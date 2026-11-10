import { DurableObject } from 'cloudflare:workers';
import { computeWeek, simulate, mondayOf, addDays, berlinNow, INITIAL_MEMBERS, CYCLE_START } from './plan.js';
import { weeklyMessages, fridayMessages, ausfallMessages, cleanerAskMessage, cleanerVisitMessages, meetingPrepMessages, dayLabel } from './messages.js';
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
const pick = (lang) => (de, en) => (lang === 'en' ? en : de);

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

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
    return Object.fromEntries((await this.members()).map((m) => [m.name, m.lang === 'en' ? 'en' : 'de']));
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

    if (path === '/weeks' && request.method === 'GET') {
      const current = mondayOf(berlinNow().day);
      const from = validMonday(url.searchParams.get('from')) ? url.searchParams.get('from') : addDays(current, -7);
      const count = Math.min(Math.max(Number(url.searchParams.get('count')) || 12, 1), 30);
      const weeks = await this.weeks([...Array(count)].map((_, i) => addDays(from, i * 7)));
      return json({ people: PEOPLE, members: await this.members(), absences: await this.absences(), events: await this.events(), polls: await this.polls(), surveys: await this.surveys(), cleanerContact: await this.cleanerContact(), current, today: berlinNow().day, weeks });
    }

    if (path === '/check' && request.method === 'POST') {
      const { monday, key, done, by } = body;
      if (!validMonday(monday) || typeof key !== 'string' || key.length > 60) return json({ error: 'bad request' }, 400);
      const k = `check:${monday}:${key}`;
      if (done) await this.ctx.storage.put(k, { by: PEOPLE.includes(by) ? by : null, at: Date.now() });
      else await this.ctx.storage.delete(k);
      return json(await this.week(monday));
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
        for (const [p, m] of Object.entries(ausfallMessages(week, await this.langs()))) await this.pushToPerson(p, m);
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
      for (const [p, m] of Object.entries(cleanerVisitMessages(week, PEOPLE.includes(by) ? by : null, await this.langs()))) await this.pushToPerson(p, m);
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
      const when = (l) => `${fmtD(date, l)}${time ? `${l === 'en' ? ' at' : ' um'} ${time}` : ''}`;
      for (const p of PEOPLE) {
        if (p === by) continue;
        await this.pushToPerson(p, (l) => {
          const L = pick(l);
          const head = fromDay && fromDay !== date
            ? L(`Die Putzkraft kommt nicht am ${fmtD(fromDay)}, sondern am ${when(l)}.`, `The cleaner is not coming on ${fmtD(fromDay, 'en')} but on ${when(l)}.`)
            : fromDay ? L(`Die Putzkraft kommt am ${when(l)}.`, `The cleaner comes on ${when(l)}.`)
              : L(`Zusätzlicher Termin: Die Putzkraft kommt am ${when(l)}.`, `Extra visit: the cleaner comes on ${when(l)}.`);
          return { title: L('Putzkraft-Termin 🧹', 'Cleaner appointment 🧹'), body: `${head} ${L('Der Putzplan ist angepasst.', 'The cleaning rota has been updated.')}${by ? L(` (von ${by})`, ` (by ${by})`) : ''}`, url: '/#plan' };
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
        body: L(`Hallo ${entry.person}, die Erinnerungen funktionieren!`, `Hi ${entry.person}, notifications are working!`),
      });
      return json(r, r.ok ? 200 : 502);
    }

    const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    // ---------- Mitglieder ----------
    if (path === '/members/join' && request.method === 'POST') {
      const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ').slice(0, 20) : '';
      const side = body.side === 'hinten' ? 'hinten' : body.side === 'vorne' ? 'vorne' : null;
      if (!name || !side) return json({ error: 'Bitte Namen und Zimmer (vorne/hinten) angeben.' }, 400);
      const members = await this.members();
      if (members.some((m) => m.name.toLowerCase() === name.toLowerCase() && (!m.until || m.until > mondayOf(berlinNow().day)))) {
        return json({ error: `${name} gibt es schon. Nimm z.B. noch den ersten Buchstaben vom Nachnamen dazu.` }, 400);
      }
      // Ab nächstem Montag im Putzplan, die laufende Woche bleibt, wie sie ist
      const since = addDays(mondayOf(berlinNow().day), 7);
      const rest = members.filter((m) => !(m.name.toLowerCase() === name.toLowerCase()));
      const lang = body.lang === 'en' ? 'en' : 'de';
      const prof = this.checkProfile(body);
      if (prof.error) return json({ error: prof.error }, 400);
      const photo = await this.savePhoto(name, body.photo || undefined);
      await this.ctx.storage.put('members', [...rest, { name, side, since, until: null, lang, ...prof.fields, ...(photo ? { photo } : {}) }]);
      const g = prof.fields.gender;
      for (const p of PEOPLE) {
        if (p === name) continue;
        await this.pushToPerson(p, (l) => (l === 'en'
          ? { title: '🎉 New flatmate', body: `${name} has joined the flat (${side === 'vorne' ? 'front' : 'back'} room) and is on the cleaning rota from ${fmtD(since, 'en')}. Say hi!`, url: '/#start' }
          : { title: `🎉 ${g === 'w' ? 'Neue Mitbewohnerin' : g === 'm' ? 'Neuer Mitbewohner' : 'Neu in der WG'}`, body: `${name} ist neu in der WG (Zimmer ${side}) und ab ${fmtD(since)} im Putzplan. Sag hallo!`, url: '/#start' }));
      }
      return json({ ok: true, name, since, members: await this.members() });
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
    if (path.startsWith('/photo/') && request.method === 'GET') {
      const data = await this.ctx.storage.get(`photo:${decodeURIComponent(path.slice(7))}`);
      if (!data) return new Response('not found', { status: 404 });
      const [head, b64] = data.split(',');
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return new Response(bytes, { headers: { 'content-type': head.slice(5, head.indexOf(';')), 'cache-control': 'public, max-age=31536000, immutable' } });
    }
    if (path === '/members/lang' && request.method === 'POST') {
      const members = await this.members();
      if (!members.some((m) => m.name === body.name)) return json({ error: 'Mitglied nicht gefunden.' }, 404);
      const lang = body.lang === 'en' ? 'en' : 'de';
      await this.ctx.storage.put('members', members.map((m) => (m.name === body.name ? { ...m, lang } : m)));
      return json({ ok: true, members: await this.members() });
    }
    if (path === '/members/leave' && request.method === 'POST') {
      const members = await this.members();
      const m = members.find((x) => x.name === body.name && !x.until);
      if (!m) return json({ error: 'Mitglied nicht gefunden.' }, 404);
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
    const rid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
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
      const when = (lang) => `${fmtD(from, lang)}${to !== from ? ` – ${fmtD(to, lang)}` : ''}${ev.time ? `${lang === 'en' ? ' at' : ' um'} ${ev.time}` : ''}`;
      for (const p of participants) {
        if (p.name === by) continue;
        if (type === 'urlaub') {
          await this.pushToPerson(p.name, (lang) => {
            const L = pick(lang);
            return {
              title: L('Urlaub bestätigen? 🏖️', 'Confirm holiday? 🏖️'),
              body: L(`${by || 'Jemand'} hat dich beim Urlaub ${ev.title ? `„${ev.title}“ ` : ''}${when(lang)} eingetragen. Bitte in der Zentrale bestätigen.`,
                `${by || 'Someone'} added you to the holiday ${ev.title ? `"${ev.title}" ` : ''}${when(lang)}. Please confirm in the app.`),
              url: '/#kalender',
            };
          });
        } else {
          await this.pushToPerson(p.name, (lang) => {
            const L = pick(lang);
            return {
              title: `${type === 'meeting' ? '🗣️ ' : '📅 '}${ev.title || (lang === 'en' ? { meeting: 'Flat meeting', sonstiges: 'Event' }[type] : label(type))}`,
              body: L(`Neuer Termin: ${when(lang)}${by ? ` (von ${by})` : ''}.`, `New event: ${when(lang)}${by ? ` (from ${by})` : ''}.`),
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
          await this.pushToPerson(p, (lang) => {
            const L = pick(lang);
            return {
              title: L('🗳️ WG-Meeting: wann passt es dir?', '🗳️ Flat meeting: when suits you?'),
              body: L(`${by || 'Jemand'} wünscht sich ein Meeting${poll.title !== 'WG-Meeting' ? ` („${poll.title}“)` : ''}. Stimm in der Zentrale ab.`,
                `${by || 'Someone'} would like a meeting${poll.title !== 'WG-Meeting' ? ` ("${poll.title}")` : ''}. Vote in the app.`),
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
        await this.pushToPerson(p, (lang) => (lang === 'en'
          ? { title: '🗣️ Flat meeting is set', body: `${poll.title === 'WG-Meeting' ? 'Flat meeting' : poll.title}: ${fmtD(opt.date, 'en')} at ${opt.time}. See you then!`, url: '/#kalender' }
          : { title: '🗣️ WG-Meeting steht fest', body: `${poll.title}: ${fmtD(opt.date)} um ${opt.time} Uhr. Bis dann!`, url: '/#kalender' }));
      }
      return calState();
    }
    // ---------- Umfragen (Übersicht) ----------
    if (path.startsWith('/surveys/') && request.method === 'POST') {
      const list = await this.surveys();
      const save = async () => { await this.ctx.storage.put('surveys', list.slice(-40)); return json({ surveys: list.slice(-40) }); };
      const by = PEOPLE.includes(body.by) ? body.by : null;
      if (path === '/surveys/add') {
        const question = str(body.question, 200);
        const opts = (Array.isArray(body.options) ? body.options : []).map((o) => str(o, 80)).filter(Boolean).slice(0, 10);
        if (!question) return json({ error: 'Bitte eine Frage eingeben.' }, 400);
        if (opts.length < 2) return json({ error: 'Bitte mindestens zwei Antworten angeben.' }, 400);
        const s = { id: rid(), question, options: opts.map((t) => ({ id: rid() + Math.random().toString(36).slice(2, 5), text: t })), multi: !!body.multi, by, votes: {}, status: 'open', at: Date.now() };
        list.push(s);
        for (const p of PEOPLE) {
          if (p === by) continue;
          await this.pushToPerson(p, (l) => (l === 'en'
            ? { title: `🗳️ Poll${by ? ` from ${by}` : ''}`, body: `${question} Tap to answer.`, url: '/#start' }
            : { title: `🗳️ Umfrage${by ? ` von ${by}` : ''}`, body: `${question} Tipp hier, um abzustimmen.`, url: '/#start' }));
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
            return `${o.text}: ${who.length ? who.join(', ') : '–'}`;
          }).join(' · ');
          await this.pushToPerson(s.by, (l) => (l === 'en'
            ? { title: '✅ Everyone has answered', body: `"${s.question}" ${result(l)}`, url: '/#start' }
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
        // Optional direkt als Ausgabe in die WG-Kasse
        const amount = parseEuro(body.price);
        if (amount && PEOPLE.includes(body.by)) {
          await this.addExpense({ desc: item.name, amount, currency: 'EUR', paidBy: body.by, mode: 'equal', parts: computeParts(amount, 'equal', PEOPLE, PEOPLE).parts, split: PEOPLE, by: body.by });
        }
      }
      return json(await this.shop());
    }

    // ---------- WG-Kasse ----------
    if (path === '/money' && request.method === 'GET') {
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
      await this.addExpense({
        desc, amount, currency, paidBy: body.paidBy, mode, parts, split: Object.keys(parts), kind,
        by: PEOPLE.includes(body.by) ? body.by : null,
      });
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
    if (path === '/money/delete' && request.method === 'POST') {
      await this.ctx.storage.delete(`exp:${str(body.id, 40)}`);
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
  async pushToPerson(person, message) {
    if (typeof message === 'function') message = message((await this.langs())[person] || 'de');
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
    if (b.dow === SCHEDULE.weekly.dow && b.hour >= SCHEDULE.weekly.hour) {
      const monday = addDays(b.day, 1);
      const flag = `sent:weekly:${monday}`;
      if (!(await this.ctx.storage.get(flag))) {
        await this.ctx.storage.put(flag, Date.now());
        const msgs = weeklyMessages(await this.week(monday), await this.langs());
        for (const [p, m] of Object.entries(msgs)) done.push([p, await this.pushToPerson(p, m)]);
      }
    }
    if (b.dow === SCHEDULE.friday.dow && b.hour >= SCHEDULE.friday.hour) {
      const monday = mondayOf(b.day);
      const flag = `sent:friday:${monday}`;
      if (!(await this.ctx.storage.get(flag))) {
        await this.ctx.storage.put(flag, Date.now());
        const msgs = fridayMessages(await this.week(monday), await this.langs());
        for (const [p, m] of Object.entries(msgs)) done.push([p, await this.pushToPerson(p, m)]);
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
          done.push([contact, await this.pushToPerson(contact, cleanerAskMessage(week, contact, (await this.langs())[contact]))]);
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
              ? { title: '🎂 Happy birthday!', body: `Happy birthday, ${p}! The whole flat wishes you a wonderful day 🎉` }
              : { title: '🎂 Alles Gute!', body: `Alles Liebe zum Geburtstag, ${p}! Die ganze WG wünscht dir einen wunderschönen Tag 🎉` }))]);
          } else {
            done.push([p, await this.pushToPerson(p, (l) => (l === 'en'
              ? { title: `🎂 ${m.name}'s birthday`, body: `Today is ${m.name}'s birthday! Don't forget to wish ${pron[1]} a happy birthday 🎉` }
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
        for (const [p, m] of Object.entries(meetingPrepMessages(ev, await this.langs()))) done.push([p, await this.pushToPerson(p, m)]);
      }
    }
    return done;
  }
}

const stub = (env) => env.PUTZPLAN.get(env.PUTZPLAN.idFromName('wg'));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return stub(env).fetch(request);
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(stub(env).runCron(new Date(event.scheduledTime)));
  },
};

