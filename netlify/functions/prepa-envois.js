// Netlify Function : /api/prepa-envois  (tuile Préparation prestation)
// Circuit « commerciale -> exploitation » : la commerciale valide une prestation ; briffetools archive le bon
// de prep et les bons de dispatch Sextan (cuisine, pâtisserie) déposés, envoie un mail à l'exploitation avec
// les PDF en pièces jointes (via Sextan), notifie dans Sextan et garde l'historique des versions.
// Toute nouvelle validation de la même réception = MODIFICATION (version n+1), signalée comme telle.
//
// GET  ?f=<jeton>                         -> le PDF archivé (lien non devinable : pièces jointes du mail, agenda, réimpression)
// POST { action:"config" }                -> { config }                                     (lecteur)
// POST { action:"config_save", config }   -> enregistre adresse(s) et destinataires          (admin)
// POST { action:"historique", reception_id? } -> { envois:[...] } (une réception, ou les 50 derniers) (lecteur)
// POST { action:"valider", reception, files:{ prep, cuisine, patisserie }, names, commentaire, sans:{cuisine,patisserie} } (editeur)
//      -> { ok, envoi, steps:{ archive, email, notification } }
// POST { action:"agenda", envoi_id, event_id, ok, message }  -> mémorise le résultat de l'étape agenda (faite par la page) (editeur)
//
// Stockage Netlify Blobs « briffe-prepa-envois » : file/<jeton> (PDF base64), rec/<reception_id> (versions), index, config.

const crypto = require("crypto");
const U = require("../lib/briffe-users.js");
const mcp = require("./sextan-mcp.js");

const SITE_ID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
const NTOKEN = process.env.NETLIFY_TOKEN || process.env.NETLIFY_API_KEY;
const STORE = "briffe-prepa-envois";
const MAX_PDF = 4.5 * 1024 * 1024; // par fichier (limite d'une fonction Netlify ~6 Mo au total)
const DEFAULT_CONFIG = { emails: [], notify_users: ["aherbaut"], cc: [] };

function headers(extra) {
  return Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": U.AUTH_HEADERS,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Cache-Control": "no-store"
  }, extra || {});
}
const json = (code, obj) => ({ statusCode: code, headers: headers(), body: JSON.stringify(obj) });

const blobUrl = key => `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${STORE}/${encodeURIComponent(key)}`;
async function blobGet(key) {
  const r = await fetch(blobUrl(key), { headers: { Authorization: "Bearer " + NTOKEN } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("Lecture du stockage impossible (" + r.status + ").");
  return r.json();
}
async function blobSet(key, value) {
  const r = await fetch(blobUrl(key), { method: "PUT", headers: { Authorization: "Bearer " + NTOKEN, "Content-Type": "application/json" }, body: JSON.stringify(value) });
  if (!r.ok) throw new Error("Écriture du stockage impossible (" + r.status + ").");
}

const str = (v, n) => String(v == null ? "" : v).slice(0, n || 200);
const escH = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const frDate = d => { const m = String(d || "").match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + "/" + m[2] + "/" + m[1] : str(d, 20); };
function baseUrl(event) {
  const h = event.headers || {};
  const host = h["x-forwarded-host"] || h.host;
  return host ? "https://" + host : (process.env.URL || "https://briffetools.netlify.app");
}
function cleanB64(v) {
  const s = String(v || "").replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  return s;
}
function isPdf(b64) { try { return Buffer.from(b64.slice(0, 12), "base64").toString("latin1").startsWith("%PDF"); } catch (e) { return false; } }

async function getConfig() {
  const c = (await blobGet("config")) || {};
  return Object.assign({}, DEFAULT_CONFIG, c);
}

// ---------- étapes ----------
function mailHtml(rec, env, links) {
  const r = rec.reception;
  const row = (k, v) => v ? `<tr><td style="padding:3px 12px 3px 0;color:#666">${escH(k)}</td><td style="padding:3px 0"><b>${escH(v)}</b></td></tr>` : "";
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111;line-height:1.5">
${env.modif ? `<p style="background:#fde68a;padding:8px 12px;border-radius:6px"><b>MODIFICATION</b> (version ${env.version}) : cette prestation avait déjà été envoyée le ${escH(frDate(env.previous_at))}. Les documents ci-joints remplacent les précédents.</p>` : ""}
<p>Prestation validée par <b>${escH(env.author)}</b>, à imprimer et distribuer aux pôles.</p>
<table style="border-collapse:collapse;margin:8px 0">
${row("Réception", "R" + r.id + (r.name ? " · " + r.name : ""))}${row("Client", r.client)}${row("Date", frDate(r.date))}${r.debut ? row("Horaires", r.debut + (r.fin && r.fin > r.debut ? " - " + r.fin : "")) : row("Heure", r.heure)}${row("Mise en place", r.mep)}${row("Couverts", r.nb ? r.nb + " pers." : "")}${row("Lieu", r.lieu)}${row("Type", r.type)}
</table>
${env.commentaire ? `<p><b>Commentaire :</b><br>${escH(env.commentaire).replace(/\n/g, "<br>")}</p>` : ""}
<p><b>Pièces jointes :</b></p><ul>${links.map(l => `<li>${escH(l.label)} — <a href="${escH(l.url)}">ouvrir</a></li>`).join("")}${env.sans.cuisine ? "<li>Pas de bon de dispatch cuisine pour cette prestation</li>" : ""}${env.sans.patisserie ? "<li>Pas de bon de dispatch pâtisserie pour cette prestation</li>" : ""}</ul>
<p style="color:#888;font-size:12px">Envoyé depuis briffetools · Préparation prestation</p></div>`;
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: headers(), body: "" };

  // ---- PDF archivé (lien à jeton) ----
  if (event.httpMethod === "GET") {
    const tok = String((event.queryStringParameters || {}).f || "");
    if (!/^[a-f0-9]{24,64}$/.test(tok)) return { statusCode: 404, headers: headers(), body: "{}" };
    try {
      const f = await blobGet("file/" + tok);
      if (!f || !f.b64) return { statusCode: 404, headers: headers(), body: JSON.stringify({ error: "Document introuvable." }) };
      return {
        statusCode: 200, isBase64Encoded: true, body: f.b64,
        headers: headers({ "Content-Type": "application/pdf", "Content-Disposition": "inline; filename=\"" + String(f.name || "document.pdf").replace(/[^\w.\- ]+/g, "_") + "\"", "Cache-Control": "private, max-age=300" })
      };
    } catch (e) { return json(500, { error: e.message }); }
  }
  if (event.httpMethod !== "POST") return json(405, { error: "Méthode non autorisée" });
  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "JSON invalide" }); }
  const action = body.action;
  if (!SITE_ID || !NTOKEN) return json(500, { error: "SITE_ID / NETLIFY_TOKEN non configurés." });

  const deny = await U.guard(event, U.roleFor(event, { config: "lecteur", historique: "lecteur", config_save: "admin" }, "editeur"), json, "prepa");
  if (deny) return deny;
  const me = event.briffeUser;

  try {
    if (action === "config") return json(200, { ok: true, config: await getConfig(), me });
    if (action === "config_save") {
      const c = body.config || {};
      const list = v => (Array.isArray(v) ? v : String(v || "").split(/[,;\s]+/)).map(x => String(x).trim()).filter(Boolean).slice(0, 10);
      const cfg = { emails: list(c.emails).filter(x => /@/.test(x)), cc: list(c.cc).filter(x => /@/.test(x)), notify_users: list(c.notify_users) };
      await blobSet("config", cfg);
      return json(200, { ok: true, config: cfg });
    }

    if (action === "historique") {
      if (body.reception_id) {
        const rec = await blobGet("rec/" + Number(body.reception_id));
        return json(200, { ok: true, envois: rec ? rec.envois.slice().reverse().map(e => Object.assign({ reception: rec.reception }, e)) : [] });
      }
      const idx = (await blobGet("index")) || [];
      return json(200, { ok: true, envois: idx.slice(0, 50) });
    }

    if (action === "agenda") {
      const rid = Number(body.reception_id);
      const rec = rid && await blobGet("rec/" + rid);
      if (!rec) return json(404, { error: "Prestation introuvable." });
      const env = rec.envois.find(e => e.id === body.envoi_id);
      if (!env) return json(404, { error: "Envoi introuvable." });
      env.steps.agenda = { ok: !!body.ok, message: str(body.message, 300), at: new Date().toISOString() };
      if (body.ok && body.event_id) rec.agenda_event_id = str(body.event_id, 200);
      await blobSet("rec/" + rid, rec);
      await updateIndex(rec, env);
      return json(200, { ok: true });
    }

    if (action === "valider") {
      const r = body.reception || {};
      const rid = Number(r.id);
      if (!rid) return json(400, { error: "Charge d'abord la réception Sextan (n° de réception manquant)." });
      const files = body.files || {}, names = body.names || {}, sans = { cuisine: !!(body.sans && body.sans.cuisine), patisserie: !!(body.sans && body.sans.patisserie) };
      const prep = cleanB64(files.prep);
      if (!prep || !isPdf(prep)) return json(400, { error: "Bon de préparation manquant ou illisible." });
      const docs = [{ k: "prep", label: "Bon de préparation", b64: prep, name: names.prep || ("BON PREP R" + rid + ".pdf") }];
      // bons de dispatch : découpés par service dans la page (cuisine / pâtisserie / logistique),
      // ou le PDF Sextan entier quand le découpage n'est pas possible (« dispatch »)
      const LAB = { cuisine: "Bon de dispatch CUISINE", patisserie: "Bon de dispatch PÂTISSERIE", logistique: "Bon de dispatch LOGISTIQUE", dispatch: "Bons de dispatch (PDF Sextan complet)" };
      for (const k of ["cuisine", "patisserie", "logistique", "dispatch"]) {
        const b = cleanB64(files[k]);
        if (!b) continue;
        if (!isPdf(b)) return json(400, { error: LAB[k] + " : ce n'est pas un PDF." });
        docs.push({ k, label: LAB[k], b64: b, name: names[k] || (LAB[k] + " R" + rid + ".pdf") });
      }
      if (!files.dispatch) for (const k of ["cuisine", "patisserie"]) {
        if (!cleanB64(files[k]) && !sans[k]) return json(400, { error: LAB[k] + " manquant : dépose les bons de dispatch, ou confirme qu'il n'y en a pas." });
      }
      for (const d of docs) if (Buffer.byteLength(d.b64, "base64") > MAX_PDF) return json(413, { error: d.label + " trop lourd (4,5 Mo max)." });

      const rec = (await blobGet("rec/" + rid)) || { reception: {}, envois: [], agenda_event_id: null };
      rec.reception = {
        id: rid, name: str(r.name), client: str(r.client), date: str(r.date, 20), heure: str(r.heure, 20), nb: Number(r.nb) || 0,
        lieu: str(r.lieu, 300), type: str(r.type, 60), commercial: str(r.commercial, 60),
        mep: str(r.mep, 5), debut: str(r.debut, 5), fin: str(r.fin, 5)
      };
      const prev = rec.envois[rec.envois.length - 1] || null;
      const env = {
        id: Date.now().toString(36) + crypto.randomBytes(3).toString("hex"),
        version: rec.envois.length + 1, modif: !!prev, previous_at: prev ? prev.at : null,
        at: new Date().toISOString(), author: me.name || me.login, author_login: me.login,
        commentaire: str(body.commentaire, 2000), sans, files: [], steps: {}
      };
      const base = baseUrl(event);

      // 1. Archive (liens à jeton, utilisés comme pièces jointes et pour la réimpression)
      try {
        for (const d of docs) {
          const tok = crypto.randomBytes(16).toString("hex");
          await blobSet("file/" + tok, { name: d.name, b64: d.b64, at: env.at, reception: rid });
          env.files.push({ k: d.k, label: d.label, name: d.name, token: tok, url: base + "/.netlify/functions/prepa-envois?f=" + tok, bytes: Buffer.byteLength(d.b64, "base64") });
        }
        env.steps.archive = { ok: true, message: env.files.length + " document(s) archivé(s)" };
      } catch (e) {
        env.steps.archive = { ok: false, message: e.message };
        return json(500, { error: "Archivage impossible : " + e.message, steps: env.steps });
      }

      const cfg = await getConfig();
      const r2 = rec.reception;
      const titre = (env.modif ? "MODIFICATION v" + env.version + " · " : "") + "Prestation R" + rid + " · " + (r2.client || r2.name || "") + " · " + frDate(r2.date);
      let token = null, sid = null, sextanErr = null;
      try { token = await mcp.getAccessToken(); sid = (await mcp.mcpSession(token)).sid; }
      catch (e) { sextanErr = "Sextan non connecté (" + e.message + ") : reconnecte le compte « briffetools » depuis le module Prix fournisseurs."; }

      // 2. Mail à l'exploitation, PDF en pièces jointes (envoi « au nom de l'ERP »)
      if (!cfg.emails.length) env.steps.email = { ok: false, message: "Aucune adresse d'exploitation configurée (Réglages du panneau)." };
      else if (sextanErr) env.steps.email = { ok: false, message: sextanErr };
      else {
        try {
          const res = await mcp.callTool(token, sid, "send_email", {
            to: cfg.emails, cc: cfg.cc.length ? cfg.cc : undefined, subject: "[Bon de prep] " + titre,
            html: mailHtml(rec, env, env.files), attachments: env.files.map(f => ({ url: f.url, filename: f.name }))
          });
          if (res && res.success !== false && !res.error && !res.rpc_error) {
            const warn = (res.attachment_warnings || []).length ? " — pièces jointes non récupérées : " + JSON.stringify(res.attachment_warnings).slice(0, 200) : "";
            env.steps.email = { ok: !warn, message: (res.message_id === "DRY-RUN" ? "Mode test Sextan : mail NON parti" : "Mail envoyé à " + cfg.emails.join(", ")) + warn };
            if (res.message_id === "DRY-RUN") env.steps.email.ok = false;
          } else {
            const rej = res && res.rejected_recipients && res.rejected_recipients.length ? " Adresse(s) inconnue(s) de Sextan : " + res.rejected_recipients.join(", ") + " — elles doivent figurer sur une fiche contact Sextan." : "";
            env.steps.email = { ok: false, message: "Envoi refusé par Sextan : " + str((res && (res.error || res.text || (res.rpc_error && res.rpc_error.message))) || "erreur inconnue", 300) + rej };
          }
        } catch (e) { env.steps.email = { ok: false, message: "Envoi impossible : " + e.message }; }
      }

      // 3. Notification Sextan (cloche), liée à la réception
      if (!cfg.notify_users.length) env.steps.notification = { ok: false, message: "Aucun destinataire de notification configuré." };
      else if (sextanErr) env.steps.notification = { ok: false, message: sextanErr };
      else {
        try {
          const res = await mcp.callTool(token, sid, "notify_user", {
            to: cfg.notify_users, title: (env.modif ? "Prestation MODIFIÉE · " : "Nouvelle prestation · ") + (r2.client || r2.name || "R" + rid),
            message: titre + " — validée par " + env.author + ". Bon de prep et bons de dispatch envoyés par mail" + (env.commentaire ? ". Commentaire : " + env.commentaire.slice(0, 300) : "") + ".",
            link_type: "reception", link_id: rid, priority: env.modif ? "high" : "normal", category: env.modif ? "alert" : "info",
            deadline: /^\d{4}-\d{2}-\d{2}$/.test(r2.date) ? r2.date : undefined
          });
          const n = res && (res.notified || (res.data && res.data.notified));
          if (res && res.success !== false && !res.error && !res.rpc_error && n !== 0) env.steps.notification = { ok: true, message: "Notifié dans Sextan : " + cfg.notify_users.join(", ") + ((res.unknown_recipients || []).length ? " (inconnus : " + res.unknown_recipients.join(", ") + ")" : "") };
          else env.steps.notification = { ok: false, message: "Notification refusée par Sextan : " + str((res && (res.error || res.text || (res.rpc_error && res.rpc_error.message) || (res.unknown_recipients && "destinataires inconnus : " + res.unknown_recipients.join(", ")))) || "erreur inconnue", 300) };
        } catch (e) { env.steps.notification = { ok: false, message: "Notification impossible : " + e.message }; }
      }

      env.steps.agenda = { ok: false, pending: true, message: "En attente (faite depuis la page)" };
      rec.envois.push(env);
      await blobSet("rec/" + rid, rec);
      await updateIndex(rec, env);
      return json(200, { ok: true, envoi: Object.assign({ reception: rec.reception }, env), agenda_event_id: rec.agenda_event_id || null, steps: env.steps });
    }

    return json(400, { error: "Action inconnue." });
  } catch (e) {
    return json(500, { error: e.message });
  }
};

// Index des derniers envois (toutes prestations), pour l'historique global
async function updateIndex(rec, env) {
  let idx = (await blobGet("index")) || [];
  idx = idx.filter(x => x.id !== env.id);
  idx.unshift(Object.assign({ reception: rec.reception }, env));
  await blobSet("index", idx.slice(0, 300));
}
