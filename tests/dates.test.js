'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { core, newChallenge, completeDays } = require('./helpers.js');

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

test('a streak runs through a month boundary without restarting', () => {
  let s = newChallenge('2026-01-30');
  s = completeDays(s, '2026-01-30', 4); // Jan 30, Jan 31, Feb 1, Feb 2
  assert.deepEqual(s.current.completedDates, ['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02']);
  const r = core.evaluateMissedDays(s, '2026-02-03');
  assert.equal(r.restarted, false);
  assert.equal(core.dayNumber(r.state, '2026-02-03'), 5);
});

test('a streak runs through New Year without restarting', () => {
  let s = newChallenge('2026-12-30');
  s = completeDays(s, '2026-12-30', 3); // Dec 30, Dec 31, Jan 1
  assert.equal(core.evaluateMissedDays(s, '2027-01-02').restarted, false);
  assert.equal(core.dayNumber(s, '2027-01-02'), 4);
});

test('missing New Year’s Eve restarts the attempt', () => {
  let s = newChallenge('2026-12-29');
  s = completeDays(s, '2026-12-29', 2); // Dec 29, Dec 30
  const r = core.evaluateMissedDays(s, '2027-01-01');
  assert.equal(r.restarted, true);
  assert.equal(r.missedDate, '2026-12-31');
  assert.equal(r.state.current.startDate, '2027-01-01');
});

test('a streak runs through Feb 29 in a leap year', () => {
  let s = newChallenge('2028-02-28');
  s = completeDays(s, '2028-02-28', 3);
  assert.deepEqual(s.current.completedDates, ['2028-02-28', '2028-02-29', '2028-03-01']);
  assert.equal(core.evaluateMissedDays(s, '2028-03-02').restarted, false);
});

test('skipping Feb 29 in a leap year counts as a missed day', () => {
  let s = newChallenge('2028-02-27');
  s = completeDays(s, '2028-02-27', 2); // Feb 27, Feb 28
  const r = core.evaluateMissedDays(s, '2028-03-01');
  assert.equal(r.restarted, true);
  assert.equal(r.missedDate, '2028-02-29');
});

test('Feb 28 to Mar 1 is consecutive in a non-leap year', () => {
  let s = newChallenge('2027-02-28');
  s = completeDays(s, '2027-02-28', 1);
  assert.equal(core.evaluateMissedDays(s, '2027-03-01').restarted, false);
  s = completeDays(s, '2027-03-01', 1);
  assert.equal(core.currentStreak(s), 2);
});
