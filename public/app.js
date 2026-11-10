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
  state.members = data.members;
  state.absences = data.absences;
  state.today = data.today;
  state.current = data.current;
  if (state.me && !state.people.includes(state.me)) { state.me = null; store.set('me', ''); }
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
      ? '⚠️ <strong>Putzkraft fällt aus.</strong> Diese Woche putzen wir selbst (Intensivputz). Ab nächster Woche ist der Plan eine Woche später dran.'
      : `🧹 <strong>Putzkraft kommt Mi ${ddmm(w.cleanerDay)}</strong> und putzt Bäder, Böden und Müll.`}</p>
      <button class="link" data-ausfall="${w.ausfall ? 0 : 1}">${w.ausfall ? 'Doch nicht ausgefallen' : 'Putzkraft fällt aus?'}</button></div>`;
  } else {
    html += '<div class="banner"><p>🫧 <strong>Woche ohne Putzkraft.</strong> Wir putzen selbst.</p></div>';
  }

  if (w.away && w.away.length) {
    html += `<div class="banner"><p>🏖️ <strong>${w.away.map(esc).join(', ')}</strong> ${w.away.length > 1 ? 'sind' : 'ist'} diese Woche weg und wurde${w.away.length > 1 ? 'n' : ''} im Plan übersprungen.</p></div>`;
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
    if (state.money) renderMoney();
    return;
  }
  const swapBtn = e.target.closest('[data-swap]');
  if (swapBtn) { openSwap(swapBtn.dataset.swap); return; }

  const ausfall = e.target.closest('[data-ausfall]');
  if (ausfall) {
    const value = ausfall.dataset.ausfall === '1';
    const msg = value
      ? 'Putzkraft fällt diese Woche aus?\n\nDann putzen wir diese Woche selbst (Küche, Flure, Bäder), ab nächster Woche rutscht der ganze Plan um eine Woche, und alle bekommen sofort eine Nachricht.'
      : 'Doch nicht ausgefallen? Der Plan rutscht dann wieder zurück.';
    if (!confirm(msg)) return;
    try {
      await api('ausfall', { monday: state.view, value });
      state.weeks.clear(); // alle folgenden Wochen ändern sich
      await load();
      await ensureWeek(state.view);
      renderWeek();
      toast(value ? 'Eingetragen, alle wurden benachrichtigt' : 'Zurückgenommen');
    } catch (err) { toast(err.message); }
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

// ---------------- Tabs ----------------
const TABS = { start: 'home', plan: 'plan', einkauf: 'shop', kasse: 'money', kalender: 'cal', regeln: 'rules' };
function currentTab() { return TABS[location.hash.slice(1)] || 'home'; }
function showTab() {
  const tab = currentTab();
  for (const t of ['home', 'plan', 'shop', 'money', 'cal', 'rules']) $(`#tab-${t}`).hidden = t !== tab;
  renderMe();
  if (tab === 'home') { renderHome(); loadMoney(); loadShop(); }
  if (tab === 'cal') renderCal();
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  if (tab === 'shop') loadShop();
  if (tab === 'money') loadMoney();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', showTab);

function ago(ts) {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min.`;
  const h = Math.round(min / 60);
  if (h < 24) return `vor ${h} Std.`;
  const d = Math.round(h / 24);
  if (d === 1) return 'gestern';
  if (d < 7) return `vor ${d} Tagen`;
  const d2 = new Date(ts);
  return d2.toLocaleDateString('de-DE', d2.getFullYear() === new Date().getFullYear() ? { day: '2-digit', month: '2-digit' } : { day: '2-digit', month: '2-digit', year: 'numeric' });
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
    `<button type="button" class="chip" role="radio" aria-checked="${c.id === state.shopCat}" data-cat="${c.id}">${c.icon} ${esc(c.label)}</button>`).join('');
  if (!sh.items.length) {
    $('#shop-list').innerHTML = '<div class="card"><p class="empty">Alles da! 🎉 Wenn etwas leer ist, trag es oben ein.</p></div>';
    return;
  }
  $('#shop-list').innerHTML = sh.categories.map((c) => {
    const items = sh.items.filter((i) => i.cat === c.id);
    if (!items.length) return '';
    return `<section class="card shop-cat"><h2>${c.icon} ${esc(c.label)} <span class="muted small">${items.length}</span></h2>
      ${items.map((i) => `<div class="shop-item"><div class="name">${esc(i.name)}<small>${i.by ? `${esc(i.by)}, ` : ''}${ago(i.at)}</small></div>
        <button class="ghost small" data-bought="${esc(i.id)}">Gekauft ✓</button></div>`).join('')}
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
    toast('Steht auf der Liste');
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
  $('#bought-title').textContent = `${item.name} gekauft 🎉`;
  $('#bought-price').value = '';
  const dlg = $('#bought-dialog');
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'ok') return;
    const price = $('#bought-price').value.trim();
    try {
      state.shop = await api('shop/done', { id: item.id, price: price || undefined, by: state.me });
      renderShop();
      toast(price ? 'Danke! Betrag steht in der WG-Kasse.' : 'Danke!');
      state.money = null;
    } catch (err) { toast(err.message); }
  };
  dlg.returnValue = '';
  dlg.showModal();
});

// Kategorien bearbeiten
function catRow(c = { label: '', icon: '🛒' }) {
  return `<div class="cat-row" data-id="${esc(c.id || '')}">
    <input class="ic" value="${esc(c.icon)}" maxlength="8" aria-label="Emoji">
    <input class="lb" value="${esc(c.label)}" maxlength="40" placeholder="Name" aria-label="Name">
    <button type="button" class="ghost" data-cat-del aria-label="Löschen">🗑</button></div>`;
}
$('#edit-cats').addEventListener('click', () => {
  $('#cats-list').innerHTML = state.shop.categories.map(catRow).join('');
  const dlg = $('#cats-dialog');
  dlg.returnValue = '';
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'ok') return;
    const categories = [...document.querySelectorAll('#cats-list .cat-row')].map((r) => ({
      id: r.dataset.id || undefined, icon: r.querySelector('.ic').value.trim(), label: r.querySelector('.lb').value.trim(),
    })).filter((c) => c.label);
    try {
      state.shop = await api('shop/categories', { categories });
      if (!state.shop.categories.some((c) => c.id === state.shopCat)) state.shopCat = state.shop.categories[0].id;
      renderShop();
      toast('Kategorien gespeichert');
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
const money = (cents, cur = 'EUR') => new Intl.NumberFormat('de-DE', { style: 'currency', currency: cur }).format(cents / 100);
const MODE_HINT = {
  equal: 'Wird gleichmäßig auf die ausgewählten Personen aufgeteilt.',
  percent: 'Prozent pro Person eintragen, zusammen 100 %.',
  shares: 'Anteile eintragen, z.B. 2 und 1 heißt: die erste Person zahlt doppelt so viel.',
  exact: 'Genaue Beträge eintragen, zusammen der Gesamtbetrag.',
};

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
          <button class="ghost small" data-settle='${esc(JSON.stringify({ ...t, currency: c }))}'>Bezahlt</button></span></div>`).join('')
      : '<p class="empty">Alle sind quitt. 🙌</p>';
    if (multi) bHtml += `<p class="cur-head" style="grid-column:1/-1">${c}</p>`;
    bHtml += [...m.people, ...(m.former || []).filter((p) => balances[p])].map((p) => {
      const v = balances[p] || 0;
      return `<div class="bal${p === state.me ? ' mine-bal' : ''}"><div class="who">${esc(p)}${m.people.includes(p) ? '' : ' (ausgezogen)'}</div>
        <div class="amt ${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${v > 0 ? '+' : ''}${money(v, c)}</div></div>`;
    }).join('');
  }
  $('#money-transfers').innerHTML = tHtml;
  $('#money-balances').innerHTML = bHtml;

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
          ? `${esc(e.paidBy)} hat ${to.map(esc).join(', ')} Geld zurückgegeben · Splitwise`
          : `${esc(e.paidBy || '?')} hat bezahlt · Splitwise`;
      } else {
        const parts = e.parts || Object.fromEntries((e.split || []).map((p) => [p, null]));
        let forWho;
        if (e.mode && e.mode !== 'equal') forWho = Object.entries(parts).map(([p, v]) => `${esc(p)} ${money(v, cur)}`).join(', ');
        else forWho = Object.keys(parts).length === m.people.length ? 'für alle' : `für ${Object.keys(parts).map(esc).join(', ')}`;
        who = settleRow ? `${esc(e.paidBy)} hat ${esc(Object.keys(parts)[0])} Geld zurückgegeben` : `${esc(e.paidBy)} hat bezahlt · ${forWho}`;
      }
      return `<div class="exp${settleRow ? ' settle' : ''}"><div class="d">${esc(e.desc)}<small>${who} · ${ago(e.at)}</small></div>
        <div class="r"><strong>${money(e.amount, cur)}</strong><button class="link small" data-del="${esc(e.id)}">löschen</button></div></div>`;
    }).join('')
    : '<p class="empty">Noch nichts eingetragen.</p>';
}

function renderSplit() {
  const m = state.money;
  document.querySelectorAll('#m-mode [data-mode]').forEach((b) => b.setAttribute('aria-checked', b.dataset.mode === state.mode));
  const equal = state.mode === 'equal';
  $('#m-split').hidden = !equal;
  $('#m-values').hidden = equal;
  if (equal) {
    $('#m-split').innerHTML = m.people.map((p) =>
      `<button type="button" class="chip" aria-pressed="${state.split.has(p)}" data-split="${esc(p)}">${esc(p)}</button>`).join('');
  } else {
    const unit = state.mode === 'percent' ? '%' : state.mode === 'shares' ? 'Anteile' : $('#m-cur').value || 'EUR';
    const old = Object.fromEntries([...document.querySelectorAll('#m-values input')].map((i) => [i.name, i.value]));
    $('#m-values').innerHTML = m.people.map((p) => `<label><span>${esc(p)}</span>
      <input name="${esc(p)}" inputmode="decimal" placeholder="0" value="${esc(old[p] ?? '')}" aria-label="${esc(p)} in ${unit}"><small class="muted">${unit}</small></label>`).join('');
  }
  updateHint();
}
function updateHint() {
  let hint = MODE_HINT[state.mode];
  if (state.mode !== 'equal') {
    const nums = [...document.querySelectorAll('#m-values input')].map((i) => Number(i.value.replace(',', '.')) || 0);
    const sum = nums.reduce((a, b) => a + b, 0);
    if (state.mode === 'percent') hint += ` Bisher: ${Math.round(sum * 100) / 100} %.`;
    if (state.mode === 'exact') {
      const total = Number($('#m-amount').value.replace(',', '.')) || 0;
      const rest = Math.round((total - sum) * 100);
      hint += rest ? ` Noch zu verteilen: ${money(rest, $('#m-cur').value)}.` : ' Passt genau.';
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
  if (state.mode === 'equal' && !state.split.size) { toast('Bitte mindestens eine Person auswählen'); return; }
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
    toast('Eingetragen');
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
    toast(`${r.imported} Einträge übernommen${r.matches ? ', Salden stimmen mit Splitwise überein ✓' : ''}`);
  } catch (err) { toast(err.message); }
});
$('#tab-money').addEventListener('click', async (e) => {
  const s = e.target.closest('[data-settle]');
  if (s) {
    const t = JSON.parse(s.dataset.settle);
    if (!confirm(`Hat ${t.from} ${t.to} ${money(t.amount, t.currency)} zurückgezahlt?`)) return;
    try {
      state.money = await api('money/add', {
        kind: 'settle', desc: 'Rückzahlung', amount: (t.amount / 100).toFixed(2), currency: t.currency, paidBy: t.from, split: [t.to], by: state.me,
      });
      renderMoney();
      toast('Ausgeglichen 👍');
    } catch (err) { toast(err.message); }
    return;
  }
  const d = e.target.closest('[data-del]');
  if (d) {
    if (!confirm('Diesen Eintrag wirklich löschen?')) return;
    try { state.money = await api('money/delete', { id: d.dataset.del }); renderMoney(); } catch (err) { toast(err.message); }
  }
});

// ---------------- Übersicht (Dashboard) ----------------
const fmtDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
function absentNow(day) { return (state.absences || []).filter((a) => a.from <= day && a.to >= day); }

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
      if (t.person === me && t.key !== 'kuehlschrank') mine.push(t.title + (t.key.startsWith('bad-') && !t.cleaningWeek ? ' (nur Klopapier)' : ''));
    }
    if (w.tasks.some((t) => t.key === 'kuehlschrank' && t.items.some((i) => i.person === me))) mine.push('Kühlschrankfach');
    html += `<a class="card wide" href="#plan"><h3>Deine Woche</h3>
      ${me ? (mine.length ? `<div class="big">${mine.map(esc).join(', ')}</div>
        ${total ? `<p>${done} von ${total} erledigt</p><div class="progress"><b style="width:${Math.round((done / total) * 100)}%"></b></div>` : ''}`
        : `<div class="big">Frei diese Woche 🎉</div>`) : '<p>Tipp oben auf deinen Namen.</p>'}
      </a>`;
    const t = (k) => w.tasks.find((x) => x.key === k);
    html += `<a class="card" href="#plan"><h3>Putzplan</h3>
      <p>Wochendienst: <strong>${esc(t('woche')?.person || '–')}</strong></p>
      <p>Bad vorne: ${esc(t('bad-vorne')?.person || '–')}</p><p>Bad hinten: ${esc(t('bad-hinten')?.person || '–')}</p>
      <p class="muted">${w.cleaner ? `🧹 Putzkraft Mi ${ddmm(w.cleanerDay)}` : w.ausfall ? '⚠️ Putzkraft fällt aus' : 'Ohne Putzkraft'}</p></a>`;
  }
  const sh = state.shop;
  html += `<a class="card" href="#einkauf"><h3>Einkauf</h3>${sh
    ? (sh.items.length ? `<div class="big">${sh.items.length}</div><p>${sh.items.slice(0, 3).map((i) => esc(i.name)).join(', ')}${sh.items.length > 3 ? ' …' : ''}</p>` : '<p>Alles da 🎉</p>')
    : '<p class="muted">…</p>'}</a>`;
  const m = state.money;
  if (m) {
    const eur = m.byCurrency.EUR;
    const v = me ? eur.balances[me] || 0 : null;
    const owe = me ? eur.transfers.filter((x) => x.from === me) : [];
    html += `<a class="card" href="#kasse"><h3>Kasse</h3>${me
      ? `<div class="big" style="color:${v > 0 ? 'var(--done)' : v < 0 ? 'var(--warn)' : 'inherit'}">${v > 0 ? '+' : ''}${money(v)}</div>
        <p>${owe.length ? owe.map((x) => `an ${esc(x.to)}: ${money(x.amount)}`).join('<br>') : v > 0 ? 'Du bekommst Geld zurück' : 'Du bist quitt'}</p>`
      : ''}</a>`;
  } else {
    html += '<a class="card" href="#kasse"><h3>Kasse</h3><p class="muted">…</p></a>';
  }
  const today = state.today;
  const now = absentNow(today);
  const next = (state.absences || []).filter((a) => a.from > today).slice(0, 3);
  html += `<a class="card" href="#kalender"><h3>Wer ist weg?</h3>
    ${now.length ? `<p>${now.map((a) => `🏖️ <strong>${esc(a.person)}</strong> bis ${ddmm(a.to)}`).join('<br>')}</p>` : '<p>Alle da</p>'}
    ${next.length ? `<p class="muted">${next.map((a) => `${esc(a.person)} ab ${ddmm(a.from)}`).join('<br>')}</p>` : ''}</a>`;
  html += '<a class="card wide" href="#regeln"><h3>Hausregeln</h3><p>Mission Haussegen 📜 Alles zum WG-Seelenfrieden</p></a>';
  html += '</div>';
  el.innerHTML = html;

  $('#members-list').innerHTML = (state.members || [])
    .filter((x) => !x.until || x.until > state.current)
    .map((x) => {
      const away = now.some((a) => a.person === x.name);
      const future = x.since > state.current;
      const leaving = x.until;
      return `<div class="member"><span><strong>${esc(x.name)}</strong> <small>Zimmer ${x.side}</small></span>
        <span>${away ? '<span class="tag away">im Urlaub</span> ' : ''}${future ? `<span class="tag">ab ${ddmm(x.since)}</span>` : ''}${leaving ? `<span class="tag away">zieht aus</span>` : ''}</span></div>`;
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
$('#join-cancel').onclick = () => {
  state.joining = false;
  if (location.hash === '#beitreten') history.replaceState(null, '', '#start');
  renderMe();
  showTab();
};
$('#join').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.joinSide) { toast('Bitte vorne oder hinten wählen'); return; }
  try {
    const r = await api('members/join', { name: $('#join-name').value, side: state.joinSide });
    state.me = r.name;
    store.set('me', r.name);
    state.joining = false;
    history.replaceState(null, '', '#start');
    state.weeks.clear();
    await load();
    showTab();
    toast(`Willkommen, ${r.name}! Ab ${ddmm(r.since)} bist du im Putzplan.`);
  } catch (err) { toast(err.message); }
});
$('#invite').onclick = async () => {
  const url = `${location.origin}/#beitreten`;
  const text = 'Komm in unsere WG-Zentrale! Leg dir dort dein Profil an:';
  try {
    if (navigator.share) { await navigator.share({ title: 'WG-Zentrale', text, url }); return; }
  } catch { return; }
  try { await navigator.clipboard.writeText(`${text} ${url}`); toast('Einladungslink kopiert, schick ihn einfach weiter'); } catch { prompt('Diesen Link verschicken:', url); }
};
$('#leave-open').onclick = async () => {
  if (!state.money) { try { state.money = await api('money'); } catch { /* egal */ } }
  const eur = state.money?.byCurrency?.EUR;
  const v = eur ? eur.balances[state.me] || 0 : 0;
  const owe = eur ? eur.transfers.filter((x) => x.from === state.me) : [];
  $('#leave-balance').innerHTML = v < 0
    ? `<div class="banner"><p>⚠️ Laut WG-Kasse schuldest du noch <strong>${money(-v)}</strong>${owe.length ? ` (${owe.map((x) => `${esc(x.to)}: ${money(x.amount)}`).join(', ')})` : ''}. Bitte vorher ausgleichen.</p></div>`
    : v > 0 ? `<div class="banner"><p>💶 Du bekommst laut WG-Kasse noch <strong>${money(v)}</strong> zurück. Sprecht das am besten vorher ab.</p></div>`
      : '<div class="banner"><p>✅ Deine WG-Kasse ist ausgeglichen.</p></div>';
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
      $('#bye-title').textContent = `Schade, dass du gehst, ${name}!`;
      $('#bye-text').textContent = 'Wir werden dich wirklich vermissen: die Gespräche in der Küche, das gemeinsame Kochen und sogar deine Putzwochen. Danke für die schöne Zeit mit dir! Pass auf dich auf, komm uns besuchen, und für einen Kaffee oder eine Party bist du hier immer willkommen. 💛';
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

// ---------------- Kalender ----------------
state.calMonth = null;
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
function renderCal() {
  if (!state.today || !$('#cal-grid')) return;
  if (!state.calMonth) state.calMonth = state.today.slice(0, 7);
  const [y, mo] = state.calMonth.split('-').map(Number);
  $('#cal-title').textContent = `${MONTHS[mo - 1]} ${y}`;
  const first = `${state.calMonth}-01`;
  const dow = (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7;
  const start = addDays(first, -dow);
  const abs = state.absences || [];
  let html = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map((d) => `<div class="dow">${d}</div>`).join('');
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    if (i >= 35 && d.slice(0, 7) !== state.calMonth) break;
    const wk = state.weeks.get(addDays(d, -((new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7)));
    const cleaner = wk && wk.cleaner && wk.cleanerDay === d;
    const away = abs.filter((a) => a.from <= d && a.to >= d);
    html += `<div class="day${d.slice(0, 7) !== state.calMonth ? ' out' : ''}${d === state.today ? ' today' : ''}">
      <span class="n">${+d.slice(8)}${cleaner ? '<span title="Putzkraft">🧹</span>' : ''}</span>
      ${away.map((a) => `<span class="pill" title="${esc(a.person)}">${esc(a.person)}</span>`).join('')}</div>`;
  }
  $('#cal-grid').innerHTML = html;

  const sel = $('#abs-person');
  const prev = (state.absTouched && sel.value) || state.me;
  sel.innerHTML = state.people.map((p) => `<option${p === prev ? ' selected' : ''}>${esc(p)}</option>`).join('');
  const upcoming = abs.filter((a) => a.to >= state.today);
  $('#abs-list').innerHTML = upcoming.length
    ? upcoming.map((a) => `<div class="abs"><div><strong>${esc(a.person)}</strong> ${fmtDay(a.from)} – ${fmtDay(a.to)}
        ${a.note ? `<small>${esc(a.note)}</small>` : ''}</div><button class="link small" data-abs-del="${esc(a.id)}">löschen</button></div>`).join('')
    : '<p class="empty">Gerade ist niemand als abwesend eingetragen.</p>';
}
async function ensureCalWeeks() {
  const [y, mo] = state.calMonth.split('-').map(Number);
  const first = `${state.calMonth}-01`;
  const from = addDays(first, -((new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7));
  if (state.weeks.has(from) && state.weeks.has(addDays(from, 35))) return;
  try {
    const data = await api(`weeks?from=${from}&count=6`);
    for (const w of data.weeks) state.weeks.set(w.monday, w);
  } catch { /* Anzeige ohne Putzkraft-Tage */ }
  void y; void mo;
}
async function moveCal(n) {
  const [y, mo] = state.calMonth.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + n, 1));
  state.calMonth = d.toISOString().slice(0, 7);
  renderCal();
  await ensureCalWeeks();
  renderCal();
}
$('#cal-prev').onclick = () => moveCal(-1);
$('#cal-next').onclick = () => moveCal(1);
$('#abs-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const from = $('#abs-from').value;
  const to = $('#abs-to').value;
  if (to < from) { toast('„Bis“ liegt vor „Von“'); return; }
  try {
    await api('absences/add', { person: $('#abs-person').value, from, to, note: $('#abs-note').value });
    $('#abs-form').reset();
    state.weeks.clear();
    await load();
    toast('Eingetragen, der Putzplan wurde angepasst');
  } catch (err) { toast(err.message); }
});
$('#abs-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-abs-del]');
  if (!b || !confirm('Abwesenheit löschen? Der Putzplan wird dann wieder zurückgerechnet.')) return;
  try {
    await api('absences/delete', { id: b.dataset.absDel });
    state.weeks.clear();
    await load();
  } catch (err) { toast(err.message); }
});
$('#abs-person').addEventListener('change', () => { state.absTouched = true; });
$('#abs-from').addEventListener('change', () => { if (!$('#abs-to').value || $('#abs-to').value < $('#abs-from').value) $('#abs-to').value = $('#abs-from').value; });

// ---------------- Start ----------------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
showTab();
if (currentTab() !== 'shop') api('shop').then((d) => { state.shop = d; renderShop(); }).catch(() => {});
load().catch((e) => {
  $('#week').innerHTML = `<div class="card"><p>Der Plan konnte nicht geladen werden (${esc(e.message)}). Bitte später nochmal versuchen.</p></div>`;
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  state.weeks.clear();
  load().catch(() => {});
  if (currentTab() === 'shop') loadShop();
  if (currentTab() === 'money') loadMoney();
});
