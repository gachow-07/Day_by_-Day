/*
 * Day by Day — core logic.
 *
 * Pure functions for dates, streaks, completion, restarts, validation,
 * schema migration and import/export. Nothing in this file touches the DOM
 * or localStorage, so it can be tested directly with Node.
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

  var SCHEMA_VERSION = 2;
  var APP_ID = 'day-by-day';
  var DAY_MS = 24 * 60 * 60 * 1000;
  var MIN_YEAR = 1970;
  var MAX_YEAR = 9999;
  var MAX_TARGET_DAYS = 1000;
  var MAX_HABITS = 20;
  var MAX_NAME_LENGTH = 120;
  var DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
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
  /* State construction                                                  */
  /* ------------------------------------------------------------------ */

  function emptyState() {
    return { schemaVersion: SCHEMA_VERSION, challenge: null, current: null, attempts: [], bestStreak: 0 };
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function newAttempt(number, startDate) {
    return {
      number: number,
      startDate: startDate,
      status: 'active',
      completedDates: [],
      checked: { date: startDate, habitIds: [] }
    };
  }

  function cleanName(value) {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  }

  /**
   * Validate the setup form input. Returns an array of human-readable
   * errors (empty when valid).
   */
  function validateChallengeInput(input) {
    var errors = [];
    var name = cleanName(input && input.name);
    var habits = ((input && input.habits) || []).map(cleanName).filter(Boolean);
    var target = Number(input && input.targetDays);
    if (!name) errors.push('Give your challenge a name.');
    if (name.length > MAX_NAME_LENGTH) errors.push('The challenge name must be ' + MAX_NAME_LENGTH + ' characters or fewer.');
    if (!Number.isInteger(target) || target < 1 || target > MAX_TARGET_DAYS) {
      errors.push('Length must be a whole number of days between 1 and ' + MAX_TARGET_DAYS + '.');
    }
    if (habits.length === 0) errors.push('Add at least one daily habit.');
    if (habits.length > MAX_HABITS) errors.push('Use ' + MAX_HABITS + ' habits or fewer.');
    if (habits.some(function (h) { return h.length > MAX_NAME_LENGTH; })) {
      errors.push('Each habit must be ' + MAX_NAME_LENGTH + ' characters or fewer.');
    }
    return errors;
  }

  /** Create a fresh challenge whose first attempt starts `today`. */
  function createChallenge(input, today) {
    var errors = validateChallengeInput(input);
    if (errors.length) throw new Error(errors.join(' '));
    if (!isValidDateKey(today)) throw new RangeError('Invalid date: ' + String(today));
    var habits = input.habits.map(cleanName).filter(Boolean).map(function (name, i) {
      return { id: 'h' + (i + 1), name: name };
    });
    var state = emptyState();
    state.challenge = {
      name: cleanName(input.name),
      targetDays: Number(input.targetDays),
      habits: habits,
      createdOn: today
    };
    state.current = newAttempt(1, today);
    return state;
  }

  /* ------------------------------------------------------------------ */
  /* Derived values                                                      */
  /* ------------------------------------------------------------------ */

  function currentStreak(state) {
    return state && state.current ? state.current.completedDates.length : 0;
  }

  /** Best streak across the current attempt and all previous attempts. */
  function bestStreak(state) {
    if (!state) return 0;
    var best = Number(state.bestStreak) || 0;
    (state.attempts || []).forEach(function (a) {
      if (a.daysCompleted > best) best = a.daysCompleted;
    });
    return Math.max(best, currentStreak(state));
  }

  function isDayCompleted(state, date) {
    return !!(state && state.current && state.current.completedDates.indexOf(date) >= 0);
  }

  /** Day number shown for `today` in the current attempt (Day 1 = start date). */
  function dayNumber(state, today) {
    if (!state || !state.current) return 0;
    return Math.max(1, daysBetween(state.current.startDate, today) + 1);
  }

  /** Habit ids checked for `today` (checks from earlier days don't carry over). */
  function checkedHabitIds(state, today) {
    if (!state || !state.current) return [];
    var checked = state.current.checked;
    if (isDayCompleted(state, today)) return state.challenge.habits.map(function (h) { return h.id; });
    if (!checked || checked.date !== today) return [];
    return checked.habitIds.slice();
  }

  function allHabitsChecked(state, today) {
    var ids = checkedHabitIds(state, today);
    return state.challenge.habits.every(function (h) { return ids.indexOf(h.id) >= 0; });
  }

  /* ------------------------------------------------------------------ */
  /* Transitions                                                         */
  /* ------------------------------------------------------------------ */

  function result(state, extra) {
    var r = { ok: true, state: state };
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) r[k] = extra[k];
    return r;
  }

  function failure(state, error, message) {
    return { ok: false, state: state, error: error, message: message };
  }

  /** Check or uncheck one habit for today. */
  function setHabitChecked(state, habitId, checked, today) {
    if (!state || !state.current || state.current.status !== 'active') {
      return failure(state, 'no-active-attempt', 'There is no active attempt.');
    }
    if (!state.challenge.habits.some(function (h) { return h.id === habitId; })) {
      return failure(state, 'unknown-habit', 'That habit is not part of this challenge.');
    }
    if (isDayCompleted(state, today)) {
      return failure(state, 'already-completed', 'Today is already complete.');
    }
    var next = clone(state);
    var ids = checkedHabitIds(state, today).filter(function (id) { return id !== habitId; });
    if (checked) ids.push(habitId);
    // Keep ids in habit order so saved data is stable.
    var order = next.challenge.habits.map(function (h) { return h.id; });
    ids.sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); });
    next.current.checked = { date: today, habitIds: ids };
    return result(next, {});
  }

  /**
   * Mark `today` complete. Requires every habit to be checked and refuses
   * to complete the same date twice.
   */
  function completeDay(state, today) {
    if (!state || !state.current) return failure(state, 'no-active-attempt', 'There is no active attempt.');
    if (state.current.status === 'completed') {
      return failure(state, 'challenge-complete', 'This attempt is already finished.');
    }
    if (isDayCompleted(state, today)) {
      return failure(state, 'already-completed', 'Today is already complete. Come back tomorrow.');
    }
    var dates = state.current.completedDates;
    var expected = dates.length ? addDays(dates[dates.length - 1], 1) : state.current.startDate;
    if (today !== expected) {
      // Only happens if missed days were not evaluated first, or the clock moved backwards.
      return failure(state, 'out-of-sequence', 'Today cannot be completed yet. Reload the app and try again.');
    }
    if (!allHabitsChecked(state, today)) {
      return failure(state, 'habits-incomplete', 'Check off every habit before completing the day.');
    }
    var next = clone(state);
    next.current.completedDates.push(today);
    next.current.checked = { date: today, habitIds: next.challenge.habits.map(function (h) { return h.id; }) };
    var finished = next.current.completedDates.length >= next.challenge.targetDays;
    if (finished) next.current.status = 'completed';
    next.bestStreak = bestStreak(next);
    return result(next, { challengeComplete: finished });
  }

  function lastCompletedDate(attempt) {
    var d = attempt.completedDates;
    return d.length ? d[d.length - 1] : null;
  }

  /** Close the current attempt and start the next one on `today`. */
  function restart(state, today, reason, missedDate) {
    var cur = state.current;
    var record = {
      number: cur.number,
      startDate: cur.startDate,
      endDate: lastCompletedDate(cur),
      daysCompleted: cur.completedDates.length,
      reason: reason,
      endedOn: today
    };
    if (missedDate) record.missedDate = missedDate;
    var next = clone(state);
    next.attempts.push(record);
    next.bestStreak = bestStreak(state);
    next.current = newAttempt(cur.number + 1, today);
    return next;
  }

  /**
   * Called whenever the app opens or the date changes. If a full calendar
   * day between the last completed day and today was missed, the attempt
   * restarts at Day 1 today.
   */
  function evaluateMissedDays(state, today) {
    if (!state || !state.current || state.current.status !== 'active') return result(state, { restarted: false });
    var cur = state.current;
    var last = lastCompletedDate(cur) || addDays(cur.startDate, -1);
    // Clock moved backwards (or nothing to check yet): never punish the user.
    if (daysBetween(last, today) < 2) return result(state, { restarted: false });
    var missed = addDays(last, 1);
    return result(restart(state, today, 'missed', missed), { restarted: true, missedDate: missed });
  }

  /** The user reports they did not complete a habit. Restarts at Day 1 today. */
  function reportFailure(state, today) {
    if (!state || !state.current || state.current.status !== 'active') {
      return failure(state, 'no-active-attempt', 'There is no active attempt to fail.');
    }
    return result(restart(state, today, 'failed'), { restarted: true });
  }

  /** After finishing a challenge, begin another attempt of it. */
  function startNewAttempt(state, today) {
    if (!state || !state.current || state.current.status !== 'completed') {
      return failure(state, 'attempt-active', 'Finish or restart the current attempt first.');
    }
    return result(restart(state, today, 'completed'), {});
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

  /**
   * Validate a current-schema state object. Returns an array of problems
   * (empty when valid). Checks structure and the invariants the app
   * relies on, e.g. completed days being consecutive from the start date.
   */
  function validateState(s) {
    var errors = [];
    function err(msg) { errors.push(msg); }

    if (!isPlainObject(s)) return ['Data must be an object.'];
    if (s.schemaVersion !== SCHEMA_VERSION) err('schemaVersion must be ' + SCHEMA_VERSION + '.');
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
   *   2 — Current format (see emptyState / createChallenge).
   *
   * To add version N+1: bump SCHEMA_VERSION and add MIGRATIONS[N].
   */
  var MIGRATIONS = {
    1: function v1ToV2(old) {
      if (!isPlainObject(old)) throw new Error('Saved data is not an object.');
      if (!old.challengeName && !old.habits && !old.startDate) {
        return emptyState();
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
      state.bestStreak = bestStreak(state);
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
    var state = {
      schemaVersion: data.schemaVersion,
      challenge: data.challenge,
      current: data.current,
      attempts: data.attempts,
      bestStreak: data.bestStreak
    };
    var errors = validateState(state);
    if (errors.length) {
      return { ok: false, error: 'invalid', message: 'The data is damaged or incomplete: ' + errors.slice(0, 3).join(' '), errors: errors };
    }
    return { ok: true, state: clone(state), fromVersion: version, migrated: version !== SCHEMA_VERSION };
  }

  /* ------------------------------------------------------------------ */
  /* Import / export                                                     */
  /* ------------------------------------------------------------------ */

  /** Build the JSON-serialisable export document. */
  function buildExport(state, now) {
    return {
      app: APP_ID,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: (now || new Date()).toISOString(),
      challenge: state.challenge,
      current: state.current,
      attempts: state.attempts,
      bestStreak: bestStreak(state)
    };
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
    // dates
    isLeapYear: isLeapYear,
    daysInMonth: daysInMonth,
    isValidDateKey: isValidDateKey,
    toDateKey: toDateKey,
    addDays: addDays,
    daysBetween: daysBetween,
    // state
    emptyState: emptyState,
    validateChallengeInput: validateChallengeInput,
    createChallenge: createChallenge,
    currentStreak: currentStreak,
    bestStreak: bestStreak,
    isDayCompleted: isDayCompleted,
    dayNumber: dayNumber,
    checkedHabitIds: checkedHabitIds,
    allHabitsChecked: allHabitsChecked,
    setHabitChecked: setHabitChecked,
    completeDay: completeDay,
    evaluateMissedDays: evaluateMissedDays,
    reportFailure: reportFailure,
    startNewAttempt: startNewAttempt,
    // persistence helpers
    validateState: validateState,
    detectVersion: detectVersion,
    migrate: migrate,
    buildExport: buildExport,
    exportFileName: exportFileName,
    parseImport: parseImport
  };
});
