import { createClient } from '@supabase/supabase-js';
import { Capacitor } from '@capacitor/core';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SUPABASE_URL = 'https://ohcbxaykwnlwrxxijqrz.supabase.co';
const SUPABASE_KEY = 'sb_publishable_r5ogU_4y2IsLMyfCNeT4tA_S6iamit5';
const IS_NATIVE = Capacitor.isNativePlatform();

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

// ---------------------------------------------------------------------------
// Local storage helpers (everything the kiosk needs to keep working offline)
// ---------------------------------------------------------------------------
const K = { cafe: 's10_cafe', queue: 's10_queue', recent: 's10_recent' };
const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const S = {
  session: null,
  cafe: load(K.cafe, null),
  player: null,        // { name, phone, consent }
  ownerTab: 'overview',
  plays: [],           // owner data cache
  playsLoaded: false,
};

const app = document.getElementById('app');
let timers = [];       // cleared on every screen change
const later = (fn, ms) => { const t = setTimeout(fn, ms); timers.push(t); return t; };
const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (ms) => (Math.max(0, ms) / 1000).toFixed(2);
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() :
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16); }));
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const dayKey = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
const fmtDateTime = (d) => new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const couponCode = () => { const a = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let s = ''; const r = crypto.getRandomValues(new Uint32Array(6)); for (const n of r) s += a[n % a.length]; return s; };
const normPhone = (raw) => { let d = String(raw).replace(/\D/g, ''); if (d.length === 12 && d.startsWith('91')) d = d.slice(2); if (d.length === 11 && d.startsWith('0')) d = d.slice(1); return d; };
const sortedTiers = (c) => [...(c?.tiers || [])].filter((t) => t && t.reward).sort((a, b) => a.margin_ms - b.margin_ms);
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const pinHash = (pin) => sha256(`${S.cafe.id}:${pin}`);

function toast(msg, ms = 2600) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
function render(html, cls = '') {
  clearTimers();
  app.className = cls;
  app.innerHTML = html;
  window.scrollTo(0, 0);
}
const $ = (sel) => app.querySelector(sel);
const $$ = (sel) => [...app.querySelectorAll(sel)];

// ---------------------------------------------------------------------------
// Data: cafe settings & play queue
// ---------------------------------------------------------------------------
async function fetchCafe() {
  const { data, error } = await sb.from('cafes').select('*').maybeSingle();
  if (error) throw error;
  if (data) { S.cafe = data; save(K.cafe, data); }
  return data;
}

async function updateCafe(patch) {
  const { data, error } = await sb.from('cafes').update(patch).eq('id', S.cafe.id).select().single();
  if (error) throw error;
  S.cafe = data; save(K.cafe, data);
  return data;
}

function queue() { return load(K.queue, []); }
let flushing = false;
async function flushQueue() {
  if (flushing || !S.session) return;
  const q = queue();
  if (!q.length) return;
  flushing = true;
  try {
    const { error } = await sb.from('plays').upsert(q, { onConflict: 'id', ignoreDuplicates: true });
    if (!error) {
      const sent = new Set(q.map((p) => p.id));
      save(K.queue, queue().filter((p) => !sent.has(p.id)));
      // keep the owner cache in step
      for (const p of q) if (!S.plays.find((x) => x.id === p.id)) S.plays.unshift(p);
    }
  } catch { /* offline: try again later */ }
  finally { flushing = false; updateOfflinePill(); }
}
setInterval(flushQueue, 30000);
window.addEventListener('online', () => { flushQueue(); updateOfflinePill(); });
window.addEventListener('offline', updateOfflinePill);

function updateOfflinePill() {
  const el = document.getElementById('offline-pill');
  if (!el) return;
  const n = queue().length;
  if (!navigator.onLine || n) {
    el.hidden = false;
    el.textContent = !navigator.onLine ? `Offline · ${n} play${n === 1 ? '' : 's'} saved on tablet` : `Syncing ${n} play${n === 1 ? '' : 's'}…`;
  } else el.hidden = true;
}

function rememberPlay(p) {
  const cutoff = Date.now() - 2 * 864e5;
  const r = load(K.recent, []).filter((x) => new Date(x.t).getTime() > cutoff);
  r.push({ phone: p.phone, t: p.played_at });
  save(K.recent, r);
}

async function playsToday(phone) {
  const since = startOfToday();
  const local = load(K.recent, []).filter((x) => x.phone === phone && new Date(x.t) >= since).length;
  if (!navigator.onLine) return local;
  try {
    const { count, error } = await withTimeout(
      sb.from('plays').select('id', { count: 'exact', head: true })
        .eq('cafe_id', S.cafe.id).eq('phone', phone).gte('played_at', since.toISOString()), 2500);
    if (error) return local;
    // server count already includes synced local plays; add only unsynced ones
    const pending = queue().filter((p) => p.phone === phone && new Date(p.played_at) >= since).length;
    return Math.max(local, (count || 0) + pending);
  } catch { return local; }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  if (IS_NATIVE) {
    try { const { StatusBar } = await import('@capacitor/status-bar'); await StatusBar.hide(); } catch {}
    try { const { KeepAwake } = await import('@capacitor-community/keep-awake'); await KeepAwake.keepAwake(); } catch {}
  }
  const { data } = await sb.auth.getSession();
  S.session = data.session;
  sb.auth.onAuthStateChange((_e, session) => { S.session = session; });

  if (!S.session) return screenAuth();
  if (S.cafe && S.cafe.owner_id !== S.session.user.id) { S.cafe = null; }
  if (!S.cafe) {
    try { await fetchCafe(); } catch { return screenError('Could not load your cafe. Check the internet connection.', boot); }
    if (!S.cafe) return screenError('No cafe found for this account.', boot);
  } else {
    fetchCafe().catch(() => {}); // refresh in background
  }
  flushQueue();
  if (!S.cafe.pin_hash) return screenSetPin(true);
  screenWelcome();
}

function screenError(msg, retry) {
  render(`<div class="screen"><h2>Something went wrong</h2><p class="sub">${esc(msg)}</p>
    <button class="btn" id="retry">Try again</button></div>`);
  $('#retry').onclick = retry;
}

// ---------------------------------------------------------------------------
// Auth (owner account)
// ---------------------------------------------------------------------------
function screenAuth(mode = 'login') {
  const signup = mode === 'signup';
  render(`
  <div class="screen game-bg">
    <div class="brand" style="font-size:44px">Stop<b>@</b>10</div>
    <p class="sub">${signup ? 'Create your cafe account. You only do this once per tablet.' : 'Cafe owner login'}</p>
    <form class="form" id="f" autocomplete="on">
      ${signup ? `<div class="field"><label>Cafe / restaurant name</label><input name="cafe" required maxlength="60" placeholder="e.g. Blue Tokai Indiranagar"></div>` : ''}
      <div class="field"><label>Email</label><input name="email" type="email" required autocomplete="email" placeholder="owner@cafe.com"></div>
      <div class="field"><label>Password</label><input name="password" type="password" required minlength="6" autocomplete="${signup ? 'new-password' : 'current-password'}" placeholder="At least 6 characters"></div>
      <div class="error" id="err"></div>
      <button class="btn block" id="go">${signup ? 'Create account' : 'Log in'}</button>
      <button type="button" class="btn ghost block" id="switch">${signup ? 'I already have an account' : 'New cafe? Create an account'}</button>
    </form>
  </div>`, '');
  $('#switch').onclick = () => screenAuth(signup ? 'login' : 'signup');
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const email = f.get('email').trim(), password = f.get('password');
    const btn = $('#go'); btn.disabled = true; $('#err').textContent = '';
    try {
      if (signup) {
        const { data, error } = await sb.auth.signUp({ email, password, options: { data: { cafe_name: f.get('cafe').trim() } } });
        if (error) throw error;
        if (!data.session) {
          // accounts are auto-confirmed on the server, so log straight in
          const r = await sb.auth.signInWithPassword({ email, password });
          if (!r.error && r.data.session) { S.cafe = null; save(K.cafe, null); S.plays = []; S.playsLoaded = false; return boot(); }
          render(`<div class="screen"><h2>Check your email</h2><p class="sub">We sent a confirmation link to <b>${esc(email)}</b>. Open it, then come back and log in.</p><button class="btn" id="b">Go to login</button></div>`);
          $('#b').onclick = () => screenAuth('login');
          return;
        }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
      S.cafe = null; save(K.cafe, null); S.plays = []; S.playsLoaded = false;
      await boot();
    } catch (err) {
      $('#err').textContent = niceAuthError(err);
      btn.disabled = false;
    }
  };
}
function niceAuthError(err) {
  const m = (err && err.message) || String(err);
  if (/Invalid login/i.test(m)) return 'Wrong email or password.';
  if (/Email not confirmed/i.test(m)) return 'Please confirm your email first (check your inbox).';
  if (/already registered/i.test(m)) return 'This email already has an account. Log in instead.';
  if (/fetch|network/i.test(m)) return 'No internet connection.';
  return m;
}

// ---------------------------------------------------------------------------
// PIN screens
// ---------------------------------------------------------------------------
function pinPad({ title, sub, onDone, onCancel, extra = '' }) {
  let pin = '';
  render(`
  <div class="screen">
    <h2>${esc(title)}</h2>
    <p class="sub">${esc(sub)}</p>
    <div class="pin-dots">${'<span></span>'.repeat(4)}</div>
    <div class="error" id="err"></div>
    <div class="pad">
      ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-k="${n}">${n}</button>`).join('')}
      <button class="${onCancel ? '' : 'blank'}" data-k="x" style="font-size:16px">${onCancel ? 'Cancel' : ''}</button>
      <button data-k="0">0</button>
      <button data-k="b" style="font-size:22px">⌫</button>
    </div>
    ${extra}
  </div>`);
  const dots = $$('.pin-dots span');
  const paint = () => dots.forEach((d, i) => d.classList.toggle('on', i < pin.length));
  $$('.pad button').forEach((b) => (b.onclick = async () => {
    const k = b.dataset.k;
    if (k === 'x') return onCancel && onCancel();
    if (k === 'b') pin = pin.slice(0, -1);
    else if (pin.length < 4) pin += k;
    paint();
    if (pin.length === 4) {
      const ok = await onDone(pin);
      if (ok === false) { pin = ''; paint(); $('#err').textContent = 'Wrong PIN, try again'; }
    }
  }));
}

function screenSetPin(firstTime = false) {
  pinPad({
    title: firstTime ? 'Set an owner PIN' : 'New owner PIN',
    sub: 'Staff use this 4-digit PIN to open the owner dashboard from the game.',
    onCancel: firstTime ? null : () => screenOwner(),
    onDone: (pin1) => {
      pinPad({
        title: 'Confirm PIN', sub: 'Enter the same PIN again.',
        onCancel: () => screenSetPin(firstTime),
        onDone: async (pin2) => {
          if (pin1 !== pin2) { toast('PINs did not match'); screenSetPin(firstTime); return; }
          try {
            await updateCafe({ pin_hash: await pinHash(pin1) });
            toast('PIN saved');
            if (firstTime) { S.ownerTab = 'settings'; screenOwner(); toast('Welcome! Set your rewards, then tap “Start game”.', 4000); }
            else screenOwner();
          } catch { toast('Could not save PIN, check internet'); screenSetPin(firstTime); }
        },
      });
    },
  });
}

function screenEnterPin() {
  pinPad({
    title: 'Owner PIN', sub: 'Enter the PIN to open the dashboard.',
    onCancel: () => screenWelcome(),
    extra: '<button class="btn ghost small" id="forgot">Forgot PIN?</button>',
    onDone: async (pin) => {
      if ((await pinHash(pin)) === S.cafe.pin_hash) { S.ownerTab = 'overview'; S.playsLoaded = false; screenOwner(); return true; }
      return false;
    },
  });
  $('#forgot').onclick = screenForgotPin;
}

function screenForgotPin() {
  render(`<div class="screen"><h2>Reset PIN</h2><p class="sub">Enter the account password for <b>${esc(S.session.user.email)}</b>.</p>
    <form class="form" id="f"><div class="field"><label>Password</label><input type="password" name="p" required></div>
    <div class="error" id="err"></div><button class="btn block">Continue</button>
    <button type="button" class="btn ghost block" id="back">Back</button></form></div>`);
  $('#back').onclick = screenWelcome;
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await sb.auth.signInWithPassword({ email: S.session.user.email, password: new FormData(e.target).get('p') });
    if (error) { $('#err').textContent = niceAuthError(error); return; }
    screenSetPin(false);
  };
}

// ---------------------------------------------------------------------------
// GAME MODE
// ---------------------------------------------------------------------------
function prizeChips() {
  const target = fmt(S.cafe.target_ms);
  return sortedTiers(S.cafe).map((t) => `<div class="prize">${t.margin_ms === 0 ? `Exactly <b>${target}</b>` : `Within <b>±${fmt(t.margin_ms)}s</b>`} → ${esc(t.reward)}</div>`).join('');
}

function screenWelcome() {
  S.player = null;
  const target = fmt(S.cafe.target_ms);
  render(`
  <div class="screen game-bg">
    <div class="offline-pill" id="offline-pill" hidden></div>
    <button class="corner" id="owner" aria-label="Owner">🔒</button>
    <div class="cafe-name">${esc(S.cafe.name)}</div>
    <div class="headline">Stop the timer at exactly <em>${target}</em></div>
    <p class="sub">${S.cafe.hide_after_ms > 0 ? `The clock disappears after ${fmt(S.cafe.hide_after_ms).replace(/\.00$/, '')} seconds. Trust your gut.` : 'Watch the clock and tap STOP at the perfect moment.'}</p>
    <div class="prizes">${prizeChips()}</div>
    <button class="btn play-btn" id="play">Play now</button>
  </div>`, 'game-bg');
  updateOfflinePill();
  $('#play').onclick = screenEntry;
  $('#owner').onclick = screenEnterPin;
}

function screenEntry() {
  render(`
  <div class="screen game-bg">
    <div class="cafe-name">${esc(S.cafe.name)}</div>
    <h1 style="font-size:40px">Who's playing?</h1>
    <form class="form" id="f" autocomplete="off">
      <div class="field"><label>Your name</label><input name="name" required maxlength="60" placeholder="Name"></div>
      <div class="field"><label>Mobile number</label><input name="phone" required inputmode="tel" maxlength="17" placeholder="10-digit mobile"></div>
      <p class="note" style="text-align:left;margin:0">Your name and number are saved by ${esc(S.cafe.name)} for this game and to give you your reward.</p>
      <label class="check"><input type="checkbox" name="consent" checked> Yes, ${esc(S.cafe.name)} can send me offers on SMS / WhatsApp.</label>
      <div class="error" id="err"></div>
      <button class="btn block" id="go">Continue</button>
      <button type="button" class="btn ghost block" id="back">Back</button>
    </form>
  </div>`, 'game-bg');
  later(screenWelcome, 120000); // walk-away reset
  $('#back').onclick = screenWelcome;
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const name = f.get('name').trim();
    const phone = normPhone(f.get('phone'));
    if (!name) return ($('#err').textContent = 'Please enter your name.');
    if (!/^[6-9]\d{9}$/.test(phone)) return ($('#err').textContent = 'Please enter a valid 10-digit mobile number.');
    $('#go').disabled = true;
    const n = await playsToday(phone);
    if (n >= (S.cafe.plays_per_day || 1)) {
      render(`<div class="screen game-bg"><div class="result-title">You've played today!</div>
        <p class="sub">${S.cafe.plays_per_day > 1 ? `That's all ${S.cafe.plays_per_day} tries for today.` : 'One try per day.'} Come back tomorrow for another shot.</p>
        <button class="btn" id="ok">OK</button></div>`, 'game-bg');
      $('#ok').onclick = screenWelcome;
      later(screenWelcome, 8000);
      return;
    }
    S.player = { name, phone, consent: !!f.get('consent') };
    screenPlay();
  };
}

function screenPlay() {
  const target = S.cafe.target_ms;
  const hideAfter = S.cafe.hide_after_ms;
  render(`
  <div class="screen game-bg">
    <div class="stage">
      <div class="target-label">${esc(S.player.name)}, stop at <b style="color:var(--accent)">${fmt(target)}</b></div>
      <div class="timer" id="t">0.00</div>
      <button class="big-tap" id="tap">START</button>
    </div>
  </div>`, 'game-bg');
  const t = $('#t'), tap = $('#tap');
  let start = 0, raf = 0, state = 'ready';
  const tick = () => {
    const el = performance.now() - start;
    if (hideAfter > 0 && el >= hideAfter) { t.textContent = '?.??'; t.classList.add('hidden-digits'); }
    else t.textContent = fmt(el);
    if (el > 60000) return finish(60000);
    raf = requestAnimationFrame(tick);
  };
  const finish = (elapsed) => {
    if (state !== 'running') return;
    state = 'done';
    cancelAnimationFrame(raf);
    const cs = Math.floor(elapsed / 10);           // what a stopwatch shows
    const timeMs = cs * 10;
    t.classList.remove('hidden-digits');
    t.textContent = fmt(timeMs);
    tap.disabled = true;
    setTimeout(() => recordResult(timeMs), 700);
  };
  tap.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (state === 'ready') {
      state = 'running';
      start = performance.now();
      tap.textContent = 'STOP'; tap.classList.add('stop');
      raf = requestAnimationFrame(tick);
    } else if (state === 'running') {
      finish(performance.now() - start);
    }
  });
}

function recordResult(timeMs) {
  const c = S.cafe;
  const diff = Math.abs(timeMs - c.target_ms);
  const tier = sortedTiers(c).find((t) => diff <= t.margin_ms) || null;
  const play = {
    id: uuid(),
    cafe_id: c.id,
    name: S.player.name,
    phone: S.player.phone,
    consent: S.player.consent,
    time_ms: timeMs,
    target_ms: c.target_ms,
    diff_ms: diff,
    tier_name: tier ? tier.name : null,
    reward: tier ? tier.reward : null,
    coupon_code: tier ? couponCode() : null,
    redeemed_at: null,
    played_at: new Date().toISOString(),
  };
  save(K.queue, [...queue(), play]);
  rememberPlay(play);
  flushQueue();
  screenResult(play);
}

function screenResult(p) {
  const win = !!p.reward;
  const off = p.diff_ms === 0 ? 'Bang on!' : `You were ${fmt(p.diff_ms)}s ${p.time_ms < p.target_ms ? 'early' : 'late'}.`;
  const secs = win ? 30 : 12;
  render(`
  <div class="screen game-bg">
    <div class="result-time ${win ? 'win' : ''}">${fmt(p.time_ms)}</div>
    <div class="result-title">${win ? esc(p.tier_name || 'You win!') : p.diff_ms <= 300 ? 'Soooo close!' : 'Nice try!'}</div>
    <p class="sub">${off}</p>
    ${win ? `<div class="coupon"><div class="reward">🎉 ${esc(p.reward)}</div><div class="code">${esc(p.coupon_code)}</div><div class="hint">Show this code at the counter</div></div>`
          : `<p class="sub">Come back tomorrow and try again.</p>`}
    <button class="btn ${win ? '' : 'ghost'}" id="done">Done</button>
    <div class="countdown" id="cd"></div>
  </div>`, 'game-bg');
  $('#done').onclick = screenWelcome;
  let left = secs;
  const step = () => { $('#cd').textContent = `Back to start in ${left}s`; if (left-- <= 0) return screenWelcome(); later(step, 1000); };
  step();
}

// ---------------------------------------------------------------------------
// OWNER MODE
// ---------------------------------------------------------------------------
async function loadPlays() {
  const all = [];
  for (let from = 0; from < 50000; from += 1000) {
    const { data, error } = await sb.from('plays').select('*').eq('cafe_id', S.cafe.id)
      .order('played_at', { ascending: false }).range(from, from + 999);
    if (error) throw error;
    all.push(...data);
    if (data.length < 1000) break;
  }
  // include plays still waiting to sync
  const ids = new Set(all.map((p) => p.id));
  for (const p of queue()) if (!ids.has(p.id)) all.unshift({ ...p, _pending: true });
  S.plays = all; S.playsLoaded = true;
}

function screenOwner() {
  const tabs = [['overview', 'Overview'], ['people', 'Participants'], ['rewards', 'Rewards'], ['settings', 'Settings']];
  render(`
  <div class="owner">
    <div class="topbar">
      <div class="title">${esc(S.cafe.name)} <span class="muted" style="font-weight:600;font-size:14px">· Owner</span></div>
      <button class="btn small ghost" id="refresh">Refresh</button>
      <button class="btn small" id="game">Start game ▶</button>
    </div>
    <div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${S.ownerTab === k ? 'active' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
    <div class="panel" id="panel"><div class="empty">Loading…</div></div>
  </div>`);
  $$('.tab').forEach((b) => (b.onclick = () => { S.ownerTab = b.dataset.tab; screenOwner(); }));
  $('#game').onclick = () => { flushQueue(); screenWelcome(); };
  $('#refresh').onclick = async () => { S.playsLoaded = false; await flushQueue(); screenOwner(); };
  renderTab();
}

async function renderTab() {
  const panel = $('#panel');
  const tab = S.ownerTab;
  if (tab === 'settings') return renderSettings(panel);
  if (!S.playsLoaded) {
    try { await loadPlays(); }
    catch { panel.innerHTML = `<div class="empty">Couldn't load data — the tablet seems to be offline.<br><br>${queue().length} play(s) are saved on this tablet and will upload automatically.</div>`; return; }
  }
  if (S.ownerTab !== tab || !document.body.contains(panel)) return;
  if (tab === 'overview') renderOverview(panel);
  if (tab === 'people') renderPeople(panel);
  if (tab === 'rewards') renderRewards(panel);
}

function customers(plays) {
  const m = new Map();
  for (const p of plays) {
    let c = m.get(p.phone);
    if (!c) { c = { phone: p.phone, name: p.name, plays: 0, wins: 0, best: Infinity, last: p.played_at, first: p.played_at, consent: false, days: new Set() }; m.set(p.phone, c); }
    c.plays++; if (p.reward) c.wins++;
    c.best = Math.min(c.best, p.diff_ms);
    if (p.played_at > c.last) { c.last = p.played_at; c.name = p.name; }
    if (p.played_at < c.first) c.first = p.played_at;
    c.consent = c.consent || p.consent;
    c.days.add(dayKey(p.played_at));
  }
  return [...m.values()].sort((a, b) => (a.last < b.last ? 1 : -1));
}

function renderOverview(panel) {
  const P = S.plays;
  const today = startOfToday();
  const cust = customers(P);
  const won = P.filter((p) => p.reward);
  const redeemed = won.filter((p) => p.redeemed_at);
  const days = [];
  for (let i = 6; i >= 0; i--) { const d = new Date(today); d.setDate(d.getDate() - i); days.push({ k: dayKey(d), l: d.toLocaleDateString('en-IN', { weekday: 'short' }), n: 0 }); }
  for (const p of P) { const d = days.find((x) => x.k === dayKey(p.played_at)); if (d) d.n++; }
  const max = Math.max(1, ...days.map((d) => d.n));
  const best = P.filter((p) => new Date(p.played_at) >= today).sort((a, b) => a.diff_ms - b.diff_ms)[0];
  const pending = queue().length;
  const stat = (n, l) => `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`;
  panel.innerHTML = `
    ${pending ? `<div class="box" style="border-color:var(--accent)"><b>${pending} play(s) waiting to upload</b><span class="note">They are saved on this tablet and will sync when the internet is back.</span></div>` : ''}
    <div class="cards">
      ${stat(P.length, 'Total plays')}
      ${stat(P.filter((p) => new Date(p.played_at) >= today).length, 'Plays today')}
      ${stat(cust.length, 'Customers collected')}
      ${stat(cust.filter((c) => c.consent).length, 'Agreed to offers')}
      ${stat(cust.filter((c) => c.days.size > 1).length, 'Came back (2+ days)')}
      ${stat(won.length, 'Rewards won')}
      ${stat(redeemed.length, 'Rewards redeemed')}
      ${stat(P.length ? Math.round((won.length / P.length) * 100) + '%' : '—', 'Win rate')}
    </div>
    <div class="box"><h3>Plays — last 7 days</h3>
      <div class="bar-chart">${days.map((d) => `<div class="b"><em>${d.n || ''}</em><i style="height:${(d.n / max) * 100}%"></i><span>${d.l}</span></div>`).join('')}</div>
    </div>
    <div class="box"><h3>Today's closest</h3>
      ${best ? `<div class="row"><div class="grow"><b>${esc(best.name)}</b> <span class="muted">· ${esc(best.phone)}</span></div><div style="font-size:28px;font-weight:900">${fmt(best.time_ms)}</div></div>` : '<span class="muted">No plays yet today.</span>'}
    </div>`;
}

function renderPeople(panel) {
  const cust = customers(S.plays);
  panel.innerHTML = `
    <div class="row">
      <input class="search grow" id="q" placeholder="Search name or number">
      <button class="btn small" id="expC">Export customers</button>
      <button class="btn small ghost" id="expP">Export all plays</button>
    </div>
    <div class="note">${cust.length} customers · ${S.plays.length} plays</div>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Mobile</th><th>Plays</th><th>Best</th><th>Wins</th><th>Offers OK</th><th>Last played</th></tr></thead>
      <tbody id="tb"></tbody></table></div>`;
  const draw = () => {
    const q = $('#q').value.trim().toLowerCase();
    const rows = cust.filter((c) => !q || c.name.toLowerCase().includes(q) || c.phone.includes(q));
    $('#tb').innerHTML = rows.length ? rows.map((c) => `<tr>
      <td><b>${esc(c.name)}</b></td><td>${esc(c.phone)}</td><td>${c.plays}</td>
      <td>±${fmt(c.best)}s</td><td>${c.wins ? `<span class="tag win">${c.wins}</span>` : '0'}</td>
      <td>${c.consent ? '✅' : '—'}</td><td>${fmtDateTime(c.last)}</td></tr>`).join('')
      : `<tr><td colspan="7" class="empty">No customers yet.</td></tr>`;
  };
  $('#q').oninput = draw; draw();
  $('#expC').onclick = () => exportCsv(`customers-${dayKey(new Date())}.csv`,
    ['Name', 'Mobile', 'Plays', 'Days visited', 'Wins', 'Best (seconds off)', 'Agreed to offers', 'First played', 'Last played'],
    cust.map((c) => [c.name, c.phone, c.plays, c.days.size, c.wins, fmt(c.best), c.consent ? 'Yes' : 'No', new Date(c.first).toLocaleString('en-IN'), new Date(c.last).toLocaleString('en-IN')]));
  $('#expP').onclick = () => exportCsv(`plays-${dayKey(new Date())}.csv`,
    ['Played at', 'Name', 'Mobile', 'Time', 'Target', 'Off by', 'Result', 'Reward', 'Coupon', 'Redeemed at', 'Agreed to offers'],
    S.plays.map((p) => [new Date(p.played_at).toLocaleString('en-IN'), p.name, p.phone, fmt(p.time_ms), fmt(p.target_ms), fmt(p.diff_ms), p.tier_name || 'No win', p.reward || '', p.coupon_code || '', p.redeemed_at ? new Date(p.redeemed_at).toLocaleString('en-IN') : '', p.consent ? 'Yes' : 'No']));
}

function renderRewards(panel) {
  const won = S.plays.filter((p) => p.reward);
  panel.innerHTML = `
    <div class="box"><h3>Redeem a coupon</h3>
      <div class="row"><input class="search grow" id="code" placeholder="Enter coupon code, e.g. K7M2QX" style="text-transform:uppercase;font-size:20px;letter-spacing:.1em">
      <button class="btn" id="find">Redeem</button></div>
      <div id="found"></div>
    </div>
    <div class="row">
      <input class="search grow" id="q" placeholder="Search name, number or code">
      <select class="search" id="flt" style="width:auto"><option value="all">All</option><option value="open">Not redeemed</option><option value="used">Redeemed</option></select>
    </div>
    <div class="note" id="rcount"></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Code</th><th>Reward</th><th>Name</th><th>Mobile</th><th>Time</th><th>Won</th><th>Status</th><th></th></tr></thead>
      <tbody id="tb"></tbody></table></div>`;
  const draw = () => {
    $('#rcount').textContent = `${won.length} rewards won · ${won.filter((p) => p.redeemed_at).length} redeemed`;
    const q = $('#q').value.trim().toLowerCase(), f = $('#flt').value;
    const rows = won.filter((p) => (f === 'all' || (f === 'used') === !!p.redeemed_at) &&
      (!q || p.name.toLowerCase().includes(q) || p.phone.includes(q) || (p.coupon_code || '').toLowerCase().includes(q)));
    $('#tb').innerHTML = rows.length ? rows.map((p) => `<tr>
      <td><b style="letter-spacing:.08em">${esc(p.coupon_code)}</b></td><td>${esc(p.reward)}</td><td>${esc(p.name)}</td><td>${esc(p.phone)}</td>
      <td>${fmt(p.time_ms)}</td><td>${fmtDateTime(p.played_at)}</td>
      <td>${p.redeemed_at ? `<span class="tag used">Redeemed ${fmtDateTime(p.redeemed_at)}</span>` : '<span class="tag open">Open</span>'}</td>
      <td>${p.redeemed_at ? '' : `<button class="btn small" data-redeem="${p.id}">Redeem</button>`}</td></tr>`).join('')
      : `<tr><td colspan="8" class="empty">No rewards yet.</td></tr>`;
    $$('[data-redeem]').forEach((b) => (b.onclick = () => redeem(S.plays.find((p) => p.id === b.dataset.redeem))));
  };
  const redeem = async (p) => {
    if (!p) return;
    if (p._pending) { toast('This play is still uploading — try again in a moment'); return; }
    const at = new Date().toISOString();
    const { data, error } = await sb.from('plays').update({ redeemed_at: at }).eq('id', p.id).is('redeemed_at', null).select();
    if (error) { toast('Could not redeem — check internet'); return; }
    if (!data.length) { toast('Already redeemed'); S.playsLoaded = false; return renderTab(); }
    p.redeemed_at = at;
    toast(`Redeemed: ${p.reward} for ${p.name}`);
    $('#found').innerHTML = ''; $('#code').value = '';
    draw();
  };
  $('#find').onclick = () => {
    const code = $('#code').value.trim().toUpperCase();
    const p = won.find((x) => x.coupon_code === code);
    const out = $('#found');
    if (!p) { out.innerHTML = `<span class="error">No coupon with code ${esc(code)}.</span>`; return; }
    if (p.redeemed_at) { out.innerHTML = `<span class="error">Already redeemed on ${fmtDateTime(p.redeemed_at)} (${esc(p.reward)}, ${esc(p.name)}).</span>`; return; }
    redeem(p);
  };
  $('#q').oninput = draw; $('#flt').onchange = draw; draw();
}

function renderSettings(panel) {
  const c = S.cafe;
  let tiers = sortedTiers(c).map((t) => ({ ...t }));
  panel.innerHTML = `
    <div class="box"><h3>Game</h3>
      <div class="grid2">
        <div class="field"><label>Cafe name (shown on the game)</label><input id="name" maxlength="60" value="${esc(c.name)}"></div>
        <div class="field"><label>Target time (seconds)</label><input id="target" type="number" inputmode="decimal" step="0.01" min="1" max="60" value="${fmt(c.target_ms)}"></div>
        <div class="field"><label>Hide the clock after (seconds, 0 = never)</label><input id="hide" type="number" inputmode="decimal" step="0.5" min="0" max="60" value="${c.hide_after_ms / 1000}"></div>
        <div class="field"><label>Plays per person per day</label><input id="ppd" type="number" inputmode="numeric" min="1" max="20" value="${c.plays_per_day}"></div>
      </div>
    </div>
    <div class="box"><h3>Rewards</h3>
      <p class="note">The closest tier wins. “Margin ±” is how far from the target still counts — 0 means exactly on target, 0.10 means anywhere from ${fmt(c.target_ms - 100)} to ${fmt(c.target_ms + 100)}.</p>
      <div id="tiers" style="display:flex;flex-direction:column;gap:12px"></div>
      <div><button class="btn small ghost" id="addTier">+ Add reward tier</button></div>
    </div>
    <div class="row"><button class="btn" id="save">Save settings</button><span class="error" id="err"></span></div>
    <div class="box"><h3>Security & tablet</h3>
      <div class="row"><button class="btn small ghost" id="pin">Change owner PIN</button><button class="btn small danger" id="logout">Log out of this tablet</button></div>
      <p class="note">Signed in as ${esc(S.session?.user?.email || '')}. Install the app on your own phone and log in with the same account to see your data from anywhere.</p>
      <p class="note"><b>Lock the tablet to the game:</b> Android Settings → Security → <i>App pinning</i> (or “Screen pinning”) → turn on. Open Stop@10, tap the Recents button, tap the app icon and choose <i>Pin</i>. Customers can't leave the game until it's unpinned.</p>
    </div>`;
  const drawTiers = () => {
    $('#tiers').innerHTML = tiers.map((t, i) => `
      <div class="tier-row">
        <div class="field"><label>Title</label><input data-i="${i}" data-k="name" value="${esc(t.name)}" maxlength="30" placeholder="Perfect!"></div>
        <div class="field"><label>Margin ± (sec)</label><input data-i="${i}" data-k="margin" type="number" step="0.01" min="0" max="5" value="${fmt(t.margin_ms)}"></div>
        <div class="field"><label>Reward</label><input data-i="${i}" data-k="reward" value="${esc(t.reward)}" maxlength="60" placeholder="Free coffee"></div>
        <button class="btn small ghost" data-del="${i}" title="Remove">✕</button>
      </div>`).join('') || '<span class="muted">No rewards — nobody can win. Add a tier.</span>';
    $$('#tiers input').forEach((inp) => (inp.oninput = () => {
      const t = tiers[+inp.dataset.i];
      if (inp.dataset.k === 'margin') t.margin_ms = Math.round(parseFloat(inp.value || '0') * 1000);
      else t[inp.dataset.k] = inp.value;
    }));
    $$('[data-del]').forEach((b) => (b.onclick = () => { tiers.splice(+b.dataset.del, 1); drawTiers(); }));
  };
  drawTiers();
  $('#addTier').onclick = () => { if (tiers.length >= 6) return toast('Up to 6 tiers'); tiers.push({ name: 'Nice!', margin_ms: 250, reward: '' }); drawTiers(); };
  $('#save').onclick = async () => {
    const err = $('#err'); err.textContent = '';
    const target = Math.round(parseFloat($('#target').value) * 1000);
    const hide = Math.round(parseFloat($('#hide').value || '0') * 1000);
    const ppd = parseInt($('#ppd').value, 10);
    const name = $('#name').value.trim();
    if (!name) return (err.textContent = 'Enter a cafe name.');
    if (!(target >= 1000 && target <= 60000)) return (err.textContent = 'Target must be between 1 and 60 seconds.');
    if (!(hide >= 0 && hide <= 60000)) return (err.textContent = 'Hide time must be 0–60 seconds.');
    if (!(ppd >= 1 && ppd <= 20)) return (err.textContent = 'Plays per day must be 1–20.');
    const clean = tiers.map((t) => ({ name: (t.name || '').trim() || 'Winner!', margin_ms: Math.max(0, Math.min(5000, Math.round(t.margin_ms / 10) * 10 || 0)), reward: (t.reward || '').trim() }));
    if (clean.some((t) => !t.reward)) return (err.textContent = 'Every tier needs a reward.');
    $('#save').disabled = true;
    try {
      await updateCafe({ name, target_ms: Math.round(target / 10) * 10, hide_after_ms: hide, plays_per_day: ppd, tiers: clean.sort((a, b) => a.margin_ms - b.margin_ms) });
      toast('Settings saved');
      screenOwner();
    } catch { err.textContent = 'Could not save — check internet.'; $('#save').disabled = false; }
  };
  $('#pin').onclick = () => screenSetPin(false);
  $('#logout').onclick = async () => {
    if (queue().length) { toast(`${queue().length} play(s) haven't uploaded yet. Connect to internet first.`, 4000); return; }
    await sb.auth.signOut().catch(() => {});
    S.cafe = null; S.plays = []; S.playsLoaded = false;
    save(K.cafe, null); save(K.recent, []);
    screenAuth();
  };
}

async function exportCsv(filename, header, rows) {
  const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = '﻿' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  if (IS_NATIVE) {
    try {
      const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
      const { Share } = await import('@capacitor/share');
      const res = await Filesystem.writeFile({ path: filename, data: csv, directory: Directory.Cache, encoding: Encoding.UTF8 });
      await Share.share({ title: filename, files: [res.uri], dialogTitle: 'Send or save the export' });
    } catch (e) { if (!/cancel/i.test(String(e?.message))) toast('Export failed: ' + (e?.message || e)); }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = filename; document.body.appendChild(a); a.click(); a.remove();
}

// expose for automated tests only
window.__s10 = { S, fmt, normPhone, sortedTiers };

boot();
