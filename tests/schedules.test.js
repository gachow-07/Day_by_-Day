'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { core, stats, withHabits, openOn, tick, play } = require('./helpers.js');

const MON = '2026-09-07'; // Monday
const SAT = '2026-09-12';
const SUN = '2026-09-13';

test('existing (every-day) goals behave exactly as before', () => {
  const s = withHabits(MON);
  assert.ok(s.habits.every((h) => h.schedule.type === 'daily'));
  assert.deepEqual(s.days[MON].habits, [{ id: 'h1', name: 'Workout' }, { id: 'h2', name: 'Read' }, { id: 'h3', name: 'Drink water' }]);
});

test('a weekdays goal is required Monday–Friday and absent at weekends', () => {
  let s = withHabits(MON, ['Work', 'Stretch']);
  s = core.updateHabit(s, 'h1', { schedule: { type: 'weekdays' } }, MON).state;
  assert.equal(core.scheduleOn(core.findHabit(s, 'h1'), MON), 'required');
  assert.equal(core.scheduleOn(core.findHabit(s, 'h1'), SAT), null);
  s = openOn(s, SAT);
  assert.deepEqual(s.days[SAT].habits.map((h) => h.id), ['h2'], 'only the every-day goal on Saturday');
});

test('weekends with nothing scheduled are neutral for the locked-in streak', () => {
  let s = withHabits(MON, ['Work']);
  s = core.updateHabit(s, 'h1', { schedule: { type: 'weekdays' } }, MON).state;
  s = play(s, MON, '✓✓✓✓✓');                  // Mon–Fri
  s = openOn(s, SUN);                            // weekend passes
  assert.equal(s.days[SAT], undefined);
  assert.equal(s.days[SUN], undefined);
  const nextMon = core.addDays(MON, 7);
  s = tick(s, nextMon);
  assert.equal(stats.currentStreak(s, nextMon), 6, 'the weekend neither counts nor breaks it');
});

test('chosen days: only those weekdays are due, and missing one breaks the streak', () => {
  let s = withHabits(MON, ['Gym']);
  s = core.updateHabit(s, 'h1', { schedule: { type: 'days', days: [1, 3, 5] } }, MON).state; // Mon Wed Fri
  s = tick(s, MON);
  s = openOn(s, core.addDays(MON, 5));           // Sat: Wed and Fri were due, not done
  assert.deepEqual(Object.keys(s.days).sort(), [MON, '2026-09-09', '2026-09-11']);
  assert.equal(stats.currentStreak(s, SAT), 0);
  assert.equal(stats.bestStreak(s, SAT), 1);
});

test('schedule validation', () => {
  const s = withHabits(MON, ['X']);
  assert.equal(core.updateHabit(s, 'h1', { schedule: { type: 'days', days: [] } }, MON).error, 'invalid-details');
  assert.equal(core.updateHabit(s, 'h1', { schedule: { type: 'weekly', times: 7 } }, MON).error, 'invalid-details');
  assert.equal(core.updateHabit(s, 'h1', { schedule: { type: 'hourly' } }, MON).error, 'invalid-details');
  const all = core.updateHabit(s, 'h1', { schedule: { type: 'days', days: [0, 1, 2, 3, 4, 5, 6] } }, MON).state;
  assert.deepEqual(core.findHabit(all, 'h1').schedule, { type: 'daily' }, 'all seven days is every day');
});

test('times-per-week goals can be ticked but don’t decide Locked In', () => {
  let s = withHabits(MON, ['Read', 'Run']);
  s = core.updateHabit(s, 'h2', { schedule: { type: 'weekly', times: 3 } }, MON).state;
  assert.deepEqual(s.days[MON].habits[1], { id: 'h2', name: 'Run', flex: true, target: 3 });
  s = core.setHabitDone(s, 'h1', true, MON).state;
  assert.equal(core.recordSummary(s.days[MON]).lockedIn, true, 'Run is optional today');
  assert.deepEqual(core.recordSummary(s.days[MON]), { total: 1, completed: 1, percentage: 100, lockedIn: true });
  s = core.setHabitDone(s, 'h2', true, MON).state;
  assert.equal(stats.weeklyProgress(s, MON, 1, 'h2'), 1);
});

test('a day with only flexible goals is neutral for the locked-in streak', () => {
  let s = withHabits(MON, ['Run']);
  s = core.updateHabit(s, 'h1', { schedule: { type: 'weekly', times: 2 } }, MON).state;
  s = tick(s, MON);
  assert.equal(stats.summary(s, MON).totalTrackedDays, 0);
  assert.equal(stats.dayState(s, MON, MON), 'none');
});

test('weekly goal stats count weeks where the target was met', () => {
  let s = withHabits(MON, ['Run']);
  s = core.updateHabit(s, 'h1', { schedule: { type: 'weekly', times: 2 } }, MON).state;
  s = play(s, MON, '✓✗✓✗✗✗✗');          // week 1 (Mon start): 2 of 2 → met
  s = play(s, core.addDays(MON, 7), '✓✗✗✗✗✗✗'); // week 2: 1 of 2 → missed
  s = play(s, core.addDays(MON, 14), '✓✓');     // week 3 in progress: met already
  const today = core.addDays(MON, 15);
  const [run] = stats.habitStats(s, today, 1);
  assert.equal(run.unit, 'week');
  assert.equal(run.completed, 5);
  assert.equal(run.periods, 3);
  assert.equal(run.completionRate, 67);
  assert.equal(run.currentStreak, 1);
  assert.equal(run.bestStreak, 1);
  assert.deepEqual(run.thisWeek, { count: 2, target: 2 });
});

test('a weekly goal’s unfinished current week doesn’t count against it yet', () => {
  let s = withHabits(MON, ['Run']);
  s = core.updateHabit(s, 'h1', { schedule: { type: 'weekly', times: 3 } }, MON).state;
  s = tick(s, MON);
  const [run] = stats.habitStats(s, MON, 1);
  assert.equal(run.periods, 0);
  assert.equal(run.completionRate, 0);
  assert.deepEqual(run.thisWeek, { count: 1, target: 3 });
});

test('changing a schedule applies from today; past records keep theirs', () => {
  let s = play(withHabits(MON, ['Run']), MON, '✓✓');
  const wed = core.addDays(MON, 2);
  s = openOn(s, wed);
  s = core.updateHabit(s, 'h1', { schedule: { type: 'weekly', times: 3 } }, wed).state;
  assert.equal(s.days[MON].habits[0].flex, undefined);
  assert.equal(s.days[wed].habits[0].flex, true);
  assert.equal(stats.bestStreak(s, wed), 2);
});

test('goal icon, colour and reminder are validated and saved', () => {
  let s = withHabits(MON, ['Read']);
  const r = core.updateHabit(s, 'h1', { icon: 'book-open', color: 'violet', reminder: '21:15' }, MON);
  assert.equal(r.ok, true);
  const h = core.findHabit(r.state, 'h1');
  assert.deepEqual([h.icon, h.color, h.reminder], ['book-open', 'violet', '21:15']);
  assert.equal(core.updateHabit(s, 'h1', { color: 'neon' }, MON).ok, false);
  assert.equal(core.updateHabit(s, 'h1', { reminder: '9am' }, MON).ok, false);
  assert.equal(core.findHabit(core.updateHabit(s, 'h1', { reminder: '' }, MON).state, 'h1').reminder, null);
  const added = core.addHabit(s, 'Stretch', MON, { icon: 'leaf', schedule: { type: 'weekdays' } });
  assert.equal(core.findHabit(added.state, added.id).icon, 'leaf');
  assert.deepEqual(core.validateState(added.state), []);
});

test('drag-and-drop reorder moves a goal to a position within its group', () => {
  let s = withHabits(MON, ['A', 'B', 'C', 'D']);
  s = core.reorderHabit(s, 'h4', 0, MON).state;
  assert.deepEqual(core.activeHabits(s).map((h) => h.name), ['D', 'A', 'B', 'C']);
  assert.deepEqual(s.days[MON].habits.map((h) => h.name), ['D', 'A', 'B', 'C'], 'today follows the new order');
  s = core.reorderHabit(s, 'h4', 99, MON).state;
  assert.deepEqual(core.activeHabits(s).map((h) => h.name), ['A', 'B', 'C', 'D'], 'clamped to the end');
  s = core.setHabitStatus(s, 'h2', 'paused', MON).state;
  s = core.reorderHabit(s, 'h4', 0, MON).state;
  assert.deepEqual(core.activeHabits(s).map((h) => h.name), ['D', 'A', 'C']);
  assert.equal(s.habits.find((h) => h.status === 'paused').name, 'B', 'other groups keep their place');
  assert.equal(core.reorderHabit(s, 'h4', 0, MON).unchanged, true);
});

test('today’s focus is optional, trimmed and limited', () => {
  let s = withHabits(MON);
  s = core.setFocus(s, '  Ship the   essay  ', MON).state;
  assert.equal(s.focus[MON], 'Ship the essay');
  assert.equal(stats.dayDetail(s, MON, MON).focus, 'Ship the essay');
  assert.equal(core.setFocus(s, 'x'.repeat(141), MON).error, 'too-long');
  s = core.setFocus(s, '', MON).state;
  assert.equal(s.focus[MON], undefined);
});

test('week start changes the calendar layout but not any statistic', () => {
  let s = play(withHabits(MON), MON, '✓✓½✓');
  const before = stats.summary(s, core.addDays(MON, 3));
  s = core.setWeekStart(s, 1).state;
  assert.deepEqual(stats.summary(s, core.addDays(MON, 3)), before);
  const sunGrid = stats.monthGrid(s, 2026, 9, MON, 0);
  const monGrid = stats.monthGrid(s, 2026, 9, MON, 1);
  assert.equal(sunGrid[0][0].date, '2026-08-30');
  assert.equal(monGrid[0][0].date, '2026-08-31');
  assert.equal(monGrid[0][1].date, '2026-09-01');
  assert.equal(core.setWeekStart(s, 5).ok, false);
});

test('goal history grid: done, missed, not due, pending and future days', () => {
  // Weekdays goal, Monday-start weeks, starting Mon Sep 7.
  let s = withHabits(MON, ['Work']);
  s = core.updateHabit(s, 'h1', { schedule: { type: 'weekdays' } }, MON).state;
  s = play(s, MON, '✓✗✓');                        // Mon done, Tue missed, Wed done
  const thu = core.addDays(MON, 3);
  s = openOn(s, thu);                              // Thu due, not done yet
  const g = stats.habitGrid(s, 'h1', thu, 2, 1);
  assert.equal(g.weeks.length, 2);
  assert.equal(g.start, '2026-08-31');
  assert.ok(g.weeks[0].every((c) => c.state === 'none'), 'week before the goal existed');
  assert.deepEqual(g.weeks[1].map((c) => c.state), ['done', 'missed', 'done', 'pending', 'future', 'future', 'future']);
  assert.deepEqual([g.due, g.done, g.doneAll], [3, 2, 2], 'today isn’t counted while it’s in progress');
});

test('goal history grid: a weekend with nothing due is "none", and weekly goals aren’t "missed"', () => {
  let s = withHabits(MON, ['Work', 'Run']);
  s = core.updateHabit(s, 'h1', { schedule: { type: 'weekdays' } }, MON).state;
  s = core.updateHabit(s, 'h2', { schedule: { type: 'weekly', times: 2 } }, MON).state;
  s = tick(s, MON, ['h2']);
  s = openOn(s, SUN);
  const work = stats.habitGrid(s, 'h1', SUN, 1, 1).weeks[0];
  assert.equal(work[5].state, 'none', 'Saturday');
  assert.equal(work[6].state, 'none', 'Sunday');
  const run = stats.habitGrid(s, 'h2', SUN, 1, 1);
  assert.equal(run.weeks[0][0].state, 'done');
  assert.equal(run.weeks[0][1].state, 'open', 'a weekly goal not done on a day is not a miss');
  assert.equal(run.due, 0);
  assert.equal(run.doneAll, 1);
});

test('goal history grid is identical for existing every-day goals and week starts', () => {
  const s = play(withHabits(MON, ['A']), MON, '✓½✓');
  const sun = stats.habitGrid(s, 'h1', core.addDays(MON, 2), 1, 0).weeks[0];
  const mon = stats.habitGrid(s, 'h1', core.addDays(MON, 2), 1, 1).weeks[0];
  assert.equal(sun[0].date, '2026-09-06');
  assert.equal(mon[0].date, MON);
  assert.deepEqual(mon.slice(0, 3).map((c) => c.state), ['done', 'done', 'done'], '½ ticks the first goal');
});
