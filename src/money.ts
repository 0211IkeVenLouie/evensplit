/**
 * Money.
 *
 * Every amount in this application is an integer number of cents. Not a float,
 * not a string, not a Decimal class — an integer. `0.1 + 0.2 !== 0.3` is the
 * famous reason, but the one that actually bites a splitter is subtler: three
 * people splitting $10 owe $3.333… each, and any representation that can hold
 * that number can lose a cent when you add it back up.
 */

export type Cents = number;

export class MoneyError extends Error {}

/**
 * Parse human input into cents. Accepts "12", "12.3", "12.34", "1,234.56",
 * "$12.34" and a leading "+". Rejects anything with more precision than a cent,
 * rather than silently rounding someone's money.
 */
export function parseMoney(input: string): Cents {
  const cleaned = input.trim().replace(/[$€£\s,]/g, '').replace(/^\+/, '');
  if (!cleaned) throw new MoneyError('Enter an amount.');
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) {
    if (/^-?\d+\.\d{3,}$/.test(cleaned)) throw new MoneyError('Amounts are only precise to the cent.');
    throw new MoneyError('That is not an amount.');
  }
  const sign = match[1] ? -1 : 1;
  const whole = Number(match[2]);
  const fraction = Number((match[3] ?? '0').padEnd(2, '0'));
  const cents = sign * (whole * 100 + fraction);
  if (!Number.isSafeInteger(cents)) throw new MoneyError('That amount is too large.');
  return cents;
}

export function formatMoney(cents: Cents, currency = 'USD', locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
}

/** "12.34" — for form fields, where a currency symbol would be in the way. */
export function formatAmount(cents: Cents): string {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

/**
 * Split `total` cents in the given proportions so that the parts sum to exactly
 * `total` — no cent invented, none lost.
 *
 * Largest remainder: give everyone the floor of their exact share, then hand
 * the leftover cents out one at a time, largest fractional part first. Ties go
 * to the earlier index so the result is deterministic — the same expense always
 * splits the same way, which matters when someone reloads the page and compares.
 */
export function allocate(total: Cents, weights: number[]): Cents[] {
  if (weights.length === 0) throw new MoneyError('Nobody to split between.');
  if (weights.some((weight) => weight < 0 || !Number.isFinite(weight))) {
    throw new MoneyError('Shares cannot be negative.');
  }
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0) throw new MoneyError('At least one person must have a share.');

  const sign = total < 0 ? -1 : 1;
  const amount = Math.abs(total);

  const exact = weights.map((weight) => (amount * weight) / totalWeight);
  const floors = exact.map(Math.floor);
  let remainder = amount - floors.reduce((sum, value) => sum + value, 0);

  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => (b.fraction === a.fraction ? a.index - b.index : b.fraction - a.fraction));

  const result = [...floors];
  for (const entry of order) {
    if (remainder <= 0) break;
    // Someone with a zero weight is not owed a leftover cent.
    if (weights[entry.index] === 0) continue;
    result[entry.index] = result[entry.index]! + 1;
    remainder -= 1;
  }
  // With every non-zero weight already topped up and cents still to place,
  // fall back to the first participant with a share.
  let guard = 0;
  while (remainder > 0 && guard < weights.length * 2) {
    const index = weights.findIndex((weight) => weight > 0);
    result[index] = result[index]! + 1;
    remainder -= 1;
    guard += 1;
  }

  return result.map((value) => value * sign);
}

/** Split evenly — the common case, and the one that produces the awkward cent. */
export function splitEqually(total: Cents, people: number): Cents[] {
  return allocate(total, new Array(people).fill(1));
}

/** Split by percentage. Percentages are numbers like 33.5, and must sum to 100. */
export function splitByPercent(total: Cents, percents: number[]): Cents[] {
  const sum = percents.reduce((acc, value) => acc + value, 0);
  if (Math.abs(sum - 100) > 0.001) {
    throw new MoneyError(`Percentages add up to ${round(sum)}%, not 100%.`);
  }
  return allocate(total, percents);
}

/** Split by shares ("Ana counts double, she had the steak"). */
export function splitByShares(total: Cents, shares: number[]): Cents[] {
  if (shares.some((share) => !Number.isInteger(share) || share < 0)) {
    throw new MoneyError('Shares must be whole numbers.');
  }
  return allocate(total, shares);
}

/** Exact amounts, checked to add up to the total. */
export function splitExactly(total: Cents, amounts: Cents[]): Cents[] {
  const sum = amounts.reduce((acc, value) => acc + value, 0);
  if (sum !== total) {
    throw new MoneyError(
      `The amounts add up to ${formatAmount(sum)}, but the expense is ${formatAmount(total)}.`,
    );
  }
  return [...amounts];
}

function round(value: number): string {
  return String(Math.round(value * 100) / 100);
}
