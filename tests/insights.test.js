'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { core, stats, withHabits, play } = require('./helpers.js');

const START = '2026-08-03'; // a Monday

test('no insights before a week of tracked days, with the exact number needed', () => {
  const s = play(withHabits(START), START, '✓✓✓✓');
  const r = stats.insights(s, core.addDays(START, 3));
  assert.equal(r.trackedDays, 4);
  assert.equal(r.needed, 3);
  assert.deepEqual(r.items, []);
});

test('week-over-week change needs enough days in both weeks', () => {
  const s = play(withHabits(START), START, '✓✓✓✓✓✓✓');
  const wow = stats.weekOverWeek(s, core.addDays(START, 6));
  assert.equal(wow.available, false, 'no previous week yet');
  const r = stats.insights(s, core.addDays(START, 6));
  assert.equal(r.needed, 0);
  assert.equal(r.items[0].id, 'week');
  assert.match(r.items[0].text, /100% of goals done this week/);
});

test('week-over-week change is reported in points, up or down', () => {
  // Week 1: all ✓ except two partials; week 2: all ✓.
  const s = play(withHabits(START, ['A', 'B']), START, '✓½✓½✓✓✓' + '✓✓✓✓✓✓✓');
  const today = core.addDays(START, 13);
  const wow = stats.weekOverWeek(s, today);
  assert.equal(wow.available, true);
  assert.equal(wow.thisWeek.rate, 100);
  assert.equal(wow.lastWeek.rate, Math.round((12 / 14) * 100));
  assert.equal(wow.change, 100 - 86);
  const item = stats.insights(s, today).items.find((i) => i.id === 'trend');
  assert.match(item.text, /100% of goals done this week, up 14 points on last week/);
  assert.equal(item.tone, 'up');
});

test('biggest opportunity names a goal only when it clearly lags', () => {
  // Read (h2) is missed on alternate days; Workout and Water always done.
  let s = withHabits(START, ['Workout', 'Read', 'Water']);
  for (let i = 0; i < 14; i++) {
    const d = core.addDays(START, i);
    s = core.ensureDays(s, d).state;
    for (const id of i % 2 ? ['h1', 'h3'] : ['h1', 'h2', 'h3']) s = core.setHabitDone(s, id, true, d).state;
  }
  const r = stats.insights(s, core.addDays(START, 13));
  const opp = r.items.find((i) => i.id === 'opportunity');
  assert.ok(opp, JSON.stringify(r.items));
  // 7 of 13 due days: today (not ticked yet) isn't counted because it isn't over.
  assert.match(opp.text, /^Read has the most room to grow: 54% this month/);
  // When every goal is done evenly, no goal is singled out.
  const even = play(withHabits(START, ['A', 'B']), START, '✓'.repeat(14));
  assert.equal(stats.insights(even, core.addDays(START, 13)).items.some((i) => i.id === 'opportunity'), false);
});

test('strongest and weakest weekday need two weeks and a real difference', () => {
  // Fridays partial, everything else done, over 3 weeks.
  const pattern = ('✓✓✓✓½✓✓').repeat(3);
  const s = play(withHabits(START, ['A', 'B']), START, pattern);
  const today = core.addDays(START, 20);
  const wd = stats.weekdayStrength(s, today);
  assert.equal(wd.available, true);
  assert.equal(wd.weakest.dow, 5, 'Friday');
  assert.equal(wd.weakest.rate, 50);
  const text = stats.insights(s, today).items.find((i) => i.id === 'weekday').text;
  assert.match(text, /s are your most consistent \(100%\)\. Fridays are hardest \(50%\)/);
  // Perfectly even history: no weekday insight.
  const even = play(withHabits(START), START, '✓'.repeat(21));
  assert.equal(stats.weekdayStrength(even, today).available, false);
  // Too little data: no weekday insight.
  assert.equal(stats.weekdayStrength(play(withHabits(START), START, '✓½✓'), core.addDays(START, 2)).available, false);
});

test('insight day names can be localised', () => {
  const s = play(withHabits(START, ['A', 'B']), START, ('✓✓✓✓½✓✓').repeat(3));
  const r = stats.insights(s, core.addDays(START, 20), (d) => 'D' + d);
  assert.match(r.items.find((i) => i.id === 'weekday').text, /D5s are hardest/);
});

test('week start helper', () => {
  assert.equal(stats.weekStartOf('2026-09-13', 0), '2026-09-13'); // Sunday
  assert.equal(stats.weekStartOf('2026-09-13', 1), '2026-09-07'); // Monday before
  assert.equal(stats.weekStartOf('2026-09-07', 1), '2026-09-07');
});
