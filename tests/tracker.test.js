'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { core, stats, withHabits, openOn, tick, play } = require('./helpers.js');

const MON = '2026-09-07'; // a Monday

/* ---------------- streaks ---------------- */

test('the brief’s example: ✓✓✓✗✓✓ gives current 2, best 3, total 5', () => {
  const s = play(withHabits(MON), MON, '✓✓✓✗✓✓'); // Mon … Sat
  const sat = core.addDays(MON, 5);
  const sum = stats.summary(s, sat);
  assert.equal(sum.currentStreak, 2);
  assert.equal(sum.bestStreak, 3);
  assert.equal(sum.totalLockedInDays, 5);
  assert.equal(sum.totalTrackedDays, 6);
  assert.equal(sum.completionRate, Math.round((15 / 18) * 100));
});

test('completing every goal locks in the day and grows the streak', () => {
  let s = withHabits(MON);
  s = core.setHabitDone(s, 'h1', true, MON).state;
  s = core.setHabitDone(s, 'h2', true, MON).state;
  assert.equal(core.recordSummary(s.days[MON]).lockedIn, false);
  assert.equal(stats.currentStreak(s, MON), 0);
  const r = core.setHabitDone(s, 'h3', true, MON);
  assert.equal(r.lockedIn, true);
  assert.equal(stats.currentStreak(r.state, MON), 1);
  assert.deepEqual(core.recordSummary(r.state.days[MON]), { total: 3, completed: 3, credit: 3, percentage: 100, lockedIn: true });
  // Unticking takes it back.
  const undo = core.setHabitDone(r.state, 'h3', false, MON);
  assert.equal(undo.lockedIn, false);
  assert.equal(stats.currentStreak(undo.state, MON), 0);
});

test('today in progress does not break the current streak', () => {
  const s = openOn(play(withHabits(MON), MON, '✓✓✓'), core.addDays(MON, 3));
  const thu = core.addDays(MON, 3);
  assert.equal(stats.currentStreak(s, thu), 3, 'yesterday’s streak still shows');
  const done = tick(s, thu);
  assert.equal(stats.currentStreak(done, thu), 4);
});

test('a partial day ends the streak but keeps all history', () => {
  const s = play(withHabits(MON), MON, '✓✓½✓');
  const thu = core.addDays(MON, 3);
  assert.equal(stats.currentStreak(s, thu), 1);
  assert.equal(stats.bestStreak(s, thu), 2);
  assert.equal(Object.keys(s.days).length, 4);
  assert.equal(stats.dayState(s, core.addDays(MON, 2), thu), 'partial');
});

test('days the app was not opened are filled in as missed on the next open', () => {
  let s = play(withHabits(MON), MON, '✓✓');
  const r = core.ensureDays(s, core.addDays(MON, 5));
  assert.deepEqual(r.missed, [core.addDays(MON, 2), core.addDays(MON, 3), core.addDays(MON, 4)]);
  s = r.state;
  assert.equal(Object.keys(s.days).length, 6);
  assert.equal(stats.dayState(s, core.addDays(MON, 3), core.addDays(MON, 5)), 'missed');
  assert.equal(stats.currentStreak(s, core.addDays(MON, 5)), 0);
  assert.equal(stats.bestStreak(s, core.addDays(MON, 5)), 2);
});

test('opening again the same day never creates duplicate records', () => {
  const s = openOn(withHabits(MON), MON);
  const again = core.ensureDays(s, MON);
  assert.equal(again.changed, false);
  assert.equal(again.state, s);
  assert.deepEqual(Object.keys(again.state.days), [MON]);
});

test('a clock set backwards does not rewrite or back-fill history', () => {
  const s = play(withHabits(MON), MON, '✓✓✓');
  const r = core.ensureDays(s, '2026-09-01');
  assert.deepEqual(r.missed, []);
  assert.equal(r.state.days['2026-09-08'].done.length, 3);
});

test('today with nothing ticked yet is in progress, not missed', () => {
  let s = openOn(withHabits(MON), MON);
  assert.equal(stats.dayState(s, MON, MON), 'pending');
  s = core.setHabitDone(s, 'h1', true, MON).state;
  assert.equal(stats.dayState(s, MON, MON), 'partial');
  assert.equal(stats.dayState(openOn(withHabits(MON), MON), MON, core.addDays(MON, 1)), 'missed', 'once the day is over');
});

test('only today can be ticked; future dates cannot', () => {
  const s = withHabits(MON);
  assert.equal(core.setHabitDone(s, 'h1', true, core.addDays(MON, 1)).error, 'not-today');
  assert.equal(stats.dayState(s, core.addDays(MON, 1), MON), 'future');
});

test('days with no required goals are neutral', () => {
  let s = play(withHabits(MON, ['Run']), MON, '✓✓');
  const wed = core.addDays(MON, 2);
  s = openOn(s, wed);
  s = core.setHabitStatus(s, 'h1', 'paused', wed).state;
  assert.equal(s.days[wed], undefined, 'no record when nothing is required');
  const thu = core.addDays(MON, 3);
  s = core.ensureDays(s, thu).state;
  assert.equal(s.days[thu], undefined);
  s = core.setHabitStatus(s, 'h1', 'active', thu).state;
  s = tick(s, thu);
  assert.equal(stats.currentStreak(s, thu), 3, 'the paused day neither counts nor breaks it');
  assert.equal(stats.summary(s, thu).totalTrackedDays, 3);
});

test('transitions never mutate their input', () => {
  const s = play(withHabits(MON), MON, '✓½');
  const before = JSON.stringify(s);
  const tue = core.addDays(MON, 1);
  core.setHabitDone(s, 'h2', true, tue);
  core.addHabit(s, 'Stretch', tue);
  core.renameHabit(s, 'h1', 'Lift', tue);
  core.moveHabit(s, 'h2', -1, tue);
  core.setHabitStatus(s, 'h1', 'archived', tue);
  core.ensureDays(s, core.addDays(MON, 9));
  assert.equal(JSON.stringify(s), before);
});

/* ---------------- managing habits ---------------- */

test('adding a goal later does not count against earlier days', () => {
  let s = play(withHabits(MON), MON, '✓✓✓');
  const thu = core.addDays(MON, 3);
  s = openOn(s, thu);
  s = core.addHabit(s, 'Stretch', thu).state;
  assert.equal(s.days[thu].habits.length, 4, 'today includes the new goal');
  assert.equal(s.days[MON].habits.length, 3, 'earlier days keep their original goals');
  assert.equal(stats.currentStreak(s, thu), 3);
  const stretch = stats.habitStats(s, thu).find((h) => h.name === 'Stretch');
  assert.equal(stretch.activeDays, 1);
  assert.equal(stretch.completionRate, 0);
});

test('renaming a goal updates today but not past records', () => {
  let s = play(withHabits(MON), MON, '✓');
  const tue = core.addDays(MON, 1);
  s = openOn(s, tue);
  s = core.renameHabit(s, 'h2', '  Read  20 pages ', tue).state;
  assert.equal(core.findHabit(s, 'h2').name, 'Read 20 pages');
  assert.equal(s.days[tue].habits[1].name, 'Read 20 pages');
  assert.equal(s.days[MON].habits[1].name, 'Read');
  assert.equal(stats.dayDetail(s, MON, tue).items[1].name, 'Read');
  assert.equal(core.renameHabit(s, 'h2', '   ', tue).error, 'invalid-name');
});

test('pausing removes a goal from today onward and resuming brings it back', () => {
  let s = play(withHabits(MON), MON, '✓');
  const tue = core.addDays(MON, 1);
  s = tick(s, tue, ['h1']);
  s = core.setHabitStatus(s, 'h1', 'paused', tue).state;
  assert.deepEqual(s.days[tue].habits.map((h) => h.id), ['h2', 'h3']);
  assert.deepEqual(s.days[tue].done, [], 'a tick on a paused goal no longer counts today');
  assert.equal(s.days[MON].habits.length, 3);
  s = core.setHabitStatus(s, 'h1', 'active', tue).state;
  assert.deepEqual(s.days[tue].habits.map((h) => h.id), ['h1', 'h2', 'h3']);
  assert.equal(core.findHabit(s, 'h1').archivedOn, null);
});

test('archived goals leave today but stay in history and stats', () => {
  let s = play(withHabits(MON), MON, '✓✓');
  const wed = core.addDays(MON, 2);
  s = openOn(s, wed);
  s = core.setHabitStatus(s, 'h3', 'archived', wed).state;
  assert.equal(core.findHabit(s, 'h3').archivedOn, wed);
  assert.equal(s.days[wed].habits.length, 2);
  assert.equal(s.days[MON].habits.length, 3);
  const water = stats.habitStats(s, wed).find((h) => h.id === 'h3');
  assert.equal(water.status, 'archived');
  assert.equal(water.completed, 2);
  assert.equal(water.completionRate, 100);
});

test('deleting is only allowed for goals with no history; otherwise archive', () => {
  let s = play(withHabits(MON), MON, '✓');
  const tue = core.addDays(MON, 1);
  s = openOn(s, tue);
  assert.equal(core.deleteHabit(s, 'h1', tue).error, 'has-history');
  s = core.addHabit(s, 'Typo', tue).state;
  const r = core.deleteHabit(s, 'h4', tue);
  assert.equal(r.ok, true);
  assert.equal(core.findHabit(r.state, 'h4'), null);
  assert.equal(r.state.days[tue].habits.length, 3);
  assert.deepEqual(core.validateState(r.state), []);
});

test('deleting the only goal on its first day leaves no empty record', () => {
  let s = withHabits(MON, ['Oops']);
  s = core.deleteHabit(s, 'h1', MON).state;
  assert.deepEqual(s.habits, []);
  assert.deepEqual(s.days, {});
});

test('goals can be reordered within their group', () => {
  let s = withHabits(MON);
  s = core.moveHabit(s, 'h3', -1, MON).state;
  assert.deepEqual(core.activeHabits(s).map((h) => h.id), ['h1', 'h3', 'h2']);
  assert.deepEqual(s.days[MON].habits.map((h) => h.id), ['h1', 'h3', 'h2'], 'today follows the new order');
  assert.equal(core.moveHabit(s, 'h1', -1, MON).error, 'edge');
  s = core.setHabitStatus(s, 'h2', 'paused', MON).state;
  assert.equal(core.moveHabit(s, 'h3', 1, MON).error, 'edge', 'paused goals are a separate group');
});

test('new goal ids are unique even after deletions and archiving', () => {
  let s = withHabits(MON, ['A', 'B']);
  s = core.setHabitStatus(s, 'h2', 'archived', MON).state;
  s = core.addHabit(s, 'C', MON).state;
  assert.equal(s.habits[2].id, 'h3');
});

test('there is a limit of 20 active goals', () => {
  let s = withHabits(MON, Array.from({ length: 20 }, (_, i) => 'Goal ' + i));
  assert.equal(core.addHabit(s, 'One too many', MON).error, 'too-many');
  s = core.setHabitStatus(s, 'h1', 'paused', MON).state;
  s = core.addHabit(s, 'Now fits', MON).state;
  assert.equal(core.setHabitStatus(s, 'h1', 'active', MON).error, 'too-many');
});

test('goal names are validated', () => {
  const s = core.emptyState();
  assert.equal(core.addHabit(s, '   ', MON).error, 'invalid-name');
  assert.equal(core.addHabit(s, 'x'.repeat(121), MON).error, 'invalid-name');
});

/* ---------------- stats ---------------- */

test('per-goal stats use only the days each goal was required', () => {
  let s = play(withHabits(MON, ['Workout', 'Read']), MON, '✓½✓'); // Read missed on Tue
  const wed = core.addDays(MON, 2);
  const [workout, read] = stats.habitStats(s, wed);
  assert.deepEqual([workout.completed, workout.completionRate, workout.currentStreak, workout.bestStreak], [3, 100, 3, 3]);
  assert.deepEqual([read.completed, read.completionRate, read.currentStreak, read.bestStreak], [2, 67, 1, 1]);
});

test('a goal’s current streak isn’t broken by today being unfinished', () => {
  const s = openOn(play(withHabits(MON), MON, '✓✓'), core.addDays(MON, 2));
  assert.equal(stats.habitStats(s, core.addDays(MON, 2))[0].currentStreak, 2);
});

test('the daily series has one point per day, with gaps as null', () => {
  let s = play(withHabits('2026-09-01', ['A', 'B']), '2026-09-01', '✓½');
  const today = '2026-09-02';
  const week = stats.dailySeries(s, today, 7);
  assert.equal(week.length, 7);
  assert.equal(week[0].date, '2026-08-27');
  assert.equal(week[0].percentage, null, 'before tracking started');
  assert.deepEqual(week.slice(-2).map((d) => d.percentage), [100, 50]);
  const all = stats.dailySeries(s, today, 'all');
  assert.deepEqual(all.map((d) => d.date), ['2026-09-01', '2026-09-02']);
  assert.equal(stats.dailySeries(core.emptyState(), today, 'all').length, 1);
});

test('day detail shows the goals as they were that day', () => {
  let s = play(withHabits(MON, ['Workout', 'Stretch']), MON, '½');
  const d = stats.dayDetail(s, MON, MON);
  assert.equal(d.completed, 1);
  assert.equal(d.total, 2);
  assert.deepEqual(d.items.map((i) => [i.name, i.done]), [['Workout', true], ['Stretch', false]]);
});

test('empty state has zeroed stats', () => {
  const sum = stats.summary(core.emptyState(), MON);
  assert.deepEqual(sum, { currentStreak: 0, bestStreak: 0, totalLockedInDays: 0, totalTrackedDays: 0, completionRate: 0, firstDay: null });
});
