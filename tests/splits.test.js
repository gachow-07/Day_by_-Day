'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { core, stats, withHabits, openOn, tick } = require('./helpers.js');

const MON = '2026-09-07'; // Monday
const SPLIT = { workouts: ['Legs', 'Chest', 'Shoulders', 'Back'], current: 0 };

function withSplit(date, extra) {
  const s = withHabits(date, ['Gym', 'Read']);
  return core.updateHabit(s, 'h1', Object.assign({ split: SPLIT }, extra), date).state;
}

const workouts = (s, date) => s.days[date].habits.filter((h) => h.id === 'h1').map((h) => h.workout)[0];

test('a goal with a split shows the next workout each day it is due', () => {
  let s = withSplit(MON);
  assert.equal(workouts(s, MON), 'Legs');
  assert.equal(s.days[MON].habits[1].workout, undefined, 'goals without a split have no workout');
  const seen = [];
  for (let i = 1; i <= 5; i++) {
    s = openOn(s, core.addDays(MON, i));
    seen.push(workouts(s, core.addDays(MON, i)));
  }
  assert.deepEqual(seen, ['Chest', 'Shoulders', 'Back', 'Legs', 'Chest']);
  assert.equal(workouts(s, core.addDays(MON, 2)), 'Shoulders', 'past days keep their workout');
});

test('the split starts on the chosen workout', () => {
  const s = core.updateHabit(withHabits(MON, ['Gym']), 'h1', { split: { workouts: SPLIT.workouts, current: 2 } }, MON).state;
  assert.equal(workouts(s, MON), 'Shoulders');
  assert.equal(workouts(openOn(s, core.addDays(MON, 1)), core.addDays(MON, 1)), 'Back');
});

test('only due days move the split on', () => {
  let s = withSplit(MON, { schedule: { type: 'days', days: [1, 3, 5] } }); // Mon Wed Fri
  const up = core.upcomingWorkouts(s, 'h1', MON);
  assert.deepEqual(up.map((u) => [u.workout, u.date]), [['Chest', '2026-09-09'], ['Shoulders', '2026-09-11'], ['Back', '2026-09-14']]);
  s = openOn(s, '2026-09-14');
  assert.equal(workouts(s, '2026-09-09'), 'Chest');
  assert.equal(workouts(s, '2026-09-11'), 'Shoulders');
  assert.equal(workouts(s, '2026-09-14'), 'Back');
  // Over many weeks as well
  assert.equal(core.workoutOn(s, core.findHabit(s, 'h1'), core.addDays(MON, 7 * 10)), SPLIT.workouts[30 % 4]);
});

test('times-per-week goals move on after each day they are done', () => {
  let s = withSplit(MON, { schedule: { type: 'weekly', times: 3 } });
  assert.equal(workouts(s, MON), 'Legs');
  assert.deepEqual(core.upcomingWorkouts(s, 'h1', MON).map((u) => u.date), [null, null, null]);
  s = openOn(s, core.addDays(MON, 1));             // Monday not done
  assert.equal(workouts(s, core.addDays(MON, 1)), 'Legs');
  s = core.setHabitDone(s, 'h1', true, core.addDays(MON, 1)).state;
  s = openOn(s, core.addDays(MON, 2));
  assert.equal(workouts(s, core.addDays(MON, 2)), 'Chest');
});

test('doing a different workout swaps it with the planned one', () => {
  let s = withSplit(MON);
  const r = core.swapWorkout(s, 'h1', 'Shoulders', MON);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.planned, 'Legs');
  assert.deepEqual(r.movedTo, { index: 2, date: '2026-09-09' });
  s = r.state;
  assert.equal(workouts(s, MON), 'Shoulders');
  assert.deepEqual(core.findHabit(s, 'h1').split.workouts, ['Shoulders', 'Chest', 'Legs', 'Back']);
  s = openOn(s, '2026-09-09');
  assert.equal(workouts(s, '2026-09-08'), 'Chest');
  assert.equal(workouts(s, '2026-09-09'), 'Legs', 'leg day moved to where shoulders was');
  assert.equal(workouts(s, MON), 'Shoulders', 'today’s record keeps what was actually done');
});

test('swapping keeps ticks, can be undone, and rejects unknown workouts', () => {
  let s = tick(withSplit(MON), MON);
  s = core.swapWorkout(s, 'h1', 'Back', MON).state;
  assert.deepEqual(s.days[MON].done, ['h1', 'h2']);
  s = core.swapWorkout(s, 'h1', 'Legs', MON).state;
  assert.deepEqual(core.findHabit(s, 'h1').split.workouts, SPLIT.workouts, 'swapping back restores the split');
  assert.equal(core.swapWorkout(s, 'h1', 'Legs', MON).unchanged, true);
  assert.equal(core.swapWorkout(s, 'h1', 'Arms', MON).ok, false);
  assert.equal(core.swapWorkout(s, 'h2', 'Legs', MON).ok, false, 'goals without a split');
});

test('changing the schedule keeps the split on today’s workout', () => {
  let s = openOn(withSplit(MON), core.addDays(MON, 1));    // Tuesday: Chest
  s = core.updateHabit(s, 'h1', { schedule: { type: 'weekdays' } }, core.addDays(MON, 1)).state;
  assert.equal(workouts(s, core.addDays(MON, 1)), 'Chest');
  assert.equal(core.upcomingWorkouts(s, 'h1', core.addDays(MON, 1))[0].workout, 'Shoulders');
});

test('split validation and removal', () => {
  const s = withHabits(MON, ['Gym']);
  assert.match(core.updateHabit(s, 'h1', { split: { workouts: ['Legs'] } }, MON).message, /at least two/);
  assert.match(core.updateHabit(s, 'h1', { split: { workouts: Array(15).fill('x') } }, MON).message, /up to 14/);
  assert.match(core.updateHabit(s, 'h1', { split: { workouts: ['Legs', 'x'.repeat(41)] } }, MON).message, /40 characters/);
  const blanks = core.updateHabit(s, 'h1', { split: { workouts: ['  Legs ', '', 'Arms'], current: 9 } }, MON).state;
  assert.deepEqual(core.findHabit(blanks, 'h1').split, { workouts: ['Legs', 'Arms'], start: MON, offset: 0 });
  const off = core.updateHabit(blanks, 'h1', { split: null }, MON).state;
  assert.equal(core.findHabit(off, 'h1').split, null);
  assert.equal(off.days[MON].habits[0].workout, undefined);
  assert.deepEqual(core.validateState(blanks), []);
  const bad = JSON.parse(JSON.stringify(blanks));
  bad.habits[0].split.offset = 5;
  assert.match(core.validateState(bad).join(' '), /split is invalid/);
});

test('v4 data gains an empty split and keeps everything else', () => {
  const v4 = withHabits(MON, ['Gym']);
  v4.schemaVersion = 4;
  delete v4.habits[0].split;
  const r = core.migrate(v4);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.fromVersion, 4);
  assert.equal(r.state.habits[0].split, null);
  assert.deepEqual(r.state.days, v4.days);
});

test('workouts appear in day details and exports', () => {
  const s = withSplit(MON);
  assert.equal(stats.dayDetail(s, MON, MON).items[0].workout, 'Legs');
  assert.equal(core.buildExport(s, new Date()).dailyRecords[0].habits[0].workout, 'Legs');
  const back = core.parseImport(JSON.stringify(core.buildExport(s, new Date())));
  assert.equal(back.ok, true, back.message);
  assert.deepEqual(back.state, s);
});

/* Weekly plan: a set workout for each day of the week */

// Sun=0 … Sat=6. Rest on Sunday and Thursday.
const PLAN = [null, 'Chest', 'Back', 'Legs', null, 'Shoulders', 'Arms'];
const WED = '2026-09-09';
const FRI = '2026-09-11';
const NEXT_WED = '2026-09-16';
const NEXT_FRI = '2026-09-18';

function withPlan(date, weekStart) {
  let s = withHabits(date, ['Gym', 'Read']);
  if (weekStart === 1) s = core.setWeekStart(s, 1).state;
  return core.updateHabit(s, 'h1', { split: { type: 'weekly', days: PLAN } }, date).state;
}

test('each day of the week has its own workout, and rest days are not due', () => {
  let s = withPlan(MON);
  const h = core.findHabit(s, 'h1');
  assert.deepEqual(h.split, { type: 'weekly', days: PLAN, moves: {} });
  assert.deepEqual(h.schedule, { type: 'days', days: [1, 2, 3, 5, 6] }, 'the plan sets the schedule');
  assert.equal(workouts(s, MON), 'Chest');
  s = openOn(s, WED);
  assert.equal(workouts(s, '2026-09-08'), 'Back');
  assert.equal(workouts(s, WED), 'Legs');
  s = openOn(s, '2026-09-10');                      // Thursday: rest
  assert.equal(s.days['2026-09-10'].habits.some((e) => e.id === 'h1'), false);
  assert.equal(core.workoutOn(s, core.findHabit(s, 'h1'), '2026-09-14'), 'Chest', 'the next Monday is Chest again');
});

test('swapping is just for this week: the next week goes back to the plan', () => {
  let s = openOn(withPlan(MON), WED);               // Wednesday: Legs
  const r = core.swapWorkout(s, 'h1', 'Shoulders', WED);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.planned, 'Legs');
  assert.deepEqual(r.movedTo, { date: FRI });
  s = r.state;
  assert.equal(workouts(s, WED), 'Shoulders');
  assert.equal(core.workoutOn(s, core.findHabit(s, 'h1'), FRI), 'Legs', 'Friday this week does the legs');
  assert.deepEqual(core.findHabit(s, 'h1').split.days, PLAN, 'the saved plan is unchanged');
  s = openOn(s, FRI);
  assert.equal(workouts(s, FRI), 'Legs');
  s = openOn(s, NEXT_WED);
  assert.equal(workouts(s, NEXT_WED), 'Legs', 'next Wednesday is back to legs');
  assert.equal(core.workoutOn(s, core.findHabit(s, 'h1'), NEXT_FRI), 'Shoulders');
  assert.equal(workouts(s, WED), 'Shoulders', 'last week keeps what was done');
});

test('a workout not coming up again this week changes just today', () => {
  let s = openOn(withPlan(MON), WED);
  const up = core.upcomingWorkouts(s, 'h1', WED);
  assert.deepEqual(up.map((u) => [u.workout, u.date]), [['Shoulders', FRI], ['Arms', '2026-09-12'], ['Chest', null], ['Back', null]]);
  const r = core.swapWorkout(s, 'h1', 'Chest', WED);
  assert.equal(r.movedTo, null);
  s = r.state;
  assert.equal(workouts(s, WED), 'Chest');
  assert.deepEqual(core.findHabit(s, 'h1').split.moves, { [WED]: 'Chest' });
  assert.equal(core.swapWorkout(s, 'h1', 'Cardio', WED).ok, false, 'only workouts in the plan');
});

test('swapping back restores the plan, and old swaps are cleared', () => {
  let s = openOn(withPlan(MON), WED);
  s = core.swapWorkout(s, 'h1', 'Shoulders', WED).state;
  s = core.swapWorkout(s, 'h1', 'Legs', WED).state;
  assert.deepEqual(core.findHabit(s, 'h1').split.moves, {}, 'back to the plan, nothing left over');
  s = core.swapWorkout(s, 'h1', 'Shoulders', WED).state;
  s = openOn(s, NEXT_WED);
  s = core.swapWorkout(s, 'h1', 'Arms', NEXT_WED).state;
  assert.deepEqual(core.findHabit(s, 'h1').split.moves, { [NEXT_WED]: 'Arms', '2026-09-19': 'Legs' }, 'last week’s swaps are dropped');
});

test('the week ends where the week-start setting says', () => {
  // Week starting Monday: from Saturday, Sunday is still this week, but it is a rest day.
  let s = openOn(withPlan(MON, 1), '2026-09-12');
  assert.deepEqual(core.weekBounds(s, '2026-09-12'), { start: MON, end: '2026-09-13' });
  const r = core.swapWorkout(s, 'h1', 'Chest', '2026-09-12');
  assert.equal(r.movedTo, null, 'Monday is next week, so Saturday changes alone');
});

test('weekly plans are validated, keep swaps on resave, and import back', () => {
  const s0 = withHabits(MON, ['Gym']);
  assert.match(core.updateHabit(s0, 'h1', { split: { type: 'weekly', days: [null, '', ' ', null, null, null, null] } }, MON).message, /at least one day/);
  let s = core.swapWorkout(withPlan(MON), 'h1', 'Back', MON).state;
  s = core.updateHabit(s, 'h1', { name: 'Lift', split: { type: 'weekly', days: PLAN } }, MON).state;
  assert.deepEqual(core.findHabit(s, 'h1').split.moves, { [MON]: 'Back', '2026-09-08': 'Chest' }, 'same plan keeps this week’s swaps');
  const changed = core.updateHabit(s, 'h1', { split: { type: 'weekly', days: ['Yoga', null, null, null, null, null, null] } }, MON).state;
  assert.deepEqual(core.findHabit(changed, 'h1').split.moves, {});
  assert.deepEqual(core.validateState(s), []);
  const bad = JSON.parse(JSON.stringify(s));
  bad.habits[0].split.days = ['A', 'B'];
  assert.match(core.validateState(bad).join(' '), /split is invalid/);
  const back = core.parseImport(JSON.stringify(core.buildExport(s, new Date())));
  assert.equal(back.ok, true, back.message);
  assert.deepEqual(back.state, s);
  const v8 = JSON.parse(JSON.stringify(withHabits(MON, ['Gym'])));
  v8.schemaVersion = 8;
  assert.equal(core.migrate(v8).ok, true);
});
