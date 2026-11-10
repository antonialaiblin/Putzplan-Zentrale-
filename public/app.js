import { EN, tr } from './i18n.js';

const $ = (s) => document.querySelector(s);
const addDays = (s, n) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* egal */ } },
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  me: store.get('me'),
  lang: store.get('lang') === 'en' ? 'en' : 'de',
  people: [],
  current: null,
  view: null,
  weeks: new Map(), // monday -> week
};

// ---------------- Sprache ----------------
/** L('Deutsch', 'English') */
const L = (de, en) => (state.lang === 'en' ? en : de);
/** Texte vom Server (Aufgaben, Kategorien, Fehlermeldungen) übersetzen */
const T = (s) => tr(s, state.lang);
const locale = () => (state.lang === 'en' ? 'en-GB' : 'de-DE');
const MON_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ddmm = (s) => (state.lang === 'en' ? `${+s.slice(8, 10)} ${MON_EN[+s.slice(5, 7) - 1]}` : `${s.slice(8, 10)}.${s.slice(5, 7)}.`);
const WD = { de: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'], en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] };
const wd = (s) => WD[state.lang][new Date(`${s}T12:00:00Z`).getUTCDay()];
const atTime = (t) => (t ? L(` um ${t}`, ` at ${t}`) : '');
const clock = (t) => L(`${t} Uhr`, t);
const cleanerWhen = (w) => `${wd(w.cleanerDay)} ${ddmm(w.cleanerDay)}${atTime(w.cleanerTime)}`;
const fmtDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString(locale(), { weekday: 'short', day: '2-digit', month: state.lang === 'en' ? 'short' : '2-digit', timeZone: 'UTC' });

// Feste Texte in index.html: deutsches Original merken und je nach Sprache austauschen
const ORIG = new WeakMap();
function translateStatic() {
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const orig = ORIG.get(n) ?? n.nodeValue;
    const key = orig.trim();
    if (!key || EN[key] === undefined) continue;
    ORIG.set(n, orig);
    const want = state.lang === 'en' ? orig.replace(key, EN[key]) : orig;
    if (n.nodeValue !== want) n.nodeValue = want;
  }
  for (const el of document.body.querySelectorAll('[placeholder],[aria-label],[title]')) {
    for (const a of ['placeholder', 'aria-label', 'title']) {
      if (!el.hasAttribute(a)) continue;
      const orig = el.getAttribute(`data-de-${a}`) ?? el.getAttribute(a);
      if (EN[orig] === undefined) continue;
      el.setAttribute(`data-de-${a}`, orig);
      el.setAttribute(a, state.lang === 'en' ? EN[orig] : orig);
    }
  }
}
function setLang(lang, { rerender = true } = {}) {
  state.lang = lang === 'en' ? 'en' : 'de';
  store.set('lang', state.lang);
  document.documentElement.lang = state.lang;
  translateStatic();
  if (rerender) {
    render();
    renderShop();
    renderMoney();
    renderEvForm();
  }
}
/** Sprache des gewählten Mitglieds übernehmen */
function syncLang() {
  const m = (state.members || []).find((x) => x.name === state.me);
  const want = m?.lang || state.lang;
  if (want !== state.lang || document.documentElement.lang !== want) setLang(want, { rerender: false });
}

async function api(path, body) {
  const res = await fetch(`/api/${path}`, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(T(data.error) || L(`Fehler ${res.status}`, `Error ${res.status}`));
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2800);
}

// ---------------- Profil-Helfer ----------------
const memberOf = (name) => (state.members || []).find((x) => x.name === name);
/** Rundes Profilbild oder Anfangsbuchstabe */
function avatar(name, cls = '') {
  const m = memberOf(name);
  return m?.photo
    ? `<span class="avatar ${cls}"><img src="/api/photo/${encodeURIComponent(name)}?v=${m.photo}" alt="" loading="lazy"></span>`
    : `<span class="avatar ${cls}" aria-hidden="true">${esc((name || '?').slice(0, 1).toUpperCase())}</span>`;
}
/** Gegenderte Wörter: G(name, 'weiblich', 'männlich', 'divers') */
const G = (name, w, m, d) => ({ w, m }[memberOf(name)?.gender] ?? d);

// ---------------- Laden ----------------
async function load() {
  const data = await api('weeks?count=12');
  state.people = data.people;
  state.members = data.members;
  state.absences = data.absences;
  state.events = data.events || [];
  state.polls = data.polls || [];
  state.cleanerContact = data.cleanerContact || null;
  state.today = data.today;
  state.current = data.current;
  if (state.me && !state.people.includes(state.me)) { state.me = null; store.set('me', ''); }
  for (const w of data.weeks) state.weeks.set(w.monday, w);
  if (!state.view || !state.weeks.has(state.view)) state.view = state.current;
  syncLang();
  render();
  const me = memberOf(state.me);
  if (me && (!me.birthday || !me.gender) && !state.askedProfile && !$('#profile-dialog').open) {
    state.askedProfile = true;
    openProfile(true);
  }
}
async function ensureWeek(monday) {
  if (!state.weeks.has(monday)) {
    const data = await api(`weeks?from=${monday}&count=1`);
    state.weeks.set(monday, data.weeks[0]);
  }
}

// ---------------- Rendern ----------------
function render() {
  renderMe();
  renderHome();
  renderCal();
  renderWeek();
  renderUpcoming();
  renderNotify();
}

function renderMe() {
  const pick = $('#pick-me');
  const joining = location.hash === '#beitreten' || state.joining;
  $('#join').hidden = !joining;
  pick.hidden = !!state.me || joining;
  $('#who-line').textContent = state.me ? L(`Hallo ${state.me} 👋`, `Hi ${state.me} 👋`) : 'Mission Haussegen';
  $('#people-buttons').innerHTML = state.people.map((p) => `<button data-me="${esc(p)}">${avatar(p, 'sm')}${esc(p)}</button>`).join('');
  // Sprachknopf oben nur, solange noch niemand ausgewählt ist (sonst in den Einstellungen)
  const quick = $('#lang-quick');
  quick.hidden = !!state.me;
  quick.textContent = state.lang === 'en' ? '🇩🇪 Deutsch' : '🇬🇧 English';
  $('#set-me').innerHTML = state.me ? `${avatar(state.me)} ${L(`Du bist <strong>${esc(state.me)}</strong>`, `You are <strong>${esc(state.me)}</strong>`)}` : '';
  document.querySelectorAll('#set-lang [data-lang]').forEach((b) => b.setAttribute('aria-checked', b.dataset.lang === state.lang));
  $('#settings').hidden = !state.me;
}

function weekTitle(monday) {
  const diff = Math.round((Date.parse(monday) - Date.parse(state.current)) / (7 * 86400000));
  if (diff === 0) return L('Diese Woche', 'This week');
  if (diff === 1) return L('Nächste Woche', 'Next week');
  if (diff === -1) return L('Letzte Woche', 'Last week');
  return diff > 0 ? L(`In ${diff} Wochen`, `In ${diff} weeks`) : L(`Vor ${-diff} Wochen`, `${-diff} weeks ago`);
}

function renderWeek() {
  const w = state.weeks.get(state.view);
  if (!w) return;
  $('#week-title').textContent = weekTitle(w.monday);
  $('#week-range').textContent = `${ddmm(w.monday)} – ${ddmm(w.sunday)}`;

  let html = '';
  const contact = state.cleanerContact;
  const contactLine = `<p class="muted small">${L('Zuständig für die Putzkraft', 'In charge of the cleaner')}: <strong>${contact ? esc(contact) : L('niemand', 'nobody')}</strong>
    <button class="link" data-cleaner-contact>${L('ändern', 'change')}</button></p>`;
  if (w.plannedCleaner) {
    const isContact = state.me && state.me === contact;
    html += `<div class="banner"><p>${w.ausfall
      ? L('⚠️ <strong>Putzkraft fällt aus.</strong> Diese Woche putzen wir selbst (Intensivputz). Ab nächster Woche ist der Plan eine Woche später dran.',
        "⚠️ <strong>Cleaner cancelled.</strong> This week we clean ourselves (deep clean). From next week the rota moves back one week.")
      : L(`🧹 <strong>Putzkraft kommt ${cleanerWhen(w)}</strong>${w.cleanerConfirmed ? ' ✓' : ' <span class="muted">(laut Plan, noch nicht bestätigt)</span>'} und putzt Bäder, Böden und Müll.`,
        `🧹 <strong>The cleaner comes ${cleanerWhen(w)}</strong>${w.cleanerConfirmed ? ' ✓' : ' <span class="muted">(as planned, not confirmed yet)</span>'} and cleans bathrooms, floors and bins.`)}</p>
      ${isContact && !w.ausfall && !w.cleanerConfirmed ? `<p class="small">${L('<strong>Du stimmst die Termine mit der Putzkraft ab:</strong> Kommt sie diese Woche? Dann trag bitte Tag und Uhrzeit ein.', '<strong>You arrange the dates with the cleaner:</strong> Is she coming this week? Then please enter the day and time.')}</p>` : ''}
      <div class="row">${w.ausfall ? '' : `<button class="link" data-cleaner-visit>${w.cleanerConfirmed ? L('Termin ändern', 'Change date') : L('Tag & Uhrzeit eintragen', 'Enter day & time')}</button>`}
      <button class="link" data-ausfall="${w.ausfall ? 0 : 1}">${w.ausfall ? L('Doch nicht ausgefallen', 'Not cancelled after all') : L('Putzkraft fällt aus?', 'Cleaner cancelled?')}</button></div>
      ${contactLine}</div>`;
  } else {
    html += `<div class="banner"><p>${L('🫧 <strong>Woche ohne Putzkraft.</strong> Wir putzen selbst.', '🫧 <strong>Week without the cleaner.</strong> We clean ourselves.')}</p>${contactLine}</div>`;
  }

  if (w.away && w.away.length) {
    const names = `<strong>${w.away.map(esc).join(', ')}</strong>`;
    html += `<div class="banner"><p>🏖️ ${L(`${names} ${w.away.length > 1 ? 'sind' : 'ist'} diese Woche weg und wurde${w.away.length > 1 ? 'n' : ''} im Plan übersprungen.`,
      `${names} ${w.away.length > 1 ? 'are' : 'is'} away this week and ${w.away.length > 1 ? 'were' : 'was'} skipped on the rota.`)}</p></div>`;
  }
  const tasks = [...w.tasks].sort((a, b) => (b.person === state.me) - (a.person === state.me));
  for (const t of tasks) {
    const items = t.items;
    const doneCount = items.filter((it) => w.checks[`${t.key}:${it.id}`]).length;
    const mine = t.person === state.me || items.some((it) => it.person === state.me);
    const complete = items.length > 0 && doneCount === items.length;
    html += `<article class="card task${mine ? ' mine' : ''}${complete ? ' complete' : ''}">
      <header><h3>${esc(T(t.title))}</h3>${t.person ? `<span class="person">${esc(t.person)}${t.person !== t.planned ? ` <span class="swapped">(${L('statt', 'instead of')} ${esc(t.planned)})</span>` : ''}</span>` : `<span class="muted small">${doneCount}/${items.length}</span>`}</header>
      ${t.note ? `<p class="note">${esc(T(t.note))}</p>` : ''}
      ${items.map((it) => {
        const key = `${t.key}:${it.id}`;
        const c = w.checks[key];
        return `<label class="check${c ? ' done' : ''}"><input type="checkbox" data-check="${esc(key)}" ${c ? 'checked' : ''}>
          <span>${esc(T(it.label))}${c?.by ? `<small>${L('erledigt von', 'done by')} ${esc(c.by)}</small>` : ''}</span></label>`;
      }).join('')}
      ${t.person ? `<div class="actions"><button class="ghost small" data-swap="${t.key}">${L('Tauschen', 'Swap')}</button></div>` : ''}
    </article>`;
  }
  $('#week').innerHTML = html;
}

function renderUpcoming() {
  const rows = [];
  for (let i = 0; i < 10; i++) {
    const w = state.weeks.get(addDays(state.current, i * 7));
    if (!w) continue;
    const p = (key) => {
      const t = w.tasks.find((x) => x.key === key);
      if (!t || !t.person) return '–';
      const name = esc(t.person);
      return t.person === state.me ? `<span class="me">${name}</span>` : name;
    };
    rows.push(`<tr class="${i === 0 ? 'current' : ''}${w.cleaner ? ' pk' : ''}"><td>${ddmm(w.monday)}</td>
      <td>${w.plannedCleaner ? (w.ausfall ? L('fällt aus', 'cancelled') : wd(w.cleanerDay)) : '–'}</td>
      <td>${p('woche')}</td><td>${p('bad-vorne')}</td><td>${p('bad-hinten')}</td></tr>`);
  }
  $('#upcoming').innerHTML = rows.join('');
}

// ---------------- Erinnerungen (Push) ----------------
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function currentSubscription() {
  if (!pushSupported) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/** Im Putzplan kurz darauf hinweisen, wenn die Erinnerungen noch aus sind */
function nudge(on) {
  $('#notify-nudge').innerHTML = on && state.me
    ? `<div class="banner"><p>🔔 ${L('Erinnerungen sind noch aus.', 'Reminders are still off.')}</p><button class="link" data-open-settings>${L('In den Einstellungen einschalten', 'Turn on in settings')}</button></div>`
    : '';
}

async function renderNotify() {
  const box = $('#notify');
  const body = $('#notify-body');
  if (!state.me) { box.hidden = true; nudge(false); return; }
  box.hidden = false;

  if (!pushSupported) {
    if (isIOS && !isStandalone) {
      body.innerHTML = L(`<h3>🔔 Erinnerungen aufs iPhone</h3>
        <p>Damit dein iPhone dich erinnern kann, musst du die Seite einmal zum Home-Bildschirm hinzufügen:</p>
        <ol class="steps"><li>Unten in Safari auf <strong>Teilen</strong> tippen (Viereck mit Pfeil).</li>
        <li><strong>Zum Home-Bildschirm</strong> wählen und hinzufügen.</li>
        <li>Die App vom Home-Bildschirm öffnen und hier auf „Erinnerungen aktivieren“ tippen.</li></ol>`,
      `<h3>🔔 Reminders on your iPhone</h3>
        <p>For your iPhone to remind you, add this page to your home screen once:</p>
        <ol class="steps"><li>In Safari, tap <strong>Share</strong> at the bottom (square with an arrow).</li>
        <li>Choose <strong>Add to Home Screen</strong>.</li>
        <li>Open the app from your home screen and tap "Turn on reminders" here.</li></ol>`);
      nudge(true);
    } else {
      body.innerHTML = L('<h3>🔔 Erinnerungen</h3><p class="muted">Dieser Browser kann leider keine Erinnerungen empfangen. Probier es mit Chrome, Firefox, Edge oder Safari.</p>',
        "<h3>🔔 Reminders</h3><p class=\"muted\">Sorry, this browser can't receive reminders. Try Chrome, Firefox, Edge or Safari.</p>");
      nudge(false);
    }
    return;
  }

  const sub = await currentSubscription();
  if (sub) {
    // Server-Zuordnung aktuell halten (z.B. nach "Mitglied wechseln")
    api('subscribe', { person: state.me, subscription: sub.toJSON() }).catch(() => {});
    body.innerHTML = `<div class="row" style="justify-content:space-between">
      <p style="margin:0">🔔 <strong>${L('Erinnerungen sind an.', 'Reminders are on.')}</strong><br><span class="muted small">${L('Sonntag 19 Uhr für die neue Woche, Freitag 18 Uhr falls noch was offen ist.', 'Sunday 7 pm for the new week, Friday 6 pm if something is still open.')}</span></p>
      <div class="row"><button class="ghost small" id="test-push">Test</button><button class="link" id="push-off">${L('Ausschalten', 'Turn off')}</button></div></div>`;
    $('#test-push').onclick = async () => {
      try { await api('test', { endpoint: sub.endpoint }); toast(L('Test-Nachricht ist unterwegs', 'Test notification is on its way')); } catch (e) { toast(e.message); }
    };
    $('#push-off').onclick = async () => {
      await api('unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
      renderNotify();
    };
    nudge(false);
    return;
  }

  if (Notification.permission === 'denied') {
    body.innerHTML = L('<h3>🔔 Erinnerungen blockiert</h3><p class="muted">Du hast Benachrichtigungen für diese Seite abgelehnt. Erlaube sie in den Einstellungen deines Browsers bzw. Handys und lade die Seite neu.</p>',
      '<h3>🔔 Reminders blocked</h3><p class="muted">You blocked notifications for this page. Allow them in your browser or phone settings and reload the page.</p>');
    nudge(false);
    return;
  }
  body.innerHTML = `<h3>🔔 ${L('Erinnerungen bekommen', 'Get reminders')}</h3>
    <p>${L('Sonntagabend siehst du, was in der neuen Woche ansteht. Wenn am Freitag noch etwas nicht abgehakt ist, kommt eine kurze Erinnerung.', "On Sunday evening you'll see what's coming up in the new week. If something isn't ticked off by Friday, you'll get a short reminder.")}</p>
    <button id="push-on">${L('Erinnerungen aktivieren', 'Turn on reminders')}</button>`;
  $('#push-on').onclick = enablePush;
  nudge(true);
  if (!state.settingsOpened) { state.settingsOpened = true; $('#settings').open = true; }
}

async function enablePush() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { renderNotify(); return; }
    const { publicKey } = await api('vapid');
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
    await api('subscribe', { person: state.me, subscription: sub.toJSON() });
    toast(L('Erinnerungen sind an 🎉', 'Reminders are on 🎉'));
  } catch (e) {
    toast(L(`Hat nicht geklappt: ${e.message}`, `That didn't work: ${e.message}`));
  }
  renderNotify();
}

// ---------------- Events ----------------
document.addEventListener('click', async (e) => {
  const meBtn = e.target.closest('[data-me]');
  if (meBtn && meBtn.closest('#people-buttons')) {
    state.me = meBtn.dataset.me;
    store.set('me', state.me);
    syncLang();
    render();
    if (state.money) renderMoney();
    renderShop();
    return;
  }
  if (e.target.closest('[data-open-settings]')) {
    location.hash = '#start';
    setTimeout(() => { $('#settings').open = true; $('#settings').scrollIntoView({ behavior: 'smooth' }); }, 50);
    return;
  }
  const swapBtn = e.target.closest('[data-swap]');
  if (swapBtn) { openSwap(swapBtn.dataset.swap); return; }

  if (e.target.closest('[data-cleaner-visit]')) { openCleanerVisit(); return; }
  if (e.target.closest('[data-cleaner-contact]')) { openCleanerContact(); return; }
  const ausfall = e.target.closest('[data-ausfall]');
  if (ausfall) {
    const value = ausfall.dataset.ausfall === '1';
    const msg = value
      ? L('Putzkraft fällt diese Woche aus?\n\nDann putzen wir diese Woche selbst (Küche, Flure, Bäder), ab nächster Woche rutscht der ganze Plan um eine Woche, und alle bekommen sofort eine Nachricht.',
        'Is the cleaner cancelled this week?\n\nThen we clean ourselves this week (kitchen, hallways, bathrooms), from next week the whole rota moves back one week, and everyone gets a notification right away.')
      : L('Doch nicht ausgefallen? Der Plan rutscht dann wieder zurück.', 'Not cancelled after all? The rota then moves back again.');
    if (!confirm(msg)) return;
    try {
      await api('ausfall', { monday: state.view, value });
      state.weeks.clear(); // alle folgenden Wochen ändern sich
      await load();
      await ensureWeek(state.view);
      renderWeek();
      toast(value ? L('Eingetragen, alle wurden benachrichtigt', 'Saved, everyone has been notified') : L('Zurückgenommen', 'Undone'));
    } catch (err) { toast(err.message); }
  }
});

$('#change-me').onclick = () => {
  state.me = null;
  render();
  window.scrollTo(0, 0);
};
$('#lang-quick').onclick = () => setLang(state.lang === 'en' ? 'de' : 'en');
$('#set-lang').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-lang]');
  if (!b || b.dataset.lang === state.lang) return;
  setLang(b.dataset.lang);
  if (!state.me) return;
  try {
    const r = await api('members/lang', { name: state.me, lang: state.lang });
    state.members = r.members;
    renderHome();
    toast(L('Sprache gespeichert, auch für deine Erinnerungen', 'Language saved, also for your reminders'));
  } catch (err) { toast(err.message); }
});

document.addEventListener('change', async (e) => {
  const key = e.target.dataset?.check;
  if (!key) return;
  const done = e.target.checked;
  e.target.closest('.check').classList.toggle('done', done);
  try {
    const w = await api('check', { monday: state.view, key, done, by: state.me });
    state.weeks.set(w.monday, w);
    renderWeek();
    if (done) toast(L('Super, danke! ✨', 'Great, thanks! ✨'));
  } catch (err) {
    e.target.checked = !done;
    toast(L(`Konnte nicht speichern: ${err.message}`, `Could not save: ${err.message}`));
  }
});

$('#prev').onclick = () => go(-7);
$('#next').onclick = () => go(7);
async function go(days) {
  const target = addDays(state.view, days);
  try {
    await ensureWeek(target);
    state.view = target;
    renderWeek();
  } catch (e) { toast(e.message); }
}

function openSwap(taskKey) {
  const w = state.weeks.get(state.view);
  const t = w.tasks.find((x) => x.key === taskKey);
  $('#swap-title').textContent = L(`${t.title} tauschen`, `Swap: ${T(t.title)}`);
  $('#swap-text').textContent = L(`Wer übernimmt diese Woche (${ddmm(w.monday)} – ${ddmm(w.sunday)}) statt ${t.person}? Sagt am besten auch kurz in der WG-Gruppe Bescheid.`,
    `Who takes over this week (${ddmm(w.monday)} – ${ddmm(w.sunday)}) instead of ${t.person}? Best to also give a quick heads-up in the flat group.`);
  $('#swap-people').innerHTML = state.people.filter((p) => p !== t.person)
    .map((p) => `<button type="button" data-swap-to="${esc(p)}">${esc(p)}${p === t.planned ? L(' (laut Plan)', ' (as planned)') : ''}</button>`).join('');
  const dlg = $('#swap-dialog');
  $('#swap-people').onclick = async (e) => {
    const b = e.target.closest('[data-swap-to]');
    if (!b) return;
    const person = b.dataset.swapTo === t.planned ? null : b.dataset.swapTo;
    const nw = await api('swap', { monday: state.view, task: taskKey, person });
    state.weeks.set(nw.monday, nw);
    dlg.close();
    render();
    toast(L('Getauscht', 'Swapped'));
  };
  dlg.showModal();
}

function openCleanerVisit() {
  const w = state.weeks.get(state.view);
  const dlg = $('#cleaner-dialog');
  const d = $('#cleaner-date');
  d.min = w.monday; d.max = w.sunday; d.value = w.cleanerDay;
  $('#cleaner-time').value = w.cleanerTime || '';
  $('#cleaner-week').textContent = L(`Woche ${ddmm(w.monday)} – ${ddmm(w.sunday)} – alle bekommen eine kurze Nachricht mit dem Termin.`,
    `Week ${ddmm(w.monday)} – ${ddmm(w.sunday)} – everyone gets a short notification with the date.`);
  $('#cleaner-form').onsubmit = async (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    try {
      const nw = await api('cleaner/visit', { monday: w.monday, date: d.value, time: $('#cleaner-time').value, by: state.me });
      state.weeks.set(nw.monday, nw);
      dlg.close();
      render();
      toast(L('Eingetragen, alle wurden benachrichtigt', 'Saved, everyone has been notified'));
    } catch (err) { toast(err.message); }
  };
  dlg.showModal();
}

function openCleanerContact() {
  const dlg = $('#swap-dialog');
  $('#swap-title').textContent = L('Zuständig für die Putzkraft', 'In charge of the cleaner');
  $('#swap-text').textContent = L('Wer stimmt die Termine mit der Putzkraft ab? Diese Person bekommt montags die Frage, ob und wann die Putzkraft kommt.',
    'Who arranges the dates with the cleaner? This person gets asked on Mondays whether and when the cleaner is coming.');
  $('#swap-people').innerHTML = state.people
    .map((p) => `<button type="button" data-contact="${esc(p)}">${esc(p)}${p === state.cleanerContact ? L(' (bisher)', ' (current)') : ''}</button>`).join('');
  $('#swap-people').onclick = async (e) => {
    const b = e.target.closest('[data-contact]');
    if (!b) return;
    try {
      const r = await api('cleaner/contact', { name: b.dataset.contact });
      state.cleanerContact = r.cleanerContact;
      dlg.close();
      render();
      toast(L(`${r.cleanerContact} ist jetzt zuständig`, `${r.cleanerContact} is now in charge`));
    } catch (err) { toast(err.message); }
  };
  dlg.showModal();
}

// ---------------- Tabs ----------------
const TABS = { start: 'home', plan: 'plan', einkauf: 'shop', kasse: 'money', kalender: 'cal', regeln: 'rules' };
function currentTab() { return TABS[location.hash.slice(1)] || 'home'; }
function showTab() {
  const tab = currentTab();
  for (const t of ['home', 'plan', 'shop', 'money', 'cal', 'rules']) $(`#tab-${t}`).hidden = t !== tab;
  renderMe();
  if (tab === 'home') { renderHome(); loadMoney(); loadShop(); }
  if (tab === 'cal') renderCal();
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === (tab === 'rules' ? 'home' : tab)));
  if (tab === 'shop') loadShop();
  if (tab === 'money') loadMoney();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', showTab);

function ago(ts) {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return L('gerade eben', 'just now');
  if (min < 60) return L(`vor ${min} Min.`, `${min} min ago`);
  const h = Math.round(min / 60);
  if (h < 24) return L(`vor ${h} Std.`, `${h} h ago`);
  const d = Math.round(h / 24);
  if (d === 1) return L('gestern', 'yesterday');
  if (d < 7) return L(`vor ${d} Tagen`, `${d} days ago`);
  const d2 = new Date(ts);
  return d2.toLocaleDateString(locale(), d2.getFullYear() === new Date().getFullYear() ? { day: '2-digit', month: '2-digit' } : { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// ---------------- Einkaufsliste ----------------
state.shop = null;
state.shopCat = store.get('shopCat') || 'allgemein';

async function loadShop() {
  try { state.shop = await api('shop'); renderShop(); renderHome(); } catch (e) { toast(e.message); }
}
function renderShop() {
  const sh = state.shop;
  if (!sh) return;
  if (!sh.categories.some((c) => c.id === state.shopCat)) state.shopCat = sh.categories[sh.categories.length - 1].id;
  const badge = $('#shop-badge');
  badge.hidden = !sh.items.length;
  badge.textContent = sh.items.length;
  $('#shop-cats').innerHTML = sh.categories.map((c) =>
    `<button type="button" class="chip" role="radio" aria-checked="${c.id === state.shopCat}" data-cat="${c.id}">${c.icon} ${esc(T(c.label))}</button>`).join('');
  if (!sh.items.length) {
    $('#shop-list').innerHTML = `<div class="card"><p class="empty">${L('Alles da! 🎉 Wenn etwas leer ist, trag es oben ein.', "We've got everything! 🎉 If something runs out, add it above.")}</p></div>`;
    return;
  }
  $('#shop-list').innerHTML = sh.categories.map((c) => {
    const items = sh.items.filter((i) => i.cat === c.id);
    if (!items.length) return '';
    return `<section class="card shop-cat"><h2>${c.icon} ${esc(T(c.label))} <span class="muted small">${items.length}</span></h2>
      ${items.map((i) => `<div class="shop-item"><div class="name">${esc(i.name)}<small>${i.by ? `${esc(i.by)}, ` : ''}${ago(i.at)}</small></div>
        <button class="ghost small" data-bought="${esc(i.id)}">${L('Gekauft ✓', 'Bought ✓')}</button></div>`).join('')}
    </section>`;
  }).join('');
}
$('#shop-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#shop-name');
  const name = input.value.trim();
  if (!name) return;
  try {
    state.shop = await api('shop/add', { name, cat: state.shopCat, by: state.me });
    input.value = '';
    renderShop();
    toast(L('Steht auf der Liste', 'Added to the list'));
  } catch (err) { toast(err.message); }
});
$('#shop-cats').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cat]');
  if (!b) return;
  state.shopCat = b.dataset.cat;
  store.set('shopCat', state.shopCat);
  renderShop();
});
$('#shop-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-bought]');
  if (!b) return;
  const item = state.shop.items.find((i) => i.id === b.dataset.bought);
  if (!item) return;
  $('#bought-title').textContent = L(`${item.name} gekauft 🎉`, `${item.name} bought 🎉`);
  $('#bought-price').value = '';
  const dlg = $('#bought-dialog');
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'ok') return;
    const price = $('#bought-price').value.trim();
    try {
      state.shop = await api('shop/done', { id: item.id, price: price || undefined, by: state.me });
      renderShop();
      toast(price ? L('Danke! Betrag steht in der WG-Kasse.', 'Thanks! The amount is in the flat money.') : L('Danke!', 'Thanks!'));
      state.money = null;
    } catch (err) { toast(err.message); }
  };
  dlg.returnValue = '';
  dlg.showModal();
});

// Kategorien bearbeiten (Namen bleiben so gespeichert, wie sie eingegeben werden)
function catRow(c = { label: '', icon: '🛒' }) {
  return `<div class="cat-row" data-id="${esc(c.id || '')}">
    <input class="ic" value="${esc(c.icon)}" maxlength="8" aria-label="Emoji">
    <input class="lb" value="${esc(T(c.label))}" data-orig="${esc(c.label)}" maxlength="40" placeholder="${L('Name', 'Name')}" aria-label="Name">
    <button type="button" class="ghost" data-cat-del aria-label="${L('Löschen', 'Delete')}">🗑</button></div>`;
}
$('#edit-cats').addEventListener('click', () => {
  $('#cats-list').innerHTML = state.shop.categories.map(catRow).join('');
  const dlg = $('#cats-dialog');
  dlg.returnValue = '';
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'ok') return;
    const categories = [...document.querySelectorAll('#cats-list .cat-row')].map((r) => {
      const lb = r.querySelector('.lb');
      const label = lb.value.trim();
      // Unveränderte, nur übersetzt angezeigte Namen im Original speichern
      return { id: r.dataset.id || undefined, icon: r.querySelector('.ic').value.trim(), label: lb.dataset.orig && label === T(lb.dataset.orig) ? lb.dataset.orig : label };
    }).filter((c) => c.label);
    try {
      state.shop = await api('shop/categories', { categories });
      if (!state.shop.categories.some((c) => c.id === state.shopCat)) state.shopCat = state.shop.categories[0].id;
      renderShop();
      toast(L('Kategorien gespeichert', 'Categories saved'));
    } catch (err) { toast(err.message); }
  };
  dlg.showModal();
});
$('#cat-add').addEventListener('click', () => {
  $('#cats-list').insertAdjacentHTML('beforeend', catRow());
  $('#cats-list .cat-row:last-child .lb').focus();
});
$('#cats-list').addEventListener('click', (e) => {
  if (e.target.closest('[data-cat-del]')) e.target.closest('.cat-row').remove();
});

// ---------------- WG-Kasse ----------------
state.money = null;
state.split = null;
state.mode = 'equal';
state.cur = store.get('cur') || 'EUR';
const money = (cents, cur = 'EUR') => new Intl.NumberFormat(locale(), { style: 'currency', currency: cur }).format(cents / 100);
const modeHint = (mode) => ({
  equal: L('Wird gleichmäßig auf die ausgewählten Personen aufgeteilt.', 'Split equally between the selected people.'),
  percent: L('Prozent pro Person eintragen, zusammen 100 %.', 'Enter a percentage per person, 100 % in total.'),
  shares: L('Anteile eintragen, z.B. 2 und 1 heißt: die erste Person zahlt doppelt so viel.', 'Enter shares, e.g. 2 and 1 means the first person pays twice as much.'),
  exact: L('Genaue Beträge eintragen, zusammen der Gesamtbetrag.', 'Enter exact amounts that add up to the total.'),
}[mode]);

async function loadMoney() {
  try { state.money = await api('money'); renderMoney(); renderHome(); } catch (e) { toast(e.message); }
}
function renderMoney() {
  const m = state.money;
  if (!m) return;
  if (!state.split) state.split = new Set(m.people);

  // Salden je Währung (EUR immer, andere nur wenn etwas offen ist)
  const curs = Object.keys(m.byCurrency).filter((c) => c === 'EUR' || Object.values(m.byCurrency[c].balances).some((v) => v));
  const multi = curs.length > 1;
  let tHtml = '';
  let bHtml = '';
  for (const c of curs) {
    const { balances, transfers } = m.byCurrency[c];
    if (multi) tHtml += `<p class="cur-head">${c}</p>`;
    tHtml += transfers.length
      ? transfers.map((t) => `<div class="transfer"><span>${esc(t.from)} → ${esc(t.to)}</span>
          <span class="row"><strong>${money(t.amount, c)}</strong>
          <button class="ghost small" data-settle='${esc(JSON.stringify({ ...t, currency: c }))}'>${L('Bezahlt', 'Paid')}</button></span></div>`).join('')
      : `<p class="empty">${L('Alle sind quitt. 🙌', 'Everyone is square. 🙌')}</p>`;
    if (multi) bHtml += `<p class="cur-head" style="grid-column:1/-1">${c}</p>`;
    bHtml += [...m.people, ...(m.former || []).filter((p) => balances[p])].map((p) => {
      const v = balances[p] || 0;
      return `<div class="bal${p === state.me ? ' mine-bal' : ''}"><div class="who">${esc(p)}${m.people.includes(p) ? '' : L(' (ausgezogen)', ' (moved out)')}</div>
        <div class="amt ${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${v > 0 ? '+' : ''}${money(v, c)}</div></div>`;
    }).join('');
  }
  $('#money-transfers').innerHTML = tHtml;
  $('#money-balances').innerHTML = bHtml;
  renderExplain(m, curs);

  const sel = $('#m-paid');
  const prev = (state.paidTouched && sel.value) || state.me || m.people[0];
  sel.innerHTML = m.people.map((p) => `<option${p === prev ? ' selected' : ''}>${esc(p)}</option>`).join('');
  const cs = $('#m-cur');
  if (!cs.options.length) {
    cs.innerHTML = m.currencies.map((c) => `<option${c === state.cur ? ' selected' : ''}>${c}</option>`).join('');
  }
  renderSplit();

  $('#money-list').innerHTML = m.expenses.length
    ? m.expenses.map((e) => {
      const cur = e.currency || 'EUR';
      const settleRow = e.kind === 'settle';
      let who;
      if (e.net) { // aus Splitwise importiert
        const to = Object.entries(e.net).filter(([, v]) => v < 0).map(([p]) => p);
        who = settleRow
          ? L(`${esc(e.paidBy)} hat ${to.map(esc).join(', ')} Geld zurückgegeben · Splitwise`, `${esc(e.paidBy)} paid back ${to.map(esc).join(', ')} · Splitwise`)
          : L(`${esc(e.paidBy || '?')} hat bezahlt · Splitwise`, `${esc(e.paidBy || '?')} paid · Splitwise`);
      } else {
        const parts = e.parts || Object.fromEntries((e.split || []).map((p) => [p, null]));
        let forWho;
        if (e.mode && e.mode !== 'equal') forWho = Object.entries(parts).map(([p, v]) => `${esc(p)} ${money(v, cur)}`).join(', ');
        else forWho = Object.keys(parts).length === m.people.length ? L('für alle', 'for everyone') : `${L('für', 'for')} ${Object.keys(parts).map(esc).join(', ')}`;
        who = settleRow
          ? L(`${esc(e.paidBy)} hat ${esc(Object.keys(parts)[0])} Geld zurückgegeben`, `${esc(e.paidBy)} paid back ${esc(Object.keys(parts)[0])}`)
          : `${L(`${esc(e.paidBy)} hat bezahlt`, `${esc(e.paidBy)} paid`)} · ${forWho}`;
      }
      const split = !e.net && e.parts && !settleRow
        ? `<details><summary>${L('Aufteilung', 'Split')}</summary><p>${Object.entries(e.parts).map(([p, v]) => `${esc(p)}: ${money(v, cur)}`).join(' · ')}</p></details>`
        : '';
      return `<div class="exp${settleRow ? ' settle' : ''}"><div class="d">${esc(T(e.desc))}<small>${who} · ${ago(e.at)}</small>${split}</div>
        <div class="r"><strong>${money(e.amount, cur)}</strong><button class="link small" data-del="${esc(e.id)}">${L('löschen', 'delete')}</button></div></div>`;
    }).join('')
    : `<p class="empty">${L('Noch nichts eingetragen.', 'Nothing added yet.')}</p>`;
}

/** "So wird gerechnet": pro Person bezahlt, Anteil, Rückzahlungen → Saldo */
function renderExplain(m, curs) {
  let html = `<p class="small">${L(
    'Für jede Person wird zusammengezählt, was sie für die WG <strong>bezahlt</strong> hat. Davon wird abgezogen, was bei allen Einträgen <strong>ihr Anteil</strong> war. Rückzahlungen werden verrechnet. Plus heißt: bekommt Geld, Minus heißt: schuldet Geld.',
    'For each person we add up what they <strong>paid</strong> for the flat and subtract <strong>their share</strong> of all entries. Repayments are taken into account. Plus means they are owed money, minus means they owe money.')}</p>`;
  for (const c of curs) {
    const bd = m.byCurrency[c].breakdown;
    if (!bd) continue;
    const people = [...m.people, ...(m.former || []).filter((p) => m.byCurrency[c].balances[p])];
    const hasImport = people.some((p) => bd[p]?.imported);
    const hasRepay = people.some((p) => bd[p]?.repaid || bd[p]?.received);
    const f = (v) => (v ? money(v, c) : '–');
    html += `${curs.length > 1 ? `<p class="cur-head">${c}</p>` : ''}<div class="table-wrap"><table><thead><tr>
      <th>${L('Person', 'Person')}</th><th>${L('bezahlt', 'paid')}</th><th>− ${L('Anteil', 'share')}</th>
      ${hasRepay ? `<th>+ ${L('zurückgezahlt', 'paid back')}</th><th>− ${L('zurückbekommen', 'got back')}</th>` : ''}
      ${hasImport ? `<th>+ Splitwise</th>` : ''}<th>= ${L('Saldo', 'Balance')}</th></tr></thead><tbody>
      ${people.map((p) => {
        const b = bd[p] || {};
        const v = m.byCurrency[c].balances[p] || 0;
        return `<tr><td>${esc(p)}</td><td>${f(b.paid)}</td><td>${f(b.share)}</td>
          ${hasRepay ? `<td>${f(b.repaid)}</td><td>${f(b.received)}</td>` : ''}
          ${hasImport ? `<td>${b.imported ? `${b.imported > 0 ? '+' : ''}${money(b.imported, c)}` : '–'}</td>` : ''}
          <td class="sum">${v > 0 ? '+' : ''}${money(v, c)}</td></tr>`;
      }).join('')}</tbody></table></div>`;
    if (hasImport) html += `<p class="muted small">${L('„Splitwise“ ist der übernommene Stand aus der alten Splitwise-Gruppe.', '"Splitwise" is the balance carried over from the old Splitwise group.')}</p>`;
  }
  html += `<p class="small">${L(
    'Damit alle wieder bei 0 sind, schlägt die App möglichst wenige Überweisungen vor: Wer am meisten schuldet, zahlt an die Person, die am meisten bekommt, und so weiter. Bei jedem Eintrag unten zeigt „Aufteilung“, wer wie viel übernimmt.',
    'To get everyone back to 0, the app suggests as few transfers as possible: whoever owes the most pays the person who is owed the most, and so on. On each entry below, "Split" shows who covers how much.')}</p>`;
  $('#money-explain').innerHTML = html;
}

function renderSplit() {
  const m = state.money;
  if (!m) return;
  document.querySelectorAll('#m-mode [data-mode]').forEach((b) => b.setAttribute('aria-checked', b.dataset.mode === state.mode));
  const equal = state.mode === 'equal';
  $('#m-split').hidden = !equal;
  $('#m-values').hidden = equal;
  if (equal) {
    $('#m-split').innerHTML = m.people.map((p) =>
      `<button type="button" class="chip" aria-pressed="${state.split.has(p)}" data-split="${esc(p)}">${esc(p)}</button>`).join('');
  } else {
    const unit = state.mode === 'percent' ? '%' : state.mode === 'shares' ? L('Anteile', 'shares') : $('#m-cur').value || 'EUR';
    const old = Object.fromEntries([...document.querySelectorAll('#m-values input')].map((i) => [i.name, i.value]));
    $('#m-values').innerHTML = m.people.map((p) => `<label><span>${esc(p)}</span>
      <input name="${esc(p)}" inputmode="decimal" placeholder="0" value="${esc(old[p] ?? '')}" aria-label="${esc(p)} ${L('in', 'in')} ${unit}"><small class="muted">${unit}</small></label>`).join('');
  }
  updateHint();
}
function updateHint() {
  let hint = modeHint(state.mode);
  if (state.mode !== 'equal') {
    const nums = [...document.querySelectorAll('#m-values input')].map((i) => Number(i.value.replace(',', '.')) || 0);
    const sum = nums.reduce((a, b) => a + b, 0);
    if (state.mode === 'percent') hint += L(` Bisher: ${Math.round(sum * 100) / 100} %.`, ` So far: ${Math.round(sum * 100) / 100} %.`);
    if (state.mode === 'exact') {
      const total = Number($('#m-amount').value.replace(',', '.')) || 0;
      const rest = Math.round((total - sum) * 100);
      hint += rest ? L(` Noch zu verteilen: ${money(rest, $('#m-cur').value)}.`, ` Still to split: ${money(rest, $('#m-cur').value)}.`) : L(' Passt genau.', ' Adds up exactly.');
    }
  }
  $('#m-hint').textContent = hint;
}
$('#m-mode').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]');
  if (!b) return;
  state.mode = b.dataset.mode;
  $('#m-values').innerHTML = '';
  renderSplit();
});
$('#money-form').addEventListener('input', (e) => {
  if (e.target.closest('#m-values') || e.target.id === 'm-amount') updateHint();
});
$('#m-paid').addEventListener('change', () => { state.paidTouched = true; });
$('#m-cur').addEventListener('change', () => { state.cur = $('#m-cur').value; store.set('cur', state.cur); renderSplit(); });
$('#m-split').addEventListener('click', (e) => {
  const b = e.target.closest('[data-split]');
  if (!b) return;
  const p = b.dataset.split;
  if (state.split.has(p)) state.split.delete(p); else state.split.add(p);
  b.setAttribute('aria-pressed', state.split.has(p));
});
$('#money-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.mode === 'equal' && !state.split.size) { toast(L('Bitte mindestens eine Person auswählen', 'Please choose at least one person')); return; }
  const values = Object.fromEntries([...document.querySelectorAll('#m-values input')].map((i) => [i.name, i.value.trim()]));
  try {
    state.money = await api('money/add', {
      desc: $('#m-desc').value, amount: $('#m-amount').value, currency: $('#m-cur').value, paidBy: $('#m-paid').value,
      mode: state.mode, split: [...state.split], values, by: state.me,
    });
    $('#m-desc').value = '';
    $('#m-amount').value = '';
    $('#m-values').innerHTML = '';
    renderMoney();
    toast(L('Eingetragen', 'Added'));
  } catch (err) { toast(err.message); }
});
$('#sw-import').addEventListener('click', () => $('#sw-file').click());
$('#sw-file').addEventListener('change', async () => {
  const file = $('#sw-file').files[0];
  $('#sw-file').value = '';
  if (!file) return;
  try {
    const r = await api('money/import', { csv: await file.text(), by: state.me });
    state.money = r;
    renderMoney();
    toast(L(`${r.imported} Einträge übernommen${r.matches ? ', Salden stimmen mit Splitwise überein ✓' : ''}`,
      `${r.imported} entries imported${r.matches ? ', balances match Splitwise ✓' : ''}`));
  } catch (err) { toast(err.message); }
});
$('#tab-money').addEventListener('click', async (e) => {
  const s = e.target.closest('[data-settle]');
  if (s) {
    const t = JSON.parse(s.dataset.settle);
    if (!confirm(L(`Hat ${t.from} ${t.to} ${money(t.amount, t.currency)} zurückgezahlt?`, `Has ${t.from} paid ${t.to} ${money(t.amount, t.currency)} back?`))) return;
    try {
      state.money = await api('money/add', {
        kind: 'settle', desc: 'Rückzahlung', amount: (t.amount / 100).toFixed(2), currency: t.currency, paidBy: t.from, split: [t.to], by: state.me,
      });
      renderMoney();
      toast(L('Ausgeglichen 👍', 'Settled 👍'));
    } catch (err) { toast(err.message); }
    return;
  }
  const d = e.target.closest('[data-del]');
  if (d) {
    if (!confirm(L('Diesen Eintrag wirklich löschen?', 'Really delete this entry?'))) return;
    try { state.money = await api('money/delete', { id: d.dataset.del }); renderMoney(); } catch (err) { toast(err.message); }
  }
});

// ---------------- Übersicht (Dashboard) ----------------
function absentNow(day) { return (state.absences || []).filter((a) => a.from <= day && a.to >= day); }
const plural = (n, de1, deN, en1, enN) => (n === 1 ? L(de1, en1) : L(deN, enN));

function renderHome() {
  const el = $('#home');
  if (!el || !state.current) return;
  const w = state.weeks.get(state.current);
  const me = state.me;
  let html = '<div class="dash">';
  if (w) {
    const mine = [];
    let done = 0;
    let total = 0;
    for (const t of w.tasks) {
      for (const it of t.items) {
        const owner = it.person || t.person;
        if (owner !== me) continue;
        total++;
        if (w.checks[`${t.key}:${it.id}`]) done++;
      }
      if (t.person === me && t.key !== 'kuehlschrank') mine.push(T(t.title) + (t.key.startsWith('bad-') && !t.cleaningWeek ? L(' (nur Klopapier)', ' (toilet paper only)') : ''));
    }
    if (w.tasks.some((t) => t.key === 'kuehlschrank' && t.items.some((i) => i.person === me))) mine.push(L('Kühlschrankfach', 'Fridge shelf'));
    html += `<a class="card wide" href="#plan"><h3>${L('Deine Woche', 'Your week')}</h3>
      ${me ? (mine.length ? `<div class="big">${mine.map(esc).join(', ')}</div>
        ${total ? `<p>${L(`${done} von ${total} erledigt`, `${done} of ${total} done`)}</p><div class="progress"><b style="width:${Math.round((done / total) * 100)}%"></b></div>` : ''}`
        : `<div class="big">${L('Frei diese Woche 🎉', 'Free this week 🎉')}</div>`) : `<p>${L('Tipp oben auf deinen Namen.', 'Tap your name above.')}</p>`}
      </a>`;
    const t = (k) => w.tasks.find((x) => x.key === k);
    html += `<a class="card" href="#plan"><h3>${L('Putzplan', 'Cleaning')}</h3>
      <p>${L('Wochendienst', 'Weekly duty')}: <strong>${esc(t('woche')?.person || '–')}</strong></p>
      <p>${L('Bad vorne', 'Front bath')}: ${esc(t('bad-vorne')?.person || '–')}</p><p>${L('Bad hinten', 'Back bath')}: ${esc(t('bad-hinten')?.person || '–')}</p>
      <p class="muted">${w.cleaner ? `🧹 ${L('Putzkraft', 'Cleaner')} ${cleanerWhen(w)}${w.cleanerConfirmed ? ' ✓' : ''}` : w.ausfall ? L('⚠️ Putzkraft fällt aus', '⚠️ Cleaner cancelled') : L('Ohne Putzkraft', 'No cleaner')}</p></a>`;
  }
  const sh = state.shop;
  html += `<a class="card" href="#einkauf"><h3>${L('Einkauf', 'Shopping')}</h3>${sh
    ? (sh.items.length ? `<div class="big">${sh.items.length}</div><p>${sh.items.slice(0, 3).map((i) => esc(i.name)).join(', ')}${sh.items.length > 3 ? ' …' : ''}</p>` : `<p>${L('Alles da 🎉', 'All stocked 🎉')}</p>`)
    : '<p class="muted">…</p>'}</a>`;
  const m = state.money;
  if (m) {
    const eur = m.byCurrency.EUR;
    const v = me ? eur.balances[me] || 0 : null;
    const owe = me ? eur.transfers.filter((x) => x.from === me) : [];
    html += `<a class="card" href="#kasse"><h3>${L('Kasse', 'Money')}</h3>${me
      ? `<div class="big" style="color:${v > 0 ? 'var(--done)' : v < 0 ? 'var(--warn)' : 'inherit'}">${v > 0 ? '+' : ''}${money(v)}</div>
        <p>${owe.length ? owe.map((x) => `${L('an', 'to')} ${esc(x.to)}: ${money(x.amount)}`).join('<br>') : v > 0 ? L('Du bekommst Geld zurück', "You're owed money") : L('Du bist quitt', "You're square")}</p>`
      : ''}</a>`;
  } else {
    html += `<a class="card" href="#kasse"><h3>${L('Kasse', 'Money')}</h3><p class="muted">…</p></a>`;
  }
  const today = state.today;
  const now = absentNow(today);
  const next = (state.absences || []).filter((a) => a.from > today).slice(0, 3);
  const meet = (state.events || []).find((e) => e.type === 'meeting' && e.from >= today);
  const openPolls = (state.polls || []).filter((p) => p.status === 'open');
  const invites = (state.events || []).filter((e) => e.participants.some((p) => p.name === me && !p.ok));
  const nTopics = meet?.topics?.length || 0;
  html += `<a class="card" href="#kalender"><h3>${L('Kalender', 'Calendar')}</h3>
    ${now.length ? `<p>${now.map((a) => `🏖️ <strong>${esc(a.person)}</strong> ${L('bis', 'until')} ${ddmm(a.to)}`).join('<br>')}</p>` : `<p>${L('Alle da', 'Everyone is home')}</p>`}
    ${next.length ? `<p class="muted">${next.map((a) => L(`${esc(a.person)} weg ab ${ddmm(a.from)}`, `${esc(a.person)} away from ${ddmm(a.from)}`)).join('<br>')}</p>` : ''}
    ${meet ? `<p>🗣️ ${esc(meet.title && meet.title !== 'WG-Meeting' ? meet.title : L('WG-Meeting', 'Flat meeting'))} ${ddmm(meet.from)} ${meet.time}${nTopics ? ` · ${nTopics} ${plural(nTopics, 'Thema', 'Themen', 'topic', 'topics')}` : ''}</p>` : ''}
    ${openPolls.length ? `<p>🗳️ ${openPolls.length} ${plural(openPolls.length, 'Abstimmung offen', 'Abstimmungen offen', 'open poll', 'open polls')}</p>` : ''}
    ${invites.length ? `<p><strong>📬 ${invites.length} ${plural(invites.length, 'Einladung für dich', 'Einladungen für dich', 'invitation for you', 'invitations for you')}</strong></p>` : ''}</a>`;
  html += `<a class="card wide" href="#regeln"><h3>${L('Hausregeln', 'House rules')}</h3><p>${L('Mission Haussegen 📜 Alles zum WG-Seelenfrieden', 'Mission Haussegen 📜 Everything for peace in the flat')}</p></a>`;
  html += '</div>';
  el.innerHTML = html;

  $('#members-list').innerHTML = (state.members || [])
    .filter((x) => !x.until || x.until > state.current)
    .map((x) => {
      const away = now.some((a) => a.person === x.name);
      const future = x.since > state.current;
      const leaving = x.until;
      const side = x.side === 'hinten' ? L('hinten', 'back') : L('vorne', 'front');
      const bday = x.birthday ? ` · 🎂 ${ddmm(x.birthday)}` : '';
      return `<div class="member"><span>${avatar(x.name)}<span><strong>${esc(x.name)}</strong> <small>${L(`Zimmer ${side}`, `${side} room`)}${bday}${x.lang === 'en' ? ' · 🇬🇧' : ''}</small></span></span>
        <span>${away ? `<span class="tag away">${L('im Urlaub', 'on holiday')}</span> ` : ''}${future ? `<span class="tag">${L('ab', 'from')} ${ddmm(x.since)}</span>` : ''}${leaving ? `<span class="tag away">${L('zieht aus', 'moving out')}</span>` : ''}</span></div>`;
    }).join('');
  $('#leave-open').hidden = !me;
}

// ---------------- Mitglieder ----------------
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-open-join]')) { state.joining = true; renderMe(); $('#join-name').focus(); }
});
$('#join-side').addEventListener('click', (e) => {
  const b = e.target.closest('[data-side]');
  if (!b) return;
  state.joinSide = b.dataset.side;
  document.querySelectorAll('#join-side [data-side]').forEach((x) => x.setAttribute('aria-checked', x === b));
});
function markJoinLang() {
  document.querySelectorAll('#join-lang [data-jlang]').forEach((x) => x.setAttribute('aria-checked', x.dataset.jlang === state.lang));
}
$('#join-lang').addEventListener('click', (e) => {
  const b = e.target.closest('[data-jlang]');
  if (!b) return;
  setLang(b.dataset.jlang); // Formular gleich in der gewählten Sprache anzeigen
  markJoinLang();
});
$('#join-cancel').onclick = () => {
  state.joining = false;
  if (location.hash === '#beitreten') history.replaceState(null, '', '#start');
  renderMe();
  showTab();
};
$('#join').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.joinSide) { toast(L('Bitte vorne oder hinten wählen', 'Please choose front or back')); return; }
  if (!joinProfile.gender) { toast(L('Bitte dein Geschlecht angeben', 'Please choose your gender')); return; }
  try {
    const r = await api('members/join', {
      name: $('#join-name').value, side: state.joinSide, lang: state.lang,
      birthday: $('#join-birthday').value, gender: joinProfile.gender, photo: joinProfile.photo || undefined,
    });
    state.me = r.name;
    store.set('me', r.name);
    state.joining = false;
    history.replaceState(null, '', '#start');
    state.weeks.clear();
    await load();
    showTab();
    toast(L(`Willkommen als ${G(r.name, 'neue Mitbewohnerin', 'neuer Mitbewohner', 'neue:r Mitbewohner:in')}, ${r.name}! Ab ${ddmm(r.since)} bist du im Putzplan.`, `Welcome, ${r.name}! You're on the cleaning rota from ${ddmm(r.since)}.`));
  } catch (err) { toast(err.message); }
});
$('#invite').onclick = async () => {
  const url = `${location.origin}/#beitreten`;
  const text = L('Komm in unsere WG-Zentrale! Leg dir dort dein Profil an:', 'Join our flat app "Zentrale"! Create your profile here:');
  try {
    if (navigator.share) { await navigator.share({ title: 'WG-Zentrale', text, url }); return; }
  } catch { return; }
  try { await navigator.clipboard.writeText(`${text} ${url}`); toast(L('Einladungslink kopiert, schick ihn einfach weiter', 'Invite link copied, just send it on')); } catch { prompt(L('Diesen Link verschicken:', 'Send this link:'), url); }
};
$('#leave-open').onclick = async () => {
  if (!state.money) { try { state.money = await api('money'); } catch { /* egal */ } }
  const eur = state.money?.byCurrency?.EUR;
  const v = eur ? eur.balances[state.me] || 0 : 0;
  const owe = eur ? eur.transfers.filter((x) => x.from === state.me) : [];
  const oweList = owe.length ? ` (${owe.map((x) => `${esc(x.to)}: ${money(x.amount)}`).join(', ')})` : '';
  $('#leave-balance').innerHTML = v < 0
    ? `<div class="banner"><p>${L(`⚠️ Laut WG-Kasse schuldest du noch <strong>${money(-v)}</strong>${oweList}. Bitte vorher ausgleichen.`, `⚠️ According to the flat money you still owe <strong>${money(-v)}</strong>${oweList}. Please settle up first.`)}</p></div>`
    : v > 0 ? `<div class="banner"><p>${L(`💶 Du bekommst laut WG-Kasse noch <strong>${money(v)}</strong> zurück. Sprecht das am besten vorher ab.`, `💶 According to the flat money you're still owed <strong>${money(v)}</strong>. Best to sort it out before you go.`)}</p></div>`
      : `<div class="banner"><p>${L('✅ Deine WG-Kasse ist ausgeglichen.', '✅ Your flat money is settled.')}</p></div>`;
  $('#leave-form').reset();
  $('#leave-date').value = state.today;
  const dlg = $('#leave-dialog');
  dlg.returnValue = '';
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'ok') return;
    const name = state.me;
    try {
      await api('members/leave', { name, date: $('#leave-date').value });
      const sub = await currentSubscription().catch(() => null);
      if (sub) { await sub.unsubscribe().catch(() => {}); }
      $('#bye-title').textContent = L(`Schade, dass du gehst, ${name}!`, `So sad to see you go, ${name}!`);
      $('#bye-text').textContent = L(`Du warst ${G(name, 'eine tolle Mitbewohnerin', 'ein toller Mitbewohner', 'ein:e tolle:r Mitbewohner:in')}, und wir werden dich wirklich vermissen: die Gespräche in der Küche, das gemeinsame Kochen und sogar deine Putzwochen. Danke für die schöne Zeit mit dir! Pass auf dich auf, komm uns besuchen, und für einen Kaffee oder eine Party bist du hier immer willkommen. 💛`,
        "We'll really miss you: the chats in the kitchen, cooking together and even your cleaning weeks. Thanks for the lovely time with you! Take care, come and visit, and you're always welcome here for a coffee or a party. 💛");
      $('#bye-dialog').showModal();
      state.me = null;
      store.set('me', '');
      state.weeks.clear();
      await load();
    } catch (err) { toast(err.message); }
  };
  dlg.showModal();
};
// Fragebogen: Abschicken nur, wenn alles abgehakt ist (Browser prüft "required")
$('#leave-form').addEventListener('submit', (e) => {
  if (e.submitter?.value === 'ok' && !$('#leave-form').checkValidity()) { e.preventDefault(); $('#leave-form').reportValidity(); }
});

// ---------------- Profil ----------------
/** Bild verkleinern (quadratisch, 320 px) und als JPEG-Daten-URL zurückgeben */
async function resizePhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = url; });
    const size = 320;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    c.getContext('2d').drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
    return c.toDataURL('image/jpeg', 0.82);
  } finally { URL.revokeObjectURL(url); }
}
/** Foto-Auswahl + Geschlecht für ein Formular (Präfix 'join' oder 'profile') verdrahten */
function profileForm(prefix) {
  const st = { photo: undefined, gender: null };
  const preview = (src, name) => {
    $(`#${prefix}-photo-preview`).innerHTML = src ? `<img src="${src}" alt="">` : esc((name || '?').slice(0, 1).toUpperCase());
    $(`#${prefix}-photo-del`).hidden = !src;
  };
  st.preview = preview;
  st.setGender = (g) => {
    st.gender = g;
    document.querySelectorAll(`#${prefix}-gender [data-gender]`).forEach((x) => x.setAttribute('aria-checked', x.dataset.gender === g));
  };
  $(`#${prefix}-gender`).addEventListener('click', (e) => { const b = e.target.closest('[data-gender]'); if (b) st.setGender(b.dataset.gender); });
  $(`#${prefix}-photo-btn`).onclick = () => $(`#${prefix}-photo`).click();
  $(`#${prefix}-photo`).addEventListener('change', async () => {
    const f = $(`#${prefix}-photo`).files[0];
    $(`#${prefix}-photo`).value = '';
    if (!f) return;
    try { st.photo = await resizePhoto(f); preview(st.photo); } catch { toast(L('Das Bild konnte nicht gelesen werden', 'The image could not be read')); }
  });
  $(`#${prefix}-photo-del`).onclick = () => { st.photo = null; preview(null, $('#profile-name')?.value); };
  return st;
}
const joinProfile = profileForm('join');
joinProfile.preview(null, '?');
const editProfile = profileForm('profile');

function openProfile(intro = false) {
  const m = memberOf(state.me);
  if (!m) return;
  $('#profile-intro').hidden = !intro;
  $('#profile-name').value = m.name;
  $('#profile-birthday').value = m.birthday || '';
  $('#profile-birthday').max = state.today;
  editProfile.photo = undefined;
  editProfile.setGender(m.gender || null);
  editProfile.preview(m.photo ? `/api/photo/${encodeURIComponent(m.name)}?v=${m.photo}` : null, m.name);
  const dlg = $('#profile-dialog');
  $('#profile-form').onsubmit = async (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    if (!editProfile.gender) { toast(L('Bitte dein Geschlecht angeben', 'Please choose your gender')); return; }
    try {
      const r = await api('members/profile', {
        name: m.name, newName: $('#profile-name').value, birthday: $('#profile-birthday').value, gender: editProfile.gender, photo: editProfile.photo,
      });
      if (r.name !== state.me) { state.me = r.name; store.set('me', r.name); }
      dlg.close();
      state.weeks.clear();
      await load();
      if (state.money) loadMoney();
      toast(L('Profil gespeichert', 'Profile saved'));
    } catch (err) { toast(err.message); }
  };
  dlg.showModal();
}
$('#profile-open').onclick = () => openProfile(false);

// ---------------- Kalender ----------------
state.calMonth = null;
state.evType = 'urlaub';
state.evPeople = null;
const MONTHS = {
  de: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
};
const TYPE_ICON = { urlaub: '🏖️', meeting: '🗣️', sonstiges: '📅' };
const typeLabel = (t) => ({ urlaub: L('Urlaub', 'Holiday'), meeting: L('WG-Meeting', 'Flat meeting'), sonstiges: L('Termin', 'Event') }[t]);
/** Titel eines Eintrags; der Standardtitel "WG-Meeting" wird übersetzt */
const evTitle = (e) => (e.title && e.title !== 'WG-Meeting' ? e.title : typeLabel(e.type));
const dowOf = (d) => (new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7;

function applyCal(data) {
  state.events = data.events;
  state.polls = data.polls;
  state.absences = data.absences;
}

function renderCal() {
  if (!state.today || !$('#cal-grid')) return;
  if (!state.calMonth) state.calMonth = state.today.slice(0, 7);
  const [y, mo] = state.calMonth.split('-').map(Number);
  $('#cal-title').textContent = `${MONTHS[state.lang][mo - 1]} ${y}`;
  const first = `${state.calMonth}-01`;
  const start = addDays(first, -dowOf(first));
  const evs = state.events || [];
  const dows = state.lang === 'en' ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] : ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  let html = dows.map((d) => `<div class="dow">${d}</div>`).join('');
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    if (i >= 35 && d.slice(0, 7) !== state.calMonth) break;
    const wk = state.weeks.get(addDays(d, -dowOf(d)));
    const cleaner = wk && wk.cleaner && wk.cleanerDay === d;
    const pills = [];
    for (const m of (state.members || []).filter((x) => x.birthday && state.people.includes(x.name) && x.birthday.slice(5) === d.slice(5))) {
      pills.push(`<span class="pill bday" title="${L('Geburtstag', 'Birthday')}">🎂 ${esc(m.name)}</span>`);
    }
    for (const e of evs) {
      if (e.from > d || e.to < d) continue;
      if (e.type === 'urlaub') {
        for (const p of e.participants) pills.push(`<span class="pill urlaub${p.ok ? '' : ' pending'}" title="${esc(p.name)}: ${typeLabel('urlaub')}">${esc(p.name)}</span>`);
      } else {
        pills.push(`<span class="pill ${e.type}" title="${esc(evTitle(e))}">${e.time ? `${e.time} ` : ''}${esc(evTitle(e))}</span>`);
      }
    }
    html += `<div class="day${d.slice(0, 7) !== state.calMonth ? ' out' : ''}${d === state.today ? ' today' : ''}">
      <span class="n">${+d.slice(8)}${cleaner ? `<span title="${L('Putzkraft', 'Cleaner')}">🧹</span>` : ''}</span>${pills.join('')}</div>`;
  }
  $('#cal-grid').innerHTML = html;
  renderInbox();
  renderPolls();
  renderEvList();
}

function renderInbox() {
  const me = state.me;
  const pending = (state.events || []).filter((e) => e.participants.some((p) => p.name === me && !p.ok));
  const openPolls = (state.polls || []).filter((p) => p.status === 'open' && !(p.votes || {})[me]);
  if (!me || (!pending.length && !openPolls.length)) { $('#cal-inbox').innerHTML = ''; return; }
  $('#cal-inbox').innerHTML = `<section class="card inbox"><h2>${L('Für dich 📬', 'For you 📬')}</h2>
    ${pending.map((e) => `<div class="row"><span>${L(`<strong>${esc(e.by || 'Jemand')}</strong> hat dich beim Urlaub ${e.title ? `„${esc(e.title)}“ ` : ''}${fmtDay(e.from)} – ${fmtDay(e.to)} eingetragen.`,
      `<strong>${esc(e.by || 'Someone')}</strong> added you to the holiday ${e.title ? `"${esc(e.title)}" ` : ''}${fmtDay(e.from)} – ${fmtDay(e.to)}.`)}</span>
      <span class="row" style="flex:none"><button class="small" data-respond="${esc(e.id)}" data-accept="1">${L('Bin dabei', "I'm in")}</button><button class="ghost small" data-respond="${esc(e.id)}" data-accept="0">${L('Nein', 'No')}</button></span></div>`).join('')}
    ${openPolls.map((p) => `<div class="row"><span>🗳️ ${L('Stimm ab', 'Vote')}: <strong>${esc(evTitle({ ...p, type: 'meeting' }))}</strong>${p.by ? ` (${L('von', 'from')} ${esc(p.by)})` : ''}</span><button type="button" class="link small" data-goto-poll="${esc(p.id)}">${L('Zur Abstimmung', 'Go to poll')}</button></div>`).join('')}
  </section>`;
}

function pollScore(poll, optId) {
  let yes = 0; let maybe = 0; let no = 0;
  for (const v of Object.values(poll.votes || {})) {
    if (v[optId] === 'yes') yes++; else if (v[optId] === 'maybe') maybe++; else if (v[optId] === 'no') no++;
  }
  return { yes, maybe, no, score: yes * 2 + maybe };
}
function renderPolls() {
  const open = (state.polls || []).filter((p) => p.status === 'open');
  const voteLabel = { yes: L('Passt', 'Works'), maybe: L('Vielleicht', 'Maybe'), no: L('Passt nicht', "Doesn't work") };
  $('#polls').innerHTML = open.map((poll) => {
    const mine = (poll.votes || {})[state.me] || {};
    const voters = Object.keys(poll.votes || {});
    const missing = state.people.filter((p) => !voters.includes(p));
    const best = Math.max(...poll.options.map((o) => pollScore(poll, o.id).score));
    return `<section class="card poll" id="poll-${esc(poll.id)}">
      <h2>🗳️ ${esc(evTitle({ ...poll, type: 'meeting' }))}</h2>
      <p class="muted small" style="margin:0 0 6px">${L('Angefragt von', 'Requested by')} ${esc(poll.by || '?')} · ${L('abgestimmt', 'voted')}: ${voters.length}/${state.people.length}${missing.length ? ` · ${L('fehlt noch', 'still missing')}: ${missing.map(esc).join(', ')}` : ''}</p>
      ${poll.options.map((o) => {
        const sc = pollScore(poll, o.id);
        const who = (v) => voters.filter((n) => poll.votes[n][o.id] === v).map(esc).join(', ');
        return `<div class="opt${sc.score === best && best > 0 ? ' best' : ''}">
          <span class="when"><strong>${fmtDay(o.date)}</strong>, ${clock(o.time)}</span>
          <span class="votes">${state.me ? ['yes', 'maybe', 'no'].map((v) => `<button type="button" class="${v}" aria-pressed="${mine[o.id] === v}" data-vote="${esc(poll.id)}" data-opt="${esc(o.id)}" data-val="${v}" aria-label="${voteLabel[v]}">${{ yes: '✅', maybe: '🤔', no: '❌' }[v]}</button>`).join('') : ''}</span>
          <span class="tally">✅ ${sc.yes}${sc.yes ? ` (${who('yes')})` : ''} · 🤔 ${sc.maybe}${sc.maybe ? ` (${who('maybe')})` : ''} · ❌ ${sc.no}${sc.no ? ` (${who('no')})` : ''}
            · <button type="button" class="link small" data-close="${esc(poll.id)}" data-opt="${esc(o.id)}">${L('Diesen Termin festlegen', 'Pick this date')}</button></span>
        </div>`;
      }).join('')}
      <div class="row end" style="margin-top:6px"><button type="button" class="link small" data-poll-del="${esc(poll.id)}">${L('Anfrage löschen', 'Delete request')}</button></div>
    </section>`;
  }).join('');
}

function renderEvList() {
  const up = (state.events || []).filter((e) => e.to >= state.today);
  $('#ev-list').innerHTML = up.length
    ? up.map((e) => {
      const ppl = e.participants.length === state.people.length && e.type !== 'urlaub'
        ? L('alle', 'everyone')
        : e.participants.map((p) => `${esc(p.name)}${p.ok ? '' : L(' (wartet auf Zusage)', ' (waiting to confirm)')}`).join(', ');
      return `<div class="ev"><div>${TYPE_ICON[e.type]} <strong>${esc(evTitle(e))}</strong>
        <small>${fmtDay(e.from)}${e.to !== e.from ? ` – ${fmtDay(e.to)}` : ''}${e.time ? `, ${clock(e.time)}` : ''} · ${ppl}${e.note ? ` · ${esc(e.note)}` : ''}</small></div>
        <div class="ev-actions">${e.type === 'meeting' ? `<button class="link small" data-notes="${esc(e.id)}">📝 ${L('Themen & Protokoll', 'Topics & minutes')}${e.topics?.length ? ` (${e.topics.length})` : ''}</button>` : ''}
        <button class="link small" data-ev-del="${esc(e.id)}">${L('löschen', 'delete')}</button></div></div>`;
    }).join('')
    : `<p class="empty">${L('Nichts eingetragen.', 'Nothing planned.')}</p>`;
  const past = (state.events || []).filter((e) => e.type === 'meeting' && e.to < state.today).sort((a, b) => (a.from < b.from ? 1 : -1));
  $('#past-meetings').innerHTML = past.length
    ? `<h3>${L('Vergangene WG-Meetings', 'Past flat meetings')}</h3>${past.map((e) => `<div class="ev"><div>🗣️ <strong>${esc(evTitle(e))}</strong>
        <small>${fmtDay(e.from)}${e.minutes?.text ? L(' · Protokoll vorhanden', ' · minutes available') : L(' · noch kein Protokoll', ' · no minutes yet')}</small></div>
        <button class="link small" data-notes="${esc(e.id)}">📝 ${e.minutes?.text ? L('Protokoll lesen', 'Read minutes') : L('Protokoll schreiben', 'Write minutes')}</button></div>`).join('')}`
    : '';
}

// WG-Meeting: Themen & Protokoll
function openNotes(id) {
  const dlg = $('#notes-dialog');
  const draw = () => {
    const e = (state.events || []).find((x) => x.id === id);
    if (!e) { dlg.close(); return null; }
    $('#notes-title').textContent = `🗣️ ${evTitle(e)}`;
    $('#notes-when').textContent = `${fmtDay(e.from)}${e.time ? `, ${clock(e.time)}` : ''}`;
    $('#notes-topics').innerHTML = (e.topics || []).length
      ? e.topics.map((t) => `<li><span>${esc(t.text)}${t.by ? ` <small class="muted">(${esc(t.by)})</small>` : ''}</span>
          <button type="button" class="link small" data-topic-del="${esc(t.id)}" aria-label="${L('Thema entfernen', 'Remove topic')}">✕</button></li>`).join('')
      : `<li class="muted">${L('Noch keine Themen.', 'No topics yet.')}</li>`;
    const m = e.minutes;
    const when = m?.at ? new Date(m.at).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    $('#notes-meta').textContent = m?.text ? L(`Zuletzt gespeichert${m.by ? ` von ${m.by}` : ''} am ${when}`, `Last saved${m.by ? ` by ${m.by}` : ''} on ${when}`) : '';
    return e;
  };
  const e = draw();
  if (!e) return;
  $('#notes-minutes').value = e.minutes?.text || '';
  const addTopic = async () => {
    const text = $('#notes-topic').value.trim();
    if (!text) return;
    try {
      applyCal(await api('events/notes/topic', { id, text, by: state.me }));
      $('#notes-topic').value = '';
      draw(); renderEvList();
    } catch (err) { toast(err.message); }
  };
  $('#notes-topic-add').onclick = addTopic;
  $('#notes-topic').onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); addTopic(); } };
  $('#notes-topics').onclick = async (ev) => {
    const b = ev.target.closest('[data-topic-del]');
    if (!b) return;
    try { applyCal(await api('events/notes/topic-delete', { id, topic: b.dataset.topicDel })); draw(); renderEvList(); } catch (err) { toast(err.message); }
  };
  $('#notes-form').onsubmit = async (ev) => {
    if (ev.submitter?.value !== 'ok') return;
    ev.preventDefault();
    try {
      applyCal(await api('events/notes/minutes', { id, text: $('#notes-minutes').value, by: state.me }));
      draw(); renderEvList();
      toast(L('Protokoll gespeichert', 'Minutes saved'));
    } catch (err) { toast(err.message); }
  };
  dlg.showModal();
}

// Eintrag-Formular
function renderEvForm() {
  if (!state.people.length) return;
  const t = state.evType;
  document.querySelectorAll('#ev-type [data-type]').forEach((b) => b.setAttribute('aria-checked', b.dataset.type === t));
  $('#ev-time-wrap').hidden = t !== 'meeting';
  $('#ev-to-wrap').hidden = t === 'meeting';
  $('#ev-from-label').textContent = t === 'meeting' ? L('Datum', 'Date') : L('Von', 'From');
  $('#ev-title').placeholder = {
    urlaub: L('z.B. Heimaturlaub, Skifahren', 'e.g. visiting family, skiing'),
    meeting: L('WG-Meeting', 'Flat meeting'),
    sonstiges: L('z.B. Hausbesichtigung, Party', 'e.g. flat viewing, party'),
  }[t];
  if (!state.evPeople) state.evPeople = new Set(t === 'meeting' ? state.people : [state.me].filter(Boolean));
  $('#ev-people').innerHTML = state.people.map((p) => `<button type="button" class="chip" aria-pressed="${state.evPeople.has(p)}" data-evp="${esc(p)}">${esc(p)}</button>`).join('');
  $('#ev-people-hint').textContent = t === 'urlaub' ? L('Andere, die du hinzufügst, müssen selbst bestätigen, dass sie dabei sind.', 'Anyone else you add has to confirm themselves that they are in.') : '';
}
$('#ev-open').onclick = () => {
  $('#ev-form').hidden = false; $('#poll-form').hidden = true;
  state.evType = 'urlaub'; state.evPeople = null;
  $('#ev-form').reset(); $('#ev-time').value = '19:00';
  renderEvForm();
  $('#ev-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
};
$('#ev-cancel').onclick = () => { $('#ev-form').hidden = true; };
$('#ev-type').addEventListener('click', (e) => {
  const b = e.target.closest('[data-type]');
  if (!b) return;
  state.evType = b.dataset.type;
  state.evPeople = null;
  renderEvForm();
});
$('#ev-people').addEventListener('click', (e) => {
  const b = e.target.closest('[data-evp]');
  if (!b) return;
  const p = b.dataset.evp;
  if (state.evPeople.has(p)) state.evPeople.delete(p); else state.evPeople.add(p);
  b.setAttribute('aria-pressed', state.evPeople.has(p));
});
$('#ev-from').addEventListener('change', () => { if (!$('#ev-to').value || $('#ev-to').value < $('#ev-from').value) $('#ev-to').value = $('#ev-from').value; });
$('#ev-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.evPeople.size) { toast(L('Bitte mindestens eine Person auswählen', 'Please choose at least one person')); return; }
  try {
    const data = await api('events/add', {
      type: state.evType, title: $('#ev-title').value, from: $('#ev-from').value, to: $('#ev-to').value || $('#ev-from').value,
      time: state.evType === 'meeting' ? $('#ev-time').value : '', note: $('#ev-note').value, participants: [...state.evPeople], by: state.me,
    });
    applyCal(data);
    $('#ev-form').hidden = true;
    state.weeks.clear();
    await load();
    toast(state.evType === 'urlaub' && state.evPeople.size > 1 ? L('Eingetragen, die anderen müssen noch zustimmen', 'Added, the others still have to confirm') : L('Eingetragen', 'Added'));
  } catch (err) { toast(err.message); }
});

// Meeting-Anfrage
function pollOptRow(date = '', time = '19:00') {
  return `<div class="poll-opt-row"><input type="date" value="${date}" required><input type="time" value="${time}" required>
    <button type="button" class="ghost" data-opt-del aria-label="${L('Entfernen', 'Remove')}">✕</button></div>`;
}
$('#poll-open').onclick = () => {
  $('#poll-form').hidden = false; $('#ev-form').hidden = true;
  $('#poll-form').reset();
  $('#poll-options').innerHTML = [3, 5, 8].map((n) => pollOptRow(addDays(state.today, n))).join('');
  $('#poll-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
};
$('#poll-cancel').onclick = () => { $('#poll-form').hidden = true; };
$('#poll-add-opt').onclick = () => $('#poll-options').insertAdjacentHTML('beforeend', pollOptRow());
$('#poll-options').addEventListener('click', (e) => { if (e.target.closest('[data-opt-del]')) e.target.closest('.poll-opt-row').remove(); });
$('#poll-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const options = [...document.querySelectorAll('#poll-options .poll-opt-row')].map((r) => {
    const [d, t] = r.querySelectorAll('input');
    return { date: d.value, time: t.value };
  });
  try {
    applyCal(await api('polls/add', { title: $('#poll-title').value, options, by: state.me }));
    $('#poll-form').hidden = true;
    renderCal(); renderHome();
    toast(L('Anfrage verschickt, alle können jetzt abstimmen', 'Request sent, everyone can vote now'));
  } catch (err) { toast(err.message); }
});

// Klicks im Kalender-Reiter
$('#tab-cal').addEventListener('click', async (e) => {
  const t = e.target;
  const go = t.closest('[data-goto-poll]');
  if (go) { document.getElementById(`poll-${go.dataset.gotoPoll}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  try {
    const vote = t.closest('[data-vote]');
    if (vote) {
      const poll = state.polls.find((p) => p.id === vote.dataset.vote);
      const votes = { ...((poll.votes || {})[state.me] || {}), [vote.dataset.opt]: vote.dataset.val };
      applyCal(await api('polls/vote', { id: poll.id, name: state.me, votes }));
      renderCal(); renderHome();
      return;
    }
    const close = t.closest('[data-close]');
    if (close) {
      const poll = state.polls.find((p) => p.id === close.dataset.close);
      const o = poll.options.find((x) => x.id === close.dataset.opt);
      if (!confirm(L(`WG-Meeting auf ${fmtDay(o.date)}, ${o.time} Uhr festlegen? Alle bekommen eine Nachricht.`, `Set the flat meeting for ${fmtDay(o.date)}, ${o.time}? Everyone gets a notification.`))) return;
      applyCal(await api('polls/close', { id: poll.id, optionId: o.id, by: state.me }));
      renderCal(); renderHome();
      toast(L('Termin steht 🎉', 'Date is set 🎉'));
      return;
    }
    const pdel = t.closest('[data-poll-del]');
    if (pdel) {
      if (!confirm(L('Anfrage löschen?', 'Delete this request?'))) return;
      applyCal(await api('polls/delete', { id: pdel.dataset.pollDel }));
      renderCal(); renderHome();
      return;
    }
    const resp = t.closest('[data-respond]');
    if (resp) {
      applyCal(await api('events/respond', { id: resp.dataset.respond, name: state.me, accept: resp.dataset.accept === '1' }));
      state.weeks.clear();
      await load();
      toast(resp.dataset.accept === '1' ? L('Bestätigt, schönen Urlaub! 🏖️', 'Confirmed, have a great holiday! 🏖️') : L('Abgelehnt', 'Declined'));
      return;
    }
    const notes = t.closest('[data-notes]');
    if (notes) { openNotes(notes.dataset.notes); return; }
    const del = t.closest('[data-ev-del]');
    if (del) {
      if (!confirm(L('Eintrag löschen?', 'Delete this entry?'))) return;
      applyCal(await api('events/delete', { id: del.dataset.evDel }));
      state.weeks.clear();
      await load();
    }
  } catch (err) { toast(err.message); }
});

async function ensureCalWeeks() {
  const first = `${state.calMonth}-01`;
  const from = addDays(first, -dowOf(first));
  if (state.weeks.has(from) && state.weeks.has(addDays(from, 35))) return;
  try {
    const data = await api(`weeks?from=${from}&count=6`);
    for (const w of data.weeks) state.weeks.set(w.monday, w);
  } catch { /* Anzeige ohne Putzkraft-Tage */ }
}
async function moveCal(n) {
  const [y, mo] = state.calMonth.split('-').map(Number);
  state.calMonth = new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7);
  renderCal();
  await ensureCalWeeks();
  renderCal();
}
$('#cal-prev').onclick = () => moveCal(-1);
$('#cal-next').onclick = () => moveCal(1);

// ---------------- Start ----------------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
setLang(state.lang, { rerender: false });
markJoinLang();
showTab();
if (currentTab() !== 'shop') api('shop').then((d) => { state.shop = d; renderShop(); }).catch(() => {});
load().catch((e) => {
  $('#week').innerHTML = `<div class="card"><p>${L(`Der Plan konnte nicht geladen werden (${esc(e.message)}). Bitte später nochmal versuchen.`, `The rota could not be loaded (${esc(e.message)}). Please try again later.`)}</p></div>`;
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  state.weeks.clear();
  load().catch(() => {});
  if (currentTab() === 'shop') loadShop();
  if (currentTab() === 'money') loadMoney();
});
