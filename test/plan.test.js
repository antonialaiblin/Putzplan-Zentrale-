import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeWeek, mondayOf, berlinNow, itemsFor } from '../src/plan.js';
import { weeklyMessages, fridayMessages } from '../src/messages.js';

const person = (w, key) => w.tasks.find((t) => t.key === key).person;

test('Wochendienst und Putzkraft wie in der Tabelle', () => {
  const expected = [
    ['2026-11-09', false, 'Simon'], ['2026-11-16', true, 'Leo'], ['2026-11-23', false, 'Toni'],
    ['2026-11-30', true, 'Johanna'], ['2026-12-07', false, 'Mo'], ['2026-12-14', true, 'Simon'],
    ['2026-12-21', false, 'Leo'], ['2026-12-28', true, 'Toni'], ['2027-01-04', false, 'Johanna'],
    ['2027-01-11', true, 'Mo'],
    // danach wieder von oben
    ['2027-01-18', false, 'Simon'], ['2027-01-25', true, 'Leo'],
  ];
  for (const [monday, cleaner, who] of expected) {
    const w = computeWeek(monday);
    assert.equal(w.cleaner, cleaner, monday);
    assert.equal(person(w, 'woche'), who, monday);
  }
  assert.equal(computeWeek('2026-11-16').cleanerDay, '2026-11-18');
});

test('Baddienst wie in der Tabelle, nie gleich Wochendienst in der Putzwoche', () => {
  const expected = [
    ['2026-11-09', 'Mo', 'Toni'], ['2026-11-23', 'Simon', 'Johanna'], ['2026-12-07', 'Leo', 'Toni'],
    ['2026-12-21', 'Mo', 'Johanna'], ['2027-01-04', 'Simon', 'Toni'], ['2027-01-18', 'Leo', 'Johanna'],
  ];
  for (const [monday, vorne, hinten] of expected) {
    for (const m of [monday, monday.replace(/\d\d$/, (d) => String(+d + 7).padStart(2, '0'))]) {
      const w = computeWeek(m.length === 10 ? m : monday);
      assert.equal(person(w, 'bad-vorne'), vorne, m);
      assert.equal(person(w, 'bad-hinten'), hinten, m);
    }
    const w = computeWeek(monday);
    assert.ok(w.tasks.find((t) => t.key === 'bad-vorne').cleaningWeek);
    assert.notEqual(person(w, 'woche'), vorne);
    assert.notEqual(person(w, 'woche'), hinten);
  }
  const pk = computeWeek('2026-11-16');
  assert.equal(pk.tasks.find((t) => t.key === 'bad-vorne').items.length, 0);
});

test('Extra-Aufgaben nur ohne Putzkraft, Ausfall schaltet sie ein', () => {
  const ids = (w) => w.tasks[0].items.map((i) => i.id);
  assert.ok(ids(computeWeek('2026-11-09')).includes('kueche'));
  assert.ok(!ids(computeWeek('2026-11-16')).includes('kueche'));
  const a = computeWeek('2026-11-16', { ausfall: true });
  assert.ok(ids(a).includes('kueche'));
  assert.ok(a.tasks.find((t) => t.key === 'bad-hinten').cleaningWeek);
});

test('Tausch, Kühlschrank und Spülbürste', () => {
  const w = computeWeek('2026-11-09', { swaps: { woche: 'Leo' } });
  assert.equal(person(w, 'woche'), 'Leo');
  assert.ok(computeWeek('2026-11-23').tasks.some((t) => t.key === 'kuehlschrank')); // So 29.11.
  assert.ok(!computeWeek('2026-11-16').tasks.some((t) => t.key === 'kuehlschrank'));
  assert.ok(computeWeek('2026-11-30').tasks[0].items.some((i) => i.id === 'spuelbuerste')); // 01.12.
});

test('Berliner Zeit und Montag', () => {
  assert.equal(mondayOf('2026-11-15'), '2026-11-09');
  assert.equal(mondayOf('2026-11-16'), '2026-11-16');
  assert.deepEqual(berlinNow(new Date('2026-11-15T18:00:00Z')), { day: '2026-11-15', dow: 6, hour: 19 });
  assert.deepEqual(berlinNow(new Date('2027-07-04T17:00:00Z')), { day: '2027-07-04', dow: 6, hour: 19 });
});

test('Nachrichten', () => {
  const w = computeWeek('2026-11-16');
  const m = weeklyMessages(w);
  assert.match(m.Leo.body, /Wochendienst/);
  assert.match(m.Mo.body, /Vorderes Bad \+ extra Klo: nur Klopapier/);
  assert.match(m.Leo.body, /Putzkraft kommt Mi 18\.11\./);
  assert.equal(m.Johanna, undefined);

  const w2 = computeWeek('2026-11-09');
  w2.checks = { 'woche:muell': {}, 'bad-vorne:putzen': {} };
  const f = fridayMessages(w2);
  assert.equal(f.Mo, undefined);
  assert.match(f.Toni.body, /Hinteres Bad putzen/);
  assert.doesNotMatch(f.Simon.body, /Müll/);
  assert.match(f.Simon.body, /Pfand/);
  assert.equal(itemsFor(w2, 'Johanna').length, 0);
});

test('Putzkraft-Ausfall: Plan rutscht ab der Folgewoche um eine Woche', () => {
  const aus = ['2026-11-16'];
  const w16 = computeWeek('2026-11-16', { ausfall: true }, aus);
  assert.equal(w16.cleaner, false);
  assert.equal(person(w16, 'woche'), 'Leo');
  // 23.11. ist jetzt wie vorher der 16.11. (Leo, Putzkraft kommt)
  const w23 = computeWeek('2026-11-23', {}, aus);
  assert.equal(person(w23, 'woche'), 'Leo');
  assert.equal(w23.cleaner, true);
  assert.equal(w23.cleanerDay, '2026-11-25');
  const w30 = computeWeek('2026-11-30', {}, aus);
  assert.equal(person(w30, 'woche'), 'Toni');
  assert.equal(w30.cleaner, false);
  // Wochen davor unverändert
  assert.equal(person(computeWeek('2026-11-09', {}, aus), 'woche'), 'Simon');
});

test('Ausfall-Nachricht', async () => {
  const { ausfallMessages } = await import('../src/messages.js');
  const m = ausfallMessages(computeWeek('2026-11-16', { ausfall: true }, ['2026-11-16']));
  assert.match(m.Leo.body, /Wochendienst inkl\. Küche/);
  assert.match(m.Mo.body, /Vorderes Bad \+ extra Klo putzen/);
  assert.match(m.Johanna.body, /ändert sich diese Woche nichts/);
  assert.match(m.Leo.body, /Mi 18\.11\./);
});

import { INITIAL_MEMBERS } from '../src/plan.js';

test('Urlaub: wer weg ist, wird übersprungen und ist danach dran', () => {
  const absences = [{ person: 'Toni', from: '2026-11-21', to: '2026-12-01' }]; // ganze Woche ab 23.11.
  const ctx = { absences };
  assert.equal(person(computeWeek('2026-11-23', {}, ctx), 'woche'), 'Johanna');
  assert.equal(person(computeWeek('2026-11-30', {}, ctx), 'woche'), 'Toni');
  assert.equal(person(computeWeek('2026-12-07', {}, ctx), 'woche'), 'Mo');
  const w = computeWeek('2026-11-23', {}, ctx);
  assert.deepEqual(w.away, ['Toni']);
  assert.ok(!w.tasks.find((t) => t.key === 'kuehlschrank').items.some((i) => i.person === 'Toni'));
});

test('Neues Mitglied kommt in die Rotation, Ausgezogene fliegen raus', () => {
  const members = [
    ...INITIAL_MEMBERS.map((m) => (m.name === 'Mo' ? { ...m, until: '2026-11-23' } : m)),
    { name: 'Lina', side: 'vorne', since: '2026-11-23', until: null },
  ];
  const ctx = { members };
  const seq = ['2026-11-23', '2026-11-30', '2026-12-07', '2026-12-14', '2026-12-21', '2026-12-28'].map((m) => person(computeWeek(m, {}, ctx), 'woche'));
  assert.deepEqual(seq, ['Toni', 'Johanna', 'Simon', 'Leo', 'Lina', 'Toni']);
  assert.ok(!computeWeek('2026-11-30', {}, ctx).people.includes('Mo'));
  const vorne = ['2026-11-23', '2026-12-07', '2026-12-21', '2027-01-04'].map((m) => person(computeWeek(m, {}, ctx), 'bad-vorne'));
  assert.ok(vorne.includes('Lina'));
  assert.ok(!vorne.includes('Mo'));
});

test('Kürzer als eine ganze Woche weg: kein Überspringen', () => {
  const ctx = { absences: [{ person: 'Toni', from: '2026-11-23', to: '2026-11-28' }] }; // Mo–Sa
  assert.equal(person(computeWeek('2026-11-23', {}, ctx), 'woche'), 'Toni');
});
