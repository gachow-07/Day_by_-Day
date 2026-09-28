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

  var SCHEMA_VERSION = 5;
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
  var GOAL_COLORS = ['jade', 'teal', 'sky', 'indigo', 'violet', 'rose', 'amber', 'slate'];
  var MAX_FOCUS_LENGTH = 140;
  var MAX_WORKOUTS = 14;
  var MAX_WORKOUT_LENGTH = 40;
  var TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  var ICON_RE = /^[a-z0-9-]{1,32}$/;
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
   * State (schema 5)
   *   habits: [{ id, name, createdOn, status, archivedOn, icon, color, schedule, reminder, split }]
   *     status is 'active', 'paused' or 'archived'; array order is display order.
   *     icon: a Lucide icon name or null; color: one of GOAL_COLORS or null.
   *     schedule: { type: 'daily' } | { type: 'weekdays' }
   *             | { type: 'days', days: [0-6, Sunday = 0] } | { type: 'weekly', times: 1-6 }
   *     reminder: 'HH:MM' or null.
   *     split: null or { workouts: [name], start: date, offset: n }, a workout
   *       rotation: each day the goal is due takes the next workout, and the
   *       day it is due on `start` gets workouts[offset]. Times-per-week goals
   *       move on to the next workout after each day they're done.
   *   days: { 'YYYY-MM-DD': { habits: [{ id, name, flex?, target?, workout? }], done: [id] } }
   *     One record per calendar date: a snapshot of the goals shown that day
   *     (with their names at the time) and which were done. Goals with
   *     flex: true and target: N (N times a week) can be ticked but are not
   *     required, so they don't decide whether the day is Locked In.
   *     workout is the split workout the goal had that day.
   *     Past records are never rewritten when goals change later. Only
   *     today's record follows the current goal list.
   *   focus: { 'YYYY-MM-DD': 'text' }  optional daily intention
   *   settings: { weekStart: 0 | 1 }   Sunday or Monday
   */

  var DAILY = { type: 'daily' };

  function emptyState() {
    return { schemaVersion: SCHEMA_VERSION, habits: [], days: {}, focus: {}, settings: { weekStart: 0 } };
  }

  /** Day of week for a date key (0 = Sunday). */
  function dayOfWeek(key) {
    return new Date(keyToUTC(key)).getUTCDay();
  }

  /**
   * How a goal appears on `date`: 'required', 'flex' (times-per-week goals,
   * which are available every day) or null (not scheduled that day).
   */
  function scheduleOn(habit, date) {
    var sch = habit.schedule || DAILY;
    if (sch.type === 'weekly') return 'flex';
    if (sch.type === 'daily') return 'required';
    var dow = dayOfWeek(date);
    if (sch.type === 'weekdays') return dow >= 1 && dow <= 5 ? 'required' : null;
    if (sch.type === 'days') return sch.days.indexOf(dow) >= 0 ? 'required' : null;
    return 'required';
  }

  /** Normalise and validate a schedule. Returns { schedule } or { error }. */
  function cleanSchedule(input) {
    var sch = input || DAILY;
    if (sch.type === 'daily' || sch.type === 'weekdays') return { schedule: { type: sch.type } };
    if (sch.type === 'days') {
      var days = Array.isArray(sch.days) ? sch.days.filter(function (d, i, a) {
        return Number.isInteger(d) && d >= 0 && d <= 6 && a.indexOf(d) === i;
      }).sort() : [];
      if (!days.length) return { error: 'Choose at least one day for this goal.' };
      if (days.length === 7) return { schedule: { type: 'daily' } };
      return { schedule: { type: 'days', days: days } };
    }
    if (sch.type === 'weekly') {
      var times = Number(sch.times);
      if (!Number.isInteger(times) || times < 1 || times > 6) return { error: 'Choose between 1 and 6 times a week.' };
      return { schedule: { type: 'weekly', times: times } };
    }
    return { error: 'Choose how often this goal repeats.' };
  }

  /**
   * Normalise and validate a workout split from the goal form:
   * { workouts: [name], current: index of the next workout } or null.
   * `today` anchors the rotation. Returns { split } or { error }.
   */
  function cleanSplit(input, today) {
    if (input === null) return { split: null };
    var workouts = Array.isArray(input && input.workouts)
      ? input.workouts.map(cleanName).filter(function (w) { return w; })
      : [];
    if (workouts.length < 2) return { error: 'Add at least two workouts to the split, one per line.' };
    if (workouts.length > MAX_WORKOUTS) return { error: 'A split can have up to ' + MAX_WORKOUTS + ' workouts.' };
    for (var i = 0; i < workouts.length; i++) {
      if (workouts[i].length > MAX_WORKOUT_LENGTH) return { error: 'Workout names must be ' + MAX_WORKOUT_LENGTH + ' characters or fewer.' };
    }
    var current = Number(input.current || 0);
    if (!Number.isInteger(current) || current < 0 || current >= workouts.length) current = 0;
    return { split: { workouts: workouts, start: today, offset: current } };
  }

  function validSplit(sp) {
    if (sp === null) return true;
    if (!isPlainObject(sp) || !Array.isArray(sp.workouts) || !isValidDateKey(sp.start)) return false;
    var n = sp.workouts.length;
    if (n < 2 || n > MAX_WORKOUTS || !Number.isInteger(sp.offset) || sp.offset < 0 || sp.offset >= n) return false;
    return sp.workouts.every(function (w) { return typeof w === 'string' && cleanName(w) === w && w && w.length <= MAX_WORKOUT_LENGTH; });
  }

  /**
   * How many times the split has moved on between `from` (inclusive) and
   * `to` (exclusive): the days the goal was due, or for times-per-week
   * goals the days it was done.
   */
  function splitSteps(state, habit, from, to) {
    var n = daysBetween(from, to);
    if (n <= 0) return 0;
    var sch = habit.schedule || DAILY;
    if (sch.type === 'daily') return n;
    if (sch.type === 'weekly') {
      return Object.keys(state.days).filter(function (d) {
        return d >= from && d < to && state.days[d].done.indexOf(habit.id) >= 0;
      }).length;
    }
    var perWeek = 0;
    for (var k = 0; k < 7; k++) if (scheduleOn(habit, addDays(from, k))) perWeek++;
    var full = Math.floor(n / 7);
    var steps = full * perWeek;
    for (var d = full * 7; d < n; d++) if (scheduleOn(habit, addDays(from, d))) steps++;
    return steps;
  }

  /** Index in the split of the workout for `date` (or the next due day), or -1. */
  function splitIndex(state, habit, date) {
    var sp = habit && habit.split;
    if (!sp || date < sp.start) return -1;
    return (sp.offset + splitSteps(state, habit, sp.start, date)) % sp.workouts.length;
  }

  /** The workout a goal has on `date`, or null when it has no split. */
  function workoutOn(state, habit, date) {
    var i = splitIndex(state, habit, date);
    return i < 0 ? null : habit.split.workouts[i];
  }

  /**
   * The rest of the rotation after today, in order: [{ index, workout, date }].
   * `date` is when it's planned, or null for times-per-week goals, where the
   * next workout comes after the next day the goal is done.
   */
  function upcomingWorkouts(state, id, today) {
    var h = findHabit(state, id);
    var i = splitIndex(state, h, today);
    if (i < 0) return [];
    var n = h.split.workouts.length;
    var flex = h.schedule.type === 'weekly';
    var out = [];
    var d = today;
    for (var k = 1; k < n; k++) {
      var date = null;
      if (!flex) {
        do { d = addDays(d, 1); } while (!scheduleOn(h, d));
        date = d;
      }
      out.push({ index: (i + k) % n, workout: h.split.workouts[(i + k) % n], date: date });
    }
    return out;
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

  /**
   * Totals for one daily record. Only required goals count toward the
   * day's total and Locked In; flexible (times-per-week) goals don't.
   */
  function recordSummary(record) {
    var total = 0;
    var completed = 0;
    if (record) {
      record.habits.forEach(function (h) {
        if (h.flex) return;
        total++;
        if (record.done.indexOf(h.id) >= 0) completed++;
      });
    }
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

  /** The goals shown on `date`, from the current active list and schedules. */
  function snapshotFor(state, date) {
    var out = [];
    activeHabits(state).forEach(function (h) {
      var how = scheduleOn(h, date);
      if (!how) return;
      var entry = how === 'flex' ? { id: h.id, name: h.name, flex: true, target: h.schedule.times } : { id: h.id, name: h.name };
      var workout = workoutOn(state, h, date);
      if (workout) entry.workout = workout;
      out.push(entry);
    });
    return out;
  }

  /**
   * Make `next`'s record for `today` mirror the current active habits:
   * same order and current names, keeping ticks for habits still active.
   * Creates the record if there are active habits and none exists yet.
   * Only ever touches today's record.
   */
  function syncTodayRecord(next, today) {
    var snap = snapshotFor(next, today);
    var rec = next.days[today];
    if (!rec) {
      if (!snap.length) return next;
      next.days[today] = { habits: snap, done: [] };
      return next;
    }
    if (!snap.length) {
      // Nothing is scheduled today any more: a neutral day, not a record.
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
   * app wasn't opened, get records with nothing done, using the goals
   * active now and their schedules (goals can only change while the app is
   * open, so these are the goals that were due on those days). Also creates
   * today's record. Returns { state, changed, missed: [dates with required goals] }.
   */
  function ensureDays(state, today) {
    if (!isValidDateKey(today)) throw new RangeError('Invalid date: ' + String(today));
    var dates = sortedDates(state);
    var last = dates.length ? dates[dates.length - 1] : null;
    var missed = [];
    var next = null;
    if (activeHabits(state).length && last && last < today) {
      var gap = daysBetween(last, today) - 1;
      if (gap > MAX_FILL_DAYS) gap = MAX_FILL_DAYS;
      var start = addDays(today, -gap);
      for (var i = 0; i < gap; i++) {
        var d = addDays(start, i);
        var snap = snapshotFor(state, d);
        if (!snap.length) continue;
        if (!next) next = clone(state);
        next.days[d] = { habits: snap, done: [] };
        if (snap.some(function (h) { return !h.flex; })) missed.push(d);
      }
    }
    var todaySnap = snapshotFor(state, today);
    if (todaySnap.length && !state.days[today]) {
      if (!next) next = clone(state);
      next.days[today] = { habits: todaySnap, done: [] };
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

  /**
   * Record that today's workout was `workout` instead of the planned one.
   * The two trade places in the rotation: today becomes `workout`, and the
   * planned workout moves to the day `workout` was coming up next.
   * Returns { ok, state, planned, movedTo: { index, date } }.
   */
  function swapWorkout(state, habitId, workout, today) {
    var h = findHabit(state, habitId);
    var rec = state.days[today];
    if (!h || !h.split || h.status !== 'active' || !rec || !rec.habits.some(function (e) { return e.id === habitId; })) {
      return failure(state, 'not-today', 'That goal has no workout today.');
    }
    var i = splitIndex(state, h, today);
    var planned = h.split.workouts[i];
    var match = upcomingWorkouts(state, habitId, today).filter(function (u) { return u.workout === workout; })[0];
    if (!match) {
      return workout === planned ? result(state, { unchanged: true, planned: planned })
        : failure(state, 'unknown-workout', 'That workout isn’t in this split.');
    }
    var next = clone(state);
    var ws = findHabit(next, habitId).split.workouts;
    ws[i] = workout;
    ws[match.index] = planned;
    return result(syncTodayRecord(next, today), { planned: planned, movedTo: { index: match.index, date: match.date } });
  }

  /* ------------------------------------------------------------------ */
  /* Managing habits                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Validate optional goal details (icon, color, schedule, reminder).
   * Returns { details } with cleaned values for the keys present, or { error }.
   */
  function cleanDetails(opts, today) {
    var out = {};
    if (!opts) return { details: out };
    if (opts.icon !== undefined) {
      if (opts.icon !== null && !ICON_RE.test(opts.icon)) return { error: 'That icon isn’t available.' };
      out.icon = opts.icon;
    }
    if (opts.color !== undefined) {
      if (opts.color !== null && GOAL_COLORS.indexOf(opts.color) < 0) return { error: 'That colour isn’t available.' };
      out.color = opts.color;
    }
    if (opts.schedule !== undefined) {
      var sch = cleanSchedule(opts.schedule);
      if (sch.error) return { error: sch.error };
      out.schedule = sch.schedule;
    }
    if (opts.reminder !== undefined) {
      if (opts.reminder !== null && opts.reminder !== '' && !TIME_RE.test(opts.reminder)) return { error: 'Enter a reminder time like 08:30.' };
      out.reminder = opts.reminder || null;
    }
    if (opts.split !== undefined) {
      var sp = cleanSplit(opts.split, today);
      if (sp.error) return { error: sp.error };
      out.split = sp.split;
    }
    return { details: out };
  }

  function addHabit(state, name, today, opts) {
    var error = habitNameError(name);
    if (error) return failure(state, 'invalid-name', error);
    var details = cleanDetails(opts, today);
    if (details.error) return failure(state, 'invalid-details', details.error);
    if (activeHabits(state).length >= MAX_ACTIVE_HABITS) {
      return failure(state, 'too-many', 'You can have up to ' + MAX_ACTIVE_HABITS + ' active goals.');
    }
    if (state.habits.length >= MAX_TOTAL_HABITS) {
      return failure(state, 'too-many', 'Too many goals. Delete some archived ones first.');
    }
    var next = clone(state);
    var id = nextHabitId(next);
    var habit = { id: id, name: cleanName(name), createdOn: today, status: 'active', archivedOn: null,
      icon: null, color: null, schedule: { type: 'daily' }, reminder: null, split: null };
    Object.keys(details.details).forEach(function (k) { habit[k] = details.details[k]; });
    next.habits.push(habit);
    return result(syncTodayRecord(next, today), { id: id });
  }

  /**
   * Change a goal's name and/or details ({ name, icon, color, schedule,
   * reminder }). Like every goal change, it applies from today: past
   * records keep the name and schedule they had.
   */
  function updateHabit(state, id, changes, today) {
    if (!findHabit(state, id)) return failure(state, 'unknown-habit', 'That goal no longer exists.');
    var c = changes || {};
    if (c.name !== undefined) {
      var error = habitNameError(c.name);
      if (error) return failure(state, 'invalid-name', error);
    }
    var details = cleanDetails(c, today);
    if (details.error) return failure(state, 'invalid-details', details.error);
    var next = clone(state);
    var h = findHabit(next, id);
    if (c.name !== undefined) h.name = cleanName(c.name);
    // A new schedule keeps the split where it is: re-anchor it on today.
    if (h.split && details.details.split === undefined && details.details.schedule &&
        JSON.stringify(details.details.schedule) !== JSON.stringify(h.schedule)) {
      h.split = { workouts: h.split.workouts, start: today, offset: Math.max(0, splitIndex(state, h, today)) };
    }
    Object.keys(details.details).forEach(function (k) { h[k] = details.details[k]; });
    return result(syncTodayRecord(next, today), {});
  }

  /** Move a goal to position `toIndex` within its status group (drag and drop). */
  function reorderHabit(state, id, toIndex, today) {
    var habit = findHabit(state, id);
    if (!habit) return failure(state, 'unknown-habit', 'That goal no longer exists.');
    var group = state.habits.filter(function (h) { return h.status === habit.status; });
    var from = group.indexOf(habit);
    var to = Math.max(0, Math.min(group.length - 1, Math.round(Number(toIndex))));
    if (!Number.isFinite(to)) return failure(state, 'invalid-index', 'Invalid position.');
    if (to === from) return result(state, { unchanged: true });
    var next = clone(state);
    var ids = group.map(function (h) { return h.id; });
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    // Rebuild the full list: the group's slots, in the new order.
    var byId = {};
    next.habits.forEach(function (h) { byId[h.id] = h; });
    var k = 0;
    next.habits = next.habits.map(function (h) { return h.status === habit.status ? byId[ids[k++]] : h; });
    return result(syncTodayRecord(next, today), {});
  }

  /** Set (or clear, with '') today's focus. */
  function setFocus(state, text, today) {
    var t = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
    if (t.length > MAX_FOCUS_LENGTH) return failure(state, 'too-long', 'Keep your focus to ' + MAX_FOCUS_LENGTH + ' characters or fewer.');
    var next = clone(state);
    if (t) next.focus[today] = t;
    else delete next.focus[today];
    return result(next, {});
  }

  function setWeekStart(state, weekStart) {
    if (weekStart !== 0 && weekStart !== 1) return failure(state, 'invalid', 'The week can start on Sunday or Monday.');
    var next = clone(state);
    next.settings.weekStart = weekStart;
    return result(next, {});
  }

  function renameHabit(state, id, name, today) {
    return updateHabit(state, id, { name: name }, today);
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
        if (h.icon !== null && !(typeof h.icon === 'string' && ICON_RE.test(h.icon))) err(label + '.icon is invalid.');
        if (h.color !== null && GOAL_COLORS.indexOf(h.color) < 0) err(label + '.color is invalid.');
        var sch = isPlainObject(h.schedule) ? cleanSchedule(h.schedule) : { error: true };
        if (sch.error || JSON.stringify(sch.schedule) !== JSON.stringify(h.schedule)) err(label + '.schedule is invalid.');
        if (h.reminder !== null && !(typeof h.reminder === 'string' && TIME_RE.test(h.reminder))) err(label + '.reminder is invalid.');
        if (!validSplit(h.split)) err(label + '.split is invalid.');
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
        if (!isPlainObject(h)) { err(label + ' has an invalid habit.'); return; }
        var badFlex = h.flex !== undefined && (h.flex !== true || !Number.isInteger(h.target) || h.target < 1 || h.target > 6);
        var badWorkout = h.workout !== undefined && !(typeof h.workout === 'string' && h.workout.trim() && h.workout.length <= MAX_WORKOUT_LENGTH);
        if (typeof h.id !== 'string' || !validName(h.name) || badFlex || badWorkout || (h.flex === undefined && h.target !== undefined)) {
          err(label + ' has an invalid habit.');
          return;
        }
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

    if (!isPlainObject(s.focus)) {
      err('focus must be an object keyed by date.');
    } else {
      Object.keys(s.focus).forEach(function (d) {
        var t = s.focus[d];
        if (!isValidDateKey(d) || typeof t !== 'string' || !t.trim() || t.length > MAX_FOCUS_LENGTH) err('focus[' + d + '] is invalid.');
      });
    }
    if (!isPlainObject(s.settings) || (s.settings.weekStart !== 0 && s.settings.weekStart !== 1)) err('settings.weekStart must be 0 or 1.');
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
   *   3 — Ongoing habits with one record per day: { habits, days }.
   *   4 — Adds goal icon, colour, schedule and reminder, flexible goals in
   *       daily records, daily focus and settings (see emptyState). Existing
   *       goals become "every day" goals, so every record and statistic is
   *       unchanged.
   *   5 — Adds an optional workout split to goals (split, null for existing
   *       goals) and the day's workout to daily records.
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
      var state = { schemaVersion: 3, habits: [], days: {} };
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
    },

    3: function v3ToV4(old) {
      if (!isPlainObject(old)) throw new Error('Saved data is not an object.');
      if (!Array.isArray(old.habits)) throw new Error('habits must be a list.');
      return {
        schemaVersion: 4,
        habits: old.habits.map(function (h) {
          if (!isPlainObject(h)) return h;
          var out = clone(h);
          out.icon = null;
          out.color = null;
          out.schedule = { type: 'daily' };
          out.reminder = null;
          return out;
        }),
        days: old.days,
        focus: {},
        settings: { weekStart: 0 }
      };
    },

    4: function v4ToV5(old) {
      if (!isPlainObject(old)) throw new Error('Saved data is not an object.');
      if (!Array.isArray(old.habits)) throw new Error('habits must be a list.');
      var next = clone(old);
      next.schemaVersion = 5;
      next.habits = next.habits.map(function (h) {
        if (isPlainObject(h) && h.split === undefined) h.split = null;
        return h;
      });
      return next;
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
    var state = { schemaVersion: data.schemaVersion, habits: data.habits, days: data.days, focus: data.focus, settings: data.settings };
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
        habits: rec.habits.map(function (h) {
          var item = { id: h.id, name: h.name, done: rec.done.indexOf(h.id) >= 0 };
          if (h.flex) item.flexible = true;
          if (h.workout) item.workout = h.workout;
          return item;
        }),
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
      focus: clone(state.focus),
      settings: clone(state.settings),
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
    MAX_FOCUS_LENGTH: MAX_FOCUS_LENGTH,
    GOAL_COLORS: GOAL_COLORS,
    // dates
    isLeapYear: isLeapYear,
    daysInMonth: daysInMonth,
    isValidDateKey: isValidDateKey,
    toDateKey: toDateKey,
    addDays: addDays,
    daysBetween: daysBetween,
    dayOfWeek: dayOfWeek,
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
    updateHabit: updateHabit,
    renameHabit: renameHabit,
    reorderHabit: reorderHabit,
    setFocus: setFocus,
    setWeekStart: setWeekStart,
    scheduleOn: scheduleOn,
    cleanSchedule: cleanSchedule,
    MAX_WORKOUTS: MAX_WORKOUTS,
    MAX_WORKOUT_LENGTH: MAX_WORKOUT_LENGTH,
    cleanSplit: cleanSplit,
    splitIndex: splitIndex,
    workoutOn: workoutOn,
    upcomingWorkouts: upcomingWorkouts,
    swapWorkout: swapWorkout,
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
