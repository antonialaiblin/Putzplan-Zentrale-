import { PEOPLE, itemsFor, addDays } from './plan.js';

const ddmm = (s) => `${s.slice(8, 10)}.${s.slice(5, 7)}.`;

/** Sonntags-Nachricht pro Person für die kommende Woche. */
export function weeklyMessages(week) {
  const msgs = {};
  for (const person of PEOPLE) {
    const lines = [];
    for (const t of week.tasks) {
      if (t.key === 'woche' && t.person === person) {
        lines.push(week.cleaner ? 'Wochendienst' : 'Wochendienst inkl. Küche + Flure');
      }
      if (t.key.startsWith('bad-') && t.person === person) {
        lines.push(t.cleaningWeek ? `${t.title} putzen` : `${t.title}: nur Klopapier`);
      }
      if (t.key === 'kuehlschrank') lines.push('Kühlschrankfach bis Sonntag');
    }
    if (!lines.length) continue;
    const info = week.cleaner ? ` Putzkraft kommt Mi ${ddmm(week.cleanerDay)}.` : week.ausfall ? ' Putzkraft fällt aus, also Intensivputz.' : '';
    msgs[person] = {
      title: `Putzplan ab Mo ${ddmm(week.monday)}`,
      body: `Hey ${person}, ab morgen bist du dran mit: ${lines.join(', ')}.${info}`,
    };
  }
  return msgs;
}
/** Freitags-Erinnerung pro Person an noch nicht abgehakte Aufgaben. */
export function fridayMessages(week) {
  const msgs = {};
  for (const person of PEOPLE) {
    const open = itemsFor(week, person).filter((x) => !week.checks[x.checkKey]).map((x) => x.item.short);
    if (!open.length) continue;
    msgs[person] = {
      title: 'Noch offen im Putzplan ⏰',
      body: `Hey ${person}, bis Sonntag noch zu erledigen: ${open.join(', ')}. Bitte auf der Seite abhaken, wenn's erledigt ist.`,
    };
  }
  return msgs;
}

/** Sofort-Nachricht an alle, wenn jemand einträgt, dass die Putzkraft ausfällt. */
export function ausfallMessages(week) {
  const msgs = {};
  const when = `am Mi ${ddmm(addDays(week.monday, 2))}`;
  for (const person of PEOPLE) {
    const mine = [];
    for (const t of week.tasks) {
      if (t.person !== person) continue;
      if (t.key === 'woche') mine.push('Wochendienst inkl. Küche + Flure');
      if (t.key.startsWith('bad-')) mine.push(`${t.title} putzen`);
    }
    msgs[person] = {
      title: 'Putzkraft fällt aus ⚠️',
      body: mine.length
        ? `Hey ${person}, die Putzkraft kommt ${when} nicht. Diese Woche putzen wir selbst, du bist dran mit: ${mine.join(', ')}. Ab nächster Woche rutscht der Plan um eine Woche.`
        : `Hey ${person}, die Putzkraft kommt ${when} nicht. Für dich ändert sich diese Woche nichts, aber ab nächster Woche rutscht der Plan um eine Woche.`,
    };
  }
  return msgs;
}
