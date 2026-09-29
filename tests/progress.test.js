'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { core, stats, withHabits, openOn } = require('./helpers.js');

const MON = '2026-09-07';
const TUE = '2026-09-08';

function timed(date, minutes) {
  const s = withHabits(date, ['Study', 'Read']);
  return core.updateHabit(s, 'h1', { amount: { unit: 'min', goal: minutes || 120 } }, date).state;
}

test('a timed goal is logged in pieces and is done when the time adds up', () => {
  let s = timed(MON);
  assert.deepEqual(s.days[MON].habits[0], { id: 'h1', name: 'Study', amount: { unit: 'min', goal: 120 } });
  let r = core.logAmount(s, 'h1', 60, MON);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.done, false);
  assert.equal(r.logged, 60);
  s = r.state;
  assert.equal(core.entryProgress(s.days[MON], s.days[MON].habits[0]), 'partial');
  s = core.logAmount(s, 'h1', 30, MON).state;
  r = core.logAmount(s, 'h1', 30, MON);
  assert.equal(r.done, true);
  s = r.state;
  assert.deepEqual(s.days[MON].logs, { h1: [60, 30, 30] });
  assert.deepEqual(s.days[MON].done, ['h1']);
  s = core.logAmount(s, 'h1', 15, MON).state;
  assert.equal(core.loggedAmount(s.days[MON], 'h1'), 135, 'going over the goal is fine');
});

test('undoing the last entry can take a goal back below its goal', () => {
  let s = timed(MON);
  s = core.logAmount(s, 'h1', 90, MON).state;
  s = core.logAmount(s, 'h1', 30, MON).state;
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
  s = core.logAmount(s, 'h1', 45, MON).state;
  s = core.setHabitDone(s, 'h1', true, MON).state;
  assert.deepEqual(s.days[MON].logs.h1, [45, 75]);
  assert.deepEqual(s.days[MON].done, ['h1']);
  s = core.setHabitDone(s, 'h1', false, MON).state;
  assert.deepEqual(s.days[MON].logs.h1, [45], 'the earlier 45 minutes are kept');
  assert.deepEqual(s.days[MON].done, []);
});

test('time logging is validated', () => {
  const s = timed(MON);
  assert.equal(core.logAmount(s, 'h2', 30, MON).error, 'no-amount');
  assert.equal(core.logAmount(s, 'h1', 0, MON).error, 'invalid-amount');
  assert.equal(core.logAmount(s, 'h1', 1.5, MON).error, 'invalid-amount');
  assert.equal(core.logAmount(s, 'h1', 1441, MON).error, 'invalid-amount');
  assert.equal(core.logAmount(s, 'h1', 30, TUE).error, 'not-today');
  assert.match(core.updateHabit(s, 'h1', { amount: { unit: 'min', goal: 3 } }, MON).message, /between 5 minutes and 24 hours/);
  assert.match(core.updateHabit(s, 'h1', { amount: { unit: 'min', goal: 1500 } }, MON).message, /between 5 minutes and 24 hours/);
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
  assert.equal(core.setHabitPartial(timed(MON), 'h1', true, MON).error, 'amount', 'amount goals use what was logged');
});

test('partial progress counts toward completion but never locks in a day', () => {
  let s = timed(MON);                                    // Study 2h, Read
  s = core.logAmount(s, 'h1', 60, MON).state;              // half of Study
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
  s = core.updateHabit(s, 'h1', { amount: { unit: 'min', goal: 60 } }, MON).state;
  assert.deepEqual(s.days[MON].done, ['h1'], 'a tick made before the goal became timed is kept');
  assert.deepEqual(s.days[MON].logs, { h1: [60] });
  s = core.updateHabit(s, 'h1', { amount: { unit: 'min', goal: 90 } }, MON).state;
  assert.deepEqual(s.days[MON].done, [], 'a bigger goal needs more time');
  s = core.updateHabit(s, 'h1', { amount: null }, MON).state;
  assert.equal(s.days[MON].logs, undefined);
  assert.equal(s.days[MON].habits[0].amount, undefined);
  assert.deepEqual(core.validateState(s), []);
});

test('past days keep their time goal and logs', () => {
  let s = timed(MON);
  s = core.logAmount(s, 'h1', 120, MON).state;
  s = openOn(s, TUE);
  s = core.updateHabit(s, 'h1', { amount: { unit: 'min', goal: 30 } }, TUE).state;
  assert.deepEqual(s.days[MON].habits[0].amount, { unit: 'min', goal: 120 });
  assert.deepEqual(s.days[TUE].habits[0].amount, { unit: 'min', goal: 30 });
  assert.deepEqual(s.days[MON].done, ['h1']);
});

test('validation catches inconsistent progress', () => {
  const s = core.logAmount(timed(MON), 'h1', 30, MON).state;
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
  goal.habits[0].amount.goal = 2;
  assert.match(core.validateState(goal).join(' '), /amount is invalid/);
});

test('v5 data gains amount: null; exports carry progress and import back', () => {
  const v5 = withHabits(MON, ['Study']);
  v5.schemaVersion = 5;
  delete v5.habits[0].amount;
  const r = core.migrate(v5);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.state.habits[0].amount, null);

  let s = core.logAmount(timed(MON), 'h1', 45, MON).state;
  s = core.setHabitPartial(s, 'h2', true, MON).state;
  const doc = core.buildExport(s, new Date());
  assert.deepEqual(doc.dailyRecords[0].habits[0].amount, { unit: 'min', logged: 45, goal: 120 });
  assert.equal(doc.dailyRecords[0].habits[1].partlyDone, true);
  const back = core.parseImport(JSON.stringify(doc));
  assert.equal(back.ok, true, back.message);
  assert.deepEqual(back.state, s);
});

/* Water */

function water(date, goal, unit) {
  const s = withHabits(date, ['Drink water', 'Read']);
  return core.updateHabit(s, 'h1', { amount: { unit: unit || 'ml', goal: goal || 2000 } }, date).state;
}

test('water is logged a glass at a time and is done at the goal', () => {
  let s = water(MON);
  assert.deepEqual(s.days[MON].habits[0].amount, { unit: 'ml', goal: 2000 });
  for (let i = 0; i < 7; i++) s = core.logAmount(s, 'h1', 250, MON).state;
  assert.equal(core.loggedAmount(s.days[MON], 'h1'), 1750);
  assert.equal(core.recordSummary(s.days[MON]).percentage, 44, 'Read not done; water 87.5%');
  const r = core.logAmount(s, 'h1', 500, MON);
  assert.equal(r.done, true);
  assert.equal(r.unit, 'ml');
  assert.equal(r.logged, 2250);
  assert.equal(core.undoLog(r.state, 'h1', MON).removed, 500);
});

test('water goals are validated per unit', () => {
  const s = withHabits(MON, ['Water']);
  assert.match(core.updateHabit(s, 'h1', { amount: { unit: 'ml', goal: 50 } }, MON).message, /between 100 ml and 10 L/);
  assert.match(core.updateHabit(s, 'h1', { amount: { unit: 'oz', goal: 400 } }, MON).message, /between 4 and 340 fl oz/);
  assert.match(core.updateHabit(s, 'h1', { amount: { unit: 'cups', goal: 8 } }, MON).message, /Choose what to track/);
  const w = water(MON);
  assert.equal(core.logAmount(w, 'h1', 20001, MON).error, 'invalid-amount');
  assert.equal(core.logAmount(w, 'h1', 12.5, MON).error, 'invalid-amount');
  assert.equal(core.logAmount(w, 'h1', 20000, MON).ok, true);
});

test('switching water between ml and oz converts today, time to water starts over', () => {
  let s = water(MON, 2000);
  s = core.logAmount(s, 'h1', 500, MON).state;
  s = core.updateHabit(s, 'h1', { amount: { unit: 'oz', goal: 64 } }, MON).state;
  assert.deepEqual(s.days[MON].logs.h1, [17], '500 ml is about 17 oz');
  s = core.updateHabit(s, 'h1', { amount: { unit: 'ml', goal: 2000 } }, MON).state;
  assert.deepEqual(s.days[MON].logs.h1, [503]);
  s = core.updateHabit(s, 'h1', { amount: { unit: 'min', goal: 30 } }, MON).state;
  assert.equal(s.days[MON].logs, undefined);
  assert.deepEqual(core.validateState(s), []);
});

test('v6 time goals become amount goals in minutes, with their history', () => {
  let s = timed(MON);
  s = core.logAmount(s, 'h1', 120, MON).state;
  s = openOn(s, TUE);
  const v6 = JSON.parse(JSON.stringify(s));
  v6.schemaVersion = 6;
  v6.habits.forEach((h) => { h.minutes = h.amount ? h.amount.goal : null; delete h.amount; });
  Object.values(v6.days).forEach((rec) => rec.habits.forEach((e) => { if (e.amount) { e.minutes = e.amount.goal; delete e.amount; } }));
  const r = core.migrate(v6);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.fromVersion, 6);
  assert.deepEqual(r.state, s);
  assert.equal(stats.dayState(r.state, MON, TUE), 'partial', 'Study done, Read not');
});

test('average water per day leaves out today and other units', () => {
  let s = water(MON);
  s = core.logAmount(s, 'h1', 1500, MON).state;
  s = openOn(s, TUE);
  s = core.logAmount(s, 'h1', 2500, TUE).state;
  const WED = '2026-09-09';
  s = openOn(s, WED);
  s = core.logAmount(s, 'h1', 250, WED).state;
  assert.deepEqual(stats.amountAverage(s, 'h1', WED, 30), { unit: 'ml', average: 2000, days: 2 });
  assert.equal(stats.amountAverage(s, 'h2', WED, 30), null, 'not an amount goal');
  s = core.updateHabit(s, 'h1', { amount: { unit: 'oz', goal: 64 } }, WED).state;
  assert.equal(stats.amountAverage(s, 'h1', WED, 30), null, 'past ml days are not mixed into oz');
});
