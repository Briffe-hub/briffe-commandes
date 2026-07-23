// Netlify Function: /api/sextan?id=NUM
// Récupère une réception depuis le serveur Sextan (MCP over HTTP) via event_details,
// et renvoie le JSON { success, data:[event] } tel quel au front (briffe-prepa).
//
// Auth : header X-API-Key = process.env.SEXTAN_API_KEY (format "sxt_...").
// Endpoint : process.env.SEXTAN_MCP_URL (défaut ci-dessous).
//
// Le serveur Sextan parle le protocole MCP (JSON-RPC). Séquence :// Netlify Function: /api/sextan?id=NUM
// Récupère une réception depuis le serveur Sextan (MCP, mais STATELESS : un seul POST).
// Renvoie { success, data:[event] } au front (briffe-prepa).
//
// Réglages (Netlify → Environment variables) :
//   SEXTAN_API_KEY  = clé "sxt_..."   (obligatoire)
//   SEXTAN_MCP_URL  = URL du serveur  (optionnel, défaut ci-dessous)

const MCP_URL = process.env.SEXTAN_MCP_URL || "https://briffe.sextan.catering/mcp";
const API_KEY = process.env.SEXTAN_API_KEY;

function cors() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

// Extrait l'objet JSON-RPC (réponse JSON simple OU flux SSE "data: ...")
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

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  if (!API_KEY) return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: "SEXTAN_API_KEY non configurée dans Netlify." }) };

  const id = (event.queryStringParameters && event.queryStringParameters.id) || "";
  if (!id) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "Paramètre id manquant" }) };

  try {
    const resp = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "X-API-Key": API_KEY
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "event_details",
          arguments: { id: parseInt(id, 10), include: ["menu", "billing", "staff", "packs"] }
        }
      })
    });

    const txt = await resp.text();
    const rpc = parseRpc(txt, resp.headers.get("content-type"));

    if (!rpc) {
      return { statusCode: 502, headers: cors(), body: JSON.stringify({ error: "Réponse Sextan illisible (HTTP " + resp.status + ")", raw: txt.slice(0, 400) }) };
    }
    if (rpc.error) {
      return { statusCode: 502, headers: cors(), body: JSON.stringify({ error: rpc.error.message || "Erreur Sextan", code: rpc.error.code }) };
    }

    // Le résultat MCP encapsule le JSON dans content[].text (ou structuredContent)
    const res = rpc.result || {};
    let payload = res.structuredContent || null;
    if (!payload && Array.isArray(res.content)) {
      const t = res.content.find(c => c.type === "text");
      if (t) { try { payload = JSON.parse(t.text); } catch (e) { payload = { raw: t.text }; } }
    }
    if (!payload) payload = res;

    return { statusCode: 200, headers: cors(), body: JSON.stringify(payload) };
  } catch (e) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: e.message }) };
  }
};
//   1. initialize            -> récupère éventuellement un mcp-session-id
//   2. notifications/initialized
//   3. tools/call event_details { id, include }
// La réponse peut être du JSON simple ou du SSE (text/event-stream) : les deux sont gérés.

const MCP_URL = process.env.SEXTAN_MCP_URL || "https://briffe.sextan.catering/mcp";
const API_KEY = process.env.SEXTAN_API_KEY;

function cors() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

// Extrait l'objet JSON-RPC d'une réponse MCP (JSON direct OU flux SSE)
function parseMcpBody(text, contentType) {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("text/event-stream") || text.startsWith("event:") || text.startsWith("data:")) {
    // On concatène les lignes "data:" et on garde le dernier objet contenant "result" ou "error"
    let last = null;
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^data:\s?(.*)$/);
      if (!m || !m[1].trim()) continue;
      try {
        const obj = JSON.parse(m[1]);
        if (obj && (obj.result || obj.error)) last = obj;
      } catch (e) { /* ligne partielle, on ignore */ }
    }
    return last;
  }
  try { return JSON.parse(text); } catch (e) { return null; }
}

async function mcpPost(payload, sessionId) {
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "X-API-Key": API_KEY
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const r = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(payload) });
  const sid = r.headers.get("mcp-session-id") || sessionId || null;
  const txt = await r.text();
  return { status: r.status, sid, body: parseMcpBody(txt, r.headers.get("content-type")), raw: txt };
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  if (!API_KEY) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: "SEXTAN_API_KEY non configurée dans Netlify." }) };
  }

  const id = (event.queryStringParameters && event.queryStringParameters.id) || "";
  if (!id) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "Paramètre id manquant" }) };

  try {
    // 1. initialize
    const init = await mcpPost({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "briffe-prepa", version: "1.0" }
      }
    });
    const sid = init.sid;

    // 2. initialized (notification, sans id) — best effort
    try {
      await mcpPost({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, sid);
    } catch (e) { /* certains serveurs stateless n'en ont pas besoin */ }

    // 3. tools/call event_details
    const call = await mcpPost({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: {
        name: "event_details",
        arguments: { id: parseInt(id, 10), include: ["menu", "billing", "staff", "packs"] }
      }
    }, sid);

    if (!call.body || call.body.error) {
      return { statusCode: 502, headers: cors(), body: JSON.stringify({ error: (call.body && call.body.error && call.body.error.message) || "Réponse Sextan invalide", raw: call.raw.slice(0, 500) }) };
    }

    // Le résultat MCP encapsule le JSON dans content[].text (ou structuredContent)
    const res = call.body.result || {};
    let payload = res.structuredContent || null;
    if (!payload && Array.isArray(res.content)) {
      const t = res.content.find(c => c.type === "text");
      if (t) { try { payload = JSON.parse(t.text); } catch (e) { payload = { raw: t.text }; } }
    }
    if (!payload) payload = res;

    return { statusCode: 200, headers: cors(), body: JSON.stringify(payload) };
  } catch (e) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: e.message }) };
  }
};
