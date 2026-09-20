import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';
import { migrate } from './migrate.js';
import {
  createExpense,
  createGroup,
  getDemoGroup,
  listMembers,
  recordSettlement,
  type Group,
  type SplitMode,
} from './groups.js';

const DEMO_SLUG = 'lisbon-weekend';

interface SeedExpense {
  description: string;
  amount: number;
  paidBy: number;
  mode: SplitMode;
  /** Indices into the member list; omit for everyone. */
  between?: number[];
  values?: number[];
  daysAgo: number;
}

const EXPENSES: SeedExpense[] = [
  { description: 'Apartment, three nights', amount: 48600, paidBy: 0, mode: 'equal', daysAgo: 6 },
  { description: 'Flights (booked together)', amount: 71200, paidBy: 1, mode: 'exact', values: [18400, 17600, 17900, 17300], daysAgo: 6 },
  { description: 'Airport taxi', amount: 4250, paidBy: 2, mode: 'equal', daysAgo: 5 },
  { description: 'Groceries', amount: 8735, paidBy: 0, mode: 'equal', daysAgo: 5 },
  { description: 'Dinner at Ramiro — Ana had the lobster', amount: 16400, paidBy: 3, mode: 'shares', values: [2, 1, 1, 1], daysAgo: 4 },
  { description: 'Tram passes', amount: 3000, paidBy: 1, mode: 'equal', daysAgo: 4 },
  { description: 'Surf lesson', amount: 12000, paidBy: 2, mode: 'equal', between: [1, 2, 3], daysAgo: 3 },
  { description: 'Pastéis de Belém', amount: 1450, paidBy: 3, mode: 'equal', daysAgo: 3 },
  { description: 'Tiles for Dee’s kitchen', amount: 6800, paidBy: 0, mode: 'exact', values: [0, 0, 0, 6800], daysAgo: 2 },
  { description: 'Last dinner', amount: 21300, paidBy: 1, mode: 'percent', values: [30, 30, 20, 20], daysAgo: 1 },
];

function dateKeyDaysAgo(days: number): string {
  const date = new Date(Date.now() - days * 86400_000);
  return date.toISOString().slice(0, 10);
}

/**
 * The demo group is the first thing anyone sees. It has enough history that the
 * balances are non-obvious and the settle-up plan has something to simplify.
 */
export async function seedDemoGroup(): Promise<Group> {
  const existing = await getDemoGroup();
  if (existing) return existing;

  const group = await createGroup({
    name: 'Lisbon weekend',
    currency: 'EUR',
    slug: DEMO_SLUG,
    isDemo: true,
    memberNames: ['Ana', 'Ben', 'Cal', 'Dee'],
  });
  const members = await listMembers(group.id);
  const ids = members.map((member) => member.id);

  for (const expense of EXPENSES) {
    const participants = (expense.between ?? ids.map((_, index) => index)).map((index) => ids[index]!);
    const values = expense.values
      ? expense.between
        ? expense.between.map((index) => expense.values![index]!)
        : expense.values
      : undefined;
    await createExpense({
      group,
      description: expense.description,
      amountCents: expense.amount,
      paidByMemberId: ids[expense.paidBy]!,
      spentOn: dateKeyDaysAgo(expense.daysAgo),
      split: { mode: expense.mode, memberIds: participants, values },
    });
  }

  // One payment already made, so the settle-up page shows a partial history.
  await recordSettlement({
    group,
    fromMemberId: ids[2]!,
    toMemberId: ids[0]!,
    amountCents: 10000,
    note: 'Sent by bank transfer',
  });

  console.log(`Seeded demo group at /g/${group.slug}`);
  return group;
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntrypoint) {
  migrate()
    .then(seedDemoGroup)
    .then(() => pool.end())
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
