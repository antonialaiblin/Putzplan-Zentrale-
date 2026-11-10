import { DurableObject } from 'cloudflare:workers';
import { computeWeek, simulate, mondayOf, addDays, berlinNow, INITIAL_MEMBERS, CYCLE_START } from './plan.js';
import { weeklyMessages, fridayMessages, ausfallMessages, cleanerAskMessage, cleanerVisitMessages, meetingPrepMessages, dayLabel, ddmm } from './messages.js';
import { tr } from '../public/i18n.js';
import { holidayOn } from '../public/holidays.js';
import { buildIcs, ICS_KINDS } from './ics.js';
import { generateVapidKeys, vapidPublicRaw, sendPush } from './webpush.js';
import { balancesByCurrency, peopleIn, parseSplitwise, computeParts, parseAmount, parseEuro, CURRENCIES, SHOP_CATEGORIES } from './money.js';

// Wann werden Erinnerungen verschickt? (Berliner Zeit, Mo=0 … So=6)
export const SCHEDULE = {
  weekly: { dow: 6, hour: 19 }, // Sonntag 19 Uhr: Plan für die kommende Woche
  friday: { dow: 4, hour: 18 }, // Freitag 18 Uhr: Erinnerung an offene Aufgaben
  cleanerAsk: { dow: 0, hour: 9 },
  birthday: { hour: 9 }, // Am Geburtstag 9 Uhr an alle
  meetingPrep: { hour: 18 }, // Am Vortag eines WG-Meetings 18 Uhr: Themen vorbereiten // Montag 9 Uhr: Zuständige:r gefragt, ob/wann die Putzkraft kommt
};

const fmtD = (d, lang = 'de') => dayLabel(d, lang);
const GUEST_MODE = true; // Gastansicht an/aus (Antonia sagt Bescheid, wann sie wieder raus soll)
const FEEDBACK_START = '2026-11-24'; // App-Umfrage: zwei Wochen nach dem Start, eine Woche lang
/** Nächster Termin einer wiederkehrenden Ausgabe */
const REPEATS = { week: [0, 7], '2week': [0, 14], month: [1, 0], '2month': [2, 0], quarter: [3, 0], year: [12, 0] };
function nextDate(d, every) {
  const [months, days] = REPEATS[every] || REPEATS.month;
  if (days) return addDays(d, days);
  const [y, m, day] = d.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return t.toISOString().slice(0, 10);
}
const REACTIONS = ['🙏', '❤️', '🎉', '👍', '😂', '🔥'];
const pick = (lang) => (de, en, sv) => (lang === 'en' ? en : lang === 'sv' ? sv ?? en : de);

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

/** Passwort-Hash (PBKDF2, mit Salz) */
async function pwHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 100000 }, key, 256);
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}
const newToken = () => [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');
async function sha(s) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(h)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class Putzplan extends DurableObject {
  // ---------- Daten ----------
  async overrides(monday) {
    return (await this.ctx.storage.get(`ov:${monday}`)) || {};
  }
  // ---------- Mitglieder & Abwesenheiten ----------
  async members() {
    return (await this.ctx.storage.get('members')) || INITIAL_MEMBERS;
  }
  /** Sprache je Person: { Name: 'de' | 'en' } */
  async langs() {
    return Object.fromEntries((await this.members()).map((m) => [m.name, ['en', 'sv'].includes(m.lang) ? m.lang : 'de']));
  }
  /** Kalender-Einträge: {id, type: urlaub|meeting|sonstiges, title, from, to, time, note, participants:[{name, ok}], by} */
  async events() {
    let ev = await this.ctx.storage.get('events');
    if (!ev) {
      // Alte Urlaubs-Einträge übernehmen
      ev = ((await this.ctx.storage.get('absences')) || []).map((a) => ({
        id: a.id, type: 'urlaub', title: a.note || '', from: a.from, to: a.to, time: '', note: '', by: a.person,
        participants: [{ name: a.person, ok: true }],
      }));
      await this.ctx.storage.put('events', ev);
    }
    return ev;
  }
  /** Für den Putzplan: bestätigte Urlaube pro Person */
  async absences() {
    return (await this.events())
      .filter((e) => e.type === 'urlaub')
      .flatMap((e) => e.participants.filter((p) => p.ok).map((p) => ({ id: e.id, person: p.name, from: e.from, to: e.to, note: e.title })));
  }
  /** Wer stimmt die Termine mit der Putzkraft ab? (Standard: Mo) */
  async cleanerContact() {
    const c = await this.ctx.storage.get('cleanerContact');
    const names = await this.names();
    if (c === undefined) return names.includes('Mo') ? 'Mo' : null;
    return names.includes(c) ? c : null;
  }
  /** Umfragen: {id, question, options:[{id,text}], multi, by, votes:{Name:[optId]}, status, at, doneNotified} */
  /** Tausch-Anfragen: {id, by, to, monday, task, back: {monday, task}|null, status: open|accepted|declined, at} */
  async swapRequests() {
    return (await this.ctx.storage.get('swapRequests')) || [];
  }
  async surveys() {
    return (await this.ctx.storage.get('surveys')) || [];
  }
  async polls() {
    return (await this.ctx.storage.get('polls')) || [];
  }
  /** Alle, die gerade wohnen oder schon zugesagt haben (noch nicht ausgezogen). */
  async names() {
    const now = mondayOf(berlinNow().day);
    return (await this.members()).filter((m) => !m.until || m.until > now).map((m) => m.name);
  }
  async planCtx() {
    return {
      members: await this.members(), absences: await this.absences(),
      ausfaelle: (await this.ctx.storage.get('ausfaelle')) || [], renames: (await this.ctx.storage.get('renames')) || [],
    };
  }

  /** Profilfelder prüfen: Geburtstag, Geschlecht, Foto. Gibt {fields} oder {error} zurück. */
  checkProfile(body, { requireAll = true } = {}) {
    const f = {};
    if (body.birthday !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(body.birthday || '') || body.birthday < '1900-01-01' || body.birthday > berlinNow().day) return { error: 'Bitte deinen Geburtstag angeben.' };
      f.birthday = body.birthday;
    } else if (requireAll) return { error: 'Bitte deinen Geburtstag angeben.' };
    if (body.gender !== undefined) {
      if (!['w', 'm', 'd'].includes(body.gender)) return { error: 'Bitte dein Geschlecht angeben.' };
      f.gender = body.gender;
    } else if (requireAll) return { error: 'Bitte dein Geschlecht angeben.' };
    if (body.photo !== undefined && body.photo !== null) {
      if (typeof body.photo !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(body.photo) || body.photo.length > 300000) return { error: 'Das Foto ist zu groß oder kein Bild.' };
    }
    return { fields: f };
  }
  async savePhoto(name, photo) {
    if (photo === undefined) return undefined;
    if (photo === null) { await this.ctx.storage.delete(`photo:${name}`); return null; }
    await this.ctx.storage.put(`photo:${name}`, photo);
    return Date.now();
  }

  /** Mitglied überall umbenennen (Plan, Kasse, Kalender, Einkauf, Erinnerungen). */
  async renameEverywhere(from, to) {
    const st = this.ctx.storage;
    const sw = (n) => (n === from ? to : n);
    const keys = (o) => (o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [sw(k), v])) : o);
    await st.put('members', (await this.members()).map((m) => (m.name === from ? { ...m, name: to } : m)));
    await st.put('renames', [...((await st.get('renames')) || []), { from, to }]);
    for (const [k, ov] of await st.list({ prefix: 'ov:' })) {
      if (ov.swaps) { ov.swaps = Object.fromEntries(Object.entries(ov.swaps).map(([t, p]) => [t, sw(p)])); await st.put(k, ov); }
    }
    for (const [k, c] of await st.list({ prefix: 'check:' })) {
      let key = k;
      const parts = k.split(':'); // check:monday:task:item (item kann ein Name sein, z.B. Kühlschrank)
      if (parts[3] === from) { parts[3] = to; key = parts.join(':'); await st.delete(k); }
      await st.put(key, { ...c, by: sw(c.by) });
    }
    for (const [k, e] of await st.list({ prefix: 'exp:' })) {
      await st.put(k, { ...e, paidBy: sw(e.paidBy), by: sw(e.by), split: e.split && e.split.map(sw), parts: keys(e.parts), net: keys(e.net), values: keys(e.values) });
    }
    for (const [k, i] of await st.list({ prefix: 'shop:' })) if (i.by === from) await st.put(k, { ...i, by: to });
    for (const [k, s] of await st.list({ prefix: 'sub:' })) if (s.person === from) await st.put(k, { ...s, person: to });
    for (const [k, a] of await st.list({ prefix: 'acct:' })) if (a.person === from) await st.put(k, { ...a, person: to });
    if ((await st.get('admin')) === from) await st.put('admin', to);
    const evs = (await this.events()).map((e) => ({
      ...e, by: sw(e.by), participants: e.participants.map((p) => ({ ...p, name: sw(p.name) })),
      topics: e.topics && e.topics.map((t) => ({ ...t, by: sw(t.by) })), minutes: e.minutes && { ...e.minutes, by: sw(e.minutes.by) },
    }));
    await st.put('events', evs);
    await st.put('polls', (await this.polls()).map((p) => ({ ...p, by: sw(p.by), votes: keys(p.votes) })));
    if ((await st.get('cleanerContact')) === from) await st.put('cleanerContact', to);
    const photo = await st.get(`photo:${from}`);
    if (photo) { await st.put(`photo:${to}`, photo); await st.delete(`photo:${from}`); }
  }
  async weeks(mondays) {
    const ctx = await this.planCtx();
    const last = mondays.reduce((a, b) => (a > b ? a : b), CYCLE_START);
    ctx.plan = simulate(ctx, last);
    const out = [];
    for (const m of mondays) out.push(await this.week(m, ctx));
    return out;
  }
  async week(monday, ctx) {
    ctx ||= await this.planCtx();
    const w = computeWeek(monday, await this.overrides(monday), ctx);
    const checks = {};
    for (const [k, v] of await this.ctx.storage.list({ prefix: `check:${monday}:` })) {
      checks[k.slice(`check:${monday}:`.length)] = v;
    }
    w.checks = checks;
    return w;
  }
  async vapid() {
    let v = await this.ctx.storage.get('vapid');
    if (!v) {
      v = await generateVapidKeys();
      await this.ctx.storage.put('vapid', v);
    }
    return v;
  }
  async subscriptions() {
    return [...(await this.ctx.storage.list({ prefix: 'sub:' })).entries()];
  }
  async shop() {
    const items = [...(await this.ctx.storage.list({ prefix: 'shop:' })).values()].sort((a, b) => a.at - b.at);
    return { categories: await this.categories(), items };
  }
  async categories() {
    return (await this.ctx.storage.get('shopcats')) || SHOP_CATEGORIES;
  }
  /** Wiederkehrende Ausgaben fällig? Dann eintragen und nächsten Termin setzen. */
  async runRecurring(today = berlinNow().day) {
    const list = (await this.ctx.storage.get('recurring')) || [];
    let changed = false;
    for (const r of list) {
      let guard = 0;
      while (r.next <= today && guard++ < 60) {
        const id = `${Date.now().toString(36).padStart(10, '0')}${Math.random().toString(36).slice(2, 6)}`;
        await this.ctx.storage.put(`exp:${id}`, {
          id, kind: 'expense', desc: r.desc, amount: r.amount, currency: r.currency, paidBy: r.paidBy, mode: r.mode, parts: r.parts, split: r.split,
          by: r.by, recurring: r.id, date: r.next, at: Date.parse(`${r.next}T10:00:00Z`) || Date.now(),
        });
        r.next = nextDate(r.next, r.every);
        changed = true;
      }
    }
    if (changed) await this.ctx.storage.put('recurring', list);
    return list;
  }
  /** Zähler für Abzeichen (Einkäufe, übernommene Dienste) */
  async bump(person, what) {
    if (!(await this.names()).includes(person)) return;
    const s = (await this.ctx.storage.get('stats')) || {};
    s[person] = s[person] || {};
    s[person][what] = (s[person][what] || 0) + 1;
    await this.ctx.storage.put('stats', s);
  }
  /** WG-Serie und Abzeichen aus dem Putzplan berechnen */
  async gami() {
    const current = mondayOf(berlinNow().day);
    const mondays = [];
    for (let m = CYCLE_START; m <= current && mondays.length < 400; m = addDays(m, 7)) mondays.push(m);
    const weeks = mondays.length ? await this.weeks(mondays) : [];
    const keysOf = (w) => w.tasks.flatMap((t) => t.items.map((it) => ({ k: `${t.key}:${it.id}`, owner: it.person || t.person, task: t })));
    const complete = (w) => { const ks = keysOf(w); return ks.length > 0 && ks.every((x) => w.checks[x.k]); };
    // Serie: abgeschlossene Wochen rückwärts zählen, die laufende Woche zählt mit, sobald sie fertig ist
    let streak = 0;
    for (let i = weeks.length - 2; i >= 0; i--) { if (complete(weeks[i])) streak++; else break; }
    const cur = weeks[weeks.length - 1];
    const curDone = !!cur && complete(cur);
    if (curDone) streak++;
    let best = 0; let run = 0;
    for (const w of weeks) { if (complete(w)) best = Math.max(best, ++run); else if (w.monday !== current) run = 0; }
    // Zahlen pro Person
    const PEOPLE = await this.names();
    const stats = (await this.ctx.storage.get('stats')) || {};
    const monthNow = berlinNow().day.slice(0, 7);
    const bdays = Object.fromEntries((await this.members()).map((m) => [m.name, m.birthday || '']));
    const doersOf = {};
    const bump = (p, k) => { per[p].sp[k] = (per[p].sp[k] || 0) + 1; };
    const per = Object.fromEntries(PEOPLE.map((p) => [p, { tasks: 0, baths: 0, rescue: stats[p]?.rescue || 0, punctual: 0, bought: stats[p]?.bought || 0, fridge: 0, items: 0, itemsMonth: 0, likes: 0, sent: 0, paidCount: 0, days: 0, notes: stats[p]?.notes || 0, swaps: stats[p]?.swaps || 0, sp: {} }]));
    let weekDone = {};
    for (const w of weeks) {
      weekDone = {};
      const deadline = Date.parse(`${addDays(w.monday, 4)}T17:00:00Z`);
      for (const t of w.tasks) {
        if (!t.items.length) continue;
        const all = t.items.every((it) => w.checks[`${t.key}:${it.id}`]);
        const doers = new Set(t.items.map((it) => w.checks[`${t.key}:${it.id}`]?.by).filter((p) => per[p]));
        for (const it of t.items) {
          const c = w.checks[`${t.key}:${it.id}`];
          // Ranking: jede abgehakte Aufgabe zählt
          if (c?.by && per[c.by]) {
            per[c.by].items++;
            if (new Date(c.at).toISOString().slice(0, 7) === monthNow) per[c.by].itemsMonth++;
            // Geheime Abzeichen: besondere Tage und Uhrzeiten (Berliner Zeit)
            const z = berlinNow(new Date(c.at));
            const md = z.day.slice(5);
            if (['12-24', '12-25', '12-26'].includes(md)) bump(c.by, 'xmas');
            if (md === '12-31' || md === '01-01') bump(c.by, 'newyear');
            if (bdays[c.by] && bdays[c.by].slice(5) === md) bump(c.by, 'bday');
            if (z.hour < 5) bump(c.by, 'owl');
            if (z.hour >= 5 && z.hour < 7) bump(c.by, 'early');
            const hol = holidayOn(z.day);
            if (hol && (hol.legal || hol.sunday)) bump(c.by, 'holiday');
            if (md.endsWith('-13') && z.dow === 4) bump(c.by, 'friday13');
            if (z.dow === 6 && z.hour >= 21) bump(c.by, 'lastminute');
            if (md === '10-31') bump(c.by, 'halloween');
            if (md === '02-14') bump(c.by, 'valentine');
            if (z.hour === 0) bump(c.by, 'midnight');
            if (z.dow >= 5) bump(c.by, 'weekend');
            if (md === '12-06') bump(c.by, 'nikolaus');
            if (md === '02-29') bump(c.by, 'leap');
            if (md === '06-21') bump(c.by, 'solstice');
            if (md === '04-01') bump(c.by, 'april');
            if (hol && /^Oster/.test(hol.de || '')) bump(c.by, 'easter');
            // Vollmond (mittlere Mondphase, Bezugs-Neumond 06.01.2000 18:14 UTC)
            const age = ((((c.at - 947182440000) / 864e5) % 29.530588) + 29.530588) % 29.530588;
            if (Math.abs(age - 14.77) < 1) bump(c.by, 'fullmoon');
          }
          if (c?.by && per[c.by] && t.key === 'kuehlschrank' && it.person === c.by) per[c.by].fridge++;
        }
        doersOf[`${w.monday}:${t.key}`] = [...doers];
        if (all && t.key !== 'kuehlschrank') for (const p of doers) (weekDone[p] = weekDone[p] || new Set()).add(t.key);
        // Blitzputz: ganzer Wochendienst schon am Montag erledigt
        if (all && t.key === 'woche' && t.items.every((it) => berlinNow(new Date(w.checks[`${t.key}:${it.id}`].at)).day === w.monday)) for (const p of doers) bump(p, 'blitz');
        if (t.key === 'kuehlschrank') continue;
        for (const p of doers) {
          if (all) per[p].tasks++;
          if (all && t.key.startsWith('bad-')) per[p].baths++;
          if (t.person && t.person !== p) per[p].rescue++;
        }
      }
      // Doppelschicht: zwei ganze Dienste in einer Woche
      for (const [p, ks] of Object.entries(weekDone)) if (ks.size >= 2) bump(p, 'double');
      if (w.monday === current && !curDone) continue;
      for (const p of PEOPLE) {
        const own = keysOf(w).filter((x) => x.owner === p);
        if (own.length && own.every((x) => w.checks[x.k] && w.checks[x.k].at <= deadline)) per[p].punctual++;
      }
    }
    // Publikumsliebling: Reaktionen der anderen auf eigene erledigte Dienste und Zettel
    const reacts = await this.reactions();
    const notes = (await this.ctx.storage.get('board')) || [];
    for (const [target, r] of Object.entries(reacts)) {
      let owners = [];
      if (target.startsWith('task:')) owners = doersOf[target.slice(5)] || [];
      else if (target.startsWith('note:')) { const n = notes.find((x) => x.id === target.slice(5)); if (n?.by) owners = [n.by]; }
      for (const o of owners) if (per[o]) per[o].likes += Object.values(r).flat().filter((x) => x !== o).length;
      for (const who of Object.values(r).flat()) if (per[who]) per[who].sent++;
    }
    // Kasse: Ausgaben ausgelegt
    for (const e of (await this.ctx.storage.list({ prefix: 'exp:' })).values()) if (e.kind !== 'settle' && !e.net && per[e.paidBy]) per[e.paidBy].paidCount++;
    // Treue Seele: Tage in der WG
    for (const m of await this.members()) if (per[m.name] && m.since) per[m.name].days = Math.max(0, Math.round((Date.parse(berlinNow().day) - Date.parse(m.since)) / 864e5));
    // Persönlicher Streak: Wochen in Folge, in denen man alle eigenen Aufgaben erledigt hat.
    // Wochen ohne eigene Aufgabe (frei/weg) unterbrechen nicht. Die laufende Woche zählt, sobald sie fertig ist.
    const streaks = {};
    for (const p of PEOPLE) {
      const ownDone = (w) => { const own = keysOf(w).filter((x) => x.owner === p); return own.length ? own.every((x) => w.checks[x.k]) : null; };
      let s = 0; let b2 = 0; let r = 0;
      for (let i = weeks.length - 2; i >= 0; i--) { const d = ownDone(weeks[i]); if (d === null) continue; if (d) s++; else break; }
      const curOwn = cur ? ownDone(cur) : null;
      if (curOwn) s++;
      for (const w of weeks) { const d = ownDone(w); if (d === null) continue; if (d) b2 = Math.max(b2, ++r); else if (w.monday !== current) r = 0; }
      streaks[p] = { streak: s, best: b2, current: !!curOwn };
      if (per[p]) per[p].streakBest = b2;
    }
    return { streak, best, current: curDone, stats: per, streaks };
  }
  async reactions() {
    return (await this.ctx.storage.get('reactions')) || {};
  }
  /** Kleines Protokoll für den Report (Erinnerungen, Einkäufe) */
  async logAct(type, by, extra = {}) {
    const list = (await this.ctx.storage.get('actlog')) || [];
    list.push({ type, by, at: Date.now(), ...extra });
    await this.ctx.storage.put('actlog', list.slice(-3000));
  }
  /** WG-Report ab einem Datum: wer macht wann was wie oft und wie pünktlich */
  async report(from) {
    const today = berlinNow().day;
    const current = mondayOf(today);
    const first = from && from > CYCLE_START ? mondayOf(from) : CYCLE_START;
    const fromMs = Date.parse(`${from && from > CYCLE_START ? from : CYCLE_START}T00:00:00Z`) - 2 * 3600e3;
    const mondays = [];
    for (let m = first; m <= current && mondays.length < 400; m = addDays(m, 7)) mondays.push(m);
    const weeks = mondays.length ? await this.weeks(mondays) : [];
    const PEOPLE = await this.names();
    const per = Object.fromEntries(PEOPLE.map((p) => [p, {
      items: 0, tasks: 0, what: {}, dows: [0, 0, 0, 0, 0, 0, 0], hours: [], own: 0, onTime: 0, late: 0, leftOpen: 0,
      fridayReminded: 0, reminded: 0, reminds: 0, rescue: 0, swapsGiven: 0, swapsTaken: 0,
      reactSent: 0, reactGot: 0, bought: 0, paid: 0,
    }]));
    let wgItems = 0; let fullWeeks = 0; let pastWeeks = 0;
    const doersOf = {};
    for (const w of weeks) {
      const deadline = Date.parse(`${addDays(w.monday, 4)}T17:00:00Z`);
      const over = Date.now() > deadline;
      const done = Date.now() > Date.parse(`${addDays(w.monday, 7)}T00:00:00Z`);
      let allDone = true; let any = false;
      for (const t of w.tasks) {
        if (t.planned && t.person && t.planned !== t.person) {
          if (per[t.planned]) per[t.planned].swapsGiven++;
          if (per[t.person]) per[t.person].swapsTaken++;
        }
        const doers = new Set();
        let full = t.items.length > 0;
        for (const it of t.items) {
          any = true;
          const k = `${t.key}:${it.id}`;
          const c = w.checks[k];
          const owner = it.person || t.person;
          if (!c) { full = false; allDone = false; }
          if (c?.by && per[c.by]) {
            const P = per[c.by];
            P.items++; wgItems++;
            doers.add(c.by);
            P.what[t.title] = (P.what[t.title] || 0) + 1;
            const z = berlinNow(new Date(c.at));
            P.dows[z.dow]++;
            P.hours.push(z.hour);
            if (owner && owner !== c.by) P.rescue++;
          }
          if (owner && per[owner] && (over || c) && !(c?.by && c.by !== owner)) {
            per[owner].own++;
            if (c && c.at <= deadline) per[owner].onTime++;
            else if (c) per[owner].late++;
            else if (done) per[owner].leftOpen++;
          }
        }
        if (full && t.key !== 'kuehlschrank') for (const p of doers) per[p].tasks++;
        doersOf[`${w.monday}:${t.key}`] = [...doers];
      }
      // Freitags-Erinnerung: eigene Aufgaben waren Freitag 18 Uhr noch offen
      if (over) {
        for (const p of PEOPLE) {
          const own = w.tasks.flatMap((t) => t.items.filter((it) => (it.person || t.person) === p).map((it) => w.checks[`${t.key}:${it.id}`]));
          if (own.some((c) => !c || c.at > deadline)) per[p].fridayReminded++;
        }
      }
      if (done) { pastWeeks++; if (any && allDone) fullWeeks++; }
    }
    // Reaktionen: verschickt und bekommen
    const reacts = await this.reactions();
    const notes = (await this.ctx.storage.get('board')) || [];
    for (const [target, r] of Object.entries(reacts)) {
      let owners = []; let inRange = false;
      if (target.startsWith('task:')) { const key = target.slice(5); inRange = key.slice(0, 10) >= first; owners = doersOf[key] || []; }
      else if (target.startsWith('note:')) { const n = notes.find((x) => x.id === target.slice(5)); inRange = !!n && (n.at || 0) >= fromMs; if (n?.by) owners = [n.by]; }
      if (!inRange) continue;
      for (const who of Object.values(r).flat()) {
        if (per[who]) per[who].reactSent++;
        for (const o of owners) if (per[o] && o !== who) per[o].reactGot++;
      }
    }
    // Erinnern-Knopf und Einkäufe
    for (const a of (await this.ctx.storage.get('actlog')) || []) {
      if (a.at < fromMs) continue;
      if (a.type === 'remind') { if (per[a.by]) per[a.by].reminds++; if (per[a.to]) per[a.to].reminded++; }
      if (a.type === 'bought' && per[a.by]) per[a.by].bought++;
    }
    // Kasse: wer hat wie viel ausgelegt (nur Euro, ohne Rückzahlungen)
    for (const e of (await this.ctx.storage.list({ prefix: 'exp:' })).values()) {
      if (e.kind === 'settle' || (e.currency && e.currency !== 'EUR') || (e.at || 0) < fromMs || e.net) continue;
      if (per[e.paidBy]) per[e.paidBy].paid += Number(e.amount) || 0;
    }
    for (const P of Object.values(per)) {
      P.paid = Math.round(P.paid * 100) / 100;
      P.avgHour = P.hours.length ? Math.round((P.hours.reduce((a, b) => a + b, 0) / P.hours.length) * 10) / 10 : null;
      delete P.hours;
    }
    return { from: first, to: today, weeks: weeks.length, pastWeeks, fullWeeks, wgItems, people: PEOPLE, per };
  }
  async board() {
    const today = berlinNow().day;
    return ((await this.ctx.storage.get('board')) || []).filter((n) => !n.expires || n.expires >= today);
  }
  /** Umfragen für eine Person: bei anonymen Umfragen sieht man nur die eigene Stimme und die Anzahl */
  async surveysFor(me, list) {
    return (list || await this.surveys()).slice(-40).map((s) => {
      const voters = Object.keys(s.votes || {});
      const counts = Object.fromEntries(s.options.map((o) => [o.id, voters.filter((n) => s.votes[n].includes(o.id)).length]));
      if (!s.anon) return { ...s, voters, counts };
      return { ...s, votes: me && s.votes[me] ? { [me]: s.votes[me] } : {}, voters, counts };
    });
  }
  async addExpense(e) {
    // Schlüssel nach Zeit sortierbar
    const id = `${Date.now().toString(36).padStart(10, '0')}${Math.random().toString(36).slice(2, 6)}`;
    await this.ctx.storage.put(`exp:${id}`, { id, kind: 'expense', ...e, at: Date.now() });
  }
  async money() {
    const all = [...(await this.ctx.storage.list({ prefix: 'exp:' })).values()];
    const people = await this.names();
    const former = [...new Set([...(await this.members()).map((m) => m.name), ...peopleIn(all)])].filter((p) => !people.includes(p));
    return {
      people,
      former,
      currencies: CURRENCIES,
      byCurrency: balancesByCurrency(all, [...people, ...former]),
      recurring: (await this.ctx.storage.get('recurring')) || [],
      expenses: all.sort((a, b) => b.at - a.at).slice(0, 100),
      total: all.length,
    };
  }
  async subject() {
    return (await this.ctx.storage.get('origin')) || 'https://github.com/antonialaiblin/Putzplan-Zentrale-';
  }

  // ---------- API ----------
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, '');
    if (!(await this.ctx.storage.get('origin'))) await this.ctx.storage.put('origin', url.origin);
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    const PEOPLE = await this.names();
    const validMonday = (m) => typeof m === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(m) && mondayOf(m) === m;
    const isDay = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
    const isTime = (t) => typeof t === 'string' && /^\d{2}:\d{2}$/.test(t);
    const rid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

    // ---------- Accounts: registrieren, Person wählen, anmelden ----------
    const token = request.headers.get('x-session') || '';
    const sess = /^[0-9a-f]{48}$/.test(token) ? await this.ctx.storage.get(`sess:${token}`) : null;
    const accounts = async () => [...(await this.ctx.storage.list({ prefix: 'acct:' })).values()];
    const acctKey = (u) => `acct:${u.toLowerCase()}`;
    // Gastansicht: eigene Kopie der Daten, man ist automatisch die Admin-Person, aber ohne Admin-Rechte
    const sandbox = await this.ctx.storage.get('guestSandbox');
    let acct = sandbox ? { username: 'Gast', person: sandbox.person } : sess?.user ? await this.ctx.storage.get(acctKey(sess.user)) : null;
    let me = acct?.person && PEOPLE.includes(acct.person) ? acct.person : null;
    const admin = (await this.ctx.storage.get('admin')) || 'Toni';
    const isAdmin = !sandbox && !!me && me === admin;
    if (sandbox && path.startsWith('/auth/') && path !== '/auth/people') return json({ error: 'In der Gastansicht geht das nicht.' }, 403);
    // Alle (außer der Person selbst) bekommen eine Push, wenn sich in der Kasse etwas tut
    const notifyMoney = async (action, e, by) => {
      const fmt = (l) => new Intl.NumberFormat(l === 'en' ? 'en-GB' : l === 'sv' ? 'sv-SE' : 'de-DE', { style: 'currency', currency: e.currency || 'EUR' }).format(e.amount / 100);
      const settle = e.kind === 'settle';
      const to = Object.keys(e.parts || {})[0];
      for (const p of PEOPLE) {
        if (p === by) continue;
        await this.pushCat('money', p, (l) => {
          const L = pick(l);
          const what = settle ? L(`${e.paidBy} → ${to}: ${fmt(l)} zurückgezahlt`, `${e.paidBy} → ${to}: ${fmt(l)} paid back`, `${e.paidBy} → ${to}: ${fmt(l)} återbetalt`)
            : L(`${tr(e.desc, 'de')}: ${fmt(l)}, bezahlt von ${e.paidBy}`, `${tr(e.desc, 'en')}: ${fmt(l)}, paid by ${e.paidBy}`, `${tr(e.desc, 'sv')}: ${fmt(l)}, betalt av ${e.paidBy}`);
          const who = by || L('Jemand', 'Someone', 'Någon');
          const title = action === 'add' ? (settle ? L(`💸 ${who} hat eine Rückzahlung eingetragen`, `💸 ${who} added a repayment`, `💸 ${who} lade till en återbetalning`) : L(`💶 ${who} hat eine Ausgabe eingetragen`, `💶 ${who} added an expense`, `💶 ${who} lade till en utgift`))
            : action === 'edit' ? L(`✏️ ${who} hat eine Ausgabe geändert`, `✏️ ${who} changed an expense`, `✏️ ${who} ändrade en utgift`)
            : L(`🗑️ ${who} hat einen Eintrag gelöscht`, `🗑️ ${who} deleted an entry`, `🗑️ ${who} tog bort en post`);
          return { title, body: what, url: '/#kasse' };
        });
      }
    };
    const startSession = async (user) => {
      const t = newToken();
      await this.ctx.storage.put(`sess:${t}`, { user, at: Date.now() });
      return t;
    };
    const hashPw = async (password) => { const salt = newToken(); return { salt, hash: await pwHash(password, salt) }; };
    const pwOk = (p) => typeof p === 'string' && p.length >= 4 && p.length <= 100;
    const dropSessions = async (user, except) => {
      for (const [k, s] of await this.ctx.storage.list({ prefix: 'sess:' })) if (s.user?.toLowerCase() === user.toLowerCase() && k !== `sess:${except}`) await this.ctx.storage.delete(k);
    };
    const claimed = async () => new Set((await accounts()).flatMap((a) => [a.person, a.pending?.type === 'claim' ? a.pending.person : null]).filter(Boolean));
    const notifyAdmin = async (a, what) => {
      await this.pushToPerson(admin, (l) => ({ title: pick(l)('🚪 Neue Beitritts-Anfrage', '🚪 New join request', '🚪 Ny förfrågan om att gå med'), body: pick(l)(`„${a.username}“ möchte als ${what} in die Zentrale. Bitte in den Einstellungen unter „Accounts verwalten“ zulassen oder ablehnen.`, `"${a.username}" wants to join the Zentrale as ${what}. Please approve or decline in Settings under "Manage accounts".`, `"${a.username}" vill gå med i Zentrale som ${what}. Godkänn eller avböj under Inställningar › "Hantera konton".`), url: '/#start' }));
    };
    /** Neue Person anlegen (nach Freigabe durch die Admin) */
    const doJoin = async (a, pend) => {
      const { name, side, lang, fields } = pend;
      const members = await this.members();
      if (members.some((m) => m.name.toLowerCase() === name.toLowerCase() && (!m.until || m.until > mondayOf(berlinNow().day)))) return `${name} gibt es schon.`;
      // Ab nächstem Montag im Putzplan, die laufende Woche bleibt, wie sie ist
      const since = addDays(mondayOf(berlinNow().day), 7);
      const rest = members.filter((m) => !(m.name.toLowerCase() === name.toLowerCase()));
      const photo = await this.savePhoto(name, pend.photo || undefined);
      await this.ctx.storage.put('members', [...rest, { name, side, since, until: null, lang, ...fields, ...(photo ? { photo } : {}) }]);
      await this.ctx.storage.put(acctKey(a.username), { ...a, person: name, pending: null });
      const g = fields.gender;
      for (const p of PEOPLE) {
        if (p === name) continue;
        await this.pushCat('people', p, (l) => (l === 'en'
          ? { title: '🎉 New flatmate', body: `${name} has joined the flat (${side === 'vorne' ? 'front' : 'back'} room) and is on the cleaning rota from ${fmtD(since, 'en')}. Say hi!`, url: '/#start' }
          : l === 'sv' ? { title: '🎉 Ny i kollektivet', body: `${name} har flyttat in (rum ${side === 'vorne' ? 'fram' : 'bak'}) och är med i städschemat från ${fmtD(since, 'sv')}. Säg hej!`, url: '/#start' }
          : { title: `🎉 ${g === 'w' ? 'Neue Mitbewohnerin' : g === 'm' ? 'Neuer Mitbewohner' : 'Neu in der WG'}`, body: `${name} ist neu in der WG (Zimmer ${side}) und ab ${fmtD(since)} im Putzplan. Sag hallo!`, url: '/#start' }));
      }
      return null;
    };
    if (path === '/auth/people' && request.method === 'GET') {
      const taken = await claimed();
      const members = (await this.members()).filter((m) => PEOPLE.includes(m.name));
      return json({
        people: PEOPLE, admin, guestMode: GUEST_MODE, guest: !!sandbox,
        members: members.map((m) => ({ name: m.name, photo: m.photo, gender: m.gender, lang: m.lang, claimed: taken.has(m.name) })),
        account: acct ? { username: acct.username, person: me, pending: acct.pending ? { type: acct.pending.type, person: acct.pending.person || acct.pending.name } : null } : null,
        pendingCount: isAdmin ? (await accounts()).filter((a) => a.pending || a.forgot).length : 0,
      });
    }
    if (path === '/auth/register' && request.method === 'POST') {
      const username = typeof body.username === 'string' ? body.username.trim().replace(/\s+/g, ' ').slice(0, 30) : '';
      if (username.length < 2) return json({ error: 'Bitte einen Benutzernamen mit mindestens 2 Zeichen angeben.' }, 400);
      if (!pwOk(body.password)) return json({ error: 'Das Passwort braucht mindestens 4 Zeichen.' }, 400);
      const all = await accounts();
      const lower = username.toLowerCase();
      // Benutzername darf weder vergeben sein noch wie eine andere Person heißen
      if (all.some((a) => a.username.toLowerCase() === lower || a.person?.toLowerCase() === lower)) return json({ error: 'Diesen Namen gibt es schon. Bitte einen anderen wählen.' }, 400);
      const hint = typeof body.hint === 'string' ? body.hint.trim().slice(0, 100) : '';
      await this.ctx.storage.put(acctKey(username), { username, ...(await hashPw(body.password)), person: null, hint: hint || null, at: Date.now() });
      return json({ token: await startSession(username), username });
    }
    if (path === '/auth/login' && request.method === 'POST') {
      const name = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
      let a = (await accounts()).find((x) => x.username.toLowerCase() === name) || (await accounts()).find((x) => x.person?.toLowerCase() === name);
      // Passwort aus der ersten Version (eins pro Person) übernehmen
      const legacyPerson = !a && PEOPLE.find((p) => p.toLowerCase() === name);
      const legacy = legacyPerson ? await this.ctx.storage.get(`auth:${legacyPerson}`) : null;
      if (legacy && !(await claimed()).has(legacyPerson) && typeof body.password === 'string' && (await pwHash(body.password, legacy.salt)) === legacy.hash) {
        a = { username: legacyPerson, salt: legacy.salt, hash: legacy.hash, person: legacyPerson, at: Date.now() };
        await this.ctx.storage.put(acctKey(legacyPerson), a);
        await this.ctx.storage.delete(`auth:${legacyPerson}`);
      }
      const failKey = `authfail:${name}`;
      const fail = (await this.ctx.storage.get(failKey)) || { n: 0, at: 0 };
      if (fail.n >= 5 && Date.now() - fail.at < 10 * 60e3) return json({ error: 'Zu viele falsche Versuche. Bitte in 10 Minuten nochmal.' }, 429);
      if (!a || typeof body.password !== 'string' || (await pwHash(body.password, a.salt)) !== a.hash) {
        await this.ctx.storage.put(failKey, { n: (Date.now() - fail.at < 10 * 60e3 ? fail.n : 0) + 1, at: Date.now() });
        return json({ error: 'Name oder Passwort stimmt nicht.' }, 401);
      }
      await this.ctx.storage.delete(failKey);
      return json({ token: await startSession(a.username), username: a.username, person: a.person && PEOPLE.includes(a.person) ? a.person : null });
    }
    if (path === '/auth/forgot' && request.method === 'POST') {
      // Passwort vergessen: die Admin bekommt Bescheid und setzt ein neues
      const name = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
      const a = (await accounts()).find((x) => x.username.toLowerCase() === name) || (await accounts()).find((x) => x.person?.toLowerCase() === name);
      if (!body.notify) return json({ hint: a?.hint || null, admin });
      if (a && !(a.forgot && Date.now() - a.forgot < 3600e3)) {
        await this.ctx.storage.put(acctKey(a.username), { ...a, forgot: Date.now() });
        await this.pushToPerson(admin, (l) => ({ title: pick(l)('🔑 Passwort vergessen', '🔑 Forgotten password', '🔑 Glömt lösenord'), body: pick(l)(`${a.person || a.username} hat das Passwort vergessen. Setz unter „Accounts verwalten“ ein neues und sag es der Person.`, `${a.person || a.username} forgot their password. Set a new one under "Manage accounts" and tell them.`, `${a.person || a.username} har glömt sitt lösenord. Sätt ett nytt under "Hantera konton" och berätta det.`), url: '/#start' }));
      }
      // Immer gleich antworten, damit man nicht herausfinden kann, welche Namen es gibt
      return json({ ok: true, admin });
    }
    if (!acct && path.startsWith('/auth/')) return json({ error: 'Bitte melde dich an.', auth: true }, 401);
    if (path === '/auth/claim' && request.method === 'POST') {
      if (me) return json({ error: 'Dein Account ist schon mit einer Person verbunden.' }, 400);
      if (!PEOPLE.includes(body.person)) return json({ error: 'Mitglied nicht gefunden.' }, 404);
      if ((await claimed()).has(body.person)) return json({ error: `${body.person} ist schon mit einem anderen Account verbunden.` }, 400);
      // Die Admin-Person darf sich beim allerersten Mal selbst verbinden, alle anderen brauchen eine Freigabe
      const adminLinked = (await accounts()).some((a) => a.person === admin);
      if (body.person === admin && !adminLinked) {
        await this.ctx.storage.put(acctKey(acct.username), { ...acct, person: body.person, pending: null });
        return json({ ok: true, person: body.person });
      }
      await this.ctx.storage.put(acctKey(acct.username), { ...acct, pending: { type: 'claim', person: body.person, at: Date.now() } });
      await notifyAdmin(acct, body.person);
      return json({ ok: true, pending: true });
    }
    if (path === '/auth/cancel' && request.method === 'POST') {
      await this.ctx.storage.put(acctKey(acct.username), { ...acct, pending: null });
      return json({ ok: true });
    }
    if (path === '/auth/hint' && request.method === 'POST') {
      const hint = typeof body.hint === 'string' ? body.hint.trim().slice(0, 100) : '';
      await this.ctx.storage.put(acctKey(acct.username), { ...acct, hint: hint || null });
      return json({ ok: true });
    }
    if (path === '/auth/logout' && request.method === 'POST') {
      if (sess) await this.ctx.storage.delete(`sess:${token}`);
      return json({ ok: true });
    }
    if (path === '/auth/password' && request.method === 'POST') {
      if (!pwOk(body.password)) return json({ error: 'Das Passwort braucht mindestens 4 Zeichen.' }, 400);
      if (typeof body.old !== 'string' || (await pwHash(body.old, acct.salt)) !== acct.hash) return json({ error: 'Das alte Passwort stimmt nicht.' }, 400);
      await this.ctx.storage.put(acctKey(acct.username), { ...acct, ...(await hashPw(body.password)) });
      await dropSessions(acct.username, token);
      return json({ ok: true });
    }
    // Nur die Verwalterin: Accounts ansehen, Passwort neu setzen, Account löschen
    if (path.startsWith('/auth/admin')) {
      if (!isAdmin) return json({ error: 'Das darf nur die Verwalterin der App.' }, 403);
      const list = async () => json({ admin, accounts: (await accounts()).map((a) => ({ username: a.username, person: a.person || null, at: a.at, forgot: !!a.forgot, pending: a.pending ? { type: a.pending.type, person: a.pending.person || a.pending.name, side: a.pending.side || null } : null })).sort((x, y) => (x.person || '~').localeCompare(y.person || '~')) });
      if (path === '/auth/admin/list') return list();
      if (path === '/auth/admin/backup') {
        const data = await this.dumpAll();
        return new Response(JSON.stringify({ app: 'zentrale', at: new Date().toISOString(), data }), { headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="zentrale-backup-${berlinNow().day}.json"` } });
      }
      if (path === '/auth/admin/backups') return json({ snapshots: await this.backupStub().snapList() });
      if (path === '/auth/admin/backup-now') { const day = berlinNow().day; return json({ snapshots: await this.backupStub().snapSave(day, await this.dumpAll()) }); }
      if (path === '/auth/admin/restore') {
        let data = null;
        if (typeof body.snapshot === 'string') data = await this.backupStub().snapGet(body.snapshot);
        else if (body.backup && body.backup.app === 'zentrale' && body.backup.data && typeof body.backup.data === 'object') data = body.backup.data;
        if (!data || !data.members) return json({ error: 'Das ist keine gültige Zentrale-Sicherung.' }, 400);
        // Vorher den aktuellen Stand sichern, damit man zurück kann
        await this.backupStub().snapSave(`${berlinNow().day}-vor-wiederherstellen`, await this.dumpAll());
        const n = await this.restoreAll(data);
        return json({ ok: true, restored: n });
      }
      if (path === '/auth/admin/feedback') {
        const f = await this.feedback();
        const names = await this.names();
        const answers = Object.values(f.answers).sort(() => Math.random() - 0.5);
        return json({ start: f.start, end: f.end, total: names.length, count: Object.keys(f.answers).length, answers: answers.map((a) => ({ stars: a.stars, like: a.like, ideas: a.ideas, uses: a.uses || [] })) });
      }
      if (path === '/auth/admin/transfer') {
        const to = body.person;
        if (!PEOPLE.includes(to) || to === me || !(await accounts()).some((a) => a.person === to)) return json({ error: 'Diese Person hat noch keinen Account.' }, 400);
        await this.ctx.storage.put('admin', to);
        await this.pushToPerson(to, (l) => ({ title: pick(l)('🔑 Du bist jetzt Admin', '🔑 You are now the admin', '🔑 Du är nu administratör'), body: pick(l)(`${me} hat dich zum Admin der Zentrale ernannt. Du kannst jetzt neue Mitglieder zulassen und Passwörter zurücksetzen.`, `${me} made you the admin of the Zentrale. You can now approve new members and reset passwords.`, `${me} har gjort dig till administratör. Du kan nu godkänna nya medlemmar och återställa lösenord.`), url: '/#start' }));
        return json({ ok: true, admin: to });
      }
      const target = (await accounts()).find((a) => a.username === body.username);
      if (!target) return json({ error: 'Account nicht gefunden.' }, 404);
      if (path === '/auth/admin/password') {
        if (!pwOk(body.password)) return json({ error: 'Das Passwort braucht mindestens 4 Zeichen.' }, 400);
        await this.ctx.storage.put(acctKey(target.username), { ...target, ...(await hashPw(body.password)), forgot: null });
        await dropSessions(target.username);
        return list();
      }
      if (path === '/auth/admin/approve' || path === '/auth/admin/decline') {
        const pend = target.pending;
        if (!pend) return json({ error: 'Diese Anfrage gibt es nicht mehr.' }, 400);
        if (path === '/auth/admin/decline') { await this.ctx.storage.put(acctKey(target.username), { ...target, pending: null }); return list(); }
        if (pend.type === 'claim') {
          const others = (await accounts()).filter((a) => a.username !== target.username);
          if (!PEOPLE.includes(pend.person) || others.some((a) => a.person === pend.person)) return json({ error: `${pend.person} ist schon mit einem anderen Account verbunden.` }, 400);
          await this.ctx.storage.put(acctKey(target.username), { ...target, person: pend.person, pending: null });
        } else {
          const err = await doJoin(target, pend);
          if (err) return json({ error: err }, 400);
        }
        return list();
      }
      if (path === '/auth/admin/delete') {
        if (target.username === acct.username) return json({ error: 'Deinen eigenen Account kannst du hier nicht löschen.' }, 400);
        await this.ctx.storage.delete(acctKey(target.username));
        await dropSessions(target.username);
        return list();
      }
      return json({ error: 'bad request' }, 400);
    }
    // Neu in der WG: Account ist da, Person wird beim Beitreten angelegt
    const open = path === '/calendar.ics' || path.startsWith('/photo/') || path.startsWith('/board/photo/') || path === '/vapid' || path === '/unsubscribe' || (path === '/_cron' && this.env.DEV_MODE);
    if (path === '/members/join' && !acct) return json({ error: 'Bitte melde dich an.', auth: true }, 401);
    if (!me && !open && path !== '/members/join') return json({ error: 'Bitte melde dich an.', auth: true }, 401);
    if (me) {
      // Wer etwas tut, ist immer die angemeldete Person
      for (const k of ['by', 'me', 'person']) if (k in body) body[k] = me;
      if ('name' in body && !['/cleaner/contact', '/members/join', '/shop/add', '/shop/categories'].includes(path)) body.name = me;
    }

    // Kalender-Abo für Apple/Google Kalender
    if (path === '/calendar.ics' && request.method === 'GET') {
      const person = PEOPLE.includes(url.searchParams.get('p')) ? url.searchParams.get('p') : null;
      const lang = ['en', 'sv'].includes(url.searchParams.get('lang')) ? url.searchParams.get('lang') : 'de';
      const current = mondayOf(berlinNow().day);
      const weeks = await this.weeks([...Array(30)].map((_, i) => addDays(current, (i - 4) * 7)));
      const events = (await this.events()).filter((e) => e.to >= addDays(current, -120));
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
      const inc = url.searchParams.get('inc');
      const kinds = inc ? inc.split(',').filter((k) => ICS_KINDS.includes(k)) : ICS_KINDS;
      const ics = buildIcs({ events, members: await this.members(), people: PEOPLE, weeks, person, lang, origin: url.origin, stamp, kinds });
      return new Response(ics, { headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-cache', 'content-disposition': 'inline; filename="zentrale.ics"' } });
    }

    if (path === '/feedback' && request.method === 'POST') {
      if (!me) return json({ error: 'Bitte melde dich an.', auth: true }, 401);
      const f = await this.feedback();
      const stars = Math.round(Number(body.stars));
      if (!(stars >= 1 && stars <= 5)) return json({ error: 'Bitte gib 1 bis 5 Sterne.' }, 400);
      const USES = ['plan', 'shop', 'money', 'cal', 'board', 'badges'];
      f.answers[me] = { stars, like: typeof body.like === 'string' ? body.like.trim().slice(0, 1000) : '', ideas: typeof body.ideas === 'string' ? body.ideas.trim().slice(0, 2000) : '', uses: Array.isArray(body.uses) ? body.uses.filter((u) => USES.includes(u)) : [], at: Date.now() };
      await this.ctx.storage.put('feedback', f);
      const names = await this.names();
      if (!f.reported && names.every((p) => f.answers[p])) {
        f.reported = true;
        await this.ctx.storage.put('feedback', f);
        await this.pushToPerson(admin, (l) => ({ title: pick(l)('📊 App-Umfrage: alle haben geantwortet', '📊 App survey: everyone answered', '📊 Appenkät: alla har svarat'), body: pick(l)('Der Report ist da. Tippe hier und öffne „App-Umfrage ansehen“ in den Einstellungen.', 'The report is ready. Tap here and open "View app survey" in Settings.', 'Rapporten är klar. Tryck här och öppna "Visa appenkät" i inställningarna.'), url: '/#start' }));
      }
      return json({ ok: true, feedback: await this.feedbackFor(me) });
    }
    if (path === '/translate' && request.method === 'POST') {
      if (!me) return json({ error: 'Bitte melde dich an.', auth: true }, 401);
      const to = ['de', 'en', 'sv'].includes(body.to) ? body.to : 'de';
      const texts = [...new Set((Array.isArray(body.texts) ? body.texts : []).filter((t) => typeof t === 'string' && t.trim() && t.length <= 2000))].slice(0, 40);
      return json({ to, tr: await this.translate(texts, to) });
    }
    if (path === '/push/prefs' && request.method === 'POST') {
      if (!me) return json({ error: 'Bitte melde dich an.', auth: true }, 401);
      const CATS = ['plan', 'cleaner', 'swap', 'money', 'react', 'board', 'cal', 'people', 'translate'];
      const all = (await this.ctx.storage.get('pushprefs')) || {};
      all[me] = Object.fromEntries(CATS.filter((c) => body.prefs?.[c] === false).map((c) => [c, false]));
      await this.ctx.storage.put('pushprefs', all);
      return json({ pushPrefs: all[me] });
    }
    if (path === '/report' && request.method === 'GET') {
      const f = url.searchParams.get('from');
      return json(await this.report(/^\d{4}-\d{2}-\d{2}$/.test(f || '') ? f : null));
    }
    if (path === '/weeks' && request.method === 'GET') {
      const current = mondayOf(berlinNow().day);
      const from = validMonday(url.searchParams.get('from')) ? url.searchParams.get('from') : addDays(current, -7);
      const count = Math.min(Math.max(Number(url.searchParams.get('count')) || 12, 1), 30);
      const weeks = await this.weeks([...Array(count)].map((_, i) => addDays(from, i * 7)));
      return json({ people: PEOPLE, members: await this.members(), absences: await this.absences(), events: await this.events(), polls: await this.polls(), surveys: await this.surveysFor(me), swapRequests: await this.swapRequests(), board: await this.board(), reactions: await this.reactions(), gami: await this.gami(), cleanerContact: await this.cleanerContact(), pushPrefs: ((await this.ctx.storage.get('pushprefs')) || {})[me] || {}, feedback: await this.feedbackFor(me), current, today: berlinNow().day, weeks });
    }

    if (path === '/check' && request.method === 'POST') {
      const { monday, key, done, by } = body;
      if (!validMonday(monday) || typeof key !== 'string' || key.length > 60) return json({ error: 'bad request' }, 400);
      const k = `check:${monday}:${key}`;
      if (done) await this.ctx.storage.put(k, { by: me || (PEOPLE.includes(by) ? by : null), at: Date.now() });
      else await this.ctx.storage.delete(k);
      return json({ ...(await this.week(monday)), gami: await this.gami() });
    }

    // ---------- Reaktionen (Emoji auf erledigte Dienste und Pinnwand-Zettel) ----------
    if (path === '/react' && request.method === 'POST') {
      const { target, emoji, by } = body;
      if (!REACTIONS.includes(emoji) || !PEOPLE.includes(by) || typeof target !== 'string') return json({ error: 'bad request' }, 400);
      let owners = []; let what = null; let url = '/#start';
      const tm = /^task:(\d{4}-\d{2}-\d{2}):([a-z-]{2,30})$/.exec(target);
      const nm = /^note:([a-z0-9]{4,30})$/.exec(target);
      if (tm && validMonday(tm[1])) {
        const w = await this.week(tm[1]);
        const t = w.tasks.find((x) => x.key === tm[2]);
        if (!t) return json({ error: 'bad request' }, 400);
        owners = [...new Set(Object.entries(w.checks).filter(([k, c]) => k.startsWith(`${t.key}:`) && c?.by).map(([, c]) => c.by))];
        if (!owners.length && t.person) owners = [t.person];
        what = (l) => tr(t.title, l); url = '/#plan';
      } else if (nm) {
        const n = (await this.board()).find((x) => x.id === nm[1]);
        if (!n) return json({ error: 'Der Zettel hängt nicht mehr.' }, 404);
        owners = n.by ? [n.by] : [];
        what = (l) => (n.text ? `„${n.text.slice(0, 60)}“` : pick(l)('dein Foto', 'your photo', 'ditt foto'));
      } else return json({ error: 'bad request' }, 400);
      const all = await this.reactions();
      const r = all[target] || {};
      const list = r[emoji] || [];
      const adding = !list.includes(by);
      r[emoji] = adding ? [...list, by] : list.filter((x) => x !== by);
      if (!r[emoji].length) delete r[emoji];
      if (Object.keys(r).length) all[target] = r; else delete all[target];
      // nicht endlos wachsen lassen
      const keys = Object.keys(all);
      for (const k of keys.slice(0, Math.max(0, keys.length - 400))) delete all[k];
      await this.ctx.storage.put('reactions', all);
      const pushedKey = `reacted:${target}:${by}`;
      if (adding && !(await this.ctx.storage.get(pushedKey))) {
        await this.ctx.storage.put(pushedKey, 1);
        for (const p of owners) {
          if (p === by) continue;
          await this.pushCat('react', p, (l) => ({
            title: `${emoji} ${by}`,
            body: pick(l)(`${by} hat auf ${what('de')} reagiert: ${emoji}`, `${by} reacted to ${what('en')}: ${emoji}`, `${by} reagerade på ${what('sv')}: ${emoji}`),
            url,
          }));
        }
      }
      return json({ reactions: all });
    }

    if (path === '/swap' && request.method === 'POST') {
      const { monday, task, person } = body;
      if (!validMonday(monday) || !['woche', 'bad-vorne', 'bad-hinten'].includes(task)) return json({ error: 'bad request' }, 400);
      const ov = await this.overrides(monday);
      ov.swaps = ov.swaps || {};
      if (PEOPLE.includes(person)) ov.swaps[task] = person;
      else delete ov.swaps[task];
      await this.ctx.storage.put(`ov:${monday}`, ov);
      return json(await this.week(monday));
    }

    // Tauschen nur mit Zustimmung der anderen Person
    if (path.startsWith('/swap/') && request.method === 'POST') {
      const TASKS = ['woche', 'bad-vorne', 'bad-hinten'];
      let list = (await this.swapRequests()).filter((r) => r.status === 'open' || Date.now() - r.at < 14 * 864e5);
      const save = async () => { await this.ctx.storage.put('swapRequests', list); return json({ swapRequests: list }); };
      const taskOf = async (monday, key) => (await this.week(monday)).tasks.find((t) => t.key === key);
      const wk = (m, l) => (l === 'en' ? `the week of ${ddmm(m, l)}` : l === 'sv' ? `veckan från ${ddmm(m, l)}` : `der Woche ab ${ddmm(m, l)}`);
      if (path === '/swap/request') {
        const { monday, task, by, to, back } = body;
        if (!validMonday(monday) || !TASKS.includes(task) || !PEOPLE.includes(by) || !PEOPLE.includes(to) || by === to) return json({ error: 'bad request' }, 400);
        const t = await taskOf(monday, task);
        if (!t || t.person !== by) return json({ error: 'Nur wer gerade dran ist, kann diesen Dienst tauschen.' }, 400);
        let b = null;
        if (back && validMonday(back.monday) && TASKS.includes(back.task)) {
          const bt = await taskOf(back.monday, back.task);
          if (!bt || bt.person !== to) return json({ error: 'Diesen Dienst hat die andere Person nicht.' }, 400);
          b = { monday: back.monday, task: back.task };
        }
        list = list.filter((r) => !(r.status === 'open' && r.monday === monday && r.task === task));
        const r = { id: rid(), by, to, monday, task, back: b, status: 'open', at: Date.now() };
        list.push(r);
        const bTitle = b ? (await taskOf(b.monday, b.task)).title : '';
        await this.pushCat('swap', to, (l) => {
          const L = pick(l);
          return {
            title: L(`🔁 ${by} möchte mit dir Putzdienst tauschen`, `🔁 ${by} would like to swap cleaning duty with you`, `🔁 ${by} vill byta städtjänst med dig`),
            body: L(`Du übernimmst „${t.title}“ in ${wk(monday, 'de')}`, `You take over "${tr(t.title, 'en')}" in ${wk(monday, 'en')}`, `Du tar över "${tr(t.title, 'sv')}" ${wk(monday, 'sv')}`)
              + (b ? L(`, dafür übernimmt ${by} dein „${bTitle}“ in ${wk(b.monday, 'de')}.`, `, and ${by} takes over your "${tr(bTitle, 'en')}" in ${wk(b.monday, 'en')}.`, `, och ${by} tar över din "${tr(bTitle, 'sv')}" ${wk(b.monday, 'sv')}.`) : '.')
              + L(' Tipp hier, um zuzusagen oder abzulehnen.', ' Tap to accept or decline.', ` Tryck för att tacka ja eller nej.`),
            url: '/#plan',
          };
        });
        return save();
      }
      const r = list.find((x) => x.id === body.id && x.status === 'open');
      if (!r) return json({ error: 'Diese Anfrage gibt es nicht mehr.' }, 404);
      if (path === '/swap/cancel') {
        list = list.filter((x) => x !== r);
        return save();
      }
      if (path === '/swap/answer') {
        if (body.name !== r.to) return json({ error: 'Nur die angefragte Person kann antworten.' }, 400);
        const t = await taskOf(r.monday, r.task);
        if (body.accept) {
          if (!t || t.person !== r.by) return json({ error: 'Der Dienst hat sich inzwischen geändert. Die Anfrage ist nicht mehr gültig.' }, 400);
          const apply = async (monday, task, person, planned) => {
            const ov = await this.overrides(monday);
            ov.swaps = ov.swaps || {};
            if (person === planned) delete ov.swaps[task]; else ov.swaps[task] = person;
            await this.ctx.storage.put(`ov:${monday}`, ov);
          };
          await apply(r.monday, r.task, r.to, t.planned);
          await this.bump(r.to, 'swaps');
          if (!r.back) await this.bump(r.to, 'rescue');
          if (r.back) {
            const bt = await taskOf(r.back.monday, r.back.task);
            if (bt && bt.person === r.to) await apply(r.back.monday, r.back.task, r.by, bt.planned);
          }
        }
        r.status = body.accept ? 'accepted' : 'declined';
        r.answeredAt = Date.now();
        await this.pushCat('swap', r.by, (l) => {
          const L = pick(l);
          return body.accept
            ? { title: L(`✅ ${r.to} hat dem Tausch zugestimmt`, `✅ ${r.to} accepted the swap`, `✅ ${r.to} har tackat ja till bytet`), body: L(`${r.to} übernimmt „${t.title}“ in ${wk(r.monday, 'de')}. Der Putzplan ist angepasst.`, `${r.to} takes over "${tr(t.title, 'en')}" in ${wk(r.monday, 'en')}. The rota has been updated.`, `${r.to} tar över "${tr(t.title, 'sv')}" ${wk(r.monday, 'sv')}. Schemat är uppdaterat.`), url: '/#plan' }
            : { title: L(`❌ ${r.to} kann leider nicht tauschen`, `❌ ${r.to} can't swap`, `❌ ${r.to} kan tyvärr inte byta`), body: L(`Frag am besten jemand anderen für „${t.title}“ in ${wk(r.monday, 'de')}.`, `Best ask someone else for "${tr(t.title, 'en')}" in ${wk(r.monday, 'en')}.`, `Fråga helst någon annan om "${tr(t.title, 'sv')}" ${wk(r.monday, 'sv')}.`), url: '/#plan' };
        });
        return save();
      }
      return json({ error: 'bad request' }, 400);
    }

    if (path === '/ausfall' && request.method === 'POST') {
      const { monday, value } = body;
      if (!validMonday(monday)) return json({ error: 'bad request' }, 400);
      const ov = await this.overrides(monday);
      ov.ausfall = !!value;
      const list = new Set((await this.ctx.storage.get('ausfaelle')) || []);
      if (ov.ausfall) list.add(monday); else list.delete(monday);
      await this.ctx.storage.put('ausfaelle', [...list].sort());
      await this.ctx.storage.put(`ov:${monday}`, ov);
      const week = await this.week(monday);
      // Sofort alle benachrichtigen (nur beim ersten Eintragen, nicht beim Zurücknehmen)
      const flag = `sent:ausfall:${monday}`;
      if (ov.ausfall && !(await this.ctx.storage.get(flag))) {
        await this.ctx.storage.put(flag, Date.now());
        for (const [p, m] of Object.entries(ausfallMessages(week, await this.langs()))) await this.pushCat('cleaner', p, m);
      }
      return json(week);
    }

    if (path === '/cleaner/contact' && request.method === 'POST') {
      await this.ctx.storage.put('cleanerContact', PEOPLE.includes(body.name) ? body.name : null);
      return json({ cleanerContact: await this.cleanerContact() });
    }

    if (path === '/cleaner/visit' && request.method === 'POST') {
      const { monday, date, time, by } = body;
      if (!validMonday(monday)) return json({ error: 'bad request' }, 400);
      if (!(typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= monday && date <= addDays(monday, 6))) {
        return json({ error: 'Bitte einen Tag in dieser Woche wählen.' }, 400);
      }
      const ov = await this.overrides(monday);
      ov.cleanerDate = date;
      ov.cleanerTime = typeof time === 'string' && /^\d{2}:\d{2}$/.test(time) ? time : '';
      ov.cleanerConfirmed = true;
      await this.ctx.storage.put(`ov:${monday}`, ov);
      const week = await this.week(monday);
      if (!week.plannedCleaner) return json({ error: 'In dieser Woche ist keine Putzkraft geplant.' }, 400);
      for (const [p, m] of Object.entries(cleanerVisitMessages(week, PEOPLE.includes(by) ? by : null, await this.langs()))) await this.pushCat('cleaner', p, m);
      return json(week);
    }

    // Putzkraft verschieben (auch in eine andere Woche) oder zusätzlich eintragen
    if ((path === '/cleaner/move' || path === '/cleaner/extra') && request.method === 'POST') {
      const by = PEOPLE.includes(body.by) ? body.by : null;
      const date = body.date;
      const time = isTime(body.time) ? body.time : '';
      if (!isDay(date)) return json({ error: 'Bitte ein gültiges Datum angeben.' }, 400);
      const target = mondayOf(date);
      const tov = await this.overrides(target);
      let fromDay = null;
      if (path === '/cleaner/move') {
        const from = body.from;
        if (!validMonday(from)) return json({ error: 'bad request' }, 400);
        const src = await this.week(from);
        if (!src.cleaner) return json({ error: 'In dieser Woche ist keine Putzkraft geplant.' }, 400);
        fromDay = src.cleanerDay;
        const sov = await this.overrides(from);
        if (from === target) {
          // gleiche Woche: nur Tag/Uhrzeit ändern
          if (src.extra) sov.extra = { ...sov.extra, date, time }; else Object.assign(sov, { cleanerDate: date, cleanerTime: time, cleanerConfirmed: true });
          await this.ctx.storage.put(`ov:${from}`, sov);
        } else {
          const tw = await this.week(target);
          if (tw.cleaner) return json({ error: 'In dieser Woche kommt die Putzkraft schon.' }, 400);
          const origin = src.extra ? src.extraFrom : from; // ursprüngliche Woche merken
          if (src.extra) delete sov.extra; else sov.movedTo = date;
          await this.ctx.storage.put(`ov:${from}`, sov);
          if (origin && origin !== from && origin !== target) {
            const oov = await this.overrides(origin);
            oov.movedTo = date;
            await this.ctx.storage.put(`ov:${origin}`, oov);
          }
          if (origin === target) { // zurück in die ursprüngliche Woche
            const t2 = await this.overrides(target);
            delete t2.movedTo;
            Object.assign(t2, { cleanerDate: date, cleanerTime: time, cleanerConfirmed: true });
            await this.ctx.storage.put(`ov:${target}`, t2);
          } else {
            tov.extra = { date, time, ...(origin && origin !== target ? { from: origin } : {}) };
            await this.ctx.storage.put(`ov:${target}`, tov);
          }
        }
      } else {
        const tw = await this.week(target);
        if (tw.cleaner) return json({ error: 'In dieser Woche kommt die Putzkraft schon.' }, 400);
        tov.extra = { date, time };
        await this.ctx.storage.put(`ov:${target}`, tov);
      }
      const week = await this.week(target);
      const when = (l) => `${fmtD(date, l)}${time ? `${{ en: ' at', sv: ' kl.' }[l] || ' um'} ${time}` : ''}`;
      for (const p of PEOPLE) {
        if (p === by) continue;
        await this.pushCat('cleaner', p, (l) => {
          const L = pick(l);
          const head = fromDay && fromDay !== date
            ? L(`Die Putzkraft kommt nicht am ${fmtD(fromDay)}, sondern am ${when(l)}.`, `The cleaner is not coming on ${fmtD(fromDay, 'en')} but on ${when(l)}.`, `Städhjälpen kommer inte ${fmtD(fromDay, 'sv')} utan ${when(l)}.`)
            : fromDay ? L(`Die Putzkraft kommt am ${when(l)}.`, `The cleaner comes on ${when(l)}.`, `Städhjälpen kommer ${when(l)}.`)
              : L(`Zusätzlicher Termin: Die Putzkraft kommt am ${when(l)}.`, `Extra visit: the cleaner comes on ${when(l)}.`, `Extrabesök: städhjälpen kommer ${when(l)}.`);
          return { title: L('Putzkraft-Termin 🧹', 'Cleaner appointment 🧹', `Tid för städhjälpen 🧹`), body: `${head} ${L('Der Putzplan ist angepasst.', 'The cleaning rota has been updated.', `Städschemat är uppdaterat.`)}${by ? L(` (von ${by})`, ` (by ${by})`, ` (av ${by})`) : ''}`, url: '/#plan' };
        });
      }
      return json(week);
    }
    if (path === '/cleaner/extra/remove' && request.method === 'POST') {
      if (!validMonday(body.monday)) return json({ error: 'bad request' }, 400);
      const ov = await this.overrides(body.monday);
      const from = ov.extra?.from;
      delete ov.extra;
      await this.ctx.storage.put(`ov:${body.monday}`, ov);
      if (from) { // verschobenen Termin zurück in die ursprüngliche Woche
        const sov = await this.overrides(from);
        delete sov.movedTo;
        await this.ctx.storage.put(`ov:${from}`, sov);
      }
      return json(await this.week(body.monday));
    }
    if (path === '/cleaner/unmove' && request.method === 'POST') {
      if (!validMonday(body.monday)) return json({ error: 'bad request' }, 400);
      const ov = await this.overrides(body.monday);
      if (ov.movedTo) {
        const t = mondayOf(ov.movedTo);
        const tov = await this.overrides(t);
        if (tov.extra?.from === body.monday) { delete tov.extra; await this.ctx.storage.put(`ov:${t}`, tov); }
        delete ov.movedTo;
        await this.ctx.storage.put(`ov:${body.monday}`, ov);
      }
      return json(await this.week(body.monday));
    }

    if (path === '/vapid') {
      return json({ publicKey: vapidPublicRaw((await this.vapid()).publicJwk) });
    }

    if (path === '/subscribe' && request.method === 'POST') {
      const { person, subscription } = body;
      if (!PEOPLE.includes(person) || !(subscription?.endpoint?.startsWith('https://') || (this.env.DEV_MODE && subscription?.endpoint?.startsWith('http://'))) || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
        return json({ error: 'bad request' }, 400);
      }
      await this.ctx.storage.put(`sub:${await sha(subscription.endpoint)}`, { person, subscription, created: Date.now() });
      return json({ ok: true });
    }

    if (path === '/unsubscribe' && request.method === 'POST') {
      if (typeof body.endpoint === 'string') await this.ctx.storage.delete(`sub:${await sha(body.endpoint)}`);
      return json({ ok: true });
    }

    if (path === '/test' && request.method === 'POST') {
      const entry = typeof body.endpoint === 'string' && (await this.ctx.storage.get(`sub:${await sha(body.endpoint)}`));
      if (!entry) return json({ error: 'Dieses Gerät ist nicht angemeldet.' }, 404);
      const L = pick((await this.langs())[entry.person]);
      const r = await this.push(`sub:${await sha(body.endpoint)}`, entry, {
        title: 'Zentrale 🧽',
        body: L(`Hallo ${entry.person}, die Erinnerungen funktionieren!`, `Hi ${entry.person}, notifications are working!`, `Hej ${entry.person}, notiserna fungerar!`),
      });
      return json(r, r.ok ? 200 : 502);
    }

    const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    // ---------- Mitglieder ----------
    if (path === '/members/join' && request.method === 'POST') {
      const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ').slice(0, 20) : '';
      const side = body.side === 'hinten' ? 'hinten' : body.side === 'vorne' ? 'vorne' : null;
      if (!name || !side) return json({ error: 'Bitte Namen und Zimmer (vorne/hinten) angeben.' }, 400);
      if (me) return json({ error: 'Dein Account ist schon mit einer Person verbunden.' }, 400);
      const members = await this.members();
      if (members.some((m) => m.name.toLowerCase() === name.toLowerCase() && (!m.until || m.until > mondayOf(berlinNow().day)))) {
        return json({ error: `${name} gibt es schon. Nimm z.B. noch den ersten Buchstaben vom Nachnamen dazu.` }, 400);
      }
      const prof = this.checkProfile(body, { requireAll: !body.quick });
      if (prof.error) return json({ error: prof.error }, 400);
      const pend = { type: 'join', name, side, lang: ['en', 'sv'].includes(body.lang) ? body.lang : 'de', fields: prof.fields, photo: typeof body.photo === 'string' ? body.photo : null, at: Date.now() };
      await this.ctx.storage.put(acctKey(acct.username), { ...acct, pending: pend });
      await notifyAdmin(acct, name);
      return json({ ok: true, pending: true });
    }
    if (path === '/members/profile' && request.method === 'POST') {
      const members = await this.members();
      const m = members.find((x) => x.name === body.name && (!x.until || x.until > mondayOf(berlinNow().day)));
      if (!m) return json({ error: 'Mitglied nicht gefunden.' }, 404);
      const prof = this.checkProfile(body, { requireAll: false });
      if (prof.error) return json({ error: prof.error }, 400);
      let name = m.name;
      const newName = typeof body.newName === 'string' ? body.newName.trim().replace(/\s+/g, ' ').slice(0, 20) : '';
      if (newName && newName !== m.name) {
        if (members.some((x) => x !== m && x.name.toLowerCase() === newName.toLowerCase())) {
          return json({ error: `${newName} gibt es schon. Nimm z.B. noch den ersten Buchstaben vom Nachnamen dazu.` }, 400);
        }
        await this.renameEverywhere(m.name, newName);
        name = newName;
      }
      const photo = await this.savePhoto(name, body.photo);
      const list = (await this.members()).map((x) => {
        if (x.name !== name) return x;
        const y = { ...x, ...prof.fields };
        if (photo === null) delete y.photo; else if (photo) y.photo = photo;
        return y;
      });
      await this.ctx.storage.put('members', list);
      return json({ ok: true, name, members: list });
    }
    if ((path.startsWith('/photo/') || path.startsWith('/board/photo/')) && request.method === 'GET') {
      const data = await this.ctx.storage.get(path.startsWith('/board/') ? `boardphoto:${decodeURIComponent(path.slice(13))}` : `photo:${decodeURIComponent(path.slice(7))}`);
      if (!data) return new Response('not found', { status: 404 });
      const [head, b64] = data.split(',');
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return new Response(bytes, { headers: { 'content-type': head.slice(5, head.indexOf(';')), 'cache-control': 'public, max-age=31536000, immutable' } });
    }
    // Persönliche Übersicht (Kacheln)
    if (path === '/members/home' && request.method === 'POST') {
      const members = await this.members();
      if (!members.some((m) => m.name === body.name)) return json({ error: 'Mitglied nicht gefunden.' }, 404);
      const layout = (Array.isArray(body.layout) ? body.layout : []).slice(0, 30)
        .filter((x) => x && typeof x.id === 'string' && /^(sc:)?[a-z]{2,20}$/.test(x.id))
        .map((x) => ({ id: x.id, size: x.size === 'w' ? 'w' : 's' }));
      await this.ctx.storage.put('members', members.map((m) => (m.name === body.name ? { ...m, home: layout } : m)));
      return json({ ok: true, members: await this.members() });
    }
    if (path === '/members/lang' && request.method === 'POST') {
      const members = await this.members();
      if (!members.some((m) => m.name === body.name)) return json({ error: 'Mitglied nicht gefunden.' }, 404);
      const lang = ['en', 'sv'].includes(body.lang) ? body.lang : 'de';
      await this.ctx.storage.put('members', members.map((m) => (m.name === body.name ? { ...m, lang } : m)));
      return json({ ok: true, members: await this.members() });
    }
    if (path === '/members/leave' && request.method === 'POST') {
      const members = await this.members();
      const m = members.find((x) => x.name === body.name && !x.until);
      if (!m) return json({ error: 'Mitglied nicht gefunden.' }, 404);
      if (m.name === admin) return json({ error: 'Du bist Admin. Bitte ernenne vorher unter „Accounts verwalten“ einen neuen Admin.' }, 400);
      const day = isDay(body.date) ? body.date : berlinNow().day;
      // Ab dem Montag nach dem Auszug nicht mehr im Plan
      const until = addDays(mondayOf(day), 7);
      if (members.filter((x) => !x.until && x.name !== m.name).length < 1) return json({ error: 'Die letzte Person kann nicht ausziehen 😉' }, 400);
      await this.ctx.storage.put('members', members.map((x) => (x === m ? { ...x, until: until < x.since ? x.since : until, leftNote: body.checklist || null } : x)));
      // Benachrichtigungen dieser Person abmelden
      for (const [k, v] of await this.subscriptions()) if (v.person === m.name) await this.ctx.storage.delete(k);
      return json({ ok: true, until, members: await this.members() });
    }

    // ---------- Kalender ----------
    const calState = async () => json({ events: await this.events(), polls: await this.polls(), absences: await this.absences() });
    const TYPES = ['urlaub', 'meeting', 'sonstiges'];
    const label = (t) => ({ urlaub: 'Urlaub', meeting: 'WG-Meeting', sonstiges: 'Termin' }[t]);

    if (path === '/events/add' && request.method === 'POST') {
      const type = TYPES.includes(body.type) ? body.type : 'sonstiges';
      const by = PEOPLE.includes(body.by) ? body.by : null;
      const from = body.from;
      const to = type === 'meeting' ? from : body.to || from;
      if (!isDay(from) || !isDay(to) || to < from) return json({ error: 'Bitte ein gültiges Datum angeben.' }, 400);
      if (type === 'meeting' && !isTime(body.time)) return json({ error: 'Bitte eine Uhrzeit fürs Meeting angeben.' }, 400);
      let names = Array.isArray(body.participants) ? [...new Set(body.participants.filter((p) => PEOPLE.includes(p)))] : [];
      if (!names.length) names = type === 'meeting' ? PEOPLE : by ? [by] : [];
      if (!names.length) return json({ error: 'Wer ist dabei?' }, 400);
      // Bei Urlaub müssen andere selbst zustimmen; Meetings/Termine gelten direkt
      const participants = names.map((n) => ({ name: n, ok: type !== 'urlaub' || n === by }));
      const ev = { id: rid(), type, title: str(body.title, 60), from, to, time: type !== 'urlaub' && isTime(body.time) ? body.time : '', note: str(body.note, 200), by, participants };
      await this.ctx.storage.put('events', [...(await this.events()), ev].sort((a, b) => (a.from + a.time < b.from + b.time ? -1 : 1)));
      const when = (lang) => `${fmtD(from, lang)}${to !== from ? ` – ${fmtD(to, lang)}` : ''}${ev.time ? `${{ en: ' at', sv: ' kl.' }[lang] || ' um'} ${ev.time}` : ''}`;
      for (const p of participants) {
        if (p.name === by) continue;
        if (type === 'urlaub') {
          await this.pushCat('cal', p.name, (lang) => {
            const L = pick(lang);
            return {
              title: L('Urlaub bestätigen? 🏖️', 'Confirm holiday? 🏖️', `Bekräfta semester? 🏖️`),
              body: L(`${by || 'Jemand'} hat dich beim Urlaub ${ev.title ? `„${ev.title}“ ` : ''}${when(lang)} eingetragen. Bitte in der Zentrale bestätigen.`,
                `${by || 'Someone'} added you to the holiday ${ev.title ? `"${ev.title}" ` : ''}${when(lang)}. Please confirm in the app.`, `${by || 'Någon'} har lagt till dig i semestern ${ev.title ? `"${ev.title}" ` : ''}${when(lang)}. Bekräfta i appen.`),
              url: '/#kalender',
            };
          });
        } else {
          await this.pushCat('cal', p.name, (lang) => {
            const L = pick(lang);
            return {
              title: `${type === 'meeting' ? '🗣️ ' : '📅 '}${ev.title || (lang === 'en' ? { meeting: 'Flat meeting', sonstiges: 'Event' }[type] : lang === 'sv' ? { meeting: 'Husmöte', sonstiges: 'Händelse' }[type] : label(type))}`,
              body: L(`Neuer Termin: ${when(lang)}${by ? ` (von ${by})` : ''}.`, `New event: ${when(lang)}${by ? ` (from ${by})` : ''}.`, `Ny händelse: ${when(lang)}${by ? ` (från ${by})` : ''}.`),
              url: '/#kalender',
            };
          });
        }
      }
      return calState();
    }
    if (path === '/events/respond' && request.method === 'POST') {
      const list = await this.events();
      const ev = list.find((e) => e.id === body.id);
      if (!ev || !ev.participants.some((p) => p.name === body.name)) return json({ error: 'Eintrag nicht gefunden.' }, 404);
      ev.participants = body.accept
        ? ev.participants.map((p) => (p.name === body.name ? { ...p, ok: true } : p))
        : ev.participants.filter((p) => p.name !== body.name);
      await this.ctx.storage.put('events', ev.participants.length ? list : list.filter((e) => e !== ev));
      return calState();
    }
    // WG-Meeting: Themen sammeln + Protokoll
    if (path.startsWith('/events/notes') && request.method === 'POST') {
      const list = await this.events();
      const ev = list.find((e) => e.id === body.id && e.type === 'meeting');
      if (!ev) return json({ error: 'Meeting nicht gefunden.' }, 404);
      const by = PEOPLE.includes(body.by) ? body.by : null;
      ev.topics ||= [];
      if (path === '/events/notes/topic') {
        const text = str(body.text, 200);
        if (!text) return json({ error: 'Bitte ein Thema eingeben.' }, 400);
        if (ev.topics.length >= 50) return json({ error: 'Zu viele Themen.' }, 400);
        ev.topics.push({ id: crypto.randomUUID().slice(0, 8), text, by });
      } else if (path === '/events/notes/topic-delete') {
        ev.topics = ev.topics.filter((t) => t.id !== body.topic);
      } else if (path === '/events/notes/minutes') {
        ev.minutes = { text: str(body.text, 10000), by, at: Date.now() };
      } else return json({ error: 'not found' }, 404);
      await this.ctx.storage.put('events', list);
      return calState();
    }
    if (path === '/events/delete' && request.method === 'POST') {
      await this.ctx.storage.put('events', (await this.events()).filter((e) => e.id !== body.id));
      return calState();
    }
    // Alte Route weiter unterstützen
    if (path === '/absences/add' && request.method === 'POST') {
      return json({ error: 'Bitte die Seite neu laden.' }, 400);
    }

    // WG-Meeting anfragen und abstimmen
    if (path === '/polls/add' && request.method === 'POST') {
      const by = PEOPLE.includes(body.by) ? body.by : null;
      const options = (Array.isArray(body.options) ? body.options : [])
        .filter((o) => isDay(o.date) && isTime(o.time)).slice(0, 8).map((o) => ({ id: rid(), date: o.date, time: o.time }));
      if (options.length < 1) return json({ error: 'Bitte mindestens einen Terminvorschlag mit Datum und Uhrzeit angeben.' }, 400);
      const poll = { id: rid(), title: str(body.title, 60) || 'WG-Meeting', note: str(body.note, 200), by, options, votes: by ? { [by]: Object.fromEntries(options.map((o) => [o.id, 'yes'])) } : {}, status: 'open', at: Date.now() };
      await this.ctx.storage.put('polls', [...(await this.polls()), poll]);
      for (const p of PEOPLE) {
        if (p !== by) {
          await this.pushCat('cal', p, (lang) => {
            const L = pick(lang);
            return {
              title: L('🗳️ WG-Meeting: wann passt es dir?', '🗳️ Flat meeting: when suits you?', `🗳️ Husmöte: när passar det?`),
              body: L(`${by || 'Jemand'} wünscht sich ein Meeting${poll.title !== 'WG-Meeting' ? ` („${poll.title}“)` : ''}. Stimm in der Zentrale ab.`,
                `${by || 'Someone'} would like a meeting${poll.title !== 'WG-Meeting' ? ` ("${poll.title}")` : ''}. Vote in the app.`, `${by || 'Någon'} vill ha ett möte${poll.title !== 'WG-Meeting' ? ` ("${poll.title}")` : ''}. Rösta i appen.`),
              url: '/#kalender',
            };
          });
        }
      }
      return calState();
    }
    if (path === '/polls/vote' && request.method === 'POST') {
      const polls = await this.polls();
      const poll = polls.find((p) => p.id === body.id && p.status === 'open');
      if (!poll || !PEOPLE.includes(body.name)) return json({ error: 'Abstimmung nicht gefunden.' }, 404);
      const v = {};
      for (const o of poll.options) if (['yes', 'maybe', 'no'].includes(body.votes?.[o.id])) v[o.id] = body.votes[o.id];
      poll.votes = { ...poll.votes, [body.name]: v };
      await this.ctx.storage.put('polls', polls);
      return calState();
    }
    if (path === '/polls/close' && request.method === 'POST') {
      const polls = await this.polls();
      const poll = polls.find((p) => p.id === body.id && p.status === 'open');
      const opt = poll?.options.find((o) => o.id === body.optionId);
      if (!opt) return json({ error: 'Termin nicht gefunden.' }, 404);
      const ev = { id: rid(), type: 'meeting', title: poll.title, from: opt.date, to: opt.date, time: opt.time, note: poll.note, by: poll.by, participants: PEOPLE.map((n) => ({ name: n, ok: true })), poll: poll.id };
      poll.status = 'done';
      poll.eventId = ev.id;
      await this.ctx.storage.put('polls', polls);
      await this.ctx.storage.put('events', [...(await this.events()), ev].sort((a, b) => (a.from + a.time < b.from + b.time ? -1 : 1)));
      for (const p of PEOPLE) {
        await this.pushCat('cal', p, (lang) => (lang === 'en'
          ? { title: '🗣️ Flat meeting is set', body: `${poll.title === 'WG-Meeting' ? 'Flat meeting' : poll.title}: ${fmtD(opt.date, 'en')} at ${opt.time}. See you then!`, url: '/#kalender' }
          : lang === 'sv' ? { title: '🗣️ Husmötet är bestämt', body: `${poll.title === 'WG-Meeting' ? 'Husmöte' : poll.title}: ${fmtD(opt.date, 'sv')} kl. ${opt.time}. Vi ses!`, url: '/#kalender' }
          : { title: '🗣️ WG-Meeting steht fest', body: `${poll.title}: ${fmtD(opt.date)} um ${opt.time} Uhr. Bis dann!`, url: '/#kalender' }));
      }
      return calState();
    }
    // ---------- Umfragen (Übersicht) ----------
    if (path.startsWith('/surveys/') && request.method === 'POST') {
      const list = await this.surveys();
      const save = async () => { await this.ctx.storage.put('surveys', list.slice(-40)); return json({ surveys: await this.surveysFor(body.me || body.name || body.by, list) }); };
      const by = PEOPLE.includes(body.by) ? body.by : null;
      if (path === '/surveys/add') {
        const question = str(body.question, 200);
        const opts = (Array.isArray(body.options) ? body.options : []).map((o) => str(o, 80)).filter(Boolean).slice(0, 10);
        if (!question) return json({ error: 'Bitte eine Frage eingeben.' }, 400);
        if (opts.length < 2) return json({ error: 'Bitte mindestens zwei Antworten angeben.' }, 400);
        const s = { id: rid(), question, options: opts.map((t) => ({ id: rid() + Math.random().toString(36).slice(2, 5), text: t })), multi: !!body.multi, anon: !!body.anon, by, votes: {}, status: 'open', at: Date.now() };
        list.push(s);
        for (const p of PEOPLE) {
          if (p === by) continue;
          await this.pushCat('board', p, async (l, who) => { const q = await this.trFor(question, l, who); return (l === 'en'
            ? { title: `🗳️ Poll${by ? ` from ${by}` : ''}`, body: `${q} Tap to answer.`, url: '/#start' }
            : l === 'sv' ? { title: `🗳️ Omröstning${by ? ` från ${by}` : ''}`, body: `${q} Tryck för att svara.`, url: '/#start' }
            : { title: `🗳️ Umfrage${by ? ` von ${by}` : ''}`, body: `${q} Tipp hier, um abzustimmen.`, url: '/#start' }); });
        }
        return save();
      }
      const s = list.find((x) => x.id === body.id);
      if (!s) return json({ error: 'Umfrage nicht gefunden.' }, 404);
      if (path === '/surveys/vote') {
        if (!PEOPLE.includes(body.name) || s.status !== 'open') return json({ error: 'Umfrage nicht gefunden.' }, 404);
        const valid = new Set(s.options.map((o) => o.id));
        let choices = (Array.isArray(body.choices) ? body.choices : []).filter((c) => valid.has(c));
        if (!s.multi) choices = choices.slice(0, 1);
        if (choices.length) s.votes[body.name] = choices; else delete s.votes[body.name];
        // Alle (außer der fragenden Person) haben abgestimmt → Ersteller:in benachrichtigen
        const others = PEOPLE.filter((p) => p !== s.by);
        if (s.by && !s.doneNotified && others.length && others.every((p) => s.votes[p])) {
          s.doneNotified = true;
          const result = (l) => s.options.map((o) => {
            const who = Object.entries(s.votes).filter(([, c]) => c.includes(o.id)).map(([n]) => n);
            if (s.anon) return `${o.text}: ${who.length}`;
            return `${o.text}: ${who.length ? who.join(', ') : '–'}`;
          }).join(' · ');
          await this.pushCat('board', s.by, (l) => (l === 'en'
            ? { title: '✅ Everyone has answered', body: `"${s.question}" ${result(l)}`, url: '/#start' }
            : l === 'sv' ? { title: '✅ Alla har svarat', body: `"${s.question}" ${result(l)}`, url: '/#start' }
            : { title: '✅ Alle haben abgestimmt', body: `„${s.question}“ ${result(l)}`, url: '/#start' }));
        }
        return save();
      }
      if (path === '/surveys/close') { s.status = s.status === 'open' ? 'closed' : 'open'; return save(); }
      if (path === '/surveys/delete') { list.splice(list.indexOf(s), 1); return save(); }
      return json({ error: 'not found' }, 404);
    }
    if (path === '/polls/delete' && request.method === 'POST') {
      await this.ctx.storage.put('polls', (await this.polls()).filter((p) => p.id !== body.id));
      return calState();
    }

    // ---------- Einkaufsliste ----------
    const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

    if (path === '/shop' && request.method === 'GET') {
      return json(await this.shop());
    }
    if (path === '/shop/add' && request.method === 'POST') {
      const name = str(body.name, 80);
      const cats = await this.categories();
      const cat = cats.some((c) => c.id === body.cat) ? body.cat : cats[cats.length - 1].id;
      if (!name) return json({ error: 'Was soll eingekauft werden?' }, 400);
      const id = newId();
      await this.ctx.storage.put(`shop:${id}`, { id, name, cat, by: PEOPLE.includes(body.by) ? body.by : null, at: Date.now() });
      return json(await this.shop());
    }
    if (path === '/shop/categories' && request.method === 'POST') {
      // Komplette Liste speichern: [{id?, label, icon}] – neue ohne id, fehlende werden gelöscht
      const old = await this.categories();
      const list = (Array.isArray(body.categories) ? body.categories : []).slice(0, 20).map((c) => ({
        id: typeof c.id === 'string' && old.some((o) => o.id === c.id) ? c.id : `k${newId()}`,
        label: str(c.label, 40),
        icon: str(c.icon, 8) || '🛒',
      })).filter((c) => c.label);
      if (!list.length) return json({ error: 'Mindestens eine Kategorie muss bleiben.' }, 400);
      await this.ctx.storage.put('shopcats', list);
      // Sachen aus gelöschten Kategorien landen in „Allgemein“ (oder der letzten Kategorie)
      const fallback = (list.find((c) => c.id === 'allgemein') || list[list.length - 1]).id;
      for (const [k, item] of await this.ctx.storage.list({ prefix: 'shop:' })) {
        if (!list.some((c) => c.id === item.cat)) await this.ctx.storage.put(k, { ...item, cat: fallback });
      }
      return json(await this.shop());
    }
    if (path === '/shop/done' && request.method === 'POST') {
      const key = `shop:${str(body.id, 40)}`;
      const item = await this.ctx.storage.get(key);
      if (item) {
        await this.ctx.storage.delete(key);
        await this.bump(body.by, 'bought');
        if (PEOPLE.includes(body.by)) await this.logAct('bought', body.by);
        // Optional direkt als Ausgabe in die WG-Kasse
        const amount = parseEuro(body.price);
        if (amount && PEOPLE.includes(body.by)) {
          await this.addExpense({ desc: item.name, amount, currency: 'EUR', paidBy: body.by, mode: 'equal', parts: computeParts(amount, 'equal', PEOPLE, PEOPLE).parts, split: PEOPLE, by: body.by });
          await notifyMoney('add', { desc: item.name, amount, currency: 'EUR', paidBy: body.by, kind: 'expense' }, me);
        }
      }
      return json(await this.shop());
    }

    // ---------- WG-Kasse ----------
    if (path === '/money' && request.method === 'GET') {
      await this.runRecurring();
      return json(await this.money());
    }
    if (path === '/money/add' && request.method === 'POST') {
      const amount = parseAmount(body.amount);
      const currency = CURRENCIES.includes(body.currency) ? body.currency : 'EUR';
      const kind = body.kind === 'settle' ? 'settle' : 'expense';
      if (!amount) return json({ error: 'Bitte einen gültigen Betrag angeben.' }, 400);
      if (!PEOPLE.includes(body.paidBy)) return json({ error: 'Wer hat bezahlt?' }, 400);
      const mode = kind === 'settle' ? 'equal' : (['equal', 'percent', 'shares', 'exact'].includes(body.mode) ? body.mode : 'equal');
      const { parts, error } = computeParts(amount, mode, PEOPLE, body.split, body.values);
      if (error) return json({ error }, 400);
      if (kind === 'settle' && (Object.keys(parts).length !== 1 || parts[body.paidBy])) return json({ error: 'Ungültige Rückzahlung.' }, 400);
      const desc = str(body.desc, 80) || (kind === 'settle' ? 'Rückzahlung' : 'Ausgabe');
      if (kind === 'expense' && REPEATS[body.repeat]) {
        // Wiederkehrend: heute zum ersten Mal, danach automatisch
        const list = (await this.ctx.storage.get('recurring')) || [];
        list.push({ id: rid(), desc, amount, currency, paidBy: body.paidBy, mode, parts, split: Object.keys(parts), every: body.repeat, next: berlinNow().day, by: PEOPLE.includes(body.by) ? body.by : null, since: berlinNow().day });
        await this.ctx.storage.put('recurring', list);
        await this.runRecurring();
        await notifyMoney('add', { desc, amount, currency, paidBy: body.paidBy, parts, kind }, me);
        return json(await this.money());
      }
      if (body.id) {
        // Bestehende Ausgabe ändern
        const key = `exp:${str(body.id, 40)}`;
        const old = await this.ctx.storage.get(key);
        if (!old || old.net) return json({ error: 'Diesen Eintrag gibt es nicht mehr.' }, 404);
        const upd = { ...old, desc, amount, currency, paidBy: body.paidBy, mode, parts, split: Object.keys(parts), editedBy: me || null, editedAt: Date.now() };
        await this.ctx.storage.put(key, upd);
        await notifyMoney('edit', upd, me);
        return json(await this.money());
      }
      await this.addExpense({
        desc, amount, currency, paidBy: body.paidBy, mode, parts, split: Object.keys(parts), kind,
        by: PEOPLE.includes(body.by) ? body.by : null,
      });
      await notifyMoney('add', { desc, amount, currency, paidBy: body.paidBy, parts, kind }, me);
      return json(await this.money());
    }
    if (path === '/money/import' && request.method === 'POST') {
      if (typeof body.csv !== 'string' || body.csv.length > 2_000_000) return json({ error: 'Keine Datei.' }, 400);
      const r = parseSplitwise(body.csv, [...PEOPLE, ...(await this.members()).map((m) => m.name)]);
      if (r.error) return json({ error: r.error }, 400);
      if (!r.entries.length) return json({ error: 'In der Datei wurden keine Einträge gefunden.' }, 400);
      // Feste IDs: nochmal importieren überschreibt statt doppelt einzutragen
      for (const e of r.entries) await this.ctx.storage.put(`exp:${e.id}`, { ...e, by: PEOPLE.includes(body.by) ? body.by : null });
      return json({ imported: r.entries.length, matches: r.matches, ...(await this.money()) });
    }
    if (path === '/money/recurring/stop' && request.method === 'POST') {
      const list = (await this.ctx.storage.get('recurring')) || [];
      await this.ctx.storage.put('recurring', list.filter((r) => r.id !== body.id));
      return json(await this.money());
    }

    // ---------- Freundlich erinnern ----------
    if (path === '/remind' && request.method === 'POST') {
      const { monday, task, by } = body;
      if (!validMonday(monday) || !PEOPLE.includes(by)) return json({ error: 'bad request' }, 400);
      const t = (await this.week(monday)).tasks.find((x) => x.key === task);
      if (!t || !t.person || t.person === by) return json({ error: 'bad request' }, 400);
      const flag = `remind:${monday}:${task}`;
      const last = await this.ctx.storage.get(flag);
      if (last && Date.now() - last < 6 * 3600e3) return json({ error: 'Es wurde gerade erst erinnert. Bitte später nochmal.' }, 429);
      await this.ctx.storage.put(flag, Date.now());
      await this.logAct('remind', by, { to: t.person, task, monday });
      await this.pushCat('plan', t.person, (l) => {
        const L = pick(l);
        return {
          title: L('🔔 Kleine Erinnerung', '🔔 A little reminder', '🔔 En liten påminnelse'),
          body: L(`${by} erinnert dich freundlich an: ${t.title}. Danke dir! 🙂`, `${by} is kindly reminding you about: ${tr(t.title, 'en')}. Thank you! 🙂`, `${by} påminner dig vänligt om: ${tr(t.title, 'sv')}. Tack! 🙂`),
          url: '/#plan',
        };
      });
      return json({ ok: true });
    }

    // ---------- Pinnwand ----------
    if (path.startsWith('/board/') && request.method === 'POST') {
      let list = await this.board();
      if (path === '/board/add') {
        const text = str(body.text, 300);
        const photo = typeof body.photo === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(body.photo) && body.photo.length < 1_500_000 ? body.photo : null;
        if (body.photo && !photo) return json({ error: 'Das Foto ist zu groß oder kein Bild.' }, 400);
        if (!text && !photo) return json({ error: 'Bitte etwas auf den Zettel schreiben.' }, 400);
        const expires = isDay(body.expires) ? body.expires : null;
        if (expires && expires < berlinNow().day) return json({ error: 'Das Ablaufdatum liegt in der Vergangenheit.' }, 400);
        const color = ['yellow', 'pink', 'blue', 'green', 'orange'].includes(body.color) ? body.color : 'yellow';
        const by = PEOPLE.includes(body.by) ? body.by : null;
        const id = rid();
        if (photo) await this.ctx.storage.put(`boardphoto:${id}`, photo);
        if (by) await this.bump(by, 'notes');
        list.unshift({ id, text, color, by, at: Date.now(), tilt: Math.round((Math.random() * 6 - 3) * 10) / 10, ...(expires ? { expires } : {}), ...(photo ? { photo: true } : {}) });
        // Abgelaufene und zu alte Zettel samt Fotos wegräumen
        const all = (await this.ctx.storage.get('board')) || [];
        const keep = new Set(list.slice(0, 40).map((n) => n.id));
        for (const n of all) if (n.photo && !keep.has(n.id)) await this.ctx.storage.delete(`boardphoto:${n.id}`);
        list = list.slice(0, 40);
        for (const p of PEOPLE) {
          if (p === by) continue;
          await this.pushCat('board', p, async (l, who) => { const tt = await this.trFor(text, l, who); return { title: pick(l)(`📌 Neuer Zettel an der Pinnwand${by ? ` von ${by}` : ''}`, `📌 New note on the board${by ? ` from ${by}` : ''}`, `📌 Ny lapp på anslagstavlan${by ? ` från ${by}` : ''}`), body: photo ? `📷 ${tt || pick(l)('Foto', 'Photo', 'Foto')}` : tt, url: '/#start' }; });
        }
      } else if (path === '/board/delete') {
        list = list.filter((n) => n.id !== body.id);
        await this.ctx.storage.delete(`boardphoto:${body.id}`);
      } else return json({ error: 'bad request' }, 400);
      await this.ctx.storage.put('board', list);
      return json({ board: list });
    }

    if (path === '/money/delete' && request.method === 'POST') {
      const key = `exp:${str(body.id, 40)}`;
      const old = await this.ctx.storage.get(key);
      await this.ctx.storage.delete(key);
      if (old) await notifyMoney('delete', old, me);
      return json(await this.money());
    }

    // Nur lokal zum Testen (DEV_MODE in .dev.vars): Cron für einen beliebigen Zeitpunkt auslösen
    if (path === '/_cron' && this.env.DEV_MODE) {
      return json(await this.runCron(new Date(url.searchParams.get('at'))));
    }

    if (path === '/subscribers') {
      const counts = Object.fromEntries(PEOPLE.map((p) => [p, 0]));
      for (const [, v] of await this.subscriptions()) counts[v.person] = (counts[v.person] || 0) + 1;
      return json(counts);
    }

    return json({ error: 'not found' }, 404);
  }

  // ---------- Push ----------
  async push(key, entry, message) {
    try {
      const r = await sendPush(entry.subscription, { url: '/', ...message }, await this.vapid(), await this.subject());
      if (r.gone) await this.ctx.storage.delete(key);
      return r;
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
  /** message: {title, body} oder Funktion (lang) => {title, body} */
  // ---------- Datensicherung ----------
  /** Alle Daten als ein Objekt (ohne Anmelde-Sitzungen) */
  async dumpAll() {
    const data = {};
    for (const [k, v] of await this.ctx.storage.list()) if (!k.startsWith('sess:')) data[k] = v;
    return data;
  }
  /** Ersetzt alle Daten durch ein Backup (Sitzungen bleiben, damit niemand abgemeldet wird) */
  async restoreAll(data) {
    for (const k of (await this.ctx.storage.list()).keys()) if (!k.startsWith('sess:') && !(k in data)) await this.ctx.storage.delete(k);
    const entries = Object.entries(data).filter(([k]) => !k.startsWith('sess:'));
    for (let i = 0; i < entries.length; i += 100) await this.ctx.storage.put(Object.fromEntries(entries.slice(i, i + 100)));
    return entries.length;
  }
  // Diese drei laufen im separaten Backup-Objekt („backup“), nicht in den WG-Daten
  async snapSave(day, data) {
    const json = JSON.stringify(data);
    const parts = [];
    for (let i = 0; i < json.length; i += 100_000) parts.push(json.slice(i, i + 100_000));
    for (let i = 0; i < parts.length; i += 50) await this.ctx.storage.put(Object.fromEntries(parts.slice(i, i + 50).map((c, j) => [`snap:${day}:${String(i + j).padStart(5, '0')}`, c])));
    const idx = ((await this.ctx.storage.get('snapidx')) || []).filter((s) => s.day !== day);
    idx.push({ day, parts: parts.length, size: json.length, at: Date.now() });
    idx.sort((a, b) => (a.day < b.day ? -1 : 1));
    while (idx.length > 8) { const old = idx.shift(); for (let i = 0; i < old.parts; i++) await this.ctx.storage.delete(`snap:${old.day}:${String(i).padStart(5, '0')}`); }
    await this.ctx.storage.put('snapidx', idx);
    return idx;
  }
  async snapList() { return (await this.ctx.storage.get('snapidx')) || []; }
  async snapGet(day) {
    const s = (await this.snapList()).find((x) => x.day === day);
    if (!s) return null;
    let json = '';
    for (let i = 0; i < s.parts; i++) json += (await this.ctx.storage.get(`snap:${day}:${String(i).padStart(5, '0')}`)) || '';
    return JSON.parse(json);
  }
  backupStub() { return this.env.PUTZPLAN.get(this.env.PUTZPLAN.idFromName('backup')); }

  // ---------- Gastansicht ----------
  /** Läuft im Gast-Objekt: beim ersten Mal eine Kopie der echten Daten holen (ohne Accounts, Sitzungen, Push-Abos) */
  async guestInit() {
    if (await this.ctx.storage.get('guestSandbox')) return true;
    const main = this.env.PUTZPLAN.get(this.env.PUTZPLAN.idFromName('wg'));
    const data = await main.dumpAll();
    const skip = (k) => /^(sess:|sub:|acct:|auth:|sent:|reacted:)/.test(k) || ['pushprefs', 'vapid', 'actlog'].includes(k);
    const entries = Object.entries(data).filter(([k]) => !skip(k));
    for (let i = 0; i < entries.length; i += 100) await this.ctx.storage.put(Object.fromEntries(entries.slice(i, i + 100)));
    await this.ctx.storage.put('guestSandbox', { person: data.admin || 'Toni', at: Date.now() });
    await this.ctx.storage.setAlarm(Date.now() + 24 * 3600e3);
    return true;
  }
  /** Gast-Kopien räumen sich nach einem Tag selbst weg */
  async alarm() {
    if (await this.ctx.storage.get('guestSandbox')) await this.ctx.storage.deleteAll();
  }

  // ---------- App-Umfrage ----------
  async feedback() {
    return (await this.ctx.storage.get('feedback')) || { start: FEEDBACK_START, end: addDays(FEEDBACK_START, 7), answers: {} };
  }
  async feedbackFor(me) {
    const f = await this.feedback();
    const today = berlinNow().day;
    return { start: f.start, end: f.end, active: today >= f.start && today <= f.end, answered: !!(me && f.answers[me]) };
  }

  // ---------- Übersetzen (Cloudflare Workers AI, kostenloses Kontingent) ----------
  /** Übersetzt Texte in die Zielsprache; Ergebnisse werden gespeichert, damit jeder Text nur einmal übersetzt wird */
  async translate(texts, to) {
    const NAMES = { de: 'German', en: 'English', sv: 'Swedish' };
    const out = {};
    const keyOf = async (t) => `tr:${to}:${[...new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    const keys = await Promise.all(texts.map(keyOf));
    const cached = await this.ctx.storage.get(keys);
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i];
      if (cached.get(keys[i]) !== undefined) { out[t] = cached.get(keys[i]); continue; }
      if (!this.env.AI) { out[t] = t; continue; }
      try {
        const r = await this.env.AI.run('@cf/meta/llama-3.1-8b-instruct-fast', {
          messages: [
            { role: 'system', content: `You translate short messages from a shared flat app into ${NAMES[to]}. Keep names, emojis, numbers, prices and line breaks. If the text is already ${NAMES[to]}, return it unchanged. Answer with the translation only, no quotes, no explanations.` },
            { role: 'user', content: t },
          ],
          max_tokens: Math.min(1024, 40 + t.length * 2),
          temperature: 0.1,
        });
        let res = String(r?.response || '').trim().replace(/^["„“']+|["“”']+$/g, '');
        if (!res || res.length > t.length * 4 + 40) res = t;
        out[t] = res;
        await this.ctx.storage.put(keys[i], res);
      } catch { out[t] = t; }
    }
    return out;
  }
  /** Für Pushes: Text in die Sprache der empfangenden Person übersetzen (wenn nicht abgeschaltet) */
  async trFor(text, lang, person) {
    if (!text) return text;
    const prefs = (await this.ctx.storage.get('pushprefs')) || {};
    if (prefs[person]?.translate === false) return text;
    return (await this.translate([text], lang))[text] || text;
  }

  /** Push nur, wenn die Person diesen Bereich nicht in den Einstellungen abgeschaltet hat */
  async pushCat(cat, person, message) {
    const prefs = (await this.ctx.storage.get('pushprefs')) || {};
    if (prefs[person]?.[cat] === false) return 0;
    return this.pushToPerson(person, message);
  }
  async pushToPerson(person, message) {
    if (typeof message === 'function') message = await message((await this.langs())[person] || 'de', person);
    let sent = 0;
    for (const [key, entry] of await this.subscriptions()) {
      if (entry.person !== person) continue;
      if ((await this.push(key, entry, message)).ok) sent++;
    }
    return sent;
  }

  async runCron(now = new Date()) {
    const b = berlinNow(now);
    const done = [];
    await this.runRecurring(b.day);
    // Wöchentliche automatische Sicherung (Sonntag ab 3 Uhr) in ein separates Backup-Objekt
    if (b.dow === 6 && b.hour >= 3 && !(await this.ctx.storage.get(`sent:backup:${b.day}`))) {
      await this.ctx.storage.put(`sent:backup:${b.day}`, Date.now());
      try { await this.backupStub().snapSave(b.day, await this.dumpAll()); done.push(['backup', 1]); } catch (e) { done.push(['backup', String(e)]); }
    }
    // Am 1. jedes Monats: Admin erinnern, eine Kopie herunterzuladen
    if (b.day.endsWith('-01') && b.hour >= 10 && !(await this.ctx.storage.get(`sent:backupAsk:${b.day}`))) {
      await this.ctx.storage.put(`sent:backupAsk:${b.day}`, Date.now());
      const adm = (await this.ctx.storage.get('admin')) || 'Toni';
      done.push([adm, await this.pushToPerson(adm, (l) => ({ title: pick(l)('💾 Zeit für eine Sicherung', '💾 Time for a backup', '💾 Dags för en säkerhetskopia'), body: pick(l)('Lade dir in den Einstellungen unter „Datensicherung“ eine Kopie aufs Handy. Dauert 5 Sekunden.', 'Download a copy under "Backup" in Settings. Takes 5 seconds.', 'Ladda ner en kopia under "Säkerhetskopia" i inställningarna. Tar 5 sekunder.'), url: '/#start' }))]);
    }
    // App-Umfrage: Start 18 Uhr, Erinnerung nach 4 Tagen, Report am Ende an Admin
    {
      const f = await this.feedback();
      const names = await this.names();
      if (b.day >= f.start && b.day <= f.end && b.hour >= 18 && !(await this.ctx.storage.get(`sent:feedback:${f.start}`))) {
        await this.ctx.storage.put(`sent:feedback:${f.start}`, Date.now());
        for (const p of names) done.push([p, await this.pushToPerson(p, (l) => ({ title: pick(l)('📝 Wie findest du die Zentrale?', '📝 How do you like the Zentrale?', '📝 Vad tycker du om Zentrale?'), body: pick(l)('2 Minuten Umfrage: Was gefällt dir, was fehlt? Deine Ideen machen die App besser.', '2-minute survey: what do you like, what is missing? Your ideas make the app better.', '2 minuters enkät: vad gillar du, vad saknas? Dina idéer gör appen bättre.'), url: '/#start' }))]);
      }
      const remind = addDays(f.start, 4);
      if (b.day >= remind && b.day <= f.end && b.hour >= 18 && !(await this.ctx.storage.get(`sent:feedbackRemind:${f.start}`))) {
        await this.ctx.storage.put(`sent:feedbackRemind:${f.start}`, Date.now());
        for (const p of names.filter((n) => !f.answers[n])) done.push([p, await this.pushToPerson(p, (l) => ({ title: pick(l)('📝 Kurze Erinnerung', '📝 Quick reminder', '📝 Kort påminnelse'), body: pick(l)('Die Umfrage zur Zentrale läuft noch bis ' + fmtD(f.end, 'de') + '. Dauert nur 2 Minuten!', 'The Zentrale survey is open until ' + fmtD(f.end, 'en') + '. Takes just 2 minutes!', 'Enkäten om Zentrale är öppen till ' + fmtD(f.end, 'sv') + '. Tar bara 2 minuter!'), url: '/#start' }))]);
      }
      if (b.day > f.end && !f.reported) {
        f.reported = true;
        await this.ctx.storage.put('feedback', f);
        const adm = (await this.ctx.storage.get('admin')) || 'Toni';
        const n = Object.keys(f.answers).length;
        done.push([adm, await this.pushToPerson(adm, (l) => ({ title: pick(l)('📊 App-Umfrage ist fertig', '📊 App survey is finished', '📊 Appenkäten är klar'), body: pick(l)(`${n} von ${names.length} haben geantwortet. Den Report findest du in den Einstellungen unter „App-Umfrage ansehen“.`, `${n} of ${names.length} answered. Find the report in Settings under "View app survey".`, `${n} av ${names.length} svarade. Rapporten finns i inställningarna under "Visa appenkät".`), url: '/#start' }))]);
      }
    }
    // Abgelaufene Pinnwand-Zettel samt Fotos abnehmen
    const allNotes = (await this.ctx.storage.get('board')) || [];
    const gone = allNotes.filter((n) => n.expires && n.expires < b.day);
    if (gone.length) {
      for (const n of gone) if (n.photo) await this.ctx.storage.delete(`boardphoto:${n.id}`);
      await this.ctx.storage.put('board', allNotes.filter((n) => !gone.includes(n)));
    }
    if (b.dow === SCHEDULE.weekly.dow && b.hour >= SCHEDULE.weekly.hour) {
      const monday = addDays(b.day, 1);
      const flag = `sent:weekly:${monday}`;
      if (!(await this.ctx.storage.get(flag))) {
        await this.ctx.storage.put(flag, Date.now());
        const msgs = weeklyMessages(await this.week(monday), await this.langs());
        for (const [p, m] of Object.entries(msgs)) done.push([p, await this.pushCat('plan', p, m)]);
      }
    }
    if (b.dow === SCHEDULE.friday.dow && b.hour >= SCHEDULE.friday.hour) {
      const monday = mondayOf(b.day);
      const flag = `sent:friday:${monday}`;
      if (!(await this.ctx.storage.get(flag))) {
        await this.ctx.storage.put(flag, Date.now());
        const msgs = fridayMessages(await this.week(monday), await this.langs());
        for (const [p, m] of Object.entries(msgs)) done.push([p, await this.pushCat('plan', p, m)]);
      }
    }
    if (b.dow === SCHEDULE.cleanerAsk.dow && b.hour >= SCHEDULE.cleanerAsk.hour) {
      const monday = mondayOf(b.day);
      const flag = `sent:cleanerAsk:${monday}`;
      const contact = await this.cleanerContact();
      if (contact && !(await this.ctx.storage.get(flag))) {
        await this.ctx.storage.put(flag, Date.now());
        const week = await this.week(monday);
        if (week.cleaner && !week.cleanerConfirmed) {
          done.push([contact, await this.pushCat('cleaner', contact, cleanerAskMessage(week, contact, (await this.langs())[contact]))]);
        }
      }
    }
    if (b.hour >= SCHEDULE.birthday.hour) {
      const names = await this.names();
      for (const m of (await this.members()).filter((x) => names.includes(x.name) && x.birthday && x.birthday.slice(5) === b.day.slice(5))) {
        const flag = `sent:birthday:${m.name}:${b.day}`;
        if (await this.ctx.storage.get(flag)) continue;
        await this.ctx.storage.put(flag, Date.now());
        const pron = { w: ['ihr', 'her'], m: ['ihm', 'him'] }[m.gender] || [m.name, m.name];
        for (const p of names) {
          if (p === m.name) {
            done.push([p, await this.pushToPerson(p, (l) => (l === 'en'
              ? { title: '🎁 Happy birthday!', body: `All the best, ${p}! Happy birthday from your Zentrale 🎂🎉` }
              : l === 'sv' ? { title: '🎁 Grattis på födelsedagen!', body: `Allt gott, ${p}! Grattis på födelsedagen från din Zentrale 🎂🎉` }
              : { title: '🎁 Alles Gute!', body: `Alles Gute zum Geburtstag, ${p}! Deine Zentrale wünscht dir einen wunderschönen Tag 🎂🎉` }))]);
          } else {
            done.push([p, await this.pushCat('people', p, (l) => (l === 'en'
              ? { title: `🎂 ${m.name}'s birthday`, body: `Today is ${m.name}'s birthday! Don't forget to wish ${pron[1]} a happy birthday 🎉` }
              : l === 'sv' ? { title: `🎂 ${m.name} fyller år`, body: `I dag fyller ${m.name} år! Glöm inte att gratulera 🎉` }
              : { title: `🎂 ${m.name} hat Geburtstag`, body: `Heute hat ${m.name} Geburtstag! Vergiss nicht, ${pron[0]} zu gratulieren 🎉` }))]);
          }
        }
      }
    }
    if (b.hour >= SCHEDULE.meetingPrep.hour) {
      const tomorrow = addDays(b.day, 1);
      for (const ev of await this.events()) {
        if (ev.type !== 'meeting' || ev.from !== tomorrow) continue;
        const flag = `sent:meetingPrep:${ev.id}:${ev.from}`;
        if (await this.ctx.storage.get(flag)) continue;
        await this.ctx.storage.put(flag, Date.now());
        for (const [p, m] of Object.entries(meetingPrepMessages(ev, await this.langs()))) done.push([p, await this.pushCat('cal', p, m)]);
      }
    }
    return done;
  }
}

const stub = (env) => env.PUTZPLAN.get(env.PUTZPLAN.idFromName('wg'));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      // Gastansicht: Anfragen gehen an eine eigene Kopie, die echten Daten bleiben unberührt
      const g = request.headers.get('x-guest') || /(?:^|;\s*)guest=(g[0-9a-f]{32})/.exec(request.headers.get('cookie') || '')?.[1];
      if (GUEST_MODE && g && /^g[0-9a-f]{32}$/.test(g)) {
        const gs = env.PUTZPLAN.get(env.PUTZPLAN.idFromName(`guest:${g}`));
        await gs.guestInit();
        return gs.fetch(request);
      }
      return stub(env).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(stub(env).runCron(new Date(event.scheduledTime)));
  },
};

