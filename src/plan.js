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

/**
 * Berechnet eine Woche.
 * @param {string} monday  "YYYY-MM-DD" eines Montags
 * @param {object} ov      Änderungen: { swaps: {"woche": "Leo", ...}, ausfall: true }
 */
export function computeWeek(monday, ov = {}) {
  const idx = weekIndex(monday);
  const cyc = mod(idx, 10);
  const plannedCleaner = cyc % 2 === 1;
  const ausfall = plannedCleaner && !!ov.ausfall;
  const cleaner = plannedCleaner && !ausfall;
  const period = Math.floor(cyc / 2);
  const swaps = ov.swaps || {};
  const sunday = addDays(monday, 6);

  const tasks = [];

  // Wochendienst
  const wItems = [...WOCHE_ITEMS];
  // Spülbürste mind. 1x im Monat neu: in der Woche, in der der Monatserste liegt
  const firstOfMonth = [0, 1, 2, 3, 4, 5, 6].map((n) => addDays(monday, n)).find((d) => d.endsWith('-01'));
  if (firstOfMonth) wItems.push({ id: 'spuelbuerste', short: 'Neue Spülbürste', label: 'Neue Spülbürste kaufen (Monatswechsel)' });
  if (!cleaner) wItems.push(...WOCHE_EXTRA);
  tasks.push({
    key: 'woche',
    title: 'Wochendienst',
    person: swaps.woche || WOCHENDIENST[cyc],
    planned: WOCHENDIENST[cyc],
    items: wItems,
  });

  // Bäder: geputzt wird in der Woche ohne Putzkraft, Klopapier gilt beide Wochen
  const bathCleaning = !cleaner;
  for (const [key, title, list] of [
    ['bad-vorne', 'Vorderes Bad + extra Klo', BAD_VORNE],
    ['bad-hinten', 'Hinteres Bad', BAD_HINTEN],
  ]) {
    tasks.push({
      key,
      title,
      person: swaps[key] || list[period],
      planned: list[period],
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
      items: PEOPLE.map((p) => ({ id: p, short: 'Kühlschrankfach', label: p, person: p })),
    });
  }

  return {
    monday,
    sunday,
    cycleWeek: cyc + 1,
    plannedCleaner,
    ausfall,
    cleaner,
    cleanerDay: plannedCleaner ? addDays(monday, 2) : null, // Mittwoch
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
