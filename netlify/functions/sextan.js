// Netlify Function: /api/sextan?id=NUM
// Récupère une réception depuis le serveur Sextan (MCP, stateless).
// Essaie plusieurs méthodes d'authentification et garde celle qui répond.
//
// Réglages (Netlify → Environment variables) :
//   SEXTAN_API_KEY  = clé "sxt_..."   (obligatoire)
//   SEXTAN_MCP_URL  = URL du serveur  (optionnel)

const MCP_URL = process.env.SEXTAN_MCP_URL || "https://briffe.sextan.catering/mcp";
const API_KEY = process.env.SEXTAN_API_KEY;

function cors() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function parseRpc(text, contentType) {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("text/event-stream") || text.startsWith("event:") || text.startsWith("data:")) {
    let last = null;
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^data:\s?(.*)$/);
      if (!m || !m[1].trim()) continue;
      try { const o = JSON.parse(m[1]); if (o && (o.result || o.error)) last = o; } catch (e) {}
    }
    return last;
  }
  try { return JSON.parse(text); } catch (e) { return null; }
}

function bodyFor(id) {
  return JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "event_details", arguments: { id: parseInt(id, 10), include: ["menu", "billing", "staff", "packs"] } }
  });
}

// Liste des méthodes d'auth à tenter, dans l'ordre
function authVariants(k) {
  const hex = k.replace(/^sxt_/, "");
  return [
    { label: "bearer",        headers: { "Authorization": "Bearer " + k } },
    { label: "xapikey_lower", headers: { "x-api-key": k } },
    { label: "xapikey_upper", headers: { "X-API-Key": k } },
    { label: "bearer+xapikey",headers: { "Authorization": "Bearer " + k, "x-api-key": k } },
    { label: "bearer_hex",    headers: { "Authorization": "Bearer " + hex } },
    { label: "auth_raw",      headers: { "Authorization": k } }
  ];
}

function isAuthError(rpc) {
  const m = (rpc && rpc.error && rpc.error.message || "").toLowerCase();
  return /bearer|token|unauthor|expired|invalid|forbidden|api.?key/.test(m);
}

async function callSextan(id, headers) {
  const resp = await fetch(MCP_URL, {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json", "Accept": "application/json, text/event-stream" }, headers),
    body: bodyFor(id)
  });
  const txt = await resp.text();
  return { status: resp.status, rpc: parseRpc(txt, resp.headers.get("content-type")), raw: txt };
}

function extractPayload(rpc) {
  const res = rpc.result || {};
  let payload = res.structuredContent || null;
  if (!payload && Array.isArray(res.content)) {
    const t = res.content.find(c => c.type === "text");
    if (t) { try { payload = JSON.parse(t.text); } catch (e) { payload = { raw: t.text }; } }
  }
  return payload || res;
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  if (!API_KEY) return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: "SEXTAN_API_KEY non configurée dans Netlify." }) };

  const q = event.queryStringParameters || {};

  // Diagnostic : forme de la clé (jamais la clé elle-même)
  if (q.debug === "1") {
    const k = API_KEY || "";
    return { statusCode: 200, headers: cors(), body: JSON.stringify({
      has_key: !!process.env.SEXTAN_API_KEY, keyLength: k.length, keyPrefixPublic: k.slice(0, 12),
      startsWithSxt: k.startsWith("sxt_"), hasWhitespace: /\s/.test(k), mcpUrl: MCP_URL
    }) };
  }
  // Diagnostic : essaie toutes les méthodes et renvoie le résultat de chacune
  if (q.debug === "2") {
    const results = {};
    for (const v of authVariants(API_KEY)) {
      try { const r = await callSextan(q.id || 1080, v.headers);
        results[v.label] = { status: r.status, body: (r.raw || "").slice(0, 140) }; }
      catch (e) { results[v.label] = { error: e.message }; }
    }
    return { statusCode: 200, headers: cors(), body: JSON.stringify(results) };
  }

  const id = q.id || "";
  if (!id) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "Paramètre id manquant" }) };

  try {
    let lastErr = null;
    for (const v of authVariants(API_KEY)) {
      const r = await callSextan(id, v.headers);
      if (r.rpc && r.rpc.result) {
        return { statusCode: 200, headers: cors(), body: JSON.stringify(extractPayload(r.rpc)) };
      }
      if (r.rpc && r.rpc.error && !isAuthError(r.rpc)) {
        // erreur "métier" (ex. réception introuvable) : inutile de tenter d'autres auth
        return { statusCode: 502, headers: cors(), body: JSON.stringify({ error: r.rpc.error.message || "Erreur Sextan", code: r.rpc.error.code }) };
      }
      lastErr = (r.rpc && r.rpc.error && r.rpc.error.message) || ("HTTP " + r.status);
    }
    return { statusCode: 502, headers: cors(), body: JSON.stringify({ error: "Authentification Sextan refusée (" + lastErr + ")" }) };
  } catch (e) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: e.message }) };
  }
};
