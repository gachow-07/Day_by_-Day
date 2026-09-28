'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { core, newChallenge, completeFullDay, completeDays } = require('./helpers.js');

const START = '2026-09-01';

test('creating a challenge starts attempt 1 at Day 1', () => {
  const s = newChallenge(START);
  assert.equal(s.schemaVersion, core.SCHEMA_VERSION);
  assert.equal(s.current.number, 1);
  assert.equal(s.current.startDate, START);
  assert.equal(core.dayNumber(s, START), 1);
  assert.equal(core.currentStreak(s), 0);
  assert.deepEqual(s.challenge.habits.map((h) => h.id), ['h1', 'h2', 'h3']);
  assert.deepEqual(core.validateState(s), []);
});

test('challenge input is validated', () => {
  assert.throws(() => core.createChallenge({ name: '', targetDays: 75, habits: ['a'] }, START));
  assert.throws(() => core.createChallenge({ name: 'x', targetDays: 0, habits: ['a'] }, START));
  assert.throws(() => core.createChallenge({ name: 'x', targetDays: 1.5, habits: ['a'] }, START));
  assert.throws(() => core.createChallenge({ name: 'x', targetDays: 75, habits: ['  ', ''] }, START));
  const s = core.createChallenge({ name: '  My   run ', targetDays: 30, habits: ['  Run ', '', 'Read'] }, START);
  assert.equal(s.challenge.name, 'My run');
  assert.deepEqual(s.challenge.habits.map((h) => h.name), ['Run', 'Read']);
});

test('completing a normal day', () => {
  let s = newChallenge(START);
  const incomplete = core.completeDay(s, START);
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.error, 'habits-incomplete');

  s = core.setHabitChecked(s, 'h1', true, START).state;
  s = core.setHabitChecked(s, 'h2', true, START).state;
  assert.equal(core.allHabitsChecked(s, START), false);
  assert.equal(core.completeDay(s, START).error, 'habits-incomplete');

  s = core.setHabitChecked(s, 'h3', true, START).state;
  const r = core.completeDay(s, START);
  assert.equal(r.ok, true);
  assert.deepEqual(r.state.current.completedDates, [START]);
  assert.equal(core.currentStreak(r.state), 1);
  assert.equal(core.bestStreak(r.state), 1);
  assert.equal(core.isDayCompleted(r.state, START), true);
  assert.deepEqual(core.validateState(r.state), []);
});

test('unchecking a habit re-blocks completion', () => {
  let s = newChallenge(START);
  for (const id of ['h1', 'h2', 'h3']) s = core.setHabitChecked(s, id, true, START).state;
  s = core.setHabitChecked(s, 'h2', false, START).state;
  assert.deepEqual(core.checkedHabitIds(s, START), ['h1', 'h3']);
  assert.equal(core.completeDay(s, START).ok, false);
});

test('transitions do not mutate their input', () => {
  const s = newChallenge(START);
  const before = JSON.stringify(s);
  core.setHabitChecked(s, 'h1', true, START);
  completeFullDay(s, START);
  core.reportFailure(s, START);
  core.evaluateMissedDays(s, '2026-09-10');
  assert.equal(JSON.stringify(s), before);
});

test('preventing duplicate completion on the same date', () => {
  const s = completeFullDay(newChallenge(START), START);
  const again = core.completeDay(s, START);
  assert.equal(again.ok, false);
  assert.equal(again.error, 'already-completed');
  assert.equal(again.state, s, 'state is returned unchanged');
  assert.equal(core.currentStreak(s), 1);
  // Habits can no longer be toggled for a completed day.
  assert.equal(core.setHabitChecked(s, 'h1', false, START).error, 'already-completed');
});

test('opening the app the day after a completed day', () => {
  const s = completeFullDay(newChallenge(START), START);
  const next = '2026-09-02';
  const r = core.evaluateMissedDays(s, next);
  assert.equal(r.restarted, false);
  assert.equal(r.state, s);
  assert.equal(core.dayNumber(s, next), 2);
  assert.deepEqual(core.checkedHabitIds(s, next), [], 'yesterday’s checks do not carry over');
  assert.equal(core.isDayCompleted(s, next), false);
  const done = completeFullDay(s, next);
  assert.equal(core.currentStreak(done), 2);
});

test('opening the app later on the start day never restarts', () => {
  const s = newChallenge(START);
  assert.equal(core.evaluateMissedDays(s, START).restarted, false);
});

test('opening the app the day after starting without completing Day 1', () => {
  // Day 1 is not finished yet if the user opens it late the same day, but
  // once the next day begins the start day was missed.
  const s = newChallenge(START);
  const r = core.evaluateMissedDays(s, '2026-09-02');
  assert.equal(r.restarted, true);
  assert.equal(r.missedDate, START);
  assert.equal(r.state.attempts[0].daysCompleted, 0);
  assert.equal(r.state.attempts[0].endDate, null);
});

test('restarting after a full missed calendar day', () => {
  let s = completeDays(newChallenge(START), START, 5); // Sep 1–5
  const r = core.evaluateMissedDays(s, '2026-09-07'); // Sep 6 missed
  assert.equal(r.restarted, true);
  assert.equal(r.missedDate, '2026-09-06');
  s = r.state;
  assert.equal(s.current.number, 2);
  assert.equal(s.current.startDate, '2026-09-07');
  assert.equal(core.dayNumber(s, '2026-09-07'), 1);
  assert.equal(core.currentStreak(s), 0);
  assert.deepEqual(s.attempts, [
    {
      number: 1,
      startDate: START,
      endDate: '2026-09-05',
      daysCompleted: 5,
      reason: 'missed',
      endedOn: '2026-09-07',
      missedDate: '2026-09-06'
    }
  ]);
  assert.equal(core.bestStreak(s), 5);
  assert.deepEqual(core.validateState(s), []);
  // Evaluating again on the same day is a no-op.
  assert.equal(core.evaluateMissedDays(s, '2026-09-07').restarted, false);
});

test('many missed days produce a single restart', () => {
  const s = completeDays(newChallenge(START), START, 2);
  const r = core.evaluateMissedDays(s, '2026-12-25');
  assert.equal(r.restarted, true);
  assert.equal(r.state.attempts.length, 1);
  assert.equal(r.state.attempts[0].missedDate, '2026-09-03');
  assert.equal(r.state.current.startDate, '2026-12-25');
});

test('a clock set backwards never restarts or completes', () => {
  const s = completeDays(newChallenge(START), START, 3);
  assert.equal(core.evaluateMissedDays(s, '2026-08-15').restarted, false);
  assert.equal(core.completeDay(s, '2026-09-02').error, 'already-completed');
  const early = core.setHabitChecked(s, 'h1', true, '2026-08-15').state;
  assert.equal(core.completeDay(early, '2026-08-15').error, 'out-of-sequence');
});

test('manual failure and restart', () => {
  let s = completeDays(newChallenge(START), START, 3); // Sep 1–3
  s = core.setHabitChecked(s, 'h1', true, '2026-09-04').state;
  const r = core.reportFailure(s, '2026-09-04');
  assert.equal(r.ok, true);
  assert.equal(r.restarted, true);
  s = r.state;
  assert.equal(s.current.number, 2);
  assert.equal(s.current.startDate, '2026-09-04');
  assert.deepEqual(core.checkedHabitIds(s, '2026-09-04'), [], 'partial checks are cleared');
  assert.equal(core.dayNumber(s, '2026-09-04'), 1);
  assert.deepEqual(s.attempts[0], {
    number: 1,
    startDate: START,
    endDate: '2026-09-03',
    daysCompleted: 3,
    reason: 'failed',
    endedOn: '2026-09-04'
  });
  // The new attempt's Day 1 can be completed the same day.
  s = completeFullDay(s, '2026-09-04');
  assert.equal(core.currentStreak(s), 1);
  assert.deepEqual(core.validateState(s), []);
});

test('manual failure after completing today ends that attempt including today', () => {
  let s = completeDays(newChallenge(START), START, 2);
  s = core.reportFailure(s, '2026-09-02').state;
  assert.equal(s.attempts[0].daysCompleted, 2);
  assert.equal(s.current.startDate, '2026-09-02');
  assert.equal(core.isDayCompleted(s, '2026-09-02'), false);
});

test('best-streak preservation across restarts', () => {
  let s = completeDays(newChallenge(START), START, 10); // best 10
  s = core.reportFailure(s, '2026-09-11').state;
  s = completeDays(s, '2026-09-11', 4);
  assert.equal(core.currentStreak(s), 4);
  assert.equal(core.bestStreak(s), 10, 'a shorter streak does not lower the best');

  s = core.evaluateMissedDays(s, '2026-09-20').state; // missed Sep 15
  assert.equal(s.attempts.length, 2);
  assert.equal(core.bestStreak(s), 10);
  assert.equal(s.bestStreak, 10);

  s = completeDays(s, '2026-09-20', 12);
  assert.equal(core.bestStreak(s), 12, 'a longer streak becomes the best');
  s = core.reportFailure(s, '2026-10-02').state;
  assert.equal(core.bestStreak(s), 12);
  assert.deepEqual(s.attempts.map((a) => a.daysCompleted), [10, 4, 12]);
});

test('finishing the challenge and starting a new attempt', () => {
  let s = newChallenge(START, { targetDays: 3 });
  s = completeDays(s, START, 2);
  const r = core.completeDay(
    ['h1', 'h2', 'h3'].reduce((acc, id) => core.setHabitChecked(acc, id, true, '2026-09-03').state, s),
    '2026-09-03'
  );
  assert.equal(r.ok, true);
  assert.equal(r.challengeComplete, true);
  s = r.state;
  assert.equal(s.current.status, 'completed');
  assert.deepEqual(core.validateState(s), []);
  // A completed challenge is not restarted by later inactivity.
  assert.equal(core.evaluateMissedDays(s, '2026-10-01').restarted, false);
  assert.equal(core.completeDay(s, '2026-09-04').error, 'challenge-complete');
  assert.equal(core.reportFailure(s, '2026-09-04').ok, false);

  const n = core.startNewAttempt(s, '2026-10-01');
  assert.equal(n.ok, true);
  assert.equal(n.state.attempts[0].reason, 'completed');
  assert.equal(n.state.current.number, 2);
  assert.equal(core.bestStreak(n.state), 3);
  assert.equal(core.startNewAttempt(n.state, '2026-10-01').ok, false);
});
