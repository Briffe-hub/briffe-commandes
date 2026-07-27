// Netlify Function: /api/signatures
// Bibliothèque de signatures & cachets — stockage Netlify Blobs (API REST, sans dépendance npm)
// Même pattern que addresses.js
// GET  → { key: { name, type, dataUrl, savedAt }, ... }   (type = "signature" | "cachet")
// POST { action: "save",   id, name, type, dataUrl } → enregistre / met à jour
// POST { action: "delete", id }                       → supprime

const crypto  = require("crypto");
const SITE_ID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
const TOKEN   = process.env.NETLIFY_TOKEN || process.env.NETLIFY_API_KEY;
const STORE   = "briffe-signatures";

// ---- Authentification (mêmes tokens que /api/auth) ----
function b64url(buf) {
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function signHmac(data, key) {
  return b64url(crypto.createHmac("sha256", key).update(data).digest());
}
function verifyToken(token, key) {
  if (!token || token.indexOf(".") < 0) return false;
  const i = token.indexOf(".");
  const p = token.slice(0, i), sig = token.slice(i + 1);
  const expected = signHmac(p, key);
  if (sig.length !== expected.length) return false;
  try { if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false; }
  catch (e) { return false; }
  try {
    const payload = JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    return payload.exp > Date.now();
  } catch (e) { return false; }
}
function requireAuth(event) {
  const key = process.env.BRIFFE_AUTH_PASSWORD;
  if (!key) return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: "auth non configurée" }) };
  const h = event.headers || {};
  const auth = h.authorization || h.Authorization || "";
  const tok = auth.replace(/^Bearer\s+/i, "");
  if (!verifyToken(tok, key)) return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: "non autorisé" }) };
  return null;
}

function blobUrl(key) {
  return `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${STORE}/${encodeURIComponent(key)}`;
}

// id sûr pour une clé de blob
function normalizeId(id) {
  return (id || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .substring(0, 120);
}

async function blobGet(key) {
  const r = await fetch(blobUrl(key), {
    headers: { "Authorization": "Bearer " + TOKEN }
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("Blob GET failed: " + r.status);
  return r.json();
}

async function blobSet(key, value) {
  const r = await fetch(blobUrl(key), {
    method: "PUT",
    headers: {
      "Authorization": "Bearer " + TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(value)
  });
  if (!r.ok) throw new Error("Blob PUT failed: " + r.status);
}

async function blobDelete(key) {
  await fetch(blobUrl(key), {
    method: "DELETE",
    headers: { "Authorization": "Bearer " + TOKEN }
  });
}

async function blobList() {
  const r = await fetch(`https://api.netlify.com/api/v1/blobs/${SITE_ID}/${STORE}`, {
    headers: { "Authorization": "Bearer " + TOKEN }
  });
  if (!r.ok) return [];
  const data = await r.json();
  return data.blobs || [];
}

exports.handler = async function(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };

  const authErr = requireAuth(event);
  if (authErr) return authErr;

  try {
    if (event.httpMethod === "GET") {
      const blobs = await blobList();
      const result = {};
      for (const b of blobs) {
        try {
          const val = await blobGet(b.key);
          if (val) result[b.key] = val;
        } catch (e) { console.error("blobGet error:", b.key, e.message); }
      }
      return { statusCode: 200, headers: cors(), body: JSON.stringify(result) };
    }

    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body);

      if (body.action === "save") {
        if (!body.dataUrl || !/^data:image\/(png|jpe?g);base64,/.test(body.dataUrl)) {
          return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "dataUrl PNG/JPEG requis" }) };
        }
        const type = ["signature", "cachet", "accord"].includes(body.type) ? body.type : "signature";
        const id   = normalizeId(body.id || (type + "_" + Date.now()));
        await blobSet(id, {
          name:    (body.name || "Sans nom").substring(0, 80),
          type:    type,
          dataUrl: body.dataUrl,
          savedAt: new Date().toISOString()
        });
        return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true, id }) };
      }

      if (body.action === "delete") {
        const id = normalizeId(body.id);
        await blobDelete(id);
        return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true }) };
      }

      return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "action inconnue" }) };
    }

    return { statusCode: 405, headers: cors(), body: "Method Not Allowed" };
  } catch (e) {
    console.error("signatures error:", e);
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: e.message }) };
  }
};

function cors() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}
