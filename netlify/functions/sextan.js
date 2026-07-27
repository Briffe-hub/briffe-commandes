// Netlify Function: /api/sextan?id=NUM
// Récupère une réception via l'API REST Sextan : POST /api/events/search
// en demandant l'inclusion du menu / de la facturation.
// SEXTAN_API_KEY = clé "sxt_..."  ;  SEXTAN_BASE (optionnel)

const BASE = (process.env.SEXTAN_BASE || "https://briffe.sextan.catering").replace(/\/+$/, "");
const API_KEY = process.env.SEXTAN_API_KEY || "";

function cors() {
  return { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" };
}

async function post(path, body, auth) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json", "Accept": "application/json" }, auth),
    body: JSON.stringify(body)
  });
  const txt = await r.text();
  let json = null; try { json = JSON.parse(txt); } catch (e) {}
  return { status: r.status, json, txt };
}

const AUTH = { "X-API-Key": API_KEY };
const AUTH2 = { "Authorization": "Bearer " + API_KEY };

// corps à essayer pour obtenir la réception AVEC le menu et la facturation
function searchBodies(id) {
  const n = parseInt(id, 10);
  const inc = ["menu", "billing", "staff", "packs"];
  return [
    { id: n, include: inc },
    { id: n, includes: inc },
    { id: n, with: inc },
    { id: n, expand: inc },
    { id: n, include: inc.join(",") },
    { id: n, full: true },
    { id: n }
  ];
}

function hasDetail(ev) {
  return ev && (ev.menu || ev.billing || ev.content || ev.products);
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  if (!API_KEY) return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: "SEXTAN_API_KEY non configurée." }) };
  const q = event.queryStringParameters || {};
  const id = q.id || "1550";

  // Diagnostic : quel corps ramène le menu/billing ?
  if (q.debug === "5") {
    const out = [];
    for (const b of searchBodies(id)) {
      try {
        const r = await post("/api/events/search", b, AUTH);
        const ev = r.json && r.json.data && r.json.data[0];
        out.push({ body: Object.keys(b).join("+"), status: r.status, keys: ev ? Object.keys(ev) : null, hasDetail: hasDetail(ev) });
      } catch (e) { out.push({ body: Object.keys(b).join("+"), error: e.message }); }
    }
    return { statusCode: 200, headers: cors(), body: JSON.stringify(out) };
  }

  const id2 = q.id || "";
  if (!id2) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "Paramètre id manquant" }) };

  try {
    // On tente les corps avec include jusqu'à obtenir le détail (menu/billing)
    let fallback = null;
    for (const auth of [AUTH, AUTH2]) {
      for (const b of searchBodies(id2)) {
        let r; try { r = await post("/api/events/search", b, auth); } catch (e) { continue; }
        const ev = r.json && r.json.data && r.json.data[0];
        if (ev && hasDetail(ev)) {
          return { statusCode: 200, headers: cors(), body: JSON.stringify({ data: [ev] }) };
        }
        if (ev && !fallback) fallback = ev; // au pire, le résumé
      }
    }
    if (fallback) return { statusCode: 200, headers: cors(), body: JSON.stringify({ data: [fallback] }) };
    return { statusCode: 502, headers: cors(), body: JSON.stringify({ error: "Réception introuvable ou non autorisée." }) };
  } catch (e) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: e.message }) };
  }
};
