/* briffetools — connexion et droits par brique, commun à toutes les pages.
   Usage : <script src="briffe-auth.js" data-brique="cartels"></script>   (data-brique absent = menu)
   - sans session valide : écran de connexion par-dessus la page ;
   - connecté sans accès à la brique : écran « accès refusé » avec retour au menu ;
   - sinon la page s'utilise normalement ; BriffeAuth.me = { login, name, is_admin, perms, level } ;
   - un bandeau discret (nom + déconnexion) est ajouté en bas à droite.
   Session partagée entre toutes les briques (localStorage, même clé que le module prix). */
(function () {
  var cur = document.currentScript;
  var BRIQUE = (cur && cur.getAttribute('data-brique')) || '';
  var MENU = cur && cur.hasAttribute('data-menu');
  var LABELS = { commandes: "Commandes appels d'offre", pdf: 'Signature & cachet', prepa: 'Préparation prestation', liens: 'Menu de liens (QR)', cartels: 'Cartels allergènes', prix: 'Prix fournisseurs' };
  var RANK = ['aucun', 'lecteur', 'editeur', 'admin'];
  var A = window.BriffeAuth = {
    brique: BRIQUE, me: null, level: 'aucun', ready: null,
    token: function () { try { var t = localStorage.getItem('bt_prix_token'), e = +localStorage.getItem('bt_prix_exp') || 0; return t && e > Date.now() ? t : ''; } catch (e) { return ''; } },
    headers: function (h) { h = h || {}; var t = A.token(); if (t) h['x-briffe-token'] = t; else { try { var p = sessionStorage.getItem('bt_prix_secours'); if (p) h['x-briffe-pass'] = p; } catch (e) {} } return h; },
    levelFor: function (b) { var m = A.me; if (!m) return 'aucun'; if (m.is_admin) return 'admin'; return (m.perms && m.perms[b]) || 'aucun'; },
    can: function (b, min) { return RANK.indexOf(A.levelFor(b)) >= RANK.indexOf(min || 'lecteur'); },
    logout: function () { try { localStorage.removeItem('bt_prix_token'); localStorage.removeItem('bt_prix_exp'); sessionStorage.removeItem('bt_prix_secours'); } catch (e) {} location.reload(); }
  };
  var css = '#ba-ov{position:fixed;inset:0;z-index:9999;background:rgba(10,10,10,.96);display:flex;align-items:center;justify-content:center;padding:16px;font-family:"DM Mono",ui-monospace,Menlo,monospace}' +
    '#ba-box{width:min(400px,100%);background:#141414;border:1px solid #2a2a2a;border-radius:10px;padding:24px;color:#e8e8e0}' +
    '#ba-box h1{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#9a9a92;font-weight:500;margin:0 0 6px}' +
    '#ba-box .br{font-size:18px;margin:0 0 16px}#ba-box .br b{color:#e8e8e0}#ba-box .br i{color:#b3242e;font-style:normal}' +
    '#ba-box input{width:100%;box-sizing:border-box;background:#0a0a0a;color:#e8e8e0;border:1px solid #2a2a2a;border-radius:4px;padding:10px 12px;font:inherit;font-size:13px;margin-bottom:10px}' +
    '#ba-box input:focus{outline:none;border-color:#f59e0b}' +
    '#ba-box button{width:100%;background:#b3242e;border:1px solid #b3242e;color:#fff;border-radius:4px;padding:10px;font:inherit;font-size:12px;letter-spacing:.1em;text-transform:uppercase;cursor:pointer}' +
    '#ba-box .err{color:#f87171;font-size:12px;min-height:1em;margin-top:8px;line-height:1.5}#ba-box p{font-size:12px;color:#b0b0a8;line-height:1.6}' +
    '#ba-box a{color:#e8e8e0}' +
    '#ba-chip{position:fixed;right:10px;bottom:10px;z-index:9000;font:11px "DM Mono",ui-monospace,Menlo,monospace;color:#9a9a92;background:rgba(20,20,20,.92);border:1px solid #2a2a2a;border-radius:4px;padding:5px 9px}' +
    '#ba-chip a{color:#e8e8e0;cursor:pointer;text-decoration:underline}@media print{#ba-chip,#ba-ov{display:none!important}}';
  function el(html) { var d = document.createElement('div'); d.innerHTML = html; return d.firstChild; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function mount() {
    if (!document.getElementById('ba-css')) { var st = document.createElement('style'); st.id = 'ba-css'; st.textContent = css; document.head.appendChild(st); }
    var ov = document.getElementById('ba-ov'); if (ov) ov.remove();
    ov = el('<div id="ba-ov"><div id="ba-box"></div></div>'); document.body.appendChild(ov); return ov.firstChild;
  }
  function unmount() { var ov = document.getElementById('ba-ov'); if (ov) ov.remove(); }
  function showLogin(msg) {
    var box = mount();
    box.innerHTML = '<h1>Connexion</h1><div class="br"><b>briffe</b><i>tools</i>' + (BRIQUE ? ' · ' + esc(LABELS[BRIQUE] || BRIQUE) : '') + '</div>' +
      '<input id="ba-l" placeholder="Identifiant" autocapitalize="none" autocomplete="username"><input id="ba-p" type="password" placeholder="Mot de passe" autocomplete="current-password">' +
      '<button id="ba-go">Se connecter</button><div class="err" id="ba-err">' + esc(msg || '') + '</div>';
    var go = function () {
      var btn = document.getElementById('ba-go'); btn.disabled = true;
      fetch('/.netlify/functions/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'login', login: document.getElementById('ba-l').value, password: document.getElementById('ba-p').value }) })
        .then(function (r) { return r.json(); }).then(function (j) {
          btn.disabled = false;
          if (!j.ok) { document.getElementById('ba-err').textContent = j.error || 'Connexion impossible.'; return; }
          try { localStorage.setItem('bt_prix_token', j.token); localStorage.setItem('bt_prix_exp', String(j.exp)); sessionStorage.removeItem('bt_prix_secours'); } catch (e) {}
          check();
        }).catch(function (e) { btn.disabled = false; document.getElementById('ba-err').textContent = e.message; });
    };
    document.getElementById('ba-go').onclick = go;
    document.getElementById('ba-p').onkeydown = function (e) { if (e.key === 'Enter') go(); };
    setTimeout(function () { var l = document.getElementById('ba-l'); if (l) l.focus(); }, 30);
  }
  function showDenied() {
    var box = mount();
    box.innerHTML = '<h1>Accès refusé</h1><div class="br">' + esc(LABELS[BRIQUE] || BRIQUE) + '</div>' +
      '<p>Le compte <b>' + esc(A.me.name || A.me.login) + '</b> n\'a pas accès à cette brique. Demande l\'accès à un administrateur.</p>' +
      '<p><a href="index.html">Retour au menu</a> · <a href="#" id="ba-out">changer de compte</a></p>';
    document.getElementById('ba-out').onclick = function (e) { e.preventDefault(); A.logout(); };
  }
  function chip() {
    var c = document.getElementById('ba-chip'); if (c) c.remove();
    c = el('<div id="ba-chip">' + esc(A.me.name || A.me.login) + (BRIQUE ? ' · ' + esc({ lecteur: 'lecture', editeur: 'édition', admin: 'admin' }[A.level] || '') : (A.me.is_admin ? ' · administrateur' : '')) + ' · <a id="ba-x">déconnexion</a></div>');
    document.body.appendChild(c); document.getElementById('ba-x').onclick = A.logout;
  }
  var resolveReady; A.ready = new Promise(function (r) { resolveReady = r; });
  function check() {
    if (!A.token() && !(function () { try { return sessionStorage.getItem('bt_prix_secours'); } catch (e) { return ''; } })()) { showLogin(''); return; }
    fetch('/.netlify/functions/users', { method: 'POST', headers: A.headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ action: 'me' }) })
      .then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
      .then(function (x) {
        if (!x.j.ok) { showLogin(x.s === 401 ? '' : (x.j.error || '')); return; }
        A.me = x.j.user; A.level = BRIQUE ? A.levelFor(BRIQUE) : (A.me.is_admin ? 'admin' : 'lecteur');
        if (BRIQUE && A.level === 'aucun') { showDenied(); return; }
        unmount(); chip(); resolveReady(A.me);
        try { document.dispatchEvent(new CustomEvent('briffe-auth', { detail: A.me })); } catch (e) {}
      }).catch(function (e) { showLogin('Serveur injoignable : ' + e.message); });
  }
  A.check = check;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check); else check();
})();
