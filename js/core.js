/*
 * Day by Day — core logic.
 *
 * Pure functions for dates, habits, daily records, validation, schema
 * migration and import/export. Nothing in this file touches the DOM or
 * localStorage, so it can be tested directly with Node. Streaks and other
 * statistics are calculated from the daily records in stats.js.
 *
 * Every function that changes state returns a NEW state object; inputs are
 * never mutated.
 *
 * Dates are local calendar days represented as "YYYY-MM-DD" strings
 * ("date keys"). Date arithmetic is done in UTC milliseconds so daylight
 * saving changes can never make a day 23 or 25 hours long.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DayByDayCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SCHEMA_VERSION = 3;
  var APP_ID = 'day-by-day';
  var DAY_MS = 24 * 60 * 60 * 1000;
  var MIN_YEAR = 1970;
  var MAX_YEAR = 9999;
  var MAX_NAME_LENGTH = 120;
  var MAX_ACTIVE_HABITS = 20;
  var MAX_TOTAL_HABITS = 200;
  var MAX_DAYS = 36600;          // about 100 years of records
  var MAX_FILL_DAYS = 3660;      // never back-fill more than ~10 years at once
  var HABIT_STATUSES = ['active', 'paused', 'archived'];
  var DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

  // Limits of the old (schema 1–2) challenge format, used only by migrations.
  var MAX_TARGET_DAYS = 1000;
  var MAX_HABITS = 20;
  var END_REASONS = ['missed', 'failed', 'completed'];

  /* ------------------------------------------------------------------ */
  /* Dates                                                               */
  /* ------------------------------------------------------------------ */

  function pad(n, width) {
    var s = String(n);
    while (s.length < width) s = '0' + s;
    return s;
  }

  function isLeapYear(year) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  }

  function daysInMonth(year, month) {
    if (month === 2) return isLeapYear(year) ? 29 : 28;
    return [4, 6, 9, 11].indexOf(month) >= 0 ? 30 : 31;
  }

  function isValidDateKey(key) {
    if (typeof key !== 'string') return false;
    var m = DATE_RE.exec(key);
    if (!m) return false;
    var y = Number(m[1]);
    var mo = Number(m[2]);
    var d = Number(m[3]);
    if (y < MIN_YEAR || y > MAX_YEAR) return false;
    if (mo < 1 || mo > 12) return false;
    return d >= 1 && d <= daysInMonth(y, mo);
  }

  function keyToUTC(key) {
    if (!isValidDateKey(key)) throw new RangeError('Invalid date: ' + String(key));
    var parts = key.split('-');
    return Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  }

  function utcToKey(ms) {
    var d = new Date(ms);
    return pad(d.getUTCFullYear(), 4) + '-' + pad(d.getUTCMonth() + 1, 2) + '-' + pad(d.getUTCDate(), 2);
  }

  /** The user's local calendar date for a Date (defaults to now). */
  function toDateKey(date) {
    var d = date || new Date();
    return pad(d.getFullYear(), 4) + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2);
  }

  function addDays(key, n) {
    return utcToKey(keyToUTC(key) + n * DAY_MS);
  }

  /** Whole calendar days from `a` to `b` (positive when b is later). */
  function daysBetween(a, b) {
    return Math.round((keyToUTC(b) - keyToUTC(a)) / DAY_MS);
  }


  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */

  /*
   * State (schema 3)
   *   habits: [{ id, name, createdOn, status, archivedOn }]
   *     status is 'active', 'paused' or 'archived'; array order is display order.
   *   days: { 'YYYY-MM-DD': { habits: [{ id, name }], done: [id] } }
   *     One record per calendar date: a snapshot of the habits that were
   *     required that day (with their names at the time) and which were done.
   *     Past records are never rewritten when habits change later. Only
   *     today's record follows the current habit list.
   */

  function emptyState() {
    return { schemaVersion: SCHEMA_VERSION, habits: [], days: {} };
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function cleanName(value) {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  }

  function result(state, extra) {
    var r = { ok: true, state: state };
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) r[k] = extra[k];
    return r;
  }

  function failure(state, error, message) {
    return { ok: false, state: state, error: error, message: message };
  }

  function findHabit(state, id) {
    for (var i = 0; i < state.habits.length; i++) if (state.habits[i].id === id) return state.habits[i];
    return null;
  }

  function activeHabits(state) {
    return state.habits.filter(function (h) { return h.status === 'active'; });
  }

  /** Validate a habit name. Returns an error message or ''. */
  function habitNameError(name) {
    var n = cleanName(name);
    if (!n) return 'Give the goal a name.';
    if (n.length > MAX_NAME_LENGTH) return 'Goal names must be ' + MAX_NAME_LENGTH + ' characters or fewer.';
    return '';
  }

  function nextHabitId(state) {
    var max = 0;
    state.habits.forEach(function (h) {
      var m = /^h(\d+)$/.exec(h.id);
      if (m && Number(m[1]) > max) max = Number(m[1]);
    });
    return 'h' + (max + 1);
  }

  function sortedDates(state) {
    return Object.keys(state.days).sort();
  }

  /** Totals for one daily record. */
  function recordSummary(record) {
    var total = record ? record.habits.length : 0;
    var completed = record ? record.done.length : 0;
    return {
      total: total,
      completed: completed,
      percentage: total ? Math.round((completed / total) * 100) : 0,
      lockedIn: total > 0 && completed === total
    };
  }

  /* ------------------------------------------------------------------ */
  /* Daily records                                                       */
  /* ------------------------------------------------------------------ */

  function snapshotActive(state) {
    return activeHabits(state).map(function (h) { return { id: h.id, name: h.name }; });
  }

  /**
   * Make `next`'s record for `today` mirror the current active habits:
   * same order and current names, keeping ticks for habits still active.
   * Creates the record if there are active habits and none exists yet.
   * Only ever touches today's record.
   */
  function syncTodayRecord(next, today) {
    var snap = snapshotActive(next);
    var rec = next.days[today];
    if (!rec) {
      if (!snap.length) return next;
      next.days[today] = { habits: snap, done: [] };
      return next;
    }
    if (!snap.length) {
      // Nothing is required today any more: a neutral day, not a record.
      delete next.days[today];
      return next;
    }
    var ids = snap.map(function (h) { return h.id; });
    rec.habits = snap;
    rec.done = ids.filter(function (id) { return rec.done.indexOf(id) >= 0; });
    return next;
  }

  /**
   * Bring the history up to `today`. Days since the last record, when the
   * app wasn't opened, get records with nothing done, using the habits
   * active now (habits can only change while the app is open, so these are
   * the habits that were required on those days). Also creates today's
   * record. Returns { state, missed: [dates] }.
   */
  function ensureDays(state, today) {
    if (!isValidDateKey(today)) throw new RangeError('Invalid date: ' + String(today));
    var dates = sortedDates(state);
    var last = dates.length ? dates[dates.length - 1] : null;
    var snap = snapshotActive(state);
    var missed = [];
    var next = null;
    if (snap.length && last && last < today) {
      var gap = daysBetween(last, today) - 1;
      if (gap > MAX_FILL_DAYS) gap = MAX_FILL_DAYS;
      var start = addDays(today, -gap);
      for (var i = 0; i < gap; i++) {
        var d = addDays(start, i);
        if (!next) next = clone(state);
        next.days[d] = { habits: clone(snap), done: [] };
        missed.push(d);
      }
    }
    if (snap.length && !state.days[today]) {
      if (!next) next = clone(state);
      next.days[today] = { habits: clone(snap), done: [] };
    }
    return { state: next || state, changed: !!next, missed: missed };
  }

  /** Tick or untick a habit for today. Only today can be changed. */
  function setHabitDone(state, habitId, done, today) {
    var rec = state.days[today];
    if (!rec || !rec.habits.some(function (h) { return h.id === habitId; })) {
      return failure(state, 'not-today', 'That goal is not on today’s list.');
    }
    var next = clone(state);
    var r = next.days[today];
    var ids = r.done.filter(function (id) { return id !== habitId; });
    if (done) ids.push(habitId);
    var order = r.habits.map(function (h) { return h.id; });
    r.done = order.filter(function (id) { return ids.indexOf(id) >= 0; });
    return result(next, { lockedIn: recordSummary(r).lockedIn });
  }

  /* ------------------------------------------------------------------ */
  /* Managing habits                                                     */
  /* ------------------------------------------------------------------ */

  function addHabit(state, name, today) {
    var error = habitNameError(name);
    if (error) return failure(state, 'invalid-name', error);
    if (activeHabits(state).length >= MAX_ACTIVE_HABITS) {
      return failure(state, 'too-many', 'You can have up to ' + MAX_ACTIVE_HABITS + ' active goals.');
    }
    if (state.habits.length >= MAX_TOTAL_HABITS) {
      return failure(state, 'too-many', 'Too many goals. Delete some archived ones first.');
    }
    var next = clone(state);
    var id = nextHabitId(next);
    next.habits.push({ id: id, name: cleanName(name), createdOn: today, status: 'active', archivedOn: null });
    return result(syncTodayRecord(next, today), { id: id });
  }

  function renameHabit(state, id, name, today) {
    var error = habitNameError(name);
    if (error) return failure(state, 'invalid-name', error);
    if (!findHabit(state, id)) return failure(state, 'unknown-habit', 'That goal no longer exists.');
    var next = clone(state);
    findHabit(next, id).name = cleanName(name);
    return result(syncTodayRecord(next, today), {});
  }

  /** Move a habit up (-1) or down (+1) past its neighbour in the same group. */
  function moveHabit(state, id, delta, today) {
    var habit = findHabit(state, id);
    if (!habit) return failure(state, 'unknown-habit', 'That goal no longer exists.');
    var group = state.habits.filter(function (h) { return h.status === habit.status; });
    var gi = group.indexOf(habit);
    var target = group[gi + delta];
    if (!target) return failure(state, 'edge', 'That goal is already at the ' + (delta < 0 ? 'top.' : 'bottom.'));
    var next = clone(state);
    var a = next.habits.map(function (h) { return h.id; }).indexOf(id);
    var b = next.habits.map(function (h) { return h.id; }).indexOf(target.id);
    var tmp = next.habits[a];
    next.habits[a] = next.habits[b];
    next.habits[b] = tmp;
    return result(syncTodayRecord(next, today), {});
  }

  /** Change status: 'active' (resume/restore), 'paused' or 'archived'. */
  function setHabitStatus(state, id, status, today) {
    if (HABIT_STATUSES.indexOf(status) < 0) return failure(state, 'invalid-status', 'Unknown status.');
    var habit = findHabit(state, id);
    if (!habit) return failure(state, 'unknown-habit', 'That goal no longer exists.');
    if (status === 'active' && habit.status !== 'active' && activeHabits(state).length >= MAX_ACTIVE_HABITS) {
      return failure(state, 'too-many', 'You can have up to ' + MAX_ACTIVE_HABITS + ' active goals.');
    }
    var next = clone(state);
    var h = findHabit(next, id);
    h.status = status;
    h.archivedOn = status === 'archived' ? today : null;
    return result(syncTodayRecord(next, today), {});
  }

  /** Dates (other than today) whose records include this habit. */
  function habitHistoryDates(state, id, today) {
    return sortedDates(state).filter(function (d) {
      return d !== today && state.days[d].habits.some(function (h) { return h.id === id; });
    });
  }

  /**
   * Delete a habit completely. Only allowed when it has no history before
   * today, so past records are never rewritten; otherwise archive it.
   */
  function deleteHabit(state, id, today) {
    if (!findHabit(state, id)) return failure(state, 'unknown-habit', 'That goal no longer exists.');
    if (habitHistoryDates(state, id, today).length) {
      return failure(state, 'has-history', 'This goal has history, so it can be archived but not deleted.');
    }
    var next = clone(state);
    next.habits = next.habits.filter(function (h) { return h.id !== id; });
    if (next.days[today]) {
      var rec = next.days[today];
      rec.habits = rec.habits.filter(function (h) { return h.id !== id; });
      rec.done = rec.done.filter(function (d) { return d !== id; });
      if (!rec.habits.length) delete next.days[today];
    }
    return result(syncTodayRecord(next, today), {});
  }

  /* ------------------------------------------------------------------ */
  /* Validation                                                          */
  /* ------------------------------------------------------------------ */

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function isNonNegInt(v) {
    return Number.isInteger(v) && v >= 0;
  }

  function validName(n) {
    return typeof n === 'string' && !!n.trim() && n.length <= MAX_NAME_LENGTH;
  }

  /**
   * Validate a current-schema state. Returns a list of problems (empty
   * when valid): structure, plus the invariants the app relies on, such as
   * every record only referring to known habits and no duplicates.
   */
  function validateState(s) {
    var errors = [];
    function err(msg) { if (errors.length < 20) errors.push(msg); }
    if (!isPlainObject(s)) return ['Data must be an object.'];
    if (s.schemaVersion !== SCHEMA_VERSION) err('schemaVersion must be ' + SCHEMA_VERSION + '.');

    var ids = [];
    if (!Array.isArray(s.habits)) {
      err('habits must be a list.');
    } else {
      if (s.habits.length > MAX_TOTAL_HABITS) err('Too many habits.');
      var active = 0;
      s.habits.forEach(function (h, i) {
        var label = 'habits[' + i + ']';
        if (!isPlainObject(h) || typeof h.id !== 'string' || !/^[\w-]{1,40}$/.test(h.id)) { err(label + ' has an invalid id.'); return; }
        if (ids.indexOf(h.id) >= 0) err('Habit id "' + h.id + '" is duplicated.');
        ids.push(h.id);
        if (!validName(h.name)) err(label + '.name is missing or too long.');
        if (!isValidDateKey(h.createdOn)) err(label + '.createdOn is not a valid date.');
        if (HABIT_STATUSES.indexOf(h.status) < 0) err(label + '.status is invalid.');
        if (h.status === 'active') active++;
        if (h.status === 'archived' ? !isValidDateKey(h.archivedOn) : h.archivedOn !== null) {
          err(label + '.archivedOn does not match its status.');
        }
      });
      if (active > MAX_ACTIVE_HABITS) err('Too many active habits.');
    }

    if (!isPlainObject(s.days)) {
      err('days must be an object keyed by date.');
      return errors;
    }
    var dates = Object.keys(s.days);
    if (dates.length > MAX_DAYS) err('Too many daily records.');
    dates.forEach(function (d) {
      var rec = s.days[d];
      var label = 'days[' + d + ']';
      if (!isValidDateKey(d)) { err(label + ' is not a valid date.'); return; }
      if (!isPlainObject(rec) || !Array.isArray(rec.habits) || !Array.isArray(rec.done)) { err(label + ' is invalid.'); return; }
      if (rec.habits.length > MAX_ACTIVE_HABITS) err(label + ' has too many habits.');
      var recIds = [];
      rec.habits.forEach(function (h) {
        if (!isPlainObject(h) || typeof h.id !== 'string' || !validName(h.name)) { err(label + ' has an invalid habit.'); return; }
        if (recIds.indexOf(h.id) >= 0) err(label + ' lists a habit twice.');
        if (ids.indexOf(h.id) < 0) err(label + ' refers to an unknown habit.');
        recIds.push(h.id);
      });
      var seen = [];
      rec.done.forEach(function (id) {
        if (recIds.indexOf(id) < 0 || seen.indexOf(id) >= 0) err(label + ' has an invalid completed habit.');
        seen.push(id);
      });
    });
    return errors;
  }

  /**
   * Validate old schema-2 (challenge) data before migrating it, so damaged
   * old data is reported instead of being converted into nonsense.
   */
  function validateV2(s) {
    var errors = [];
    function err(msg) { errors.push(msg); }

    if (!isPlainObject(s)) return ['Data must be an object.'];
    if (s.schemaVersion !== 2) err("schemaVersion must be 2.");
    if (!Array.isArray(s.attempts)) err('attempts must be a list.');
    if (!isNonNegInt(s.bestStreak)) err('bestStreak must be a whole number.');

    if (s.challenge === null) {
      if (s.current !== null) err('current must be empty when there is no challenge.');
      return errors;
    }

    var c = s.challenge;
    var habitIds = [];
    if (!isPlainObject(c)) {
      err('challenge must be an object.');
      return errors;
    }
    if (typeof c.name !== 'string' || !c.name.trim() || c.name.length > MAX_NAME_LENGTH) err('challenge.name is missing or too long.');
    if (!Number.isInteger(c.targetDays) || c.targetDays < 1 || c.targetDays > MAX_TARGET_DAYS) err('challenge.targetDays is invalid.');
    if (!isValidDateKey(c.createdOn)) err('challenge.createdOn is not a valid date.');
    if (!Array.isArray(c.habits) || c.habits.length === 0 || c.habits.length > MAX_HABITS) {
      err('challenge.habits must list 1 to ' + MAX_HABITS + ' habits.');
    } else {
      c.habits.forEach(function (h, i) {
        if (!isPlainObject(h) || typeof h.id !== 'string' || !h.id || typeof h.name !== 'string' || !h.name.trim() || h.name.length > MAX_NAME_LENGTH) {
          err('challenge.habits[' + i + '] is invalid.');
          return;
        }
        if (habitIds.indexOf(h.id) >= 0) err('Habit id "' + h.id + '" is duplicated.');
        habitIds.push(h.id);
      });
    }

    var cur = s.current;
    if (!isPlainObject(cur)) {
      err('current attempt is missing.');
    } else {
      if (!Number.isInteger(cur.number) || cur.number < 1) err('current.number is invalid.');
      if (!isValidDateKey(cur.startDate)) err('current.startDate is not a valid date.');
      if (cur.status !== 'active' && cur.status !== 'completed') err('current.status is invalid.');
      if (!Array.isArray(cur.completedDates)) {
        err('current.completedDates must be a list.');
      } else if (isValidDateKey(cur.startDate)) {
        cur.completedDates.forEach(function (d, i) {
          if (!isValidDateKey(d) || d !== addDays(cur.startDate, i)) {
            err('current.completedDates must be consecutive days from the start date (problem at item ' + (i + 1) + ').');
          }
        });
        if (Number.isInteger(c.targetDays)) {
          if (cur.completedDates.length > c.targetDays) err('current attempt has more completed days than the challenge length.');
          if (cur.status === 'completed' && cur.completedDates.length !== c.targetDays) err('current attempt is marked complete but is not.');
          if (cur.status === 'active' && cur.completedDates.length >= c.targetDays) err('current attempt should be marked complete.');
        }
      }
      var ch = cur.checked;
      if (!isPlainObject(ch) || !isValidDateKey(ch.date) || !Array.isArray(ch.habitIds) ||
          ch.habitIds.some(function (id) { return habitIds.indexOf(id) < 0; })) {
        err('current.checked is invalid.');
      }
    }

    if (Array.isArray(s.attempts)) {
      s.attempts.forEach(function (a, i) {
        var label = 'attempts[' + i + ']';
        if (!isPlainObject(a)) { err(label + ' is invalid.'); return; }
        if (!Number.isInteger(a.number) || a.number < 1) err(label + '.number is invalid.');
        if (!isValidDateKey(a.startDate)) err(label + '.startDate is not a valid date.');
        if (a.endDate !== null && !isValidDateKey(a.endDate)) err(label + '.endDate is not a valid date.');
        if (!isNonNegInt(a.daysCompleted)) err(label + '.daysCompleted is invalid.');
        if (END_REASONS.indexOf(a.reason) < 0) err(label + '.reason is invalid.');
        if (!isValidDateKey(a.endedOn)) err(label + '.endedOn is not a valid date.');
        if (a.missedDate !== undefined && !isValidDateKey(a.missedDate)) err(label + '.missedDate is not a valid date.');
        if ((a.daysCompleted === 0) !== (a.endDate === null)) err(label + ' has an inconsistent endDate.');
      });
    }
    return errors;
  }

  /* ------------------------------------------------------------------ */
  /* Migration                                                           */
  /* ------------------------------------------------------------------ */

  /*
   * Schema history
   *   1 — Unversioned prototype format (no schemaVersion field):
   *       { challengeName, targetDays?, habits: [string], startDate,
   *         completedDays: [date], checkedToday?: { date, habits: [index] },
   *         history: [{ start, end, days, reason? }], best? }
   *   2 — Fixed-length challenge with attempts:
   *       { challenge: { name, targetDays, habits: [{ id, name }], createdOn },
   *         current: { number, startDate, status, completedDates, checked },
   *         attempts: [{ number, startDate, endDate, daysCompleted, reason,
   *                      endedOn, missedDate? }], bestStreak }
   *   3 — Ongoing habits with one record per day (see emptyState).
   *
   * To add version N+1: bump SCHEMA_VERSION and add MIGRATIONS[N].
   */

  function emptyV2() {
    return { schemaVersion: 2, challenge: null, current: null, attempts: [], bestStreak: 0 };
  }

  function bestStreakV2(state) {
    var best = Number(state.bestStreak) || 0;
    (state.attempts || []).forEach(function (a) { if (a.daysCompleted > best) best = a.daysCompleted; });
    return Math.max(best, state.current ? state.current.completedDates.length : 0);
  }

  var MIGRATIONS = {
    1: function v1ToV2(old) {
      if (!isPlainObject(old)) throw new Error('Saved data is not an object.');
      if (!old.challengeName && !old.habits && !old.startDate) {
        return emptyV2();
      }
      var habits = (Array.isArray(old.habits) ? old.habits : []).map(function (name, i) {
        return { id: 'h' + (i + 1), name: cleanName(String(name)) };
      });
      var start = old.startDate;
      var completed = Array.isArray(old.completedDays) ? old.completedDays.slice().sort() : [];
      var target = Number.isInteger(old.targetDays) ? old.targetDays : 75;
      var checked = { date: start, habitIds: [] };
      if (isPlainObject(old.checkedToday) && Array.isArray(old.checkedToday.habits)) {
        checked = {
          date: old.checkedToday.date,
          habitIds: old.checkedToday.habits
            .filter(function (i) { return Number.isInteger(i) && i >= 0 && i < habits.length; })
            .map(function (i) { return habits[i].id; })
        };
      }
      var attempts = (Array.isArray(old.history) ? old.history : []).map(function (h, i) {
        var days = Number(h && h.days) || 0;
        return {
          number: i + 1,
          startDate: h.start,
          endDate: days > 0 ? (h.end || addDays(h.start, days - 1)) : null,
          daysCompleted: days,
          reason: END_REASONS.indexOf(h.reason) >= 0 ? h.reason : 'missed',
          endedOn: h.end ? addDays(h.end, 1) : h.start
        };
      });
      var state = {
        schemaVersion: 2,
        challenge: { name: cleanName(String(old.challengeName || 'My challenge')), targetDays: target, habits: habits, createdOn: attempts.length ? attempts[0].startDate : start },
        current: {
          number: attempts.length + 1,
          startDate: start,
          status: completed.length >= target ? 'completed' : 'active',
          completedDates: completed,
          checked: checked
        },
        attempts: attempts,
        bestStreak: Number.isInteger(old.best) && old.best >= 0 ? old.best : 0
      };
      state.bestStreak = bestStreakV2(state);
      return state;
    },

    /*
     * Challenge attempts become continuous daily history. Every day the old
     * app recorded as complete (in any attempt) becomes a fully done record;
     * days the old app knew were missed or failed become records with
     * nothing done (it did not store partial progress for them); today's
     * ticks carry over. The challenge's habits become ongoing habits.
     */
    2: function v2ToV3(old) {
      var problems = validateV2(old);
      if (problems.length) throw new Error(problems.slice(0, 3).join(' '));
      var state = emptyState();
      if (!old.challenge) return state;
      var c = old.challenge;
      state.habits = c.habits.map(function (h) {
        return { id: h.id, name: h.name, createdOn: c.createdOn, status: 'active', archivedOn: null };
      });
      var snap = c.habits.map(function (h) { return { id: h.id, name: h.name }; });
      var allIds = snap.map(function (h) { return h.id; });

      var locked = {};
      var known = [c.createdOn];
      old.attempts.forEach(function (a) {
        for (var i = 0; i < a.daysCompleted; i++) locked[addDays(a.startDate, i)] = true;
        known.push(a.startDate, a.endedOn);
        if (a.missedDate) known.push(a.missedDate);
      });
      var cur = old.current;
      cur.completedDates.forEach(function (d) { locked[d] = true; });
      known.push(cur.startDate);
      known = known.concat(Object.keys(locked));
      var partial = null;
      if (cur.status === 'active' && !locked[cur.checked.date]) {
        partial = cur.checked;
        known.push(partial.date);
      }
      known.sort();
      var first = known[0];
      var last = known[known.length - 1];
      var span = Math.min(daysBetween(first, last), MAX_DAYS - 1);
      for (var n = 0; n <= span; n++) {
        var d = addDays(first, n);
        var done = locked[d] ? allIds.slice() : (partial && partial.date === d ? partial.habitIds.slice() : []);
        state.days[d] = { habits: clone(snap), done: done };
      }
      return state;
    }
  };

  /** Read the schema version of raw saved/imported data (unversioned = 1). */
  function detectVersion(raw) {
    if (!isPlainObject(raw)) return null;
    if (raw.schemaVersion === undefined) return 1;
    return raw.schemaVersion;
  }

  /**
   * Upgrade raw data to the current schema and validate it.
   * Returns { ok, state, fromVersion, migrated } or { ok: false, error, message }.
   */
  function migrate(raw) {
    var version = detectVersion(raw);
    if (version === null) return { ok: false, error: 'invalid', message: 'The data is not a Day by Day object.' };
    if (!Number.isInteger(version) || version < 1) {
      return { ok: false, error: 'invalid', message: 'schemaVersion "' + String(version) + '" is not valid.' };
    }
    if (version > SCHEMA_VERSION) {
      return {
        ok: false,
        error: 'incompatible',
        message: 'This data uses schema version ' + version + ', but this app only understands up to version ' +
          SCHEMA_VERSION + '. Update Day by Day and try again.'
      };
    }
    var data = raw;
    try {
      for (var v = version; v < SCHEMA_VERSION; v++) data = MIGRATIONS[v](data);
    } catch (e) {
      return { ok: false, error: 'invalid', message: 'The data could not be upgraded: ' + e.message };
    }
    // Keep only the stored fields; exports also carry computed ones.
    var state = { schemaVersion: data.schemaVersion, habits: data.habits, days: data.days };
    var errors = validateState(state);
    if (errors.length) {
      return { ok: false, error: 'invalid', message: 'The data is damaged or incomplete: ' + errors.slice(0, 3).join(' '), errors: errors };
    }
    return { ok: true, state: clone(state), fromVersion: version, migrated: version !== SCHEMA_VERSION };
  }

  /* ------------------------------------------------------------------ */
  /* Import / export                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Build the JSON export: the stored habits and days (what import reads),
   * plus computed daily records and a stats summary for people and other
   * tools. `summary` comes from DayByDayStats.summary().
   */
  function buildExport(state, now, summary) {
    var dailyRecords = sortedDates(state).map(function (d) {
      var rec = state.days[d];
      var s = recordSummary(rec);
      return {
        date: d,
        habits: rec.habits.map(function (h) { return { id: h.id, name: h.name, done: rec.done.indexOf(h.id) >= 0 }; }),
        totalCompleted: s.completed,
        totalPossible: s.total,
        percentage: s.percentage,
        lockedIn: s.lockedIn
      };
    });
    var doc = {
      app: APP_ID,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: (now || new Date()).toISOString(),
      habits: clone(state.habits),
      days: clone(state.days),
      dailyRecords: dailyRecords
    };
    if (summary) doc.stats = summary;
    return doc;
  }

  function exportFileName(today) {
    return 'day-by-day-backup-' + today + '.json';
  }

  /**
   * Parse and validate an import file's text. Never touches storage.
   * Returns { ok: true, state } or { ok: false, message }.
   */
  function parseImport(text) {
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'empty', message: 'The file is empty.' };
    var raw;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      return { ok: false, error: 'not-json', message: 'The file is not valid JSON.' };
    }
    if (!isPlainObject(raw)) return { ok: false, error: 'invalid', message: 'The file does not contain a Day by Day backup.' };
    if (raw.app !== undefined && raw.app !== APP_ID) {
      return { ok: false, error: 'invalid', message: 'The file was not exported from Day by Day.' };
    }
    if (raw.schemaVersion === undefined) {
      return { ok: false, error: 'invalid', message: 'The file has no schemaVersion, so it is not a Day by Day backup.' };
    }
    return migrate(raw);
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    APP_ID: APP_ID,
    MAX_ACTIVE_HABITS: MAX_ACTIVE_HABITS,
    // dates
    isLeapYear: isLeapYear,
    daysInMonth: daysInMonth,
    isValidDateKey: isValidDateKey,
    toDateKey: toDateKey,
    addDays: addDays,
    daysBetween: daysBetween,
    // state
    emptyState: emptyState,
    cleanName: cleanName,
    habitNameError: habitNameError,
    findHabit: findHabit,
    activeHabits: activeHabits,
    sortedDates: sortedDates,
    recordSummary: recordSummary,
    ensureDays: ensureDays,
    setHabitDone: setHabitDone,
    addHabit: addHabit,
    renameHabit: renameHabit,
    moveHabit: moveHabit,
    setHabitStatus: setHabitStatus,
    habitHistoryDates: habitHistoryDates,
    deleteHabit: deleteHabit,
    // persistence helpers
    validateState: validateState,
    detectVersion: detectVersion,
    migrate: migrate,
    buildExport: buildExport,
    exportFileName: exportFileName,
    parseImport: parseImport
  };
});
