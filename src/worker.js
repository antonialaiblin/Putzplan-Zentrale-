import { DurableObject } from 'cloudflare:workers';
import { computeWeek, simulate, mondayOf, addDays, berlinNow, INITIAL_MEMBERS, CYCLE_START } from './plan.js';
import { weeklyMessages, fridayMessages, ausfallMessages } from './messages.js';
import { generateVapidKeys, vapidPublicRaw, sendPush } from './webpush.js';
import { balancesByCurrency, peopleIn, parseSplitwise, computeParts, parseAmount, parseEuro, CURRENCIES, SHOP_CATEGORIES } from './money.js';

// Wann werden Erinnerungen verschickt? (Berliner Zeit, Mo=0 … So=6)
export const SCHEDULE = {
  weekly: { dow: 6, hour: 19 }, // Sonntag 19 Uhr: Plan für die kommende Woche
  friday: { dow: 4, hour: 18 }, // Freitag 18 Uhr: Erinnerung an offene Aufgaben
};

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
  async absences() {
    return (await this.ctx.storage.get('absences')) || [];
  }
  /** Alle, die gerade wohnen oder schon zugesagt haben (noch nicht ausgezogen). */
  async names() {
    const now = mondayOf(berlinNow().day);
    return (await this.members()).filter((m) => !m.until || m.until > now).map((m) => m.name);
  }
  async planCtx() {
    return { members: await this.members(), absences: await this.absences(), ausfaelle: (await this.ctx.storage.get('ausfaelle')) || [] };
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

    if (path === '/weeks' && request.method === 'GET') {
      const current = mondayOf(berlinNow().day);
      const from = validMonday(url.searchParams.get('from')) ? url.searchParams.get('from') : addDays(current, -7);
      const count = Math.min(Math.max(Number(url.searchParams.get('count')) || 12, 1), 30);
      const weeks = await this.weeks([...Array(count)].map((_, i) => addDays(from, i * 7)));
      return json({ people: PEOPLE, members: await this.members(), absences: await this.absences(), current, today: berlinNow().day, weeks });
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
        for (const [p, m] of Object.entries(ausfallMessages(week))) await this.pushToPerson(p, m);
      }
      return json(week);
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
      const r = await this.push(`sub:${await sha(body.endpoint)}`, entry, {
        title: 'Zentrale 🧽',
        body: `Hallo ${entry.person}, die Erinnerungen funktionieren!`,
      });
      return json(r, r.ok ? 200 : 502);
    }

    // ---------- Mitglieder ----------
    const isDay = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
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
      await this.ctx.storage.put('members', [...rest, { name, side, since, until: null }]);
      return json({ ok: true, name, since, members: await this.members() });
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

    // ---------- Abwesenheiten (Urlaub) ----------
    if (path === '/absences/add' && request.method === 'POST') {
      const { person, from, to } = body;
      if (!PEOPLE.includes(person) || !isDay(from) || !isDay(to) || to < from) return json({ error: 'Bitte Person, Von und Bis angeben.' }, 400);
      const list = await this.absences();
      list.push({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, person, from, to, note: typeof body.note === 'string' ? body.note.trim().slice(0, 60) : '' });
      list.sort((a, b) => (a.from < b.from ? -1 : 1));
      await this.ctx.storage.put('absences', list);
      return json({ absences: list });
    }
    if (path === '/absences/delete' && request.method === 'POST') {
      const list = (await this.absences()).filter((a) => a.id !== body.id);
      await this.ctx.storage.put('absences', list);
      return json({ absences: list });
    }

    // ---------- Einkaufsliste ----------
    const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
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
  async pushToPerson(person, message) {
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
        const msgs = weeklyMessages(await this.week(monday));
        for (const [p, m] of Object.entries(msgs)) done.push([p, await this.pushToPerson(p, m)]);
      }
    }
    if (b.dow === SCHEDULE.friday.dow && b.hour >= SCHEDULE.friday.hour) {
      const monday = mondayOf(b.day);
      const flag = `sent:friday:${monday}`;
      if (!(await this.ctx.storage.get(flag))) {
        await this.ctx.storage.put(flag, Date.now());
        const msgs = fridayMessages(await this.week(monday));
        for (const [p, m] of Object.entries(msgs)) done.push([p, await this.pushToPerson(p, m)]);
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

