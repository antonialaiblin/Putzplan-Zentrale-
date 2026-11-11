// Kalender-Abo (iCalendar), damit Apple/Google Kalender die WG-Termine anzeigen.
import { tr } from '../public/i18n.js';
import { addDays } from './plan.js';

const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const d8 = (d) => d.replace(/-/g, '');
const t6 = (t) => `${t.replace(':', '')}00`;
/** Lange Zeilen falten (RFC 5545) */
const fold = (line) => {
  const cp = [...line];
  const out = [cp.slice(0, 50).join('')];
  for (let i = 50; i < cp.length; i += 50) out.push(` ${cp.slice(i, i + 50).join('')}`);
  return out.join('\r\n');
};
const plusHour = (t, h) => {
  const [hh, mm] = t.split(':').map(Number);
  const n = Math.min(hh + h, 23);
  return `${String(n).padStart(2, '0')}:${String(n === 23 && hh + h > 23 ? 59 : mm).padStart(2, '0')}`;
};

const VTIMEZONE = [
  'BEGIN:VTIMEZONE', 'TZID:Europe/Berlin',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'END:VTIMEZONE',
];

/**
 * @param {object} o { events, members, people, weeks, person, lang, origin, stamp }
 */
export const ICS_KINDS = ['putzkraft', 'dienste', 'urlaub', 'meeting', 'sonstiges', 'besuch', 'geburtstage'];
export function buildIcs({ events, members, people, weeks, person, lang = 'de', origin = '', stamp, kinds = ICS_KINDS }) {
  const want = (k) => kinds.includes(k);
  const L = (de, en, sv) => (lang === 'en' ? en : lang === 'sv' ? sv ?? en : de);
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//WG Zentrale//DE', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(person ? `Zentrale (${person})` : 'Zentrale')}`, 'X-WR-TIMEZONE:Europe/Berlin',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H', ...VTIMEZONE,
  ];
  const ev = (uid, { day, to, time, end, summary, desc }) => {
    lines.push('BEGIN:VEVENT', `UID:${uid}@zentrale`, `DTSTAMP:${stamp}`);
    if (time) {
      lines.push(`DTSTART;TZID=Europe/Berlin:${d8(day)}T${t6(time)}`, `DTEND;TZID=Europe/Berlin:${d8(to || day)}T${t6(end || plusHour(time, 1))}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${d8(day)}`, `DTEND;VALUE=DATE:${d8(addDays(to || day, 1))}`);
    }
    lines.push(fold(`SUMMARY:${esc(summary)}`));
    if (desc) lines.push(fold(`DESCRIPTION:${esc(desc)}`));
    if (origin) lines.push(`URL:${origin}/#kalender`);
    lines.push('END:VEVENT');
  };

  // Einträge aus dem Kalender
  for (const e of events || []) {
    if (!want(e.type)) continue;
    const ppl = e.participants.filter((p) => p.ok !== false).map((p) => p.name);
    if (e.type === 'besuch') {
      const where = e.sleep === 'room' ? L(`schläft bei ${e.by}`, `sleeps in ${e.by}'s room`, `sover hos ${e.by}`) : e.bed ? L(`schläft in ${e.bed}s Bett`, `sleeps in ${e.bed}'s bed`, `sover i ${e.bed}s säng`) : '';
      ev(e.id, { day: e.from, to: e.time ? e.from : e.to, time: e.time, end: e.time ? plusHour(e.time, 2) : '', summary: `👋 ${L('Besuch bei', 'Guest of', 'Besök hos')} ${e.by}${e.title ? `: ${e.title}` : ''}`, desc: [where, e.note].filter(Boolean).join('\n') });
    } else if (e.type === 'urlaub') {
      const who = e.participants.filter((p) => p.ok).map((p) => p.name);
      if (!who.length) continue;
      ev(e.id, { day: e.from, to: e.to, summary: `🏖️ ${L('Urlaub', 'Holiday', `Semester`)}: ${who.join(', ')}${e.title ? ` (${e.title})` : ''}`, desc: e.note });
    } else {
      const title = e.type === 'meeting' && (!e.title || e.title === 'WG-Meeting') ? L('WG-Meeting', 'Flat meeting', `Husmöte`) : e.title || L('Termin', 'Appointment', `Tid`);
      const icon = e.type === 'meeting' ? '🗣️' : '📅';
      const topics = (e.topics || []).map((t) => `• ${t.text}`).join('\n');
      const desc = [e.note, ppl.length && ppl.length < (people || []).length ? `${L('Wer', 'Who', `Vem`)}: ${ppl.join(', ')}` : '', topics ? `${L('Themen', 'Topics', `Ämnen`)}:\n${topics}` : ''].filter(Boolean).join('\n\n');
      ev(e.id, { day: e.from, to: e.time ? e.from : e.to, time: e.time, end: e.time ? plusHour(e.time, e.type === 'meeting' ? 1 : 1) : '', summary: `${icon} ${title}`, desc });
    }
  }

  // Putzkraft und (optional) eigene Putzdienste
  for (const w of weeks || []) {
    if (want('putzkraft') && w.cleaner && w.cleanerDay) {
      ev(`putzkraft-${w.monday}`, {
        day: w.cleanerDay, time: w.cleanerTime, end: w.cleanerTime ? plusHour(w.cleanerTime, 3) : '',
        summary: `🧹 ${L('Putzkraft', 'Cleaner', `Städhjälp`)}`,
      });
    }
    if (!person || !want('dienste')) continue;
    for (const t of w.tasks || []) {
      if (t.person !== person) continue;
      if (t.key !== 'woche' && w.cleaner) continue; // Bad putzen nur in Wochen ohne Putzkraft
      ev(`dienst-${w.monday}-${t.key}`, {
        day: w.monday, to: w.sunday,
        summary: `🧽 ${tr(t.title, lang)}`,
        desc: (t.items || []).map((i) => `• ${tr(i.label, lang)}`).join('\n'),
      });
    }
  }

  // Geburtstage (jährlich)
  for (const m of want('geburtstage') ? members || [] : []) {
    if (!m.birthday || !(people || []).includes(m.name)) continue;
    lines.push('BEGIN:VEVENT', `UID:geburtstag-${encodeURIComponent(m.name)}@zentrale`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${d8(m.birthday)}`, `DTEND;VALUE=DATE:${d8(addDays(m.birthday, 1))}`, 'RRULE:FREQ=YEARLY',
      fold(`SUMMARY:${esc(`🎂 ${L('Geburtstag', 'Birthday', `Födelsedag`)} ${m.name}`)}`), 'TRANSP:TRANSPARENT', 'END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}
