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

// ---------- MCP ----------
// Lit une réponse JSON ou SSE (lignes « data: {...} ») et renvoie le message JSON-RPC.
function parseMcp(txt) {
  try { return JSON.parse(txt); } catch (e) {}
  const lines = String(txt).split(/\r?\n/).filter(l => l.startsWith("data:"));
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i].slice(5).trim()); } catch (e) {}
  }
  return null;
}

async function mcpPost(authHeaders, sessionId, payload, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 6000);
  try {
    const h = Object.assign({ "Content-Type": "application/json", "Accept": "application/json, text/event-stream" }, authHeaders);
    if (sessionId) h["Mcp-Session-Id"] = sessionId;
    const r = await fetch(BASE + "/mcp", { method: "POST", headers: h, body: JSON.stringify(payload), signal: ctrl.signal });
    const txt = await r.text();
    return { status: r.status, session: r.headers.get("mcp-session-id"), msg: parseMcp(txt), snippet: txt.slice(0, 400) };
  } catch (e) {
    return { status: 0, error: e.name + ": " + e.message };
  } finally { clearTimeout(t); }
}

// Extrait le JSON renvoyé par un outil MCP (content[0].text en général).
function toolPayload(msg) {
  if (!msg) return null;
  if (msg.error) return { rpc_error: msg.error };
  const res = msg.result || {};
  if (res.structuredContent) return res.structuredContent;
  const c = Array.isArray(res.content) && res.content.find(x => x.type === "text");
  if (c) { try { return JSON.parse(c.text); } catch (e) { return { text: String(c.text).slice(0, 400), isError: res.isError }; } }
  return res;
}

async function probeMcp() {
  const variants = [
    { name: "X-API-Key", h: { "X-API-Key": API_KEY } },
    { name: "Bearer", h: { "Authorization": "Bearer " + API_KEY } }
  ];
  const out = { variants: {} };
  for (const v of variants) {
    const rep = {};
    const init = await mcpPost(v.h, null, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "briffetools-probe", version: "1.0" } }
    });
    rep.initialize = { status: init.status, ok: !!(init.msg && init.msg.result), server: init.msg && init.msg.result && init.msg.result.serverInfo, error: init.error || (init.msg && init.msg.error), snippet: init.msg && init.msg.result ? undefined : init.snippet };
    if (!(init.msg && init.msg.result)) { out.variants[v.name] = rep; continue; }
    const sid = init.session;
    rep.session = !!sid;
    await mcpPost(v.h, sid, { jsonrpc: "2.0", method: "notifications/initialized" }, 4000);

    const list = await mcpPost(v.h, sid, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const tools = (list.msg && list.msg.result && list.msg.result.tools || []).map(t => t.name);
    rep.tools_count = tools.length;
    rep.has = {};
    ["search_articles", "article_reference", "update_article", "create_article", "search_providers", "update_provider", "category_tree"].forEach(n => { rep.has[n] = tools.includes(n); });

    const s = await mcpPost(v.h, sid, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_articles", arguments: { search: "beurre", limit: 1 } } });
    const sp = toolPayload(s.msg);
    rep.search_articles = { status: s.status, success: sp && sp.success, count: sp && sp.count, first: sp && Array.isArray(sp.data) && sp.data[0] ? sp.data[0].name : undefined, detail: sp && sp.success ? undefined : (sp || s.snippet) };

    const u = await mcpPost(v.h, sid, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "update_article", arguments: { id: TEST_ARTICLE_ID, comment: "", dry_run: true } } });
    const up = toolPayload(u.msg);
    rep.update_article_dry_run = { status: u.status, success: up && up.success, dry_run: up && up.dry_run, detail: up && up.success ? undefined : (up || u.snippet) };

    out.variants[v.name] = rep;
    if (rep.search_articles.success) break; // une variante qui marche suffit
  }
  const ok = Object.entries(out.variants).find(([, r]) => r.search_articles && r.search_articles.success);
  out.verdict = {
    auth_qui_marche: ok ? ok[0] : "aucune",
    lecture_articles: ok ? "OUI" : "NON",
    update_simule: ok && ok[1].update_article_dry_run && ok[1].update_article_dry_run.success && ok[1].update_article_dry_run.dry_run === true ? "OUI" : "NON"
  };
  return out;
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

  // Mode ?mode=mcp : passe par le serveur MCP Sextan (/mcp, JSON-RPC « streamable HTTP ») avec la clé API.
  // Lecture des articles + update simulé (dry_run, commentaire déjà vide) via les outils MCP.
  if (q.mode === "mcp") {
    report.mcp = await probeMcp();
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
