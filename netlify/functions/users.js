// Netlify Function : /.netlify/functions/users  (alias /api/users)
// Gestion des comptes briffetools (utilisé d'abord par le module Prix fournisseurs).
// POST JSON :
//   { action:"login", login, password }        -> { ok, token, exp, user }            (public)
//   { action:"me" }                            -> { ok, user }                         (tout compte connecté)
//   { action:"change_password", current, password } -> { ok, token, exp }            (compte nominatif)
//   { action:"list" }                          -> { ok, users:[...] }                   (admin)
//   { action:"create", login, name, role, password }  -> { ok, user }                  (admin)
//   { action:"update", id, name?, role?, active? }    -> { ok, user }                  (admin)
//   { action:"reset_password", id, password }  -> { ok }   déconnecte toutes ses sessions (admin)
//   { action:"logout_all", id }                -> { ok }   déconnecte toutes ses sessions (admin)
//   { action:"delete", id }                    -> { ok }                                (admin)
// Authentification : en-tête x-briffe-token (jeton de session) ou x-briffe-pass (accès de secours = admin).
// Garde-fous : impossible de supprimer, désactiver ou rétrograder le dernier admin actif,
// ni de se supprimer / se rétrograder soi-même.

const crypto = require("crypto");
const U = require("../lib/briffe-users.js");

function headers() {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": U.AUTH_HEADERS,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store"
  };
}
const json = (code, obj) => ({ statusCode: code, headers: headers(), body: JSON.stringify(obj) });
const normLogin = s => String(s || "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9._-]+/g, "");
const now = () => new Date().toISOString();
const activeAdmins = store => store.users.filter(u => u.role === "admin" && u.active !== false);

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: headers(), body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Méthode non autorisée" });
  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch (e) {}
  const action = body.action;

  try {
    // ---------- connexion (public) ----------
    if (action === "login") {
      const login = normLogin(body.login);
      const store = await U.loadStore();
      const u = store.users.find(x => x.login === login);
      if (!u || u.active === false || !U.checkPassword(u, body.password || "")) {
        await new Promise(r => setTimeout(r, 500)); // ralentit la force brute
        return json(401, { error: "Identifiant ou mot de passe incorrect." });
      }
      u.last_login = now();
      await U.saveStore(store).catch(() => {}); // non bloquant
      const t = U.makeToken(u);
      return json(200, { ok: true, token: t.token, exp: t.exp, user: U.publicUser(u) });
    }

    // ---------- tout compte connecté ----------
    if (action === "me") {
      const deny = await U.guard(event, "lecteur", json); if (deny) return deny;
      return json(200, { ok: true, user: event.briffeUser });
    }
    if (action === "change_password") {
      const deny = await U.guard(event, "lecteur", json); if (deny) return deny;
      const me = event.briffeUser;
      if (me.master) return json(400, { error: "L'accès de secours n'a pas de mot de passe propre : il se change dans la variable BRIFFE_AUTH_PASSWORD sur Netlify." });
      const store = await U.loadStore();
      const u = store.users.find(x => x.id === me.id);
      if (!u || !U.checkPassword(u, body.current || "")) return json(400, { error: "Mot de passe actuel incorrect." });
      const pb = U.passwordProblem(body.password); if (pb) return json(400, { error: pb });
      Object.assign(u, U.hashPassword(body.password), { ver: (u.ver || 1) + 1, updated: now() });
      await U.saveStore(store);
      const t = U.makeToken(u); // les autres sessions sont déconnectées, celle-ci continue
      return json(200, { ok: true, token: t.token, exp: t.exp });
    }

    // ---------- administration ----------
    const deny = await U.guard(event, "admin", json); if (deny) return deny;
    const me = event.briffeUser;
    const store = await U.loadStore();
    const find = id => store.users.find(x => x.id === id);

    if (action === "list") {
      return json(200, { ok: true, users: store.users.map(U.publicUser), roles: U.ROLES, me });
    }

    if (action === "create") {
      const login = normLogin(body.login);
      if (!login || login.length < 2) return json(400, { error: "Identifiant invalide (lettres, chiffres, point, tiret ; 2 caractères minimum)." });
      if (login === "secours") return json(400, { error: "Identifiant réservé." });
      if (store.users.some(x => x.login === login)) return json(400, { error: "L'identifiant « " + login + " » existe déjà." });
      const role = U.ROLES.includes(body.role) ? body.role : "lecteur";
      const pb = U.passwordProblem(body.password); if (pb) return json(400, { error: pb });
      const u = Object.assign({
        id: crypto.randomBytes(8).toString("hex"),
        login, name: String(body.name || "").trim().slice(0, 80) || login,
        role, active: true, ver: 1, created: now(), updated: now(), created_by: me.login
      }, U.hashPassword(body.password));
      store.users.push(u);
      await U.saveStore(store);
      return json(200, { ok: true, user: U.publicUser(u) });
    }

    if (action === "update") {
      const u = find(body.id); if (!u) return json(404, { error: "Compte introuvable." });
      const self = u.id === me.id;
      if (body.name !== undefined) u.name = String(body.name || "").trim().slice(0, 80) || u.login;
      if (body.role !== undefined) {
        if (!U.ROLES.includes(body.role)) return json(400, { error: "Rôle inconnu." });
        if (u.role === "admin" && body.role !== "admin") {
          if (self) return json(400, { error: "Tu ne peux pas retirer ton propre rôle admin." });
          if (activeAdmins(store).length <= 1 && u.active !== false) return json(400, { error: "Il doit rester au moins un admin actif." });
        }
        u.role = body.role;
      }
      if (body.active !== undefined) {
        const act = !!body.active;
        if (!act && self) return json(400, { error: "Tu ne peux pas désactiver ton propre compte." });
        if (!act && u.role === "admin" && activeAdmins(store).length <= 1 && u.active !== false) return json(400, { error: "Il doit rester au moins un admin actif." });
        if (!act) u.ver = (u.ver || 1) + 1; // coupe les sessions ouvertes
        u.active = act;
      }
      u.updated = now();
      await U.saveStore(store);
      return json(200, { ok: true, user: U.publicUser(u) });
    }

    if (action === "reset_password") {
      const u = find(body.id); if (!u) return json(404, { error: "Compte introuvable." });
      const pb = U.passwordProblem(body.password); if (pb) return json(400, { error: pb });
      Object.assign(u, U.hashPassword(body.password), { ver: (u.ver || 1) + 1, updated: now() });
      await U.saveStore(store);
      return json(200, { ok: true });
    }

    if (action === "logout_all") {
      const u = find(body.id); if (!u) return json(404, { error: "Compte introuvable." });
      u.ver = (u.ver || 1) + 1; u.updated = now();
      await U.saveStore(store);
      return json(200, { ok: true });
    }

    if (action === "delete") {
      const u = find(body.id); if (!u) return json(404, { error: "Compte introuvable." });
      if (u.id === me.id) return json(400, { error: "Tu ne peux pas supprimer ton propre compte." });
      if (u.role === "admin" && u.active !== false && activeAdmins(store).length <= 1) return json(400, { error: "Il doit rester au moins un admin actif." });
      store.users = store.users.filter(x => x.id !== u.id);
      await U.saveStore(store);
      return json(200, { ok: true });
    }

    return json(400, { error: "Action inconnue." });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
