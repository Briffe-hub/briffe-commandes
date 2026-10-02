// Netlify Function: /api/liens-files
// Stockage des fichiers téléchargeables du menu de liens (plaquettes PDF, etc.) dans Netlify Blobs.
// GET  ?id=xxx                              -> renvoie le fichier en téléchargement (public)
// POST { filename, contentType, dataBase64 } -> stocke le fichier (protégé par x-briffe-pass), renvoie { id, url, name }

const SITE_ID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
const TOKEN   = process.env.NETLIFY_TOKEN || process.env.NETLIFY_API_KEY;
const STORE   = "briffe-liens-files";

// Limite pratique : la réponse/requête synchrone d'une fonction Netlify plafonne ~6 Mo (base64 inclus).
const MAX_B64 = 5.5 * 1024 * 1024; // ~5,5 Mo de base64 ≈ ~4 Mo de fichier

function corsJSON() {
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

function checkPass(event) {
  const required = process.env.BRIFFE_AUTH_PASSWORD;
  if (!required) return true;
  const given = (event.headers["x-briffe-pass"] || event.headers["X-Briffe-Pass"] || "").trim();
  const allowed = required.split(",").map(s => s.trim()).filter(Boolean);
  return allowed.indexOf(given) >= 0;
}

function safeName(n) {
  return String(n || "fichier").replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120) || "fichier";
}
function uid() {
  try { return require("crypto").randomUUID().replace(/-/g, ""); }
  catch (e) { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsJSON(), body: "" };
  if (!SITE_ID || !TOKEN) return { statusCode: 500, headers: corsJSON(), body: JSON.stringify({ error: "Stockage non configuré (SITE_ID / NETLIFY_TOKEN)." }) };

  try {
    if (event.httpMethod === "GET") {
      const id = (event.queryStringParameters && event.queryStringParameters.id) || "";
      if (!id) return { statusCode: 400, headers: corsJSON(), body: JSON.stringify({ error: "id requis" }) };
      let rec = null;
      try { rec = await blobGet(id); } catch (e) { console.warn("blobGet:", e.message); }
      if (!rec || !rec.b) return { statusCode: 404, headers: corsJSON(), body: JSON.stringify({ error: "Fichier introuvable" }) };
      const dl = (event.queryStringParameters && event.queryStringParameters.dl) !== "0";
      const dispo = (dl ? "attachment" : "inline") + '; filename="' + safeName(rec.n) + '"';
      return {
        statusCode: 200,
        isBase64Encoded: true,
        headers: {
          "Content-Type": rec.t || "application/octet-stream",
          "Content-Disposition": dispo,
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=3600"
        },
        body: rec.b
      };
    }

    if (event.httpMethod === "POST") {
      if (!checkPass(event)) return { statusCode: 401, headers: corsJSON(), body: JSON.stringify({ error: "Mot de passe invalide." }) };
      const body = JSON.parse(event.body || "{}");
      const b64 = String(body.dataBase64 || "").replace(/^data:[^;]+;base64,/, "");
      if (!b64) return { statusCode: 400, headers: corsJSON(), body: JSON.stringify({ error: "dataBase64 requis" }) };
      if (b64.length > MAX_B64) return { statusCode: 413, headers: corsJSON(), body: JSON.stringify({ error: "Fichier trop lourd (max ~4 Mo via upload). Utilise un lien pour les fichiers plus gros." }) };
      const id = uid();
      await blobSet(id, { n: safeName(body.filename), t: String(body.contentType || "application/octet-stream"), b: b64, at: Date.now() });
      return { statusCode: 200, headers: corsJSON(), body: JSON.stringify({ id: id, url: "/api/liens-files?id=" + id, name: safeName(body.filename) }) };
    }

    return { statusCode: 405, headers: corsJSON(), body: "Method Not Allowed" };
  } catch (e) {
    console.error("liens-files error:", e);
    return { statusCode: 500, headers: corsJSON(), body: JSON.stringify({ error: e.message }) };
  }
};
