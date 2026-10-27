// Netlify Function : /.netlify/functions/prix-historique  (module Prix fournisseurs)
// Historique des prix fournisseurs, stocké dans briffetools (Netlify Blobs, store « briffe-prix »).
//   - « doc/<clé> »  : le texte extrait d'un document traité (fournisseur, n°, date, lignes, décisions)
//   - « historique » : agrégat reconstructible = index des documents + relevés de prix datés par article
//   - « alias »      : correspondances apprises fournisseur + désignation -> article Sextan
// POST JSON (en-tête x-briffe-pass) :
//   { action:"lire" }                                  -> agrégat (reconstruit automatiquement si ancien format)
//   { action:"document", key }                         -> document complet
//   { action:"ajouter", entry }                        -> enregistre un document (remplace s'il existait)
//   { action:"supprimer_point", doc, li }              -> écarte une ligne d'un document de l'historique
//   { action:"rattacher", groupe, article:{id,name,unit}, points:[{doc,li,p}] }
//                                                      -> rattache un produit hors Sextan à un article
//   { action:"reconstruire" }                          -> recalcule l'agrégat depuis les documents
// Relevé (point) = { d, p, pf, up, f, fn, ref, des, doc, li, a, neg }
// Produits hors Sextan : regroupés par fournisseur + désignation (les références changent souvent,
// ex. fruits et légumes), la référence reste visible sur chaque relevé.

const SITE_ID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
const NTOKEN = process.env.NETLIFY_TOKEN || process.env.NETLIFY_API_KEY;
const STORE = "briffe-prix";
const VERSION = 2;

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
// Même normalisation que la page (clé des produits hors Sextan et des correspondances)
const normDes = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
function pointKey(l, providerId) {
  if (l.article_id) return String(l.article_id);
  return "x:" + (providerId || "?") + ":" + (normDes(l.designation) || "ref-" + (l.ref || "?"));
}

function emptyHist() { return { v: VERSION, docs: [], articles: {} }; }

// Ajoute (ou remplace) un document dans l'agrégat. Pure.
function merge(hist, entry) {
  hist = hist && typeof hist === "object" ? hist : emptyHist();
  hist.docs = Array.isArray(hist.docs) ? hist.docs : [];
  hist.articles = hist.articles && typeof hist.articles === "object" ? hist.articles : {};
  const key = entry.key;
  hist.docs = hist.docs.filter(d => d.key !== key);
  for (const id of Object.keys(hist.articles)) {
    const a = hist.articles[id];
    a.points = (a.points || []).filter(p => p.doc !== key);
    if (!a.points.length) delete hist.articles[id];
  }
  const f = entry.fournisseur || {};
  const date = entry.document && entry.document.date;
  let n = 0;
  (entry.lignes || []).forEach((l, li) => {
    const p = num(l.prix_unitaire);
    if (p === null || l.action === "ignorer" || l.exclu) return;
    const k = pointKey(l, f.id);
    const a = hist.articles[k] = hist.articles[k] || { name: l.article_name || l.designation, unit: l.unite_article || "", points: [] };
    if (l.article_name) a.name = l.article_name;
    if (l.unite_article) a.unit = l.unite_article;
    a.points.push({ d: date, p, pf: num(l.prix_facture), up: l.unite_prix || "", f: f.id || null, fn: f.name || "", ref: l.ref || "", des: l.designation || "", doc: key, li, a: l.action || "aucune", neg: num(l.negocie_avant) });
    a.points.sort((x, y) => String(x.d).localeCompare(String(y.d)));
    n++;
  });
  hist.docs.push({ key, date, fournisseur: f.name || "", fournisseur_id: f.id || null, numero: entry.document && entry.document.numero || "", type: entry.document && entry.document.type || "", lignes: n, saisi_le: entry.saisi_le });
  hist.docs.sort((x, y) => String(y.date).localeCompare(String(x.date)));
  hist.v = VERSION;
  hist.updated = new Date().toISOString();
  return hist;
}

async function rebuild(prev) {
  const keys = ((prev && prev.docs) || []).map(d => d.key);
  let hist = emptyHist();
  const docs = await Promise.all(keys.map(k => blobGet("doc/" + k).catch(() => null)));
  docs.filter(Boolean).sort((a, b) => String(a.document && a.document.date).localeCompare(String(b.document && b.document.date)))
    .forEach(d => { hist = merge(hist, d); });
  await blobSet("historique", hist);
  return hist;
}

// Correspondances apprises : fournisseur + désignation -> article
async function learnAliases(entry) {
  const f = entry.fournisseur || {};
  if (!f.id) return;
  // on n'apprend que les rattachements confirmés : par référence, choisis à la main, ou rattachés dans l'historique
  const lines = (entry.lignes || []).filter(l => l.article_id && l.designation && !l.exclu && l.action !== "ignorer" &&
    (l.statut !== "a_confirmer" || l.manuel || l.rattache_le));
  if (!lines.length) return;
  const alias = (await blobGet("alias").catch(() => null)) || {};
  const m = alias[f.id] = alias[f.id] || {};
  lines.forEach(l => { m[normDes(l.designation)] = { id: l.article_id, name: l.article_name || "", unit: l.unite_article || "" }; });
  await blobSet("alias", alias);
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: headers(), body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Méthode non autorisée" });
  if (!checkPass(event)) return json(401, { error: "Mot de passe Briffe manquant ou incorrect." });
  if (!SITE_ID || !NTOKEN) return json(500, { error: "SITE_ID / NETLIFY_TOKEN non configurés." });
  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch (e) {}
  try {
    if (body.action === "lire") {
      let h = await blobGet("historique");
      if (h && h.v !== VERSION) h = await rebuild(h); // migration de l'ancien regroupement
      return json(200, Object.assign({ ok: true }, h || emptyHist()));
    }
    if (body.action === "reconstruire") {
      return json(200, Object.assign({ ok: true }, await rebuild(await blobGet("historique"))));
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
      let h = await blobGet("historique");
      if (h && h.v !== VERSION) h = await rebuild(h);
      h = merge(h, e);
      await blobSet("historique", h);
      await learnAliases(e).catch(() => {});
      return json(200, { ok: true, key: e.key, docs: h.docs.length });
    }
    if (body.action === "supprimer_point") {
      const d = await blobGet("doc/" + body.doc);
      if (!d || !d.lignes || !d.lignes[body.li]) return json(404, { error: "Relevé introuvable." });
      d.lignes[body.li].exclu = true;
      await blobSet("doc/" + body.doc, d);
      const h = merge(await blobGet("historique"), d);
      await blobSet("historique", h);
      return json(200, Object.assign({ ok: true }, h));
    }
    if (body.action === "rattacher") {
      const art = body.article || {};
      const pts = Array.isArray(body.points) ? body.points : [];
      if (!art.id || !pts.length) return json(400, { error: "Article ou relevés manquants." });
      const byDoc = {};
      pts.forEach(p => { (byDoc[p.doc] = byDoc[p.doc] || []).push(p); });
      let h = await blobGet("historique");
      for (const k of Object.keys(byDoc)) {
        const d = await blobGet("doc/" + k);
        if (!d) continue;
        byDoc[k].forEach(p => {
          const l = d.lignes[p.li]; if (!l) return;
          l.article_id = art.id; l.article_name = art.name; l.unite_article = art.unit || l.unite_article;
          if (num(p.p) !== null) l.prix_unitaire = num(p.p); // prix recalculé dans l'unité de la fiche
          l.rattache_le = new Date().toISOString();
        });
        await blobSet("doc/" + k, d);
        h = merge(h, d);
        await learnAliases(d).catch(() => {});
      }
      await blobSet("historique", h);
      return json(200, Object.assign({ ok: true }, h));
    }
    if (body.action === "alias") {
      return json(200, { ok: true, alias: (await blobGet("alias")) || {} });
    }
    return json(400, { error: "Action inconnue" });
  } catch (e) {
    return json(502, { error: e.message });
  }
};

exports._merge = merge;
exports._normDes = normDes;
