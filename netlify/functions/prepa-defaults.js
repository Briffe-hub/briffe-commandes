// Netlify Function: /api/prepa-defaults
// Défauts partagés par onglet + PARAMÈTRES globaux partagés de la tuile "Préparation prestation".
// GET                  → { defaults:{...}, params:{...} } (public)
// POST { type, tab }   → met à jour les défauts d'UN onglet (merge)        (protégé x-briffe-pass)
// POST { defaults }    → remplace tous les défauts                          (protégé)
// POST { params }      → remplace les paramètres globaux                    (protégé)

const SITE_ID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
const TOKEN   = process.env.NETLIFY_TOKEN || process.env.NETLIFY_API_KEY;
const STORE   = "briffe-prepa-defaults";
const KEY_DEF = "defaults";
const KEY_PAR = "params";

function cors() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, x-briffe-pass",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Cache-Control": "no-store"
  };
}
function blobUrl(key) { return `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${STORE}/${encodeURIComponent(key)}`; }

async function blobGet(key) {
  const r = await fetch(blobUrl(key), { headers: { "Authorization": "Bearer " + TOKEN } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("Blob GET " + r.status);
  return r.json();
}
async function blobSet(key, value) {
  const r = await fetch(blobUrl(key), {
    method: "PUT",
    headers: { "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(value)
  });
  if (!r.ok) throw new Error("Blob PUT " + r.status);
}

function sanitizeTab(t) {
  t = t || {};
  const obj = o => (o && typeof o === "object" && !Array.isArray(o)) ? o : {};
  return {
    hid:         obj(t.hid),
    elO:         obj(t.elO),
    qtyO:        obj(t.qtyO),
    choice:      obj(t.choice),
    choiceOther: obj(t.choiceOther),
    comment:     obj(t.comment),
    add:         Array.isArray(t.add) ? t.add.slice(0, 200) : []
  };
}

function checkPass(event) {
  const required = process.env.BRIFFE_AUTH_PASSWORD;
  if (!required) return true;
  const given = (event.headers["x-briffe-pass"] || event.headers["X-Briffe-Pass"] || "").trim();
  const allowed = required.split(",").map(s => s.trim()).filter(Boolean);
  return allowed.indexOf(given) >= 0;
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  if (!SITE_ID || !TOKEN) return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: "Stockage non configuré (SITE_ID / NETLIFY_TOKEN)." }) };

  try {
    if (event.httpMethod === "GET") {
      let d = null, p = null;
      try { d = await blobGet(KEY_DEF); } catch (e) { console.warn("blobGet defaults:", e.message); }
      try { p = await blobGet(KEY_PAR); } catch (e) { console.warn("blobGet params:", e.message); }
      return { statusCode: 200, headers: cors(), body: JSON.stringify({ defaults: d || {}, params: p || null }) };
    }

    if (event.httpMethod === "POST") {
      if (!checkPass(event)) return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: "Mot de passe invalide." }) };
      const body = JSON.parse(event.body || "{}");

      // Paramètres globaux : { params }
      if (body.params && typeof body.params === "object") {
        await blobSet(KEY_PAR, body.params);
        return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true, params: body.params }) };
      }

      // Défauts d'un seul onglet (merge) : { type, tab }
      if (body.type) {
        let cur = null;
        try { cur = await blobGet(KEY_DEF); } catch (e) { console.warn("blobGet:", e.message); }
        cur = (cur && typeof cur === "object") ? cur : {};
        cur[String(body.type)] = sanitizeTab(body.tab);
        await blobSet(KEY_DEF, cur);
        return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true, defaults: cur }) };
      }

      // Remplacement global des défauts : { defaults }
      const defs = body.defaults;
      if (!defs || typeof defs !== "object") return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "defaults, (type,tab) ou params requis" }) };
      const clean = {};
      for (const k in defs) clean[k] = sanitizeTab(defs[k]);
      await blobSet(KEY_DEF, clean);
      return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true, defaults: clean }) };
    }

    return { statusCode: 405, headers: cors(), body: "Method Not Allowed" };
  } catch (e) {
    console.error("prepa-defaults error:", e);
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: e.message }) };
  }
};
