// Netlify Function : /.netlify/functions/prix-appliquer  (module Prix fournisseurs)
// Écrit dans Sextan (via le serveur MCP, compte « briffetools ») les décisions validées à l'écran.
// POST JSON (en-tête x-briffe-pass) :
//   { action:"reference" }  -> classification Magasin prod (type > catégorie > famille), unités, allergènes
//   { action:"appliquer", dry_run:true|false, provider_id, doc_key, lignes:[ ... ] }
// Une ligne : { key, action, article_id?, ref?, designation, prix, lot?, unite_cond?, nouvel?:{...} }
//   action = "maj_prix"   : prix négocié de la ligne fournisseur + dernier prix d'achat de l'article
//            "maj_dernier": dernier prix d'achat seulement
//            "rattacher"  : ajoute la référence du fournisseur à la fiche (prix négocié + dernier prix)
//            "creer"      : crée l'article (nouvel = { name, unit, rayon, category, family, allergen })
// Garde-fous :
//   - chaque fiche est RELUE juste avant d'être modifiée ; les autres lignes fournisseurs sont renvoyées
//     à l'identique (Sextan remplace la liste entière) ; aucune ligne n'est supprimée ;
//   - les lignes d'un même article sont regroupées en UNE modification ;
//   - les créations portent une clé d'idempotence (pas de doublon en cas de rejeu) ;
//   - dry_run:true simule sans rien écrire. La page impose une simulation avant l'enregistrement réel.

const mcp = require("./sextan-mcp.js");
const crypto = require("crypto");

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
async function blobDel(key) {
  await fetch(blobUrl(key), { method: "DELETE", headers: { Authorization: "Bearer " + NTOKEN } }).catch(() => {});
}

// ---------- utilitaires ----------
const num = v => { const n = parseFloat(String(v === null || v === undefined ? "" : v).replace(",", ".")); return isFinite(n) ? n : null; };
const priceStr = v => { const n = num(v); return n === null ? "" : String(Math.round(n * 1e6) / 1e6); };
const sameRef = (a, b) => !!a && !!b && String(a).replace(/^0+/, "").toLowerCase() === String(b).replace(/^0+/, "").toLowerCase();
const validUnitWord = u => !!u && !/^\s*[\d.,]+\s*$/.test(String(u));

// Recopie d'une ligne fournisseur existante, à l'identique (sans le libellé, que Sextan conserve
// automatiquement pour une même référence chez le même fournisseur).
function keepLine(s) {
  const out = { provider_id: s.provider_id, lot: s.lot, price: s.price === null || s.price === undefined ? "" : String(s.price), ref: s.ref || "", unit: s.unit || "", comment: s.comment === undefined ? "1" : s.comment };
  if (s.cat) out.cat = s.cat;
  if (s.preorder) out.preorder = s.preorder;
  if (s.preorder_days) out.preorder_days = s.preorder_days;
  return out;
}

// Construit la nouvelle liste de fournisseurs d'un article à partir des opérations demandées.
// Renvoie { suppliers, price, changes:[texte], error? }
function planArticle(article, ops, providerId) {
  const lines = (article.suppliers || []).map(s => Object.assign({}, s));
  const bad = lines.find(s => !(num(s.lot) > 0) || !validUnitWord(s.unit));
  const changes = [];
  let touchSuppliers = false, newPrice = null;
  for (const op of ops) {
    const p = priceStr(op.prix);
    if (!p) return { error: "Prix manquant pour « " + (op.designation || op.ref) + " »." };
    if (op.action === "maj_dernier") { newPrice = p; changes.push("dernier prix → " + p); continue; }
    if (op.action === "maj_prix" || op.action === "rattacher") {
      let target = lines.find(s => s.provider_id === providerId && sameRef(s.ref, op.ref));
      if (!target && op.action === "maj_prix") target = lines.find(s => s.provider_id === providerId && !s.ref);
      if (target) {
        const before = target.price;
        target.price = p;
        if (!target.ref && op.ref) target.ref = op.ref;
        changes.push("prix négocié " + (target.ref || "") + " : " + (before === "" || before === null ? "vide" : before) + " → " + p);
      } else {
        const lot = num(op.lot);
        if (!(lot > 0)) return { error: "Conditionnement (quantité) manquant pour rattacher « " + (op.designation || op.ref) + " »." };
        const unit = op.unite_cond || "COLIS";
        if (!validUnitWord(unit)) return { error: "Le nom du conditionnement doit être un mot (pas un nombre) : « " + unit + " »." };
        const nl = { provider_id: providerId, ref: op.ref || "", price: p, lot: String(lot), unit: unit, comment: "1" };
        if (op.designation) nl.supplier_label = String(op.designation).slice(0, 255);
        nl._new = true;
        lines.push(nl);
        changes.push("nouvelle référence " + (op.ref || "(sans réf.)") + " à " + p + " (" + lot + " par " + unit + ")");
      }
      touchSuppliers = true;
      newPrice = p;
    }
  }
  if (touchSuppliers && bad) {
    return { error: "La fiche « " + article.name + " » a une ligne fournisseur incomplète (" + (bad.provider || "fournisseur " + bad.provider_id) + " : conditionnement « " + (bad.lot || "vide") + " » / unité « " + (bad.unit || "vide") + " »). Sextan refuserait la modification : corrige-la d'abord dans Sextan." };
  }
  const suppliers = touchSuppliers ? lines.map(s => {
    if (s._new) { const c = Object.assign({}, s); delete c._new; return c; }
    return keepLine(s);
  }) : null;
  return { suppliers, price: newPrice, changes };
}

function idem(docKey, line) {
  return "prix-" + crypto.createHash("sha256").update(String(docKey) + "|" + line.key + "|" + (line.ref || "") + "|" + (line.nouvel && line.nouvel.name)).digest("hex").slice(0, 40);
}

async function applyBatch(body) {
  const dry = body.dry_run !== false;
  const providerId = Number(body.provider_id) || null;
  const lignes = Array.isArray(body.lignes) ? body.lignes : [];
  if (!providerId && lignes.some(l => l.action !== "maj_dernier")) throw new Error("Fournisseur non choisi.");
  const token = await mcp.getAccessToken();
  const { sid } = await mcp.mcpSession(token);
  const results = [];

  // 1) Créations
  const creations = lignes.filter(l => l.action === "creer");
  await Promise.all(creations.map(async l => {
    const n = l.nouvel || {};
    const errs = [];
    if (!n.name) errs.push("nom");
    if (!n.unit) errs.push("unité");
    if (n.allergen === undefined || n.allergen === null || n.allergen === "") errs.push("allergènes (cocher « sans allergène » si aucun)");
    if (!(num(l.lot) > 0)) errs.push("conditionnement");
    if (!priceStr(l.prix)) errs.push("prix");
    if (errs.length) { results.push({ key: l.key, ok: false, message: "À compléter : " + errs.join(", ") + "." }); return; }
    const unitCond = l.unite_cond || "COLIS";
    if (!validUnitWord(unitCond)) { results.push({ key: l.key, ok: false, message: "Le nom du conditionnement doit être un mot." }); return; }
    const args = {
      name: n.name, unit: n.unit, department: "prod", available: "1", price: priceStr(l.prix), allergen: String(n.allergen),
      suppliers: [Object.assign({ provider_id: providerId, ref: l.ref || "", price: priceStr(l.prix), lot: String(num(l.lot)), unit: unitCond, comment: "1" }, l.designation ? { supplier_label: String(l.designation).slice(0, 255) } : {})],
      dry_run: dry, idempotency_key: idem(body.doc_key || "", l)
    };
    if (n.rayon) args.rayon = n.rayon;
    if (n.category) args.category = n.category;
    if (n.family) args.family = n.family;
    const r = await mcp.callTool(token, sid, "create_article", args);
    const ok = !!(r && r.success);
    const art = ok && r.data && (Array.isArray(r.data) ? r.data[0] : r.data);
    results.push({
      key: l.key, ok, dry_run: dry,
      article_id: ok ? ((r.review && r.review.article_id) || (art && art.id) || null) : null,
      url: ok && r.review && r.review.url ? r.review.url : null,
      message: ok ? (dry ? "Création simulée : « " + n.name + " »" : "Article créé : « " + n.name + " »") : "Création refusée : " + ((r && (r.message || r.error || r.text)) || "erreur inconnue"),
      warnings: (r && r.warnings) || []
    });
  }));

  // 2) Modifications, regroupées par article
  const groups = {};
  lignes.filter(l => ["maj_prix", "maj_dernier", "rattacher"].includes(l.action)).forEach(l => {
    const id = Number(l.article_id);
    if (!id) { results.push({ key: l.key, ok: false, message: "Aucun article choisi." }); return; }
    (groups[id] = groups[id] || []).push(l);
  });
  await Promise.all(Object.keys(groups).map(async id => {
    const ops = groups[id];
    const read = await mcp.callTool(token, sid, "search_articles", { id: Number(id) });
    const article = read && read.success && Array.isArray(read.data) ? read.data.find(a => String(a.id) === String(id)) : null;
    if (!article) { ops.forEach(o => results.push({ key: o.key, ok: false, message: "Article " + id + " introuvable dans Sextan." })); return; }
    const plan = planArticle(article, ops, providerId);
    if (plan.error) { ops.forEach(o => results.push({ key: o.key, ok: false, message: plan.error })); return; }
    const args = { id: Number(id), dry_run: dry };
    if (plan.price) args.price = plan.price;
    if (plan.suppliers) args.suppliers = plan.suppliers;
    const r = await mcp.callTool(token, sid, "update_article", args);
    const ok = !!(r && r.success);
    const msg = ok ? (dry ? "Simulation OK" : "Enregistré") + " sur « " + article.name + " » : " + plan.changes.join(" ; ") : "Modification refusée : " + ((r && (r.message || r.error || r.text)) || "erreur inconnue");
    ops.forEach(o => results.push({
      key: o.key, ok, dry_run: dry, article_id: Number(id), message: msg,
      avant: { dernier: article.price, negocie: ((article.suppliers || []).find(s => s.provider_id === providerId && sameRef(s.ref, o.ref)) || {}).price || null },
      warnings: (r && r.warnings) || [], url: r && r.review && r.review.url ? r.review.url : null
    }));
  }));

  if (!dry && results.some(r => r.ok)) await blobDel("catalogue"); // le catalogue en cache n'est plus à jour
  return results;
}

async function loadReference() {
  const c = await blobGet("reference").catch(() => null);
  if (c && c.at && Date.now() - c.at < 24 * 3600 * 1000) return c;
  const token = await mcp.getAccessToken();
  const { sid } = await mcp.mcpSession(token);
  const [tree, ref] = await Promise.all([
    mcp.callTool(token, sid, "category_tree", { type: "prod" }),
    mcp.callTool(token, sid, "article_reference", {})
  ]);
  if (!tree || !tree.success) throw new Error("Classification indisponible : " + JSON.stringify(tree).slice(0, 200));
  const slim = nodes => (nodes || []).map(n => ({ name: n.name, children: slim(n.children) }));
  const d = (ref && ref.data) || {};
  const out = { at: Date.now(), tree: slim(tree.tree), units: d.units || [], allergens: d.allergens || [] };
  await blobSet("reference", out).catch(() => {});
  return out;
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: headers(), body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Méthode non autorisée" });
  if (!checkPass(event)) return json(401, { error: "Mot de passe Briffe manquant ou incorrect." });
  if (!SITE_ID || !NTOKEN) return json(500, { error: "SITE_ID / NETLIFY_TOKEN non configurés." });
  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch (e) {}
  try {
    if (body.action === "reference") return json(200, Object.assign({ ok: true }, await loadReference()));
    if (body.action === "appliquer") {
      if (!Array.isArray(body.lignes) || !body.lignes.length) return json(400, { error: "Aucune ligne à appliquer." });
      if (body.lignes.length > 12) return json(400, { error: "12 lignes au plus par appel." });
      return json(200, { ok: true, dry_run: body.dry_run !== false, results: await applyBatch(body) });
    }
    return json(400, { error: "Action inconnue" });
  } catch (e) {
    const reconnect = e.code === "RECONNECT" || e.code === "NOT_CONNECTED";
    return json(reconnect ? 409 : 502, { error: e.message, reconnect });
  }
};

exports._planArticle = planArticle; // tests
