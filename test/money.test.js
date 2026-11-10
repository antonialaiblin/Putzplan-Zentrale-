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
