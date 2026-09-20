import type { Cents } from './money.js';

export interface Balance {
  memberId: string;
  /** Positive: owed money. Negative: owes money. Always sums to zero across a group. */
  cents: Cents;
}

export interface Transfer {
  fromMemberId: string;
  toMemberId: string;
  cents: Cents;
}

/** Above this many non-zero balances the exact search is skipped for the greedy one. */
export const EXACT_SEARCH_LIMIT = 16;

/**
 * Settle-up: who should pay whom, in as few transfers as possible.
 *
 * Everyone's net balance is a single number, so the raw debts ("Ana owes Ben
 * $4, Ben owes Cal $4") can be collapsed: Ana pays Cal once and Ben is out of
 * it. The question is how few transfers that takes.
 *
 * With n people holding non-zero balances, a settlement needs **n - k**
 * transfers, where k is the number of groups the people can be partitioned into
 * such that each group's balances sum to zero. Each such group is settled
 * internally with (size - 1) transfers, and no transfer can ever cross between
 * two zero-sum groups usefully.
 *
 * Maximising k is the subset-sum problem wearing a hat, so the exact answer is
 * NP-hard. Two implementations, and the honest reason for each:
 *
 *  - `simplifyOptimal` finds the true minimum with a bitmask DP over subsets.
 *    2^n states, so it is only run for groups up to EXACT_SEARCH_LIMIT people —
 *    which is every real dinner, house share and holiday.
 *  - `simplifyGreedy` repeatedly matches the largest debtor with the largest
 *    creditor. Always at most n - 1 transfers, usually optimal, and O(n log n).
 */
export function simplify(balances: Balance[]): Transfer[] {
  const active = balances
    .map((balance) => ({ ...balance, cents: normaliseCents(balance.cents) }))
    .filter((balance) => balance.cents !== 0);
  if (active.length === 0) return [];

  const total = active.reduce((sum, balance) => sum + balance.cents, 0);
  if (total !== 0) {
    throw new Error(`Balances must sum to zero, got ${total} cents. This is a bug in the balance calculation.`);
  }

  return active.length <= EXACT_SEARCH_LIMIT ? simplifyOptimal(active) : simplifyGreedy(active);
}

/** Largest debtor pays the largest creditor, repeatedly. */
export function simplifyGreedy(balances: Balance[]): Transfer[] {
  const debtors = balances.filter((b) => b.cents < 0).map((b) => ({ ...b }));
  const creditors = balances.filter((b) => b.cents > 0).map((b) => ({ ...b }));
  // Descending by size, so the biggest obligations are cleared first.
  debtors.sort((a, b) => a.cents - b.cents);
  creditors.sort((a, b) => b.cents - a.cents);

  const transfers: Transfer[] = [];
  let debtorIndex = 0;
  let creditorIndex = 0;

  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex]!;
    const creditor = creditors[creditorIndex]!;
    const amount = Math.min(-debtor.cents, creditor.cents);

    if (amount > 0) {
      transfers.push({ fromMemberId: debtor.memberId, toMemberId: creditor.memberId, cents: amount });
      debtor.cents += amount;
      creditor.cents -= amount;
    }
    if (debtor.cents === 0) debtorIndex += 1;
    if (creditor.cents === 0) creditorIndex += 1;
  }
  return transfers;
}

/**
 * Minimum number of transfers, exactly.
 *
 * Partition the people into as many zero-sum groups as possible (a bitmask DP
 * over all 2^n subsets), then settle each group greedily, which is optimal for
 * a group that cannot be split further.
 */
export function simplifyOptimal(balances: Balance[]): Transfer[] {
  const n = balances.length;
  if (n === 0) return [];
  if (n > EXACT_SEARCH_LIMIT) return simplifyGreedy(balances);

  const size = 1 << n;
  const sums = new Int32Array(size);
  for (let mask = 1; mask < size; mask += 1) {
    const lowest = mask & -mask;
    const index = Math.log2(lowest) | 0;
    sums[mask] = sums[mask ^ lowest]! + balances[index]!.cents;
  }

  // best[mask] = the most zero-sum groups `mask` can be partitioned into.
  const best = new Int32Array(size).fill(-1);
  const choice = new Int32Array(size);
  best[0] = 0;

  for (let mask = 1; mask < size; mask += 1) {
    // Fix the lowest set member and try every subset of `mask` containing it,
    // which enumerates each partition exactly once.
    const lowest = mask & -mask;
    const rest = mask ^ lowest;
    for (let sub = rest; ; sub = (sub - 1) & rest) {
      const group = sub | lowest;
      const remainder = mask ^ group;
      const previous = best[remainder]!;
      if (previous >= 0) {
        const score = previous + (sums[group] === 0 ? 1 : 0);
        if (score > best[mask]!) {
          best[mask] = score;
          choice[mask] = group;
        }
      }
      if (sub === 0) break;
    }
  }

  // Walk the choices back out into actual groups, and settle each one.
  const transfers: Transfer[] = [];
  let mask = size - 1;
  while (mask > 0) {
    const group = choice[mask]!;
    const members: Balance[] = [];
    for (let index = 0; index < n; index += 1) {
      if (group & (1 << index)) members.push(balances[index]!);
    }
    transfers.push(...simplifyGreedy(members));
    mask ^= group;
  }
  return transfers;
}

/**
 * Negative zero is a real JavaScript value and it is not `0` under strict
 * equality, so it can slip through a `=== 0` check and render as "-0.00".
 * Everything that produces a balance goes through here.
 */
export function normaliseCents(cents: Cents): Cents {
  return cents === 0 ? 0 : cents;
}

/** Apply transfers to balances — used by the tests to prove nothing is lost. */
export function applyTransfers(balances: Balance[], transfers: Transfer[]): Balance[] {
  const byId = new Map(balances.map((balance) => [balance.memberId, balance.cents]));
  for (const transfer of transfers) {
    byId.set(transfer.fromMemberId, (byId.get(transfer.fromMemberId) ?? 0) + transfer.cents);
    byId.set(transfer.toMemberId, (byId.get(transfer.toMemberId) ?? 0) - transfer.cents);
  }
  return [...byId].map(([memberId, cents]) => ({ memberId, cents: normaliseCents(cents) }));
}
