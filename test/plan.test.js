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
    ['2026-12-21', 'Mo', 'Johanna'], ['2027-01-04', 'Simon', 'Toni'], ['2027-01-18', 'Mo', 'Toni'],
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
