import { one, query, transaction } from './db.js';
import { AppError } from './errors.js';
import {
  allocate,
  splitByPercent,
  splitByShares,
  splitEqually,
  splitExactly,
  type Cents,
} from './money.js';
import { normaliseCents, simplify, type Balance, type Transfer } from './settle.js';

export type SplitMode = 'equal' | 'shares' | 'percent' | 'exact';

export interface Group {
  id: string;
  slug: string;
  name: string;
  currency: string;
  isDemo: boolean;
}

export interface Member {
  id: string;
  groupId: string;
  name: string;
}

export interface Expense {
  id: string;
  groupId: string;
  description: string;
  amountCents: Cents;
  paidByMemberId: string;
  splitMode: SplitMode;
  spentOn: string;
  shares: Array<{ memberId: string; shareCents: Cents }>;
}

export interface Settlement {
  id: string;
  groupId: string;
  fromMemberId: string;
  toMemberId: string;
  amountCents: Cents;
  note: string;
  settledAt: Date;
}

const SLUG_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

export function randomSlug(length = 10): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += SLUG_ALPHABET[Math.floor(Math.random() * SLUG_ALPHABET.length)];
  return out;
}

/* ---------------------------------------------------------------- groups */

export async function createGroup(input: {
  name: string;
  currency?: string;
  memberNames?: string[];
  slug?: string;
  isDemo?: boolean;
}): Promise<Group> {
  const name = input.name.trim().slice(0, 120) || 'Untitled group';
  return transaction(async (client) => {
    const row = (
      await client.query<{ id: string; slug: string; name: string; currency: string; is_demo: boolean }>(
        `INSERT INTO groups (slug, name, currency, is_demo) VALUES ($1, $2, $3, $4)
         RETURNING id, slug, name, currency, is_demo`,
        [input.slug ?? randomSlug(), name, (input.currency ?? 'USD').toUpperCase().slice(0, 3), input.isDemo ?? false],
      )
    ).rows[0]!;

    for (const memberName of input.memberNames ?? []) {
      const trimmed = memberName.trim().slice(0, 60);
      if (!trimmed) continue;
      await client.query(
        'INSERT INTO members (group_id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [row.id, trimmed],
      );
    }
    return { id: row.id, slug: row.slug, name: row.name, currency: row.currency, isDemo: row.is_demo };
  });
}

export async function getGroupBySlug(slug: string): Promise<Group | undefined> {
  const row = await one<{ id: string; slug: string; name: string; currency: string; is_demo: boolean }>(
    'SELECT id, slug, name, currency, is_demo FROM groups WHERE slug = $1',
    [slug],
  );
  return row ? { id: row.id, slug: row.slug, name: row.name, currency: row.currency, isDemo: row.is_demo } : undefined;
}

export async function getDemoGroup(): Promise<Group | undefined> {
  const row = await one<{ id: string; slug: string; name: string; currency: string; is_demo: boolean }>(
    'SELECT id, slug, name, currency, is_demo FROM groups WHERE is_demo = true ORDER BY created_at LIMIT 1',
  );
  return row ? { id: row.id, slug: row.slug, name: row.name, currency: row.currency, isDemo: row.is_demo } : undefined;
}

/* --------------------------------------------------------------- members */

export async function listMembers(groupId: string): Promise<Member[]> {
  const rows = await query<{ id: string; group_id: string; name: string }>(
    'SELECT id, group_id, name FROM members WHERE group_id = $1 ORDER BY created_at, name',
    [groupId],
  );
  return rows.map((row) => ({ id: row.id, groupId: row.group_id, name: row.name }));
}

export async function addMember(groupId: string, name: string): Promise<Member> {
  const trimmed = name.trim().slice(0, 60);
  if (!trimmed) throw new AppError('INVALID', 'Give them a name.');
  try {
    const row = await one<{ id: string; group_id: string; name: string }>(
      'INSERT INTO members (group_id, name) VALUES ($1, $2) RETURNING id, group_id, name',
      [groupId, trimmed],
    );
    return { id: row!.id, groupId: row!.group_id, name: row!.name };
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new AppError('CONFLICT', `${trimmed} is already in this group.`);
    }
    throw error;
  }
}

/**
 * Removing someone is only safe while they have no history — otherwise the
 * group's books would stop balancing. Better to refuse than to quietly rewrite
 * what people already agreed.
 */
export async function removeMember(groupId: string, memberId: string): Promise<void> {
  const involved = await one<{ count: number }>(
    `SELECT (
       (SELECT COUNT(*) FROM expenses WHERE paid_by_member_id = $1)
     + (SELECT COUNT(*) FROM expense_shares WHERE member_id = $1)
     + (SELECT COUNT(*) FROM settlements WHERE from_member_id = $1 OR to_member_id = $1)
     )::int AS count`,
    [memberId],
  );
  if ((involved?.count ?? 0) > 0) {
    throw new AppError('CONFLICT', 'They are part of an expense already, so they cannot be removed.');
  }
  await query('DELETE FROM members WHERE id = $1 AND group_id = $2', [memberId, groupId]);
}

/* -------------------------------------------------------------- expenses */

export interface SplitInput {
  mode: SplitMode;
  /** Member ids taking part, in the order the numbers below refer to. */
  memberIds: string[];
  /** For 'shares' whole numbers, for 'percent' percentages, for 'exact' cents. */
  values?: number[];
}

/** Turn a split request into exact cents per member, summing to the total. */
export function computeShares(amountCents: Cents, split: SplitInput): Array<{ memberId: string; shareCents: Cents }> {
  if (split.memberIds.length === 0) throw new AppError('INVALID', 'Choose who this is split between.');

  let amounts: Cents[];
  try {
    switch (split.mode) {
      case 'equal':
        amounts = splitEqually(amountCents, split.memberIds.length);
        break;
      case 'shares':
        amounts = splitByShares(amountCents, requireValues(split));
        break;
      case 'percent':
        amounts = splitByPercent(amountCents, requireValues(split));
        break;
      case 'exact':
        amounts = splitExactly(amountCents, requireValues(split));
        break;
      default:
        amounts = allocate(amountCents, new Array(split.memberIds.length).fill(1));
    }
  } catch (error) {
    throw new AppError('INVALID', (error as Error).message);
  }

  return split.memberIds.map((memberId, index) => ({ memberId, shareCents: amounts[index] ?? 0 }));
}

function requireValues(split: SplitInput): number[] {
  if (!split.values || split.values.length !== split.memberIds.length) {
    throw new AppError('INVALID', 'Give a number for each person in the split.');
  }
  return split.values;
}

export async function createExpense(input: {
  group: Group;
  description: string;
  amountCents: Cents;
  paidByMemberId: string;
  split: SplitInput;
  spentOn?: string;
}): Promise<Expense> {
  const description = input.description.trim().slice(0, 200);
  if (!description) throw new AppError('INVALID', 'What was it for?');
  if (input.amountCents <= 0) throw new AppError('INVALID', 'The amount must be more than zero.');

  const members = await listMembers(input.group.id);
  const known = new Set(members.map((member) => member.id));
  if (!known.has(input.paidByMemberId)) throw new AppError('INVALID', 'That payer is not in this group.');
  if (input.split.memberIds.some((id) => !known.has(id))) {
    throw new AppError('INVALID', 'Someone in that split is not in this group.');
  }

  const shares = computeShares(input.amountCents, input.split);
  // Belt and braces: the allocator guarantees this, and a bug here would
  // silently create or destroy money.
  const sum = shares.reduce((acc, share) => acc + share.shareCents, 0);
  if (sum !== input.amountCents) {
    throw new Error(`Split does not add up: ${sum} != ${input.amountCents}`);
  }

  return transaction(async (client) => {
    const row = (
      await client.query<{ id: string; spent_on: string }>(
        `INSERT INTO expenses (group_id, description, amount_cents, paid_by_member_id, split_mode, spent_on)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, CURRENT_DATE))
         RETURNING id, to_char(spent_on, 'YYYY-MM-DD') AS spent_on`,
        [
          input.group.id,
          description,
          input.amountCents,
          input.paidByMemberId,
          input.split.mode,
          input.spentOn ?? null,
        ],
      )
    ).rows[0]!;

    for (const share of shares) {
      await client.query(
        'INSERT INTO expense_shares (expense_id, member_id, share_cents) VALUES ($1, $2, $3)',
        [row.id, share.memberId, share.shareCents],
      );
    }

    return {
      id: row.id,
      groupId: input.group.id,
      description,
      amountCents: input.amountCents,
      paidByMemberId: input.paidByMemberId,
      splitMode: input.split.mode,
      spentOn: row.spent_on,
      shares,
    };
  });
}

export async function deleteExpense(groupId: string, expenseId: string): Promise<void> {
  const deleted = await query('DELETE FROM expenses WHERE id = $1 AND group_id = $2 RETURNING id', [
    expenseId,
    groupId,
  ]);
  if (deleted.length === 0) throw new AppError('NOT_FOUND', 'That expense is already gone.');
}

export async function listExpenses(groupId: string): Promise<Expense[]> {
  const rows = await query<{
    id: string;
    description: string;
    amount_cents: string | number;
    paid_by_member_id: string;
    split_mode: SplitMode;
    spent_on: string;
    shares: Array<{ member_id: string; share_cents: string | number }>;
  }>(
    `SELECT e.id, e.description, e.amount_cents, e.paid_by_member_id, e.split_mode,
            to_char(e.spent_on, 'YYYY-MM-DD') AS spent_on,
            COALESCE(
              (SELECT json_agg(json_build_object('member_id', s.member_id, 'share_cents', s.share_cents))
                 FROM expense_shares s WHERE s.expense_id = e.id),
              '[]'::json
            ) AS shares
       FROM expenses e
      WHERE e.group_id = $1
      ORDER BY e.spent_on DESC, e.created_at DESC`,
    [groupId],
  );
  return rows.map((row) => ({
    id: row.id,
    groupId,
    description: row.description,
    amountCents: Number(row.amount_cents),
    paidByMemberId: row.paid_by_member_id,
    splitMode: row.split_mode,
    spentOn: row.spent_on,
    shares: row.shares.map((share) => ({
      memberId: share.member_id,
      shareCents: Number(share.share_cents),
    })),
  }));
}

/* ----------------------------------------------------------- settlements */

export async function recordSettlement(input: {
  group: Group;
  fromMemberId: string;
  toMemberId: string;
  amountCents: Cents;
  note?: string;
}): Promise<Settlement> {
  if (input.amountCents <= 0) throw new AppError('INVALID', 'A payment has to be more than zero.');
  if (input.fromMemberId === input.toMemberId) throw new AppError('INVALID', 'That is the same person.');

  const row = await one<{
    id: string;
    from_member_id: string;
    to_member_id: string;
    amount_cents: string | number;
    note: string;
    settled_at: Date;
  }>(
    `INSERT INTO settlements (group_id, from_member_id, to_member_id, amount_cents, note)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, from_member_id, to_member_id, amount_cents, note, settled_at`,
    [input.group.id, input.fromMemberId, input.toMemberId, input.amountCents, (input.note ?? '').slice(0, 200)],
  );
  return {
    id: row!.id,
    groupId: input.group.id,
    fromMemberId: row!.from_member_id,
    toMemberId: row!.to_member_id,
    amountCents: Number(row!.amount_cents),
    note: row!.note,
    settledAt: row!.settled_at,
  };
}

export async function listSettlements(groupId: string): Promise<Settlement[]> {
  const rows = await query<{
    id: string;
    from_member_id: string;
    to_member_id: string;
    amount_cents: string | number;
    note: string;
    settled_at: Date;
  }>(
    `SELECT id, from_member_id, to_member_id, amount_cents, note, settled_at
       FROM settlements WHERE group_id = $1 ORDER BY settled_at DESC`,
    [groupId],
  );
  return rows.map((row) => ({
    id: row.id,
    groupId,
    fromMemberId: row.from_member_id,
    toMemberId: row.to_member_id,
    amountCents: Number(row.amount_cents),
    note: row.note,
    settledAt: row.settled_at,
  }));
}

export async function deleteSettlement(groupId: string, settlementId: string): Promise<void> {
  await query('DELETE FROM settlements WHERE id = $1 AND group_id = $2', [settlementId, groupId]);
}

/* -------------------------------------------------------------- balances */

export interface GroupLedger {
  members: Member[];
  expenses: Expense[];
  settlements: Settlement[];
  balances: Balance[];
  transfers: Transfer[];
  totalSpentCents: Cents;
}

/**
 * A member's balance is what they have put in minus what they consumed:
 *
 *     paid for expenses  −  their share of expenses  +  payments made  −  payments received
 *
 * A settlement is just a transfer of "having paid", which is why it lands in
 * the same sum rather than needing a separate concept of a debt being closed.
 * Over a whole group these cancel exactly, so the balances always sum to zero —
 * and `simplify` refuses to run if they do not, because that would mean a bug
 * here rather than an unusual group.
 */
export function computeBalances(input: {
  members: Member[];
  expenses: Expense[];
  settlements: Settlement[];
}): Balance[] {
  const totals = new Map<string, Cents>(input.members.map((member) => [member.id, 0]));
  const add = (memberId: string, cents: Cents) => {
    if (!totals.has(memberId)) totals.set(memberId, 0);
    totals.set(memberId, totals.get(memberId)! + cents);
  };

  for (const expense of input.expenses) {
    add(expense.paidByMemberId, expense.amountCents);
    for (const share of expense.shares) add(share.memberId, -share.shareCents);
  }
  for (const settlement of input.settlements) {
    add(settlement.fromMemberId, settlement.amountCents);
    add(settlement.toMemberId, -settlement.amountCents);
  }

  return [...totals].map(([memberId, cents]) => ({ memberId, cents: normaliseCents(cents) }));
}

export async function loadLedger(group: Group): Promise<GroupLedger> {
  const [members, expenses, settlements] = await Promise.all([
    listMembers(group.id),
    listExpenses(group.id),
    listSettlements(group.id),
  ]);
  const balances = computeBalances({ members, expenses, settlements });
  return {
    members,
    expenses,
    settlements,
    balances,
    transfers: simplify(balances),
    totalSpentCents: expenses.reduce((sum, expense) => sum + expense.amountCents, 0),
  };
}
