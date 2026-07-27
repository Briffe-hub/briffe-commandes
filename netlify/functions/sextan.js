// Netlify Function: /api/sextan?id=NUM
// Accès aux données Sextan. Deux pistes gérées :
//   - API REST /api/... avec la clé sxt_ (X-API-Key ou Bearer)
//   - (repli) MCP /mcp
// SEXTAN_API_KEY = clé "sxt_..."   ;  SEXTAN_BASE (optionnel, défaut ci-dessous)

const BASE = (process.env.SEXTAN_BASE || "https://briffe.sextan.catering").replace(/\/+$/, "");
const API_KEY = process.env.SEXTAN_API_KEY || "";

function cors() {
  return { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" };
}

// Endpoints REST candidats pour le détail d'une réception
function candidates(id) {
  return [
    ["GET",  "/api/events/" + id],
    ["GET",  "/api/event/" + id],
    ["GET",  "/api/receptions/" + id],
    ["GET",  "/api/reception/" + id],
    ["GET",  "/api/quotes/" + id],
    ["GET",  "/api/quote/" + id],
    ["POST", "/api/events/search",     { id: parseInt(id, 10) }],
    ["POST", "/api/receptions/search", { id: parseInt(id, 10) }]
  ];
}

async function tryCall(method, path, auth, body) {
  const headers = Object.assign({ "Accept": "application/json" }, auth);
  const opts = { method, headers };
  if (body) { headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const r = await fetch(BASE + path, opts);
  const txt = await r.text();
  return { status: r.status, ct: r.headers.get("content-type") || "", body: txt };
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  if (!API_KEY) return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: "SEXTAN_API_KEY non configurée." }) };
  const q = event.queryStringParameters || {};
  const id = q.id || "1080";

  // ── Mode sonde : teste les endpoints REST avec les 2 styles d'auth ──────────
  if (q.debug === "4") {
    const auths = [
      ["xapikey", { "X-API-Key": API_KEY }],
      ["bearer",  { "Authorization": "Bearer " + API_KEY }]
    ];
    const out = [];
    for (const [alabel, ah] of auths) {
      for (const [method, path, body] of candidates(id)) {
        try {
          const r = await tryCall(method, path, ah, body);
          out.push({ auth: alabel, method, path, status: r.status, ct: r.ct.split(";")[0], snippet: r.body.slice(0, 120).replace(/\s+/g, " ") });
        } catch (e) { out.push({ auth: alabel, method, path, error: e.message }); }
      }
    }
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ base: BASE, id, results: out }) };
  }

  // ── Chemin normal : tente les endpoints REST, renvoie le 1er qui donne du JSON réception ──
  const auths = [{ "X-API-Key": API_KEY }, { "Authorization": "Bearer " + API_KEY }];
  let lastInfo = null;
  try {
    for (const ah of auths) {
      for (const [method, path, body] of candidates(id)) {
        let r;
        try { r = await tryCall(method, path, ah, body); } catch (e) { continue; }
        lastInfo = { path, status: r.status };
        if (r.status === 200 && /json/i.test(r.ct)) {
          let j; try { j = JSON.parse(r.body); } catch (e) { continue; }
          // normalise : on veut un objet réception (avec nbr_pax) éventuellement enveloppé
          const ev = (j && j.data && (Array.isArray(j.data) ? j.data[0] : j.data)) || j;
          if (ev && (ev.nbr_pax != null || ev.id != null)) {
            return { statusCode: 200, headers: cors(), body: JSON.stringify({ data: [ev] }) };
          }
        }
      }
    }
    return { statusCode: 502, headers: cors(), body: JSON.stringify({ error: "Aucun endpoint REST n'a renvoyé la réception (dernier: " + (lastInfo && lastInfo.path) + " → " + (lastInfo && lastInfo.status) + ")" }) };
  } catch (e) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: e.message }) };
  }
};
