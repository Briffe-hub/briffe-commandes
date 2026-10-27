// Netlify Function : /.netlify/functions/sextan-probe?pass=MOT_DE_PASSE
// Sonde TEMPORAIRE pour le futur module « Mise à jour des prix fournisseurs ».
// Vérifie quelles routes de l'API REST Sextan sont accessibles avec SEXTAN_API_KEY :
//   - lecture articles / fournisseurs / référentiel articles
//   - écriture articles (update, create) et fournisseurs (create) en SIMULATION (dry_run)
// Sécurité :
//   - protégé par BRIFFE_AUTH_PASSWORD (paramètre ?pass= ou en-tête x-briffe-pass)
//   - l'update testé ne touche qu'un champ vide (commentaire "" de l'article 154, déjà vide)
//   - les créations ne sont tentées QUE si l'update a prouvé que dry_run est respecté
// À supprimer du dépôt une fois le diagnostic fait.

const BASE = (process.env.SEXTAN_BASE || "https://briffe.sextan.catering").replace(/\/+$/, "");
let API_KEY = process.env.SEXTAN_API_KEY || "";
const TEST_ARTICLE_ID = 154; // « Beurre extra-sec 84% », commentaire vide

function headers() {
  return { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, x-briffe-pass" };
}

function authorized(event) {
  const conf = String(process.env.BRIFFE_AUTH_PASSWORD || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!conf.length) return false;
  const q = event.queryStringParameters || {};
  const h = event.headers || {};
  const given = String(q.pass || h["x-briffe-pass"] || h["X-Briffe-Pass"] || "").trim();
  return conf.includes(given);
}

async function call(path, body, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 4000);
  const started = Date.now();
  try {
    const r = await fetch(BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json", "X-API-Key": API_KEY },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const txt = await r.text();
    let json = null; try { json = JSON.parse(txt); } catch (e) {}
    return { path, status: r.status, ms: Date.now() - started, json, snippet: txt.slice(0, 400) };
  } catch (e) {
    return { path, status: 0, ms: Date.now() - started, error: e.name + ": " + e.message };
  } finally { clearTimeout(t); }
}

// Essaie plusieurs chemins candidats, garde le premier qui répond 200 (sinon tous les résultats).
async function firstOk(cands, ms) {
  const results = await Promise.all(cands.map(c => call(c.path, c.body, ms)));
  const ok = results.find(r => r.status === 200 && r.json && r.json.success !== false);
  return { ok: ok || null, tried: results.map(r => ({ path: r.path, status: r.status, ms: r.ms, error: r.error, snippet: r.status === 200 ? undefined : r.snippet })) };
}

function summarize(r) {
  if (!r) return null;
  const j = r.json || {};
  return {
    path: r.path, status: r.status, ms: r.ms,
    success: j.success, dry_run: j.dry_run, count: j.count, message: j.message,
    warnings: j.warnings, firstItemKeys: Array.isArray(j.data) && j.data[0] ? Object.keys(j.data[0]) : undefined,
    snippet: r.snippet
  };
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: headers(), body: "" };
  if (!authorized(event)) return { statusCode: 401, headers: headers(), body: JSON.stringify({ error: "Mot de passe manquant ou incorrect (?pass=...)" }) };
  // ?key=prix : teste la clé dédiée SEXTAN_API_KEY_PRIX au lieu de la clé principale
  const qk = (event.queryStringParameters || {}).key;
  API_KEY = qk === "prix" ? (process.env.SEXTAN_API_KEY_PRIX || "") : (process.env.SEXTAN_API_KEY || "");
  if (!API_KEY) return { statusCode: 500, headers: headers(), body: JSON.stringify({ error: "SEXTAN_API_KEY non configurée." }) };

  const report = { base: BASE, keyUsed: qk === "prix" ? "SEXTAN_API_KEY_PRIX" : "SEXTAN_API_KEY", keyLen: API_KEY.length, at: new Date().toISOString() };

  // Mode ?mode=scopes : une lecture par ressource, pour cartographier ce que la clé obtient réellement.
  const q = event.queryStringParameters || {};
  if (q.mode === "scopes") {
    const RES = ["articles", "products", "events", "packs", "menus", "formules", "places", "staff",
                 "clients", "invoices", "quotes", "providers", "purchase-orders", "payments"];
    const results = await Promise.all(RES.map(r => call("/api/" + r + "/search", { limit: 1 }, 6000)));
    report.scopes = {};
    results.forEach((r, i) => {
      const err = r.json && (r.json.error || r.json.message);
      report.scopes[RES[i]] = r.status === 200 && r.json && r.json.success !== false
        ? "OK"
        : (r.status + (err ? " " + err : "") + (r.error ? " " + r.error : ""));
    });
    return { statusCode: 200, headers: headers(), body: JSON.stringify(report, null, 2) };
  }

  // 1) Lectures (en parallèle)
  const [art, prov, ref] = await Promise.all([
    firstOk([
      { path: "/api/articles/search", body: { search: "beurre", limit: 2 } },
      { path: "/api/article/search", body: { search: "beurre", limit: 2 } }
    ]),
    firstOk([
      { path: "/api/providers/search", body: { name: "PATIFRAIS", limit: 2 } },
      { path: "/api/provider/search", body: { name: "PATIFRAIS", limit: 2 } },
      { path: "/api/suppliers/search", body: { name: "PATIFRAIS", limit: 2 } }
    ]),
    firstOk([
      { path: "/api/articles/reference", body: {} },
      { path: "/api/article/reference", body: {} }
    ])
  ]);
  report.read_articles = { found: summarize(art.ok), tried: art.tried };
  report.read_providers = { found: summarize(prov.ok), tried: prov.tried };
  report.read_article_reference = { found: summarize(ref.ok), tried: ref.tried };

  // 2) Update article en simulation (champ commentaire déjà vide => inoffensif même si dry_run était ignoré)
  const upd = await firstOk([
    { path: "/api/articles/update", body: { id: TEST_ARTICLE_ID, comment: "", dry_run: true } },
    { path: "/api/article/update", body: { id: TEST_ARTICLE_ID, comment: "", dry_run: true } }
  ], 5000);
  report.write_article_update = { found: summarize(upd.ok), tried: upd.tried };
  const dryRunHonored = !!(upd.ok && upd.ok.json && upd.ok.json.dry_run === true);
  report.dry_run_honored = dryRunHonored;

  // 3) Créations en simulation, SEULEMENT si dry_run est prouvé
  if (dryRunHonored) {
    const [crA, crP] = await Promise.all([
      firstOk([
        { path: "/api/articles/create", body: { name: "SONDE briffetools (simulation)", unit: "g", department: "prod", dry_run: true } },
        { path: "/api/article/create", body: { name: "SONDE briffetools (simulation)", unit: "g", department: "prod", dry_run: true } }
      ], 5000),
      firstOk([
        { path: "/api/providers/create", body: { name: "SONDE briffetools (simulation)", dry_run: true } },
        { path: "/api/provider/create", body: { name: "SONDE briffetools (simulation)", dry_run: true } }
      ], 5000)
    ]);
    report.write_article_create = { found: summarize(crA.ok), tried: crA.tried };
    report.write_provider_create = { found: summarize(crP.ok), tried: crP.tried };
  } else {
    report.write_article_create = "non testé : dry_run non confirmé sur l'update";
    report.write_provider_create = "non testé : dry_run non confirmé sur l'update";
  }

  // 4) Verdict lisible
  const yes = x => (x && x.found ? "OUI" : "NON");
  report.verdict = {
    lecture_articles: yes(report.read_articles),
    lecture_fournisseurs: yes(report.read_providers),
    referentiel_articles: yes(report.read_article_reference),
    modification_article: yes(report.write_article_update),
    simulation_respectee: dryRunHonored ? "OUI" : "NON",
    creation_article: typeof report.write_article_create === "string" ? "non testé" : yes(report.write_article_create),
    creation_fournisseur: typeof report.write_provider_create === "string" ? "non testé" : yes(report.write_provider_create)
  };

  return { statusCode: 200, headers: headers(), body: JSON.stringify(report, null, 2) };
};
