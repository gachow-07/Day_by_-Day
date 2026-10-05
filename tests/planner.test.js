'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { core, withHabits, openOn } = require('./helpers.js');

const MON = '2026-09-07'; // Monday
const TUE = '2026-09-08';
const SAT = '2026-09-12';
const SCHEDULE = {
  items: [
    { title: 'Calculus', time: '09:00', end: '10:15', days: [1, 3, 5] },
    { title: 'Chemistry lab', time: '13:00', end: null, days: [2, 4] },
    { title: 'Work shift', time: null, end: null, days: [6] }
  ]
};

function withPlanner(date) {
  const s = withHabits(date, ['Plan tomorrow', 'Read']);
  const r = core.updateHabit(s, 'h1', { planner: SCHEDULE }, date);
  assert.ok(r.ok, r.message);
  return r.state;
}

const titles = (list) => list.map((it) => it.title);

test('a planner goal keeps a regular schedule with ids, and new goals have no planner', () => {
  const s = withPlanner(MON);
  assert.equal(s.habits[1].planner, null);
  assert.deepEqual(s.habits[0].planner.items.map((it) => it.id), ['r1', 'r2', 'r3']);
  assert.deepEqual(s.habits[0].planner.items[0], { id: 'r1', title: 'Calculus', time: '09:00', end: '10:15', days: [1, 3, 5] });
  assert.equal(core.plannerHabit(s).id, 'h1');
  assert.deepEqual(core.validateState(s), []);
  // Resaving keeps ids; a new row gets the next id
  const items = s.habits[0].planner.items.concat([{ title: 'Gym', time: '07:00', end: null, days: [0, 1, 2, 3, 4, 5, 6] }]);
  const r = core.updateHabit(s, 'h1', { planner: { items } }, MON);
  assert.deepEqual(r.state.habits[0].planner.items.map((it) => it.id), ['r1', 'r2', 'r3', 'r4']);
});

test('each day’s plan has that weekday’s regular items, sorted by time', () => {
  let s = withPlanner(MON);
  assert.deepEqual(titles(core.agendaFor(s, MON)), ['Calculus']);
  assert.deepEqual(titles(core.agendaFor(s, TUE)), ['Chemistry lab']);
  assert.deepEqual(titles(core.agendaFor(s, SAT)), ['Work shift']);
  s = core.addAgendaItem(s, TUE, { title: 'Dentist', time: '08:30' }, MON).state;
  s = core.addAgendaItem(s, TUE, { title: 'Call mom' }, MON).state;
  s = core.addAgendaItem(s, TUE, { title: 'Study group', time: '18:00', end: '19:30' }, MON).state;
  const tue = core.agendaFor(s, TUE);
  assert.deepEqual(titles(tue), ['Dentist', 'Chemistry lab', 'Study group', 'Call mom'], 'untimed items last');
  assert.deepEqual(tue[0], { id: 'p1', title: 'Dentist', time: '08:30', end: null, regular: false, skipped: false, done: false });
  assert.equal(tue[1].regular, true);
  assert.deepEqual(core.validateState(s), []);
});

test('plans can be made for today and up to a year ahead, not the past', () => {
  const s = withPlanner(TUE);
  assert.ok(core.addAgendaItem(s, core.addDays(TUE, 366), { title: 'Next year' }, TUE).ok);
  assert.ok(core.addAgendaItem(s, TUE, { title: 'Today thing' }, TUE).ok);
  assert.equal(core.addAgendaItem(s, MON, { title: 'Too late' }, TUE).error, 'past');
  assert.equal(core.addAgendaItem(s, core.addDays(TUE, 367), { title: 'Far' }, TUE).error, 'too-far');
  assert.equal(core.addAgendaItem(s, TUE, { title: '  ' }, TUE).error, 'invalid-title');
  assert.equal(core.addAgendaItem(s, TUE, { title: 'x'.repeat(81) }, TUE).error, 'invalid-title');
  assert.equal(core.addAgendaItem(s, TUE, { title: 'Bad', time: '25:00' }, TUE).error, 'invalid-time');
  assert.equal(core.addAgendaItem(s, TUE, { title: 'Bad', time: '10:00', end: '09:00' }, TUE).error, 'invalid-time');
  assert.equal(core.addAgendaItem(s, TUE, { title: 'Bad', end: '09:00' }, TUE).error, 'invalid-time');
});

test('skipping a class only affects that day, and items can be removed', () => {
  let s = withPlanner(MON);
  const wed = core.addDays(MON, 2);
  const fri = core.addDays(MON, 4);
  s = core.setAgendaSkip(s, wed, 'r1', true, MON).state;
  assert.equal(core.agendaFor(s, wed)[0].skipped, true);
  assert.equal(core.agendaFor(s, fri)[0].skipped, false, 'Friday still has Calculus');
  s = core.setAgendaSkip(s, wed, 'r1', false, MON).state;
  assert.equal(s.agenda[wed], undefined, 'nothing left to store');
  assert.equal(core.setAgendaSkip(s, wed, 'r2', true, MON).error, 'unknown-item', 'r2 is not on Wednesdays');
  s = core.addAgendaItem(s, wed, { title: 'Haircut' }, MON).state;
  s = core.removeAgendaItem(s, wed, 'p1', MON).state;
  assert.deepEqual(titles(core.agendaFor(s, wed)), ['Calculus']);
  assert.equal(core.removeAgendaItem(s, wed, 'p1', MON).error, 'unknown-item');
});

test('today’s plan can be ticked off; skipped and removed items lose their tick', () => {
  let s = withPlanner(MON);
  s = core.addAgendaItem(s, MON, { title: 'Groceries' }, MON).state;
  s = core.setAgendaDone(s, MON, 'r1', true, MON).state;
  s = core.setAgendaDone(s, MON, 'p1', true, MON).state;
  assert.deepEqual(core.agendaFor(s, MON).map((it) => it.done), [true, true]);
  assert.equal(core.setAgendaDone(s, TUE, 'r2', true, MON).error, 'not-today');
  s = core.removeAgendaItem(s, MON, 'p1', MON).state;
  assert.deepEqual(s.agenda[MON].done, ['r1']);
  s = core.setAgendaSkip(s, MON, 'r1', true, MON).state;
  assert.equal(s.agenda[MON].done, undefined);
  assert.equal(core.setAgendaDone(s, MON, 'r1', true, MON).error, 'unknown-item', 'skipped items can’t be ticked');
});

test('the planner goal is an ordinary goal: it’s checked off like any other', () => {
  let s = withPlanner(MON);
  s = openOn(s, MON);
  assert.ok(s.days[MON].habits.some((h) => h.id === 'h1'));
  const r = core.setHabitDone(s, 'h1', true, MON);
  assert.ok(r.ok);
  assert.deepEqual(r.state.days[MON].done, ['h1']);
});

test('only the first active planner goal drives the plan; paused planners don’t', () => {
  let s = withPlanner(MON);
  s = core.setHabitStatus(s, 'h1', 'paused', MON).state;
  assert.equal(core.plannerHabit(s), null);
  assert.deepEqual(core.agendaFor(s, MON), []);
});

test('planner goals can’t also track amounts or workouts, and bad schedules are rejected', () => {
  const s = withHabits(MON, ['Plan']);
  assert.equal(core.updateHabit(s, 'h1', { planner: SCHEDULE, amount: { unit: 'min', goal: 30 } }, MON).error, 'invalid-details');
  const withAmount = core.updateHabit(s, 'h1', { amount: { unit: 'min', goal: 30 } }, MON).state;
  assert.equal(core.updateHabit(withAmount, 'h1', { planner: SCHEDULE }, MON).error, 'invalid-details');
  assert.equal(core.addHabit(s, 'Plan 2', MON, { planner: SCHEDULE, split: { type: 'weekly', days: ['Legs', null, null, null, null, null, null] } }).error, 'invalid-details');
  const bad = (items) => core.cleanPlanner({ items }).error;
  assert.match(bad([{ title: 'Class', time: '09:00', days: [] }]), /Choose the days/);
  assert.match(bad([{ title: '', time: '09:00', days: [1] }]), /Give each item/);
  assert.match(bad([{ title: 'Class', time: '9am', days: [1] }]), /like 09:30/);
  assert.equal(bad([{ title: '', time: '', end: '', days: [1] }]), undefined, 'blank rows are dropped');
  assert.deepEqual(core.cleanPlanner({ items: [] }).planner, { items: [] }, 'a planner without a regular schedule is fine');
  assert.ok(bad(Array.from({ length: 31 }, (_, i) => ({ title: 'C' + i, days: [1] }))));
});

test('validation rejects damaged planners and agendas', () => {
  const s = withPlanner(MON);
  const cases = {
    'unknown planner key': (x) => { x.habits[0].planner.extra = 1; },
    'duplicate regular ids': (x) => { x.habits[0].planner.items[1].id = 'r1'; },
    'unsorted days': (x) => { x.habits[0].planner.items[0].days = [5, 1]; },
    'end before start': (x) => { x.habits[0].planner.items[0].end = '08:00'; },
    'agenda not an object': (x) => { x.agenda = []; },
    'bad agenda date': (x) => { x.agenda['2026-02-30'] = {}; },
    'bad item id': (x) => { x.agenda[MON] = { items: [{ id: 'r1', title: 'A', time: null, end: null }] }; },
    'done for a missing item': (x) => { x.agenda[MON] = { done: ['p4'] }; },
    'unknown agenda key': (x) => { x.agenda[MON] = { notes: 'hi' }; },
    'untrimmed title': (x) => { x.agenda[MON] = { items: [{ id: 'p1', title: ' A', time: null, end: null }] }; }
  };
  for (const [name, damage] of Object.entries(cases)) {
    const x = JSON.parse(JSON.stringify(s));
    damage(x);
    assert.ok(core.validateState(x).length, name);
  }
});

test('version 9 data gets planner: null and an empty agenda; plans export and import', () => {
  const s = withPlanner(MON);
  const v9 = JSON.parse(JSON.stringify(s));
  v9.schemaVersion = 9;
  delete v9.agenda;
  v9.habits.forEach((h) => { delete h.planner; });
  const r = core.migrate(v9);
  assert.ok(r.ok, r.message);
  assert.equal(r.state.schemaVersion, 10);
  assert.deepEqual(r.state.agenda, {});
  assert.ok(r.state.habits.every((h) => h.planner === null));
  let p = core.addAgendaItem(s, TUE, { title: 'Dentist', time: '08:30' }, MON).state;
  p = core.setAgendaSkip(p, TUE, 'r2', true, MON).state;
  const back = core.parseImport(JSON.stringify(core.buildExport(p, new Date())));
  assert.ok(back.ok, back.message);
  assert.deepEqual(back.state.agenda, p.agenda);
  assert.deepEqual(back.state.habits[0].planner, p.habits[0].planner);
});
