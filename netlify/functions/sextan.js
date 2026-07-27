// Netlify Function: /api/sextan?id=NUM
// Client MCP (Streamable HTTP) complet : initialize -> session -> tools/call.
// Auth par en-tête X-API-Key (comme les clients MCP officiels), repli Bearer.
//
// Netlify env : SEXTAN_API_KEY = "sxt_...", SEXTAN_MCP_URL (optionnel).

const MCP_URL = process.env.SEXTAN_MCP_URL || "https://briffe.sextan.catering/mcp";
const API_KEY = process.env.SEXTAN_API_KEY;

function cors() {
  return { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" };
}
function parseRpc(text, ct) {
  ct = (ct || "").toLowerCase();
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
function extractPayload(rpc) {
  const res = rpc.result || {};
  let p = res.structuredContent || null;
  if (!p && Array.isArray(res.content)) { const t = res.content.find(c => c.type === "text"); if (t) { try { p = JSON.parse(t.text); } catch (e) { p = { raw: t.text }; } } }
  return p || res;
}

// Séquence MCP complète avec un jeu d'en-têtes d'auth donné
async function mcpSequence(id, auth, trace) {
  const base = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" };
  const h1 = Object.assign({}, base, auth);
  // 1) initialize
  const r1 = await fetch(MCP_URL, { method: "POST", headers: h1, body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "briffe-prepa", version: "1.0" } }
  }) });
  const sid = r1.headers.get("mcp-session-id");
  const t1 = await r1.text();
  if (trace) trace.initialize = { status: r1.status, sid: sid || null, body: t1.slice(0, 160) };
  const rpc1 = parseRpc(t1, r1.headers.get("content-type"));
  if (!rpc1 || rpc1.error) return { ok: false, where: "initialize", status: r1.status, rpc: rpc1 };
  const h2 = Object.assign({}, h1, sid ? { "Mcp-Session-Id": sid } : {});
  // 2) initialized (notification)
  try { await fetch(MCP_URL, { method: "POST", headers: h2, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }); } catch (e) {}
  // 3) tools/call
  const r3 = await fetch(MCP_URL, { method: "POST", headers: h2, body: JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "event_details", arguments: { id: parseInt(id, 10), include: ["menu", "billing", "staff", "packs"] } }
  }) });
  const t3 = await r3.text();
  if (trace) trace.toolscall = { status: r3.status, body: t3.slice(0, 160) };
  const rpc3 = parseRpc(t3, r3.headers.get("content-type"));
  if (rpc3 && rpc3.result) return { ok: true, payload: extractPayload(rpc3) };
  return { ok: false, where: "tools/call", status: r3.status, rpc: rpc3 };
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  if (!API_KEY) return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: "SEXTAN_API_KEY non configurée dans Netlify." }) };
  const q = event.queryStringParameters || {};
  const k = API_KEY;

  if (q.debug === "1") {
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ has_key: !!k, keyLength: k.length, keyPrefixPublic: k.slice(0, 12), startsWithSxt: k.startsWith("sxt_"), hasWhitespace: /\s/.test(k), mcpUrl: MCP_URL }) };
  }
  if (q.debug === "3") {
    const out = {};
    const tX = {}; const rX = await mcpSequence(q.id || 1080, { "X-API-Key": k }, tX); out.xapikey = { trace: tX, ok: rX.ok, err: rX.rpc && rX.rpc.error };
    const tB = {}; const rB = await mcpSequence(q.id || 1080, { "Authorization": "Bearer " + k }, tB); out.bearer = { trace: tB, ok: rB.ok, err: rB.rpc && rB.rpc.error };
    return { statusCode: 200, headers: cors(), body: JSON.stringify(out) };
  }

  const id = q.id || "";
  if (!id) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "Paramètre id manquant" }) };

  try {
    let last = null;
    for (const auth of [{ "X-API-Key": k }, { "Authorization": "Bearer " + k }]) {
      const r = await mcpSequence(id, auth);
      if (r.ok) return { statusCode: 200, headers: cors(), body: JSON.stringify(r.payload) };
      last = r;
      // erreur métier (pas d'auth) -> stop
      const msg = (r.rpc && r.rpc.error && r.rpc.error.message || "").toLowerCase();
      if (r.rpc && r.rpc.error && !/bearer|token|unauthor|expired|invalid|api.?key|forbidden/.test(msg)) {
        return { statusCode: 502, headers: cors(), body: JSON.stringify({ error: r.rpc.error.message, code: r.rpc.error.code }) };
      }
    }
    const m = (last && last.rpc && last.rpc.error && last.rpc.error.message) || ("HTTP " + (last && last.status));
    return { statusCode: 502, headers: cors(), body: JSON.stringify({ error: "Sextan a refusé la requête (" + m + ")" }) };
  } catch (e) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: e.message }) };
  }
};
