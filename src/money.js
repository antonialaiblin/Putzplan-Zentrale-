// WG-Kasse: Salden und Ausgleichs-Überweisungen (alles in Cent).

/** Verteilt amount (Cent) gleichmäßig auf people; Rest-Cents gehen an die ersten. */
export function shares(amount, people) {
  const n = people.length;
  const base = Math.floor(amount / n);
  let rest = amount - base * n;
  return people.map((p) => [p, base + (rest-- > 0 ? 1 : 0)]);
}

/** Saldo pro Person: positiv = bekommt Geld, negativ = schuldet Geld. */
export function balances(expenses, people) {
  const bal = Object.fromEntries(people.map((p) => [p, 0]));
  for (const e of expenses) {
    if (!(e.paidBy in bal)) continue;
    const split = e.split.filter((p) => p in bal);
    if (!split.length) continue;
    bal[e.paidBy] += e.amount;
    for (const [p, s] of shares(e.amount, split)) bal[p] -= s;
  }
  return bal;
}

/** Möglichst wenige Überweisungen, damit alle bei 0 landen. */
export function settle(bal) {
  const debtors = Object.entries(bal).filter(([, v]) => v < 0).map(([p, v]) => [p, -v]).sort((a, b) => b[1] - a[1]);
  const creditors = Object.entries(bal).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i][1], creditors[j][1]);
    if (amount > 0) out.push({ from: debtors[i][0], to: creditors[j][0], amount });
    debtors[i][1] -= amount;
    creditors[j][1] -= amount;
    if (debtors[i][1] === 0) i++;
    if (creditors[j][1] === 0) j++;
  }
  return out;
}

/** "12,50" / "12.5" / "12" → 1250 Cent, sonst null */
export function parseEuro(input) {
  if (typeof input === 'number') return Number.isFinite(input) && input > 0 ? Math.round(input * 100) : null;
  if (typeof input !== 'string') return null;
  const s = input.trim().replace(/\s|€/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const cents = Math.round(parseFloat(s) * 100);
  return cents > 0 && cents < 10_000_000 ? cents : null;
}

export const SHOP_CATEGORIES = [
  { id: 'putzsachen', label: 'Putzsachen', icon: '🧴' },
  { id: 'bad', label: 'Bad', icon: '🛁' },
  { id: 'kueche', label: 'Küche', icon: '🍳' },
  { id: 'allgemein', label: 'Allgemein', icon: '🛒' },
];
