const $ = (s) => document.querySelector(s);
const ddmm = (s) => `${s.slice(8, 10)}.${s.slice(5, 7)}.`;
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
  people: [],
  current: null,
  view: null,
  weeks: new Map(), // monday -> week
};

async function api(path, body) {
  const res = await fetch(`/api/${path}`, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2800);
}

// ---------------- Laden ----------------
async function load() {
  const data = await api('weeks?count=12');
  state.people = data.people;
  state.current = data.current;
  for (const w of data.weeks) state.weeks.set(w.monday, w);
  if (!state.view || !state.weeks.has(state.view)) state.view = state.current;
  render();
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
  renderWeek();
  renderUpcoming();
  renderNotify();
}

function renderMe() {
  const pick = $('#pick-me');
  pick.hidden = !!state.me;
  $('#change-me').hidden = !state.me;
  $('#who-line').textContent = state.me ? `Hallo ${state.me} 👋` : 'Mission Haussegen';
  $('#people-buttons').innerHTML = state.people.map((p) => `<button data-me="${esc(p)}">${esc(p)}</button>`).join('');
}

function weekTitle(monday) {
  const diff = Math.round((Date.parse(monday) - Date.parse(state.current)) / (7 * 86400000));
  if (diff === 0) return 'Diese Woche';
  if (diff === 1) return 'Nächste Woche';
  if (diff === -1) return 'Letzte Woche';
  return diff > 0 ? `In ${diff} Wochen` : `Vor ${-diff} Wochen`;
}

function renderWeek() {
  const w = state.weeks.get(state.view);
  if (!w) return;
  $('#week-title').textContent = weekTitle(w.monday);
  $('#week-range').textContent = `${ddmm(w.monday)} – ${ddmm(w.sunday)}`;

  let html = '';
  if (w.plannedCleaner) {
    html += `<div class="banner"><p>${w.ausfall
      ? '⚠️ <strong>Putzkraft fällt aus.</strong> Diese Woche putzen wir selbst (Intensivputz).'
      : `🧹 <strong>Putzkraft kommt Mi ${ddmm(w.cleanerDay)}</strong> und putzt Bäder, Böden und Müll.`}</p>
      <button class="link" data-ausfall="${w.ausfall ? 0 : 1}">${w.ausfall ? 'Doch nicht ausgefallen' : 'Putzkraft fällt aus?'}</button></div>`;
  } else {
    html += '<div class="banner"><p>🫧 <strong>Woche ohne Putzkraft.</strong> Wir putzen selbst.</p></div>';
  }

  const tasks = [...w.tasks].sort((a, b) => (b.person === state.me) - (a.person === state.me));
  for (const t of tasks) {
    const items = t.items;
    const doneCount = items.filter((it) => w.checks[`${t.key}:${it.id}`]).length;
    const mine = t.person === state.me || items.some((it) => it.person === state.me);
    const complete = items.length > 0 && doneCount === items.length;
    html += `<article class="card task${mine ? ' mine' : ''}${complete ? ' complete' : ''}">
      <header><h3>${esc(t.title)}</h3>${t.person ? `<span class="person">${esc(t.person)}${t.person !== t.planned ? ` <span class="swapped">(statt ${esc(t.planned)})</span>` : ''}</span>` : `<span class="muted small">${doneCount}/${items.length}</span>`}</header>
      ${t.note ? `<p class="note">${esc(t.note)}</p>` : ''}
      ${items.map((it) => {
        const key = `${t.key}:${it.id}`;
        const c = w.checks[key];
        return `<label class="check${c ? ' done' : ''}"><input type="checkbox" data-check="${esc(key)}" ${c ? 'checked' : ''}>
          <span>${esc(it.label)}${c?.by ? `<small>erledigt von ${esc(c.by)}</small>` : ''}</span></label>`;
      }).join('')}
      ${t.person ? `<div class="actions"><button class="ghost small" data-swap="${t.key}">Tauschen</button></div>` : ''}
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
      const name = esc(t.person);
      return t.person === state.me ? `<span class="me">${name}</span>` : name;
    };
    rows.push(`<tr class="${i === 0 ? 'current' : ''}${w.cleaner ? ' pk' : ''}"><td>${ddmm(w.monday)}</td>
      <td>${w.plannedCleaner ? (w.ausfall ? 'fällt aus' : `Mi`) : '–'}</td>
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

async function renderNotify() {
  const box = $('#notify');
  const body = $('#notify-body');
  if (!state.me) { box.hidden = true; return; }
  box.hidden = false;

  if (!pushSupported) {
    if (isIOS && !isStandalone) {
      body.innerHTML = `<h2>🔔 Erinnerungen aufs iPhone</h2>
        <p>Damit dein iPhone dich erinnern kann, musst du die Seite einmal zum Home-Bildschirm hinzufügen:</p>
        <ol class="steps"><li>Unten in Safari auf <strong>Teilen</strong> tippen (Viereck mit Pfeil).</li>
        <li><strong>Zum Home-Bildschirm</strong> wählen und hinzufügen.</li>
        <li>Die Putzplan-App vom Home-Bildschirm öffnen und hier auf „Erinnerungen aktivieren“ tippen.</li></ol>`;
    } else {
      body.innerHTML = '<h2>🔔 Erinnerungen</h2><p class="muted">Dieser Browser kann leider keine Erinnerungen empfangen. Probier es mit Chrome, Firefox, Edge oder Safari.</p>';
    }
    return;
  }

  const sub = await currentSubscription();
  if (sub) {
    // Server-Zuordnung aktuell halten (z.B. nach "Person wechseln")
    api('subscribe', { person: state.me, subscription: sub.toJSON() }).catch(() => {});
    body.innerHTML = `<div class="row" style="justify-content:space-between">
      <p style="margin:0">🔔 <strong>Erinnerungen sind an.</strong><br><span class="muted small">Sonntag 19 Uhr für die neue Woche, Freitag 18 Uhr falls noch was offen ist.</span></p>
      <div class="row"><button class="ghost small" id="test-push">Test</button><button class="link" id="push-off">Ausschalten</button></div></div>`;
    $('#test-push').onclick = async () => {
      try { await api('test', { endpoint: sub.endpoint }); toast('Test-Nachricht ist unterwegs'); } catch (e) { toast(e.message); }
    };
    $('#push-off').onclick = async () => {
      await api('unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
      renderNotify();
    };
    return;
  }

  if (Notification.permission === 'denied') {
    body.innerHTML = '<h2>🔔 Erinnerungen blockiert</h2><p class="muted">Du hast Benachrichtigungen für diese Seite abgelehnt. Erlaube sie in den Einstellungen deines Browsers bzw. Handys und lade die Seite neu.</p>';
    return;
  }
  body.innerHTML = `<h2>🔔 Erinnerungen bekommen</h2>
    <p>Sonntagabend siehst du, was in der neuen Woche ansteht. Wenn am Freitag noch etwas nicht abgehakt ist, kommt eine kurze Erinnerung.</p>
    <button id="push-on">Erinnerungen aktivieren</button>`;
  $('#push-on').onclick = enablePush;
}

async function enablePush() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { renderNotify(); return; }
    const { publicKey } = await api('vapid');
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
    await api('subscribe', { person: state.me, subscription: sub.toJSON() });
    toast('Erinnerungen sind an 🎉');
  } catch (e) {
    toast(`Hat nicht geklappt: ${e.message}`);
  }
  renderNotify();
}

// ---------------- Events ----------------
document.addEventListener('click', async (e) => {
  const meBtn = e.target.closest('[data-me]');
  if (meBtn && meBtn.closest('#people-buttons')) {
    state.me = meBtn.dataset.me;
    store.set('me', state.me);
    render();
    return;
  }
  const swapBtn = e.target.closest('[data-swap]');
  if (swapBtn) { openSwap(swapBtn.dataset.swap); return; }

  const ausfall = e.target.closest('[data-ausfall]');
  if (ausfall) {
    const value = ausfall.dataset.ausfall === '1';
    if (value && !confirm('Putzkraft fällt diese Woche aus? Dann kommen die Extra-Aufgaben (Küche, Flure, Bäder) dazu.')) return;
    const w = await api('ausfall', { monday: state.view, value });
    state.weeks.set(w.monday, w);
    render();
  }
});

$('#change-me').onclick = () => {
  state.me = null;
  render();
};

document.addEventListener('change', async (e) => {
  const key = e.target.dataset?.check;
  if (!key) return;
  const done = e.target.checked;
  e.target.closest('.check').classList.toggle('done', done);
  try {
    const w = await api('check', { monday: state.view, key, done, by: state.me });
    state.weeks.set(w.monday, w);
    renderWeek();
    if (done) toast('Super, danke! ✨');
  } catch (err) {
    e.target.checked = !done;
    toast(`Konnte nicht speichern: ${err.message}`);
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
  $('#swap-title').textContent = `${t.title} tauschen`;
  $('#swap-text').textContent = `Wer übernimmt diese Woche (${ddmm(w.monday)} – ${ddmm(w.sunday)}) statt ${t.person}? Sagt am besten auch kurz in der WG-Gruppe Bescheid.`;
  $('#swap-people').innerHTML = state.people.filter((p) => p !== t.person)
    .map((p) => `<button type="button" data-swap-to="${esc(p)}">${esc(p)}${p === t.planned ? ' (laut Plan)' : ''}</button>`).join('');
  const dlg = $('#swap-dialog');
  $('#swap-people').onclick = async (e) => {
    const b = e.target.closest('[data-swap-to]');
    if (!b) return;
    const person = b.dataset.swapTo === t.planned ? null : b.dataset.swapTo;
    const nw = await api('swap', { monday: state.view, task: taskKey, person });
    state.weeks.set(nw.monday, nw);
    dlg.close();
    render();
    toast('Getauscht');
  };
  dlg.showModal();
}

// ---------------- Start ----------------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
load().catch((e) => {
  $('#week').innerHTML = `<div class="card"><p>Der Plan konnte nicht geladen werden (${esc(e.message)}). Bitte später nochmal versuchen.</p></div>`;
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { state.weeks.clear(); load().catch(() => {}); }
});
