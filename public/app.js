import { EN, tr } from './i18n.js';
import { berlinHolidays, holidayOn, holidayInfo } from './holidays.js';

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
  lang: ['en', 'sv'].includes(store.get('lang')) ? store.get('lang') : 'de',
  people: [],
  current: null,
  view: null,
  weeks: new Map(), // monday -> week
};

// ---------------- Sprache ----------------
/** L('Deutsch', 'English', `Svenska`) */
const L = (de, en, sv) => (state.lang === 'en' ? en : state.lang === 'sv' ? sv ?? en : de);
/** Texte vom Server (Aufgaben, Kategorien, Fehlermeldungen) übersetzen */
const T = (s) => tr(s, state.lang);
const locale = () => ({ en: 'en-GB', sv: 'sv-SE' }[state.lang] || 'de-DE');
const MON_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MON_SV = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const ddmm = (s) => (state.lang === 'en' ? `${+s.slice(8, 10)} ${MON_EN[+s.slice(5, 7) - 1]}` : state.lang === 'sv' ? `${+s.slice(8, 10)} ${MON_SV[+s.slice(5, 7) - 1]}` : `${s.slice(8, 10)}.${s.slice(5, 7)}.`);
const WD = { de: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'], en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], sv: ['sön', 'mån', 'tis', 'ons', 'tor', 'fre', 'lör'] };
const wd = (s) => WD[state.lang][new Date(`${s}T12:00:00Z`).getUTCDay()];
const atTime = (t) => (t ? L(` um ${t}`, ` at ${t}`, ` kl. ${t}`) : '');
const clock = (t) => L(`${t} Uhr`, t, `kl. ${t}`);
const cleanerWhen = (w) => `${wd(w.cleanerDay)} ${ddmm(w.cleanerDay)}${atTime(w.cleanerTime)}`;
const fmtDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString(locale(), { weekday: 'short', day: '2-digit', month: state.lang === 'de' ? '2-digit' : 'short', timeZone: 'UTC' });

// Feste Texte in index.html: deutsches Original merken und je nach Sprache austauschen
const ORIG = new WeakMap();
function translateStatic() {
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const orig = ORIG.get(n) ?? n.nodeValue;
    const key = orig.trim();
    if (!key || EN[key] === undefined) continue;
    ORIG.set(n, orig);
    const want = state.lang === 'de' ? orig : orig.replace(key, tr(key, state.lang));
    if (n.nodeValue !== want) n.nodeValue = want;
  }
  for (const el of document.body.querySelectorAll('[placeholder],[aria-label],[title]')) {
    for (const a of ['placeholder', 'aria-label', 'title']) {
      if (!el.hasAttribute(a)) continue;
      const orig = el.getAttribute(`data-de-${a}`) ?? el.getAttribute(a);
      if (EN[orig] === undefined) continue;
      el.setAttribute(`data-de-${a}`, orig);
      el.setAttribute(a, state.lang === 'de' ? orig : tr(orig, state.lang));
    }
  }
}
// ---------------- Hell / Dunkel ----------------
/** Sonnenauf- und -untergang in Berlin (NOAA-Näherung), als Date */
function sunTimes(date, lat = 52.52, lng = 13.405) {
  const rad = Math.PI / 180;
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const N = Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - start) / 864e5);
  const lngHour = lng / 15;
  const calc = (rising) => {
    const t = N + ((rising ? 6 : 18) - lngHour) / 24;
    const M = 0.9856 * t - 3.289;
    let Ls = (M + 1.916 * Math.sin(M * rad) + 0.020 * Math.sin(2 * M * rad) + 282.634) % 360;
    if (Ls < 0) Ls += 360;
    let RA = Math.atan(0.91764 * Math.tan(Ls * rad)) / rad;
    RA = (RA + 360) % 360;
    RA += Math.floor(Ls / 90) * 90 - Math.floor(RA / 90) * 90;
    RA /= 15;
    const sinDec = 0.39782 * Math.sin(Ls * rad);
    const cosDec = Math.cos(Math.asin(sinDec));
    const cosH = (Math.cos(90.833 * rad) - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad));
    let H = Math.acos(Math.max(-1, Math.min(1, cosH))) / rad;
    if (rising) H = 360 - H;
    H /= 15;
    const T0 = H + RA - 0.06571 * t - 6.622;
    const UT = ((T0 - lngHour) % 24 + 24) % 24;
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) + UT * 3600e3);
  };
  return { rise: calc(true), set: calc(false) };
}
const themePref = () => { try { return localStorage.getItem('theme') || 'auto'; } catch { return 'auto'; } };
function applyTheme() {
  const pref = themePref();
  const now = new Date();
  const { rise, set } = sunTimes(now);
  const theme = pref === 'auto' ? (now >= rise && now < set ? 'light' : 'dark') : pref;
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#151816' : '#2f6f5e');
  document.querySelectorAll('#set-theme [data-theme-set]').forEach((b) => b.setAttribute('aria-checked', b.dataset.themeSet === pref));
  const hm = (d) => d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
  if ($('#theme-hint')) $('#theme-hint').textContent = pref === 'auto' ? L(`Heute hell von ${hm(rise)} bis ${hm(set)} (Sonnenauf- und -untergang in Berlin).`, `Light today from ${hm(rise)} to ${hm(set)} (sunrise and sunset in Berlin).`, `Ljust i dag från ${hm(rise)} till ${hm(set)} (soluppgång och solnedgång i Berlin).`) : '';
}
setInterval(applyTheme, 60e3);
applyTheme();
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-theme-set]');
  if (!b) return;
  try { localStorage.setItem('theme', b.dataset.themeSet); } catch { /* egal */ }
  applyTheme();
});

function setLang(lang, { rerender = true } = {}) {
  state.lang = ['en', 'sv'].includes(lang) ? lang : 'de';
  store.set('lang', state.lang);
  document.documentElement.lang = state.lang;
  translateStatic();
  applyTheme();
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
  const headers = { 'x-session': store.get('token') || '' };
  const res = await fetch(`/api/${path}`, body
    ? { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : { headers });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.auth && store.get('token') && (state.me || path.startsWith('auth/'))) {
    // Abgemeldet (z.B. Passwort wurde zurückgesetzt): zurück zur Anmeldung
    store.set('token', ''); store.set('me', ''); state.me = null; state.account = null; state.authView = 'login';
    loadLogin().catch(() => {});
  }
  if (!res.ok) throw new Error(T(data.error) || L(`Fehler ${res.status}`, `Error ${res.status}`, `Fel ${res.status}`));
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
/** Noch nicht angemeldet: nur Namen zum Auswählen laden */
async function loadLogin() {
  const d = await api('auth/people');
  state.people = d.people;
  state.members = d.members;
  state.admin = d.admin;
  state.account = d.account;
  state.me = null;
  renderMe();
}
async function load() {
  if (!store.get('token')) { state.account = null; await loadLogin(); return; }
  // Account prüfen: ist er schon mit einer Person verbunden?
  const who = await api('auth/people');
  state.admin = who.admin;
  state.account = who.account;
  state.pendingCount = who.pendingCount || 0;
  if (!who.account) store.set('token', '');
  if (!who.account?.person) { state.people = who.people; state.members = who.members; state.me = null; renderMe(); return; }
  state.me = who.account.person;
  store.set('me', state.me);
  state.isAdmin = state.me === who.admin;
  const data = await api('weeks?count=12');
  state.people = data.people;
  state.members = data.members;
  state.absences = data.absences;
  state.events = data.events || [];
  state.polls = data.polls || [];
  state.surveys = data.surveys || [];
  state.swapRequests = data.swapRequests || [];
  state.board = data.board || [];
  state.reactions = data.reactions || {};
  state.gami = data.gami || null;
  state.cleanerContact = data.cleanerContact || null;
  state.today = data.today;
  state.current = data.current;
  if (state.me && !state.people.includes(state.me)) { state.me = null; store.set('me', ''); }
  for (const w of data.weeks) state.weeks.set(w.monday, w);
  if (!state.view || !state.weeks.has(state.view)) state.view = state.current;
  syncLang();
  render();
  maybeAskProfile();
}
/** Wer noch keinen Geburtstag/kein Geschlecht eingetragen hat, wird einmal pro Besuch gefragt */
function maybeAskProfile() {
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
  renderSwapInbox();
  renderHome();
  renderSurveys();
  renderCal();
  renderWeek();
  renderUpcoming();
  renderNotify();
}

function renderMe() {
  const pick = $('#pick-me');
  const acct = state.account;
  // Alle Personen vergeben: direkt Vorname eingeben, Person wird automatisch angelegt
  const allTaken = !!acct && !acct.person && state.people.length > 0 && state.people.every((p) => memberOf(p)?.claimed);
  const joining = !state.me && !!acct && !acct.pending && (location.hash === '#beitreten' || state.joining || allTaken);
  $('#join').classList.toggle('quick', allTaken);
  $('#join-birthday').required = !allTaken;
  $('#join-title').textContent = allTaken ? L('Wie heißt du? 👋', "What's your name? 👋", 'Vad heter du? 👋') : L('Willkommen in der WG! 🎉', 'Welcome to the flat! 🎉', 'Välkommen till kollektivet! 🎉');
  $('#join-text').textContent = allTaken
    ? L('Gib deinen Vornamen ein, dann wirst du automatisch angelegt. Ab nächstem Montag bist du im Putzplan.', "Enter your first name and you'll be added automatically. You're on the cleaning rota from next Monday.", 'Skriv ditt förnamn så läggs du till automatiskt. Från nästa måndag är du med i städschemat.')
    : L('Leg dein Profil an. Ab nächstem Montag bist du automatisch im Putzplan.', "Create your profile. From next Monday you're automatically on the cleaning rota.", 'Skapa din profil. Från nästa måndag är du automatiskt med i städschemat.');
  $('#join').hidden = !joining;
  pick.hidden = !!state.me || joining;
  // Ohne Account: Start / Anmelden / Registrieren, mit Account ohne Person: Person wählen
  const view = acct ? (acct.pending ? 'wait' : 'pick') : (state.authView || (location.hash === '#beitreten' ? 'register' : 'start'));
  $('#auth-wait').hidden = view !== 'wait';
  if (acct?.pending) $('#wait-text').textContent = L(`Deine Anfrage als ${acct.pending.person} liegt bei ${state.admin}. Sobald ${state.admin} zustimmt, kannst du loslegen.`, `Your request to join as ${acct.pending.person} is with ${state.admin}. As soon as ${state.admin} approves, you can get started.`, `Din förfrågan som ${acct.pending.person} ligger hos ${state.admin}. Så fort ${state.admin} godkänner kan du sätta igång.`);
  const pr = $('#admin-requests');
  pr.hidden = !(state.isAdmin && state.pendingCount);
  if (!pr.hidden) pr.innerHTML = `<button type="button" class="banner-btn" id="admin-requests-open">🚪 ${L(`${state.pendingCount} ${state.pendingCount === 1 ? 'Anfrage wartet' : 'Anfragen warten'} auf dich (Beitritt / Passwort)`, `${state.pendingCount} ${state.pendingCount === 1 ? 'request is' : 'requests are'} waiting for you (join / password)`, `${state.pendingCount} ${state.pendingCount === 1 ? 'förfrågan väntar' : 'förfrågningar väntar'} på dig (medlem / lösenord)`)} ›</button>`;
  $('#auth-start').hidden = view !== 'start';
  $('#login-form').hidden = view !== 'login';
  $('#register-form').hidden = view !== 'register';
  $('#auth-pick').hidden = view !== 'pick';
  $('#admin-box').hidden = !state.isAdmin;
  // Ohne Auswahl ist nur „Wer bist du?“ (bzw. Beitreten) zu sehen
  document.body.classList.toggle('no-me', !state.me);
  $('#who-line').textContent = state.me ? L(`Hallo ${state.me} 👋`, `Hi ${state.me} 👋`, `Hej ${state.me} 👋`) : 'Mission Haussegen';
  $('#people-buttons').innerHTML = state.people.map((p) => (memberOf(p)?.claimed
    ? `<button type="button" disabled class="taken">${avatar(p, 'sm')}${esc(p)} <span class="lock" title="${L('vergeben', 'taken', 'upptagen')}">🔒</span></button>`
    : `<button type="button" data-me="${esc(p)}">${avatar(p, 'sm')}${esc(p)}</button>`)).join('');
  // Sprachknopf oben nur, solange noch niemand ausgewählt ist (sonst in den Einstellungen)
  const quick = $('#lang-quick');
  quick.hidden = !!state.me;
  quick.textContent = { de: '🇬🇧 English', en: '🇸🇪 Svenska', sv: '🇩🇪 Deutsch' }[state.lang];
  document.querySelectorAll('#set-lang [data-lang]').forEach((b) => b.setAttribute('aria-checked', b.dataset.lang === state.lang));
  $('#settings').hidden = !state.me;
}

function weekTitle(monday) {
  const diff = Math.round((Date.parse(monday) - Date.parse(state.current)) / (7 * 86400000));
  if (diff === 0) return L('Diese Woche', 'This week', `Den här veckan`);
  if (diff === 1) return L('Nächste Woche', 'Next week', `Nästa vecka`);
  if (diff === -1) return L('Letzte Woche', 'Last week', `Förra veckan`);
  return diff > 0 ? L(`In ${diff} Wochen`, `In ${diff} weeks`, `Om ${diff} veckor`) : L(`Vor ${-diff} Wochen`, `${-diff} weeks ago`, `För ${-diff} veckor sedan`);
}

function renderWeek() {
  const w = state.weeks.get(state.view);
  if (!w) return;
  $('#week-title').textContent = weekTitle(w.monday);
  $('#week-range').textContent = `${ddmm(w.monday)} – ${ddmm(w.sunday)}`;

  let html = '';
  const contact = state.cleanerContact;
  const contactLine = `<p class="muted small">${L('Zuständig für die Putzkraft', 'In charge of the cleaner', `Ansvarig för städhjälpen`)}: <strong>${contact ? esc(contact) : L('niemand', 'nobody', `ingen`)}</strong>
    <button class="link" data-cleaner-contact>${L('ändern', 'change', `ändra`)}</button></p>`;
  const whenD = (d) => `${wd(d)} ${ddmm(d)}`;
  if (w.extra) {
    html += `<div class="banner"><p>${L(`🧹 <strong>Putzkraft kommt ${cleanerWhen(w)}</strong> ✓ <span class="muted">(${w.extraFrom ? `verschoben aus der Woche ab ${ddmm(w.extraFrom)}` : 'Zusatztermin'})</span> und putzt Bäder, Böden und Müll.`,
      `🧹 <strong>The cleaner comes ${cleanerWhen(w)}</strong> ✓ <span class="muted">(${w.extraFrom ? `moved from the week of ${ddmm(w.extraFrom)}` : 'extra visit'})</span> and cleans bathrooms, floors and bins.`, `🧹 <strong>Städhjälpen kommer ${cleanerWhen(w)}</strong> ✓ <span class="muted">(${w.extraFrom ? `flyttad från veckan ${ddmm(w.extraFrom)}` : 'extrabesök'})</span> och städar badrum, golv och sopor.`)}</p>
      <div class="row"><button class="link" data-cleaner-visit>${L('Termin ändern', 'Change date', `Ändra tid`)}</button>
      <button class="link" data-cleaner-extra-remove>${w.extraFrom ? L('Zurück in die alte Woche', 'Back to the original week', `Tillbaka till ursprungliga veckan`) : L('Zusatztermin löschen', 'Delete extra visit', `Ta bort extrabesök`)}</button></div>
      ${contactLine}</div>`;
  } else if (w.movedTo) {
    html += `<div class="banner"><p>${L(`📅 <strong>Putzkraft wurde auf ${whenD(w.movedTo)} verschoben.</strong> Diese Woche putzen wir selbst.`,
      `📅 <strong>The cleaner was moved to ${whenD(w.movedTo)}.</strong> This week we clean ourselves.`, `📅 <strong>Städhjälpen har flyttats till ${whenD(w.movedTo)}.</strong> Den här veckan städar vi själva.`)}</p>
      <div class="row"><button class="link" data-cleaner-unmove>${L('Verschiebung rückgängig', 'Undo move', `Ångra flytt`)}</button></div>
      ${contactLine}</div>`;
  } else if (w.plannedCleaner) {
    const isContact = state.me && state.me === contact;
    html += `<div class="banner"><p>${w.ausfall
      ? L('⚠️ <strong>Putzkraft fällt aus.</strong> Diese Woche putzen wir selbst (Intensivputz). Ab nächster Woche ist der Plan eine Woche später dran.',
        "⚠️ <strong>Cleaner cancelled.</strong> This week we clean ourselves (deep clean). From next week the rota moves back one week.", `⚠️ <strong>Städhjälpen är inställd.</strong> Den här veckan städar vi själva (storstäd). Från nästa vecka flyttas schemat en vecka framåt.`)
      : L(`🧹 <strong>Putzkraft kommt ${cleanerWhen(w)}</strong>${w.cleanerConfirmed ? ' ✓' : ' <span class="muted">(laut Plan, noch nicht bestätigt)</span>'} und putzt Bäder, Böden und Müll.`,
        `🧹 <strong>The cleaner comes ${cleanerWhen(w)}</strong>${w.cleanerConfirmed ? ' ✓' : ' <span class="muted">(as planned, not confirmed yet)</span>'} and cleans bathrooms, floors and bins.`, `🧹 <strong>Städhjälpen kommer ${cleanerWhen(w)}</strong>${w.cleanerConfirmed ? ' ✓' : ' <span class="muted">(enligt plan, inte bekräftat än)</span>'} och städar badrum, golv och sopor.`)}</p>
      ${isContact && !w.ausfall && !w.cleanerConfirmed ? `<p class="small">${L('<strong>Du stimmst die Termine mit der Putzkraft ab:</strong> Kommt sie diese Woche? Dann trag bitte Tag und Uhrzeit ein.', '<strong>You arrange the dates with the cleaner:</strong> Is she coming this week? Then please enter the day and time.', `<strong>Du bokar tider med städhjälpen:</strong> Kommer hon den här veckan? Fyll i så fall i dag och tid.`)}</p>` : ''}
      <div class="row">${w.ausfall ? '' : `<button class="link" data-cleaner-visit>${w.cleanerConfirmed ? L('Termin ändern', 'Change date', `Ändra tid`) : L('Tag & Uhrzeit eintragen', 'Enter day & time', `Fyll i dag & tid`)}</button>`}
      <button class="link" data-ausfall="${w.ausfall ? 0 : 1}">${w.ausfall ? L('Doch nicht ausgefallen', 'Not cancelled after all', `Inte inställd ändå`) : L('Putzkraft fällt aus?', 'Cleaner cancelled?', `Städhjälpen inställd?`)}</button></div>
      ${contactLine}</div>`;
  } else {
    html += `<div class="banner"><p>${L('🫧 <strong>Woche ohne Putzkraft.</strong> Wir putzen selbst.', '🫧 <strong>Week without the cleaner.</strong> We clean ourselves.', `🫧 <strong>Vecka utan städhjälp.</strong> Vi städar själva.`)}</p>
      <div class="row"><button class="link" data-cleaner-add>${L('Putzkraft kommt diese Woche doch?', 'Cleaner coming this week after all?', `Kommer städhjälpen ändå den här veckan?`)}</button></div>${contactLine}</div>`;
  }

  if (w.away && w.away.length) {
    const names = `<strong>${w.away.map(esc).join(', ')}</strong>`;
    html += `<div class="banner"><p>🏖️ ${L(`${names} ${w.away.length > 1 ? 'sind' : 'ist'} diese Woche weg und wurde${w.away.length > 1 ? 'n' : ''} im Plan übersprungen.`,
      `${names} ${w.away.length > 1 ? 'are' : 'is'} away this week and ${w.away.length > 1 ? 'were' : 'was'} skipped on the rota.`, `${names} är borta den här veckan och hoppas över i schemat.`)}</p></div>`;
  }
  if (w.monday === state.current && state.gami) html += `<p class="streak-line plan-streak">${streakLine()}</p>`;
  const tasks = [...w.tasks].sort((a, b) => (b.person === state.me) - (a.person === state.me));
  for (const t of tasks) {
    const items = t.items;
    const doneCount = items.filter((it) => w.checks[`${t.key}:${it.id}`]).length;
    const mine = t.person === state.me || items.some((it) => it.person === state.me);
    const complete = items.length > 0 && doneCount === items.length;
    html += `<article class="card task${mine ? ' mine' : ''}${complete ? ' complete' : ''}">
      <header><h3>${esc(T(t.title))}</h3>${t.person ? `<span class="person">${esc(t.person)}${t.person !== t.planned ? ` <span class="swapped">(${L('statt', 'instead of', `i stället för`)} ${esc(t.planned)})</span>` : ''}</span>` : `<span class="muted small">${doneCount}/${items.length}</span>`}</header>
      ${t.note ? `<p class="note">${esc(T(t.note))}</p>` : ''}
      ${items.map((it) => {
        const key = `${t.key}:${it.id}`;
        const c = w.checks[key];
        return `<label class="check${c ? ' done' : ''}"><input type="checkbox" data-check="${esc(key)}" ${c ? 'checked' : ''}>
          <span>${esc(T(it.label))}${c?.by ? `<small>${L('erledigt von', 'done by', `klart av`)} ${esc(c.by)}</small>` : ''}</span></label>`;
      }).join('')}
      ${doneCount ? reactBar(`task:${w.monday}:${t.key}`, [...new Set(items.map((it) => w.checks[`${t.key}:${it.id}`]?.by).filter(Boolean))]) : ''}
      ${t.person ? (() => {
        const req = openSwaps().find((r) => r.monday === w.monday && r.task === t.key);
        const canRemind = state.me && t.person !== state.me && !complete && w.monday <= state.current;
        return `<div class="actions">${canRemind ? `<button class="ghost small" data-remind="${t.key}">🔔 ${L('Erinnern', 'Remind', 'Påminn')}</button>` : ''}${req ? `<span class="muted small">⏳ ${L(`Tausch-Anfrage an ${esc(req.to)} läuft`, `Swap request to ${esc(req.to)} pending`, `Bytesförfrågan till ${esc(req.to)} väntar`)}</span>` : ''}<button class="ghost small" data-swap="${t.key}">${L('Tauschen', 'Swap', `Byt`)}</button></div>`;
      })() : ''}
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
      <td>${w.cleaner ? wd(w.cleanerDay) : w.ausfall ? L('fällt aus', 'cancelled', `inställd`) : w.movedTo ? L('verschoben', 'moved', `flyttad`) : '–'}</td>
      <td>${p('woche')}</td><td>${p('bad-vorne')}</td><td>${p('bad-hinten')}</td></tr>`);
  }
  $('#upcoming').innerHTML = rows.join('');
}

// ---------------- Anmeldung ----------------
async function afterLogin() {
  state.weeks.clear();
  state.authView = null;
  await load();
  showTab();
  if (state.me) api('shop').then((d) => { state.shop = d; renderShop(); }).catch(() => {});
}
document.addEventListener('click', (e) => {
  if (e.target.closest('#go-login')) { state.authView = 'login'; renderMe(); $('#login-user').focus(); }
  else if (e.target.closest('#go-register')) { state.authView = 'register'; renderMe(); $('#reg-user').focus(); }
  else if (e.target.closest('[data-auth-back]')) { state.authView = 'start'; if (location.hash === '#beitreten') history.replaceState(null, '', '#start'); renderMe(); }
});
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('auth/login', { username: $('#login-user').value, password: $('#login-pw').value });
    store.set('token', r.token);
    $('#login-pw').value = '';
    await afterLogin();
    if (state.me) { toast(L(`Hallo ${state.me} 👋`, `Hi ${state.me} 👋`, `Hej ${state.me} 👋`)); maybeAskProfile(); }
  } catch (err) { toast(err.message); }
});
$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if ($('#reg-pw').value !== $('#reg-pw2').value) { toast(L('Die Passwörter sind nicht gleich.', "The passwords don't match.", 'Lösenorden matchar inte.')); return; }
  try {
    const r = await api('auth/register', { username: $('#reg-user').value, password: $('#reg-pw').value });
    store.set('token', r.token);
    $('#reg-pw').value = ''; $('#reg-pw2').value = '';
    await afterLogin();
    toast(L('Account erstellt 🎉', 'Account created 🎉', 'Konto skapat 🎉'));
  } catch (err) { toast(err.message); }
});
$('#auth-forgot').onclick = async () => {
  let name = $('#login-user').value.trim();
  if (!name) name = (prompt(L('Wie ist dein Name (Benutzername oder Vorname)?', 'What is your name (username or first name)?', 'Vad heter du (användarnamn eller förnamn)?')) || '').trim();
  if (!name) return;
  try {
    const r = await api('auth/forgot', { username: name });
    alert(L(`${r.admin} bekommt Bescheid und setzt dir ein neues Passwort. Du erfährst es dann direkt von ${r.admin}.`, `${r.admin} will be notified and will set a new password for you. ${r.admin} will tell you directly.`, `${r.admin} får en notis och sätter ett nytt lösenord åt dig. ${r.admin} berättar det direkt för dig.`));
  } catch (err) { toast(err.message); }
};
$('#pw-change').onclick = async () => {
  const old = prompt(L('Altes Passwort:', 'Current password:', 'Nuvarande lösenord:'));
  if (old === null) return;
  const pw = prompt(L('Neues Passwort (mind. 4 Zeichen):', 'New password (at least 4 characters):', 'Nytt lösenord (minst 4 tecken):'));
  if (pw === null) return;
  try { await api('auth/password', { old, password: pw }); toast(L('Passwort geändert 🔑', 'Password changed 🔑', 'Lösenordet är ändrat 🔑')); } catch (err) { toast(err.message); }
};
async function openAdmin(data) {
  const d = data || await api('auth/admin/list');
  $('#swap-title').textContent = L('🔑 Accounts verwalten', '🔑 Manage accounts', '🔑 Hantera konton');
  $('#swap-text').textContent = L('Nur du siehst das. Du kannst ein neues Passwort setzen (die Person wird abgemeldet) oder einen Account löschen, dann ist die Person wieder frei.', 'Only you can see this. You can set a new password (the person gets signed out) or delete an account, which frees the person again.', 'Bara du ser detta. Du kan sätta ett nytt lösenord (personen loggas ut) eller ta bort ett konto, då blir personen ledig igen.');
  const pend = d.accounts.filter((a) => a.pending);
  const forgot = d.accounts.filter((a) => a.forgot);
  const forgotHtml = forgot.length ? `<h3 class="add-h">🔑 ${L('Passwort vergessen', 'Forgotten passwords', 'Glömda lösenord')}</h3>${forgot.map((a) => `<div class="acct-row pending"><div><strong>${esc(a.person || a.username)}</strong> <span class="muted small">${L('Name', 'Name', 'Namn')}: ${esc(a.username)}</span></div><div class="row"><button type="button" class="small" data-acct-pw="${esc(a.username)}">${L('Neues Passwort setzen', 'Set new password', 'Sätt nytt lösenord')}</button></div></div>`).join('')}` : '';
  const pendHtml = pend.length ? `<h3 class="add-h">🚪 ${L('Anfragen', 'Requests', 'Förfrågningar')}</h3>${pend.map((a) => `<div class="acct-row pending"><div><strong>${esc(a.pending.person)}</strong> <span class="muted small">${a.pending.type === 'join' ? L(`neu in der WG, Zimmer ${a.pending.side}`, `new flatmate, ${a.pending.side === 'vorne' ? 'front' : 'back'} room`, `ny i kollektivet, rum ${a.pending.side === 'vorne' ? 'fram' : 'bak'}`) : L('möchte diese Person sein', 'wants to be this person', 'vill vara den här personen')} · ${L('Name', 'Name', 'Namn')}: ${esc(a.username)}</span></div>
    <div class="row"><button type="button" class="small" data-acct-ok="${esc(a.username)}">✓ ${L('Zulassen', 'Approve', 'Godkänn')}</button><button type="button" class="ghost small" data-acct-no="${esc(a.username)}">${L('Ablehnen', 'Decline', 'Avböj')}</button></div></div>`).join('')}<h3 class="add-h">${L('Alle Accounts', 'All accounts', 'Alla konton')}</h3>` : '';
  const heirs = d.accounts.filter((a) => a.person && a.person !== state.me).map((a) => a.person);
  const transferHtml = `<h3 class="add-h">👑 ${L('Admin übergeben', 'Hand over admin', 'Lämna över administratör')}</h3><p class="muted small" style="width:100%;margin:0 0 6px">${L('Zum Beispiel bevor du ausziehst. Die neue Person kann dann Mitglieder zulassen und Passwörter zurücksetzen, du nicht mehr.', 'For example before you move out. The new person can then approve members and reset passwords, and you no longer can.', 'Till exempel innan du flyttar ut. Den nya personen kan då godkänna medlemmar och återställa lösenord, inte du längre.')}</p>${heirs.map((p) => `<button type="button" class="ghost small" data-admin-to="${esc(p)}">${avatar(p, 'sm')}${esc(p)}</button>`).join('') || `<p class="muted small">${L('Noch niemand sonst hat einen Account.', 'Nobody else has an account yet.', 'Ingen annan har ett konto än.')}</p>`}`;
  $('#swap-people').innerHTML = forgotHtml + pendHtml + (forgot.length && !pend.length ? `<h3 class="add-h">${L('Alle Accounts', 'All accounts', 'Alla konton')}</h3>` : '') + d.accounts.filter((a) => !a.pending || a.person).map((a) => `<div class="acct-row"><div>${a.person ? avatar(a.person, 'sm') : ''}<strong>${esc(a.person || L('(noch keine Person)', '(no person yet)', '(ingen person än)'))}</strong> <span class="muted small">${L('Name', 'Name', 'Namn')}: ${esc(a.username)}</span></div>
    <div class="row"><button type="button" class="ghost small" data-acct-pw="${esc(a.username)}">${L('Neues Passwort', 'New password', 'Nytt lösenord')}</button>${a.person === state.me ? '' : `<button type="button" class="ghost small" data-acct-del="${esc(a.username)}">${L('Löschen', 'Delete', 'Ta bort')}</button>`}</div></div>`).join('') + transferHtml;
  $('#swap-people').onclick = async (e) => {
    const pw = e.target.closest('[data-acct-pw]');
    const del = e.target.closest('[data-acct-del]');
    const ok = e.target.closest('[data-acct-ok]');
    const no = e.target.closest('[data-acct-no]');
    const to = e.target.closest('[data-admin-to]');
    try {
      if (ok || no) {
        const nd = await api(ok ? 'auth/admin/approve' : 'auth/admin/decline', { username: (ok || no).dataset[ok ? 'acctOk' : 'acctNo'] });
        state.pendingCount = nd.accounts.filter((a) => a.pending || a.forgot).length;
        renderMe();
        await openAdmin(nd);
        toast(ok ? L('Zugelassen 🎉', 'Approved 🎉', 'Godkänd 🎉') : L('Abgelehnt', 'Declined', 'Avböjd'));
        if (ok) { state.weeks.clear(); load().catch(() => {}); }
        return;
      }
      if (to) {
        const p = to.dataset.adminTo;
        if (!confirm(L(`${p} zum Admin machen? Danach kannst du keine Mitglieder mehr zulassen und keine Passwörter mehr zurücksetzen.`, `Make ${p} the admin? Afterwards you can no longer approve members or reset passwords.`, `Göra ${p} till administratör? Efteråt kan du inte längre godkänna medlemmar eller återställa lösenord.`))) return;
        await api('auth/admin/transfer', { person: p });
        $('#swap-dialog').close();
        state.isAdmin = false; state.admin = p;
        renderMe();
        toast(L(`${p} ist jetzt Admin 👑`, `${p} is now the admin 👑`, `${p} är nu administratör 👑`));
        return;
      }
      if (pw) {
        const np = prompt(L(`Neues Passwort für ${pw.dataset.acctPw} (mind. 4 Zeichen). Sag es der Person danach.`, `New password for ${pw.dataset.acctPw} (at least 4 characters). Tell them afterwards.`, `Nytt lösenord för ${pw.dataset.acctPw} (minst 4 tecken). Berätta det för personen efteråt.`));
        if (!np) return;
        const nd = await api('auth/admin/password', { username: pw.dataset.acctPw, password: np });
        state.pendingCount = nd.accounts.filter((a) => a.pending || a.forgot).length;
        renderMe();
        await openAdmin(nd);
        toast(L('Passwort gesetzt', 'Password set', 'Lösenordet är satt'));
      } else if (del) {
        if (!confirm(L(`Account „${del.dataset.acctDel}“ wirklich löschen? Die Person kann dann neu gewählt werden.`, `Really delete the account "${del.dataset.acctDel}"? The person can then be chosen again.`, `Vill du verkligen ta bort kontot "${del.dataset.acctDel}"? Personen kan då väljas igen.`))) return;
        await openAdmin(await api('auth/admin/delete', { username: del.dataset.acctDel }));
      }
    } catch (err) { toast(err.message); }
  };
  const dlg = $('#swap-dialog');
  if (!dlg.open) dlg.showModal();
}
$('#admin-open').onclick = () => openAdmin().catch((err) => toast(err.message));
document.addEventListener('click', (e) => { if (e.target.closest('#admin-requests-open')) openAdmin().catch((err) => toast(err.message)); });
$('#wait-refresh').onclick = async () => { await afterLogin(); if (state.me) toast(L(`Du bist drin 🎉 Willkommen, ${state.me}!`, `You're in 🎉 Welcome, ${state.me}!`, `Du är inne 🎉 Välkommen, ${state.me}!`)); else toast(L('Noch nicht freigegeben ⏳', 'Not approved yet ⏳', 'Inte godkänd än ⏳')); };
$('#wait-cancel').onclick = async () => { if (!confirm(L('Anfrage zurückziehen?', 'Withdraw your request?', 'Dra tillbaka förfrågan?'))) return; try { await api('auth/cancel', {}); await load(); } catch (err) { toast(err.message); } };

// ---------------- Gamification ----------------
function cheer() {
  const list = [
    L('Erledigt! Die WG verneigt sich 🙇', 'Done! The flat bows to you 🙇', 'Klart! Kollektivet bugar sig 🙇'),
    L('Glänzt wie neu ✨', 'Shiny as new ✨', 'Skiner som ny ✨'),
    L('Haussegen gerettet 🏡', 'House peace saved 🏡', 'Husfriden räddad 🏡'),
    L('Legendär. Einfach legendär. 🏆', 'Legendary. Simply legendary. 🏆', 'Legendariskt. Helt enkelt legendariskt. 🏆'),
    L('Die Staubmäuse haben keine Chance 🐭💨', 'The dust bunnies stand no chance 🐭💨', 'Dammråttorna har ingen chans 🐭💨'),
    L('Danke! Du bist ein Schatz 💛', "Thanks! You're a gem 💛", 'Tack! Du är en pärla 💛'),
    L('Check! Weiter so 💪', 'Check! Keep it up 💪', 'Check! Fortsätt så 💪'),
  ];
  return list[Math.floor(Math.random() * list.length)];
}
function confetti(n = 120) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const c = document.createElement('canvas');
  c.className = 'confetti';
  const dpr = devicePixelRatio || 1;
  c.width = innerWidth * dpr; c.height = innerHeight * dpr;
  document.body.appendChild(c);
  const x = c.getContext('2d'); x.scale(dpr, dpr);
  const colors = ['#ffcc33', '#ff6b6b', '#6cc4a8', '#5aa9ff', '#c38bff', '#ff9f43'];
  const ps = Array.from({ length: n }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 80, y: innerHeight * 0.45,
    vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 14 - 4, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.4,
    w: 6 + Math.random() * 6, h: 4 + Math.random() * 4, c: colors[Math.floor(Math.random() * colors.length)],
  }));
  const t0 = performance.now();
  const step = (t) => {
    x.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of ps) {
      p.vy += 0.35; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      x.save(); x.translate(p.x, p.y); x.rotate(p.r); x.fillStyle = p.c; x.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); x.restore();
    }
    if (t - t0 < 2600) requestAnimationFrame(step); else c.remove();
  };
  requestAnimationFrame(step);
}
const BADGES = [
  { id: 'tasks', icon: '🧽', name: () => L('Putzteufel', 'Clean machine', 'Städdjävul'), desc: (n) => L(`${n} Dienste komplett erledigt`, `${n} duties fully done`, `${n} tjänster helt klara`), tiers: [1, 10, 25, 50] },
  { id: 'baths', icon: '🚿', name: () => L('Bad-Profi', 'Bathroom pro', 'Badrumsproffs'), desc: (n) => L(`${n}× Bad geputzt`, `${n}× bathroom cleaned`, `${n}× badrum städat`), tiers: [1, 10, 25] },
  { id: 'punctual', icon: '⏰', name: () => L('Immer pünktlich', 'Always on time', 'Alltid i tid'), desc: (n) => L(`${n} Wochen alles vor Freitag 18 Uhr erledigt`, `${n} weeks with everything done before Friday 6 pm`, `${n} veckor med allt klart före fredag kl. 18`), tiers: [3, 10, 25] },
  { id: 'rescue', icon: '🦸', name: (p) => L(G(p, 'Retterin', 'Retter', 'Retter:in'), 'Rescuer', 'Räddare'), desc: (n) => L(`${n}× für jemand anderen eingesprungen`, `${n}× stepped in for someone`, `${n}× hoppat in för någon`), tiers: [1, 5, 15] },
  { id: 'bought', icon: '🛒', name: (p) => L(G(p, 'Einkaufsheldin', 'Einkaufsheld', 'Einkaufsheld:in'), 'Shopping hero', 'Inköpshjälte'), desc: (n) => L(`${n} Sachen von der Einkaufsliste gekauft`, `${n} things bought from the list`, `${n} saker köpta från listan`), tiers: [5, 20, 50] },
  { id: 'fridge', icon: '🧊', name: () => L('Kühlschrank-Ordnung', 'Fridge keeper', 'Kylskåpsordning'), desc: (n) => L(`${n}× Kühlschrankfach geputzt`, `${n}× fridge shelf cleaned`, `${n}× kylskåpshylla städad`), tiers: [1, 6, 12] },
];
function badgesOf(p) {
  const s = state.gami?.stats?.[p] || {};
  return BADGES.map((b) => {
    const n = s[b.id] || 0;
    const level = b.tiers.filter((t) => n >= t).length;
    return { ...b, n, level, next: b.tiers[level] };
  });
}
function badgeHtml(b, p) {
  const stars = b.level ? '⭐'.repeat(b.level) : '';
  return `<div class="bdg${b.level ? '' : ' locked'}"><span class="b-icon">${b.icon}</span><div><strong>${esc(b.name(p))}</strong> <span class="stars">${stars}</span>
    <small>${b.desc(b.n)}${b.next ? ` · ${L(`nächste Stufe bei ${b.next}`, `next level at ${b.next}`, `nästa nivå vid ${b.next}`)}` : ` · ${L('höchste Stufe!', 'top level!', 'högsta nivån!')}`}</small></div></div>`;
}
function streakLine() {
  const g = state.gami;
  if (!g) return '';
  return g.streak
    ? `🔥 ${L(`WG-Streak: <strong>${g.streak} ${g.streak === 1 ? 'Woche' : 'Wochen'}</strong> alles erledigt`, `Flat streak: <strong>${g.streak} ${g.streak === 1 ? 'week' : 'weeks'}</strong> all done`, `Kollektivets streak: <strong>${g.streak} ${g.streak === 1 ? 'vecka' : 'veckor'}</strong> allt klart`)}${g.best > g.streak ? ` <span class="muted small">(${L('Rekord', 'record', 'rekord')}: ${g.best})</span>` : ''}`
    : `🔥 ${L('Startet einen WG-Streak: Diese Woche alles erledigen!', 'Start a flat streak: get everything done this week!', 'Starta en streak: gör allt den här veckan!')}`;
}
function checkNewBadges() {
  if (!state.me || !state.gami) return;
  const key = `badges:${state.me}`;
  let seen = {};
  try { seen = JSON.parse(localStorage.getItem(key) || '{}'); } catch { /* egal */ }
  const now = Object.fromEntries(badgesOf(state.me).map((b) => [b.id, b.level]));
  const fresh = badgesOf(state.me).find((b) => b.level > (seen[b.id] ?? b.level));
  try { localStorage.setItem(key, JSON.stringify(now)); } catch { /* egal */ }
  if (fresh) setTimeout(() => { confetti(160); toast(`${L('Neues Abzeichen', 'New badge', 'Nytt märke')}: ${fresh.icon} ${fresh.name(state.me)} ${'⭐'.repeat(fresh.level)}`); }, 1400);
}
function openBadges() {
  const me = state.me;
  $('#swap-title').textContent = L('🏅 Abzeichen', '🏅 Badges', '🏅 Märken');
  $('#swap-text').innerHTML = streakLine();
  const others = state.people.filter((p) => p !== me);
  $('#swap-people').innerHTML = `<h3 class="add-h">${L('Deine', 'Yours', 'Dina')}</h3><div class="bdg-list">${badgesOf(me).map((b) => badgeHtml(b, me)).join('')}</div>
    <h3 class="add-h">${L('Die anderen', 'The others', 'De andra')}</h3>${others.map((p) => `<p class="b-row">${avatar(p, 'sm')} <strong>${esc(p)}</strong> ${badgesOf(p).filter((b) => b.level).map((b) => `<span title="${esc(b.name(p))}">${b.icon}${b.level > 1 ? `<sup>${b.level}</sup>` : ''}</span>`).join(' ') || `<span class="muted small">${L('noch keine', 'none yet', 'inga än')}</span>`}</p>`).join('')}`;
  $('#swap-people').onclick = null;
  const dlg = $('#swap-dialog');
  const btn = dlg.querySelector('button[value=cancel]');
  btn.textContent = L('Schließen', 'Close', 'Stäng');
  dlg.addEventListener('close', () => { btn.textContent = L('Abbrechen', 'Cancel', 'Avbryt'); }, { once: true });
  dlg.showModal();
}

// ---------------- Reaktionen ----------------
const REACTIONS = ['🙏', '❤️', '🎉', '👍', '😂', '🔥'];
function reactBar(target, owners = []) {
  const r = (state.reactions || {})[target] || {};
  const chips = Object.entries(r).map(([e, who]) => `<button type="button" class="react-chip" data-react="${esc(target)}" data-emoji="${e}" aria-pressed="${who.includes(state.me)}" title="${esc(who.join(', '))}">${e} <span>${who.length > 2 ? who.length : who.map(esc).join(', ')}</span></button>`).join('');
  const canAdd = state.me && !owners.includes(state.me);
  return `<div class="reacts">${chips}${canAdd ? `<span class="react-add"><button type="button" class="react-plus" data-react-open aria-label="${L('Reagieren', 'React', 'Reagera')}">😊+</button><span class="react-pick" hidden>${REACTIONS.map((e) => `<button type="button" data-react="${esc(target)}" data-emoji="${e}">${e}</button>`).join('')}</span></span>` : ''}</div>`;
}
document.addEventListener('click', async (e) => {
  const open = e.target.closest('[data-react-open]');
  if (open) {
    const pk = open.nextElementSibling;
    document.querySelectorAll('.react-pick').forEach((x) => { if (x !== pk) x.hidden = true; });
    pk.hidden = !pk.hidden;
    return;
  }
  const b = e.target.closest('[data-react]');
  if (!b) { document.querySelectorAll('.react-pick').forEach((x) => { x.hidden = true; }); return; }
  if (!state.me) return;
  try {
    state.reactions = (await api('react', { target: b.dataset.react, emoji: b.dataset.emoji, by: state.me })).reactions;
    renderWeek();
    renderHome();
  } catch (err) { toast(err.message); }
});

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
    ? `<div class="banner"><p>🔔 ${L('Erinnerungen sind noch aus.', 'Reminders are still off.', `Påminnelserna är fortfarande avstängda.`)}</p><button class="link" data-open-settings>${L('In den Einstellungen einschalten', 'Turn on in settings', `Slå på i inställningarna`)}</button></div>`
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
        <li>Open the app from your home screen and tap "Turn on reminders" here.</li></ol>`, `<h3>🔔 Påminnelser på din iPhone</h3>
        <p>För att din iPhone ska kunna påminna dig, lägg till den här sidan på hemskärmen en gång:</p>
        <ol class="steps"><li>Tryck på <strong>Dela</strong> längst ner i Safari (fyrkant med pil).</li>
        <li>Välj <strong>Lägg till på hemskärmen</strong>.</li>
        <li>Öppna appen från hemskärmen och tryck här på "Slå på påminnelser".</li></ol>`);
      nudge(true);
    } else {
      body.innerHTML = L('<h3>🔔 Erinnerungen</h3><p class="muted">Dieser Browser kann leider keine Erinnerungen empfangen. Probier es mit Chrome, Firefox, Edge oder Safari.</p>',
        "<h3>🔔 Reminders</h3><p class=\"muted\">Sorry, this browser can't receive reminders. Try Chrome, Firefox, Edge or Safari.</p>", `<h3>🔔 Påminnelser</h3><p class="muted">Tyvärr kan den här webbläsaren inte ta emot påminnelser. Testa Chrome, Firefox, Edge eller Safari.</p>`);
      nudge(false);
    }
    return;
  }

  const sub = await currentSubscription();
  if (sub) {
    // Server-Zuordnung aktuell halten (z.B. nach "Mitglied wechseln")
    api('subscribe', { person: state.me, subscription: sub.toJSON() }).catch(() => {});
    body.innerHTML = `<div class="row" style="justify-content:space-between">
      <p style="margin:0">🔔 <strong>${L('Erinnerungen sind an.', 'Reminders are on.', `Påminnelserna är på.`)}</strong><br><span class="muted small">${L('Sonntag 19 Uhr für die neue Woche, Freitag 18 Uhr falls noch was offen ist.', 'Sunday 7 pm for the new week, Friday 6 pm if something is still open.', `Söndag kl. 19 för den nya veckan, fredag kl. 18 om något fortfarande är kvar.`)}</span></p>
      <div class="row"><button class="ghost small" id="test-push">Test</button><button class="link" id="push-off">${L('Ausschalten', 'Turn off', `Stäng av`)}</button></div></div>`;
    $('#test-push').onclick = async () => {
      try { await api('test', { endpoint: sub.endpoint }); toast(L('Test-Nachricht ist unterwegs', 'Test notification is on its way', `Testnotisen är på väg`)); } catch (e) { toast(e.message); }
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
      '<h3>🔔 Reminders blocked</h3><p class="muted">You blocked notifications for this page. Allow them in your browser or phone settings and reload the page.</p>', `<h3>🔔 Påminnelser blockerade</h3><p class="muted">Du har blockerat notiser för den här sidan. Tillåt dem i webbläsarens eller telefonens inställningar och ladda om sidan.</p>`);
    nudge(false);
    return;
  }
  body.innerHTML = `<h3>🔔 ${L('Erinnerungen bekommen', 'Get reminders', `Få påminnelser`)}</h3>
    <p>${L('Sonntagabend siehst du, was in der neuen Woche ansteht. Wenn am Freitag noch etwas nicht abgehakt ist, kommt eine kurze Erinnerung.', "On Sunday evening you'll see what's coming up in the new week. If something isn't ticked off by Friday, you'll get a short reminder.", `På söndagskvällen ser du vad som väntar den nya veckan. Om något inte är avbockat till fredag får du en kort påminnelse.`)}</p>
    <button id="push-on">${L('Erinnerungen aktivieren', 'Turn on reminders', `Slå på påminnelser`)}</button>`;
  $('#push-on').onclick = enablePush;
  nudge(true);
}

async function enablePush() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { renderNotify(); return; }
    const { publicKey } = await api('vapid');
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
    await api('subscribe', { person: state.me, subscription: sub.toJSON() });
    toast(L('Erinnerungen sind an 🎉', 'Reminders are on 🎉', `Påminnelserna är på 🎉`));
  } catch (e) {
    toast(L(`Hat nicht geklappt: ${e.message}`, `That didn't work: ${e.message}`, `Det fungerade inte: ${e.message}`));
  }
  renderNotify();
}

// ---------------- Events ----------------
document.addEventListener('click', async (e) => {
  const meBtn = e.target.closest('[data-me]');
  if (meBtn && meBtn.closest('#people-buttons')) {
    const who = meBtn.dataset.me;
    if (!confirm(L(`Bist du ${who}? Das wird fest mit deinem Account verbunden.`, `Are you ${who}? This will be permanently linked to your account.`, `Är du ${who}? Det kopplas permanent till ditt konto.`))) return;
    let cr;
    try { cr = await api('auth/claim', { person: who }); } catch (err) { toast(err.message); loadLogin().catch(() => {}); return; }
    if (cr.pending) { await load(); return; }
    await afterLogin();
    // Erstes Mal: Profil einrichten (überspringbar), danach Einstellungen aufgeklappt zeigen
    state.askedProfile = true;
    openProfile(true);
    $('#profile-dialog').addEventListener('close', () => {
      $('#settings').open = true;
      setTimeout(() => $('#settings').scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    }, { once: true });
    return;
  }
  const notesBtn = e.target.closest('#home [data-notes]');
  if (notesBtn) { openNotes(notesBtn.dataset.notes); return; }
  if (e.target.closest('[data-open-settings]')) {
    location.hash = '#start';
    setTimeout(() => { $('#settings').open = true; $('#settings').scrollIntoView({ behavior: 'smooth' }); }, 50);
    return;
  }
  if (e.target.closest('[data-note-add]')) { openNoteDialog(); return; }
  if (e.target.closest('[data-open-badges]') && !state.editHome) { openBadges(); return; }
  const nd = e.target.closest('[data-note-del]');
  if (nd) {
    if (!confirm(L('Zettel von der Pinnwand abnehmen?', 'Take this note off the board?', 'Ta ner lappen från anslagstavlan?'))) return;
    try { state.board = (await api('board/delete', { id: nd.dataset.noteDel })).board; renderHome(); } catch (err) { toast(err.message); }
    return;
  }
  const sc = e.target.closest('[data-shortcut]');
  if (sc && !state.editHome) { runShortcut(sc.dataset.shortcut); return; }
  if (state.editHome && e.target.closest('.tile-edit') && !e.target.closest('.tile-tools')) { e.preventDefault(); return; }
  if (e.target.closest('[data-home-edit]')) {
    if (!state.me) { toast(L('Wähle zuerst oben aus, wer du bist.', 'First choose who you are at the top.', `Välj först högst upp vem du är.`)); return; }
    state.editHome = true; state.homeDraft = null; renderHome(); return;
  }
  if (e.target.closest('[data-home-done]')) { state.editHome = false; state.homeDraft = null; renderHome(); toast(L('Gespeichert', 'Saved', `Sparat`)); return; }
  if (e.target.closest('[data-home-add]')) { openHomeAdd(); return; }
  if (e.target.closest('[data-home-reset]')) {
    if (confirm(L('Übersicht auf den Standard zurücksetzen?', 'Reset the overview to the default?', `Återställa översikten till standard?`))) saveHome(DEFAULT_HOME.map((x) => ({ ...x })));
    return;
  }
  const tm = e.target.closest('[data-tile-move]');
  const ts = e.target.closest('[data-tile-size]');
  const td = e.target.closest('[data-tile-del]');
  if (tm || ts || td) {
    const layout = homeLayout().map((x) => ({ ...x }));
    if (tm) {
      const i = +tm.dataset.tileMove; const j = i + +tm.dataset.dir;
      if (j >= 0 && j < layout.length) [layout[i], layout[j]] = [layout[j], layout[i]];
    } else if (ts) {
      const x = layout[+ts.dataset.tileSize]; x.size = x.size === 'w' ? 's' : 'w';
    } else layout.splice(+td.dataset.tileDel, 1);
    saveHome(layout);
    return;
  }
  const rem = e.target.closest('[data-remind]');
  if (rem) {
    const t = state.weeks.get(state.view).tasks.find((x) => x.key === rem.dataset.remind);
    try {
      await api('remind', { monday: state.view, task: rem.dataset.remind, by: state.me });
      toast(L(`${t.person} wurde freundlich erinnert 🔔`, `${t.person} got a friendly reminder 🔔`, `${t.person} har fått en vänlig påminnelse 🔔`));
    } catch (err) { toast(err.message); }
    return;
  }
  const ans = e.target.closest('[data-swap-answer]');
  const canc = e.target.closest('[data-swap-cancel]');
  if (ans || canc) {
    try {
      if (canc) await api('swap/cancel', { id: canc.dataset.swapCancel, by: state.me });
      else await api('swap/answer', { id: ans.dataset.swapAnswer, name: state.me, accept: ans.dataset.accept === '1' });
      await reloadWeeks();
      toast(canc ? L('Anfrage zurückgezogen', 'Request withdrawn', `Förfrågan återkallad`) : ans.dataset.accept === '1' ? L('Getauscht, der Putzplan ist angepasst', 'Swapped, the rota has been updated', `Bytt, schemat är uppdaterat`) : L('Abgelehnt', 'Declined', `Nekad`));
    } catch (err) { toast(err.message); await reloadWeeks(); }
    return;
  }
  const swapBtn = e.target.closest('[data-swap]');
  if (swapBtn) { openSwap(swapBtn.dataset.swap); return; }

  if (e.target.closest('[data-cleaner-visit]')) { openCleaner(state.view); return; }
  if (e.target.closest('[data-cleaner-add]')) { openCleaner('', state.view); return; }
  if (e.target.closest('[data-cleaner-extra-remove]') || e.target.closest('[data-cleaner-unmove]')) {
    const w = state.weeks.get(state.view);
    const undo = !!e.target.closest('[data-cleaner-unmove]');
    const q = undo ? L('Verschiebung rückgängig machen? Die Putzkraft kommt dann wieder in dieser Woche.', 'Undo the move? The cleaner then comes in this week again.', `Ångra flytten? Städhjälpen kommer då den här veckan igen.`)
      : w.extraFrom ? L('Termin zurück in die ursprüngliche Woche legen?', 'Move the visit back to the original week?', `Flytta tillbaka besöket till den ursprungliga veckan?`)
        : L('Zusatztermin löschen?', 'Delete the extra visit?', `Ta bort extrabesöket?`);
    if (!confirm(q)) return;
    try {
      await api(undo ? 'cleaner/unmove' : 'cleaner/extra/remove', { monday: state.view });
      await reloadWeeks();
      toast(L('Erledigt, der Putzplan ist angepasst', 'Done, the rota has been updated', `Klart, schemat är uppdaterat`));
    } catch (err) { toast(err.message); }
    return;
  }
  if (e.target.closest('[data-cleaner-contact]')) { openCleanerContact(); return; }
  const ausfall = e.target.closest('[data-ausfall]');
  if (ausfall) {
    const value = ausfall.dataset.ausfall === '1';
    const msg = value
      ? L('Putzkraft fällt diese Woche aus?\n\nDann putzen wir diese Woche selbst (Küche, Flure, Bäder), ab nächster Woche rutscht der ganze Plan um eine Woche, und alle bekommen sofort eine Nachricht.',
        'Is the cleaner cancelled this week?\n\nThen we clean ourselves this week (kitchen, hallways, bathrooms), from next week the whole rota moves back one week, and everyone gets a notification right away.', `Är städhjälpen inställd den här veckan?\n\nDå städar vi själva den här veckan (kök, hallar, badrum), från nästa vecka flyttas hela schemat en vecka och alla får en notis direkt.`)
      : L('Doch nicht ausgefallen? Der Plan rutscht dann wieder zurück.', 'Not cancelled after all? The rota then moves back again.', `Inte inställd ändå? Schemat flyttas då tillbaka igen.`);
    if (!confirm(msg)) return;
    try {
      await api('ausfall', { monday: state.view, value });
      state.weeks.clear(); // alle folgenden Wochen ändern sich
      await load();
      await ensureWeek(state.view);
      renderWeek();
      toast(value ? L('Eingetragen, alle wurden benachrichtigt', 'Saved, everyone has been notified', `Sparat, alla har fått en notis`) : L('Zurückgenommen', 'Undone', `Ångrat`));
    } catch (err) { toast(err.message); }
  }
});

$('#lang-quick').onclick = () => setLang({ de: 'en', en: 'sv', sv: 'de' }[state.lang]);
$('#set-lang').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-lang]');
  if (!b || b.dataset.lang === state.lang) return;
  setLang(b.dataset.lang);
  if (!state.me) return;
  try {
    const r = await api('members/lang', { name: state.me, lang: state.lang });
    state.members = r.members;
    renderHome();
    toast(L('Sprache gespeichert, auch für deine Erinnerungen', 'Language saved, also for your reminders', `Språket är sparat, även för dina påminnelser`));
  } catch (err) { toast(err.message); }
});

document.addEventListener('change', async (e) => {
  const key = e.target.dataset?.check;
  if (!key) return;
  const done = e.target.checked;
  e.target.closest('.check').classList.toggle('done', done);
  try {
    const before = state.gami;
    const w = await api('check', { monday: state.view, key, done, by: state.me });
    if (w.gami) state.gami = w.gami;
    state.weeks.set(w.monday, w);
    renderWeek();
    renderHome();
    if (done) {
      const t = w.tasks.find((x) => key.startsWith(`${x.key}:`));
      const taskDone = t && t.items.every((it) => w.checks[`${t.key}:${it.id}`]);
      if (state.gami?.current && !before?.current && w.monday === state.current) {
        confetti(220);
        toast(L(`Die ganze WG hat diese Woche alles erledigt! 🔥 Streak: ${state.gami.streak}`, `The whole flat got everything done this week! 🔥 Streak: ${state.gami.streak}`, `Hela kollektivet har gjort allt den här veckan! 🔥 Streak: ${state.gami.streak}`));
      } else if (taskDone) {
        confetti(110);
        toast(cheer());
      } else toast(L('Super, danke! ✨', 'Great, thanks! ✨', `Toppen, tack! ✨`));
      checkNewBadges();
    }
  } catch (err) {
    e.target.checked = !done;
    toast(L(`Konnte nicht speichern: ${err.message}`, `Could not save: ${err.message}`, `Kunde inte spara: ${err.message}`));
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

const openSwaps = () => (state.swapRequests || []).filter((r) => r.status === 'open' && addDays(r.monday, 6) >= (state.today || ''));
const taskTitle = (key) => T({ woche: 'Wochendienst', 'bad-vorne': 'Vorderes Bad + extra Klo', 'bad-hinten': 'Hinteres Bad' }[key] || key);
const weekOf = (m) => L(`Woche ab ${ddmm(m)}`, `week of ${ddmm(m)}`, `veckan från ${ddmm(m)}`);

function openSwap(taskKey) {
  const w = state.weeks.get(state.view);
  const t = w.tasks.find((x) => x.key === taskKey);
  const dlg = $('#swap-dialog');
  $('#swap-title').textContent = L(`${t.title} tauschen`, `Swap: ${T(t.title)}`, `Byt: ${T(t.title)}`);
  const box = $('#swap-people');
  if (!state.me) { toast(L('Wähle zuerst oben aus, wer du bist.', 'First choose who you are at the top.', `Välj först högst upp vem du är.`)); return; }
  if (state.me !== t.person) {
    $('#swap-text').textContent = L(`Diese Woche ist ${t.person} dran. Nur ${t.person} kann für diesen Dienst eine Tausch-Anfrage stellen.`,
      `${t.person} is on duty this week. Only ${t.person} can send a swap request for this duty.`, `${t.person} har tjänsten den här veckan. Bara ${t.person} kan skicka en bytesförfrågan för den.`);
    box.innerHTML = '';
    dlg.showModal();
    return;
  }
  $('#swap-text').textContent = L(`Wen möchtest du fragen, ob er oder sie „${t.title}“ in der ${weekOf(w.monday)} übernimmt? Die Person bekommt eine Nachricht und muss zustimmen, erst dann wird getauscht.`,
    `Who do you want to ask to take over "${T(t.title)}" in the ${weekOf(w.monday)}? They get a notification and have to accept before anything changes.`, `Vem vill du fråga om att ta över "${T(t.title)}" ${weekOf(w.monday)}? Personen får en notis och måste tacka ja innan något ändras.`);
  const step1 = () => {
    box.innerHTML = state.people.filter((p) => p !== t.person)
      .map((p) => `<button type="button" data-swap-to="${esc(p)}">${avatar(p, 'sm')}${esc(p)}</button>`).join('');
  };
  const step2 = (to) => {
    // Dienste der anderen Person in den nächsten Wochen, die ich im Gegenzug übernehmen kann
    const opts = [...state.weeks.values()].filter((x) => x.monday >= state.current).sort((a, b) => (a.monday < b.monday ? -1 : 1))
      .flatMap((x) => x.tasks.filter((y) => y.person === to).map((y) => ({ monday: x.monday, task: y.key, label: `${T(y.title)} · ${weekOf(x.monday)}` })));
    box.innerHTML = `<div class="swap-step">
      <p><strong>${L(`Anfrage an ${esc(to)}`, `Request to ${esc(to)}`, `Förfrågan till ${esc(to)}`)}</strong></p>
      <label class="field"><span>${L(`Übernimmst du dafür einen Dienst von ${esc(to)}? (optional)`, `Will you take over one of ${esc(to)}'s duties in return? (optional)`, `Tar du över en av ${esc(to)}s tjänster i gengäld? (valfritt)`)}</span>
        <select id="swap-back"><option value="">${L('Nein, einfach nur abgeben', 'No, just hand it over', `Nej, bara lämna över`)}</option>
        ${opts.map((o) => `<option value="${o.monday}|${o.task}">${esc(o.label)}</option>`).join('')}</select></label>
      <div class="row end"><button type="button" class="ghost" data-swap-backstep>${L('Zurück', 'Back', `Tillbaka`)}</button><button type="button" data-swap-send="${esc(to)}">${L('Anfrage senden', 'Send request', `Skicka förfrågan`)}</button></div></div>`;
  };
  step1();
  box.onclick = async (e) => {
    const p = e.target.closest('[data-swap-to]');
    if (p) { step2(p.dataset.swapTo); return; }
    if (e.target.closest('[data-swap-backstep]')) { step1(); return; }
    const send = e.target.closest('[data-swap-send]');
    if (!send) return;
    const [bm, bt] = ($('#swap-back').value || '|').split('|');
    try {
      const r = await api('swap/request', { monday: w.monday, task: taskKey, by: state.me, to: send.dataset.swapSend, back: bm ? { monday: bm, task: bt } : null });
      state.swapRequests = r.swapRequests;
      dlg.close();
      render();
      toast(L(`Anfrage an ${send.dataset.swapSend} geschickt`, `Request sent to ${send.dataset.swapSend}`, `Förfrågan skickad till ${send.dataset.swapSend}`));
    } catch (err) { toast(err.message); }
  };
  dlg.showModal();
}

function renderSwapInbox() {
  const me = state.me;
  const reqs = openSwaps();
  const inc = reqs.filter((r) => r.to === me);
  const out = reqs.filter((r) => r.by === me);
  const html = !me || (!inc.length && !out.length) ? '' : `<section class="card inbox"><h2>${L('Tauschen 🔁', 'Swaps 🔁', `Byten 🔁`)}</h2>
    ${inc.map((r) => `<div class="swap-req"><p>${L(`<strong>${esc(r.by)}</strong> möchte mit dir Putzdienst tauschen: Du übernimmst <strong>${taskTitle(r.task)}</strong> (${weekOf(r.monday)})`,
      `<strong>${esc(r.by)}</strong> would like to swap cleaning duty with you: you take over <strong>${taskTitle(r.task)}</strong> (${weekOf(r.monday)})`, `<strong>${esc(r.by)}</strong> vill byta städtjänst med dig: du tar över <strong>${taskTitle(r.task)}</strong> (${weekOf(r.monday)})`)}${r.back
      ? L(`, dafür übernimmt ${esc(r.by)} dein <strong>${taskTitle(r.back.task)}</strong> (${weekOf(r.back.monday)}).`, `, and ${esc(r.by)} takes over your <strong>${taskTitle(r.back.task)}</strong> (${weekOf(r.back.monday)}).`, `, och ${esc(r.by)} tar över din <strong>${taskTitle(r.back.task)}</strong> (${weekOf(r.back.monday)}).`) : '.'}</p>
      <div class="row"><button class="small" data-swap-answer="${esc(r.id)}" data-accept="1">${L('Zusagen', 'Accept', `Tacka ja`)}</button><button class="ghost small" data-swap-answer="${esc(r.id)}" data-accept="0">${L('Ablehnen', 'Decline', `Tacka nej`)}</button></div></div>`).join('')}
    ${out.map((r) => `<div class="row"><span class="small">⏳ ${L(`Warte auf ${esc(r.to)}: ${taskTitle(r.task)} (${weekOf(r.monday)})`, `Waiting for ${esc(r.to)}: ${taskTitle(r.task)} (${weekOf(r.monday)})`, `Väntar på ${esc(r.to)}: ${taskTitle(r.task)} (${weekOf(r.monday)})`)}</span>
      <button class="link small" data-swap-cancel="${esc(r.id)}">${L('zurückziehen', 'withdraw', `återkalla`)}</button></div>`).join('')}
  </section>`;
  for (const id of ['#swap-inbox', '#swap-inbox-home']) if ($(id)) $(id).innerHTML = html;
}

async function reloadWeeks() {
  const view = state.view;
  state.weeks.clear();
  await load();
  if (view && view !== state.view) { await ensureWeek(view); state.view = view; }
  render();
}

/**
 * Putzkraft-Termin verschieben (auch in eine andere Woche) oder zusätzlich eintragen.
 * from: Montag der Woche, deren Termin verschoben wird ('' = Zusatztermin); near: Woche für den Vorschlag
 */
function openCleaner(from = null, near = null) {
  const dlg = $('#cleaner-dialog');
  const sel = $('#cleaner-which');
  const d = $('#cleaner-date');
  const t = $('#cleaner-time');
  const weeks = [...state.weeks.values()].filter((w) => w.cleaner && w.sunday >= state.today).sort((a, b) => (a.monday < b.monday ? -1 : 1));
  sel.innerHTML = weeks.map((w) => `<option value="${w.monday}">${L(`Termin ${cleanerWhen(w)} verschieben`, `Move visit on ${cleanerWhen(w)}`, `Flytta besöket ${cleanerWhen(w)}`)}</option>`).join('')
    + `<option value="">${L('➕ Zusätzlicher Termin', '➕ Extra visit', `➕ Extrabesök`)}</option>`;
  if (from === null) from = weeks.length ? weeks[0].monday : '';
  if (from && !weeks.some((w) => w.monday === from)) from = '';
  sel.value = from;
  d.min = state.today;
  const fill = () => {
    const w = sel.value && state.weeks.get(sel.value);
    if (w) { d.value = w.cleanerDay; t.value = w.cleanerTime || ''; } else { d.value = near && near > state.today ? addDays(near, 2) : ''; t.value = ''; }
    $('#cleaner-week').textContent = w
      ? L('Du kannst auch einen Tag in einer anderen Woche wählen. Der Putzplan passt sich an, und alle bekommen eine kurze Nachricht.', 'You can also pick a day in another week. The rota adjusts and everyone gets a short notification.', `Du kan också välja en dag i en annan vecka. Schemat anpassas och alla får en kort notis.`)
      : L('Für eine Woche, in der die Putzkraft sonst nicht kommt. Der Putzplan passt sich an, und alle bekommen eine kurze Nachricht.', 'For a week in which the cleaner would not come otherwise. The rota adjusts and everyone gets a short notification.', `För en vecka då städhjälpen annars inte kommer. Schemat anpassas och alla får en kort notis.`);
  };
  sel.onchange = fill;
  fill();
  $('#cleaner-form').onsubmit = async (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    try {
      const body = { date: d.value, time: t.value, by: state.me };
      const nw = sel.value ? await api('cleaner/move', { ...body, from: sel.value }) : await api('cleaner/extra', body);
      dlg.close();
      await reloadWeeks();
      if (state.weeks.has(nw.monday) && location.hash === '#plan') { state.view = nw.monday; render(); }
      toast(L('Eingetragen, alle wurden benachrichtigt', 'Saved, everyone has been notified', `Sparat, alla har fått en notis`));
    } catch (err) { toast(err.message); }
  };
  dlg.showModal();
}

function openCleanerContact() {
  const dlg = $('#swap-dialog');
  $('#swap-title').textContent = L('Zuständig für die Putzkraft', 'In charge of the cleaner', `Ansvarig för städhjälpen`);
  $('#swap-text').textContent = L('Wer stimmt die Termine mit der Putzkraft ab? Diese Person bekommt montags die Frage, ob und wann die Putzkraft kommt.',
    'Who arranges the dates with the cleaner? This person gets asked on Mondays whether and when the cleaner is coming.', `Vem bokar tider med städhjälpen? Den personen får en fråga på måndagar om och när städhjälpen kommer.`);
  $('#swap-people').innerHTML = state.people
    .map((p) => `<button type="button" data-contact="${esc(p)}">${esc(p)}${p === state.cleanerContact ? L(' (bisher)', ' (current)', ` (nuvarande)`) : ''}</button>`).join('');
  $('#swap-people').onclick = async (e) => {
    const b = e.target.closest('[data-contact]');
    if (!b) return;
    try {
      const r = await api('cleaner/contact', { name: b.dataset.contact });
      state.cleanerContact = r.cleanerContact;
      dlg.close();
      render();
      toast(L(`${r.cleanerContact} ist jetzt zuständig`, `${r.cleanerContact} is now in charge`, `${r.cleanerContact} är nu ansvarig`));
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
  // Kopf „Zentrale · Hallo …“ nur in der Übersicht
  document.body.classList.toggle('not-home', tab !== 'home');
  renderMe();
  if (tab === 'home') { renderHome(); if (state.me) { loadMoney(); loadShop(); } }
  if (tab === 'cal') renderCal();
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === (tab === 'rules' ? 'home' : tab)));
  if (state.me && tab === 'shop') loadShop();
  if (state.me && tab === 'money') loadMoney();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', showTab);

function ago(ts) {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return L('gerade eben', 'just now', `nyss`);
  if (min < 60) return L(`vor ${min} Min.`, `${min} min ago`, `för ${min} min sedan`);
  const h = Math.round(min / 60);
  if (h < 24) return L(`vor ${h} Std.`, `${h} h ago`, `för ${h} h sedan`);
  const d = Math.round(h / 24);
  if (d === 1) return L('gestern', 'yesterday', `i går`);
  if (d < 7) return L(`vor ${d} Tagen`, `${d} days ago`, `för ${d} dagar sedan`);
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
    $('#shop-list').innerHTML = `<div class="card"><p class="empty">${L('Alles da! 🎉 Wenn etwas leer ist, trag es oben ein.', "We've got everything! 🎉 If something runs out, add it above.", `Vi har allt! 🎉 Om något tar slut, lägg till det ovan.`)}</p></div>`;
    return;
  }
  $('#shop-list').innerHTML = sh.categories.map((c) => {
    const items = sh.items.filter((i) => i.cat === c.id);
    if (!items.length) return '';
    return `<section class="card shop-cat"><h2>${c.icon} ${esc(T(c.label))} <span class="muted small">${items.length}</span></h2>
      ${items.map((i) => `<div class="shop-item"><button type="button" class="tick" data-bought="${esc(i.id)}" aria-label="${L('Gekauft', 'Bought', 'Köpt')}: ${esc(i.name)}"></button>
        <div class="name" data-bought="${esc(i.id)}">${esc(i.name)}<small>${i.by ? `${esc(i.by)}, ` : ''}${ago(i.at)}</small></div></div>`).join('')}
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
    toast(L('Steht auf der Liste', 'Added to the list', `Tillagt på listan`));
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
  $('#bought-title').textContent = L(`${item.name} gekauft 🎉`, `${item.name} bought 🎉`, `${item.name} köpt 🎉`);
  $('#bought-price').value = '';
  const dlg = $('#bought-dialog');
  const tick = b.closest('.shop-item')?.querySelector('.tick');
  tick?.classList.add('done');
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'ok') { tick?.classList.remove('done'); return; }
    const price = $('#bought-price').value.trim();
    try {
      state.shop = await api('shop/done', { id: item.id, price: price || undefined, by: state.me });
      renderShop();
      toast(price ? L('Danke! Betrag steht in der WG-Kasse.', 'Thanks! The amount is in the flat money.', `Tack! Beloppet finns nu i kollektivkassan.`) : L('Danke!', 'Thanks!', `Tack!`));
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
    <input class="lb" value="${esc(T(c.label))}" data-orig="${esc(c.label)}" maxlength="40" placeholder="${L('Name', 'Name', `Namn`)}" aria-label="Name">
    <button type="button" class="ghost" data-cat-del aria-label="${L('Löschen', 'Delete', `Ta bort`)}">🗑</button></div>`;
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
      toast(L('Kategorien gespeichert', 'Categories saved', `Kategorierna sparade`));
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
  equal: L('Wird gleichmäßig auf die ausgewählten Personen aufgeteilt.', 'Split equally between the selected people.', `Delas lika mellan de valda personerna.`),
  percent: L('Prozent pro Person eintragen, zusammen 100 %.', 'Enter a percentage per person, 100 % in total.', `Ange procent per person, totalt 100 %.`),
  shares: L('Anteile eintragen, z.B. 2 und 1 heißt: die erste Person zahlt doppelt so viel.', 'Enter shares, e.g. 2 and 1 means the first person pays twice as much.', `Ange andelar, t.ex. 2 och 1 betyder att första personen betalar dubbelt så mycket.`),
  exact: L('Genaue Beträge eintragen, zusammen der Gesamtbetrag.', 'Enter exact amounts that add up to the total.', `Ange exakta belopp som tillsammans blir totalen.`),
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
          <button class="ghost small" data-settle='${esc(JSON.stringify({ ...t, currency: c }))}'>${L('Bezahlt', 'Paid', `Betalat`)}</button></span></div>`).join('')
      : `<p class="empty">${L('Alle sind quitt. 🙌', 'Everyone is square. 🙌', `Alla är kvitt. 🙌`)}</p>`;
    if (multi) bHtml += `<p class="cur-head" style="grid-column:1/-1">${c}</p>`;
    bHtml += [...m.people, ...(m.former || []).filter((p) => balances[p])].map((p) => {
      const v = balances[p] || 0;
      return `<div class="bal${p === state.me ? ' mine-bal' : ''}"><div class="who">${esc(p)}${m.people.includes(p) ? '' : L(' (ausgezogen)', ' (moved out)', ` (utflyttad)`)}</div>
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

  renderRecurring();
  $('#money-list').innerHTML = m.expenses.length
    ? m.expenses.map((e) => {
      const cur = e.currency || 'EUR';
      const settleRow = e.kind === 'settle';
      let who;
      if (e.net) { // aus Splitwise importiert
        const to = Object.entries(e.net).filter(([, v]) => v < 0).map(([p]) => p);
        who = settleRow
          ? L(`${esc(e.paidBy)} hat ${to.map(esc).join(', ')} Geld zurückgegeben · Splitwise`, `${esc(e.paidBy)} paid back ${to.map(esc).join(', ')} · Splitwise`, `${esc(e.paidBy)} betalade tillbaka ${to.map(esc).join(', ')} · Splitwise`)
          : L(`${esc(e.paidBy || '?')} hat bezahlt · Splitwise`, `${esc(e.paidBy || '?')} paid · Splitwise`, `${esc(e.paidBy || '?')} betalade · Splitwise`);
      } else {
        const parts = e.parts || Object.fromEntries((e.split || []).map((p) => [p, null]));
        let forWho;
        if (e.mode && e.mode !== 'equal') forWho = Object.entries(parts).map(([p, v]) => `${esc(p)} ${money(v, cur)}`).join(', ');
        else forWho = Object.keys(parts).length === m.people.length ? L('für alle', 'for everyone', `för alla`) : `${L('für', 'for', `för`)} ${Object.keys(parts).map(esc).join(', ')}`;
        who = settleRow
          ? L(`${esc(e.paidBy)} hat ${esc(Object.keys(parts)[0])} Geld zurückgegeben`, `${esc(e.paidBy)} paid back ${esc(Object.keys(parts)[0])}`, `${esc(e.paidBy)} betalade tillbaka ${esc(Object.keys(parts)[0])}`)
          : `${L(`${esc(e.paidBy)} hat bezahlt`, `${esc(e.paidBy)} paid`, `${esc(e.paidBy)} betalade`)} · ${forWho}`;
      }
      const split = !e.net && e.parts && !settleRow
        ? `<details><summary>${L('Aufteilung', 'Split', `Fördelning`)}</summary><p>${Object.entries(e.parts).map(([p, v]) => `${esc(p)}: ${money(v, cur)}`).join(' · ')}</p></details>`
        : '';
      return `<div class="exp${settleRow ? ' settle' : ''}"><div class="d">${e.recurring ? '🔁 ' : ''}${esc(T(e.desc))}<small>${who} · ${e.recurring && e.date ? fmtDay(e.date) : ago(e.at)}</small>${split}</div>
        <div class="r"><strong>${money(e.amount, cur)}</strong><button class="link small" data-del="${esc(e.id)}">${L('löschen', 'delete', `ta bort`)}</button></div></div>`;
    }).join('')
    : `<p class="empty">${L('Noch nichts eingetragen.', 'Nothing added yet.', `Inget tillagt än.`)}</p>`;
}

/** "So wird gerechnet": pro Person bezahlt, Anteil, Rückzahlungen → Saldo */
function renderExplain(m, curs) {
  let html = `<p class="small">${L(
    'Für jede Person wird zusammengezählt, was sie für die WG <strong>bezahlt</strong> hat. Davon wird abgezogen, was bei allen Einträgen <strong>ihr Anteil</strong> war. Rückzahlungen werden verrechnet. Plus heißt: bekommt Geld, Minus heißt: schuldet Geld.',
    'For each person we add up what they <strong>paid</strong> for the flat and subtract <strong>their share</strong> of all entries. Repayments are taken into account. Plus means they are owed money, minus means they owe money.', `För varje person lägger vi ihop vad hen har <strong>betalat</strong> för kollektivet och drar av <strong>sin andel</strong> av alla poster. Återbetalningar räknas med. Plus betyder att hen ska få pengar, minus att hen är skyldig.`)}</p>`;
  for (const c of curs) {
    const bd = m.byCurrency[c].breakdown;
    if (!bd) continue;
    const people = [...m.people, ...(m.former || []).filter((p) => m.byCurrency[c].balances[p])];
    const hasImport = people.some((p) => bd[p]?.imported);
    const hasRepay = people.some((p) => bd[p]?.repaid || bd[p]?.received);
    const f = (v) => (v ? money(v, c) : '–');
    html += `${curs.length > 1 ? `<p class="cur-head">${c}</p>` : ''}<div class="table-wrap"><table><thead><tr>
      <th>${L('Person', 'Person', `Person`)}</th><th>${L('bezahlt', 'paid', `betalat`)}</th><th>− ${L('Anteil', 'share', `andel`)}</th>
      ${hasRepay ? `<th>+ ${L('zurückgezahlt', 'paid back', `betalat tillbaka`)}</th><th>− ${L('zurückbekommen', 'got back', `fått tillbaka`)}</th>` : ''}
      ${hasImport ? `<th>+ Splitwise</th>` : ''}<th>= ${L('Saldo', 'Balance', `Saldo`)}</th></tr></thead><tbody>
      ${people.map((p) => {
        const b = bd[p] || {};
        const v = m.byCurrency[c].balances[p] || 0;
        return `<tr><td>${esc(p)}</td><td>${f(b.paid)}</td><td>${f(b.share)}</td>
          ${hasRepay ? `<td>${f(b.repaid)}</td><td>${f(b.received)}</td>` : ''}
          ${hasImport ? `<td>${b.imported ? `${b.imported > 0 ? '+' : ''}${money(b.imported, c)}` : '–'}</td>` : ''}
          <td class="sum">${v > 0 ? '+' : ''}${money(v, c)}</td></tr>`;
      }).join('')}</tbody></table></div>`;
    if (hasImport) html += `<p class="muted small">${L('„Splitwise“ ist der übernommene Stand aus der alten Splitwise-Gruppe.', '"Splitwise" is the balance carried over from the old Splitwise group.', `"Splitwise" är saldot som fördes över från den gamla Splitwise-gruppen.`)}</p>`;
  }
  html += `<p class="small">${L(
    'Damit alle wieder bei 0 sind, schlägt die App möglichst wenige Überweisungen vor: Wer am meisten schuldet, zahlt an die Person, die am meisten bekommt, und so weiter. Bei jedem Eintrag unten zeigt „Aufteilung“, wer wie viel übernimmt.',
    'To get everyone back to 0, the app suggests as few transfers as possible: whoever owes the most pays the person who is owed the most, and so on. On each entry below, "Split" shows who covers how much.', `För att alla ska komma tillbaka till 0 föreslår appen så få överföringar som möjligt: den som är skyldig mest betalar till den som ska få mest, och så vidare. Vid varje post nedan visar "Fördelning" vem som står för hur mycket.`)}</p>`;
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
    const unit = state.mode === 'percent' ? '%' : state.mode === 'shares' ? L('Anteile', 'shares', `andelar`) : $('#m-cur').value || 'EUR';
    const old = Object.fromEntries([...document.querySelectorAll('#m-values input')].map((i) => [i.name, i.value]));
    $('#m-values').innerHTML = m.people.map((p) => `<label><span>${esc(p)}</span>
      <input name="${esc(p)}" inputmode="decimal" placeholder="0" value="${esc(old[p] ?? '')}" aria-label="${esc(p)} ${L('in', 'in', `i`)} ${unit}"><small class="muted">${unit}</small></label>`).join('');
  }
  updateHint();
}
function updateHint() {
  let hint = modeHint(state.mode);
  if (state.mode !== 'equal') {
    const nums = [...document.querySelectorAll('#m-values input')].map((i) => Number(i.value.replace(',', '.')) || 0);
    const sum = nums.reduce((a, b) => a + b, 0);
    if (state.mode === 'percent') hint += L(` Bisher: ${Math.round(sum * 100) / 100} %.`, ` So far: ${Math.round(sum * 100) / 100} %.`, ` Hittills: ${Math.round(sum * 100) / 100} %.`);
    if (state.mode === 'exact') {
      const total = Number($('#m-amount').value.replace(',', '.')) || 0;
      const rest = Math.round((total - sum) * 100);
      hint += rest ? L(` Noch zu verteilen: ${money(rest, $('#m-cur').value)}.`, ` Still to split: ${money(rest, $('#m-cur').value)}.`, ` Kvar att fördela: ${money(rest, $('#m-cur').value)}.`) : L(' Passt genau.', ' Adds up exactly.', ` Går jämnt ut.`);
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
  if (state.mode === 'equal' && !state.split.size) { toast(L('Bitte mindestens eine Person auswählen', 'Please choose at least one person', `Välj minst en person`)); return; }
  const values = Object.fromEntries([...document.querySelectorAll('#m-values input')].map((i) => [i.name, i.value.trim()]));
  try {
    state.money = await api('money/add', {
      desc: $('#m-desc').value, amount: $('#m-amount').value, currency: $('#m-cur').value, paidBy: $('#m-paid').value,
      mode: state.mode, split: [...state.split], values, by: state.me,
      repeat: $('#m-repeat-on').checked ? $('#m-repeat').value : null,
    });
    const wasRepeat = $('#m-repeat-on').checked;
    $('#m-repeat-on').checked = false;
    $('#m-repeat-wrap').hidden = true;
    if (wasRepeat) toast(L('Eingetragen, ab jetzt automatisch 🔁', 'Added, automatic from now on 🔁', 'Tillagt, automatiskt från och med nu 🔁'));
    $('#m-desc').value = '';
    $('#m-amount').value = '';
    $('#m-values').innerHTML = '';
    renderMoney();
    toast(L('Eingetragen', 'Added', `Tillagt`));
  } catch (err) { toast(err.message); }
});
$('#m-repeat-on').addEventListener('change', () => { $('#m-repeat-wrap').hidden = !$('#m-repeat-on').checked; });
const REPEAT_LABEL = () => ({ week: L('jede Woche', 'every week', 'varje vecka'), '2week': L('alle 2 Wochen', 'every 2 weeks', 'varannan vecka'), month: L('jeden Monat', 'every month', 'varje månad'), '2month': L('alle 2 Monate', 'every 2 months', 'varannan månad'), quarter: L('alle 3 Monate', 'every 3 months', 'var 3:e månad'), year: L('jedes Jahr', 'every year', 'varje år') });
function renderRecurring() {
  const list = state.money?.recurring || [];
  $('#recurring-card').hidden = !list.length;
  $('#recurring-list').innerHTML = list.map((r) => `<div class="exp"><div class="d">🔁 ${esc(T(r.desc))}<small>${esc(r.paidBy)} · ${REPEAT_LABEL()[r.every] || ''} · ${L('nächstes Mal', 'next', 'nästa gång')} ${fmtDay(r.next)}</small></div>
    <div class="a"><strong>${money(r.amount, r.currency)}</strong><button class="link small" data-stop-rec="${esc(r.id)}">${L('beenden', 'stop', 'avsluta')}</button></div></div>`).join('');
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-stop-rec]');
  if (!b) return;
  if (!confirm(L('Diese wiederkehrende Ausgabe beenden? Bisherige Einträge bleiben.', 'Stop this recurring expense? Past entries stay.', 'Avsluta den här återkommande utgiften? Tidigare poster finns kvar.'))) return;
  try { state.money = await api('money/recurring/stop', { id: b.dataset.stopRec }); renderMoney(); } catch (err) { toast(err.message); }
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
      `${r.imported} entries imported${r.matches ? ', balances match Splitwise ✓' : ''}`, `${r.imported} poster importerade${r.matches ? ', saldona stämmer med Splitwise ✓' : ''}`));
  } catch (err) { toast(err.message); }
});
$('#tab-money').addEventListener('click', async (e) => {
  const s = e.target.closest('[data-settle]');
  if (s) {
    const t = JSON.parse(s.dataset.settle);
    if (!confirm(L(`Hat ${t.from} ${t.to} ${money(t.amount, t.currency)} zurückgezahlt?`, `Has ${t.from} paid ${t.to} ${money(t.amount, t.currency)} back?`, `Har ${t.from} betalat tillbaka ${money(t.amount, t.currency)} till ${t.to}?`))) return;
    try {
      state.money = await api('money/add', {
        kind: 'settle', desc: 'Rückzahlung', amount: (t.amount / 100).toFixed(2), currency: t.currency, paidBy: t.from, split: [t.to], by: state.me,
      });
      renderMoney();
      toast(L('Ausgeglichen 👍', 'Settled 👍', `Utjämnat 👍`));
    } catch (err) { toast(err.message); }
    return;
  }
  const d = e.target.closest('[data-del]');
  if (d) {
    if (!confirm(L('Diesen Eintrag wirklich löschen?', 'Really delete this entry?', `Vill du verkligen ta bort posten?`))) return;
    try { state.money = await api('money/delete', { id: d.dataset.del }); renderMoney(); } catch (err) { toast(err.message); }
  }
});

// ---------------- Übersicht (Dashboard) ----------------
function absentNow(day) { return (state.absences || []).filter((a) => a.from <= day && a.to >= day); }
const plural = (n, de1, deN, en1, enN, sv1, svN) => (n === 1 ? L(de1, en1, sv1) : L(deN, enN, svN));

// ---------- Übersicht: Kacheln pro Person ----------
const WIDGETS = {
  week: { de: 'Deine Woche', en: 'Your week', sv: 'Din vecka', size: 'w' },
  board: { de: 'Pinnwand', en: 'Pinboard', sv: 'Anslagstavla', size: 'w' },
  plan: { de: 'Putzplan', en: 'Cleaning', sv: 'Städning', size: 's' },
  shop: { de: 'Einkauf', en: 'Shopping', sv: 'Handla', size: 's' },
  money: { de: 'Kasse', en: 'Money', sv: 'Kassa', size: 's' },
  cal: { de: 'Kalender', en: 'Calendar', sv: 'Kalender', size: 's' },
  meetings: { de: 'Letzte WG-Meetings', en: 'Recent flat meetings', sv: 'Senaste husmötena', size: 'w' },
  rules: { de: 'Hausregeln', en: 'House rules', sv: 'Husregler', size: 'w' },
  duties: { de: 'Meine nächsten Dienste', en: 'My next duties', sv: 'Mina nästa tjänster', size: 's' },
  cleaner: { de: 'Putzkraft', en: 'Cleaner', sv: 'Städhjälp', size: 's' },
  birthdays: { de: 'Nächste Geburtstage', en: 'Next birthdays', sv: 'Nästa födelsedagar', size: 's' },
  holiday: { de: 'Nächster Feiertag', en: 'Next holiday', sv: 'Nästa helgdag', size: 's' },
  shoplist: { de: 'Einkaufsliste', en: 'Shopping list', sv: 'Inköpslista', size: 'w' },
  badges: { de: 'Abzeichen & WG-Streak', en: 'Badges & streak', sv: 'Märken & streak', size: 'w' },
};
const SHORTCUTS = {
  shop: { icon: '🛒', de: 'Einkauf eintragen', en: 'Add to shopping', sv: 'Lägg till inköp' },
  expense: { icon: '💶', de: 'Ausgabe eintragen', en: 'Add expense', sv: 'Lägg till utgift' },
  event: { icon: '📅', de: 'Kalendereintrag', en: 'Calendar entry', sv: 'Kalenderpost' },
  survey: { icon: '🗳️', de: 'Umfrage starten', en: 'Start a poll', sv: 'Starta omröstning' },
  cleaner: { icon: '🧹', de: 'Putzkraft-Termin', en: 'Cleaner date', sv: 'Tid för städhjälpen' },
  swap: { icon: '🔁', de: 'Dienst tauschen', en: 'Swap duty', sv: 'Byt tjänst' },
  icscal: { icon: '📲', de: 'Handy-Kalender', en: 'Phone calendar', sv: 'Mobilkalender' },
  note: { icon: '📌', de: 'Zettel anpinnen', en: 'Pin a note', sv: 'Sätt upp en lapp' },
  invite: { icon: '➕', de: 'Mitglied einladen', en: 'Invite member', sv: 'Bjud in medlem' },
};
const DEFAULT_HOME = ['week', 'badges', 'board', 'plan', 'shop', 'money', 'cal', 'meetings', 'rules'].map((id) => ({ id, size: WIDGETS[id].size }));
const widgetName = (id) => (id.startsWith('sc:') ? L(SHORTCUTS[id.slice(3)]?.de || id, SHORTCUTS[id.slice(3)]?.en || id, SHORTCUTS[id.slice(3)]?.sv || id) : L(WIDGETS[id]?.de || id, WIDGETS[id]?.en || id, WIDGETS[id]?.sv || id));
function homeLayout() {
  if (state.homeDraft) return state.homeDraft;
  const saved = memberOf(state.me)?.home;
  const ok = Array.isArray(saved) ? saved.filter((x) => WIDGETS[x.id] || (x.id.startsWith('sc:') && SHORTCUTS[x.id.slice(3)])) : null;
  return ok && ok.length ? ok : DEFAULT_HOME;
}
async function saveHome(layout) {
  state.homeDraft = layout;
  renderHome();
  try {
    const r = await api('members/home', { name: state.me, layout });
    state.members = r.members;
  } catch (err) { toast(err.message); }
}

/** Zusätzliche Kacheln, die man sich hinzufügen kann */
function extraTiles(w) {
  const me = state.me;
  const out = {};
  const today = state.today;
  // Pinnwand
  const notes = state.board || [];
  out.board = `<div class="card __CLS__ board-card"><div class="board-head"><h3>📌 ${L('Pinnwand', 'Pinboard', 'Anslagstavla')}</h3>${state.editHome ? '' : `<button type="button" class="small" data-note-add>+ ${L('Zettel', 'Note', 'Lapp')}</button>`}</div>
    <div class="cork">${notes.length ? notes.map((n) => `<div class="note ${n.photo ? 'polaroid' : n.color}" style="--tilt:${n.tilt || 0}deg"><span class="pin"></span>${n.photo ? `<a href="/api/board/photo/${esc(n.id)}" target="_blank" rel="noopener"><img src="/api/board/photo/${esc(n.id)}" alt="" loading="lazy"></a>` : ''}${n.text ? `<p>${esc(n.text).replace(/\n/g, '<br>')}</p>` : ''}
      ${reactBar(`note:${n.id}`, n.by ? [n.by] : [])}${n.expires ? `<span class="note-exp">⏳ ${L('bis', 'until', 'till')} ${ddmm(n.expires)}</span>` : ''}<small>${n.by ? esc(n.by) : ''} · ${ago(n.at)}${state.editHome ? '' : ` <button type="button" class="note-del" data-note-del="${esc(n.id)}" aria-label="${L('Zettel abnehmen', 'Remove note', 'Ta ner lappen')}">✕</button>`}</small></div>`).join('')
    : `<p class="cork-empty">${L('Noch nichts angepinnt. Häng z.B. das WLAN-Passwort oder „Handwerker kommt Do“ auf.', 'Nothing pinned yet. Put up e.g. the Wi-Fi password or "plumber comes Thu".', 'Inget uppsatt än. Sätt t.ex. upp wifi-lösenordet eller "hantverkaren kommer tors".')}</p>`}</div></div>`;
  // Meine nächsten Dienste
  if (me) {
    const list = [...state.weeks.values()].filter((x) => x.monday >= state.current).sort((a, b) => (a.monday < b.monday ? -1 : 1))
      .flatMap((x) => x.tasks.filter((t) => t.person === me && t.key !== 'kuehlschrank' && (t.key === 'woche' || !x.cleaner)).map((t) => `${ddmm(x.monday)} ${esc(T(t.title))}`)).slice(0, 4);
    out.duties = `<a class="card __CLS__" href="#plan"><h3>${L('Meine nächsten Dienste', 'My next duties', `Mina nästa tjänster`)}</h3>${list.length ? `<p>${list.join('<br>')}</p>` : `<p class="muted">${L('Nichts geplant', 'Nothing planned', `Inget planerat`)}</p>`}</a>`;
  }
  // Putzkraft: nächster Termin
  const nextCleaner = [...state.weeks.values()].filter((x) => x.cleaner && x.cleanerDay >= today).sort((a, b) => (a.cleanerDay < b.cleanerDay ? -1 : 1))[0];
  out.cleaner = `<a class="card __CLS__" href="#plan"><h3>${L('Putzkraft', 'Cleaner', `Städhjälp`)}</h3>${nextCleaner
    ? `<div class="big">🧹 ${cleanerWhen(nextCleaner)}</div><p class="muted">${nextCleaner.cleanerConfirmed ? L('bestätigt ✓', 'confirmed ✓', `bekräftat ✓`) : L('laut Plan', 'as planned', `enligt plan`)}</p>`
    : `<p class="muted">${L('Kein Termin geplant', 'No visit planned', `Inget besök planerat`)}</p>`}</a>`;
  // Geburtstage
  const bdays = (state.members || []).filter((m) => m.birthday && state.people.includes(m.name)).map((m) => {
    let d = `${today.slice(0, 4)}${m.birthday.slice(4)}`;
    if (d < today) d = `${+today.slice(0, 4) + 1}${m.birthday.slice(4)}`;
    return { name: m.name, d };
  }).sort((a, b) => (a.d < b.d ? -1 : 1)).slice(0, 3);
  out.birthdays = `<a class="card __CLS__" href="#kalender"><h3>${L('Nächste Geburtstage', 'Next birthdays', `Nästa födelsedagar`)}</h3>${bdays.length
    ? `<p>${bdays.map((b) => `🎂 ${esc(b.name)} · ${ddmm(b.d)}${b.d === today ? L(' (heute!)', ' (today!)', ` (i dag!)`) : ''}`).join('<br>')}</p>` : `<p class="muted">${L('Noch keine Geburtstage eingetragen', 'No birthdays yet', `Inga födelsedagar än`)}</p>`}</a>`;
  // Nächster Feiertag
  const y = +today.slice(0, 4);
  const hol = [...berlinHolidays(y), ...berlinHolidays(y + 1)].find((h) => h.date >= today && (h.legal || h.short));
  if (hol) out.holiday = `<a class="card __CLS__" href="#kalender"><h3>${L('Nächster Feiertag', 'Next holiday', `Nästa helgdag`)}</h3><div class="big">${hol.legal ? '🔴' : '⚪'} ${esc(L(hol.de, hol.en, hol.sv || hol.en))}</div><p>${fmtDay(hol.date)}</p><p class="muted">${holidayInfo(hol, state.lang)}</p></a>`;
  // Einkaufsliste komplett
  const sh = state.shop;
  out.shoplist = `<a class="card __CLS__" href="#einkauf"><h3>${L('Einkaufsliste', 'Shopping list', `Inköpslista`)}</h3>${sh
    ? (sh.items.length ? `<ul>${sh.items.slice(0, 12).map((i) => `<li>${esc(i.name)}</li>`).join('')}</ul>${sh.items.length > 12 ? `<p class="muted">+ ${sh.items.length - 12}</p>` : ''}` : `<p>${L('Alles da 🎉', 'All stocked 🎉', `Allt finns 🎉`)}</p>`)
    : '<p class="muted">…</p>'}</a>`;
  return out;
}

function openHomeAdd() {
  const layout = homeLayout();
  const have = new Set(layout.map((x) => x.id));
  const ws = Object.keys(WIDGETS).filter((id) => !have.has(id));
  const scs = Object.keys(SHORTCUTS).filter((id) => !have.has(`sc:${id}`));
  $('#swap-title').textContent = L('Kachel hinzufügen', 'Add a tile', `Lägg till en ruta`);
  $('#swap-text').textContent = L('Was soll in deine Übersicht? Es landet ganz unten, mit den Pfeilen kannst du es verschieben.', 'What should go into your overview? It is added at the bottom; use the arrows to move it.', `Vad ska finnas i din översikt? Det hamnar längst ner, med pilarna kan du flytta det.`);
  $('#swap-people').innerHTML = `${ws.length ? `<h3 class="add-h">${L('Kacheln', 'Tiles', `Rutor`)}</h3>${ws.map((id) => `<button type="button" class="ghost" data-add-tile="${id}">${esc(widgetName(id))}</button>`).join('')}` : ''}
    ${scs.length ? `<h3 class="add-h">${L('Kurzbefehle', 'Shortcuts', `Genvägar`)}</h3>${scs.map((id) => `<button type="button" class="ghost" data-add-tile="sc:${id}">${SHORTCUTS[id].icon} ${esc(widgetName(`sc:${id}`))}</button>`).join('')}` : ''}
    ${!ws.length && !scs.length ? `<p class="muted">${L('Du hast schon alles in deiner Übersicht.', 'You already have everything in your overview.', `Du har redan allt i din översikt.`)}</p>` : ''}`;
  const dlg = $('#swap-dialog');
  $('#swap-people').onclick = (e) => {
    const b = e.target.closest('[data-add-tile]');
    if (!b) return;
    const id = b.dataset.addTile;
    dlg.close();
    saveHome([...homeLayout(), { id, size: id.startsWith('sc:') ? 's' : WIDGETS[id].size }]);
  };
  dlg.showModal();
}

function openNoteDialog() {
  const dlg = $('#note-dialog');
  $('#note-text').value = '';
  $('#note-expires').value = '';
  $('#note-expires').min = state.today;
  let color = 'yellow';
  let photo = null;
  const showPhoto = () => {
    $('#note-photo-preview').hidden = !photo;
    $('#note-photo-preview').innerHTML = photo ? `<img src="${photo}" alt=""><button type="button" class="link small" id="note-photo-del">${L('Foto entfernen', 'Remove photo', 'Ta bort foto')}</button>` : '';
    if (photo) $('#note-photo-del').onclick = () => { photo = null; $('#note-photo').value = ''; showPhoto(); };
  };
  showPhoto();
  $('#note-photo-btn').onclick = () => $('#note-photo').click();
  $('#note-photo').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { photo = await resizeImage(f, 1000); showPhoto(); } catch { toast(L('Das Foto ist zu groß oder kein Bild.', 'The photo is too big or not an image.', 'Fotot är för stort eller ingen bild.')); }
  };
  const mark = () => document.querySelectorAll('#note-colors [data-color]').forEach((b) => b.setAttribute('aria-checked', b.dataset.color === color));
  $('#note-colors').onclick = (e) => { const b = e.target.closest('[data-color]'); if (b) { color = b.dataset.color; mark(); } };
  mark();
  $('#note-form').onsubmit = async (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    try {
      state.board = (await api('board/add', { text: $('#note-text').value, color, photo, expires: $('#note-expires').value || null, by: state.me })).board;
      dlg.close();
      renderHome();
      toast(L('Angepinnt 📌 Alle bekommen Bescheid', 'Pinned 📌 Everyone gets notified', 'Uppsatt 📌 Alla får en notis'));
    } catch (err) { toast(err.message); }
  };
  dlg.showModal();
  $('#note-text').focus();
}

function runShortcut(id) {
  const go = (hash, fn) => { location.hash = hash; if (fn) setTimeout(fn, 120); };
  if (id === 'shop') go('#einkauf', () => $('#shop-name').focus());
  else if (id === 'expense') go('#kasse', () => { $('#money-form').scrollIntoView({ behavior: 'smooth' }); $('#m-desc').focus(); });
  else if (id === 'event') go('#kalender', () => { $('#ev-open').click(); $('#ev-form').scrollIntoView({ behavior: 'smooth' }); });
  else if (id === 'survey') { $('#survey-open').click(); $('#surveys-card').scrollIntoView({ behavior: 'smooth' }); }
  else if (id === 'cleaner') openCleaner();
  else if (id === 'swap') { state.view = state.current; go('#plan', () => render()); }
  else if (id === 'icscal') go('#kalender', () => $('#ics-open').click());
  else if (id === 'invite') $('#invite').click();
  else if (id === 'note') openNoteDialog();
}

function renderHome() {
  const el = $('#home');
  if (!el || !state.current) return;
  const w = state.weeks.get(state.current);
  const me = state.me;
  const tiles = {};
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
      if (t.person === me && t.key !== 'kuehlschrank') mine.push(T(t.title) + (t.key.startsWith('bad-') && !t.cleaningWeek ? L(' (nur Klopapier)', ' (toilet paper only)', ` (bara toapapper)`) : ''));
    }
    if (w.tasks.some((t) => t.key === 'kuehlschrank' && t.items.some((i) => i.person === me))) mine.push(L('Kühlschrankfach', 'Fridge shelf', `Kylskåpshylla`));
    tiles.week = `<a class="card __CLS__" href="#plan"><h3>${L('Deine Woche', 'Your week', `Din vecka`)}</h3>
      ${me ? (mine.length ? `<div class="big">${mine.map(esc).join(', ')}</div>
        ${total ? `<p>${L(`${done} von ${total} erledigt`, `${done} of ${total} done`, `${done} av ${total} klart`)}</p><div class="progress"><b style="width:${Math.round((done / total) * 100)}%"></b></div>` : ''}`
        : `<div class="big">${L('Frei diese Woche 🎉', 'Free this week 🎉', `Ledig den här veckan 🎉`)}</div>`) : `<p>${L('Tipp oben auf deinen Namen.', 'Tap your name above.', `Tryck på ditt namn ovan.`)}</p>`}
      ${state.gami ? `<p class="streak-line">${streakLine()}</p>` : ''}</a>`;
    const t = (k) => w.tasks.find((x) => x.key === k);
    tiles.plan = `<a class="card __CLS__" href="#plan"><h3>${L('Putzplan', 'Cleaning', `Städning`)}</h3>
      <p>${L('Wochendienst', 'Weekly duty', `Veckotjänst`)}: <strong>${esc(t('woche')?.person || '–')}</strong></p>
      <p>${L('Bad vorne', 'Front bath', `Främre badrum`)}: ${esc(t('bad-vorne')?.person || '–')}</p><p>${L('Bad hinten', 'Back bath', `Bakre badrum`)}: ${esc(t('bad-hinten')?.person || '–')}</p>
      <p class="muted">${w.cleaner ? `🧹 ${L('Putzkraft', 'Cleaner', `Städhjälp`)} ${cleanerWhen(w)}${w.cleanerConfirmed ? ' ✓' : ''}` : w.ausfall ? L('⚠️ Putzkraft fällt aus', '⚠️ Cleaner cancelled', `⚠️ Städhjälpen inställd`) : L('Ohne Putzkraft', 'No cleaner', `Ingen städhjälp`)}</p></a>`;
  }
  if (me && state.gami) {
    const mine = badgesOf(me);
    const got = mine.filter((b) => b.level);
    const soon = mine.filter((b) => b.next).sort((a, b) => (b.n / b.next) - (a.n / a.next))[0];
    tiles.badges = `<div class="card __CLS__ badges-card" data-open-badges role="button" tabindex="0"><h3>🏅 ${L('Abzeichen', 'Badges', 'Märken')}</h3>
      <div class="b-icons">${got.length ? got.map((b) => `<span title="${esc(b.name(me))}">${b.icon}${b.level > 1 ? `<sup>${b.level}</sup>` : ''}</span>`).join('') : `<span class="muted small">${L('Noch keine, das erste kommt mit dem ersten erledigten Dienst.', 'None yet, the first comes with your first finished duty.', 'Inga än, det första kommer med din första klara tjänst.')}</span>`}</div>
      ${soon ? `<p class="muted small">${L('Als Nächstes', 'Up next', 'Nästa')}: ${soon.icon} ${esc(soon.name(me))} (${soon.n}/${soon.next})</p>` : ''}</div>`;
  }
  const sh = state.shop;
  tiles.shop = `<a class="card __CLS__" href="#einkauf"><h3>${L('Einkauf', 'Shopping', `Handla`)}</h3>${sh
    ? (sh.items.length ? `<div class="big">${sh.items.length}</div><p>${sh.items.slice(0, 3).map((i) => esc(i.name)).join(', ')}${sh.items.length > 3 ? ' …' : ''}</p>` : `<p>${L('Alles da 🎉', 'All stocked 🎉', `Allt finns 🎉`)}</p>`)
    : '<p class="muted">…</p>'}</a>`;
  const m = state.money;
  if (m) {
    const eur = m.byCurrency.EUR;
    const v = me ? eur.balances[me] || 0 : null;
    const owe = me ? eur.transfers.filter((x) => x.from === me) : [];
    tiles.money = `<a class="card __CLS__" href="#kasse"><h3>${L('Kasse', 'Money', `Kassa`)}</h3>${me
      ? `<div class="big" style="color:${v > 0 ? 'var(--done)' : v < 0 ? 'var(--warn)' : 'inherit'}">${v > 0 ? '+' : ''}${money(v)}</div>
        <p>${owe.length ? owe.map((x) => `${L('an', 'to', `till`)} ${esc(x.to)}: ${money(x.amount)}`).join('<br>') : v > 0 ? L('Du bekommst Geld zurück', "You're owed money", `Du ska få pengar`) : L('Du bist quitt', "You're square", `Du är kvitt`)}</p>`
      : ''}</a>`;
  } else {
    tiles.money = `<a class="card __CLS__" href="#kasse"><h3>${L('Kasse', 'Money', `Kassa`)}</h3><p class="muted">…</p></a>`;
  }
  const today = state.today;
  const now = absentNow(today);
  const next = (state.absences || []).filter((a) => a.from > today).slice(0, 3);
  const meet = (state.events || []).find((e) => e.type === 'meeting' && e.from >= today);
  const openPolls = (state.polls || []).filter((p) => p.status === 'open');
  const invites = (state.events || []).filter((e) => e.participants.some((p) => p.name === me && !p.ok));
  const nTopics = meet?.topics?.length || 0;
  tiles.cal = `<a class="card __CLS__" href="#kalender"><h3>${L('Kalender', 'Calendar', `Kalender`)}</h3>
    ${now.length ? `<p>${now.map((a) => `🏖️ <strong>${esc(a.person)}</strong> ${L('bis', 'until', `till`)} ${ddmm(a.to)}`).join('<br>')}</p>` : `<p>${L('Alle da', 'Everyone is home', `Alla är hemma`)}</p>`}
    ${next.length ? `<p class="muted">${next.map((a) => L(`${esc(a.person)} weg ab ${ddmm(a.from)}`, `${esc(a.person)} away from ${ddmm(a.from)}`, `${esc(a.person)} borta från ${ddmm(a.from)}`)).join('<br>')}</p>` : ''}
    ${meet ? `<p>🗣️ ${esc(meet.title && meet.title !== 'WG-Meeting' ? meet.title : L('WG-Meeting', 'Flat meeting', `Husmöte`))} ${ddmm(meet.from)} ${meet.time}${nTopics ? ` · ${nTopics} ${plural(nTopics, 'Thema', 'Themen', 'topic', 'topics', 'ämne', 'ämnen')}` : ''}</p>` : ''}
    ${openPolls.length ? `<p>🗳️ ${openPolls.length} ${plural(openPolls.length, 'Abstimmung offen', 'Abstimmungen offen', 'omröstning öppen', 'omröstningar öppna')}</p>` : ''}
    ${invites.length ? `<p><strong>📬 ${invites.length} ${plural(invites.length, 'Einladung für dich', 'Einladungen für dich', 'inbjudan till dig', 'inbjudningar till dig')}</strong></p>` : ''}</a>`;
  // Letzte WG-Meetings mit Protokoll
  const pastMeetings = (state.events || []).filter((e) => e.type === 'meeting' && e.to < today).sort((a, b) => (a.from < b.from ? 1 : -1)).slice(0, 3);
  if (pastMeetings.length) {
    tiles.meetings = `<div class="card __CLS__ meetings-card"><h3>${L('Letzte WG-Meetings', 'Recent flat meetings', `Senaste husmötena`)}</h3>
      ${pastMeetings.map((e) => {
        const txt = e.minutes?.text?.trim();
        const short = txt ? (txt.length > 140 ? `${txt.slice(0, 140)}…` : txt) : '';
        return `<button type="button" class="meeting-row" data-notes="${esc(e.id)}">
          <span><strong>🗣️ ${esc(evTitle(e))}</strong> <small class="muted">${fmtDay(e.from)}</small></span>
          <span class="muted small">${short ? esc(short) : L('Noch kein Protokoll, tippen zum Schreiben', 'No minutes yet, tap to write', `Inget protokoll än, tryck för att skriva`)}</span></button>`;
      }).join('')}</div>`;
  } else {
    tiles.meetings = `<a class="card __CLS__" href="#kalender"><h3>${L('Letzte WG-Meetings', 'Recent flat meetings', `Senaste husmötena`)}</h3><p class="muted">${L('Noch keine vergangenen WG-Meetings. Die Protokolle erscheinen dann hier.', 'No past flat meetings yet. Their minutes will show up here.', `Inga tidigare husmöten än. Protokollen visas sedan här.`)}</p></a>`;
  }
  tiles.rules = `<a class="card __CLS__" href="#regeln"><h3>${L('Hausregeln', 'House rules', `Husregler`)}</h3><p>${L('Mission Haussegen 📜 Alles zum WG-Seelenfrieden', 'Mission Haussegen 📜 Everything for peace in the flat', `Mission Haussegen 📜 Allt för husfriden`)}</p></a>`;
  Object.assign(tiles, extraTiles(w));
  const layout = homeLayout();
  const editing = state.editHome;
  let html = `<div class="dash${editing ? ' editing' : ''}">`;
  layout.forEach((x, i) => {
    let t = tiles[x.id];
    if (x.id.startsWith('sc:')) {
      const sc = SHORTCUTS[x.id.slice(3)];
      if (!sc) return;
      t = `<button type="button" class="card __CLS__ shortcut" data-shortcut="${x.id.slice(3)}"><span class="sc-icon">${sc.icon}</span><span>${L(sc.de, sc.en, sc.sv || sc.en)}</span></button>`;
    }
    if (!t) {
      if (!editing) return;
      t = `<div class="card __CLS__"><h3>${esc(widgetName(x.id))}</h3><p class="muted">${L('Gerade nichts anzuzeigen', 'Nothing to show right now', `Inget att visa just nu`)}</p></div>`;
    }
    t = t.replace('__CLS__', `tile${x.size === 'w' ? ' wide' : ''}`);
    if (editing) {
      t = `<div class="tile-edit${x.size === 'w' ? ' wide' : ''}">${t}<div class="tile-tools">
        <button type="button" data-tile-move="${i}" data-dir="-1" aria-label="${L('Nach vorne', 'Move up', `Flytta upp`)}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" data-tile-move="${i}" data-dir="1" aria-label="${L('Nach hinten', 'Move down', `Flytta ner`)}" ${i === layout.length - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" data-tile-size="${i}" aria-label="${x.size === 'w' ? L('Kleiner machen', 'Make smaller', `Gör mindre`) : L('Größer machen', 'Make bigger', `Gör större`)}" title="${x.size === 'w' ? L('Kleiner machen', 'Make smaller', `Gör mindre`) : L('Größer machen', 'Make bigger', `Gör större`)}">${x.size === 'w' ? '⇲ ' + L('klein', 'small', `liten`) : '⇱ ' + L('groß', 'big', `stor`)}</button>
        <button type="button" data-tile-del="${i}" aria-label="${L('Entfernen', 'Remove', `Ta bort`)}">✕</button></div></div>`;
    }
    html += t;
  });
  html += '</div>';
  html += editing
    ? `<div class="row dash-edit-bar"><button type="button" class="ghost" data-home-add>${L('+ Kachel oder Kurzbefehl', '+ Tile or shortcut', `+ Ruta eller genväg`)}</button><button type="button" class="ghost" data-home-reset>${L('Zurücksetzen', 'Reset', `Återställ`)}</button><button type="button" data-home-done>${L('Fertig', 'Done', `Klar`)}</button></div>`
    : `<div class="dash-edit-link"><button type="button" class="link small" data-home-edit>✏️ ${L('Übersicht anpassen', 'Customise overview', `Anpassa översikten`)}</button></div>`;
  el.innerHTML = html;

  $('#members-list').innerHTML = (state.members || [])
    .filter((x) => !x.until || x.until > state.current)
    .map((x) => {
      const away = now.some((a) => a.person === x.name);
      const future = x.since > state.current;
      const leaving = x.until;
      const side = x.side === 'hinten' ? L('hinten', 'back', `bak`) : L('vorne', 'front', `fram`);
      const bday = x.birthday ? ` · 🎂 ${ddmm(x.birthday)}` : '';
      return `<div class="member"><span>${avatar(x.name)}<span><strong>${esc(x.name)}</strong> <small>${L(`Zimmer ${side}`, `${side} room`, `Rum ${side}`)}${bday}${x.lang === 'en' ? ' · 🇬🇧' : x.lang === 'sv' ? ' · 🇸🇪' : ''}</small></span></span>
        <span>${away ? `<span class="tag away">${L('im Urlaub', 'on holiday', `på semester`)}</span> ` : ''}${future ? `<span class="tag">${L('ab', 'from', `från`)} ${ddmm(x.since)}</span>` : ''}${leaving ? `<span class="tag away">${L('zieht aus', 'moving out', `flyttar ut`)}</span>` : ''}</span></div>`;
    }).join('');
  $('#leave-open').hidden = !me;
}

// ---------------- Umfragen ----------------
function renderSurveys() {
  const el = $('#surveys');
  if (!el) return;
  const list = [...(state.surveys || [])].reverse();
  const open = list.filter((s) => s.status === 'open');
  const closed = list.filter((s) => s.status !== 'open').slice(0, 3);
  if (!open.length && !closed.length) {
    el.innerHTML = `<p class="muted small" style="margin:10px 0 0">${L('Frag die WG schnell etwas, z.B. ob jemand zu Hause ist, wenn die Putzkraft kommt. Alle bekommen eine Nachricht, und du erfährst, sobald alle geantwortet haben.', 'Quickly ask the flat something, e.g. whether anyone is home when the cleaner comes. Everyone gets a notification, and you find out as soon as everyone has answered.', `Fråga kollektivet något snabbt, t.ex. om någon är hemma när städhjälpen kommer. Alla får en notis, och du får veta så fort alla har svarat.`)}</p>`;
    return;
  }
  const one = (s) => {
    const mine = (s.votes || {})[state.me] || [];
    const voters = s.voters || Object.keys(s.votes || {});
    const others = state.people.filter((p) => p !== s.by);
    const missing = others.filter((p) => !voters.includes(p));
    const isOpen = s.status === 'open';
    return `<div class="survey${isOpen ? '' : ' closed'}">
      <h3>${esc(s.question)}</h3>
      <p class="muted small meta">${s.by ? `${L('von', 'from', `från`)} ${esc(s.by)} · ` : ''}${ago(s.at)} · ${missing.length ? `${L('fehlt noch', 'still missing', `saknas fortfarande`)}: ${missing.map(esc).join(', ')}` : L('alle haben abgestimmt ✓', 'everyone has answered ✓', `alla har svarat ✓`)}${isOpen ? '' : ` · ${L('beendet', 'closed', `avslutad`)}`}${s.multi ? ` · ${L('mehrere Antworten möglich', 'multiple answers', `flera svar`)}` : ''}${s.anon ? ` · 🕶️ ${L('anonym', 'anonymous', 'anonym')}` : ''}</p>
      ${s.options.map((o) => {
        const who = s.anon ? [] : voters.filter((n) => (s.votes[n] || []).includes(o.id));
        const n = s.counts ? s.counts[o.id] || 0 : who.length;
        const pct = voters.length ? Math.round((n / voters.length) * 100) : 0;
        return `<button type="button" class="s-opt" ${isOpen && state.me ? `data-svote="${esc(s.id)}" data-sopt="${esc(o.id)}"` : 'disabled'} aria-pressed="${mine.includes(o.id)}">
          <span class="bar" style="width:${pct}%"></span><span class="t">${mine.includes(o.id) ? '✓ ' : ''}${esc(o.text)}</span>
          <span class="who">${n} ${who.length ? `· ${who.map(esc).join(', ')}` : ''}</span></button>`;
      }).join('')}
      ${s.by === state.me || !s.by ? `<div class="row end"><button type="button" class="link small" data-sclose="${esc(s.id)}">${isOpen ? L('Umfrage beenden', 'Close poll', `Avsluta omröstning`) : L('Wieder öffnen', 'Reopen', `Öppna igen`)}</button>
        <button type="button" class="link small" data-sdel="${esc(s.id)}">${L('löschen', 'delete', `ta bort`)}</button></div>` : ''}
    </div>`;
  };
  el.innerHTML = open.map(one).join('') + (closed.length ? `<details class="explain"><summary>${L('Beendete Umfragen', 'Closed polls', `Avslutade omröstningar`)}</summary>${closed.map(one).join('')}</details>` : '');
}
function surveyOptRow(v = '') {
  return `<div class="row"><input maxlength="80" value="${esc(v)}" placeholder="${L('Antwort', 'Answer', `Svara`)}"><button type="button" class="ghost" data-sopt-del aria-label="${L('Entfernen', 'Remove', `Ta bort`)}">✕</button></div>`;
}
$('#survey-open').onclick = () => {
  const f = $('#survey-form');
  f.hidden = !f.hidden;
  if (f.hidden) return;
  f.reset();
  $('#survey-opts').innerHTML = [L('Ja', 'Yes', `Ja`), L('Nein', 'No', `Nej`)].map(surveyOptRow).join('');
  $('#survey-q').focus();
};
$('#survey-cancel').onclick = () => { $('#survey-form').hidden = true; };
$('#survey-add-opt').onclick = () => { $('#survey-opts').insertAdjacentHTML('beforeend', surveyOptRow()); $('#survey-opts .row:last-child input').focus(); };
$('#survey-opts').addEventListener('click', (e) => { if (e.target.closest('[data-sopt-del]')) e.target.closest('.row').remove(); });
$('#survey-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const options = [...document.querySelectorAll('#survey-opts input')].map((i) => i.value.trim()).filter(Boolean);
  try {
    const r = await api('surveys/add', { question: $('#survey-q').value, options, multi: $('#survey-multi').checked, anon: $('#survey-anon').checked, by: state.me });
    state.surveys = r.surveys;
    $('#survey-form').hidden = true;
    renderSurveys();
    toast(L('Umfrage verschickt, alle bekommen eine Nachricht', 'Poll sent, everyone gets a notification', `Omröstningen skickad, alla får en notis`));
  } catch (err) { toast(err.message); }
});
$('#surveys').addEventListener('click', async (e) => {
  try {
    const v = e.target.closest('[data-svote]');
    if (v) {
      const s = state.surveys.find((x) => x.id === v.dataset.svote);
      const mine = (s.votes || {})[state.me] || [];
      const o = v.dataset.sopt;
      const choices = s.multi ? (mine.includes(o) ? mine.filter((x) => x !== o) : [...mine, o]) : (mine.includes(o) ? [] : [o]);
      state.surveys = (await api('surveys/vote', { id: s.id, name: state.me, choices })).surveys;
      renderSurveys();
      return;
    }
    const c = e.target.closest('[data-sclose]');
    if (c) { state.surveys = (await api('surveys/close', { id: c.dataset.sclose, me: state.me })).surveys; renderSurveys(); return; }
    const d = e.target.closest('[data-sdel]');
    if (d) {
      if (!confirm(L('Umfrage löschen?', 'Delete this poll?', `Ta bort omröstningen?`))) return;
      state.surveys = (await api('surveys/delete', { id: d.dataset.sdel, me: state.me })).surveys;
      renderSurveys();
    }
  } catch (err) { toast(err.message); }
});

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
  if (!state.joinSide) { toast(L('Bitte vorne oder hinten wählen', 'Please choose front or back', `Välj fram eller bak`)); return; }
  const quick = $('#join').classList.contains('quick');
  if (!quick && !joinProfile.gender) { toast(L('Bitte dein Geschlecht angeben', 'Please choose your gender', `Välj ditt kön`)); return; }
  try {
    const r = await api('members/join', {
      name: $('#join-name').value, side: state.joinSide, lang: state.lang,
      birthday: $('#join-birthday').value || undefined, gender: joinProfile.gender || undefined, photo: joinProfile.photo || undefined, quick,
    });
    state.joining = false;
    history.replaceState(null, '', '#start');
    await load();
    toast(L(`Anfrage gesendet ✉️ ${state.admin || 'Die Admin'} muss dich noch freigeben.`, `Request sent ✉️ ${state.admin || 'The admin'} still has to approve you.`, `Förfrågan skickad ✉️ ${state.admin || 'Administratören'} måste godkänna dig.`));
  } catch (err) { toast(err.message); }
});
$('#invite').onclick = async () => {
  const url = `${location.origin}/#beitreten`;
  const text = L('Komm in unsere WG-Zentrale! Leg dir dort dein Profil an:', 'Join our flat app "Zentrale"! Create your profile here:', `Gå med i vår kollektiv-app "Zentrale"! Skapa din profil här:`);
  try {
    if (navigator.share) { await navigator.share({ title: 'WG-Zentrale', text, url }); return; }
  } catch { return; }
  try { await navigator.clipboard.writeText(`${text} ${url}`); toast(L('Einladungslink kopiert, schick ihn einfach weiter', 'Invite link copied, just send it on', `Inbjudningslänken är kopierad, skicka den vidare`)); } catch { prompt(L('Diesen Link verschicken:', 'Send this link:', `Skicka den här länken:`), url); }
};
$('#leave-open').onclick = async () => {
  if (!state.money) { try { state.money = await api('money'); } catch { /* egal */ } }
  const eur = state.money?.byCurrency?.EUR;
  const v = eur ? eur.balances[state.me] || 0 : 0;
  const owe = eur ? eur.transfers.filter((x) => x.from === state.me) : [];
  const oweList = owe.length ? ` (${owe.map((x) => `${esc(x.to)}: ${money(x.amount)}`).join(', ')})` : '';
  $('#leave-balance').innerHTML = v < 0
    ? `<div class="banner"><p>${L(`⚠️ Laut WG-Kasse schuldest du noch <strong>${money(-v)}</strong>${oweList}. Bitte vorher ausgleichen.`, `⚠️ According to the flat money you still owe <strong>${money(-v)}</strong>${oweList}. Please settle up first.`, `⚠️ Enligt kollektivkassan är du fortfarande skyldig <strong>${money(-v)}</strong>${oweList}. Gör upp först.`)}</p></div>`
    : v > 0 ? `<div class="banner"><p>${L(`💶 Du bekommst laut WG-Kasse noch <strong>${money(v)}</strong> zurück. Sprecht das am besten vorher ab.`, `💶 According to the flat money you're still owed <strong>${money(v)}</strong>. Best to sort it out before you go.`, `💶 Enligt kollektivkassan ska du fortfarande få <strong>${money(v)}</strong>. Gör upp det helst innan du flyttar.`)}</p></div>`
      : `<div class="banner"><p>${L('✅ Deine WG-Kasse ist ausgeglichen.', '✅ Your flat money is settled.', `✅ Din kollektivkassa är uppgjord.`)}</p></div>`;
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
      $('#bye-title').textContent = L(`Schade, dass du gehst, ${name}!`, `So sad to see you go, ${name}!`, `Så tråkigt att du flyttar, ${name}!`);
      $('#bye-text').textContent = L(`Du warst ${G(name, 'eine tolle Mitbewohnerin', 'ein toller Mitbewohner', 'ein:e tolle:r Mitbewohner:in')}, und wir werden dich wirklich vermissen: die Gespräche in der Küche, das gemeinsame Kochen und sogar deine Putzwochen. Danke für die schöne Zeit mit dir! Pass auf dich auf, komm uns besuchen, und für einen Kaffee oder eine Party bist du hier immer willkommen. 💛`,
        "We'll really miss you: the chats in the kitchen, cooking together and even your cleaning weeks. Thanks for the lovely time with you! Take care, come and visit, and you're always welcome here for a coffee or a party. 💛", `Vi kommer att sakna dig: pratstunderna i köket, matlagningen tillsammans och till och med dina städveckor. Tack för den fina tiden med dig! Ta hand om dig, kom och hälsa på, du är alltid välkommen på en kaffe eller en fest. 💛`);
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
/** Bild verkleinern (längste Seite max px) und als JPEG-Daten-URL zurückgeben */
async function resizeImage(file, max) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = url; });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.8);
  } finally { URL.revokeObjectURL(url); }
}
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
    try { st.photo = await resizePhoto(f); preview(st.photo); } catch { toast(L('Das Bild konnte nicht gelesen werden', 'The image could not be read', `Bilden kunde inte läsas`)); }
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
  $('#profile-form button[value=cancel]').textContent = intro ? L('Überspringen', 'Skip', 'Hoppa över') : L('Abbrechen', 'Cancel', 'Avbryt');
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
    if (!editProfile.gender) { toast(L('Bitte dein Geschlecht angeben', 'Please choose your gender', `Välj ditt kön`)); return; }
    try {
      const r = await api('members/profile', {
        name: m.name, newName: $('#profile-name').value, birthday: $('#profile-birthday').value, gender: editProfile.gender, photo: editProfile.photo,
      });
      if (r.name !== state.me) { state.me = r.name; store.set('me', r.name); }
      dlg.close();
      state.weeks.clear();
      await load();
      if (state.money) loadMoney();
      toast(L('Profil gespeichert', 'Profile saved', `Profilen är sparad`));
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
  sv: ['Januari', 'Februari', 'Mars', 'April', 'Maj', 'Juni', 'Juli', 'Augusti', 'September', 'Oktober', 'November', 'December'],
};
const TYPE_ICON = { urlaub: '🏖️', meeting: '🗣️', sonstiges: '📅' };
const typeLabel = (t) => ({ urlaub: L('Urlaub', 'Holiday', `Semester`), meeting: L('WG-Meeting', 'Flat meeting', `Husmöte`), sonstiges: L('Termin', 'Event', `Händelse`) }[t]);
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
  const dows = { en: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], sv: ['mån', 'tis', 'ons', 'tor', 'fre', 'lör', 'sön'] }[state.lang] || ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  let html = dows.map((d) => `<div class="dow">${d}</div>`).join('');
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    if (i >= 35 && d.slice(0, 7) !== state.calMonth) break;
    const wk = state.weeks.get(addDays(d, -dowOf(d)));
    const cleaner = wk && wk.cleaner && wk.cleanerDay === d;
    const pills = [];
    const hol = holidayOn(d);
    if (hol) pills.push(`<span class="pill hol${hol.legal || hol.sunday ? ' closed' : ''}" title="${esc(`${L(hol.de, hol.en, hol.sv || hol.en)}: ${holidayInfo(hol, state.lang)}`)}">${hol.legal ? '🔴' : hol.sunday ? '' : '⚪'} ${esc(L(hol.de, hol.en, hol.sv || hol.en))}</span>`);
    for (const m of (state.members || []).filter((x) => x.birthday && state.people.includes(x.name) && x.birthday.slice(5) === d.slice(5))) {
      pills.push(`<span class="pill bday" title="${L('Geburtstag', 'Birthday', `Födelsedag`)}">🎂 ${esc(m.name)}</span>`);
    }
    for (const e of evs) {
      if (e.from > d || e.to < d) continue;
      if (e.type === 'urlaub') {
        for (const p of e.participants) pills.push(`<span class="pill urlaub${p.ok ? '' : ' pending'}" title="${esc(p.name)}: ${typeLabel('urlaub')}">${esc(p.name)}</span>`);
      } else {
        pills.push(`<span class="pill ${e.type}" title="${esc(evTitle(e))}">${e.time ? `${e.time} ` : ''}${esc(evTitle(e))}</span>`);
      }
    }
    html += `<div class="day${d.slice(0, 7) !== state.calMonth ? ' out' : ''}${d === state.today ? ' today' : ''}${hol && hol.legal ? ' holiday' : ''}">
      <span class="n">${+d.slice(8)}${cleaner ? `<span title="${L('Putzkraft', 'Cleaner', `Städhjälp`)}">🧹</span>` : ''}</span>${pills.join('')}</div>`;
  }
  $('#cal-grid').innerHTML = html;
  const hols = berlinHolidays(y).filter((h) => h.date.startsWith(state.calMonth));
  $('#cal-holidays').innerHTML = hols.length
    ? `<h3>${L('Feiertage in Berlin', 'Holidays in Berlin', `Helgdagar i Berlin`)}</h3>${hols.map((h) => `<div class="hol-row${h.legal ? ' legal' : ''}"><span>${h.legal ? '🔴' : h.sunday ? '⚫' : '⚪'}</span><span><strong>${fmtDay(h.date)} · ${esc(L(h.de, h.en, h.sv || h.en))}</strong><br><small>${holidayInfo(h, state.lang)}</small></span></div>`).join('')}`
    : '';
  renderInbox();
  renderPolls();
  renderEvList();
}

function renderInbox() {
  const me = state.me;
  const pending = (state.events || []).filter((e) => e.participants.some((p) => p.name === me && !p.ok));
  const openPolls = (state.polls || []).filter((p) => p.status === 'open' && !(p.votes || {})[me]);
  if (!me || (!pending.length && !openPolls.length)) { $('#cal-inbox').innerHTML = ''; return; }
  $('#cal-inbox').innerHTML = `<section class="card inbox"><h2>${L('Für dich 📬', 'For you 📬', `Till dig 📬`)}</h2>
    ${pending.map((e) => `<div class="row"><span>${L(`<strong>${esc(e.by || 'Jemand')}</strong> hat dich beim Urlaub ${e.title ? `„${esc(e.title)}“ ` : ''}${fmtDay(e.from)} – ${fmtDay(e.to)} eingetragen.`,
      `<strong>${esc(e.by || 'Someone')}</strong> added you to the holiday ${e.title ? `"${esc(e.title)}" ` : ''}${fmtDay(e.from)} – ${fmtDay(e.to)}.`, `<strong>${esc(e.by || 'Någon')}</strong> har lagt till dig i semestern ${e.title ? `"${esc(e.title)}" ` : ''}${fmtDay(e.from)} – ${fmtDay(e.to)}.`)}</span>
      <span class="row" style="flex:none"><button class="small" data-respond="${esc(e.id)}" data-accept="1">${L('Bin dabei', "I'm in", `Jag är med`)}</button><button class="ghost small" data-respond="${esc(e.id)}" data-accept="0">${L('Nein', 'No', `Nej`)}</button></span></div>`).join('')}
    ${openPolls.map((p) => `<div class="row"><span>🗳️ ${L('Stimm ab', 'Vote', `Rösta`)}: <strong>${esc(evTitle({ ...p, type: 'meeting' }))}</strong>${p.by ? ` (${L('von', 'from', `från`)} ${esc(p.by)})` : ''}</span><button type="button" class="link small" data-goto-poll="${esc(p.id)}">${L('Zur Abstimmung', 'Go to poll', `Till omröstningen`)}</button></div>`).join('')}
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
  const voteLabel = { yes: L('Passt', 'Works', `Passar`), maybe: L('Vielleicht', 'Maybe', `Kanske`), no: L('Passt nicht', "Doesn't work", `Passar inte`) };
  $('#polls').innerHTML = open.map((poll) => {
    const mine = (poll.votes || {})[state.me] || {};
    const voters = Object.keys(poll.votes || {});
    const missing = state.people.filter((p) => !voters.includes(p));
    const best = Math.max(...poll.options.map((o) => pollScore(poll, o.id).score));
    return `<section class="card poll" id="poll-${esc(poll.id)}">
      <h2>🗳️ ${esc(evTitle({ ...poll, type: 'meeting' }))}</h2>
      <p class="muted small" style="margin:0 0 6px">${L('Angefragt von', 'Requested by', `Frågat av`)} ${esc(poll.by || '?')} · ${L('abgestimmt', 'voted', `röstat`)}: ${voters.length}/${state.people.length}${missing.length ? ` · ${L('fehlt noch', 'still missing', `saknas fortfarande`)}: ${missing.map(esc).join(', ')}` : ''}</p>
      ${poll.options.map((o) => {
        const sc = pollScore(poll, o.id);
        const who = (v) => voters.filter((n) => poll.votes[n][o.id] === v).map(esc).join(', ');
        return `<div class="opt${sc.score === best && best > 0 ? ' best' : ''}">
          <span class="when"><strong>${fmtDay(o.date)}</strong>, ${clock(o.time)}</span>
          <span class="votes">${state.me ? ['yes', 'maybe', 'no'].map((v) => `<button type="button" class="${v}" aria-pressed="${mine[o.id] === v}" data-vote="${esc(poll.id)}" data-opt="${esc(o.id)}" data-val="${v}" aria-label="${voteLabel[v]}">${{ yes: '✅', maybe: '🤔', no: '❌' }[v]}</button>`).join('') : ''}</span>
          <span class="tally">✅ ${sc.yes}${sc.yes ? ` (${who('yes')})` : ''} · 🤔 ${sc.maybe}${sc.maybe ? ` (${who('maybe')})` : ''} · ❌ ${sc.no}${sc.no ? ` (${who('no')})` : ''}
            · <button type="button" class="link small" data-close="${esc(poll.id)}" data-opt="${esc(o.id)}">${L('Diesen Termin festlegen', 'Pick this date', `Välj den här tiden`)}</button></span>
        </div>`;
      }).join('')}
      <div class="row end" style="margin-top:6px"><button type="button" class="link small" data-poll-del="${esc(poll.id)}">${L('Anfrage löschen', 'Delete request', `Ta bort förfrågan`)}</button></div>
    </section>`;
  }).join('');
}

function renderEvList() {
  const up = (state.events || []).filter((e) => e.to >= state.today);
  $('#ev-list').innerHTML = up.length
    ? up.map((e) => {
      const ppl = e.participants.length === state.people.length && e.type !== 'urlaub'
        ? L('alle', 'everyone', `alla`)
        : e.participants.map((p) => `${esc(p.name)}${p.ok ? '' : L(' (wartet auf Zusage)', ' (waiting to confirm)', ` (väntar på bekräftelse)`)}`).join(', ');
      return `<div class="ev"><div>${TYPE_ICON[e.type]} <strong>${esc(evTitle(e))}</strong>
        <small>${fmtDay(e.from)}${e.to !== e.from ? ` – ${fmtDay(e.to)}` : ''}${e.time ? `, ${clock(e.time)}` : ''} · ${ppl}${e.note ? ` · ${esc(e.note)}` : ''}</small></div>
        <div class="ev-actions">${e.type === 'meeting' ? `<button class="link small" data-notes="${esc(e.id)}">📝 ${L('Themen & Protokoll', 'Topics & minutes', `Ämnen & protokoll`)}${e.topics?.length ? ` (${e.topics.length})` : ''}</button>` : ''}
        <button class="link small" data-ev-del="${esc(e.id)}">${L('löschen', 'delete', `ta bort`)}</button></div></div>`;
    }).join('')
    : `<p class="empty">${L('Nichts eingetragen.', 'Nothing planned.', `Inget planerat.`)}</p>`;
  const past = (state.events || []).filter((e) => e.type === 'meeting' && e.to < state.today).sort((a, b) => (a.from < b.from ? 1 : -1));
  $('#past-meetings').innerHTML = past.length
    ? `<h3>${L('Vergangene WG-Meetings', 'Past flat meetings', `Tidigare husmöten`)}</h3>${past.map((e) => `<div class="ev"><div>🗣️ <strong>${esc(evTitle(e))}</strong>
        <small>${fmtDay(e.from)}${e.minutes?.text ? L(' · Protokoll vorhanden', ' · minutes available', ` · protokoll finns`) : L(' · noch kein Protokoll', ' · no minutes yet', ` · inget protokoll än`)}</small></div>
        <button class="link small" data-notes="${esc(e.id)}">📝 ${e.minutes?.text ? L('Protokoll lesen', 'Read minutes', `Läs protokoll`) : L('Protokoll schreiben', 'Write minutes', `Skriv protokoll`)}</button></div>`).join('')}`
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
          <button type="button" class="link small" data-topic-del="${esc(t.id)}" aria-label="${L('Thema entfernen', 'Remove topic', `Ta bort ämne`)}">✕</button></li>`).join('')
      : `<li class="muted">${L('Noch keine Themen.', 'No topics yet.', `Inga ämnen än.`)}</li>`;
    const m = e.minutes;
    const when = m?.at ? new Date(m.at).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    $('#notes-meta').textContent = m?.text ? L(`Zuletzt gespeichert${m.by ? ` von ${m.by}` : ''} am ${when}`, `Last saved${m.by ? ` by ${m.by}` : ''} on ${when}`, `Senast sparat${m.by ? ` by ${m.by}` : ''} den ${when}`) : '';
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
      draw(); renderEvList(); renderHome();
    } catch (err) { toast(err.message); }
  };
  $('#notes-topic-add').onclick = addTopic;
  $('#notes-topic').onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); addTopic(); } };
  $('#notes-topics').onclick = async (ev) => {
    const b = ev.target.closest('[data-topic-del]');
    if (!b) return;
    try { applyCal(await api('events/notes/topic-delete', { id, topic: b.dataset.topicDel })); draw(); renderEvList(); renderHome(); } catch (err) { toast(err.message); }
  };
  $('#notes-form').onsubmit = async (ev) => {
    if (ev.submitter?.value !== 'ok') return;
    ev.preventDefault();
    try {
      applyCal(await api('events/notes/minutes', { id, text: $('#notes-minutes').value, by: state.me }));
      draw(); renderEvList(); renderHome();
      toast(L('Protokoll gespeichert', 'Minutes saved', `Protokollet är sparat`));
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
  $('#ev-from-label').textContent = t === 'meeting' ? L('Datum', 'Date', `Datum`) : L('Von', 'From', `Från`);
  $('#ev-title').placeholder = {
    urlaub: L('z.B. Heimaturlaub, Skifahren', 'e.g. visiting family, skiing', `t.ex. hälsa på familjen, skidåkning`),
    meeting: L('WG-Meeting', 'Flat meeting', `Husmöte`),
    sonstiges: L('z.B. Hausbesichtigung, Party', 'e.g. flat viewing, party', `t.ex. visning, fest`),
  }[t];
  if (!state.evPeople) state.evPeople = new Set(t === 'meeting' ? state.people : [state.me].filter(Boolean));
  $('#ev-people').innerHTML = state.people.map((p) => `<button type="button" class="chip" aria-pressed="${state.evPeople.has(p)}" data-evp="${esc(p)}">${esc(p)}</button>`).join('');
  $('#ev-people-hint').textContent = t === 'urlaub' ? L('Andere, die du hinzufügst, müssen selbst bestätigen, dass sie dabei sind.', 'Anyone else you add has to confirm themselves that they are in.', `Alla andra du lägger till måste själva bekräfta att de är med.`) : '';
}
$('#cleaner-open').onclick = () => openCleaner();
$('#ics-open').onclick = () => {
  const update = () => {
    const q = new URLSearchParams();
    const kinds = [...document.querySelectorAll('#ics-kinds input')].filter((c) => c.checked && !c.closest('label').hidden).map((c) => c.value);
    if (state.me && kinds.includes('dienste')) q.set('p', state.me);
    if (kinds.length < document.querySelectorAll('#ics-kinds input').length - (state.me ? 0 : 1)) q.set('inc', kinds.join(','));
    if (state.lang !== 'de') q.set('lang', state.lang);
    const https = `${location.origin}/api/calendar.ics${q.toString() ? `?${q}` : ''}`;
    const webcal = https.replace(/^https?:/, 'webcal:');
    $('#ics-apple').href = webcal;
    $('#ics-google').href = `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`;
    $('#ics-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(https); toast(L('Link kopiert', 'Link copied', `Länken är kopierad`)); } catch { prompt(L('Link kopieren:', 'Copy link:', `Kopiera länken:`), https); }
    };
  };
  $('#ics-mine-row').hidden = !state.me;
  for (const c of document.querySelectorAll('#ics-kinds input')) c.onchange = update;
  update();
  $('#ics-dialog').showModal();
};
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
  if (!state.evPeople.size) { toast(L('Bitte mindestens eine Person auswählen', 'Please choose at least one person', `Välj minst en person`)); return; }
  try {
    const data = await api('events/add', {
      type: state.evType, title: $('#ev-title').value, from: $('#ev-from').value, to: $('#ev-to').value || $('#ev-from').value,
      time: state.evType === 'meeting' ? $('#ev-time').value : '', note: $('#ev-note').value, participants: [...state.evPeople], by: state.me,
    });
    applyCal(data);
    $('#ev-form').hidden = true;
    state.weeks.clear();
    await load();
    toast(state.evType === 'urlaub' && state.evPeople.size > 1 ? L('Eingetragen, die anderen müssen noch zustimmen', 'Added, the others still have to confirm', `Tillagt, de andra måste fortfarande bekräfta`) : L('Eingetragen', 'Added', `Tillagt`));
  } catch (err) { toast(err.message); }
});

// Meeting-Anfrage
function pollOptRow(date = '', time = '19:00') {
  return `<div class="poll-opt-row"><input type="date" value="${date}" required><input type="time" value="${time}" required>
    <button type="button" class="ghost" data-opt-del aria-label="${L('Entfernen', 'Remove', `Ta bort`)}">✕</button></div>`;
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
    toast(L('Anfrage verschickt, alle können jetzt abstimmen', 'Request sent, everyone can vote now', `Förfrågan skickad, alla kan rösta nu`));
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
      if (!confirm(L(`WG-Meeting auf ${fmtDay(o.date)}, ${o.time} Uhr festlegen? Alle bekommen eine Nachricht.`, `Set the flat meeting for ${fmtDay(o.date)}, ${o.time}? Everyone gets a notification.`, `Bestämma husmötet till ${fmtDay(o.date)}, ${o.time}? Alla får en notis.`))) return;
      applyCal(await api('polls/close', { id: poll.id, optionId: o.id, by: state.me }));
      renderCal(); renderHome();
      toast(L('Termin steht 🎉', 'Date is set 🎉', `Tiden är bestämd 🎉`));
      return;
    }
    const pdel = t.closest('[data-poll-del]');
    if (pdel) {
      if (!confirm(L('Anfrage löschen?', 'Delete this request?', `Ta bort förfrågan?`))) return;
      applyCal(await api('polls/delete', { id: pdel.dataset.pollDel }));
      renderCal(); renderHome();
      return;
    }
    const resp = t.closest('[data-respond]');
    if (resp) {
      applyCal(await api('events/respond', { id: resp.dataset.respond, name: state.me, accept: resp.dataset.accept === '1' }));
      state.weeks.clear();
      await load();
      toast(resp.dataset.accept === '1' ? L('Bestätigt, schönen Urlaub! 🏖️', 'Confirmed, have a great holiday! 🏖️', `Bekräftat, ha en fin semester! 🏖️`) : L('Abgelehnt', 'Declined', `Nekad`));
      return;
    }
    const notes = t.closest('[data-notes]');
    if (notes) { openNotes(notes.dataset.notes); return; }
    const del = t.closest('[data-ev-del]');
    if (del) {
      if (!confirm(L('Eintrag löschen?', 'Delete this entry?', `Ta bort posten?`))) return;
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
// Passwortfelder: Auge zum Anzeigen/Verbergen
document.querySelectorAll('input[type=password]').forEach((inp) => {
  const wrap = document.createElement('span');
  wrap.className = 'pw-wrap';
  inp.replaceWith(wrap);
  wrap.append(inp);
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'pw-eye';
  const set = (show) => {
    inp.type = show ? 'text' : 'password';
    b.textContent = show ? '🙈' : '👁️';
    b.setAttribute('aria-label', show ? L('Passwort verbergen', 'Hide password', 'Dölj lösenord') : L('Passwort anzeigen', 'Show password', 'Visa lösenord'));
  };
  b.onclick = () => set(inp.type === 'password');
  set(false);
  wrap.append(b);
  inp.closest('dialog')?.addEventListener('close', () => set(false));
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
setLang(state.lang, { rerender: false });
markJoinLang();
showTab();
if (store.get('token') && currentTab() !== 'shop') api('shop').then((d) => { state.shop = d; renderShop(); }).catch(() => {});
load().catch((e) => {
  $('#week').innerHTML = `<div class="card"><p>${L(`Der Plan konnte nicht geladen werden (${esc(e.message)}). Bitte später nochmal versuchen.`, `The rota could not be loaded (${esc(e.message)}). Please try again later.`, `Schemat kunde inte laddas (${esc(e.message)}). Försök igen senare.`)}</p></div>`;
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  state.weeks.clear();
  load().catch(() => {});
  if (!store.get('token')) return;
  if (currentTab() === 'shop') loadShop();
  if (currentTab() === 'money') loadMoney();
});
