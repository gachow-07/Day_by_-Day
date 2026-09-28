'use strict';

const core = require('../js/core.js');

const HABITS = ['Workout', 'Read 10 pages', 'Drink water'];

/** A new 75-day challenge starting on `start`. */
function newChallenge(start, options) {
  const opts = options || {};
  return core.createChallenge(
    { name: opts.name || 'Test challenge', targetDays: opts.targetDays || 75, habits: opts.habits || HABITS },
    start
  );
}

/** Check every habit and complete `date`. Throws if completion fails. */
function completeFullDay(state, date) {
  let s = state;
  for (const h of s.challenge.habits) {
    const r = core.setHabitChecked(s, h.id, true, date);
    if (!r.ok) throw new Error('check failed: ' + r.error);
    s = r.state;
  }
  const r = core.completeDay(s, date);
  if (!r.ok) throw new Error('complete failed on ' + date + ': ' + r.error);
  return r.state;
}

/** Complete `count` consecutive days starting at `start`. */
function completeDays(state, start, count) {
  let s = state;
  for (let i = 0; i < count; i++) s = completeFullDay(s, core.addDays(start, i));
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

module.exports = { core, HABITS, newChallenge, completeFullDay, completeDays, FakeStorage };
