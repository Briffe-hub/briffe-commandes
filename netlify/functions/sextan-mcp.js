// Netlify Function : /.netlify/functions/sextan-mcp  (alias /api/sextan-mcp)
// Connexion de briffetools au serveur MCP Sextan par OAuth (doc Sextan : OAuth seul,
// enregistrement dynamique d'un client public, PKCE S256, Streamable HTTP).
//
// Actions (POST JSON, protégées par l'en-tête x-briffe-pass = BRIFFE_AUTH_PASSWORD) :
//   { action:"start" }      -> { url }  : adresse de la page de connexion Sextan
//   { action:"status" }     -> état de la connexion + test (outils visibles, lecture article,
//                              modification SIMULÉE dry_run sur un champ déjà vide)
//   { action:"disconnect" } -> oublie les jetons
// Retour OAuth : GET sur cette même adresse avec ?code=&state= (page HTML de confirmation).
//
// Stockage : Netlify Blobs (store « briffe-sextan-mcp », clés client / pending / tokens),
// via l'API REST, avec SITE_ID + NETLIFY_TOKEN comme les autres fonctions.
// Le compte Sextan connecté (prévu : « briffetools ») est celui au nom duquel tout est fait.

const crypto = require("crypto");

const SEXTAN = (process.env.SEXTAN_BASE || "https://briffe.sextan.catering").replace(/\/+$/, "");
const MCP_URL = SEXTAN + "/mcp";
const SITE_ID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
const NTOKEN = process.env.NETLIFY_TOKEN || process.env.NETLIFY_API_KEY;
const STORE = "briffe-sextan-mcp";
const TEST_ARTICLE_ID = 154; // « Beurre extra-sec 84% », commentaire vide
const PENDING_TTL_MS = 15 * 60 * 1000;

// ---------- utilitaires HTTP ----------
function jsonHeaders() {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, x-briffe-pass",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Cache-Control": "no-store"
  };
}
const json = (code, obj) => ({ statusCode: code, headers: jsonHeaders(), body: JSON.stringify(obj, null, 2) });
const html = (code, body) => ({ statusCode: code, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }, body });

function checkPass(event) {
  const allowed = String(process.env.BRIFFE_AUTH_PASSWORD || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!allowed.length) return false;
  const h = event.headers || {};
  const given = String(h["x-briffe-pass"] || h["X-Briffe-Pass"] || "").trim();
  return allowed.includes(given);
}

async function fetchT(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 6000);
  try { return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal })); }
  finally { clearTimeout(t); }
}

// ---------- Netlify Blobs ----------
const blobUrl = key => `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${STORE}/${encodeURIComponent(key)}`;
async function blobGet(key) {
  const r = await fetchT(blobUrl(key), { headers: { Authorization: "Bearer " + NTOKEN } }, 5000);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("Blob GET " + key + " " + r.status);
  return r.json();
}
async function blobSet(key, value) {
  const r = await fetchT(blobUrl(key), {
    method: "PUT", headers: { Authorization: "Bearer " + NTOKEN, "Content-Type": "application/json" }, body: JSON.stringify(value)
  }, 5000);
  if (!r.ok) throw new Error("Blob PUT " + key + " " + r.status);
}
async function blobDel(key) {
  await fetchT(blobUrl(key), { method: "DELETE", headers: { Authorization: "Bearer " + NTOKEN } }, 5000).catch(() => {});
}

// ---------- OAuth : découverte ----------
async function getJson(url) {
  try {
    const r = await fetchT(url, { headers: { Accept: "application/json" } }, 5000);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

async function discover() {
  const origin = new URL(SEXTAN).origin;
  // 1) métadonnées de la ressource protégée -> serveur d'autorisation
  let prm = await getJson(origin + "/.well-known/oauth-protected-resource/mcp")
         || await getJson(origin + "/.well-known/oauth-protected-resource");
  const as = (prm && Array.isArray(prm.authorization_servers) && prm.authorization_servers[0]) || origin;
  const asOrigin = as.replace(/\/+$/, "");
  const asPath = new URL(asOrigin).pathname.replace(/\/+$/, "");
  const asRoot = new URL(asOrigin).origin;
  // 2) métadonnées du serveur d'autorisation (RFC 8414, puis OpenID)
  const meta = await getJson(asRoot + "/.well-known/oauth-authorization-server" + asPath)
            || await getJson(asOrigin + "/.well-known/oauth-authorization-server")
            || await getJson(asOrigin + "/.well-known/openid-configuration");
  if (!meta || !meta.authorization_endpoint || !meta.token_endpoint) {
    throw new Error("Découverte OAuth impossible (métadonnées du serveur d'autorisation introuvables).");
  }
  return {
    resource: (prm && prm.resource) || MCP_URL,
    authorization_endpoint: meta.authorization_endpoint,
    token_endpoint: meta.token_endpoint,
    registration_endpoint: meta.registration_endpoint || null,
    scopes: (prm && prm.scopes_supported) || meta.scopes_supported || null
  };
}

function redirectUri(event) {
  const h = event.headers || {};
  const host = h["x-forwarded-host"] || h.host;
  return "https://" + host + "/.netlify/functions/sextan-mcp";
}

async function ensureClient(disc, redirect) {
  const saved = await blobGet("client");
  if (saved && saved.client_id && saved.redirect_uri === redirect && saved.registration_endpoint === disc.registration_endpoint) return saved;
  if (!disc.registration_endpoint) throw new Error("Le serveur Sextan n'annonce pas d'enregistrement dynamique de client.");
  const r = await fetchT(disc.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "briffetools",
      redirect_uris: [redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    })
  }, 6000);
  const txt = await r.text();
  let j = null; try { j = JSON.parse(txt); } catch (e) {}
  if (!r.ok || !j || !j.client_id) throw new Error("Enregistrement du client refusé (" + r.status + ") : " + txt.slice(0, 300));
  const client = { client_id: j.client_id, redirect_uri: redirect, registration_endpoint: disc.registration_endpoint, created: new Date().toISOString() };
  await blobSet("client", client);
  return client;
}

const b64url = buf => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// ---------- OAuth : jetons ----------
async function tokenRequest(disc, params) {
  const r = await fetchT(disc.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params).toString()
  }, 7000);
  const txt = await r.text();
  let j = null; try { j = JSON.parse(txt); } catch (e) {}
  if (!r.ok || !j || !j.access_token) throw new Error("Échange de jeton refusé (" + r.status + ") : " + txt.slice(0, 300));
  return j;
}

function storeShape(tok, previous) {
  return {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || (previous && previous.refresh_token) || null,
    expires_at: tok.expires_in ? Date.now() + tok.expires_in * 1000 : null,
    scope: tok.scope || (previous && previous.scope) || null,
    obtained_at: new Date().toISOString()
  };
}

// Renvoie un jeton d'accès valide (renouvelé si besoin), ou lève une erreur « reconnexion nécessaire ».
async function getAccessToken() {
  const tokens = await blobGet("tokens");
  if (!tokens || !tokens.access_token) { const e = new Error("Sextan n'est pas connecté."); e.code = "NOT_CONNECTED"; throw e; }
  const fresh = !tokens.expires_at || tokens.expires_at - Date.now() > 60 * 1000;
  if (fresh) return tokens.access_token;
  if (!tokens.refresh_token) { const e = new Error("Jeton expiré, reconnexion nécessaire."); e.code = "RECONNECT"; throw e; }
  const disc = await discover();
  const client = await blobGet("client");
  try {
    const tok = await tokenRequest(disc, {
      grant_type: "refresh_token", refresh_token: tokens.refresh_token,
      client_id: client.client_id, resource: disc.resource
    });
    const saved = storeShape(tok, tokens);
    await blobSet("tokens", saved);
    return saved.access_token;
  } catch (e) {
    const err = new Error("Renouvellement refusé, reconnexion nécessaire. " + e.message); err.code = "RECONNECT"; throw err;
  }
}

// ---------- MCP (JSON-RPC, Streamable HTTP) ----------
function parseMcp(txt) {
  try { return JSON.parse(txt); } catch (e) {}
  const lines = String(txt).split(/\r?\n/).filter(l => l.startsWith("data:"));
  for (let i = lines.length - 1; i >= 0; i--) { try { return JSON.parse(lines[i].slice(5).trim()); } catch (e) {} }
  return null;
}
async function mcpPost(token, sessionId, payload, ms) {
  const h = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer " + token };
  if (sessionId) h["Mcp-Session-Id"] = sessionId;
  const r = await fetchT(MCP_URL, { method: "POST", headers: h, body: JSON.stringify(payload) }, ms || 7000);
  const txt = await r.text();
  return { status: r.status, session: r.headers.get("mcp-session-id"), msg: parseMcp(txt), snippet: txt.slice(0, 300) };
}
async function mcpSession(token) {
  const init = await mcpPost(token, null, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "briffetools", version: "1.0" } }
  });
  if (!(init.msg && init.msg.result)) {
    const e = new Error("Ouverture de session MCP refusée (" + init.status + ") : " + ((init.msg && init.msg.error && init.msg.error.message) || init.snippet));
    if (init.status === 401) e.code = "RECONNECT";
    throw e;
  }
  const sid = init.session;
  await mcpPost(token, sid, { jsonrpc: "2.0", method: "notifications/initialized" }, 4000).catch(() => {});
  return { sid, server: init.msg.result.serverInfo || null };
}
function toolPayload(msg) {
  if (!msg) return null;
  if (msg.error) return { success: false, rpc_error: msg.error };
  const res = msg.result || {};
  if (res.structuredContent) return res.structuredContent;
  const c = Array.isArray(res.content) && res.content.find(x => x.type === "text");
  if (c) { try { return JSON.parse(c.text); } catch (e) { return { success: !res.isError, text: String(c.text).slice(0, 500) }; } }
  return res;
}
let rpcId = 10;
async function callTool(token, sid, name, args) {
  const r = await mcpPost(token, sid, { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args || {} } });
  return toolPayload(r.msg) || { success: false, status: r.status, text: r.snippet };
}

// ---------- page de retour OAuth ----------
function donePage(ok, message) {
  const color = ok ? "#22c55e" : "#ef4444";
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connexion Sextan</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f0f0f;color:#e8e8e0;font-family:ui-monospace,Menlo,monospace;padding:16px}
.box{max-width:460px;border:1px solid #2a2a2a;background:#141414;padding:28px;border-radius:10px}
h1{font-size:15px;letter-spacing:.12em;text-transform:uppercase;color:${color};margin:0 0 12px}p{font-size:13px;line-height:1.6;color:#b5b5ad}a{color:#e8e8e0}</style></head>
<body><div class="box"><h1>${ok ? "Sextan connecté" : "Connexion échouée"}</h1><p>${message}</p><p><a href="/briffe-prix.html">Retour au module prix fournisseurs</a></p></div></body></html>`;
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------- handler ----------
exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: jsonHeaders(), body: "" };
  if (!SITE_ID || !NTOKEN) return json(500, { error: "SITE_ID / NETLIFY_TOKEN non configurés (stockage des jetons)." });

  // Retour de la page de connexion Sextan
  if (event.httpMethod === "GET") {
    const q = event.queryStringParameters || {};
    if (q.error) return html(400, donePage(false, "Sextan a refusé l'autorisation : " + esc(q.error_description || q.error)));
    if (!q.code || !q.state) return html(400, donePage(false, "Paramètres de retour manquants."));
    try {
      const pending = await blobGet("pending");
      if (!pending || pending.state !== q.state) return html(400, donePage(false, "Demande de connexion inconnue ou déjà utilisée. Relance la connexion depuis le module."));
      if (Date.now() - pending.created > PENDING_TTL_MS) return html(400, donePage(false, "Demande de connexion expirée. Relance la connexion depuis le module."));
      await blobDel("pending");
      const disc = await discover();
      const tok = await tokenRequest(disc, {
        grant_type: "authorization_code", code: q.code, redirect_uri: pending.redirect_uri,
        client_id: pending.client_id, code_verifier: pending.verifier, resource: disc.resource
      });
      await blobSet("tokens", storeShape(tok, null));
      return html(200, donePage(true, "briffetools peut maintenant lire et modifier les articles Sextan, dans la limite des droits du compte connecté. Tu peux fermer cette page."));
    } catch (e) {
      return html(500, donePage(false, esc(e.message)));
    }
  }

  if (event.httpMethod !== "POST") return json(405, { error: "Méthode non autorisée" });
  if (!checkPass(event)) return json(401, { error: "Mot de passe Briffe manquant ou incorrect." });
  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch (e) {}

  try {
    if (body.action === "start") {
      const disc = await discover();
      const redirect = redirectUri(event);
      const client = await ensureClient(disc, redirect);
      const verifier = b64url(crypto.randomBytes(48));
      const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
      const state = b64url(crypto.randomBytes(24));
      await blobSet("pending", { state, verifier, client_id: client.client_id, redirect_uri: redirect, created: Date.now() });
      const u = new URL(disc.authorization_endpoint);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("client_id", client.client_id);
      u.searchParams.set("redirect_uri", redirect);
      u.searchParams.set("code_challenge", challenge);
      u.searchParams.set("code_challenge_method", "S256");
      u.searchParams.set("state", state);
      u.searchParams.set("resource", disc.resource);
      u.searchParams.set("prompt", "login"); // force la saisie des identifiants (évite de réutiliser une session Sextan déjà ouverte)
      if (Array.isArray(disc.scopes) && disc.scopes.length) u.searchParams.set("scope", disc.scopes.join(" "));
      return json(200, { url: u.toString() });
    }

    if (body.action === "disconnect") {
      await blobDel("tokens");
      return json(200, { ok: true });
    }

    if (body.action === "status") {
      const tokens = await blobGet("tokens");
      if (!tokens) return json(200, { connected: false });
      const out = { connected: true, expires_at: tokens.expires_at ? new Date(tokens.expires_at).toISOString() : null, has_refresh: !!tokens.refresh_token, obtained_at: tokens.obtained_at };
      const token = await getAccessToken();
      const { sid, server } = await mcpSession(token);
      out.server = server;
      const [list, search, upd] = await Promise.all([
        mcpPost(token, sid, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
        callTool(token, sid, "search_articles", { search: "beurre", limit: 1 }),
        callTool(token, sid, "update_article", { id: TEST_ARTICLE_ID, comment: "", dry_run: true })
      ]);
      out.tools = ((list.msg && list.msg.result && list.msg.result.tools) || []).map(t => t.name).sort();
      out.test_lecture = search && search.success ? { ok: true, article: search.data && search.data[0] && search.data[0].name } : { ok: false, detail: search };
      out.test_ecriture_simulee = upd && upd.success && upd.dry_run === true ? { ok: true } : { ok: false, detail: upd };
      return json(200, out);
    }

    return json(400, { error: "Action inconnue" });
  } catch (e) {
    return json(e.code === "NOT_CONNECTED" ? 200 : 502, { connected: e.code === "NOT_CONNECTED" ? false : undefined, reconnect: e.code === "RECONNECT" || undefined, error: e.message });
  }
};

// Exporté pour le futur module prix (appel d'outils MCP avec jeton renouvelé automatiquement).
exports.getAccessToken = getAccessToken;
exports.mcpSession = mcpSession;
exports.callTool = callTool;
