// Feiertage in Berlin.
// legal: gesetzlicher Feiertag in Berlin (frei, Geschäfte zu).
// Sonst: Feiertag/besonderer Tag, an dem in Berlin normal geöffnet ist.

const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const plus = (s, n) => {
  const d = new Date(`${s}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Ostersonntag (Gauß/Meeus) */
function easter(y) {
  const a = y % 19; const b = Math.floor(y / 100); const c = y % 100;
  const d = Math.floor(b / 4); const e = b % 4; const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3); const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4); const k = c % 4; const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(y, month, day);
}

const cache = new Map();
export function berlinHolidays(y) {
  if (cache.has(y)) return cache.get(y);
  const os = easter(y);
  // Buß- und Bettag: Mittwoch vor dem 23. November
  const nov23 = new Date(Date.UTC(y, 10, 23));
  const bussDiff = ((nov23.getUTCDay() - 3 + 7) % 7) || 7;
  const list = [
    { date: iso(y, 1, 1), de: 'Neujahr', en: "New Year's Day", sv: 'Nyårsdagen', legal: true },
    { date: iso(y, 1, 6), de: 'Heilige Drei Könige', en: 'Epiphany', sv: 'Trettondedag jul' },
    { date: iso(y, 3, 8), de: 'Frauentag', en: "International Women's Day", sv: 'Internationella kvinnodagen', legal: true },
    { date: plus(os, -3), de: 'Gründonnerstag', en: 'Maundy Thursday', sv: 'Skärtorsdagen' },
    { date: plus(os, -2), de: 'Karfreitag', en: 'Good Friday', sv: 'Långfredagen', legal: true },
    { date: os, de: 'Ostersonntag', en: 'Easter Sunday', sv: 'Påskdagen', sunday: true },
    { date: plus(os, 1), de: 'Ostermontag', en: 'Easter Monday', sv: 'Annandag påsk', legal: true },
    { date: iso(y, 5, 1), de: 'Tag der Arbeit', en: 'Labour Day', sv: 'Första maj', legal: true },
    { date: plus(os, 39), de: 'Christi Himmelfahrt', en: 'Ascension Day', sv: 'Kristi himmelsfärdsdag', legal: true },
    { date: plus(os, 49), de: 'Pfingstsonntag', en: 'Whit Sunday', sv: 'Pingstdagen', sunday: true },
    { date: plus(os, 50), de: 'Pfingstmontag', en: 'Whit Monday', sv: 'Annandag pingst', legal: true },
    { date: plus(os, 60), de: 'Fronleichnam', en: 'Corpus Christi', sv: 'Kristi lekamens dag' },
    { date: iso(y, 10, 3), de: 'Tag der Deutschen Einheit', en: 'German Unity Day', sv: 'Tysklands enhetsdag', legal: true },
    { date: iso(y, 10, 31), de: 'Reformationstag', en: 'Reformation Day', sv: 'Reformationsdagen' },
    { date: iso(y, 11, 1), de: 'Allerheiligen', en: "All Saints' Day", sv: 'Alla helgons dag' },
    { date: plus(iso(y, 11, 23), -bussDiff), de: 'Buß- und Bettag', en: 'Day of Repentance', sv: 'Bot- och bönedagen' },
    { date: iso(y, 12, 24), de: 'Heiligabend', en: 'Christmas Eve', sv: 'Julafton', short: true },
    { date: iso(y, 12, 25), de: '1. Weihnachtstag', en: 'Christmas Day', sv: 'Juldagen', legal: true },
    { date: iso(y, 12, 26), de: '2. Weihnachtstag', en: 'Boxing Day', sv: 'Annandag jul', legal: true },
    { date: iso(y, 12, 31), de: 'Silvester', en: "New Year's Eve", sv: 'Nyårsafton', short: true },
  ];
  cache.set(y, list);
  return list;
}

/** Feiertag an diesem Tag (oder undefined) */
export const holidayOn = (d) => berlinHolidays(+d.slice(0, 4)).find((h) => h.date === d);

/** Kurze Erklärung: hat alles zu oder ist offen? */
export function holidayInfo(h, lang = 'de') {
  if (lang === 'sv') {
    if (h.legal) return 'allmän helgdag i Berlin, affärerna stängda';
    if (h.sunday) return 'söndag, affärerna stängda (ingen extra helgdag i Berlin)';
    if (h.short) return 'ingen allmän helgdag, affärerna oftast öppna till ca kl. 14';
    return 'ingen helgdag i Berlin, allt öppet';
  }
  const de = lang !== 'en';
  if (h.legal) return de ? 'gesetzlicher Feiertag, Geschäfte zu' : 'public holiday, shops closed';
  if (h.sunday) return de ? 'Sonntag, Geschäfte zu (in Berlin kein extra Feiertag)' : 'Sunday, shops closed (no extra holiday in Berlin)';
  if (h.short) return de ? 'kein gesetzlicher Feiertag, Geschäfte meist nur bis ca. 14 Uhr' : 'not a public holiday, shops usually open until about 2 pm';
  return de ? 'kein Feiertag in Berlin, alles offen' : 'not a holiday in Berlin, everything open';
}
