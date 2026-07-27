// Netlify Function: /api/sextan?id=NUM
// Récupère une réception via l'API REST Sextan.
// Résumé via /api/events/search ; menu/facturation via routes dédiées (en cours de calage).

const BASE = (process.env.SEXTAN_BASE || "https://briffe.sextan.catering").replace(/\/+$/, "");
const API_KEY = process.env.SEXTAN_API_KEY || "";
const AUTH = { "X-API-Key": API_KEY };

function cors() { return { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" }; }

async function call(method, path, body) {
  const opts = { method, headers: Object.assign({ "Accept": "application/json" }, AUTH) };
  if (body) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const r = await fetch(BASE + path, opts);
  const txt = await r.text();
  let json = null; try { json = JSON.parse(txt); } catch (e) {}
  return { status: r.status, ct: (r.headers.get("content-type") || "").split(";")[0], json, txt };
}

async function summary(id) {
  const r = await call("POST", "/api/events/search", { id: parseInt(id, 10) });
  return r.json && r.json.data && r.json.data[0];
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  if (!API_KEY) return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: "SEXTAN_API_KEY non configurée." }) };
  const q = event.queryStringParameters || {};
  const id = q.id || "1550";
  const n = parseInt(id, 10);

  // Sonde d'endpoints menu/facturation
  if (q.debug === "6") {
    const probes = [
      ["GET",  "/api/events/" + n],
      ["GET",  "/api/events/" + n + "?include=menu,billing,staff"],
      ["POST", "/api/events/get", { id: n, include: ["menu", "billing", "staff"] }],
      ["POST", "/api/events/details", { id: n }],
      ["POST", "/api/products/search", { event: n }],
      ["POST", "/api/products/search", { event_id: n }],
      ["POST", "/api/products/search", { reception: n }],
      ["POST", "/api/event-products/search", { event: n }],
      ["POST", "/api/billing/search", { event: n }],
      ["POST", "/api/steps/search", { event: n }],
      ["POST", "/api/menus/search", { event: n }],
      ["GET",  "/api/events/" + n + "/products"],
      ["GET",  "/api/events/" + n + "/menu"],
      ["GET",  "/api/events/" + n + "/billing"]
    ];
    const out = [];
    for (const [m, p, b] of probes) {
      try {
        const r = await call(m, p, b);
        let shape = null;
        if (r.json) {
          if (Array.isArray(r.json)) shape = { array: r.json.length, first: r.json[0] ? Object.keys(r.json[0]).slice(0, 12) : null };
          else if (Array.isArray(r.json.data)) shape = { dataArray: r.json.data.length, first: r.json.data[0] ? Object.keys(r.json.data[0]).slice(0, 12) : null };
          else shape = { keys: Object.keys(r.json).slice(0, 15) };
        }
        out.push({ ep: m + " " + p + (b ? " " + Object.keys(b).join(",") : ""), status: r.status, ct: r.ct, shape });
      } catch (e) { out.push({ ep: m + " " + p, error: e.message }); }
    }
    return { statusCode: 200, headers: cors(), body: JSON.stringify(out) };
  }

  // Chemin normal : résumé (toujours), enrichi si on trouve mieux plus tard
  if (!q.id) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "Paramètre id manquant" }) };
  try {
    const ev = await summary(id);
    if (!ev) return { statusCode: 502, headers: cors(), body: JSON.stringify({ error: "Réception introuvable." }) };
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ data: [ev] }) };
  } catch (e) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: e.message }) };
  }
};
