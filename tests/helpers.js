'use strict';

const core = require('../js/core.js');
const stats = require('../js/stats.js');

const HABITS = ['Workout', 'Read', 'Drink water'];

/** A state with `names` as active habits, all created on `start`. */
function withHabits(start, names) {
  let s = core.emptyState();
  for (const n of names || HABITS) {
    const r = core.addHabit(s, n, start);
    if (!r.ok) throw new Error(r.message);
    s = r.state;
  }
  return s;
}

/** Open the app on `date` (fills missed days, creates today's record). */
function openOn(state, date) {
  return core.ensureDays(state, date).state;
}

/** Open on `date` and tick `ids` (default: every habit required that day). */
function tick(state, date, ids) {
  let s = openOn(state, date);
  const todo = ids || s.days[date].habits.map((h) => h.id);
  for (const id of todo) {
    const r = core.setHabitDone(s, id, true, date);
    if (!r.ok) throw new Error('tick failed on ' + date + ': ' + r.error);
    s = r.state;
  }
  return s;
}

/**
 * Build history from a pattern starting on `start`, one character per day:
 *   '✓' every habit done   '½' first habit only   '✗' opened, nothing done
 *   '.' app not opened (the next open back-fills it as missed)
 */
function play(state, start, pattern) {
  let s = state;
  [...pattern].forEach((c, i) => {
    const d = core.addDays(start, i);
    if (c === '✓') s = tick(s, d);
    else if (c === '½') s = tick(s, d, [openOn(s, d).days[d].habits[0].id]);
    else if (c === '✗') s = openOn(s, d);
    else if (c !== '.') throw new Error('bad pattern char ' + c);
  });
  return s;
}

/** Minimal in-memory localStorage replacement. */
class FakeStorage {
  constructor(initial) {
    this.data = new Map(Object.entries(initial || {}));
    this.failWrites = false;
  }
  getItem(key) {
    return this.data.has(key) ? this.data.get(key) : null;
  }
  setItem(key, value) {
    if (this.failWrites) throw new Error('QuotaExceededError');
    this.data.set(key, String(value));
  }
  removeItem(key) {
    this.data.delete(key);
  }
  keys() {
    return Array.from(this.data.keys());
  }
}

/** A valid schema-2 (fixed-length challenge) document, as the old app saved it. */
function v2Doc(overrides) {
  return Object.assign({
    schemaVersion: 2,
    challenge: {
      name: '75 Hard',
      targetDays: 75,
      habits: [{ id: 'h1', name: 'Workout' }, { id: 'h2', name: 'Read' }],
      createdOn: '2026-09-01'
    },
    current: {
      number: 2,
      startDate: '2026-09-05',
      status: 'active',
      completedDates: ['2026-09-05', '2026-09-06'],
      checked: { date: '2026-09-07', habitIds: ['h2'] }
    },
    attempts: [
      { number: 1, startDate: '2026-09-01', endDate: '2026-09-03', daysCompleted: 3, reason: 'missed', endedOn: '2026-09-05', missedDate: '2026-09-04' }
    ],
    bestStreak: 3
  }, overrides || {});
}

module.exports = { core, stats, HABITS, withHabits, openOn, tick, play, FakeStorage, v2Doc };
