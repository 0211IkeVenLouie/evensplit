import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MoneyError,
  allocate,
  formatAmount,
  formatMoney,
  parseMoney,
  splitByPercent,
  splitByShares,
  splitEqually,
  splitExactly,
} from '../src/money.js';

test('money is parsed into whole cents', () => {
  assert.equal(parseMoney('12.34'), 1234);
  assert.equal(parseMoney('12'), 1200);
  assert.equal(parseMoney('12.3'), 1230);
  assert.equal(parseMoney('0.05'), 5);
  assert.equal(parseMoney('$1,234.56'), 123456);
  assert.equal(parseMoney(' 40 '), 4000);
  assert.equal(parseMoney('-8.50'), -850);
});

test('input that is not exactly representable in cents is refused, not rounded', () => {
  assert.throws(() => parseMoney('12.345'), MoneyError);
  assert.throws(() => parseMoney('0.005'), MoneyError);
  assert.throws(() => parseMoney('twelve'), MoneyError);
  assert.throws(() => parseMoney(''), MoneyError);
  assert.throws(() => parseMoney('1e5'), MoneyError);
});

test('formatting round-trips', () => {
  assert.equal(formatAmount(1234), '12.34');
  assert.equal(formatAmount(5), '0.05');
  assert.equal(formatAmount(-850), '-8.50');
  assert.equal(formatAmount(0), '0.00');
  assert.equal(parseMoney(formatAmount(99999)), 99999);
  assert.equal(formatMoney(1234, 'USD'), '$12.34');
  assert.equal(formatMoney(1234, 'EUR', 'de-DE').replace(/ /g, ' '), '12,34 €');
});

test('an even split of an odd amount loses no cents', () => {
  const parts = splitEqually(1000, 3);
  assert.deepEqual(parts, [334, 333, 333]);
  assert.equal(sum(parts), 1000);
});

test('the leftover cent is deterministic, not random', () => {
  for (let i = 0; i < 20; i += 1) {
    assert.deepEqual(splitEqually(1000, 3), [334, 333, 333]);
  }
});

test('no amount of splitting invents or destroys money', () => {
  for (let total = 0; total <= 2000; total += 7) {
    for (let people = 1; people <= 9; people += 1) {
      const parts = splitEqually(total, people);
      assert.equal(sum(parts), total, `${total} between ${people}`);
      assert.equal(parts.length, people);
      // The parts differ by at most one cent, which is the fairest an integer
      // split can be.
      assert.ok(Math.max(...parts) - Math.min(...parts) <= 1);
    }
  }
});

test('percentages split exactly and must add up to 100', () => {
  assert.deepEqual(splitByPercent(10000, [50, 50]), [5000, 5000]);
  assert.deepEqual(splitByPercent(10000, [33.33, 33.33, 33.34]), [3333, 3333, 3334]);
  const awkward = splitByPercent(10001, [33.33, 33.33, 33.34]);
  assert.equal(sum(awkward), 10001);
  assert.throws(() => splitByPercent(1000, [50, 30]), /not 100%/);
});

test('shares let one person count for more', () => {
  // Ana had the steak and counts double.
  assert.deepEqual(splitByShares(9000, [2, 1, 1]), [4500, 2250, 2250]);
  assert.equal(sum(splitByShares(10000, [2, 1, 1, 1])), 10000);
  assert.throws(() => splitByShares(1000, [1.5, 1]), /whole numbers/);
  assert.throws(() => splitByShares(1000, [0, 0]), /at least one/i);
});

test('a zero share means a zero amount, even when cents are left over', () => {
  const parts = allocate(100, [1, 1, 0]);
  assert.equal(parts[2], 0, 'someone who is not in on the expense pays nothing');
  assert.equal(sum(parts), 100);
});

test('exact amounts are checked against the total', () => {
  assert.deepEqual(splitExactly(3000, [1000, 500, 1500]), [1000, 500, 1500]);
  assert.throws(() => splitExactly(3000, [1000, 500, 1000]), /add up to 25\.00/);
});

test('an uneven weighting still adds up over many totals', () => {
  for (let total = 1; total < 500; total += 1) {
    const parts = allocate(total, [3, 1, 1, 7]);
    assert.equal(sum(parts), total);
    assert.ok(parts.every((part) => part >= 0));
  }
});

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}
