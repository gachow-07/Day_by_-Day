'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { core, stats, withHabits, play } = require('./helpers.js');

test('validates date keys', () => {
  assert.equal(core.isValidDateKey('2026-09-28'), true);
  assert.equal(core.isValidDateKey('2026-02-29'), false, '2026 is not a leap year');
  assert.equal(core.isValidDateKey('2028-02-29'), true);
  assert.equal(core.isValidDateKey('2026-13-01'), false);
  assert.equal(core.isValidDateKey('2026-04-31'), false);
  assert.equal(core.isValidDateKey('2026-9-28'), false);
  assert.equal(core.isValidDateKey('not a date'), false);
  assert.equal(core.isValidDateKey(20260928), false);
  assert.equal(core.isValidDateKey(null), false);
});

test('toDateKey uses the local calendar date', () => {
  assert.equal(core.toDateKey(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.equal(core.toDateKey(new Date(2026, 0, 6, 0, 0)), '2026-01-06');
});

test('addDays and daysBetween cross month boundaries', () => {
  assert.equal(core.addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(core.addDays('2026-04-30', 1), '2026-05-01');
  assert.equal(core.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(core.daysBetween('2026-01-31', '2026-02-01'), 1);
  assert.equal(core.daysBetween('2026-02-01', '2026-01-31'), -1);
});

test('addDays and daysBetween cross year boundaries', () => {
  assert.equal(core.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(core.addDays('2027-01-01', -1), '2026-12-31');
  assert.equal(core.daysBetween('2026-12-31', '2027-01-01'), 1);
  assert.equal(core.daysBetween('2026-01-01', '2027-01-01'), 365);
});

test('date math is unaffected by daylight saving transitions', () => {
  // US and EU DST changes happen in March/October/November.
  assert.equal(core.daysBetween('2026-03-07', '2026-03-09'), 2);
  assert.equal(core.addDays('2026-03-29', 1), '2026-03-30');
  assert.equal(core.daysBetween('2026-10-24', '2026-11-02'), 9);
});

test('leap years follow the Gregorian rules', () => {
  assert.equal(core.isLeapYear(2024), true);
  assert.equal(core.isLeapYear(2026), false);
  assert.equal(core.isLeapYear(2000), true);
  assert.equal(core.isLeapYear(2100), false);
  assert.equal(core.daysInMonth(2028, 2), 29);
  assert.equal(core.daysInMonth(2027, 2), 28);
  assert.equal(core.addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(core.addDays('2028-02-29', 1), '2028-03-01');
  assert.equal(core.addDays('2027-02-28', 1), '2027-03-01');
  assert.equal(core.daysBetween('2028-01-01', '2029-01-01'), 366);
});

test('a streak runs through a month boundary', () => {
  const s = play(withHabits('2026-01-30'), '2026-01-30', '✓✓✓✓'); // Jan 30 – Feb 2
  assert.equal(stats.currentStreak(s, '2026-02-02'), 4);
  assert.deepEqual(Object.keys(s.days).sort(), ['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02']);
});

test('a streak runs through New Year', () => {
  const s = play(withHabits('2026-12-30'), '2026-12-30', '✓✓✓'); // Dec 30 – Jan 1
  assert.equal(stats.currentStreak(s, '2027-01-01'), 3);
  // Next morning, before ticking anything, the streak is still alive.
  assert.equal(stats.currentStreak(core.ensureDays(s, '2027-01-02').state, '2027-01-02'), 3);
});

test('not opening the app on New Year’s Eve breaks the streak', () => {
  const s = play(withHabits('2026-12-29'), '2026-12-29', '✓✓.✓'); // Dec 31 skipped
  assert.equal(s.days['2026-12-31'].done.length, 0, 'the missed day is recorded as missed');
  assert.equal(stats.currentStreak(s, '2027-01-01'), 1);
  assert.equal(stats.bestStreak(s, '2027-01-01'), 2);
});

test('a streak runs through Feb 29 in a leap year', () => {
  const s = play(withHabits('2028-02-28'), '2028-02-28', '✓✓✓');
  assert.deepEqual(Object.keys(s.days).sort(), ['2028-02-28', '2028-02-29', '2028-03-01']);
  assert.equal(stats.currentStreak(s, '2028-03-01'), 3);
});

test('skipping Feb 29 in a leap year counts as a missed day', () => {
  const s = play(withHabits('2028-02-27'), '2028-02-27', '✓✓.✓');
  assert.equal(stats.dayState(s, '2028-02-29', '2028-03-01'), 'missed');
  assert.equal(stats.currentStreak(s, '2028-03-01'), 1);
});

test('Feb 28 to Mar 1 is consecutive in a non-leap year', () => {
  const s = play(withHabits('2027-02-28'), '2027-02-28', '✓✓');
  assert.equal(stats.currentStreak(s, '2027-03-01'), 2);
  assert.equal(s.days['2027-02-29'], undefined);
});

test('month grid starts on Sunday and covers the whole month', () => {
  const s = withHabits('2026-09-01');
  const grid = stats.monthGrid(s, 2026, 9, '2026-09-15'); // Sep 1 2026 is a Tuesday
  assert.equal(grid[0][0].date, '2026-08-30');
  assert.equal(grid[0][2].date, '2026-09-01');
  assert.equal(grid[0][2].inMonth, true);
  assert.equal(grid[0][0].inMonth, false);
  const cells = grid.flat().filter((c) => c.inMonth);
  assert.equal(cells.length, 30);
  assert.equal(cells.find((c) => c.isToday).date, '2026-09-15');
  assert.equal(cells.find((c) => c.date === '2026-09-20').state, 'future');
  const feb = stats.monthGrid(s, 2028, 2, '2026-09-15').flat().filter((c) => c.inMonth);
  assert.equal(feb.length, 29, 'leap February');
});
