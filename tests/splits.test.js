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
