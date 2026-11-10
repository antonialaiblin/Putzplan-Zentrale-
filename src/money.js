// WG-Kasse: Salden und Ausgleichs-Überweisungen (alles in Cent).

/** Verteilt amount (Cent) gleichmäßig auf people; Rest-Cents gehen an die ersten. */
export function shares(amount, people) {
  const n = people.length;
  const base = Math.floor(amount / n);
  let rest = amount - base * n;
  return people.map((p) => [p, base + (rest-- > 0 ? 1 : 0)]);
}

/** Verteilt amount nach Gewichten (größter Rest), Summe stimmt immer cent-genau. */
export function weighted(amount, weights) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const total = entries.reduce((n, [, w]) => n + w, 0);
  if (!total) return null;
  const raw = entries.map(([p, w]) => [p, (amount * w) / total]);
  const out = Object.fromEntries(raw.map(([p, v]) => [p, Math.floor(v)]));
  let rest = amount - Object.values(out).reduce((n, v) => n + v, 0);
  for (const [p] of [...raw].sort((a, b) => (b[1] % 1) - (a[1] % 1))) {
    if (rest-- <= 0) break;
    out[p] += 1;
  }
  return out;
}

/**
 * Anteile pro Person in Cent berechnen.
 * mode: 'equal' (split = Namen), 'percent' | 'shares' | 'exact' (values = {Name: Zahl})
 * Gibt {parts} oder {error} zurück.
 */
export function computeParts(amount, mode, people, split, values) {
  const valid = (p) => people.includes(p);
  if (mode === 'equal' || !mode) {
    const list = [...new Set((split || []).filter(valid))];
    if (!list.length) return { error: 'Bitte mindestens eine Person auswählen.' };
    return { parts: Object.fromEntries(shares(amount, list)) };
  }
  const vals = {};
  for (const [p, v] of Object.entries(values || {})) {
    if (!valid(p) || v === '' || v === null || v === undefined) continue;
    const n = mode === 'exact' ? parseAmount(String(v), true) : Number(String(v).replace(',', '.'));
    if (n === null || !Number.isFinite(n) || n < 0) return { error: `Ungültiger Wert bei ${p}.` };
    if (n > 0) vals[p] = n;
  }
  if (!Object.keys(vals).length) return { error: 'Bitte bei mindestens einer Person etwas eintragen.' };
  if (mode === 'percent') {
    const sum = Object.values(vals).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 100) > 0.01) return { error: `Die Prozente ergeben ${Math.round(sum * 100) / 100} %, nicht 100 %.` };
    return { parts: weighted(amount, vals) };
  }
  if (mode === 'shares') return { parts: weighted(amount, vals) };
  if (mode === 'exact') {
    const sum = Object.values(vals).reduce((a, b) => a + b, 0);
    if (sum !== amount) return { error: `Die Einzelbeträge ergeben ${(sum / 100).toFixed(2).replace('.', ',')}, nicht ${(amount / 100).toFixed(2).replace('.', ',')}.` };
    return { parts: vals };
  }
  return { error: 'Unbekannte Aufteilung.' };
}

/** Saldo pro Person: positiv = bekommt Geld, negativ = schuldet Geld. */
export function balances(expenses, people) {
  const bal = Object.fromEntries(people.map((p) => [p, 0]));
  for (const e of expenses) {
    if (!(e.paidBy in bal)) continue;
    let parts = e.parts;
    if (!parts) {
      const split = (e.split || []).filter((p) => p in bal);
      if (!split.length) continue;
      parts = Object.fromEntries(shares(e.amount, split));
    }
    bal[e.paidBy] += e.amount;
    for (const [p, v] of Object.entries(parts)) if (p in bal) bal[p] -= v;
  }
  return bal;
}

/** Salden getrennt nach Währung (es wird nicht umgerechnet). */
export function balancesByCurrency(expenses, people) {
  const groups = { EUR: [] };
  for (const e of expenses) (groups[e.currency || 'EUR'] ||= []).push(e);
  const out = {};
  for (const [cur, list] of Object.entries(groups)) {
    const bal = balances(list, people);
    out[cur] = { balances: bal, transfers: settle(bal) };
  }
  return out;
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

/** "12,50" / "12.5" / "12" → 1250 (Cent), sonst null. allowZero für Einzelbeträge. */
export function parseAmount(input, allowZero = false) {
  if (typeof input === 'number') input = String(input);
  if (typeof input !== 'string') return null;
  const s = input.trim().replace(/[\s€$£]/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const cents = Math.round(parseFloat(s) * 100);
  if (cents >= 10_000_000) return null;
  return cents > 0 || (allowZero && cents === 0) ? cents : null;
}
export const parseEuro = (input) => parseAmount(input);

export const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'PLN', 'CZK', 'DKK', 'SEK', 'NOK', 'HUF', 'TRY', 'RON', 'BGN', 'AUD', 'CAD'];

export const SHOP_CATEGORIES = [
  { id: 'putzsachen', label: 'Putzsachen allgemein', icon: '🧴' },
  { id: 'bad', label: 'Bad', icon: '🛁' },
  { id: 'kueche', label: 'Küche', icon: '🍳' },
  { id: 'allgemein', label: 'Allgemein', icon: '🛒' },
];
