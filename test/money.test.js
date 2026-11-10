import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balances, settle, parseEuro, shares } from '../src/money.js';

const P = ['Simon', 'Leo', 'Toni', 'Johanna', 'Mo'];

test('Beträge einlesen', () => {
  assert.equal(parseEuro('12,50'), 1250);
  assert.equal(parseEuro('3.49 €'), 349);
  assert.equal(parseEuro('7'), 700);
  assert.equal(parseEuro('abc'), null);
  assert.equal(parseEuro('0'), null);
  assert.equal(parseEuro('1,234'), null);
});

test('Aufteilung geht cent-genau auf', () => {
  const s = shares(1000, P);
  assert.equal(s.reduce((n, [, v]) => n + v, 0), 1000);
  assert.deepEqual(s.map(([, v]) => v), [200, 200, 200, 200, 200]);
  assert.equal(shares(1001, P).reduce((n, [, v]) => n + v, 0), 1001);
});

test('Salden und Ausgleich', () => {
  const ex = [
    { amount: 5000, paidBy: 'Toni', split: P },          // jede*r 10 €
    { amount: 2000, paidBy: 'Leo', split: ['Leo', 'Mo'] }, // Mo schuldet Leo 10 €
  ];
  const b = balances(ex, P);
  assert.deepEqual(b, { Simon: -1000, Leo: 0, Toni: 4000, Johanna: -1000, Mo: -2000 });
  assert.equal(Object.values(b).reduce((a, c) => a + c, 0), 0);
  const t = settle(b);
  assert.equal(t.length, 3);
  assert.ok(t.every((x) => x.to === 'Toni'));
  // Rückzahlungen eintragen → alle quitt
  const after = balances([...ex, ...t.map((x) => ({ amount: x.amount, paidBy: x.from, split: [x.to] }))], P);
  assert.ok(Object.values(after).every((v) => v === 0));
});

import { computeParts, balancesByCurrency } from '../src/money.js';

test('Aufteilen nach Prozent, Anteilen und Beträgen', () => {
  assert.deepEqual(computeParts(1000, 'percent', P, null, { Toni: '60', Leo: '40' }).parts, { Toni: 600, Leo: 400 });
  assert.match(computeParts(1000, 'percent', P, null, { Toni: '60', Leo: '30' }).error, /90 %/);
  assert.deepEqual(computeParts(1000, 'shares', P, null, { Toni: '1', Leo: '2', Mo: '' }).parts, { Toni: 333, Leo: 667 });
  assert.deepEqual(computeParts(1999, 'exact', P, null, { Toni: '10', Leo: '9,99' }).parts, { Toni: 1000, Leo: 999 });
  assert.match(computeParts(2000, 'exact', P, null, { Toni: '10' }).error, /10,00/);
  assert.deepEqual(computeParts(1000, 'equal', P, ['Toni', 'Mo']).parts, { Toni: 500, Mo: 500 });
});

test('Währungen werden getrennt abgerechnet', () => {
  const r = balancesByCurrency([
    { amount: 1000, paidBy: 'Toni', parts: { Toni: 500, Leo: 500 } },
    { amount: 3000, currency: 'CHF', paidBy: 'Leo', parts: { Mo: 3000 } },
  ], P);
  assert.equal(r.EUR.balances.Leo, -500);
  assert.equal(r.CHF.balances.Leo, 3000);
  assert.deepEqual(r.CHF.transfers, [{ from: 'Mo', to: 'Leo', amount: 3000 }]);
});

import { parseSplitwise } from '../src/money.js';

test('Splitwise-Import: Netto-Werte und Gesamtbilanz', () => {
  const csv = [
    'Datum,Beschreibung,Kategorie,Kosten,Währung,Leonard Penz,Toni,Mo,Wilko Kramer (entfernt)',
    '',
    '2026-01-05,Waschpulver,Allgemein,16.00,EUR,0.00,-5.33,-5.34,10.67',
    '2026-02-01,Toni zahlte Wilko K.,Zahlung,5.33,EUR,0.00,5.33,0.00,-5.33',
    '"2026-03-01","Spüli, Schwämme",Haushalt,9.00,EUR,-3.00,-3.00,6.00,0.00',
    '',
    '2026-11-10,Gesamtbilanz, , ,EUR,-3.00,-3.00,0.66,5.34',
  ].join('\n');
  const r = parseSplitwise(csv, P);
  assert.equal(r.entries.length, 3);
  assert.equal(r.matches, true);
  assert.deepEqual(r.people, ['Leo', 'Toni', 'Mo', 'Wilko']);
  assert.equal(r.entries[1].kind, 'settle');
  assert.equal(r.entries[2].desc, 'Spüli, Schwämme');
  const b = balancesByCurrency(r.entries, [...P, 'Wilko']).EUR.balances;
  assert.equal(b.Wilko, 534);
  assert.equal(b.Mo, 66);
});
