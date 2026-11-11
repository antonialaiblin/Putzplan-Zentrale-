// Putzplan-Logik: wer ist in welcher Woche dran?
// Grundlage: "Mission Haussegen" (Stand 03.11.2026). Der ganze Plan läuft in
// einem 10-Wochen-Zyklus, der am Montag, 09.11.2026 beginnt, und fängt danach
// wieder von oben an.

export const PEOPLE = ['Simon', 'Leo', 'Toni', 'Johanna', 'Mo'];

export const CYCLE_START = '2026-11-09'; // Montag der ersten Zyklus-Woche

// Wochendienst, Woche 1-10 des Zyklus
const WOCHENDIENST = ['Simon', 'Leo', 'Toni', 'Johanna', 'Mo', 'Simon', 'Leo', 'Toni', 'Johanna', 'Mo'];
// Baddienst, je 2 Wochen (Zeitraum 1-5 des Zyklus)
const BAD_VORNE = ['Mo', 'Simon', 'Leo', 'Mo', 'Simon'];
const BAD_HINTEN = ['Toni', 'Johanna', 'Toni', 'Johanna', 'Toni'];

const DAY = 86400000;

// ---------- Datums-Helfer (alles als UTC-Mitternacht "YYYY-MM-DD") ----------
export function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
export function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}
export function addDays(s, n) {
  return fmtDate(new Date(parseDate(s).getTime() + n * DAY));
}
export function mondayOf(s) {
  const d = parseDate(s);
  const dow = (d.getUTCDay() + 6) % 7; // Mo=0 … So=6
  return addDays(s, -dow);
}
/** Datum, Wochentag (Mo=0) und Stunde in Berlin für einen Zeitpunkt. */
export function berlinNow(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', hourCycle: 'h23', weekday: 'short',
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday);
  return { day, dow, hour: Number(parts.hour) };
}
function weekIndex(monday) {
  return Math.round((parseDate(monday) - parseDate(CYCLE_START)) / (7 * DAY));
}
const mod = (a, n) => ((a % n) + n) % n;

const WOCHE_ITEMS = [
  { id: 'muell', short: 'Müll', label: 'Müll leeren (Rest, Bio, Papier, Gelber Sack), sobald voll, neue Tüten rein' },
  { id: 'pfand', short: 'Pfand + Altglas', label: 'Pfand + Altglas wegbringen' },
  { id: 'verbrauch', short: 'Verbrauchsmaterial', label: 'Küchen-Verbrauchsmaterial checken: Spülbürste, Handseife, Spüli, Lappen, Tabs' },
  { id: 'handtuecher', short: 'Küchenhandtücher waschen', label: 'Küchenhandtücher und Lappen waschen (60/90 Grad)' },
];
const WOCHE_EXTRA = [
  { id: 'kueche', short: 'Küche putzen', label: 'Küche: Arbeitsflächen, Herd, Spüle, Tisch, Unterschränke außen, Boden saugen (Ofen bei Bedarf)' },
  { id: 'flure', short: 'Eingang + Flure', label: 'Eingang + 2 Flure saugen, Schuhe/Kram ordnen' },
];
const BAD_UMFANG = 'Klo, Waschbecken, Dusche/Wanne, Spiegel, Boden saugen, Handtücher checken';

// ---------- Mitglieder & automatische Rotation ----------
// Startbesetzung laut "Mission Haussegen". Die Reihenfolgen ergeben genau die Tabellen
// aus dem Dokument; danach läuft alles als faire Warteschlange weiter.
export const INITIAL_MEMBERS = [
  { name: 'Simon', side: 'vorne' },
  { name: 'Leo', side: 'vorne' },
  { name: 'Toni', side: 'hinten' },
  { name: 'Johanna', side: 'hinten' },
  { name: 'Mo', side: 'vorne' },
].map((m) => ({ ...m, since: CYCLE_START, until: null }));
const INITIAL_QUEUES = {
  woche: ['Mo', 'Leo', 'Toni', 'Johanna', 'Simon'],
  vorne: ['Mo', 'Simon', 'Leo'],
  hinten: ['Toni', 'Johanna'],
};
export const ABSENT_MIN_DAYS = 7; // nur wer die ganze Woche (Mo–So) weg ist, wird übersprungen

/** An wie vielen Tagen (Mo–So) ist die Person in dieser Woche weg? */
export function daysAway(name, monday, absences) {
  let days = 0;
  for (let i = 0; i < 7; i++) {
    const d = addDays(monday, i);
    if (absences.some((a) => a.person === name && a.from <= d && a.to >= d)) days++;
  }
  return days;
}

function takeNext(queue, ok, fallback = true) {
  if (!queue.length) return null;
  let i = queue.findIndex(ok);
  if (i < 0 && !fallback) return null; // z.B. ganze Bad-Seite im Urlaub: dann putzt niemand
  if (i < 0) i = 0;
  const [n] = queue.splice(i, 1);
  queue.push(n);
  return n;
}

/**
 * Spielt den Plan Woche für Woche ab Zyklusstart durch.
 * Wer im Urlaub ist, wird übersprungen und ist danach als Erstes wieder dran.
 * Neue Mitglieder kommen hinten in die Warteschlange, Ausgezogene fliegen raus.
 * Nach einem Putzkraft-Ausfall wiederholt die Folgewoche die Besetzung (Plan rutscht eine Woche).
 */
export function simulate(ctx = {}, until) {
  const members = ctx.members || INITIAL_MEMBERS;
  const ausfaelle = ctx.ausfaelle || [];
  const absences = ctx.absences || [];
  // Umbenannte Mitglieder behalten ihren Platz in der Start-Reihenfolge
  const rn = (n) => { for (const r of ctx.renames || []) if (r.from === n) n = r.to; return n; };
  const q = { woche: INITIAL_QUEUES.woche.map(rn), vorne: INITIAL_QUEUES.vorne.map(rn), hinten: INITIAL_QUEUES.hinten.map(rn) };
  const out = new Map();
  let prev = null;
  let bath = { vorne: null, hinten: null };
  for (let m = CYCLE_START; m <= until; m = addDays(m, 7)) {
    const active = members.filter((x) => x.since <= m && (!x.until || x.until > m));
    const names = active.map((x) => x.name);
    for (const key of ['woche', 'vorne', 'hinten']) {
      const fits = (n) => names.includes(n) && (key === 'woche' || active.find((x) => x.name === n).side === key);
      q[key] = q[key].filter(fits);
      for (const n of names) if (fits(n) && !q[key].includes(n)) q[key].push(n);
    }
    const away = (n) => daysAway(n, m, absences) >= ABSENT_MIN_DAYS;
    const shift = ausfaelle.filter((a) => a < m).length;
    const e = weekIndex(m) - shift;
    let a;
    if (prev && e === prev.e) {
      a = { ...prev }; // Woche nach Putzkraft-Ausfall: alles eine Woche später
    } else {
      const woche = takeNext(q.woche, (n) => !away(n));
      for (const side of ['vorne', 'hinten']) {
        const gone = bath[side] && !names.includes(bath[side]);
        if (e % 2 === 0 || gone || !bath[side]) bath[side] = takeNext(q[side], (n) => !away(n) && n !== woche, !q[side].every((n) => away(n)));
      }
      a = { woche, vorne: bath.vorne, hinten: bath.hinten };
    }
    a = { ...a, e, shift, people: names, away: names.filter(away) };
    out.set(m, a);
    prev = a;
  }
  return out;
}

/** Besetzung vor dem Zyklusstart (nur für die Anzeige der Vorwoche). */
function legacyAssignment(monday) {
  const cyc = mod(weekIndex(monday), 10);
  const period = Math.floor(cyc / 2);
  return {
    woche: WOCHENDIENST[cyc], vorne: BAD_VORNE[period], hinten: BAD_HINTEN[period],
    e: weekIndex(monday), shift: 0, people: PEOPLE, away: [],
  };
}

/**
 * Berechnet eine Woche.
 * @param {string} monday  "YYYY-MM-DD" eines Montags
 * @param {object} ov      Änderungen: { swaps: {"woche": "Leo", ...}, ausfall: true }
 * @param {object|string[]} ctx  { members, ausfaelle, absences, plan (Map aus simulate) } oder nur die Ausfall-Liste
 */
export function computeWeek(monday, ov = {}, ctx = {}) {
  if (Array.isArray(ctx)) ctx = { ausfaelle: ctx };
  const asg = monday < CYCLE_START ? legacyAssignment(monday) : (ctx.plan || simulate(ctx, monday)).get(monday);
  const { e, shift } = asg;
  const plannedCleaner = mod(e, 2) === 1;
  const ausfall = plannedCleaner && !!ov.ausfall;
  const sunday = addDays(monday, 6);
  // In eine andere Woche verschoben (ohne dass der Plan rutscht)?
  const movedTo = plannedCleaner && !ausfall && ov.movedTo ? ov.movedTo : null;
  const regular = plannedCleaner && !ausfall && !movedTo;
  // Zusätzlicher (oder hierher verschobener) Termin in einer Woche ohne Putzkraft
  const extra = !regular && ov.extra && ov.extra.date >= monday && ov.extra.date <= sunday ? ov.extra : null;
  const cleaner = regular || !!extra;
  const swaps = ov.swaps || {};
  const gifts = ov.gifts || {};

  const tasks = [];

  // Wochendienst
  const wItems = [...WOCHE_ITEMS];
  // Spülbürste mind. 1x im Monat neu: in der Woche, in der der Monatserste liegt
  const firstOfMonth = [0, 1, 2, 3, 4, 5, 6].map((n) => addDays(monday, n)).find((d) => d.endsWith('-01'));
  if (firstOfMonth) wItems.push({ id: 'spuelbuerste', short: 'Neue Spülbürste', label: 'Neue Spülbürste kaufen (Monatswechsel)' });
  if (!cleaner) wItems.push(...WOCHE_EXTRA);
  if (asg.woche) {
    tasks.push({ key: 'woche', title: 'Wochendienst', person: swaps.woche || asg.woche, planned: asg.woche, gift: !!(gifts.woche && swaps.woche), items: wItems });
  }

  // Bäder: geputzt wird in der Woche ohne Putzkraft, Klopapier gilt beide Wochen
  const bathCleaning = !cleaner;
  for (const [key, title, side] of [
    ['bad-vorne', 'Vorderes Bad + extra Klo', 'vorne'],
    ['bad-hinten', 'Hinteres Bad', 'hinten'],
  ]) {
    if (!asg[side]) continue;
    tasks.push({
      key,
      title,
      person: swaps[key] || asg[side],
      planned: asg[side],
      gift: !!(gifts[key] && swaps[key]),
      note: bathCleaning
        ? `${BAD_UMFANG}. Außerdem 2 Wochen lang fürs Klopapier zuständig.`
        : 'Putzkraft-Woche: nur Klopapier checken und bei Bedarf kaufen.',
      cleaningWeek: bathCleaning,
      items: bathCleaning ? [{ id: 'putzen', short: `${title} putzen`, label: `${title} putzen` }] : [],
    });
  }

  // Kühlschrank: bis zum letzten Sonntag des Monats
  const nextSunday = addDays(sunday, 7);
  if (nextSunday.slice(5, 7) !== sunday.slice(5, 7)) {
    tasks.push({
      key: 'kuehlschrank',
      title: 'Kühlschrank (Monatsende)',
      person: null, // alle
      note: 'Bis Sonntag eigenes Fach putzen und Abgelaufenes wegwerfen.',
      items: asg.people.filter((p) => !asg.away.includes(p)).map((p) => ({ id: p, short: 'Kühlschrankfach', label: p, person: p })),
    });
  }

  return {
    monday,
    sunday,
    cycleWeek: mod(e, 10) + 1,
    shift,
    people: asg.people,
    away: asg.away,
    plannedCleaner,
    ausfall,
    cleaner,
    // Standard Mittwoch; die/der Zuständige kann Tag und Uhrzeit für die Woche ändern
    cleanerDay: extra ? extra.date : plannedCleaner ? (ov.cleanerDate && ov.cleanerDate >= monday && ov.cleanerDate <= sunday ? ov.cleanerDate : addDays(monday, 2)) : null,
    cleanerTime: extra ? extra.time || '' : plannedCleaner && ov.cleanerTime ? ov.cleanerTime : '',
    cleanerConfirmed: extra ? true : plannedCleaner && !!ov.cleanerConfirmed,
    extra: !!extra,
    extraFrom: extra?.from || null,
    movedTo,
    tasks,
  };
}

/** Alle Punkte einer Person in einer Woche: [{task, item, checkKey}] */
export function itemsFor(week, person) {
  const out = [];
  for (const t of week.tasks) {
    for (const it of t.items) {
      const owner = it.person || t.person;
      if (owner === person) out.push({ task: t, item: it, checkKey: `${t.key}:${it.id}` });
    }
  }
  return out;
}
