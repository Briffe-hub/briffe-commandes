// Netlify Function : /.netlify/functions/prix-historique  (module Prix fournisseurs)
// Historique des prix fournisseurs, stocké dans briffetools (Netlify Blobs, store « briffe-prix »).
//   - « doc/<clé> »  : le texte extrait d'un document traité (fournisseur, n°, date, lignes, décisions)
//   - « historique » : agrégat compact = index des documents + points de prix datés par article
// POST JSON (en-tête x-briffe-pass) :
//   { action:"lire" }                      -> { docs:[...], articles:{ id:{ name, unit, points:[...] } } }
//   { action:"document", key }             -> le document complet
//   { action:"ajouter", entry:{...} }      -> enregistre un document (remplace s'il existait déjà)
// Un point de prix = { d:date, p:prix par unité d'usage, pf:prix facturé, up:unité facturée,
//                      f:id fournisseur, fn:nom, ref, doc:clé, a:action }

const SITE_ID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
const NTOKEN = process.env.NETLIFY_TOKEN || process.env.NETLIFY_API_KEY;
const STORE = "briffe-prix";

function headers() {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, x-briffe-pass",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store"
  };
}
const json = (code, obj) => ({ statusCode: code, headers: headers(), body: JSON.stringify(obj) });
function checkPass(event) {
  const allowed = String(process.env.BRIFFE_AUTH_PASSWORD || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!allowed.length) return false;
  const h = event.headers || {};
  return allowed.includes(String(h["x-briffe-pass"] || h["X-Briffe-Pass"] || "").trim());
}
const blobUrl = key => `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${STORE}/${encodeURIComponent(key)}`;
async function blobGet(key) {
  const r = await fetch(blobUrl(key), { headers: { Authorization: "Bearer " + NTOKEN } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("Blob GET " + r.status);
  return r.json();
}
async function blobSet(key, value) {
  const r = await fetch(blobUrl(key), { method: "PUT", headers: { Authorization: "Bearer " + NTOKEN, "Content-Type": "application/json" }, body: JSON.stringify(value) });
  if (!r.ok) throw new Error("Blob PUT " + r.status);
}

const num = v => { const n = parseFloat(String(v === null || v === undefined ? "" : v).replace(",", ".")); return isFinite(n) ? n : null; };

// Clé d'un point pour une ligne sans article Sextan : fournisseur + référence (ou désignation)
function pointKey(l, providerId) {
  if (l.article_id) return String(l.article_id);
  const r = l.ref ? "ref:" + l.ref : "des:" + String(l.designation || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
  return "x:" + (providerId || "?") + ":" + r;
}

// Ajoute (ou remplace) un document dans l'agrégat. Pure, pour les tests.
function merge(hist, entry) {
  hist = hist && typeof hist === "object" ? hist : {};
  hist.docs = Array.isArray(hist.docs) ? hist.docs : [];
  hist.articles = hist.articles && typeof hist.articles === "object" ? hist.articles : {};
  const key = entry.key;
  // retire les points d'une version précédente du même document
  hist.docs = hist.docs.filter(d => d.key !== key);
  for (const id of Object.keys(hist.articles)) {
    const a = hist.articles[id];
    a.points = (a.points || []).filter(p => p.doc !== key);
    if (!a.points.length) delete hist.articles[id];
  }
  const f = entry.fournisseur || {};
  const date = entry.document && entry.document.date;
  let n = 0;
  for (const l of entry.lignes || []) {
    const p = num(l.prix_unitaire);
    if (p === null || l.action === "ignorer") continue;
    const k = pointKey(l, f.id);
    const a = hist.articles[k] = hist.articles[k] || { name: l.article_name || l.designation, unit: l.unite_article || "", points: [] };
    if (l.article_name) a.name = l.article_name;
    if (l.unite_article) a.unit = l.unite_article;
    a.points.push({ d: date, p, pf: num(l.prix_facture), up: l.unite_prix || "", f: f.id || null, fn: f.name || "", ref: l.ref || "", des: l.designation || "", doc: key, a: l.action || "aucune", neg: num(l.negocie_avant) });
    a.points.sort((x, y) => String(x.d).localeCompare(String(y.d)));
    n++;
  }
  hist.docs.push({ key, date, fournisseur: f.name || "", fournisseur_id: f.id || null, numero: entry.document && entry.document.numero || "", type: entry.document && entry.document.type || "", lignes: n, saisi_le: entry.saisi_le });
  hist.docs.sort((x, y) => String(y.date).localeCompare(String(x.date)));
  hist.updated = new Date().toISOString();
  return hist;
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: headers(), body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Méthode non autorisée" });
  if (!checkPass(event)) return json(401, { error: "Mot de passe Briffe manquant ou incorrect." });
  if (!SITE_ID || !NTOKEN) return json(500, { error: "SITE_ID / NETLIFY_TOKEN non configurés." });
  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch (e) {}
  try {
    if (body.action === "lire") {
      const h = await blobGet("historique");
      return json(200, Object.assign({ ok: true, docs: [], articles: {} }, h || {}));
    }
    if (body.action === "document") {
      const d = body.key ? await blobGet("doc/" + body.key) : null;
      return d ? json(200, { ok: true, document: d }) : json(404, { error: "Document introuvable." });
    }
    if (body.action === "ajouter") {
      const e = body.entry;
      if (!e || !e.key || !Array.isArray(e.lignes)) return json(400, { error: "Entrée invalide." });
      if (!/^\d{4}-\d{2}-\d{2}$/.test((e.document && e.document.date) || "")) return json(400, { error: "Date du document obligatoire : elle date les prix dans l'historique." });
      e.saisi_le = new Date().toISOString();
      await blobSet("doc/" + e.key, e);
      const hist = merge(await blobGet("historique"), e);
      await blobSet("historique", hist);
      return json(200, { ok: true, key: e.key, docs: hist.docs.length });
    }
    return json(400, { error: "Action inconnue" });
  } catch (e) {
    return json(502, { error: e.message });
  }
};

exports._merge = merge; // tests
