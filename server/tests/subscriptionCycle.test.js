const test = require('node:test');
const assert = require('node:assert/strict');
const { cycleContaining } = require('../services/subscriptionCycle');

test('8 Sep cycle ends 7 Oct, next starts 8 Oct', () => {
  assert.deepEqual(cycleContaining('2026-09-08', '2026-09-08'), { index: 0, start: '2026-09-08', end: '2026-10-07' });
  assert.deepEqual(cycleContaining('2026-09-08', '2026-10-07'), { index: 0, start: '2026-09-08', end: '2026-10-07' });
  assert.deepEqual(cycleContaining('2026-09-08', '2026-10-08'), { index: 1, start: '2026-10-08', end: '2026-11-07' });
});
test('not started yet -> no cycle', () => {
  assert.equal(cycleContaining('2026-09-08', '2026-09-07'), null);
});
test('anchor on the 31st keeps the anniversary through short months', () => {
  assert.deepEqual(cycleContaining('2026-01-31', '2026-02-28'), { index: 1, start: '2026-02-28', end: '2026-03-30' });
  assert.deepEqual(cycleContaining('2026-01-31', '2026-03-31'), { index: 2, start: '2026-03-31', end: '2026-04-29' });
});
test('leap year and year rollover', () => {
  assert.deepEqual(cycleContaining('2027-12-29', '2028-02-29'), { index: 2, start: '2028-02-29', end: '2028-03-28' });
  assert.deepEqual(cycleContaining('2026-12-15', '2027-01-14'), { index: 0, start: '2026-12-15', end: '2027-01-14' });
});
test('quarterly and yearly', () => {
  assert.deepEqual(cycleContaining('2026-01-10', '2026-05-01', 'QUARTERLY'), { index: 1, start: '2026-04-10', end: '2026-07-09' });
  assert.deepEqual(cycleContaining('2026-01-10', '2027-01-09', 'YEARLY'), { index: 0, start: '2026-01-10', end: '2027-01-09' });
});
test('bad input throws', () => {
  assert.throws(() => cycleContaining('2026-02-30', '2026-03-01'));
  assert.throws(() => cycleContaining('2026-01-01', '2026-03-01', 'WEEKLY'));
});
