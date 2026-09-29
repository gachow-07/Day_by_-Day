'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { core, stats, withHabits, openOn } = require('./helpers.js');

const MON = '2026-09-07';
const TUE = '2026-09-08';

function timed(date, minutes) {
  const s = withHabits(date, ['Study', 'Read']);
  return core.updateHabit(s, 'h1', { minutes: minutes || 120 }, date).state;
}

test('a timed goal is logged in pieces and is done when the time adds up', () => {
  let s = timed(MON);
  assert.deepEqual(s.days[MON].habits[0], { id: 'h1', name: 'Study', minutes: 120 });
  let r = core.logTime(s, 'h1', 60, MON);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.done, false);
  assert.equal(r.logged, 60);
  s = r.state;
  assert.equal(core.entryProgress(s.days[MON], s.days[MON].habits[0]), 'partial');
  s = core.logTime(s, 'h1', 30, MON).state;
  r = core.logTime(s, 'h1', 30, MON);
  assert.equal(r.done, true);
  s = r.state;
  assert.deepEqual(s.days[MON].logs, { h1: [60, 30, 30] });
  assert.deepEqual(s.days[MON].done, ['h1']);
  s = core.logTime(s, 'h1', 15, MON).state;
  assert.equal(core.loggedMinutes(s.days[MON], 'h1'), 135, 'going over the goal is fine');
});

test('undoing the last entry can take a goal back below its goal', () => {
  let s = timed(MON);
  s = core.logTime(s, 'h1', 90, MON).state;
  s = core.logTime(s, 'h1', 30, MON).state;
  assert.deepEqual(s.days[MON].done, ['h1']);
  const r = core.undoLog(s, 'h1', MON);
  assert.equal(r.removed, 30);
  assert.deepEqual(r.state.days[MON].done, []);
  assert.deepEqual(r.state.days[MON].logs, { h1: [90] });
  const empty = core.undoLog(core.undoLog(r.state, 'h1', MON).state, 'h1', MON);
  assert.equal(empty.ok, false);
});

test('ticking a timed goal logs what is left; unticking takes it back', () => {
  let s = timed(MON);
  s = core.logTime(s, 'h1', 45, MON).state;
  s = core.setHabitDone(s, 'h1', true, MON).state;
  assert.deepEqual(s.days[MON].logs.h1, [45, 75]);
  assert.deepEqual(s.days[MON].done, ['h1']);
  s = core.setHabitDone(s, 'h1', false, MON).state;
  assert.deepEqual(s.days[MON].logs.h1, [45], 'the earlier 45 minutes are kept');
  assert.deepEqual(s.days[MON].done, []);
});

test('time logging is validated', () => {
  const s = timed(MON);
  assert.equal(core.logTime(s, 'h2', 30, MON).error, 'untimed');
  assert.equal(core.logTime(s, 'h1', 0, MON).error, 'invalid-minutes');
  assert.equal(core.logTime(s, 'h1', 1.5, MON).error, 'invalid-minutes');
  assert.equal(core.logTime(s, 'h1', 1441, MON).error, 'invalid-minutes');
  assert.equal(core.logTime(s, 'h1', 30, TUE).error, 'not-today');
  assert.match(core.updateHabit(s, 'h1', { minutes: 3 }, MON).message, /between 5 minutes and 24 hours/);
  assert.match(core.updateHabit(s, 'h1', { minutes: 1500 }, MON).message, /between 5 minutes and 24 hours/);
});

test('a goal can be marked partly done, and ticking it clears that', () => {
  let s = withHabits(MON, ['Read', 'Walk']);
  s = core.setHabitPartial(s, 'h1', true, MON).state;
  assert.deepEqual(s.days[MON].partial, ['h1']);
  assert.equal(core.entryProgress(s.days[MON], s.days[MON].habits[0]), 'partial');
  s = core.setHabitDone(s, 'h1', true, MON).state;
  assert.equal(s.days[MON].partial, undefined);
  s = core.setHabitPartial(s, 'h1', true, MON).state;
  assert.deepEqual(s.days[MON].done, [], 'partly done replaces done');
  s = core.setHabitPartial(s, 'h1', false, MON).state;
  assert.equal(s.days[MON].partial, undefined);
  assert.equal(core.setHabitPartial(timed(MON), 'h1', true, MON).error, 'timed', 'timed goals use their logged time');
});

test('partial progress counts toward completion but never locks in a day', () => {
  let s = timed(MON);                                    // Study 2h, Read
  s = core.logTime(s, 'h1', 60, MON).state;              // half of Study
  s = core.setHabitPartial(s, 'h2', true, MON).state;    // Read partly done
  const sum = core.recordSummary(s.days[MON]);
  assert.equal(sum.completed, 0);
  assert.equal(sum.credit, 1);
  assert.equal(sum.percentage, 50);
  assert.equal(sum.lockedIn, false);
  s = openOn(s, TUE);
  assert.equal(stats.dayState(s, MON, TUE), 'partial', 'yellow on the calendar, not missed');
  assert.equal(stats.currentStreak(s, TUE), 0);
  assert.equal(stats.summary(s, MON).completionRate, 50);
  const study = stats.habitStats(s, MON, 0).find((x) => x.id === 'h1');
  assert.equal(study.completionRate, 50);
  assert.equal(study.currentStreak, 0);
  assert.equal(stats.habitGrid(s, 'h1', TUE, 1, 0).weeks[0][1].state, 'partial');
  assert.deepEqual(stats.dayDetail(s, MON, TUE).items.map((i) => [i.progress, i.logged]), [['partial', 60], ['partial', null]]);
});

test('changing a goal to or from timed keeps today consistent', () => {
  let s = withHabits(MON, ['Study']);
  s = core.setHabitDone(s, 'h1', true, MON).state;
  s = core.updateHabit(s, 'h1', { minutes: 60 }, MON).state;
  assert.deepEqual(s.days[MON].done, ['h1'], 'a tick made before the goal became timed is kept');
  assert.deepEqual(s.days[MON].logs, { h1: [60] });
  s = core.updateHabit(s, 'h1', { minutes: 90 }, MON).state;
  assert.deepEqual(s.days[MON].done, [], 'a bigger goal needs more time');
  s = core.updateHabit(s, 'h1', { minutes: null }, MON).state;
  assert.equal(s.days[MON].logs, undefined);
  assert.equal(s.days[MON].habits[0].minutes, undefined);
  assert.deepEqual(core.validateState(s), []);
});

test('past days keep their time goal and logs', () => {
  let s = timed(MON);
  s = core.logTime(s, 'h1', 120, MON).state;
  s = openOn(s, TUE);
  s = core.updateHabit(s, 'h1', { minutes: 30 }, TUE).state;
  assert.equal(s.days[MON].habits[0].minutes, 120);
  assert.equal(s.days[TUE].habits[0].minutes, 30);
  assert.deepEqual(s.days[MON].done, ['h1']);
});

test('validation catches inconsistent progress', () => {
  const s = core.logTime(timed(MON), 'h1', 30, MON).state;
  assert.deepEqual(core.validateState(s), []);
  const tick = JSON.parse(JSON.stringify(s));
  tick.days[MON].done = ['h1'];
  assert.match(core.validateState(tick).join(' '), /logs don’t match/);
  const logs = JSON.parse(JSON.stringify(s));
  logs.days[MON].logs.h2 = [10];
  assert.match(core.validateState(logs).join(' '), /invalid time logs/);
  const part = JSON.parse(JSON.stringify(s));
  part.days[MON].partial = ['h1'];
  assert.match(core.validateState(part).join(' '), /partly done/);
  const goal = JSON.parse(JSON.stringify(s));
  goal.habits[0].minutes = 2;
  assert.match(core.validateState(goal).join(' '), /minutes is invalid/);
});

test('v5 data gains minutes: null; exports carry progress and import back', () => {
  const v5 = withHabits(MON, ['Study']);
  v5.schemaVersion = 5;
  delete v5.habits[0].minutes;
  const r = core.migrate(v5);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.state.habits[0].minutes, null);

  let s = core.logTime(timed(MON), 'h1', 45, MON).state;
  s = core.setHabitPartial(s, 'h2', true, MON).state;
  const doc = core.buildExport(s, new Date());
  assert.deepEqual(doc.dailyRecords[0].habits[0].minutes, { logged: 45, goal: 120 });
  assert.equal(doc.dailyRecords[0].habits[1].partlyDone, true);
  const back = core.parseImport(JSON.stringify(doc));
  assert.equal(back.ok, true, back.message);
  assert.deepEqual(back.state, s);
});
