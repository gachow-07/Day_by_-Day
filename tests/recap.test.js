'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { core, stats, openOn } = require('./helpers.js');

const MON = '2026-10-05'; // Monday
const SUN = '2026-10-11';

function week() {
  let s = core.emptyState();
  s = core.addHabit(s, 'Gym', MON, { split: { type: 'weekly', days: [null, 'Legs', null, 'Push', null, 'Pull', null] } }).state;
  s = core.addHabit(s, 'Study', MON, { amount: { unit: 'min', goal: 120 } }).state;
  s = core.addHabit(s, 'Plan tomorrow', MON, { planner: { items: [{ title: 'Calculus', time: '09:00', end: '10:15', days: [1, 3, 5] }] } }).state;
  return s;
}

test('the recap sums up the 7 days ending on Sunday', () => {
  let s = week();
  for (let i = 0; i < 7; i++) {
    const d = core.addDays(MON, i);
    s = openOn(s, d);
    s = core.setHabitDone(s, 'h3', true, d).state;
    if (i === 0 || i === 2) s = core.setHabitDone(s, 'h1', true, d).state; // Mon Legs, Wed Push (Fri missed)
    if (i < 3) s = core.logAmount(s, 'h2', 90, d).state;
  }
  s = core.addAgendaItem(s, SUN, { title: 'Study' }, MON).state;
  s = core.addItemTask(s, SUN, 'p1', 'Flashcards', MON).state;
  s = core.addItemTask(s, SUN, 'p1', 'Essay outline', MON).state;
  s = core.setItemTaskDone(s, SUN, 'p1', 't1', true, MON).state;
  s = core.addItemTask(s, '2026-10-07', 'r1', 'Problem set', MON).state;
  const r = stats.weekRecap(s, SUN);
  assert.equal(r.start, MON);
  assert.equal(r.days, 7);
  assert.deepEqual(r.workouts.map((w) => w.workout), ['Legs', 'Push']);
  assert.equal(r.workoutsPlanned, 3);
  assert.equal(r.studyMinutes, 270);
  const gym = r.goals.find((g) => g.id === 'h1');
  assert.deepEqual([gym.due, gym.done, gym.rate], [3, 2, 67]);
  const plan = r.goals.find((g) => g.id === 'h3');
  assert.deepEqual([plan.due, plan.done, plan.rate], [7, 7, 100]);
  assert.equal(r.planned, 4, 'three Calculus classes and one Study session');
  assert.deepEqual([r.tasks, r.tasksDone], [3, 1]);
  assert.deepEqual(r.unfinished.map((u) => [u.date, u.item, u.text]), [
    ['2026-10-07', 'Calculus', 'Problem set'],
    [SUN, 'Study', 'Essay outline']
  ]);
});

test('an empty week has a recap with nothing in it', () => {
  const r = stats.weekRecap(core.emptyState(), SUN);
  assert.deepEqual([r.days, r.goals.length, r.planned, r.tasks, r.unfinished.length, r.studyMinutes], [0, 0, 0, 0, 0, 0]);
});

test('unfinished to-dos can be carried over into one item', () => {
  let s = week();
  const r = core.carryOverTasks(s, '2026-10-12', ['Essay outline', ' Essay  outline', 'Problem set', ''], SUN);
  assert.ok(r.ok, r.message);
  s = r.state;
  assert.equal(r.count, 2, 'duplicates and blanks dropped');
  const item = core.agendaFor(s, '2026-10-12').find((it) => it.id === r.id);
  assert.equal(item.title, 'Leftover to-dos');
  assert.equal(item.time, null);
  assert.deepEqual(core.itemDetails(s, '2026-10-12', r.id).tasks.map((t) => [t.text, t.done]), [['Essay outline', false], ['Problem set', false]]);
  assert.deepEqual(core.validateState(s), []);
  assert.equal(core.carryOverTasks(s, '2026-10-12', [], SUN).error, 'nothing');
  assert.equal(core.carryOverTasks(s, '2026-10-01', ['X'], SUN).error, 'past');
});
