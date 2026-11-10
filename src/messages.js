import { itemsFor } from './plan.js';
import { tr } from '../public/i18n.js';

// Jede Funktion bekommt optional `langs` = { Name: 'de' | 'en' } und schreibt jeder Person in ihrer Sprache.
const langOf = (langs, p) => (langs && langs[p] === 'en' ? 'en' : 'de');
const pick = (lang) => (de, en) => (lang === 'en' ? en : de);

const MON_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "16.11." bzw. "16 Nov" */
export const ddmm = (s, lang = 'de') => (lang === 'en' ? `${+s.slice(8, 10)} ${MON_EN[+s.slice(5, 7) - 1]}` : `${s.slice(8, 10)}.${s.slice(5, 7)}.`);
const WD = { de: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'], en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] };
const wd = (s, lang) => WD[lang][new Date(`${s}T12:00:00Z`).getUTCDay()];
/** "Do 13.11. um 10:00" / "Thu 13 Nov at 10:00" */
export const cleanerWhen = (week, lang = 'de') =>
  `${wd(week.cleanerDay, lang)} ${ddmm(week.cleanerDay, lang)}${week.cleanerTime ? `${lang === 'en' ? ' at' : ' um'} ${week.cleanerTime}` : ''}`;
/** Wochentag + Datum, z.B. "Fr. 13.11." / "Fri 13 Nov" */
export const dayLabel = (d, lang = 'de') => (lang === 'en' ? `${wd(d, 'en')} ${ddmm(d, 'en')}` : `${wd(d, 'de')}. ${ddmm(d, 'de')}`);

/** Sonntags-Nachricht pro Person für die kommende Woche. */
export function weeklyMessages(week, langs) {
  const msgs = {};
  for (const person of week.people) {
    const lang = langOf(langs, person);
    const L = pick(lang);
    const lines = [];
    for (const t of week.tasks) {
      if (t.key === 'woche' && t.person === person) {
        lines.push(week.cleaner ? L('Wochendienst', 'weekly duty') : L('Wochendienst inkl. Küche + Flure', 'weekly duty incl. kitchen + hallways'));
      }
      if (t.key.startsWith('bad-') && t.person === person) {
        lines.push(t.cleaningWeek ? L(`${t.title} putzen`, `clean ${tr(t.title, 'en').toLowerCase()}`) : L(`${t.title}: nur Klopapier`, `${tr(t.title, 'en')}: toilet paper only`));
      }
      if (t.key === 'kuehlschrank') lines.push(L('Kühlschrankfach bis Sonntag', 'your fridge shelf by Sunday'));
    }
    if (!lines.length) continue;
    const info = week.cleaner
      ? L(` Putzkraft kommt ${cleanerWhen(week)}.`, ` The cleaner comes ${cleanerWhen(week, 'en')}.`)
      : week.ausfall ? L(' Putzkraft fällt aus, also Intensivputz.', ' The cleaner is cancelled, so it is a deep clean.') : '';
    msgs[person] = {
      title: L(`Putzplan ab Mo ${ddmm(week.monday)}`, `Cleaning rota from Mon ${ddmm(week.monday, 'en')}`),
      body: L(`Hey ${person}, ab morgen bist du dran mit: ${lines.join(', ')}.${info}`, `Hey ${person}, from tomorrow it's your turn for: ${lines.join(', ')}.${info}`),
    };
  }
  return msgs;
}

/** Freitags-Erinnerung pro Person an noch nicht abgehakte Aufgaben. */
export function fridayMessages(week, langs) {
  const msgs = {};
  for (const person of week.people) {
    const lang = langOf(langs, person);
    const L = pick(lang);
    const open = itemsFor(week, person).filter((x) => !week.checks[x.checkKey]).map((x) => tr(x.item.short, lang));
    if (!open.length) continue;
    msgs[person] = {
      title: L('Noch offen im Putzplan ⏰', 'Still open on the cleaning rota ⏰'),
      body: L(`Hey ${person}, bis Sonntag noch zu erledigen: ${open.join(', ')}. Bitte auf der Seite abhaken, wenn's erledigt ist.`,
        `Hey ${person}, still to do by Sunday: ${open.join(', ')}. Please tick it off in the app when it's done.`),
    };
  }
  return msgs;
}

/** Sofort-Nachricht an alle, wenn jemand einträgt, dass die Putzkraft ausfällt. */
export function ausfallMessages(week, langs) {
  const msgs = {};
  for (const person of week.people) {
    const lang = langOf(langs, person);
    const L = pick(lang);
    const when = L(`am ${cleanerWhen(week)}`, `on ${cleanerWhen(week, 'en')}`);
    const mine = [];
    for (const t of week.tasks) {
      if (t.person !== person) continue;
      if (t.key === 'woche') mine.push(L('Wochendienst inkl. Küche + Flure', 'weekly duty incl. kitchen + hallways'));
      if (t.key.startsWith('bad-')) mine.push(L(`${t.title} putzen`, `clean ${tr(t.title, 'en').toLowerCase()}`));
    }
    msgs[person] = {
      title: L('Putzkraft fällt aus ⚠️', 'Cleaner cancelled ⚠️'),
      body: mine.length
        ? L(`Hey ${person}, die Putzkraft kommt ${when} nicht. Diese Woche putzen wir selbst, du bist dran mit: ${mine.join(', ')}. Ab nächster Woche rutscht der Plan um eine Woche.`,
          `Hey ${person}, the cleaner is not coming ${when}. This week we clean ourselves, you're on: ${mine.join(', ')}. From next week the rota moves back one week.`)
        : L(`Hey ${person}, die Putzkraft kommt ${when} nicht. Für dich ändert sich diese Woche nichts, aber ab nächster Woche rutscht der Plan um eine Woche.`,
          `Hey ${person}, the cleaner is not coming ${when}. Nothing changes for you this week, but from next week the rota moves back one week.`),
    };
  }
  return msgs;
}

/** Am Vortag eines WG-Meetings an alle Teilnehmenden: Themen vorbereiten. */
export function meetingPrepMessages(ev, langs) {
  const msgs = {};
  const topics = (ev.topics || []).map((t) => t.text);
  for (const p of ev.participants) {
    const L = pick(langOf(langs, p.name));
    const named = ev.title && ev.title !== 'WG-Meeting';
    const list = topics.length
      ? L(` Bisherige Themen: ${topics.slice(0, 5).join(', ')}${topics.length > 5 ? ' …' : ''}.`, ` Topics so far: ${topics.slice(0, 5).join(', ')}${topics.length > 5 ? ' …' : ''}.`)
      : L(' Noch keine Themen eingetragen.', ' No topics yet.');
    msgs[p.name] = {
      title: L('Morgen WG-Meeting 🗣️', 'Flat meeting tomorrow 🗣️'),
      body: L(`Hey ${p.name}, morgen${ev.time ? ` um ${ev.time}` : ''} ist ${named ? `WG-Meeting: ${ev.title}` : 'WG-Meeting'}. Überleg dir schon mal, was du ansprechen willst, und trag deine Themen in der App ein.${list}`,
        `Hey ${p.name}, tomorrow${ev.time ? ` at ${ev.time}` : ''} there's a flat meeting${named ? `: ${ev.title}` : ''}. Think about what you'd like to bring up and add your topics in the app.${list}`),
      url: '/#kalender',
    };
  }
  return msgs;
}

/** Montags an die/den Putzkraft-Zuständige:n: Kommt sie diese Woche? */
export function cleanerAskMessage(week, contact, lang = 'de') {
  const L = pick(lang);
  return {
    title: L('Kommt die Putzkraft diese Woche? 🧹', 'Is the cleaner coming this week? 🧹'),
    body: L(`Hey ${contact}, laut Plan kommt die Putzkraft ${cleanerWhen(week)}. Stimmt das? Tipp hier, um Tag und Uhrzeit einzutragen oder einen Ausfall zu melden.`,
      `Hey ${contact}, according to the plan the cleaner comes ${cleanerWhen(week, 'en')}. Is that right? Tap here to enter the day and time or to report a cancellation.`),
    url: '/#plan',
  };
}

/** An alle, wenn der Putzkraft-Termin eingetragen oder geändert wurde. */
export function cleanerVisitMessages(week, by, langs) {
  const msgs = {};
  for (const person of week.people) {
    if (person === by) continue;
    const L = pick(langOf(langs, person));
    msgs[person] = {
      title: L('Putzkraft-Termin 🧹', 'Cleaner appointment 🧹'),
      body: L(`Die Putzkraft kommt diese Woche ${cleanerWhen(week)}${by ? ` (eingetragen von ${by})` : ''}.`,
        `The cleaner comes this week on ${cleanerWhen(week, 'en')}${by ? ` (added by ${by})` : ''}.`),
      url: '/#plan',
    };
  }
  return msgs;
}
