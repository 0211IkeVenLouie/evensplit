import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { closeDatabase, resetDatabase } from './helpers.js';
import { AppError } from '../src/errors.js';
import {
  addMember,
  computeBalances,
  createExpense,
  createGroup,
  deleteExpense,
  listExpenses,
  listMembers,
  loadLedger,
  recordSettlement,
  removeMember,
  type Group,
  type Member,
} from '../src/groups.js';

async function seedGroup(names = ['Ana', 'Ben', 'Cal']): Promise<{ group: Group; members: Member[] }> {
  const group = await createGroup({ name: 'Lisbon trip', memberNames: names, currency: 'EUR' });
  return { group, members: await listMembers(group.id) };
}

beforeEach(resetDatabase);
after(closeDatabase);

test('a new group starts empty and balanced', async () => {
  const { group } = await seedGroup();
  const ledger = await loadLedger(group);
  assert.equal(ledger.members.length, 3);
  assert.equal(ledger.expenses.length, 0);
  assert.equal(ledger.totalSpentCents, 0);
  assert.deepEqual(ledger.transfers, []);
  assert.ok(ledger.balances.every((balance) => balance.cents === 0));
});

test('one person pays, everyone shares: the split is exact to the cent', async () => {
  const { group, members } = await seedGroup();
  const [ana, ben, cal] = members;

  await createExpense({
    group,
    description: 'Dinner',
    amountCents: 10000, // €100.00 between three
    paidByMemberId: ana!.id,
    split: { mode: 'equal', memberIds: members.map((m) => m.id) },
  });

  const ledger = await loadLedger(group);
  const shares = ledger.expenses[0]!.shares.map((s) => s.shareCents);
  assert.deepEqual(shares, [3334, 3333, 3333]);
  assert.equal(shares.reduce((a, b) => a + b, 0), 10000, 'the shares must equal the bill');

  const balance = (id: string) => ledger.balances.find((b) => b.memberId === id)!.cents;
  assert.equal(balance(ana!.id), 10000 - 3334);
  assert.equal(balance(ben!.id), -3333);
  assert.equal(balance(cal!.id), -3333);
  assert.equal(ledger.balances.reduce((sum, b) => sum + b.cents, 0), 0, 'balances always sum to zero');
});

test('uneven splits: shares, percentages and exact amounts', async () => {
  const { group, members } = await seedGroup();
  const ids = members.map((m) => m.id);

  const byShares = await createExpense({
    group,
    description: 'Taxi — Ana had the big suitcase',
    amountCents: 9000,
    paidByMemberId: ids[0]!,
    split: { mode: 'shares', memberIds: ids, values: [2, 1, 1] },
  });
  assert.deepEqual(byShares.shares.map((s) => s.shareCents), [4500, 2250, 2250]);

  const byPercent = await createExpense({
    group,
    description: 'Apartment',
    amountCents: 30000,
    paidByMemberId: ids[1]!,
    split: { mode: 'percent', memberIds: ids, values: [50, 25, 25] },
  });
  assert.deepEqual(byPercent.shares.map((s) => s.shareCents), [15000, 7500, 7500]);

  const byExact = await createExpense({
    group,
    description: 'Museum tickets',
    amountCents: 4500,
    paidByMemberId: ids[2]!,
    split: { mode: 'exact', memberIds: ids, values: [2000, 2000, 500] },
  });
  assert.deepEqual(byExact.shares.map((s) => s.shareCents), [2000, 2000, 500]);

  const ledger = await loadLedger(group);
  assert.equal(ledger.balances.reduce((sum, b) => sum + b.cents, 0), 0);
  assert.equal(ledger.totalSpentCents, 9000 + 30000 + 4500);
});

test('an expense can leave people out of the split entirely', async () => {
  const { group, members } = await seedGroup();
  const [ana, ben, cal] = members;
  await createExpense({
    group,
    description: 'Two coffees',
    amountCents: 700,
    paidByMemberId: ana!.id,
    split: { mode: 'equal', memberIds: [ana!.id, ben!.id] },
  });
  const ledger = await loadLedger(group);
  assert.equal(ledger.balances.find((b) => b.memberId === cal!.id)!.cents, 0, 'Cal had no coffee');
  assert.equal(ledger.balances.find((b) => b.memberId === ben!.id)!.cents, -350);
});

test('a split that does not add up is refused', async () => {
  const { group, members } = await seedGroup();
  const ids = members.map((m) => m.id);
  await assert.rejects(
    () =>
      createExpense({
        group,
        description: 'Wrong',
        amountCents: 3000,
        paidByMemberId: ids[0]!,
        split: { mode: 'exact', memberIds: ids, values: [1000, 1000, 500] },
      }),
    (error: AppError) => error.code === 'INVALID' && /add up to 25\.00/.test(error.message),
  );
  await assert.rejects(
    () =>
      createExpense({
        group,
        description: 'Wrong percentages',
        amountCents: 3000,
        paidByMemberId: ids[0]!,
        split: { mode: 'percent', memberIds: ids, values: [50, 20, 20] },
      }),
    (error: AppError) => /not 100%/.test(error.message),
  );
  assert.equal((await listExpenses(group.id)).length, 0, 'nothing should have been written');
});

test('settling up: the plan clears every balance', async () => {
  const { group, members } = await seedGroup(['Ana', 'Ben', 'Cal', 'Dee']);
  const [ana, ben, cal, dee] = members;
  const everyone = members.map((m) => m.id);

  await createExpense({
    group, description: 'House', amountCents: 84000, paidByMemberId: ana!.id,
    split: { mode: 'equal', memberIds: everyone },
  });
  await createExpense({
    group, description: 'Groceries', amountCents: 12000, paidByMemberId: ben!.id,
    split: { mode: 'equal', memberIds: everyone },
  });
  await createExpense({
    group, description: 'Wine', amountCents: 4000, paidByMemberId: cal!.id,
    split: { mode: 'equal', memberIds: [ana!.id, cal!.id] },
  });

  const ledger = await loadLedger(group);
  assert.ok(ledger.transfers.length <= 3, 'four people should never need more than three transfers');

  // Paying the plan settles everyone exactly.
  for (const transfer of ledger.transfers) {
    await recordSettlement({
      group,
      fromMemberId: transfer.fromMemberId,
      toMemberId: transfer.toMemberId,
      amountCents: transfer.cents,
    });
  }
  const after = await loadLedger(group);
  assert.deepEqual(after.transfers, [], 'nothing left to settle');
  assert.ok(after.balances.every((b) => b.cents === 0), 'everyone is square');
  assert.ok(!after.balances.some((b) => Object.is(b.cents, -0)));
  assert.equal(dee!.name, 'Dee');
});

test('a partial payment leaves the right remainder', async () => {
  const { group, members } = await seedGroup(['Ana', 'Ben']);
  const [ana, ben] = members;
  await createExpense({
    group, description: 'Tickets', amountCents: 10000, paidByMemberId: ana!.id,
    split: { mode: 'equal', memberIds: [ana!.id, ben!.id] },
  });
  await recordSettlement({ group, fromMemberId: ben!.id, toMemberId: ana!.id, amountCents: 2000 });

  const ledger = await loadLedger(group);
  assert.equal(ledger.balances.find((b) => b.memberId === ben!.id)!.cents, -3000);
  assert.deepEqual(ledger.transfers, [
    { fromMemberId: ben!.id, toMemberId: ana!.id, cents: 3000 },
  ]);
});

test('deleting an expense unwinds it completely', async () => {
  const { group, members } = await seedGroup();
  const expense = await createExpense({
    group, description: 'Mistake', amountCents: 5000, paidByMemberId: members[0]!.id,
    split: { mode: 'equal', memberIds: members.map((m) => m.id) },
  });
  await deleteExpense(group.id, expense.id);
  const ledger = await loadLedger(group);
  assert.equal(ledger.expenses.length, 0);
  assert.ok(ledger.balances.every((b) => b.cents === 0));
  await assert.rejects(() => deleteExpense(group.id, expense.id), (e: AppError) => e.code === 'NOT_FOUND');
});

test('members cannot be duplicated, and cannot be removed once they owe something', async () => {
  const { group, members } = await seedGroup();
  await assert.rejects(() => addMember(group.id, 'Ana'), (e: AppError) => e.code === 'CONFLICT');

  const dee = await addMember(group.id, 'Dee');
  await removeMember(group.id, dee.id); // fine, no history
  assert.equal((await listMembers(group.id)).length, 3);

  await createExpense({
    group, description: 'Lunch', amountCents: 3000, paidByMemberId: members[0]!.id,
    split: { mode: 'equal', memberIds: members.map((m) => m.id) },
  });
  await assert.rejects(
    () => removeMember(group.id, members[1]!.id),
    (error: AppError) => error.code === 'CONFLICT' && /part of an expense/.test(error.message),
  );
});

test('an expense cannot involve someone from another group', async () => {
  const { group } = await seedGroup();
  const other = await createGroup({ name: 'Other', memberNames: ['Zed'] });
  const zed = (await listMembers(other.id))[0]!;
  const ours = await listMembers(group.id);

  await assert.rejects(
    () =>
      createExpense({
        group, description: 'Sneaky', amountCents: 1000, paidByMemberId: zed.id,
        split: { mode: 'equal', memberIds: ours.map((m) => m.id) },
      }),
    (error: AppError) => /not in this group/.test(error.message),
  );
  await assert.rejects(
    () =>
      createExpense({
        group, description: 'Sneaky', amountCents: 1000, paidByMemberId: ours[0]!.id,
        split: { mode: 'equal', memberIds: [ours[0]!.id, zed.id] },
      }),
    (error: AppError) => /not in this group/.test(error.message),
  );
});

test('balances survive a long, messy history without drifting', async () => {
  const { group, members } = await seedGroup(['Ana', 'Ben', 'Cal', 'Dee', 'Eve']);
  const ids = members.map((m) => m.id);

  for (let i = 0; i < 40; i += 1) {
    const participants = ids.filter((_, index) => (i + index) % 3 !== 0);
    if (participants.length === 0) continue;
    await createExpense({
      group,
      description: `Expense ${i}`,
      // Deliberately awkward amounts that do not divide evenly.
      amountCents: 997 + i * 13,
      paidByMemberId: ids[i % ids.length]!,
      split: { mode: 'equal', memberIds: participants },
    });
  }

  const ledger = await loadLedger(group);
  const total = ledger.balances.reduce((sum, b) => sum + b.cents, 0);
  assert.equal(total, 0, 'forty awkward splits and not one cent lost');

  // Every expense's shares still reconcile with its amount.
  for (const expense of ledger.expenses) {
    assert.equal(
      expense.shares.reduce((sum, share) => sum + share.shareCents, 0),
      expense.amountCents,
      `expense ${expense.description} does not reconcile`,
    );
  }

  for (const transfer of ledger.transfers) {
    await recordSettlement({
      group, fromMemberId: transfer.fromMemberId, toMemberId: transfer.toMemberId, amountCents: transfer.cents,
    });
  }
  assert.deepEqual((await loadLedger(group)).transfers, []);
});

test('computeBalances is pure and agrees with the database', async () => {
  const { group, members } = await seedGroup();
  await createExpense({
    group, description: 'Test', amountCents: 1000, paidByMemberId: members[0]!.id,
    split: { mode: 'equal', memberIds: members.map((m) => m.id) },
  });
  const ledger = await loadLedger(group);
  const recomputed = computeBalances({
    members: ledger.members,
    expenses: ledger.expenses,
    settlements: ledger.settlements,
  });
  assert.deepEqual(recomputed, ledger.balances);
});
