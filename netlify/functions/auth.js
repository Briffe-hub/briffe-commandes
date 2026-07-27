// Netlify Function: /api/auth
// Authentification par mot de passe pour la page "Signature & cachet".
// Le(s) mot(s) de passe vivent UNIQUEMENT dans la variable d'environnement
// Netlify BRIFFE_AUTH_PASSWORD (jamais dans le repo). Plusieurs mots de passe
// sont possibles en les séparant par des virgules : "motA,motB".
// POST { password } -> { ok:true, token, exp }  |  401 si incorrect.
// Le token est un HMAC-SHA256 signé avec le mot de passe, avec expiration.

const crypto = require("crypto");
const TTL_MS = 12 * 60 * 60 * 1000; // 12 h

function b64url(buf) {
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function sign(data, key) {
  return b64url(crypto.createHmac("sha256", key).update(data).digest());
}
function makeToken(key) {
  const exp = Date.now() + TTL_MS;
  const p = b64url(Buffer.from(JSON.stringify({ exp })));
  return { token: p + "." + sign(p, key), exp };
}
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ab, bb); } catch (e) { return false; }
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors(), body: "Method Not Allowed" };

  const key = process.env.BRIFFE_AUTH_PASSWORD;
  if (!key) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: "BRIFFE_AUTH_PASSWORD non défini" }) };
  }

  // Un ou plusieurs mots de passe acceptés, séparés par des virgules.
  const passwords = key.split(",").map(s => s.trim()).filter(Boolean);

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) {}

  const submitted = body.password || "";
  const ok = passwords.some(pw => safeEqual(submitted, pw));
  if (!ok) {
    // petit délai pour ralentir une attaque par force brute
    await new Promise(r => setTimeout(r, 400));
    return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: "mot de passe incorrect" }) };
  }

  // Le jeton est signé avec la valeur brute de la variable (clé stable,
  // identique côté /api/signatures) — pas avec le mot de passe individuel.
  const t = makeToken(key);
  return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true, token: t.token, exp: t.exp }) };
};

function cors() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}
