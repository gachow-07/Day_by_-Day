'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { core } = require('./helpers.js');

const TODAY = '2026-10-12';

test('to-dos can be added (newest first), ticked, edited, removed and cleared', () => {
  let s = core.emptyState();
  s = core.addTodo(s, ' Email  advisor ', null).state;
  s = core.addTodo(s, 'Pay rent', '2026-11-01').state;
  assert.deepEqual(s.todos, [
    { id: 'd2', text: 'Pay rent', done: false, due: '2026-11-01' },
    { id: 'd1', text: 'Email advisor', done: false, due: null }
  ]);
  s = core.setTodoDone(s, 'd1', true).state;
  assert.equal(s.todos[1].done, true);
  s = core.updateTodo(s, 'd2', { text: 'Pay rent + utilities', due: null }).state;
  assert.deepEqual(s.todos[0], { id: 'd2', text: 'Pay rent + utilities', done: false, due: null });
  assert.deepEqual(core.validateState(s), []);
  const cleared = core.clearDoneTodos(s);
  assert.equal(cleared.count, 1);
  assert.deepEqual(cleared.state.todos.map((t) => t.id), ['d2']);
  assert.equal(core.clearDoneTodos(cleared.state).count, 0);
  s = core.removeTodo(cleared.state, 'd2').state;
  assert.deepEqual(s.todos, []);
  assert.equal(core.addTodo(s, '   ').error, 'invalid-text');
  assert.equal(core.addTodo(s, 'x'.repeat(121)).error, 'invalid-text');
  assert.equal(core.addTodo(s, 'X', '2026-02-30').error, 'invalid-date');
  assert.equal(core.removeTodo(s, 'd9').error, 'unknown-todo');
});

test('important dates: one-offs and yearly ones, soonest first with countdowns', () => {
  let s = core.emptyState();
  s = core.addImportantDate(s, { title: 'Midterm', date: '2026-10-20' }).state;
  s = core.addImportantDate(s, { title: 'Mom’s birthday', date: '1970-03-04', yearly: true }).state;
  s = core.addImportantDate(s, { title: 'Old deadline', date: '2026-09-01' }).state;
  s = core.addImportantDate(s, { title: 'Anniversary', date: '2020-10-12', yearly: true }).state;
  assert.deepEqual(core.validateState(s), []);
  const up = core.upcomingDates(s, TODAY);
  assert.deepEqual(up.map((u) => [u.title, u.date, u.days]), [
    ['Anniversary', '2026-10-12', 0],
    ['Midterm', '2026-10-20', 8],
    ['Mom’s birthday', '2027-03-04', 143]
  ], 'past one-offs drop out; yearly ones roll over');
  assert.equal(up[0].years, 6);
  assert.equal(up[2].years, 57);
  assert.equal(up[1].years, undefined);
  assert.deepEqual(core.upcomingDates(s, TODAY, 1).length, 1);
  assert.deepEqual(core.datesOn(s, '2027-03-04').map((e) => e.title), ['Mom’s birthday']);
  assert.deepEqual(core.datesOn(s, '1969-03-04'), [], 'not before it started');
  assert.deepEqual(core.datesOn(s, '2026-09-01').map((e) => e.title), ['Old deadline']);
  s = core.removeImportantDate(s, 'e3').state;
  assert.equal(s.dates.length, 3);
  assert.equal(core.addImportantDate(s, { title: '', date: TODAY }).error, 'invalid-title');
  assert.equal(core.addImportantDate(s, { title: 'X', date: 'soon' }).error, 'invalid-date');
});

test('a Feb 29 birthday falls on Feb 28 in other years', () => {
  let s = core.addImportantDate(core.emptyState(), { title: 'Leap kid', date: '2004-02-29', yearly: true }).state;
  assert.equal(core.upcomingDates(s, TODAY)[0].date, '2027-02-28');
  assert.equal(core.nextOccurrence(s.dates[0], '2027-12-01'), '2028-02-29');
  assert.deepEqual(core.datesOn(s, '2027-02-28').map((e) => e.title), ['Leap kid']);
});

test('to-dos and dates are validated, exported and migrated', () => {
  let s = core.addTodo(core.emptyState(), 'Return library books', '2026-10-15').state;
  s = core.addImportantDate(s, { title: 'Exam', date: '2026-12-10' }).state;
  const back = core.parseImport(JSON.stringify(core.buildExport(s, new Date())));
  assert.ok(back.ok, back.message);
  assert.deepEqual(back.state.todos, s.todos);
  assert.deepEqual(back.state.dates, s.dates);
  const bad = {
    'todos not a list': (x) => { x.todos = {}; },
    'todo without done': (x) => { delete x.todos[0].done; },
    'bad due': (x) => { x.todos[0].due = 'Friday'; },
    'duplicate todo id': (x) => { x.todos.push(Object.assign({}, x.todos[0])); },
    'date without yearly': (x) => { delete x.dates[0].yearly; },
    'untrimmed title': (x) => { x.dates[0].title = ' Exam'; }
  };
  for (const [name, damage] of Object.entries(bad)) {
    const x = JSON.parse(JSON.stringify(s));
    damage(x);
    assert.ok(core.validateState(x).length, name);
  }
  const v11 = JSON.parse(JSON.stringify(core.emptyState()));
  v11.schemaVersion = 11;
  delete v11.todos;
  delete v11.dates;
  const m = core.migrate(v11);
  assert.ok(m.ok, m.message);
  assert.equal(m.state.schemaVersion, 12);
  assert.deepEqual([m.state.todos, m.state.dates], [[], []]);
});
