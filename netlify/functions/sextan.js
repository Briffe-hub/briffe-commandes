// Netlify Function: /api/sextan?id=NUM
// Détail d'une réception via l'API REST Sextan (POST /api/events/details),
// repli sur /api/events/search (résumé). Appels bornés par un délai.

const BASE = (process.env.SEXTAN_BASE || "https://briffe.sextan.catering").replace(/\/+$/, "");
const API_KEY = process.env.SEXTAN_API_KEY || "";
const AUTH = { "X-API-Key": API_KEY };

function cors() { return { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" }; }

async function call(path, body, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 7000);
  try {
    const r = await fetch(BASE + path, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json", "Accept": "application/json" }, AUTH),
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const txt = await r.text();
    let json = null; try { json = JSON.parse(txt); } catch (e) {}
    return { status: r.status, json, len: txt.length };
  } finally { clearTimeout(t); }
}

function firstEvent(json) {
  if (!json) return null;
  if (Array.isArray(json.data)) return json.data[0];
  if (json.data && json.data.id) return json.data;
  if (json.id) return json;
  return null;
}
const hasDetail = ev => !!(ev && (ev.menu || ev.billing || ev.content || ev.products));

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  if (!API_KEY) return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: "SEXTAN_API_KEY non configurée." }) };
  const q = event.queryStringParameters || {};
  const id = q.id || "1550";
  const n = parseInt(id, 10);

  // santé (aucun réseau)
  if (q.debug === "1") {
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ alive: true, base: BASE, keyLen: API_KEY.length }) };
  }
  // détail : un seul appel, on renvoie la forme
  if (q.debug === "7") {
    try {
      const r = await call("/api/events/details", { id: n, include: ["menu", "billing", "staff", "packs"] }, 8000);
      const ev = firstEvent(r.json);
      return { statusCode: 200, headers: cors(), body: JSON.stringify({
        status: r.status, len: r.len,
        allKeys: ev ? Object.keys(ev) : null,
        hasMenu: !!(ev && ev.menu), hasBilling: !!(ev && ev.billing),
        menuType: ev && ev.menu ? (Array.isArray(ev.menu) ? "array" : typeof ev.menu) : null,
        stepsLen: ev && ev.menu && ev.menu.steps ? ev.menu.steps.length : null,
        firstProduct: (ev && ev.menu && ev.menu.steps && ev.menu.steps[0] && ev.menu.steps[0].products && ev.menu.steps[0].products[0]) || null,
        firstBilling: (ev && ev.billing && ev.billing.items && ev.billing.items[0]) || null
      }) };
    } catch (e) { return { statusCode: 200, headers: cors(), body: JSON.stringify({ error: e.name + ": " + e.message }) }; }
  }

  if (!q.id) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "Paramètre id manquant" }) };
  try {
    let ev = null;
    try { const r = await call("/api/events/details", { id: n, include: ["menu", "billing", "staff", "packs"] }, 8000); ev = firstEvent(r.json); } catch (e) {}
    if (!hasDetail(ev)) {
      try { const r2 = await call("/api/events/search", { id: n }, 6000); const s = firstEvent(r2.json); if (s) ev = ev || s; } catch (e) {}
    }
    if (!ev) return { statusCode: 502, headers: cors(), body: JSON.stringify({ error: "Réception introuvable ou service indisponible." }) };
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ data: [ev] }) };
  } catch (e) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: e.message }) };
  }
};
