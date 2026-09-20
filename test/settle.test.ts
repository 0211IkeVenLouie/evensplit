import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyTransfers,
  simplify,
  simplifyGreedy,
  simplifyOptimal,
  type Balance,
  type Transfer,
} from '../src/settle.js';

function balances(values: Record<string, number>): Balance[] {
  return Object.entries(values).map(([memberId, cents]) => ({ memberId, cents }));
}

function assertSettles(input: Balance[], transfers: Transfer[]): void {
  for (const transfer of transfers) {
    assert.notEqual(transfer.fromMemberId, transfer.toMemberId, 'nobody pays themselves');
    assert.ok(transfer.cents > 0, 'every transfer moves a positive amount');
    assert.ok(Number.isInteger(transfer.cents), 'transfers are whole cents');
  }
  for (const balance of applyTransfers(input, transfers)) {
    assert.equal(balance.cents, 0, `${balance.memberId} is not settled`);
  }
}

test('nobody owes anybody', () => {
  assert.deepEqual(simplify([]), []);
  assert.deepEqual(simplify(balances({ ana: 0, ben: 0 })), []);
});

test('the simplest debt is one transfer', () => {
  const input = balances({ ana: -1500, ben: 1500 });
  const transfers = simplify(input);
  assert.deepEqual(transfers, [{ fromMemberId: 'ana', toMemberId: 'ben', cents: 1500 }]);
  assertSettles(input, transfers);
});

test('a chain of debts collapses: Ana → Ben → Cal becomes Ana → Cal', () => {
  // Ana owes Ben $10, Ben owes Cal $10. Net: Ana -10, Ben 0, Cal +10.
  const input = balances({ ana: -1000, ben: 0, cal: 1000 });
  const transfers = simplify(input);
  assert.equal(transfers.length, 1, 'Ben should not have to touch the money');
  assert.deepEqual(transfers[0], { fromMemberId: 'ana', toMemberId: 'cal', cents: 1000 });
  assertSettles(input, transfers);
});

test('a realistic weekend: four people, three transfers at most', () => {
  // Ana paid for the house, Ben for dinner, nobody else paid anything.
  const input = balances({ ana: 42000, ben: 6000, cal: -24000, dee: -24000 });
  const transfers = simplify(input);
  assertSettles(input, transfers);
  assert.ok(transfers.length <= 3, `expected at most 3 transfers, got ${transfers.length}`);
});

test('the exact solver beats the greedy one when the balances line up', () => {
  // Ben and Eve cancel each other out exactly, so they should settle between
  // themselves and stay out of everyone else's way. Greedy does not notice.
  const input = balances({ ana: -600, ben: -600, cal: -400, dee: 1000, eve: 600 });

  const greedy = simplifyGreedy(input);
  const optimal = simplifyOptimal(input);
  assertSettles(input, greedy);
  assertSettles(input, optimal);

  assert.equal(greedy.length, 4, 'greedy matching needs four transfers here');
  assert.equal(optimal.length, 3, 'three is the true minimum');
  assert.equal(simplify(input).length, 3, 'simplify() should pick the exact solver at this size');
});

test('the minimum is n minus the number of zero-sum groups', () => {
  // Two independent pairs: {ana, ben} and {cal, dee}. Four people, two groups,
  // so two transfers — and crucially no transfer between the pairs.
  const input = balances({ ana: -500, ben: 500, cal: -300, dee: 300 });
  const transfers = simplify(input);
  assert.equal(transfers.length, 2);
  assertSettles(input, transfers);
  const crossing = transfers.filter(
    (t) => ['ana', 'ben'].includes(t.fromMemberId) !== ['ana', 'ben'].includes(t.toMemberId),
  );
  assert.equal(crossing.length, 0, 'the two pairs should not be mixed together');
});

test('people already square are left out of the plan entirely', () => {
  const input = balances({ ana: -1000, ben: 0, cal: 1000, dee: 0 });
  const transfers = simplify(input);
  const involved = new Set(transfers.flatMap((t) => [t.fromMemberId, t.toMemberId]));
  assert.deepEqual([...involved].sort(), ['ana', 'cal']);
});

test('balances that do not sum to zero are a bug, and say so', () => {
  assert.throws(() => simplify(balances({ ana: -100, ben: 50 })), /must sum to zero/);
});

test('randomised: always settles, never exceeds n-1, and beats or matches greedy', () => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const count = 2 + Math.floor(Math.random() * 7);
    const values: number[] = [];
    for (let i = 0; i < count - 1; i += 1) values.push(Math.floor(Math.random() * 20001) - 10000);
    // `-0` is a legal JavaScript number and not `0` under Object.is, so the
    // generator normalises it the same way the production code does.
    values.push(-values.reduce((acc, value) => acc + value, 0) || 0);

    const input = values.map((cents, index) => ({ memberId: `m${index}`, cents }));
    const nonZero = input.filter((b) => b.cents !== 0).length;

    const transfers = simplify(input);
    assertSettles(input, transfers);
    assert.ok(
      transfers.length <= Math.max(0, nonZero - 1),
      `${transfers.length} transfers for ${nonZero} people`,
    );
    assert.ok(
      transfers.length <= simplifyGreedy(input.filter((b) => b.cents !== 0)).length,
      'the exact solver must never be worse than greedy',
    );
  }
});

test('a negative-zero balance counts as settled', () => {
  const input = [
    { memberId: 'ana', cents: -0 },
    { memberId: 'ben', cents: -500 },
    { memberId: 'cal', cents: 500 },
  ];
  const transfers = simplify(input);
  assert.equal(transfers.length, 1);
  assert.ok(
    !transfers.some((t) => t.fromMemberId === 'ana' || t.toMemberId === 'ana'),
    'Ana is square and stays out of it',
  );
  for (const balance of applyTransfers(input, transfers)) {
    assert.equal(Object.is(balance.cents, -0), false, 'no negative zero escapes');
    assert.equal(balance.cents, 0);
  }
});

test('the greedy fallback still settles a large group correctly', () => {
  const count = 40;
  const values: number[] = [];
  for (let i = 0; i < count - 1; i += 1) values.push(((i * 7919) % 2001) - 1000);
  values.push(-values.reduce((acc, value) => acc + value, 0));
  const input = values.map((cents, index) => ({ memberId: `m${index}`, cents }));

  const transfers = simplify(input); // over EXACT_SEARCH_LIMIT, so greedy
  assertSettles(input, transfers);
  assert.ok(transfers.length <= input.filter((b) => b.cents !== 0).length - 1);
});
