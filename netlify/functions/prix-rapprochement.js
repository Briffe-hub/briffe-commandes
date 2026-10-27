// Netlify Function : /.netlify/functions/prix-rapprochement  (module Prix fournisseurs)
// Rapproche un document lu (prix-lecture) avec le catalogue d'articles Sextan.
// POST JSON (en-tête x-briffe-pass) :
//   { document:{ fournisseur, document, lignes }, seuil?: 1, refresh?: false, provider_id?: n }
//   { action:"catalogue" }  -> renvoie la liste allégée des articles + fournisseurs (pour la recherche manuelle)
// Lecture seule : aucune écriture dans Sextan.
// Le catalogue (articles + fournisseurs) est lu via le serveur MCP Sextan (compte « briffetools »)
// et mis en cache 15 min dans Netlify Blobs (store « briffe-prix », clé « catalogue »).

const mcp = require("./sextan-mcp.js");

const SITE_ID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
const NTOKEN = process.env.NETLIFY_TOKEN || process.env.NETLIFY_API_KEY;
const STORE = "briffe-prix";
const CACHE_TTL_MS = 15 * 60 * 1000;

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

// ---------- Blobs ----------
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

// ---------- Catalogue Sextan ----------
const num = v => { const n = parseFloat(String(v === null || v === undefined ? "" : v).replace(",", ".")); return isFinite(n) ? n : null; };

function slimArticle(a) {
  return {
    id: a.id, name: a.name, unit: a.unit || "", type: a.type || "", price: num(a.price),
    allergen: a.allergen || "",
    suppliers: (a.suppliers || []).map(s => ({
      provider_id: s.provider_id, provider: s.provider, ref: String(s.ref || "").trim(),
      supplier_label: s.supplier_label || "", price: num(s.price), lot: num(s.lot), unit: s.unit || "", cat: s.cat || null
    }))
  };
}

async function loadCatalogue(force) {
  if (!force) {
    const c = await blobGet("catalogue").catch(() => null);
    if (c && c.at && Date.now() - c.at < CACHE_TTL_MS) return c;
  }
  const token = await mcp.getAccessToken();
  const { sid } = await mcp.mcpSession(token);
  const LIMIT = 100;
  const offsets = [0, 100, 200, 300, 400, 500];
  const [provs, ...pages] = await Promise.all([
    mcp.callTool(token, sid, "search_providers", { limit: 100 }),
    ...offsets.map(o => mcp.callTool(token, sid, "search_articles", { limit: LIMIT, offset: o }))
  ]);
  let articles = [];
  for (const p of pages) {
    if (!p || p.success === false) throw new Error("Lecture du catalogue refusée : " + JSON.stringify(p).slice(0, 300));
    articles = articles.concat(p.data || []);
  }
  // Pages supplémentaires si le catalogue dépasse 600 articles
  let off = 600;
  while (pages[pages.length - 1] && (pages[pages.length - 1].data || []).length === LIMIT && off < 3000) {
    const more = await mcp.callTool(token, sid, "search_articles", { limit: LIMIT, offset: off });
    pages.push(more); articles = articles.concat((more && more.data) || []); off += LIMIT;
  }
  const seen = new Set();
  articles = articles.filter(a => a && !seen.has(a.id) && seen.add(a.id)).map(slimArticle);
  const providers = ((provs && provs.data) || []).map(p => ({ id: p.id, name: p.name, inactive: !!p.inactive }));
  const cat = { at: Date.now(), articles, providers };
  await blobSet("catalogue", cat).catch(() => {});
  return cat;
}

// ---------- Texte ----------
function norm(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/%%/g, "%").replace(/[^a-z0-9%.,]+/g, " ").trim();
}
const STOP = new Set(["de", "du", "des", "la", "le", "les", "et", "au", "aux", "en", "un", "une", "par", "pour", "sur", "avec", "sans", "x", "pce", "pcs", "un", "kg", "g", "l", "cl", "ml", "aff", "iqf"]);
function tokens(s) {
  return norm(s).split(" ").filter(t => t.length >= 3 && !STOP.has(t) && !/^\d+([.,]\d+)?$/.test(t) && !/^\d/.test(t));
}
function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.length || !B.length) return 0;
  let hit = 0;
  for (const t of A) {
    if (B.some(u => u === t || (t.length >= 4 && u.length >= 4 && (u.startsWith(t.slice(0, 4)) || t.startsWith(u.slice(0, 4)))))) hit++;
  }
  return hit / Math.max(A.length, Math.min(B.length + 1, A.length + 2));
}
function percents(s) { return (norm(s).match(/\d+(?:[.,]\d+)?\s?%/g) || []).map(x => parseFloat(x.replace(",", "."))); }
function levenshtein(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const compact = s => norm(s).replace(/\b(sas|sasu|sarl|sa|eurl|snc|ets|societe)\b/g, "").replace(/[^a-z0-9]/g, "");
const sameRef = (a, b) => !!a && !!b && String(a).replace(/^0+/, "").toLowerCase() === String(b).replace(/^0+/, "").toLowerCase();

// ---------- Unités ----------
// Ce que représente UNE unité d'usage de l'article : { dim: "masse"|"volume"|"piece", q }
function articleUnit(u) {
  const x = norm(u).replace(/\s/g, "");
  if (x === "g" || x === "gr" || x === "gramme" || x === "grammes") return { dim: "masse", q: 1 };
  if (x === "kg") return { dim: "masse", q: 1000 };
  if (x === "ml") return { dim: "volume", q: 1 };
  if (x === "cl") return { dim: "volume", q: 10 };
  if (x === "l" || x === "litre" || x === "litres") return { dim: "volume", q: 1000 };
  return { dim: "piece", q: 1 };
}
const baseDim = u => (u === "g" ? "masse" : u === "ml" ? "volume" : "piece");
// masse et volume sont traités comme équivalents (1 L = 1000 g), comme dans Sextan
const compatible = (a, b) => a === b || (a !== "piece" && b !== "piece");

// Prix facturé -> prix par unité d'usage de l'article. Renvoie { value, how, sure }
function convertPrice(line, article, supplierLine) {
  const p = line.prix;
  if (p === null || p === undefined) return { value: null, how: "prix illisible", sure: false };
  const au = articleUnit(article.unit);
  const options = [];
  if (line.base_prix && line.base_prix.quantite > 0) {
    const bd = baseDim(line.base_prix.unite);
    if (compatible(bd, au.dim)) options.push({ value: p / line.base_prix.quantite * au.q, how: "prix ÷ " + line.base_prix.quantite + " " + (line.base_prix.unite === "piece" ? "pièces" : line.base_prix.unite) + (au.q !== 1 ? " × " + au.q : ""), sure: true });
  }
  const up = (line.unite_prix || "").toUpperCase();
  if (au.dim !== "piece" && (up === "KG" || up === "L")) options.push({ value: p / 1000 * au.q, how: "prix au " + up.toLowerCase() + " ÷ 1000", sure: true });
  if (au.dim !== "piece" && up !== "KG" && up !== "L") options.push({ value: p / 1000 * au.q, how: "1 unité facturée = 1 kg ou 1 L (supposé)", sure: false });
  if (supplierLine && supplierLine.lot > 0) options.push({ value: p / supplierLine.lot, how: "prix ÷ conditionnement Sextan (" + supplierLine.lot + ")", sure: false });
  if (au.dim === "piece") options.push({ value: p, how: "prix à l'unité", sure: false });
  if (!options.length) return { value: null, how: "conversion impossible", sure: false };
  const ref = supplierLine && supplierLine.price > 0 ? supplierLine.price : (article.price > 0 ? article.price : null);
  let best = options[0];
  if (ref) {
    const dist = o => Math.abs(Math.log(o.value / ref));
    const first = options[0];
    // on garde la conversion « sûre » si elle est plausible (écart < 2x), sinon la plus proche du prix connu
    if (!(first.sure && dist(first) < Math.log(2))) {
      best = options.reduce((a, b) => (dist(b) < dist(a) ? b : a));
      best = Object.assign({}, best, { sure: false });
    }
  }
  return best;
}

// ---------- Rapprochement ----------
function matchProvider(doc, cat, forcedId) {
  if (forcedId) { const p = cat.providers.find(x => x.id === forcedId); if (p) return { provider: p, how: "choisi" }; }
  const name = compact(doc.fournisseur && doc.fournisseur.nom);
  let best = null;
  if (name) {
    for (const p of cat.providers) {
      const c = compact(p.name);
      if (!c) continue;
      const score = name === c ? 1 : (name.includes(c) || c.includes(name)) ? 0.9 : (levenshtein(name, c) <= 2 ? 0.85 : 0);
      if (score && (!best || score > best.score)) best = { provider: p, score, how: "nom" };
    }
  }
  // Vote par références : le fournisseur qui porte le plus de références du document
  const votes = {};
  for (const l of doc.lignes || []) {
    if (!l.ref) continue;
    for (const a of cat.articles) for (const s of a.suppliers) if (sameRef(s.ref, l.ref)) votes[s.provider_id] = (votes[s.provider_id] || 0) + 1;
  }
  const top = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
  if (top && (!best || (best.score < 1 && top[1] >= 2 && String(best.provider.id) !== top[0]))) {
    const p = cat.providers.find(x => String(x.id) === top[0]);
    if (p) return { provider: p, how: "références (" + top[1] + ")" };
  }
  return best ? { provider: best.provider, how: best.how } : { provider: null, how: "inconnu" };
}

function pct(a, b) { return a !== null && b > 0 ? (a / b - 1) * 100 : null; }
const round = (v, d) => (v === null || v === undefined ? null : Math.round(v * Math.pow(10, d)) / Math.pow(10, d));

function matchLines(doc, cat, providerId, seuil) {
  const out = [];
  (doc.lignes || []).forEach((l, idx) => {
    const r = { idx, ligne: l, statut: null, alertes: [], candidats: [], article: null, ligne_fournisseur: null, conversion: null, prix_converti: null, ecart_negocie: null, ecart_dernier: null, action: "aucune" };
    // 1) par référence
    const byRef = [];
    if (l.ref) for (const a of cat.articles) for (const s of a.suppliers) if (sameRef(s.ref, l.ref)) byRef.push({ a, s });
    let hits = byRef.filter(h => !providerId || h.s.provider_id === providerId);
    if (!hits.length && byRef.length) { hits = byRef; r.alertes.push("Référence trouvée chez un autre fournisseur (" + byRef[0].s.provider + ")."); }
    const scored = hits.map(h => {
      const conv = convertPrice(l, h.a, h.s);
      const priceFit = conv.value && h.s.price > 0 ? Math.max(0, 1 - Math.abs(Math.log(conv.value / h.s.price))) : 0.5;
      return Object.assign({}, h, { conv, score: similarity(l.designation, h.a.name) * 0.6 + priceFit * 0.4 });
    }).sort((x, y) => y.score - x.score);

    if (scored.length) {
      const best = scored[0];
      r.article = { id: best.a.id, name: best.a.name, unit: best.a.unit, price: best.a.price };
      r.ligne_fournisseur = best.s;
      r.candidats = scored.map(h => ({ id: h.a.id, name: h.a.name, unit: h.a.unit, via: "référence", score: round(h.score, 2) }));
      if (scored.length > 1) { r.statut = "ambigu"; r.alertes.push("La référence " + l.ref + " est rattachée à " + scored.length + " articles : " + scored.map(h => "« " + h.a.name + " »").join(", ") + "."); }
      r.conversion = best.conv;
    } else {
      // 2) par nom
      const sims = cat.articles.map(a => ({ a, score: similarity(l.designation, a.name) })).filter(x => x.score >= 0.34).sort((x, y) => y.score - x.score).slice(0, 5);
      r.candidats = sims.map(x => ({ id: x.a.id, name: x.a.name, unit: x.a.unit, via: "nom", score: round(x.score, 2) }));
      if (sims.length) {
        const a = sims[0].a;
        const s = a.suppliers.find(x => x.provider_id === providerId) || null;
        r.article = { id: a.id, name: a.name, unit: a.unit, price: a.price };
        r.ligne_fournisseur = s;
        r.conversion = convertPrice(l, a, s);
        r.statut = "a_confirmer";
        r.alertes.push("Aucune fiche avec la référence " + (l.ref || "(absente)") + " : rapprochement par le nom, à confirmer.");
        r.action = "rattacher";
      } else {
        r.statut = "inconnu";
        r.alertes.push("Article introuvable dans Sextan.");
        r.action = "creer";
      }
    }

    if (r.conversion) {
      r.prix_converti = r.conversion.value;
      if (r.conversion.value !== null && !r.conversion.sure) r.alertes.push("Conversion d'unité à vérifier (" + r.conversion.how + ").");
    }
    const neg = r.ligne_fournisseur && r.ligne_fournisseur.price > 0 ? r.ligne_fournisseur.price : null;
    r.ecart_negocie = round(pct(r.prix_converti, neg), 2);
    r.ecart_dernier = round(pct(r.prix_converti, r.article && r.article.price), 2);
    if (r.ligne_fournisseur && !neg) r.alertes.push("Pas de prix négocié renseigné pour cette ligne fournisseur.");

    // Désignation incohérente (ex. 18 % facturé, fiche 30 %)
    if (r.article && r.statut !== "inconnu") {
      const pa = percents(l.designation), pb = percents(r.article.name);
      if (pa.length && pb.length && !pa.some(x => pb.includes(x))) {
        r.alertes.push("Désignation différente de la fiche (" + pa.join("/") + " % facturé, " + pb.join("/") + " % sur « " + r.article.name + " »).");
        if (!r.statut) { r.statut = "designation"; r.action = "creer"; }
      }
    }

    if (!r.statut) {
      if (r.prix_converti === null) { r.statut = "conversion"; r.action = "aucune"; }
      else if (r.ecart_negocie !== null && Math.abs(r.ecart_negocie) > seuil) { r.statut = "ecart"; r.action = "maj_prix"; }
      else if (r.conversion && !r.conversion.sure) { r.statut = "conversion"; r.action = "aucune"; }
      else if (neg === null && r.prix_converti !== null) { r.statut = "ecart"; r.action = "maj_prix"; }
      else {
        r.statut = "ok";
        // Sextan arrondit le dernier prix d'achat à 3 décimales : un écart dû au seul arrondi n'est pas un écart
        const roundedDiffers = r.article && r.article.price !== null && round(r.prix_converti, 3) !== round(r.article.price, 3);
        r.action = (roundedDiffers && r.ecart_dernier !== null && Math.abs(r.ecart_dernier) > seuil) ? "maj_dernier" : "aucune";
      }
    }
    if (r.statut === "ambigu") r.action = "choisir";
    if (r.statut === "ok" && r.action === "maj_dernier") r.alertes.push("Prix négocié conforme, mais le dernier prix d'achat de la fiche diffère de " + r.ecart_dernier + " %.");
    r.prix_converti = round(r.prix_converti, 6);
    out.push(r);
  });
  return out;
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: headers(), body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Méthode non autorisée" });
  if (!checkPass(event)) return json(401, { error: "Mot de passe Briffe manquant ou incorrect." });
  if (!SITE_ID || !NTOKEN) return json(500, { error: "SITE_ID / NETLIFY_TOKEN non configurés." });
  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch (e) {}
  const started = Date.now();
  try {
    const cat = await loadCatalogue(!!body.refresh);
    if (body.action === "catalogue") return json(200, { ok: true, articles: cat.articles, providers: cat.providers, at: cat.at });
    const doc = body.document;
    if (!doc || !Array.isArray(doc.lignes)) return json(400, { error: "Document manquant." });
    const seuil = num(body.seuil) !== null ? num(body.seuil) : 1;
    const prov = matchProvider(doc, cat, body.provider_id ? Number(body.provider_id) : null);
    const lignes = matchLines(doc, cat, prov.provider && prov.provider.id, seuil);
    return json(200, {
      ok: true, fournisseur: prov.provider, fournisseur_via: prov.how, seuil,
      lignes, providers: cat.providers, catalogue_at: cat.at, ms: Date.now() - started
    });
  } catch (e) {
    const reconnect = e.code === "RECONNECT" || e.code === "NOT_CONNECTED";
    return json(reconnect ? 409 : 502, { error: e.message, reconnect });
  }
};

// pour les tests
exports._matchLines = matchLines;
exports._matchProvider = matchProvider;
exports._convertPrice = convertPrice;
exports._slimArticle = slimArticle;
