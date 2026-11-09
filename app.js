(() => {
'use strict';

/* =========================================================
   Utilitaires
   ========================================================= */
const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmt = (ms) => { ms = Math.max(0, ms | 0); const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const CFG = window.IPOD_CONFIG || {};
// Préfixe de stockage : chaque copie de l'app garde ses propres réglages et sa connexion.
const PFX = (CFG.storageKey || 'ipod') + '.';
const LS = {
  get(k, d) { try { const v = localStorage.getItem(PFX + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(PFX + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(PFX + k); } catch {} },
};
const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');

/* =========================================================
   Authentification Spotify (PKCE, sans secret)
   ========================================================= */
const SCOPES = [
  'user-read-playback-state', 'user-modify-playback-state', 'user-read-currently-playing',
  'playlist-read-private', 'playlist-read-collaborative',
  'user-library-read', 'user-library-modify', 'user-follow-read',
  'user-read-recently-played', 'user-read-private',
].join(' ');
class AuthError extends Error { constructor() { super('Non connecté'); this.auth = true; } }

const redirectUri = () => location.origin + location.pathname;
const clientId = () => ((window.IPOD_CONFIG && window.IPOD_CONFIG.clientId) || LS.get('clientId', '')).trim();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const loggedIn = () => DEMO || !!LS.get('token', null);

async function login() {
  if (!clientId()) return openSetup();
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  LS.set('pkce', { verifier, state });
  const q = new URLSearchParams({
    client_id: clientId(), response_type: 'code', redirect_uri: redirectUri(),
    code_challenge_method: 'S256', code_challenge: challenge, scope: SCOPES, state,
  });
  location.href = 'https://accounts.spotify.com/authorize?' + q;
}

async function handleCallback() {
  const code = params.get('code'), err = params.get('error');
  if (!code && !err) return;
  history.replaceState(null, '', redirectUri());
  if (err) throw new Error('connexion refusée');
  const p = LS.get('pkce', null); LS.del('pkce');
  if (!p || p.state !== params.get('state')) throw new Error('session expirée, réessaie');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId(), grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: p.verifier }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || 'jeton refusé');
  saveToken(j);
}
function saveToken(j) {
  const t = LS.get('token', {}) || {};
  t.access = j.access_token;
  if (j.refresh_token) t.refresh = j.refresh_token;
  t.exp = Date.now() + ((j.expires_in || 3600) - 60) * 1000;
  LS.set('token', t);
}
let refreshing = null;
function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const t = LS.get('token', null);
    if (!t || !t.refresh) { LS.del('token'); throw new AuthError(); }
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: clientId() }),
    });
    if (!r.ok) { if (r.status === 400 || r.status === 401) LS.del('token'); throw new AuthError(); }
    saveToken(await r.json());
  })().finally(() => { refreshing = null; });
  return refreshing;
}
async function accessToken() {
  const t = LS.get('token', null);
  if (!t) throw new AuthError();
  if (Date.now() > t.exp) await refresh();
  return LS.get('token', {}).access;
}
function logout() { LS.del('token'); LS.del('me'); P.state = null; me = null; resetRoot(); toast('Déconnecté'); }

/* =========================================================
   Appels API
   ========================================================= */
async function api(path, opts = {}, retry = true) {
  const { method = 'GET', body, query } = opts;
  if (DEMO) return mock(path, method, body, query || {});
  let url = path.startsWith('http') ? path : 'https://api.spotify.com/v1' + path;
  if (query) url += (url.includes('?') ? '&' : '?') + new URLSearchParams(query);
  const tok = await accessToken();
  const headers = { Authorization: 'Bearer ' + tok };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (r.status === 401 && retry) { await refresh(); return api(path, opts, false); }
  if (r.status === 429 && retry) { await sleep(Math.min(+r.headers.get('Retry-After') || 1, 5) * 1000); return api(path, opts, false); }
  if (r.status === 204 || r.status === 202) return null;
  const txt = await r.text();
  let j = null; try { j = txt ? JSON.parse(txt) : null; } catch {}
  if (!r.ok) {
    const e = new Error((j && j.error && j.error.message) || ('Erreur ' + r.status));
    e.status = r.status; e.reason = j && j.error && j.error.reason;
    throw e;
  }
  return j;
}
// Certaines routes limitent "limit" : on retente à 10 si Spotify refuse.
const limitCap = {};
async function getPage(path, query) {
  const key = path.replace(/\/[A-Za-z0-9]{22}/g, '/:id');
  const q = { ...query };
  if (limitCap[key] && q.limit > limitCap[key]) q.limit = limitCap[key];
  try { return await api(path, { query: q }); }
  catch (e) {
    if (e.status === 400 && q.limit > 10) { limitCap[key] = 10; return getPage(path, query); }
    throw e;
  }
}
function errText(e) {
  if (!e) return 'Erreur';
  if (e.auth) return 'Reconnecte-toi à Spotify';
  if (e.reason === 'PREMIUM_REQUIRED') return 'Spotify Premium requis';
  if (e.reason === 'NO_ACTIVE_DEVICE' || e.status === 404) return 'Aucun appareil actif';
  if (e.reason === 'VOLUME_CONTROL_DISALLOW') return 'Volume réglable sur l’appareil';
  if (e.status === 403) return 'Action refusée par Spotify';
  if (e instanceof TypeError) return 'Pas de connexion internet';
  return e.message || 'Erreur';
}
function showErr(e) {
  toast(errText(e));
  if (e && e.auth) resetRoot();
}

/* =========================================================
   Son du clic + vibration
   ========================================================= */
let actx = null;
function tick() {
  if (LS.get('vibrate', true) && navigator.vibrate) { try { navigator.vibrate(4); } catch {} }
  if (!LS.get('sound', true)) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    const t = actx.currentTime;
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'square'; o.frequency.setValueAtTime(2200, t);
    g.gain.setValueAtTime(0.05, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
    o.connect(g).connect(actx.destination); o.start(t); o.stop(t + 0.02);
  } catch {}
}

/* =========================================================
   Toast
   ========================================================= */
let toastT = 0;
function toast(msg, ms = 2000) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), ms);
}

/* =========================================================
   Pile d'écrans
   ========================================================= */
const stack = [];
const cur = () => stack[stack.length - 1];
function push(s) {
  if (s.kind === 'list') { s.items = s.items || []; s.sel = s.sel ?? firstSelectable(s); s.top = 0; s.count = 0; }
  stack.push(s);
  if (s.load) ensureLoaded(s);
  render();
}
function pop() {
  if (stack.length <= 1) return;
  stack.pop();
  const s = cur();
  if (s.refresh) { s.items = s.baseItems ? [...s.baseItems] : []; s.loaded = false; s.count = 0; if (s.load) ensureLoaded(s); }
  render();
}
function resetRoot() { stack.length = 0; push(rootMenu()); }

function list(title, items, load, extra = {}) {
  return { kind: 'list', title, items: [...items], baseItems: [...items], load, ...extra };
}
const isSel = (it) => it && !it.head;
function firstSelectable(s) { const i = (s.items || []).findIndex(isSel); return i < 0 ? 0 : i; }

async function ensureLoaded(s, more = false) {
  if (!s.load || s.loading) return;
  if (!more && s.loaded) return;
  s.loading = true; s.error = null;
  if (cur() === s) render();
  try {
    const r = await s.load(s.count, s);
    const wasEmpty = !s.items.some(isSel);
    s.items.push(...r.items);
    s.count += r.used ?? r.items.length;
    s.more = !!r.more && (r.used ?? r.items.length) > 0;
    s.loaded = true;
    if (wasEmpty) s.sel = firstSelectable(s);
  } catch (e) {
    s.error = e; s.loaded = true; s.more = false;
    if (e.auth) { s.loading = false; return showErr(e); }
  }
  s.loading = false;
  if (cur() === s) render();
}

/* =========================================================
   Rendu
   ========================================================= */
const body = () => $('#screenBody');
let rowPx = 0;
function render() {
  const s = cur(); if (!s) return;
  $('#hdrTitle').textContent = s.title || 'iPod';
  updateHeaderPlay();
  if (s.kind === 'list') renderList(s);
  else if (s.kind === 'now') renderNow(true);
  else if (s.kind === 'search') renderSearch(s);
  else if (s.kind === 'msg') renderMsg(s);
}
function updateHeaderPlay() {
  const st = P.state;
  $('#hdrPlay').textContent = st && st.item ? (st.is_playing ? '▶' : '❚❚') : '';
}
const val = (v) => (typeof v === 'function' ? v() : v);

function rowsVisible() {
  const b = body();
  if (!rowPx) rowPx = $('#ipod').clientWidth * 0.074 || 28;
  return Math.max(1, Math.floor((b.clientHeight + 1) / rowPx));
}
function renderList(s, target = body()) {
  target.dataset.kind = 'list';
  const items = s.items;
  if (!items.length) {
    if (s.loading || !s.loaded && s.load) target.innerHTML = '<div class="msg"><div><div class="spinner"></div>Chargement…</div></div>';
    else if (s.error) target.innerHTML = `<div class="msg"><div><b>Oups</b>${esc(errText(s.error))}</div></div>`;
    else target.innerHTML = `<div class="msg"><div>${esc(s.empty || 'Rien ici')}</div></div>`;
    return;
  }
  const rows = rowsVisible();
  s.sel = clamp(s.sel, 0, items.length - 1);
  if (s.sel < s.top) s.top = s.sel;
  if (s.sel >= s.top + rows) s.top = s.sel - rows + 1;
  s.top = clamp(s.top, 0, Math.max(0, items.length - rows + (s.loading ? 1 : 0)));
  const sb = items.length > rows;
  let html = `<ul class="list${sb ? ' has-sb' : ''}">`;
  for (let i = s.top; i < Math.min(items.length, s.top + rows); i++) {
    const it = items[i];
    if (it.head) { html += `<li class="head"><span class="lbl">${esc(val(it.label))}</span></li>`; continue; }
    const sub = val(it.sub);
    html += `<li class="${i === s.sel ? 'sel' : ''}">` +
      (it.check !== undefined ? `<span class="chk">${val(it.check) ? '✓' : ''}</span>` : '') +
      `<span class="lbl"><span>${esc(val(it.label))}</span></span>` +
      (sub ? `<span class="sub">${esc(sub)}</span>` : '') +
      (it.chev ? '<span class="chev">›</span>' : '') + '</li>';
  }
  if (s.loading && s.top + rows > items.length) html += '<li><span class="lbl">Chargement…</span></li>';
  html += '</ul>';
  if (sb) {
    const total = items.length + (s.more ? 5 : 0);
    html += `<div class="scrollbar"><i style="top:${(s.top / total) * 100}%;height:${Math.max(8, (rows / total) * 100)}%"></i></div>`;
  }
  target.innerHTML = html;
  const li = target.querySelector('li:not(.head)');
  if (li && li.offsetHeight) rowPx = li.offsetHeight;
  if (sb) target.querySelectorAll('.list li').forEach((l) => (l.style.paddingRight = '4cqw'));
  const sel = target.querySelector('li.sel .lbl');
  if (sel) {
    const span = sel.firstElementChild, diff = span.scrollWidth - sel.clientWidth;
    if (diff > 2) { sel.parentElement.classList.add('marquee'); span.style.setProperty('--shift', `-${diff + 6}px`); }
  }
  if (s.more && !s.loading && s.sel >= items.length - rows) ensureLoaded(s, true);
}

function renderMsg(s) {
  const b = body(); b.dataset.kind = 'msg';
  b.innerHTML = `<div class="msg"><div>${s.html}</div></div>`;
}

/* ---------- En cours ---------- */
function renderNow(full) {
  const b = body();
  const st = P.state, it = st && st.item;
  if (!it) {
    b.dataset.kind = 'now-empty';
    b.innerHTML = '<div class="msg"><div><b>Rien en lecture</b>Appuie au centre pour choisir un appareil.</div></div>';
    return;
  }
  if (full || b.dataset.kind !== 'now') {
    b.dataset.kind = 'now';
    b.innerHTML = `<div class="now">
      <div class="now-top"><div class="now-art" id="nArt"></div>
        <div class="now-meta"><div class="t" id="nT"></div><div class="a" id="nA"></div><div class="al" id="nAl"></div><div class="dev" id="nDev"></div></div></div>
      <div class="now-flags" id="nFlags"></div>
      <div id="nBottom"></div></div>`;
  }
  const img = (it.album && it.album.images && it.album.images[0]) || (it.images && it.images[0]);
  const art = $('#nArt'); const url = img ? img.url : '';
  if (art.dataset.url !== url) { art.dataset.url = url; art.style.backgroundImage = url ? `url("${url}")` : ''; }
  $('#nT').textContent = it.name;
  $('#nA').textContent = it.artists ? it.artists.map((a) => a.name).join(', ') : (it.show ? it.show.name : '');
  $('#nAl').textContent = it.album ? it.album.name : '';
  $('#nDev').textContent = st.device ? '♪ ' + st.device.name : '';
  const flags = [];
  if (st.shuffle_state) flags.push('Aléatoire');
  if (st.repeat_state === 'context') flags.push('Répéter tout');
  if (st.repeat_state === 'track') flags.push('Répéter le titre');
  $('#nFlags').textContent = flags.join(' · ');
  renderNowBottom();
}
function renderNowBottom() {
  const st = P.state; if (!st || !st.item) return;
  const el = $('#nBottom'); if (!el) return;
  if (Date.now() < volShowUntil && st.device) {
    const v = st.device.volume_percent ?? 0;
    el.innerHTML = `<div class="vol">🔈<div class="bar"><i style="width:${v}%"></i></div>🔊</div>`;
  } else {
    const dur = st.item.duration_ms || 1, pos = clamp(progress(), 0, dur);
    el.innerHTML = `<div class="bar"><i style="width:${(pos / dur) * 100}%"></i></div>
      <div class="times"><span>${fmt(pos)}</span><span>-${fmt(dur - pos)}</span></div>`;
  }
}

/* ---------- Recherche ---------- */
function renderSearch(s) {
  const b = body();
  if (b.dataset.kind !== 'search') {
    b.dataset.kind = 'search';
    b.innerHTML = `<div class="search"><input id="q" type="search" enterkeyhint="search" placeholder="Artiste, album, titre…" autocomplete="off" autocapitalize="off">
      <div class="hint">Valide avec le bouton central</div><div id="recent" style="flex:1;position:relative;overflow:hidden"></div></div>`;
    const q = $('#q'); q.value = s.query || '';
    q.addEventListener('input', () => { s.query = q.value; });
    q.addEventListener('focus', () => { s.sel = -1; drawRecent(s); });
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); q.blur(); doSearch(s.query); } });
    if (s.sel === -1 && matchMedia('(pointer:fine)').matches) setTimeout(() => q.focus(), 50);
  }
  drawRecent(s);
}
function drawRecent(s) {
  const box = $('#recent'); if (!box) return;
  const rec = LS.get('recentSearches', []);
  s.items = rec.length ? [{ head: true, label: 'Récentes' }, ...rec.map((r) => ({ label: r, act: () => doSearch(r) }))] : [];
  if (!s.items.length) { box.innerHTML = ''; return; }
  const fake = { items: s.items, sel: s.sel < 0 ? -99 : s.sel, top: 0, loaded: true };
  const ul = document.createElement('div'); ul.style.height = '100%';
  box.innerHTML = ''; box.appendChild(ul);
  // rendu simplifié de la liste des recherches récentes
  const rows = Math.max(1, Math.floor(box.clientHeight / (rowPx || 28)));
  let top = 0; if (fake.sel >= rows) top = fake.sel - rows + 1;
  ul.innerHTML = '<ul class="list">' + s.items.slice(top, top + rows).map((it, k) =>
    it.head ? `<li class="head"><span class="lbl">${esc(it.label)}</span></li>`
      : `<li class="${top + k === fake.sel ? 'sel' : ''}"><span class="lbl"><span>${esc(it.label)}</span></span></li>`).join('') + '</ul>';
}

/* =========================================================
   Navigation (molette, boutons)
   ========================================================= */
function move(n) {
  const s = cur(); if (!s || !n) return;
  if (s.kind === 'now') return changeVolume(n);
  if (s.kind === 'search') {
    if (!s.items.length) return;
    let i = s.sel < 0 ? 0 : s.sel + Math.sign(n);
    while (s.items[i] && s.items[i].head) i += Math.sign(n) || 1;
    if (i < 1) { s.sel = -1; tick(); drawRecent(s); return; }
    if (i >= s.items.length) return;
    if (document.activeElement && document.activeElement.id === 'q') document.activeElement.blur();
    s.sel = i; tick(); drawRecent(s); return;
  }
  if (s.kind !== 'list' || !s.items.length) return;
  const step = Math.sign(n);
  let i = s.sel, moved = 0;
  for (let k = 0; k < Math.abs(n); k++) {
    let j = i + step;
    while (s.items[j] && !isSel(s.items[j])) j += step;
    if (j < 0 || j >= s.items.length) break;
    i = j; moved++;
  }
  if (moved) { s.sel = i; tick(); renderList(s); }
}
function select() {
  const s = cur(); if (!s) return;
  tick();
  if (s.kind === 'list') { const it = s.items[s.sel]; if (it && it.act) Promise.resolve(it.act()).catch(showErr); }
  else if (s.kind === 'now') { if (P.state && P.state.item) push(nowOptions()); else push(devicesScreen()); }
  else if (s.kind === 'search') {
    if (s.sel >= 0 && s.items[s.sel]) s.items[s.sel].act();
    else if ((s.query || '').trim()) doSearch(s.query);
    else { const q = $('#q'); if (q) q.focus(); }
  }
  else if (s.kind === 'msg' && s.act) Promise.resolve(s.act()).catch(showErr);
}
function menuBtn() { tick(); if (stack.length > 1) pop(); }

/* =========================================================
   Lecture
   ========================================================= */
const P = { state: null, at: 0 };
let pendingPlay = null, volShowUntil = 0, volTimer = 0;

function progress() {
  const st = P.state; if (!st) return 0;
  return (st.progress_ms || 0) + (st.is_playing ? Date.now() - P.at : 0);
}
async function poll() {
  if (!loggedIn()) return;
  try {
    const st = await api('/me/player', { query: { additional_types: 'episode' } });
    P.state = st; P.at = Date.now();
  } catch (e) { if (e.auth) return; }
  updateHeaderPlay();
  if (cur() && cur().kind === 'now') renderNow(false);
}
const pollSoon = (ms = 450) => setTimeout(poll, ms);

function goNow() { if (cur().kind !== 'now') push({ kind: 'now', title: 'En cours' }); }

async function play(bodyObj, deviceId) {
  try {
    await api('/me/player/play', { method: 'PUT', body: bodyObj || undefined, query: deviceId ? { device_id: deviceId } : undefined });
    pendingPlay = null;
    if (P.state) P.state.is_playing = true;
    goNow(); pollSoon(); setTimeout(poll, 1500);
  } catch (e) {
    if (e.status === 404 || e.reason === 'NO_ACTIVE_DEVICE') {
      pendingPlay = bodyObj || {};
      toast('Choisis un appareil');
      push(devicesScreen());
    } else showErr(e);
  }
}
async function shufflePlay(contextUri, total) {
  try { await api('/me/player/shuffle', { method: 'PUT', query: { state: 'true' } }); } catch {}
  const b = { context_uri: contextUri };
  if (total > 1) b.offset = { position: Math.floor(Math.random() * Math.min(total, 1000)) };
  return play(b);
}
async function playPause() {
  tick();
  const st = P.state;
  if (!st || !st.item) return play(null);
  try {
    if (st.is_playing) { await api('/me/player/pause', { method: 'PUT' }); st.progress_ms = progress(); P.at = Date.now(); st.is_playing = false; }
    else { await api('/me/player/play', { method: 'PUT' }); P.at = Date.now(); st.is_playing = true; }
    updateHeaderPlay(); if (cur().kind === 'now') renderNow(false);
    pollSoon(800);
  } catch (e) { if (e.status === 404) push(devicesScreen()); else showErr(e); }
}
async function skip(dir) {
  tick();
  try {
    if (dir < 0 && progress() > 3000) await api('/me/player/seek', { method: 'PUT', query: { position_ms: 0 } });
    else await api(dir > 0 ? '/me/player/next' : '/me/player/previous', { method: 'POST' });
    pollSoon(); setTimeout(poll, 1200);
  } catch (e) { if (e.status === 404) push(devicesScreen()); else showErr(e); }
}
function changeVolume(n) {
  const st = P.state;
  if (!st || !st.device) return;
  if (st.device.supports_volume === false) { volShowUntil = 0; return toast('Volume réglable sur l’appareil'); }
  const v = clamp((st.device.volume_percent ?? 50) + n * 3, 0, 100);
  if (v === st.device.volume_percent) return;
  st.device.volume_percent = v; tick();
  volShowUntil = Date.now() + 1800; renderNowBottom();
  clearTimeout(volTimer);
  volTimer = setTimeout(() => api('/me/player/volume', { method: 'PUT', query: { volume_percent: v } }).catch(showErr), 200);
}

/* =========================================================
   Écrans / menus
   ========================================================= */
let me = LS.get('me', null);
async function loadMe() { try { me = await api('/me'); LS.set('me', { id: me.id, display_name: me.display_name, product: me.product }); } catch {} }

const imgOf = (o) => (o && o.images && o.images[0] && o.images[0].url) || '';
const artistsOf = (t) => (t && t.artists ? t.artists.map((a) => a.name).join(', ') : '');

/* Installation sur l'écran d'accueil */
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; });
window.addEventListener('appinstalled', () => { installEvt = null; toast('App installée ✓'); });
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const installItem = () => (standalone() ? [] : [{ label: 'Installer l’app', act: installApp }]);
function installApp() {
  if (installEvt) {
    const ev = installEvt; installEvt = null;
    ev.prompt();
    return ev.userChoice.then((c) => { if (c.outcome !== 'accepted') installEvt = ev; }).catch(() => {});
  }
  const ua = navigator.userAgent;
  let html;
  if (/SamsungBrowser/i.test(ua)) html = '<b>Samsung Internet</b>Touche ≡ (en bas à droite) → <b>Ajouter la page à</b> → <b>Écran d’accueil</b>.';
  else if (/iPhone|iPad/.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document)) html = '<b>Safari</b>Touche Partager ⬆︎ → <b>Sur l’écran d’accueil</b> → <b>Ajouter</b>.';
  else if (/Android/i.test(ua)) html = '<b>Chrome</b>Touche ⋮ (en haut à droite) → <b>Ajouter à l’écran d’accueil</b> → <b>Installer</b>.<br><br>Pas de ⋮ ? Ouvre le lien dans Chrome.';
  else html = '<b>Ordinateur</b>Clique sur l’icône d’installation à droite de la barre d’adresse.';
  push({ kind: 'msg', title: 'Installer', html });
}

function rootMenu() {
  if (!loggedIn()) {
    return list('iPod', [
      { label: 'Se connecter à Spotify', act: login },
      ...installItem(),
      { label: 'Essayer en démo', act: () => { location.href = redirectUri() + '?demo'; } },
      { label: 'Personnaliser', chev: true, act: openTheme },
      { label: 'Réglages', chev: true, act: () => push(settingsScreen()) },
    ]);
  }
  return list('iPod', [
    { label: 'Playlists', chev: true, act: () => push(playlistsScreen()) },
    { label: 'Artistes', chev: true, act: () => push(artistsScreen()) },
    { label: 'Albums', chev: true, act: () => push(albumsScreen()) },
    { label: 'Titres likés', chev: true, act: () => push(likedScreen()) },
    { label: 'Écoutés récemment', chev: true, act: () => push(recentScreen()) },
    { label: 'Rechercher', chev: true, act: () => push({ kind: 'search', title: 'Rechercher', sel: -1, items: [] }) },
    { label: 'Jam', chev: true, act: () => push(jamScreen()) },
    { label: 'Appareils', chev: true, act: () => push(devicesScreen()) },
    { label: 'Mélanger mes titres likés', act: shuffleLiked },
    ...installItem(),
    { label: 'Personnaliser', chev: true, act: openTheme },
    { label: 'Réglages', chev: true, act: () => push(settingsScreen()) },
    { label: 'En cours', chev: true, act: goNow },
  ]);
}

function trackItem(t, act) { return { label: t.name, sub: artistsOf(t), act }; }

/* Playlists */
function playlistsScreen() {
  return list('Playlists', [], async (offset) => {
    const r = await getPage('/me/playlists', { limit: 50, offset });
    const items = (r.items || []).filter(Boolean).map((p) => {
      const total = (p.tracks && p.tracks.total) ?? (p.items && p.items.total);
      return { label: p.name, sub: total != null ? `${total}` : '', chev: true, act: () => push(playlistScreen(p, total)) };
    });
    return { items, used: (r.items || []).length, more: !!r.next };
  }, { empty: 'Aucune playlist' });
}
let playlistPath = null; // '/items' (API 2026) ou '/tracks' (ancienne)
async function playlistItems(id, offset) {
  const q = { limit: 50, offset, additional_types: 'track,episode' };
  if (playlistPath) return getPage(`/playlists/${id}${playlistPath}`, q);
  try { const r = await getPage(`/playlists/${id}/items`, q); playlistPath = '/items'; return r; }
  catch (e) { if (e.status === 404 || e.status === 403 || e.status === 400) { const r = await getPage(`/playlists/${id}/tracks`, q); playlistPath = '/tracks'; return r; } throw e; }
}
function playlistScreen(p, total) {
  return list(p.name, [
    { label: 'Lire', act: () => play({ context_uri: p.uri }) },
    { label: 'Lecture aléatoire', act: () => shufflePlay(p.uri, total) },
    { head: true, label: 'Titres' },
  ], async (offset) => {
    const r = await playlistItems(p.id, offset);
    const raw = r.items || [];
    const items = raw.map((x) => x && (x.track || x.item)).filter((t) => t && t.uri && !t.is_local)
      .map((t) => trackItem(t, () => play({ context_uri: p.uri, offset: { uri: t.uri } })));
    return { items, used: raw.length, more: !!r.next };
  }, { empty: 'Playlist vide' });
}

/* Artistes */
function artistsScreen() {
  return list('Artistes', [], async (offset, s) => {
    const q = { type: 'artist', limit: 50 }; if (s.after) q.after = s.after;
    const r = await getPage('/me/following', q);
    const a = r.artists || {};
    s.after = a.cursors && a.cursors.after;
    const items = (a.items || []).map((ar) => ({ label: ar.name, chev: true, act: () => push(artistScreen(ar)) }))
      .sort((x, y) => x.label.localeCompare(y.label, 'fr'));
    return { items, more: !!(a.next && s.after) };
  }, { empty: 'Tu ne suis aucun artiste. Utilise Rechercher.' });
}
function artistScreen(ar) {
  return list(ar.name, [
    { label: 'Lire l’artiste', act: () => play({ context_uri: ar.uri }) },
    { label: 'Titres populaires', chev: true, act: () => push(topTracksScreen(ar)) },
    { label: 'Albums', chev: true, act: () => push(artistAlbumsScreen(ar, 'album', 'Albums')) },
    { label: 'Singles et EP', chev: true, act: () => push(artistAlbumsScreen(ar, 'single', 'Singles et EP')) },
    { label: 'Apparitions', chev: true, act: () => push(artistAlbumsScreen(ar, 'appears_on,compilation', 'Apparitions')) },
  ]);
}
function topTracksScreen(ar) {
  return list('Populaires', [], async () => {
    const r = await api(`/artists/${ar.id}/top-tracks`, { query: { market: 'from_token' } });
    const tr = r.tracks || [];
    return { items: tr.map((t) => trackItem(t, () => play({ uris: tr.map((x) => x.uri), offset: { uri: t.uri } }))), more: false };
  });
}
function artistAlbumsScreen(ar, groups, title) {
  return list(title, [], async (offset) => {
    const r = await getPage(`/artists/${ar.id}/albums`, { include_groups: groups, limit: 50, offset });
    return { items: (r.items || []).map((al) => ({ label: al.name, sub: (al.release_date || '').slice(0, 4), chev: true, act: () => push(albumScreen(al)) })), used: (r.items || []).length, more: !!r.next };
  }, { empty: 'Rien ici' });
}

/* Albums */
function albumsScreen() {
  return list('Albums', [], async (offset) => {
    const r = await getPage('/me/albums', { limit: 50, offset });
    return { items: (r.items || []).map((x) => x.album).filter(Boolean).map((al) => ({ label: al.name, sub: artistsOf(al), chev: true, act: () => push(albumScreen(al)) })), used: (r.items || []).length, more: !!r.next };
  }, { empty: 'Aucun album enregistré' });
}
function albumScreen(al) {
  return list(al.name, [
    { label: 'Lire', act: () => play({ context_uri: al.uri }) },
    { label: 'Lecture aléatoire', act: () => shufflePlay(al.uri, al.total_tracks) },
    { head: true, label: artistsOf(al) || 'Titres' },
  ], async (offset) => {
    const r = await getPage(`/albums/${al.id}/tracks`, { limit: 50, offset });
    return { items: (r.items || []).map((t) => ({ label: `${t.track_number}. ${t.name}`, sub: fmt(t.duration_ms), act: () => play({ context_uri: al.uri, offset: { uri: t.uri } }) })), used: (r.items || []).length, more: !!r.next };
  });
}

/* Titres likés */
function likedScreen() {
  const s = list('Titres likés', [
    { label: 'Lecture aléatoire', act: shuffleLiked },
    { head: true, label: 'Titres' },
  ], async (offset) => {
    const r = await getPage('/me/tracks', { limit: 50, offset });
    const raw = r.items || [];
    const tracks = raw.map((x) => x.track).filter(Boolean);
    s.tracks = (s.tracks || []).concat(tracks);
    const items = tracks.map((t) => trackItem(t, () => playLiked(t, s)));
    return { items, used: raw.length, more: !!r.next };
  }, { empty: 'Aucun titre liké' });
  return s;
}
async function playLiked(t, s) {
  if (me && me.id) {
    try { await api('/me/player/play', { method: 'PUT', body: { context_uri: `spotify:user:${me.id}:collection`, offset: { uri: t.uri } } }); goNow(); pollSoon(); return; }
    catch (e) { if (e.status === 404 && e.reason === 'NO_ACTIVE_DEVICE') { return play({ context_uri: `spotify:user:${me.id}:collection`, offset: { uri: t.uri } }); } }
  }
  const all = (s && s.tracks) || [t];
  const i = Math.max(0, all.findIndex((x) => x.uri === t.uri));
  return play({ uris: all.slice(i, i + 100).map((x) => x.uri) });
}
async function shuffleLiked() {
  if (!me) await loadMe();
  try { await api('/me/player/shuffle', { method: 'PUT', query: { state: 'true' } }); } catch {}
  if (me && me.id) return play({ context_uri: `spotify:user:${me.id}:collection` });
  const r = await getPage('/me/tracks', { limit: 50 });
  const uris = (r.items || []).map((x) => x.track && x.track.uri).filter(Boolean).sort(() => Math.random() - 0.5);
  return play({ uris });
}

/* Récents */
function recentScreen() {
  return list('Récents', [], async () => {
    const r = await api('/me/player/recently-played', { query: { limit: 50 } });
    const seen = new Set();
    const tr = (r.items || []).map((x) => x.track).filter((t) => t && !seen.has(t.uri) && seen.add(t.uri));
    return { items: tr.map((t) => trackItem(t, () => play(t.album ? { context_uri: t.album.uri, offset: { uri: t.uri } } : { uris: [t.uri] }))), more: false };
  }, { empty: 'Rien d’écouté récemment' });
}

/* Recherche */
async function doSearch(q) {
  q = (q || '').trim(); if (!q) return;
  const rec = LS.get('recentSearches', []).filter((x) => x.toLowerCase() !== q.toLowerCase());
  rec.unshift(q); LS.set('recentSearches', rec.slice(0, 12));
  const s = list(q, [], async () => {
    const r = await getPage('/search', { q, type: 'artist,album,track,playlist', limit: 10 });
    const cat = [
      ['artists', 'Artistes', 'artist'], ['albums', 'Albums', 'album'],
      ['tracks', 'Titres', 'track'], ['playlists', 'Playlists', 'playlist'],
    ];
    const items = cat.map(([k, label, type]) => {
      const n = r[k] ? (r[k].items || []).filter(Boolean).length : 0;
      return n ? { label, sub: r[k].total > n ? `${r[k].total}` : `${n}`, chev: true, act: () => push(searchTypeScreen(q, type, label)) } : null;
    }).filter(Boolean);
    return { items, more: false };
  }, { empty: 'Aucun résultat' });
  push(s);
}
function searchTypeScreen(q, type, label) {
  return list(label, [], async (offset) => {
    const r = await getPage('/search', { q, type, limit: 20, offset });
    const blk = r[type + 's'] || {};
    const raw = blk.items || [];
    const xs = raw.filter(Boolean);
    let items;
    if (type === 'artist') items = xs.map((a) => ({ label: a.name, chev: true, act: () => push(artistScreen(a)) }));
    else if (type === 'album') items = xs.map((a) => ({ label: a.name, sub: artistsOf(a), chev: true, act: () => push(albumScreen(a)) }));
    else if (type === 'playlist') items = xs.map((p) => ({ label: p.name, sub: p.owner && p.owner.display_name, chev: true, act: () => push(playlistScreen(p, (p.tracks || p.items || {}).total)) }));
    else items = xs.map((t) => trackItem(t, () => play({ context_uri: t.album.uri, offset: { uri: t.uri } })));
    return { items, used: raw.length, more: !!blk.next && offset + raw.length < 200 };
  });
}

/* Appareils */
function devicesScreen() {
  const s = list('Appareils', [], async () => {
    const r = await api('/me/player/devices');
    const ds = (r && r.devices) || [];
    const items = ds.map((d) => ({
      label: d.name, sub: devType(d.type), check: () => d.is_active,
      act: () => pickDevice(d),
    }));
    items.push({ label: 'Actualiser', act: () => { s.items = []; s.loaded = false; s.count = 0; ensureLoaded(s); } });
    items.push({ label: 'Ouvrir Spotify', act: openSpotify });
    if (!ds.length) items.unshift({ head: true, label: 'Ouvre Spotify sur un appareil' });
    return { items, more: false };
  });
  return s;
}
const devType = (t) => ({ Smartphone: 'Téléphone', Computer: 'Ordinateur', Tablet: 'Tablette', Speaker: 'Enceinte', TV: 'TV', CastVideo: 'Chromecast', CastAudio: 'Chromecast', Automobile: 'Voiture' }[t] || t || '');
async function pickDevice(d) {
  if (pendingPlay) return play(pendingPlay, d.id);
  try {
    await api('/me/player', { method: 'PUT', body: { device_ids: [d.id], play: true } });
    toast('Lecture sur ' + d.name);
    pollSoon(700); setTimeout(() => { if (cur().title === 'Appareils') pop(); goNow(); }, 500);
  } catch (e) { showErr(e); }
}
function openSpotify() { location.href = 'spotify:'; }

/* Jam */
function jamScreen() {
  return {
    kind: 'msg', title: 'Jam',
    html: '<b>Lancer un Jam</b>Spotify ne permet pas aux apps externes de démarrer un Jam.<br><br>Appuie au centre → Spotify s’ouvre → touche l’appareil (en bas) → <b>Lancer un Jam</b>.<br><br>Reviens ici : l’iPod pilote le Jam.',
    act: openSpotify,
  };
}

/* Options du titre en cours */
function nowOptions() {
  const st = P.state, it = st.item;
  let liked = null;
  const s = list('Options', [
    { label: () => (liked == null ? 'J’aime…' : liked ? 'Retirer des titres likés' : 'Ajouter aux titres likés'), act: () => toggleLike(it, liked, (v) => { liked = v; renderList(s); }) },
    { label: 'Aléatoire', sub: () => (P.state.shuffle_state ? 'Oui' : 'Non'), act: async () => {
      const v = !P.state.shuffle_state;
      await api('/me/player/shuffle', { method: 'PUT', query: { state: String(v) } }); P.state.shuffle_state = v; renderList(s);
    } },
    { label: 'Répéter', sub: () => ({ off: 'Non', context: 'Tout', track: 'Titre' }[P.state.repeat_state] || 'Non'), act: async () => {
      const nx = { off: 'context', context: 'track', track: 'off' }[P.state.repeat_state] || 'context';
      await api('/me/player/repeat', { method: 'PUT', query: { state: nx } }); P.state.repeat_state = nx; renderList(s);
    } },
    ...(it.artists && it.artists[0] ? [{ label: 'Aller à l’artiste', chev: true, act: () => push(artistScreen(it.artists[0])) }] : []),
    ...(it.album ? [{ label: 'Aller à l’album', chev: true, act: () => push(albumScreen(it.album)) }] : []),
    { label: 'Appareils', chev: true, act: () => push(devicesScreen()) },
  ]);
  if (it.type !== 'episode' && it.id) {
    likedState(it).then((v) => { liked = v; if (cur() === s) renderList(s); }).catch(() => {});
  }
  return s;
}
async function likedState(t) {
  try { const r = await api('/me/tracks/contains', { query: { ids: t.id } }); return !!(r && r[0]); }
  catch { const r = await api('/me/library/contains', { query: { uris: t.uri } }); return !!(r && r[0]); }
}
async function toggleLike(t, liked, done) {
  const method = liked ? 'DELETE' : 'PUT';
  try { await api('/me/tracks', { method, query: { ids: t.id } }); }
  catch (e) { if (e.status === 404 || e.status === 403) await api('/me/library', { method, query: { uris: t.uri } }); else throw e; }
  done(!liked); toast(liked ? 'Retiré des titres likés' : 'Ajouté aux titres likés ♥');
}

/* Réglages */
function settingsScreen() {
  const s = list('Réglages', [
    { label: 'Son du clic', sub: () => (LS.get('sound', true) ? 'Oui' : 'Non'), act: () => { LS.set('sound', !LS.get('sound', true)); renderList(s); } },
    { label: 'Vibration', sub: () => (LS.get('vibrate', true) ? 'Oui' : 'Non'), act: () => { LS.set('vibrate', !LS.get('vibrate', true)); renderList(s); } },
    { label: 'Personnaliser', chev: true, act: openTheme },
    ...(loggedIn() && !DEMO ? [
      { label: 'Compte', sub: () => (me && me.display_name) || '…' },
      { label: 'Se déconnecter', act: logout },
    ] : []),
    ...(DEMO ? [{ label: 'Quitter la démo', act: () => { location.href = redirectUri(); } }] : []),
    ...(!(window.IPOD_CONFIG && window.IPOD_CONFIG.clientId) ? [{ label: 'Configuration Spotify', chev: true, act: openSetup }] : []),
    { label: 'Version', sub: '1.0' },
  ]);
  return s;
}

/* =========================================================
   Personnalisation des couleurs
   ========================================================= */
const PARTS = [
  ['body', 'Coque', '--body'],
  ['bezel', 'Contour écran', '--bezel'],
  ['scrBg', 'Fond écran', '--scr-bg'],
  ['scrText', 'Texte écran', '--scr-text'],
  ['hdrBg', 'Barre de titre', '--hdr-bg'],
  ['hlBg', 'Sélection', '--hl-bg'],
  ['hlText', 'Texte sélection', '--hl-text'],
  ['wheel', 'Molette', '--wheel'],
  ['wheelText', 'Libellés molette', '--wheel-text'],
  ['center', 'Bouton central', '--center'],
  ['pageBg', 'Fond de page', '--page-bg'],
];
const PRESETS = [
  { name: 'Noir classique', t: { body: '#2b2c30', bezel: '#0d0d0f', scrBg: '#f4f6f8', scrText: '#111316', hdrBg: '#d9dde3', hlBg: '#2f7de1', hlText: '#ffffff', wheel: '#3a3b40', wheelText: '#f2f2f2', center: '#2b2c30', pageBg: '#1b1d22', finish: 'gloss' } },
  { name: 'Blanc', t: { body: '#f3f3f1', bezel: '#1a1a1a', scrBg: '#f7f9fb', scrText: '#111316', hdrBg: '#dfe3e8', hlBg: '#3b82f6', hlText: '#ffffff', wheel: '#ffffff', wheelText: '#a6a9b0', center: '#ebebe9', pageBg: '#d8dade', finish: 'gloss' } },
  { name: 'Argent', t: { body: '#c4c8ce', bezel: '#151619', scrBg: '#f4f6f8', scrText: '#111316', hdrBg: '#d6dbe2', hlBg: '#4a8be0', hlText: '#ffffff', wheel: '#f4f4f4', wheelText: '#8f939a', center: '#cfd3d8', pageBg: '#2a2c31', finish: 'metal' } },
  { name: 'Rouge', t: { body: '#b3121f', bezel: '#120708', scrBg: '#f6f4f4', scrText: '#160a0b', hdrBg: '#e2d6d6', hlBg: '#c8102e', hlText: '#ffffff', wheel: '#1b1b1d', wheelText: '#e8323f', center: '#b3121f', pageBg: '#2a0e11', finish: 'gloss' } },
  { name: 'Rose', t: { body: '#f2a7c3', bezel: '#2a1720', scrBg: '#fff7fa', scrText: '#2a1720', hdrBg: '#f6d9e5', hlBg: '#e2558a', hlText: '#ffffff', wheel: '#fdeef4', wheelText: '#cf6b93', center: '#f2a7c3', pageBg: '#3a2430', finish: 'metal' } },
  { name: 'Menthe', t: { body: '#9edcc6', bezel: '#12241e', scrBg: '#f5fbf8', scrText: '#10221b', hdrBg: '#d3eee4', hlBg: '#2fa27a', hlText: '#ffffff', wheel: '#effaf5', wheelText: '#4ea787', center: '#9edcc6', pageBg: '#1d332b', finish: 'metal' } },
  { name: 'Spotify', t: { body: '#141414', bezel: '#000000', scrBg: '#181818', scrText: '#ffffff', hdrBg: '#2a2a2a', hlBg: '#1db954', hlText: '#000000', wheel: '#1f1f1f', wheelText: '#1db954', center: '#141414', pageBg: '#000000', finish: 'matte' } },
  { name: 'Bleu nuit', t: { body: '#1f3a7a', bezel: '#070b16', scrBg: '#eef3fb', scrText: '#0b1430', hdrBg: '#cbd7ee', hlBg: '#f59e0b', hlText: '#111111', wheel: '#e9eef8', wheelText: '#1f3a7a', center: '#1f3a7a', pageBg: '#0b1227', finish: 'metal' } },
];
let theme = { ...PRESETS[0].t, ...LS.get('theme', {}) };
function applyTheme(t) {
  theme = { ...PRESETS[0].t, ...t };
  const root = document.documentElement.style;
  PARTS.forEach(([k, , v]) => root.setProperty(v, theme[k]));
  const ip = $('#ipod'); ip.classList.remove('gloss', 'matte', 'metal'); ip.classList.add(theme.finish || 'gloss');
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = theme.pageBg;
  LS.set('theme', theme);
}
function openTheme() {
  const sheet = $('#themeSheet');
  const sw = (t) => `background:linear-gradient(135deg, ${t.body} 0 50%, ${t.wheel} 50% 100%)`;
  $('#presets').innerHTML = PRESETS.map((p, i) => `<button class="preset" data-p="${i}"><span class="sw" style="${sw(p.t)}"></span>${esc(p.name)}</button>`).join('');
  const drawMine = () => {
    const mine = LS.get('myThemes', []);
    $('#myPresets').innerHTML = mine.map((p, i) => `<button class="preset" data-m="${i}"><span class="sw" style="${sw(p.t)}"></span>${esc(p.name)}<span class="del" data-del="${i}">✕</span></button>`).join('');
  };
  drawMine();
  const drawParts = () => {
    $('#parts').innerHTML = PARTS.map(([k, label]) => `<label class="part">${esc(label)}<input type="color" data-k="${k}" value="${theme[k]}"></label>`).join('');
    $('#finish').value = theme.finish || 'gloss';
  };
  drawParts();
  $('#parts').oninput = (e) => { const k = e.target.dataset.k; if (k) applyTheme({ ...theme, [k]: e.target.value }); };
  $('#finish').onchange = (e) => applyTheme({ ...theme, finish: e.target.value });
  $('#presets').onclick = (e) => { const b = e.target.closest('[data-p]'); if (b) { applyTheme(PRESETS[+b.dataset.p].t); drawParts(); } };
  $('#myPresets').onclick = (e) => {
    const mine = LS.get('myThemes', []);
    const d = e.target.closest('[data-del]');
    if (d) { e.stopPropagation(); if (confirm('Supprimer ce thème ?')) { mine.splice(+d.dataset.del, 1); LS.set('myThemes', mine); drawMine(); } return; }
    const b = e.target.closest('[data-m]'); if (b) { applyTheme(mine[+b.dataset.m].t); drawParts(); }
  };
  $('#saveTheme').onclick = () => {
    const name = (prompt('Nom du thème', 'Mon iPod') || '').trim(); if (!name) return;
    const mine = LS.get('myThemes', []); mine.push({ name, t: { ...theme } }); LS.set('myThemes', mine); drawMine();
  };
  $('#resetTheme').onclick = () => { applyTheme(PRESETS[0].t); drawParts(); };
  sheet.hidden = false;
  document.body.classList.add('theming'); rowPx = 0; render();
}
function closeTheme() { document.body.classList.remove('theming'); rowPx = 0; render(); }

/* Configuration Spotify */
function openSetup() {
  $('#redirectUri').textContent = redirectUri();
  $('#clientIdInput').value = LS.get('clientId', '');
  $('#setupSheet').hidden = false;
}
$('#copyRedirect').onclick = async () => {
  try { await navigator.clipboard.writeText(redirectUri()); toast('Copié'); } catch { toast('Sélectionne et copie le texte'); }
};
$('#saveClientId').onclick = () => {
  const v = $('#clientIdInput').value.trim();
  if (!/^[a-f0-9]{32}$/i.test(v)) return alert('Le Client ID fait 32 caractères (chiffres et lettres a-f).');
  LS.set('clientId', v); $('#setupSheet').hidden = true; login();
};
document.querySelectorAll('.sheet').forEach((sh) => sh.addEventListener('click', (e) => {
  if (e.target === sh || e.target.closest('[data-close]')) { sh.hidden = true; if (sh.id === 'themeSheet') closeTheme(); }
}));

/* =========================================================
   Molette : rotation + boutons
   ========================================================= */
const wheel = $('#wheel'), center = $('#center');
const STEP = 18; // degrés par cran (20 crans par tour)
let drag = null;
function polar(e) {
  const r = wheel.getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
  return { a: Math.atan2(dy, dx) * 180 / Math.PI, d: Math.hypot(dx, dy) / (r.width / 2) };
}
wheel.addEventListener('pointerdown', (e) => {
  if (e.target === center) return;
  e.preventDefault();
  try { wheel.setPointerCapture(e.pointerId); } catch {}
  const p = polar(e);
  drag = { id: e.pointerId, a: p.a, acc: 0, total: 0, start: p };
  wheel.classList.add('active');
});
wheel.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const p = polar(e);
  if (p.d < 0.25) { drag.a = p.a; return; } // trop près du centre : angle instable
  let d = p.a - drag.a; if (d > 180) d -= 360; if (d < -180) d += 360;
  drag.a = p.a; drag.acc += d; drag.total += Math.abs(d);
  if (Math.abs(drag.acc) >= STEP) { const n = Math.trunc(drag.acc / STEP); drag.acc -= n * STEP; move(n); }
});
function endDrag(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const wasTap = drag.total < 10 && e.type === 'pointerup';
  const a = drag.start.a;
  drag = null; wheel.classList.remove('active');
  if (!wasTap) return;
  if (a > -135 && a < -45) menuBtn();
  else if (a >= -45 && a <= 45) skip(1);
  else if (a > 45 && a < 135) playPause();
  else skip(-1);
}
wheel.addEventListener('pointerup', endDrag);
wheel.addEventListener('pointercancel', endDrag);
center.addEventListener('pointerdown', (e) => e.stopPropagation());
center.addEventListener('click', (e) => { e.preventDefault(); select(); });

// Souris / pavé tactile (ordinateur)
let wheelAcc = 0;
$('#ipod').addEventListener('wheel', (e) => {
  if (!$('#themeSheet').hidden) return;
  e.preventDefault(); wheelAcc += e.deltaY;
  if (Math.abs(wheelAcc) >= 40) { const n = Math.trunc(wheelAcc / 40); wheelAcc -= n * 40; move(n); }
}, { passive: false });

// Clavier
document.addEventListener('keydown', (e) => {
  if (!$('#themeSheet').hidden || !$('#setupSheet').hidden) { if (e.key === 'Escape') { $('#themeSheet').hidden = true; $('#setupSheet').hidden = true; closeTheme(); } return; }
  const typing = document.activeElement && document.activeElement.tagName === 'INPUT';
  if (typing && e.key !== 'Escape' && e.key !== 'ArrowDown') return;
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); move(1); break;
    case 'ArrowUp': e.preventDefault(); move(-1); break;
    case 'Enter': e.preventDefault(); select(); break;
    case 'Escape': case 'Backspace': e.preventDefault(); if (typing) document.activeElement.blur(); menuBtn(); break;
    case ' ': e.preventDefault(); playPause(); break;
    case 'ArrowRight': skip(1); break;
    case 'ArrowLeft': skip(-1); break;
  }
});

/* =========================================================
   Batterie (Android / navigateurs qui l'exposent)
   ========================================================= */
if (navigator.getBattery) {
  navigator.getBattery().then((b) => {
    const upd = () => { $('#battFill').style.width = Math.round(b.level * 100) + '%'; };
    upd(); b.addEventListener('levelchange', upd);
  }).catch(() => {});
}

/* =========================================================
   Mode démo (données fictives, sans compte Spotify)
   ========================================================= */
const D = { tracks: new Map(), state: null };
function art(i) {
  const h = (i * 47) % 360;
  return 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='hsl(${h},70%,62%)'/><stop offset='1' stop-color='hsl(${(h + 80) % 360},65%,32%)'/></linearGradient></defs><rect width='10' height='10' fill='url(#g)'/><circle cx='5' cy='5' r='2.2' fill='rgba(255,255,255,.25)'/></svg>`);
}
const DA = ['Neptunica', 'Clara Luciani', 'Daft Punk', 'Angèle', 'Stromae', 'Phoenix', 'Christine and the Queens', 'Justice', 'Juliette Armanet', 'M83'];
const dArtist = (i) => ({ id: 'ar' + i, name: DA[i % DA.length], uri: 'spotify:artist:ar' + i });
const dAlbum = (i) => ({ id: 'al' + i, name: ['What If?', 'Cœur', 'Discovery', 'Nonante-Cinq', 'Racine Carrée', 'Wolfgang', 'Chris', 'Cross', 'Brune', 'Hurry Up'][i % 10] + (i >= 10 ? ' ' + i : ''), uri: 'spotify:album:al' + i, artists: [dArtist(i)], images: [{ url: art(i) }], release_date: String(2010 + (i % 15)), total_tracks: 12 });
function dTrack(i) {
  const t = { id: 't' + i, uri: 'spotify:track:t' + i, type: 'track', name: ['Midnight Drive', 'Lumière', 'One More Time', 'Bruxelles', 'Papaoutai', 'Lisztomania', 'Tilted', 'D.A.N.C.E', 'Le dernier jour', 'Midnight City', 'Sous la pluie', 'Neon Heart'][i % 12] + (i >= 12 ? ' (' + i + ')' : ''), artists: [dArtist(i % 10)], album: dAlbum(i % 10), duration_ms: 150000 + (i * 7919) % 120000, track_number: (i % 12) + 1 };
  D.tracks.set(t.uri, t); return t;
}
const page = (arr, q, total) => {
  const off = +q.offset || 0, lim = +q.limit || 20;
  return { items: arr.slice(off, off + lim), total: total ?? arr.length, next: off + lim < (total ?? arr.length) ? 'x' : null };
};
function mock(path, method, b, q) {
  const now = Date.now();
  if (!D.state) D.state = { is_playing: true, progress_ms: 42000, item: dTrack(0), shuffle_state: false, repeat_state: 'off', device: { id: 'd1', name: 'iPhone', type: 'Smartphone', volume_percent: 60, supports_volume: true, is_active: true }, _at: now };
  const st = D.state;
  const prog = () => st.progress_ms + (st.is_playing ? now - st._at : 0);
  const setTrack = (t) => { st.item = t; st.progress_ms = 0; st._at = now; st.is_playing = true; };
  const range = (n, f, o = 0) => Array.from({ length: n }, (_, i) => f(i + o));
  return sleep(120).then(() => {
    if (path === '/me') return { id: 'demo', display_name: 'Démo', product: 'premium' };
    if (path === '/me/player' && method === 'GET') { const p = prog(); return { ...st, progress_ms: p >= st.item.duration_ms ? 0 : p }; }
    if (path === '/me/player' && method === 'PUT') { st.is_playing = true; return null; }
    if (path === '/me/player/play') {
      st.progress_ms = prog(); st._at = now;
      if (b && b.offset && b.offset.uri && D.tracks.get(b.offset.uri)) setTrack(D.tracks.get(b.offset.uri));
      else if (b && (b.context_uri || b.uris)) setTrack(dTrack(Math.floor(Math.random() * 40)));
      st.is_playing = true; return null;
    }
    if (path === '/me/player/pause') { st.progress_ms = prog(); st._at = now; st.is_playing = false; return null; }
    if (path === '/me/player/next') { setTrack(dTrack((+st.item.id.slice(1) + 1) % 60)); return null; }
    if (path === '/me/player/previous') { setTrack(dTrack(Math.max(0, +st.item.id.slice(1) - 1))); return null; }
    if (path === '/me/player/seek') { st.progress_ms = +q.position_ms; st._at = now; return null; }
    if (path === '/me/player/volume') { st.device.volume_percent = +q.volume_percent; return null; }
    if (path === '/me/player/shuffle') { st.shuffle_state = q.state === 'true'; return null; }
    if (path === '/me/player/repeat') { st.repeat_state = q.state; return null; }
    if (path === '/me/player/devices') return { devices: [st.device, { id: 'd2', name: 'iPad', type: 'Tablet', volume_percent: 40, is_active: false }, { id: 'd3', name: 'Galaxy Tab', type: 'Tablet', volume_percent: 40, is_active: false }, { id: 'd4', name: 'Enceinte salon', type: 'Speaker', volume_percent: 30, is_active: false }] };
    if (path === '/me/playlists') return page(range(24, (i) => ({ id: 'pl' + i, uri: 'spotify:playlist:pl' + i, name: ['Chill du soir', 'Running', 'Années 80', 'Focus', 'Dîner entre amis', 'Road trip', 'Découvertes de la semaine', 'Électro FR'][i % 8] + (i >= 8 ? ' ' + i : ''), tracks: { total: 30 + i }, owner: { display_name: 'Démo' }, images: [{ url: art(i) }] })), q);
    let m;
    if ((m = path.match(/^\/playlists\/(\w+)\/(items|tracks)$/))) return page(range(40, (i) => ({ track: dTrack(i) })), q);
    if (path === '/me/following') return { artists: { items: range(10, dArtist), next: null, cursors: {} } };
    if ((m = path.match(/^\/artists\/(\w+)\/top-tracks$/))) return { tracks: range(10, dTrack, 3) };
    if ((m = path.match(/^\/artists\/(\w+)\/albums$/))) return page(range(8, dAlbum, 1), q);
    if (path === '/me/albums') return page(range(18, (i) => ({ album: dAlbum(i) })), q);
    if ((m = path.match(/^\/albums\/(\w+)\/tracks$/))) return page(range(12, dTrack, 5), q);
    if (path === '/me/tracks') return page(range(120, (i) => ({ track: dTrack(i) })), q);
    if (path === '/me/tracks/contains') return [false];
    if (path === '/me/tracks') return null;
    if (path === '/me/player/recently-played') return { items: range(15, (i) => ({ track: dTrack(i * 3) })) };
    if (path === '/search') {
      const types = q.type.split(','), out = {};
      if (types.includes('artist')) out.artists = page(range(6, dArtist), q, 6);
      if (types.includes('album')) out.albums = page(range(10, dAlbum), q, 10);
      if (types.includes('track')) out.tracks = page(range(30, dTrack), q, 30);
      if (types.includes('playlist')) out.playlists = page(range(8, (i) => ({ id: 'ps' + i, uri: 'spotify:playlist:ps' + i, name: `${q.q} — mix ${i + 1}`, tracks: { total: 25 }, owner: { display_name: 'Spotify' } })), q, 8);
      return out;
    }
    return null;
  });
}

/* =========================================================
   Démarrage
   ========================================================= */
async function init() {
  applyTheme(theme);
  if (params.get('cid')) { LS.set('clientId', params.get('cid')); history.replaceState(null, '', redirectUri()); }
  try { await handleCallback(); } catch (e) { setTimeout(() => toast('Connexion impossible : ' + e.message, 3500), 300); }
  resetRoot();
  if (loggedIn()) {
    if (DEMO) setTimeout(() => toast('Mode démo : données fictives', 2500), 300);
    loadMe(); poll();
  }
  setInterval(() => { if (document.visibilityState === 'visible' && loggedIn()) poll(); }, 4000);
  setInterval(() => { const s = cur(); if (s && s.kind === 'now' && P.state && P.state.item) { if (P.state.is_playing && progress() > P.state.item.duration_ms + 800) poll(); renderNowBottom(); } }, 500);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poll(); });
  window.addEventListener('resize', () => { rowPx = 0; render(); });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register(CFG.swPath || 'sw.js').catch(() => {});
  // Copie sans Client ID intégré : on ouvre la configuration dès le premier lancement.
  if (!DEMO && !clientId() && !loggedIn()) setTimeout(openSetup, 400);
}
init();
})();
