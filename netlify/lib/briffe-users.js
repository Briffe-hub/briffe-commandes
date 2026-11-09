// Bibliothèque partagée : comptes utilisateurs briffetools (réutilisable par toutes les tuiles).
// Stockage : Netlify Blobs, store « briffe-users », clé « users » (via l'API REST, SITE_ID + NETLIFY_TOKEN).
// Mots de passe : jamais stockés en clair, hachés scrypt + sel aléatoire par compte.
// Jetons de session : HMAC-SHA256, valables 12 h, signés avec BRIFFE_USERS_SECRET (sinon dérivé de
// BRIFFE_AUTH_PASSWORD). Le rôle n'est PAS lu dans le jeton mais dans le compte à chaque requête :
// un changement de rôle, une désactivation ou une suppression prend effet immédiatement.
// Accès de secours : l'en-tête x-briffe-pass = BRIFFE_AUTH_PASSWORD donne les droits admin.
//
// Rôles (du plus faible au plus fort) : lecteur < editeur < admin.

const crypto = require("crypto");

const SITE_ID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
const NTOKEN = process.env.NETLIFY_TOKEN || process.env.NETLIFY_API_KEY;
const STORE = "briffe-users";
const KEY = "users";
const TTL_MS = 12 * 60 * 60 * 1000;
const ROLES = ["lecteur", "editeur", "admin"];
const ROLE_LABEL = { aucun: "Aucun accès", lecteur: "Lecture", editeur: "Édition", admin: "Admin" };
// Briques de briffetools : chaque compte a un niveau par brique (aucun / lecteur / editeur / admin).
// Un administrateur général (is_admin) a tous les droits partout et gère les comptes.
const BRIQUES = [
  { id: "commandes", label: "Commandes appels d'offre" },
  { id: "pdf",       label: "Signature & cachet" },
  { id: "prepa",     label: "Préparation prestation" },
  { id: "liens",     label: "Menu de liens (QR)" },
  { id: "cartels",   label: "Cartels allergènes" },
  { id: "prix",      label: "Prix fournisseurs" }
];
const BRIQUE_IDS = BRIQUES.map(b => b.id);
// Comptes créés avant les droits par brique : leur rôle valait pour Prix et Préparation.
function normUser(u) {
  if (!u) return u;
  if (u.is_admin === undefined) u.is_admin = u.role === "admin";
  if (!u.perms) { u.perms = {}; if (!u.is_admin && ROLES.includes(u.role)) { u.perms.prix = u.role; u.perms.prepa = u.role; } }
  return u;
}
function cleanPerms(p) {
  const out = {};
  BRIQUE_IDS.forEach(b => { const v = p && p[b]; if (ROLES.includes(v)) out[b] = v; });
  return out;
}
const MIN_PASSWORD = 8;

// ---------- Blobs ----------
const blobUrl = () => `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${STORE}/${KEY}`;
async function loadStore() {
  if (!SITE_ID || !NTOKEN) throw new Error("SITE_ID / NETLIFY_TOKEN non configurés.");
  const r = await fetch(blobUrl(), { headers: { Authorization: "Bearer " + NTOKEN } });
  if (r.status === 404) return { v: 1, users: [] };
  if (!r.ok) throw new Error("Lecture des comptes impossible (" + r.status + ").");
  const j = await r.json();
  return j && Array.isArray(j.users) ? j : { v: 1, users: [] };
}
async function saveStore(store) {
  const r = await fetch(blobUrl(), {
    method: "PUT",
    headers: { Authorization: "Bearer " + NTOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(store)
  });
  if (!r.ok) throw new Error("Enregistrement des comptes impossible (" + r.status + ").");
}

// ---------- mots de passe ----------
function hashPassword(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
  return { salt, hash };
}
function checkPassword(user, pw) {
  if (!user || !user.salt || !user.hash) return false;
  const h = hashPassword(pw, user.salt).hash;
  return safeEqual(h, user.hash);
}
function safeEqual(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ab, bb); } catch (e) { return false; }
}
function passwordProblem(pw) {
  pw = String(pw || "");
  if (pw.length < MIN_PASSWORD) return "Le mot de passe doit faire au moins " + MIN_PASSWORD + " caractères.";
  return null;
}

// ---------- jetons ----------
function secret() {
  const s = process.env.BRIFFE_USERS_SECRET || process.env.BRIFFE_AUTH_PASSWORD || "";
  if (!s) throw new Error("BRIFFE_AUTH_PASSWORD non défini.");
  return crypto.createHash("sha256").update("briffe-users|" + s).digest();
}
const b64url = buf => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sign = data => b64url(crypto.createHmac("sha256", secret()).update(data).digest());
function makeToken(user) {
  const exp = Date.now() + TTL_MS;
  const p = b64url(Buffer.from(JSON.stringify({ u: user.id, s: user.ver || 1, exp })));
  return { token: p + "." + sign(p), exp };
}
function readToken(tok) {
  const parts = String(tok || "").split(".");
  if (parts.length !== 2 || !safeEqual(sign(parts[0]), parts[1])) return null;
  try {
    const d = JSON.parse(Buffer.from(parts[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return d && d.exp > Date.now() ? d : null;
  } catch (e) { return null; }
}

// ---------- accès ----------
function header(event, name) {
  const h = event.headers || {};
  const k = Object.keys(h).find(x => x.toLowerCase() === name);
  return k ? String(h[k] || "").trim() : "";
}
function masterOk(event) {
  const given = header(event, "x-briffe-pass");
  if (!given) return false;
  const allowed = String(process.env.BRIFFE_AUTH_PASSWORD || "").split(",").map(s => s.trim()).filter(Boolean);
  return allowed.some(pw => safeEqual(given, pw));
}
const MASTER = { id: "secours", login: "secours", name: "Accès de secours", role: "admin", is_admin: true, perms: {}, master: true };
function publicUser(u) {
  normUser(u);
  return { id: u.id, login: u.login, name: u.name || u.login, role: u.is_admin ? "admin" : (u.role || "lecteur"), is_admin: !!u.is_admin, perms: Object.assign({}, u.perms),
    master: !!u.master, active: u.active !== false, created: u.created || null, updated: u.updated || null, last_login: u.last_login || null };
}
// Niveau effectif d'un compte sur une brique ("aucun" si pas d'accès)
function levelFor(user, brique) {
  if (!user) return "aucun";
  if (user.is_admin) return "admin";
  if (!brique) return "lecteur"; // actions sans brique (session, mot de passe) : tout compte connecté
  return (user.perms && user.perms[brique]) || "aucun";
}
const rank = role => ROLES.indexOf(role);

// Vérifie l'accès. Renvoie { user } ou { status, error }.
// minRole : "lecteur" | "editeur" | "admin" ; brique : id de la brique (droits par brique), sinon droits généraux.
async function authenticate(event, minRole, brique) {
  let user = null;
  if (masterOk(event)) user = MASTER;
  else {
    const tok = header(event, "x-briffe-token");
    const d = tok ? readToken(tok) : null;
    if (!d) return { status: 401, error: tok ? "Session expirée, reconnecte-toi." : "Connexion requise." };
    const store = await loadStore();
    const u = store.users.find(x => x.id === d.u);
    if (!u || u.active === false || (u.ver || 1) !== d.s) return { status: 401, error: "Session expirée, reconnecte-toi." };
    user = publicUser(u);
  }
  const lvl = levelFor(user, brique);
  user.level = lvl; user.brique = brique || null;
  if (rank(lvl) < rank(minRole || "lecteur")) {
    const b = BRIQUES.find(x => x.id === brique);
    if (lvl === "aucun") return { status: 403, error: b ? "Pas d'accès à la brique « " + b.label + " » : demande-le à un administrateur." : "Action réservée à un administrateur." };
    return { status: 403, error: "Droits insuffisants : action réservée au niveau « " + ROLE_LABEL[minRole] + " »" + (b ? " sur « " + b.label + " »" : "") + "." };
  }
  return { user };
}

// Adaptateur pour les fonctions Netlify : renvoie null si autorisé (et pose event.briffeUser), sinon la réponse d'erreur.
async function guard(event, minRole, json, brique) {
  try {
    const a = await authenticate(event, minRole, brique);
    if (a.error) return json(a.status, { error: a.error, auth: a.status === 401 ? "login" : "forbidden" });
    event.briffeUser = a.user;
    return null;
  } catch (e) {
    return json(500, { error: e.message });
  }
}

// Rôle requis selon l'action demandée dans le corps JSON : roleFor(event, { lire:"lecteur" }, "editeur").
function roleFor(event, byAction, fallback) {
  let a = "";
  try { a = String((JSON.parse(event.body || "{}") || {}).action || ""); } catch (e) {}
  return (byAction && byAction[a]) || fallback || "admin";
}

const AUTH_HEADERS = "Content-Type, x-briffe-pass, x-briffe-token";

module.exports = {
  ROLES, ROLE_LABEL, BRIQUES, BRIQUE_IDS, MIN_PASSWORD, AUTH_HEADERS, MASTER, normUser, cleanPerms, levelFor,
  loadStore, saveStore, hashPassword, checkPassword, passwordProblem,
  makeToken, readToken, authenticate, guard, roleFor, publicUser, rank
};
