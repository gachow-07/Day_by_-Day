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

  var SCHEMA_VERSION = 11;
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
  var MAX_PLAN_ITEMS = 30;       // regular schedule items on the day planner goal
  var MAX_DAY_ITEMS = 30;        // one-off plan items per day
  var MAX_PLAN_TITLE = 80;
  var MAX_NOTES_LENGTH = 2000;   // an item's description
  var MAX_TASKS = 50;            // checklist items per planned item
  var MAX_TASK_LENGTH = 120;
  var MAX_PLAN_AHEAD = 366;      // days ahead a plan can be made (about a year)
  var MAX_WORKOUT_LENGTH = 40;
  var MIN_GOAL_MINUTES = 5;
  /* Amount goals: time in minutes, or water in millilitres or US fluid ounces. */
  var UNITS = {
    min: { minGoal: 5, maxGoal: 1440, maxDay: 1440 },
    ml: { minGoal: 100, maxGoal: 10000, maxDay: 20000 },
    oz: { minGoal: 4, maxGoal: 384, maxDay: 768 }
  };
  /* How a water goal in fl oz is shown: fl oz, cups (8 fl oz) or gallons (128 fl oz). */
  var OZ_DISPLAYS = ['oz', 'cup', 'gal'];
  var ML_PER_OZ = 29.5735;
  var MAX_LOGS = 100;            // time entries per goal per day
  var PARTIAL_CREDIT = 0.5;      // "partly done" counts as half in completion rates
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
   * State (schema 6)
   *   habits: [{ id, name, createdOn, status, archivedOn, icon, color, schedule, reminder, split, amount, planner }]
   *     status is 'active', 'paused' or 'archived'; array order is display order.
   *     icon: a Lucide icon name or null; color: one of GOAL_COLORS or null.
   *     schedule: { type: 'daily' } | { type: 'weekdays' }
   *             | { type: 'days', days: [0-6, Sunday = 0] } | { type: 'weekly', times: 1-6 }
   *     reminder: 'HH:MM' or null.
   *     split: null, or a workout split, either
   *       - a weekly plan: { type: 'weekly', days: [7 names or null, Sunday
   *         = 0], moves: { date: name } }. Each weekday has its own workout
   *         (null is a rest day, when the goal isn't due). moves holds this
   *         week's swaps, so the next week goes back to the plan; or
   *       - a rotation: { workouts: [name], start: date, offset: n }: each
   *         day the goal is due takes the next workout, and the day it is due
   *         on `start` gets workouts[offset]. Times-per-week goals move on to
   *         the next workout after each day they're done.
   *     amount: null, or a daily amount logged in pieces: { unit, goal } where
   *       unit is 'min' (time: "study for 2 hours", 30 minutes at a time),
   *       'ml' or 'oz' (water: 2 litres a day, a glass at a time). See UNITS.
   *       Water in 'oz' may add display: 'oz' | 'cup' | 'gal', the unit it's
   *       shown and typed in; it's always stored and logged in whole fl oz.
   *   days: { 'YYYY-MM-DD': { habits: [{ id, name, flex?, target?, workout?, amount? }],
   *                           done: [id], partial?: [id], logs?: { id: [amounts] } } }
   *     One record per calendar date: a snapshot of the goals shown that day
   *     (with their names at the time) and which were done. Goals with
   *     flex: true and target: N (N times a week) can be ticked but are not
   *     required, so they don't decide whether the day is Locked In.
   *     workout is the split workout the goal had that day; amount is the
   *     goal's amount goal that day. logs are the entries for amount goals
   *     (in the goal's unit),
   *     which are done once they add up to the goal. partial lists untimed
   *     goals marked "partly done". Neither kind of partial progress makes a
   *     day Locked In, but both count toward completion rates (a timed goal
   *     by the share of time logged, a partly done goal as half).
   *     Past records are never rewritten when goals change later. Only
   *     today's record follows the current goal list.
   *     planner: null, or { items: [{ id: 'r1', title, time, end, days }] }:
   *       a "plan tomorrow" goal and its regular schedule (classes, work),
   *       each item on the weekdays in `days` (Sunday = 0). time and end are
   *       'HH:MM' or null. The first active planner goal drives the plan.
   *   agenda: { 'YYYY-MM-DD': { items?: [{ id: 'p1', title, time, end }],
   *                              skip?: [regular item ids], done?: [item ids],
   *                              details?: { itemId: { notes?, tasks?: [{ id: 't1', text, done }] } } } }
   *     The plan for each day: one-off items, regular items skipped that
   *     day, items ticked off, and each item's description and checklist
   *     for that day (regular items get a fresh one each day).
   *   focus: { 'YYYY-MM-DD': 'text' }  daily intention (no longer edited;
   *     kept so older days still show it)
   *   settings: { weekStart: 0 | 1 }   Sunday or Monday
   *   timer: null, or the one running study timer (see "Study timer"):
   *     { habitId, date, startedAt, pausedAt, pausedMs, mode, logged, checkAt }
   */

  var DAILY = { type: 'daily' };

  function emptyState() {
    return { schemaVersion: SCHEMA_VERSION, habits: [], days: {}, focus: {}, agenda: {}, settings: { weekStart: 0 }, timer: null };
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

  function isWeeklySplit(sp) {
    return !!sp && sp.type === 'weekly';
  }

  /** The weekdays a weekly plan has a workout on (Sunday = 0). */
  function planDays(sp) {
    var out = [];
    sp.days.forEach(function (w, i) { if (w) out.push(i); });
    return out;
  }

  /**
   * Normalise and validate a workout split from the goal form or null:
   * a weekly plan { type: 'weekly', days: [7 names, blank = rest] }, or a
   * rotation { workouts: [name], current: index of the next workout }.
   * `today` anchors a rotation. Returns { split } or { error }.
   */
  function cleanSplit(input, today) {
    if (input === null) return { split: null };
    if (input && input.type === 'weekly') {
      var days = [0, 1, 2, 3, 4, 5, 6].map(function (i) {
        var w = Array.isArray(input.days) ? cleanName(input.days[i] || '') : '';
        return w || null;
      });
      if (!days.some(function (w) { return w; })) return { error: 'Add a workout to at least one day.' };
      for (var j = 0; j < 7; j++) {
        if (days[j] && days[j].length > MAX_WORKOUT_LENGTH) return { error: 'Workout names must be ' + MAX_WORKOUT_LENGTH + ' characters or fewer.' };
      }
      return { split: { type: 'weekly', days: days, moves: {} } };
    }
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

  function validWorkoutName(w) {
    return typeof w === 'string' && !!w && cleanName(w) === w && w.length <= MAX_WORKOUT_LENGTH;
  }

  function validSplit(sp) {
    if (sp === null) return true;
    if (isPlainObject(sp) && sp.type === 'weekly') {
      if (Object.keys(sp).length !== 3 || !Array.isArray(sp.days) || sp.days.length !== 7 || !isPlainObject(sp.moves)) return false;
      if (!sp.days.every(function (w) { return w === null || validWorkoutName(w); }) || !sp.days.some(function (w) { return w; })) return false;
      var keys = Object.keys(sp.moves);
      return keys.length <= 14 && keys.every(function (d) { return isValidDateKey(d) && validWorkoutName(sp.moves[d]); });
    }
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
    if (!sp || isWeeklySplit(sp) || date < sp.start) return -1;
    return (sp.offset + splitSteps(state, habit, sp.start, date)) % sp.workouts.length;
  }

  /** The workout a goal has on `date`, or null when it has no split. */
  function workoutOn(state, habit, date) {
    var sp = habit && habit.split;
    if (isWeeklySplit(sp)) return sp.moves[date] || sp.days[dayOfWeek(date)] || null;
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
    if (h && isWeeklySplit(h.split)) return weekOptions(state, h, today);
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

  /** First and last day of the week containing `date`, by the week-start setting. */
  function weekBounds(state, date) {
    var ws = state.settings && state.settings.weekStart === 1 ? 1 : 0;
    var start = addDays(date, -((dayOfWeek(date) - ws + 7) % 7));
    return { start: start, end: addDays(start, 6) };
  }

  /**
   * Weekly plan: the other workouts in the plan, each with the later day
   * this week it's planned on (date), or date null when it isn't coming up
   * again this week (doing it today is then just for today).
   * [{ workout, date, weekly: true }], in the order they come up.
   */
  function weekOptions(state, h, today) {
    var current = workoutOn(state, h, today);
    var end = weekBounds(state, today).end;
    var out = [];
    var seen = {};
    if (current) seen[current] = true;
    for (var d = addDays(today, 1); d <= end; d = addDays(d, 1)) {
      var w = scheduleOn(h, d) && workoutOn(state, h, d);
      if (w && !seen[w]) { seen[w] = true; out.push({ workout: w, date: d, weekly: true }); }
    }
    for (var k = 1; k <= 7; k++) {
      var p = h.split.days[(dayOfWeek(today) + k) % 7];
      if (p && !seen[p]) { seen[p] = true; out.push({ workout: p, date: null, weekly: true }); }
    }
    return out;
  }

  /** Validate an amount goal: null or { unit, goal }. Returns { amount } or { error }. */
  /* ---------------- Day planner ---------------- */

  function cleanPlanTitle(value) {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  }

  function cleanPlanTimes(item) {
    var time = item.time || null;
    var end = item.end || null;
    if (time !== null && !TIME_RE.test(time)) return { error: 'Enter times like 09:30.' };
    if (end !== null && !TIME_RE.test(end)) return { error: 'Enter times like 09:30.' };
    if (end && !time) return { error: 'Add a start time, or clear the end time.' };
    if (end && end <= time) return { error: 'The end time must be after the start time.' };
    return { time: time, end: end };
  }

  function nextItemId(items, prefix) {
    var max = 0;
    items.forEach(function (it) {
      var n = Number(String(it.id || '').slice(1));
      if (String(it.id || '').charAt(0) === prefix && Number.isInteger(n) && n > max) max = n;
    });
    return prefix + (max + 1);
  }

  /**
   * Normalise and validate a day planner from the goal form, or null:
   * { items: [{ id?, title, time, end, days }] }. Blank rows are dropped and
   * new items get ids. Returns { planner } or { error }.
   */
  function cleanPlanner(input) {
    if (input === null) return { planner: null };
    if (!isPlainObject(input) || !Array.isArray(input.items)) return { error: 'That schedule can’t be saved.' };
    var items = [];
    for (var i = 0; i < input.items.length; i++) {
      var it = input.items[i] || {};
      var title = cleanPlanTitle(it.title);
      if (!title && !it.time && !it.end) continue;
      if (!title) return { error: 'Give each item in your schedule a name.' };
      if (title.length > MAX_PLAN_TITLE) return { error: 'Keep names to ' + MAX_PLAN_TITLE + ' characters or fewer.' };
      var t = cleanPlanTimes(it);
      if (t.error) return { error: t.error };
      var days = Array.isArray(it.days) ? it.days.filter(function (d, j, a) {
        return Number.isInteger(d) && d >= 0 && d <= 6 && a.indexOf(d) === j;
      }).sort() : [];
      if (!days.length) return { error: 'Choose the days for “' + title + '”.' };
      var id = typeof it.id === 'string' && /^r\d{1,4}$/.test(it.id) && !items.some(function (x) { return x.id === it.id; }) ? it.id : null;
      items.push({ id: id, title: title, time: t.time, end: t.end, days: days });
    }
    if (items.length > MAX_PLAN_ITEMS) return { error: 'Your schedule can have up to ' + MAX_PLAN_ITEMS + ' items.' };
    items.forEach(function (it) { if (!it.id) it.id = nextItemId(items, 'r'); });
    return { planner: { items: items } };
  }

  function validPlanItem(it, idRe) {
    if (!isPlainObject(it) || typeof it.id !== 'string' || !idRe.test(it.id)) return false;
    var title = cleanPlanTitle(it.title);
    if (!title || title !== it.title || title.length > MAX_PLAN_TITLE) return false;
    if (it.time !== null && !(typeof it.time === 'string' && TIME_RE.test(it.time))) return false;
    if (it.end !== null && !(typeof it.end === 'string' && TIME_RE.test(it.end))) return false;
    return !(it.end && (!it.time || it.end <= it.time));
  }

  function uniqueIds(list) {
    return list.every(function (x, i) { return list.indexOf(x) === i; });
  }

  function validPlanner(p) {
    if (p === null) return true;
    if (!isPlainObject(p) || Object.keys(p).length !== 1 || !Array.isArray(p.items) || p.items.length > MAX_PLAN_ITEMS) return false;
    return uniqueIds(p.items.map(function (it) { return it && it.id; })) && p.items.every(function (it) {
      if (!validPlanItem(it, /^r\d{1,4}$/) || Object.keys(it).length !== 5) return false;
      var c = cleanSchedule({ type: 'days', days: it.days });
      return Array.isArray(it.days) && it.days.length && !c.error && JSON.stringify(it.days) === JSON.stringify(it.days.slice().sort()) &&
        uniqueIds(it.days) && it.days.every(function (d) { return Number.isInteger(d) && d >= 0 && d <= 6; });
    });
  }

  function validAgendaEntry(e) {
    if (!isPlainObject(e)) return false;
    if (Object.keys(e).some(function (k) { return ['items', 'skip', 'done', 'details'].indexOf(k) < 0; })) return false;
    var items = e.items === undefined ? [] : e.items;
    if (!Array.isArray(items) || items.length > MAX_DAY_ITEMS) return false;
    if (!items.every(function (it) { return validPlanItem(it, /^p\d{1,4}$/) && Object.keys(it).length === 4; })) return false;
    var ids = items.map(function (it) { return it.id; });
    if (!uniqueIds(ids)) return false;
    var skip = e.skip === undefined ? [] : e.skip;
    var done = e.done === undefined ? [] : e.done;
    if (!Array.isArray(skip) || skip.length > MAX_PLAN_ITEMS || !uniqueIds(skip) || skip.some(function (id) { return typeof id !== 'string' || !/^r\d{1,4}$/.test(id); })) return false;
    if (!Array.isArray(done) || done.length > MAX_PLAN_ITEMS + MAX_DAY_ITEMS || !uniqueIds(done)) return false;
    if (!done.every(function (id) {
      return typeof id === 'string' && (/^r\d{1,4}$/.test(id) || ids.indexOf(id) >= 0);
    })) return false;
    if (e.details === undefined) return true;
    if (!isPlainObject(e.details) || Object.keys(e.details).length > MAX_PLAN_ITEMS + MAX_DAY_ITEMS) return false;
    return Object.keys(e.details).every(function (id) {
      return (/^r\d{1,4}$/.test(id) || ids.indexOf(id) >= 0) && validDetails(e.details[id]);
    });
  }

  function validDetails(d) {
    if (!isPlainObject(d) || !Object.keys(d).length) return false;
    if (Object.keys(d).some(function (k) { return k !== 'notes' && k !== 'tasks'; })) return false;
    if (d.notes !== undefined && !(typeof d.notes === 'string' && d.notes.trim() && d.notes.length <= MAX_NOTES_LENGTH)) return false;
    if (d.tasks === undefined) return true;
    if (!Array.isArray(d.tasks) || !d.tasks.length || d.tasks.length > MAX_TASKS) return false;
    if (!uniqueIds(d.tasks.map(function (t) { return t && t.id; }))) return false;
    return d.tasks.every(function (t) {
      return isPlainObject(t) && Object.keys(t).length === 3 && typeof t.id === 'string' && /^t\d{1,4}$/.test(t.id) &&
        typeof t.text === 'string' && t.text === cleanPlanTitle(t.text) && t.text && t.text.length <= MAX_TASK_LENGTH &&
        typeof t.done === 'boolean';
    });
  }

  /** The active goal whose planner makes the day plan (the first one), or null. */
  function plannerHabit(state) {
    return activeHabits(state).filter(function (h) { return h.planner; })[0] || null;
  }

  function byTime(a, b) {
    if (a.time && b.time) return a.time < b.time ? -1 : a.time > b.time ? 1 : 0;
    if (a.time) return -1;
    if (b.time) return 1;
    return 0;
  }

  /**
   * The plan for `date`: regular items on that weekday (from the planner
   * goal) and that day's one-off items, by time (untimed last). Each is
   * { id, title, time, end, regular, skipped, done }.
   */
  function agendaFor(state, date) {
    var e = (state.agenda && state.agenda[date]) || {};
    var skip = e.skip || [];
    var done = e.done || [];
    var details = e.details || {};
    var out = [];
    function withDetails(item) {
      var d = details[item.id];
      var tasks = (d && d.tasks) || [];
      item.notes = (d && d.notes) || '';
      item.tasks = tasks.length;
      item.tasksDone = tasks.filter(function (t) { return t.done; }).length;
      return item;
    }
    var h = plannerHabit(state);
    var dow = dayOfWeek(date);
    if (h) {
      h.planner.items.forEach(function (it) {
        if (it.days.indexOf(dow) < 0) return;
        out.push(withDetails({ id: it.id, title: it.title, time: it.time, end: it.end, regular: true, skipped: skip.indexOf(it.id) >= 0, done: done.indexOf(it.id) >= 0 }));
      });
    }
    (e.items || []).forEach(function (it) {
      out.push(withDetails({ id: it.id, title: it.title, time: it.time, end: it.end, regular: false, skipped: false, done: done.indexOf(it.id) >= 0 }));
    });
    // Stable sort by time
    return out.map(function (it, i) { return [it, i]; }).sort(function (a, b) {
      return byTime(a[0], b[0]) || a[1] - b[1];
    }).map(function (x) { return x[0]; });
  }

  function agendaDateError(state, date, today) {
    if (!isValidDateKey(date)) return failure(state, 'invalid-date', 'Invalid date.');
    if (date < today) return failure(state, 'past', 'Past days can’t be planned.');
    if (daysBetween(today, date) > MAX_PLAN_AHEAD) return failure(state, 'too-far', 'You can plan up to a year ahead.');
    return null;
  }

  /** Change the agenda entry for `date` with `fn(entry)`, dropping empty parts. */
  function editAgenda(state, date, fn) {
    var next = clone(state);
    if (!isPlainObject(next.agenda)) next.agenda = {};
    var e = next.agenda[date] || {};
    e.items = e.items || [];
    e.skip = e.skip || [];
    e.done = e.done || [];
    var res = fn(e);
    if (res && res.error) return failure(state, res.error, res.message);
    var ids = e.items.map(function (it) { return it.id; });
    e.done = e.done.filter(function (id) { return id.charAt(0) === 'r' || ids.indexOf(id) >= 0; });
    ['items', 'skip', 'done'].forEach(function (k) { if (!e[k].length) delete e[k]; });
    if (e.details) {
      Object.keys(e.details).forEach(function (id) {
        var d = e.details[id];
        if (d.tasks && !d.tasks.length) delete d.tasks;
        if (!d.notes) delete d.notes;
        if ((id.charAt(0) === 'p' && ids.indexOf(id) < 0) || !Object.keys(d).length) delete e.details[id];
      });
      if (!Object.keys(e.details).length) delete e.details;
    }
    if (Object.keys(e).length) next.agenda[date] = e;
    else delete next.agenda[date];
    return result(next, res || {});
  }

  /** Check a one-off item's title and times: { title, time, end } or { error, message }. */
  function cleanAgendaItem(item) {
    var title = cleanPlanTitle(item && item.title);
    if (!title) return { error: 'invalid-title', message: 'Name what you’re planning.' };
    if (title.length > MAX_PLAN_TITLE) return { error: 'invalid-title', message: 'Keep it to ' + MAX_PLAN_TITLE + ' characters or fewer.' };
    var t = cleanPlanTimes(item);
    if (t.error) return { error: 'invalid-time', message: t.error };
    return { title: title, time: t.time, end: t.end };
  }

  /** Add a one-off item { title, time, end } to the plan for `date` (today or later). */
  function addAgendaItem(state, date, item, today) {
    var bad = agendaDateError(state, date, today);
    if (bad) return bad;
    var t = cleanAgendaItem(item);
    if (t.error) return failure(state, t.error, t.message);
    var title = t.title;
    return editAgenda(state, date, function (e) {
      if (e.items.length >= MAX_DAY_ITEMS) return { error: 'too-many', message: 'A day can have up to ' + MAX_DAY_ITEMS + ' extra items.' };
      var id = nextItemId(e.items, 'p');
      e.items.push({ id: id, title: title, time: t.time, end: t.end });
      return { id: id };
    });
  }

  /** Change a one-off item's title and times { title, time, end }. Its tick is kept. */
  function updateAgendaItem(state, date, id, item, today) {
    var bad = agendaDateError(state, date, today);
    if (bad) return bad;
    var t = cleanAgendaItem(item);
    if (t.error) return failure(state, t.error, t.message);
    return editAgenda(state, date, function (e) {
      var it = e.items.filter(function (x) { return x.id === id; })[0];
      if (!it) return { error: 'unknown-item', message: 'That item is no longer in the plan.' };
      it.title = t.title;
      it.time = t.time;
      it.end = t.end;
      return {};
    });
  }

  /** Remove a one-off item from the plan for `date`. */
  function removeAgendaItem(state, date, id, today) {
    var bad = agendaDateError(state, date, today);
    if (bad) return bad;
    return editAgenda(state, date, function (e) {
      var before = e.items.length;
      e.items = e.items.filter(function (it) { return it.id !== id; });
      if (e.items.length === before) return { error: 'unknown-item', message: 'That item is no longer in the plan.' };
      return {};
    });
  }

  /* ---- An item's description and checklist (per day) ---- */

  /** The description and checklist of item `id` on `date`: { notes, tasks: [{ id, text, done }] }. */
  function itemDetails(state, date, id) {
    var e = state.agenda && state.agenda[date];
    var d = e && e.details && e.details[id];
    return { notes: (d && d.notes) || '', tasks: clone((d && d.tasks) || []) };
  }

  /**
   * Change an item's details with fn(details). Past days are allowed too,
   * so last night's checklist can still be ticked off; the item must be in
   * that day's plan.
   */
  function editDetails(state, date, id, today, fn) {
    if (!isValidDateKey(date)) return failure(state, 'invalid-date', 'Invalid date.');
    if (daysBetween(today, date) > MAX_PLAN_AHEAD) return failure(state, 'too-far', 'You can plan up to a year ahead.');
    if (!agendaFor(state, date).some(function (it) { return it.id === id; })) {
      return failure(state, 'unknown-item', 'That item is no longer in the plan.');
    }
    return editAgenda(state, date, function (e) {
      e.details = e.details || {};
      var d = e.details[id] || {};
      d.tasks = d.tasks || [];
      e.details[id] = d;
      return fn(d);
    });
  }

  /** Set (or clear, with '') an item's description for `date`. */
  function setItemNotes(state, date, id, notes, today) {
    var text = typeof notes === 'string' ? notes.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim() : '';
    if (text.length > MAX_NOTES_LENGTH) return failure(state, 'too-long', 'Keep the description to ' + MAX_NOTES_LENGTH + ' characters or fewer.');
    return editDetails(state, date, id, today, function (d) { d.notes = text; return {}; });
  }

  /** Add a checklist item to an item's details for `date`. */
  function addItemTask(state, date, id, text, today) {
    var t = cleanPlanTitle(text);
    if (!t) return failure(state, 'invalid-task', 'Type what needs doing.');
    if (t.length > MAX_TASK_LENGTH) return failure(state, 'invalid-task', 'Keep it to ' + MAX_TASK_LENGTH + ' characters or fewer.');
    return editDetails(state, date, id, today, function (d) {
      if (d.tasks.length >= MAX_TASKS) return { error: 'too-many', message: 'A checklist can have up to ' + MAX_TASKS + ' items.' };
      var tid = nextItemId(d.tasks, 't');
      d.tasks.push({ id: tid, text: t, done: false });
      return { id: tid };
    });
  }

  /** Tick a checklist item off (or back on). */
  function setItemTaskDone(state, date, id, taskId, done, today) {
    return editDetails(state, date, id, today, function (d) {
      var t = d.tasks.filter(function (x) { return x.id === taskId; })[0];
      if (!t) return { error: 'unknown-task', message: 'That checklist item is gone.' };
      t.done = !!done;
      return {};
    });
  }

  /** Remove a checklist item. */
  function removeItemTask(state, date, id, taskId, today) {
    return editDetails(state, date, id, today, function (d) {
      var before = d.tasks.length;
      d.tasks = d.tasks.filter(function (x) { return x.id !== taskId; });
      if (d.tasks.length === before) return { error: 'unknown-task', message: 'That checklist item is gone.' };
      return {};
    });
  }

  /** Skip a regular schedule item on `date` (or bring it back). */
  function setAgendaSkip(state, date, id, skip, today) {
    var bad = agendaDateError(state, date, today);
    if (bad) return bad;
    if (!agendaFor(state, date).some(function (it) { return it.regular && it.id === id; })) {
      return failure(state, 'unknown-item', 'That isn’t on your schedule that day.');
    }
    return editAgenda(state, date, function (e) {
      e.skip = e.skip.filter(function (x) { return x !== id; });
      if (skip) {
        e.skip.push(id);
        e.done = e.done.filter(function (x) { return x !== id; });
      }
      return {};
    });
  }

  /** Tick an item in today's plan off (or back on). */
  function setAgendaDone(state, date, id, done, today) {
    if (date !== today) return failure(state, 'not-today', 'Only today’s plan can be ticked off.');
    var item = agendaFor(state, date).filter(function (it) { return it.id === id && !it.skipped; })[0];
    if (!item) return failure(state, 'unknown-item', 'That item is no longer in the plan.');
    return editAgenda(state, date, function (e) {
      e.done = e.done.filter(function (x) { return x !== id; });
      if (done) e.done.push(id);
      return {};
    });
  }

  function cleanAmount(input) {
    if (input === null) return { amount: null };
    var unit = input && input.unit;
    var u = UNITS[unit];
    if (!u) return { error: 'Choose what to track.' };
    var goal = Number(input.goal);
    if (!Number.isInteger(goal) || goal < u.minGoal || goal > u.maxGoal) {
      return { error: unit === 'min' ? 'Set a time goal between 5 minutes and 24 hours.'
        : unit === 'ml' ? 'Set a water goal between 100 ml and 10 L.' : 'Set a water goal between 4 fl oz and 3 gallons.' };
    }
    var out = { unit: unit, goal: goal };
    if (input.display !== undefined && input.display !== null) {
      if (unit !== 'oz' || OZ_DISPLAYS.indexOf(input.display) < 0) return { error: 'Choose how to show the water goal.' };
      if (input.display !== 'oz') out.display = input.display;
    }
    return { amount: out };
  }

  /** A stored amount: known unit, whole goal in range, optional display for oz. */
  function validAmount(a, minGoal) {
    if (!isPlainObject(a) || !UNITS[a.unit]) return false;
    var keys = Object.keys(a).filter(function (k) { return k !== 'unit' && k !== 'goal' && k !== 'display'; });
    if (keys.length) return false;
    if (a.display !== undefined && (a.unit !== 'oz' || a.display === 'oz' || OZ_DISPLAYS.indexOf(a.display) < 0)) return false;
    return Number.isInteger(a.goal) && a.goal >= (minGoal || 1) && a.goal <= UNITS[a.unit].maxGoal;
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
    var credit = 0;
    if (record) {
      record.habits.forEach(function (h) {
        if (h.flex) return;
        total++;
        if (record.done.indexOf(h.id) >= 0) completed++;
        credit += entryCredit(record, h);
      });
    }
    return {
      total: total,
      completed: completed,
      credit: credit,
      percentage: total ? Math.round((credit / total) * 100) : 0,
      lockedIn: total > 0 && completed === total
    };
  }

  /** The total logged for an amount goal in a daily record (in its unit). */
  function loggedAmount(record, id) {
    var list = record && record.logs && record.logs[id];
    return list ? list.reduce(function (a, m) { return a + m; }, 0) : 0;
  }

  /** How much of a goal was done that day, from 0 to 1. */
  function entryCredit(record, entry) {
    if (record.done.indexOf(entry.id) >= 0) return 1;
    if (entry.amount) return Math.min(1, loggedAmount(record, entry.id) / entry.amount.goal);
    if (record.partial && record.partial.indexOf(entry.id) >= 0) return PARTIAL_CREDIT;
    return 0;
  }

  /** 'done', 'partial' or 'none' for one goal in a daily record. */
  function entryProgress(record, entry) {
    var c = entryCredit(record, entry);
    return c >= 1 ? 'done' : c > 0 ? 'partial' : 'none';
  }

  /**
   * Keep a record consistent: done, partial and logs only mention goals on
   * the record; timed goals are done exactly when their logs reach the goal;
   * partial marks only apply to untimed goals that aren't done.
   */
  function tidyRecord(rec) {
    var byId = {};
    rec.habits.forEach(function (h) { byId[h.id] = h; });
    var ids = rec.habits.map(function (h) { return h.id; });
    var logs = {};
    if (rec.logs) {
      Object.keys(rec.logs).forEach(function (id) {
        if (byId[id] && byId[id].amount && rec.logs[id].length) logs[id] = rec.logs[id];
      });
    }
    var sum = function (id) { return (logs[id] || []).reduce(function (a, m) { return a + m; }, 0); };
    rec.done = ids.filter(function (id) {
      return byId[id].amount ? sum(id) >= byId[id].amount.goal : rec.done.indexOf(id) >= 0;
    });
    var partial = ids.filter(function (id) {
      return !byId[id].amount && rec.partial && rec.partial.indexOf(id) >= 0 && rec.done.indexOf(id) < 0;
    });
    if (partial.length) rec.partial = partial; else delete rec.partial;
    if (Object.keys(logs).length) rec.logs = logs; else delete rec.logs;
    return rec;
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
      if (h.amount) entry.amount = clone(h.amount);
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
    snap.forEach(function (h) {
      var before = rec.habits.filter(function (x) { return x.id === h.id; })[0];
      if (!before || !h.amount) return;
      var list = rec.logs && rec.logs[h.id];
      if (!before.amount) {
        // A goal that gets an amount while already ticked keeps its tick.
        if (rec.done.indexOf(h.id) >= 0 && !loggedAmount(rec, h.id)) {
          rec.logs = rec.logs || {};
          rec.logs[h.id] = [h.amount.goal];
        }
      } else if (before.amount.unit !== h.amount.unit && list) {
        // Water switched between ml and oz: convert today's entries.
        // Anything else (time to water) can't be converted, so starts over.
        var from = before.amount.unit;
        var to = h.amount.unit;
        if ((from === 'ml' && to === 'oz') || (from === 'oz' && to === 'ml')) {
          rec.logs[h.id] = list.map(function (v) {
            return Math.max(1, Math.round(to === 'oz' ? v / ML_PER_OZ : v * ML_PER_OZ));
          });
        } else {
          delete rec.logs[h.id];
        }
      }
    });
    rec.habits = snap;
    tidyRecord(rec);
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
    var entry = r.habits.filter(function (h) { return h.id === habitId; })[0];
    if (entry.amount) {
      // Ticking an amount goal logs what's left; unticking takes back the
      // most recent entries until it's below the goal again.
      var goal = entry.amount.goal;
      var list = (r.logs && r.logs[habitId]) || [];
      var sum = loggedAmount(r, habitId);
      if (done && sum < goal) list.push(goal - sum);
      if (!done) while (list.length && sum >= goal) sum -= list.pop();
      r.logs = r.logs || {};
      r.logs[habitId] = list;
    } else {
      if (done && r.done.indexOf(habitId) < 0) r.done.push(habitId);
      if (!done) r.done = r.done.filter(function (id) { return id !== habitId; });
      if (r.partial) r.partial = r.partial.filter(function (id) { return id !== habitId; });
      var order = r.habits.map(function (h) { return h.id; });
      r.done = order.filter(function (id) { return r.done.indexOf(id) >= 0; });
    }
    tidyRecord(r);
    return result(next, { lockedIn: recordSummary(r).lockedIn });
  }

  function todayEntry(state, habitId, today) {
    var rec = state.days[today];
    return rec ? rec.habits.filter(function (h) { return h.id === habitId; })[0] || null : null;
  }

  /** Mark a goal without an amount "partly done" today (or clear it). */
  function setHabitPartial(state, habitId, partial, today) {
    var entry = todayEntry(state, habitId, today);
    if (!entry) return failure(state, 'not-today', 'That goal is not on today’s list.');
    if (entry.amount) return failure(state, 'amount', 'Log an amount for this goal instead.');
    var next = clone(state);
    var r = next.days[today];
    var list = (r.partial || []).filter(function (id) { return id !== habitId; });
    if (partial) {
      list.push(habitId);
      r.done = r.done.filter(function (id) { return id !== habitId; });
    }
    r.partial = list;
    tidyRecord(r);
    return result(next, {});
  }

  /**
   * Add an entry (in the goal's unit: minutes, ml or oz) to an amount goal
   * today. Returns { done, logged, goal, unit }.
   */
  function logAmount(state, habitId, value, today) {
    var entry = todayEntry(state, habitId, today);
    if (!entry) return failure(state, 'not-today', 'That goal is not on today’s list.');
    if (!entry.amount) return failure(state, 'no-amount', 'This goal doesn’t track an amount.');
    var unit = entry.amount.unit;
    var m = Number(value);
    if (!Number.isInteger(m) || m < 1) return failure(state, 'invalid-amount', unit === 'min' ? 'Enter a number of minutes.' : 'Enter how much you drank.');
    var logged = loggedAmount(state.days[today], habitId);
    if (logged + m > UNITS[unit].maxDay) {
      return failure(state, 'invalid-amount', unit === 'min' ? 'That’s more than 24 hours in one day.' : 'That’s more than anyone should drink in a day. Check the amount.');
    }
    var r0 = state.days[today];
    if (r0.logs && r0.logs[habitId] && r0.logs[habitId].length >= MAX_LOGS) return failure(state, 'too-many', 'That’s a lot of entries for one day. Try a bigger amount.');
    var next = clone(state);
    var r = next.days[today];
    r.logs = r.logs || {};
    r.logs[habitId] = (r.logs[habitId] || []).concat([m]);
    tidyRecord(r);
    return result(next, { done: r.done.indexOf(habitId) >= 0, logged: logged + m, goal: entry.amount.goal, unit: unit, lockedIn: recordSummary(r).lockedIn });
  }

  /** Remove the most recent entry for an amount goal today. */
  function undoLog(state, habitId, today) {
    var rec = state.days[today];
    if (!rec || !rec.logs || !rec.logs[habitId] || !rec.logs[habitId].length) {
      return failure(state, 'nothing', 'There’s nothing to undo.');
    }
    var next = clone(state);
    var r = next.days[today];
    var removed = r.logs[habitId].pop();
    tidyRecord(r);
    return result(next, { removed: removed, logged: loggedAmount(r, habitId) });
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
    if (isWeeklySplit(h.split)) return swapWeekly(state, h, workout, today);
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

  /**
   * Weekly plan: today becomes `workout`, and if `workout` is planned later
   * this week, that day takes today's planned workout. Swaps only last for
   * the week: next week every day goes back to the plan.
   */
  function swapWeekly(state, h, workout, today) {
    var planned = workoutOn(state, h, today);
    if (workout === planned) return result(state, { unchanged: true, planned: planned });
    var option = weekOptions(state, h, today).filter(function (o) { return o.workout === workout; })[0];
    if (!option) return failure(state, 'unknown-workout', 'That workout isn’t in this plan.');
    var next = clone(state);
    var sp = findHabit(next, h.id).split;
    var week = weekBounds(state, today);
    // Swaps from earlier weeks have done their job.
    Object.keys(sp.moves).forEach(function (d) { if (d < week.start) delete sp.moves[d]; });
    sp.moves[today] = workout;
    if (option.date) sp.moves[option.date] = planned;
    Object.keys(sp.moves).forEach(function (d) { if (sp.moves[d] === sp.days[dayOfWeek(d)]) delete sp.moves[d]; });
    return result(syncTodayRecord(next, today), { planned: planned, movedTo: option.date ? { date: option.date } : null, weekly: true });
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
    if (opts.amount !== undefined) {
      var am = cleanAmount(opts.amount);
      if (am.error) return { error: am.error };
      out.amount = am.amount;
    }
    if (opts.split !== undefined) {
      var sp = cleanSplit(opts.split, today);
      if (sp.error) return { error: sp.error };
      out.split = sp.split;
      // A weekly plan decides the schedule: days without a workout are rest days.
      if (isWeeklySplit(sp.split)) out.schedule = cleanSchedule({ type: 'days', days: planDays(sp.split) }).schedule;
    }
    if (opts.planner !== undefined) {
      var pl = cleanPlanner(opts.planner);
      if (pl.error) return { error: pl.error };
      out.planner = pl.planner;
    }
    return { details: out };
  }

  /** A planner goal is ticked by planning, so it can't track an amount or workouts. */
  function plannerConflict(h) {
    if (h.planner && (h.amount || h.split)) return 'A day planner goal is checked off by planning tomorrow, so it can’t also track time, water or workouts.';
    return '';
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
      icon: null, color: null, schedule: { type: 'daily' }, reminder: null, split: null, amount: null, planner: null };
    Object.keys(details.details).forEach(function (k) { habit[k] = details.details[k]; });
    if (plannerConflict(habit)) return failure(state, 'invalid-details', plannerConflict(habit));
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
    // Saving the same weekly plan keeps this week's swaps.
    var newSplit = details.details.split;
    if (isWeeklySplit(newSplit) && isWeeklySplit(h.split) && JSON.stringify(newSplit.days) === JSON.stringify(h.split.days)) {
      newSplit.moves = clone(h.split.moves);
    }
    // A new schedule keeps a rotation where it is: re-anchor it on today.
    if (h.split && !isWeeklySplit(h.split) && details.details.split === undefined && details.details.schedule &&
        JSON.stringify(details.details.schedule) !== JSON.stringify(h.schedule)) {
      h.split = { workouts: h.split.workouts, start: today, offset: Math.max(0, splitIndex(state, h, today)) };
    }
    Object.keys(details.details).forEach(function (k) { h[k] = details.details[k]; });
    if (plannerConflict(h)) return failure(state, 'invalid-details', plannerConflict(h));
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
    if (next.timer && next.timer.habitId === id) next.timer = null;
    if (next.days[today]) {
      var rec = next.days[today];
      rec.habits = rec.habits.filter(function (h) { return h.id !== id; });
      rec.done = rec.done.filter(function (d) { return d !== id; });
      if (!rec.habits.length) delete next.days[today];
    }
    return result(syncTodayRecord(next, today), {});
  }

  /* ------------------------------------------------------------------ */
  /* Study timer                                                         */
  /* ------------------------------------------------------------------ */

  /*
   * One timer at a time, for a goal whose amount is time. It never counts
   * ticks: everything comes from timestamps (ms since 1970), so it stays
   * right in background tabs, while a phone sleeps and after a reload.
   *   habitId    the goal being timed
   *   date       the day it was started; time is always logged to that day,
   *              even if the session runs past midnight
   *   startedAt  when it started
   *   pausedAt   when it was paused, or null while running
   *   pausedMs   total time spent paused before pausedAt
   *   mode       'free' (a plain stopwatch) or 'focus' (25 min focus, 5 min
   *              break, repeating; each finished focus block is logged)
   *   logged     focus blocks already logged
   *   checkAt    minutes of counted time after which to ask "Still
   *              studying?" before logging any more
   */
  var FOCUS_MS = 25 * 60000;
  var BREAK_MS = 5 * 60000;
  var TIMER_CHECK_MINUTES = 180;
  var TIMER_MODES = ['free', 'focus'];

  function timerElapsedMs(t, now) {
    var end = t.pausedAt !== null ? t.pausedAt : now;
    return Math.max(0, end - t.startedAt - t.pausedMs);
  }

  /**
   * Where a timer stands at `now`: elapsed and counted time (in focus mode,
   * breaks don't count), the current phase and time left in it, finished
   * focus blocks, what hasn't been logged yet, and whether it's past the
   * "Still studying?" check.
   */
  function timerStatus(t, now) {
    var e = timerElapsedMs(t, now);
    var out = { elapsedMs: e, paused: t.pausedAt !== null, mode: t.mode, blocks: 0, phase: 'run', phaseLeftMs: 0, countedMs: e };
    if (t.mode === 'focus') {
      var cycle = FOCUS_MS + BREAK_MS;
      var cycles = Math.floor(e / cycle);
      var inCycle = e - cycles * cycle;
      var focus = inCycle < FOCUS_MS;
      out.blocks = cycles + (focus ? 0 : 1);
      out.phase = focus ? 'focus' : 'break';
      out.phaseLeftMs = focus ? FOCUS_MS - inCycle : cycle - inCycle;
      out.countedMs = out.blocks * FOCUS_MS + (focus ? inCycle : 0);
    }
    out.unloggedMs = Math.max(0, out.countedMs - t.logged * FOCUS_MS);
    out.countedMinutes = Math.floor(out.countedMs / 60000);
    out.needsCheck = out.countedMinutes >= t.checkAt;
    return out;
  }

  /** Whole minutes to log for `ms`: under a minute is skipped, otherwise rounded. */
  function timerMinutes(ms) {
    return ms < 60000 ? 0 : Math.round(ms / 60000);
  }

  function timedEntry(state, habitId, date) {
    var rec = state.days[date];
    var e = rec && rec.habits.filter(function (h) { return h.id === habitId; })[0];
    return e && e.amount && e.amount.unit === 'min' ? e : null;
  }

  /** Start timing a time goal that's on today's list. */
  function startTimer(state, habitId, today, now, mode) {
    if (state.timer) return failure(state, 'busy', 'Another timer is running. Stop it first.');
    if (!timedEntry(state, habitId, today)) return failure(state, 'not-timed', 'Only goals measured in time can be timed.');
    var m = mode || 'free';
    if (TIMER_MODES.indexOf(m) < 0) return failure(state, 'invalid-mode', 'Unknown timer mode.');
    if (!Number.isFinite(now)) return failure(state, 'invalid-time', 'Invalid time.');
    var next = clone(state);
    next.timer = { habitId: habitId, date: today, startedAt: Math.round(now), pausedAt: null, pausedMs: 0, mode: m, logged: 0, checkAt: TIMER_CHECK_MINUTES };
    return result(next, {});
  }

  function pauseTimer(state, now) {
    if (!state.timer) return failure(state, 'no-timer', 'No timer is running.');
    if (state.timer.pausedAt !== null) return result(state, { unchanged: true });
    var next = clone(state);
    next.timer.pausedAt = Math.max(next.timer.startedAt, Math.round(now));
    return result(next, {});
  }

  function resumeTimer(state, now) {
    if (!state.timer) return failure(state, 'no-timer', 'No timer is running.');
    if (state.timer.pausedAt === null) return result(state, { unchanged: true });
    var next = clone(state);
    var t = next.timer;
    t.pausedMs += Math.max(0, Math.round(now) - t.pausedAt);
    t.pausedAt = null;
    return result(next, {});
  }

  /** Log `minutes` for the timer's goal on the day it started, capped to what's left of that day. */
  function logTimerMinutes(state, t, minutes) {
    var rec = state.days[t.date];
    var room = UNITS.min.maxDay - loggedAmount(rec, t.habitId);
    var m = Math.min(minutes, room);
    if (m < 1) return { state: state, minutes: 0 };
    var r = logAmount(state, t.habitId, m, t.date);
    return r.ok ? { state: r.state, minutes: m, done: r.done, lockedIn: r.lockedIn } : { state: state, minutes: 0, error: r.message };
  }

  /**
   * Stop the timer and log what hasn't been logged yet (rounded to the
   * minute; under a minute is skipped). `minutes`, when given, replaces the
   * measured amount (the "Still studying?" edit). Returns { minutes, date,
   * habitId, skipped }.
   */
  function stopTimer(state, now, minutes) {
    var t = state.timer;
    if (!t) return failure(state, 'no-timer', 'No timer is running.');
    var st = timerStatus(t, now);
    var m = minutes === undefined || minutes === null ? timerMinutes(st.unloggedMs) : Number(minutes);
    if (!Number.isInteger(m) || m < 0) return failure(state, 'invalid-minutes', 'Enter a whole number of minutes.');
    var next = clone(state);
    next.timer = null;
    var extra = { habitId: t.habitId, date: t.date, minutes: 0, skipped: true };
    if (m < 1 || !timedEntry(next, t.habitId, t.date)) return result(next, extra);
    var logged = logTimerMinutes(next, t, m);
    extra.minutes = logged.minutes;
    extra.skipped = logged.minutes < 1;
    extra.done = logged.done;
    extra.lockedIn = logged.lockedIn;
    return result(logged.state, extra);
  }

  /** Drop the timer without logging anything. */
  function discardTimer(state) {
    if (!state.timer) return result(state, { unchanged: true });
    var next = clone(state);
    next.timer = null;
    return result(next, {});
  }

  /**
   * Focus mode: log each finished 25-minute block that isn't logged yet,
   * but never past the "Still studying?" check. Returns { blocks, minutes }.
   */
  function timerCatchUp(state, now) {
    var t = state.timer;
    if (!t || t.mode !== 'focus') return result(state, { blocks: 0, minutes: 0 });
    var st = timerStatus(t, now);
    var allowed = Math.floor(t.checkAt / 25);
    var fresh = Math.min(st.blocks, allowed) - t.logged;
    if (fresh < 1) return result(state, { blocks: 0, minutes: 0 });
    var next = clone(state);
    next.timer.logged += fresh;
    var extra = { blocks: fresh, minutes: 0, habitId: t.habitId, date: t.date, phase: st.phase };
    if (!timedEntry(next, t.habitId, t.date)) return result(next, extra);
    var logged = logTimerMinutes(next, t, fresh * 25);
    extra.minutes = logged.minutes;
    extra.done = logged.done;
    extra.lockedIn = logged.lockedIn;
    return result(logged.state, extra);
  }

  /** "Still studying? Yes": keep going and ask again in another 3 hours. */
  function confirmTimer(state, now) {
    if (!state.timer) return failure(state, 'no-timer', 'No timer is running.');
    var next = clone(state);
    var st = timerStatus(next.timer, now);
    next.timer.checkAt = Math.max(next.timer.checkAt, st.countedMinutes) + TIMER_CHECK_MINUTES;
    return result(next, {});
  }

  function validTimer(t, s) {
    if (t === null) return true;
    if (!isPlainObject(t)) return false;
    var keys = ['habitId', 'date', 'startedAt', 'pausedAt', 'pausedMs', 'mode', 'logged', 'checkAt'];
    if (Object.keys(t).length !== keys.length || keys.some(function (k) { return !(k in t); })) return false;
    if (!Array.isArray(s.habits) || !s.habits.some(function (h) { return h && h.id === t.habitId; })) return false;
    if (!isValidDateKey(t.date) || TIMER_MODES.indexOf(t.mode) < 0) return false;
    if (!Number.isInteger(t.startedAt) || t.startedAt < 0) return false;
    if (t.pausedAt !== null && !(Number.isInteger(t.pausedAt) && t.pausedAt >= t.startedAt)) return false;
    return isNonNegInt(t.pausedMs) && isNonNegInt(t.logged) && Number.isInteger(t.checkAt) && t.checkAt >= TIMER_CHECK_MINUTES;
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
        if (h.amount !== null && !validAmount(h.amount, UNITS[h.amount && h.amount.unit] && UNITS[h.amount.unit].minGoal)) err(label + '.amount is invalid.');
        if (!validPlanner(h.planner)) err(label + '.planner is invalid.');
        else if (h.planner && (h.amount || h.split)) err(label + ' is a day planner with an amount or workouts.');
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
        var badAmount = h.amount !== undefined && !validAmount(h.amount, 1);
        if (typeof h.id !== 'string' || !validName(h.name) || badFlex || badWorkout || badAmount || (h.flex === undefined && h.target !== undefined)) {
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
      var entryOf = function (id) { return rec.habits.filter(function (h) { return isPlainObject(h) && h.id === id; })[0]; };
      if (rec.partial !== undefined) {
        if (!Array.isArray(rec.partial) || rec.partial.some(function (id, i, a) {
          var e = entryOf(id);
          return !e || e.amount || rec.done.indexOf(id) >= 0 || a.indexOf(id) !== i;
        })) err(label + ' has an invalid partly done goal.');
      }
      if (rec.logs !== undefined) {
        if (!isPlainObject(rec.logs)) {
          err(label + ' has invalid time logs.');
        } else {
          Object.keys(rec.logs).forEach(function (id) {
            var e = entryOf(id);
            var list = rec.logs[id];
            var maxDay = e && e.amount && UNITS[e.amount.unit] ? UNITS[e.amount.unit].maxDay : 0;
            if (!e || !e.amount || !Array.isArray(list) || !list.length || list.length > MAX_LOGS ||
                list.some(function (m) { return !Number.isInteger(m) || m < 1 || m > maxDay; }) ||
                list.reduce(function (a, m) { return a + m; }, 0) > maxDay) {
              err(label + ' has invalid time logs.');
            }
          });
        }
      }
      rec.habits.forEach(function (h) {
        if (!isPlainObject(h) || !isPlainObject(h.amount)) return;
        var reached = loggedAmount(rec, h.id) >= h.amount.goal;
        if (reached !== (rec.done.indexOf(h.id) >= 0)) err(label + ' has an amount goal whose logs don’t match its tick.');
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
    if (!isPlainObject(s.agenda)) {
      err('agenda must be an object keyed by date.');
    } else {
      var agendaDates = Object.keys(s.agenda);
      if (agendaDates.length > MAX_DAYS) err('Too many planned days.');
      agendaDates.forEach(function (d) {
        if (!isValidDateKey(d) || !validAgendaEntry(s.agenda[d])) err('agenda[' + d + '] is invalid.');
      });
    }
    if (!isPlainObject(s.settings) || (s.settings.weekStart !== 0 && s.settings.weekStart !== 1)) err('settings.weekStart must be 0 or 1.');
    if (s.timer === undefined || !validTimer(s.timer, s)) err('timer is invalid.');
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
   *   6 — Adds time goals (minutes, null for existing goals), time logs and
   *       "partly done" marks to daily records.
   *   9 — Adds weekly workout plans (split.type 'weekly'); nothing to convert.
   *   8 — Adds the study timer (timer: null when none is running).
   *   7 — Generalises time goals into amount goals, so water can be tracked
   *       too: minutes: n becomes amount: { unit: 'min', goal: n } on goals
   *       and daily records. Logs are unchanged (still minutes).
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
    },

    5: function v5ToV6(old) {
      if (!isPlainObject(old)) throw new Error('Saved data is not an object.');
      if (!Array.isArray(old.habits)) throw new Error('habits must be a list.');
      var next = clone(old);
      next.schemaVersion = 6;
      next.habits = next.habits.map(function (h) {
        if (isPlainObject(h) && h.minutes === undefined) h.minutes = null;
        return h;
      });
      return next;
    },

    8: function v8ToV9(old) {
      // Adds weekly workout plans as a kind of split; existing data is unchanged.
      if (!isPlainObject(old)) throw new Error('Saved data is not an object.');
      var next = clone(old);
      next.schemaVersion = 9;
      return next;
    },

    6: function v6ToV7(old) {
      if (!isPlainObject(old)) throw new Error('Saved data is not an object.');
      if (!Array.isArray(old.habits)) throw new Error('habits must be a list.');
      var next = clone(old);
      next.schemaVersion = 7;
      var toAmount = function (h) {
        if (!isPlainObject(h)) return h;
        if (h.minutes !== undefined) {
          if (h.minutes !== null) h.amount = { unit: 'min', goal: h.minutes };
          else if (h.amount === undefined) h.amount = null;
          delete h.minutes;
        }
        return h;
      };
      next.habits = next.habits.map(function (h) {
        h = toAmount(h);
        if (isPlainObject(h) && h.amount === undefined) h.amount = null;
        return h;
      });
      if (isPlainObject(next.days)) {
        Object.keys(next.days).forEach(function (d) {
          var rec = next.days[d];
          if (!isPlainObject(rec) || !Array.isArray(rec.habits)) return;
          rec.habits = rec.habits.map(function (e) {
            if (isPlainObject(e) && e.minutes !== undefined) {
              e.amount = { unit: 'min', goal: e.minutes };
              delete e.minutes;
            }
            return e;
          });
        });
      }
      return next;
    },

    9: function v9ToV10(old) {
      // Adds the day planner: goals gain planner: null, and an empty agenda.
      if (!isPlainObject(old)) throw new Error('Saved data is not an object.');
      if (!Array.isArray(old.habits)) throw new Error('habits must be a list.');
      var next = clone(old);
      next.schemaVersion = 10;
      next.habits = next.habits.map(function (h) {
        if (isPlainObject(h) && h.planner === undefined) h.planner = null;
        return h;
      });
      if (next.agenda === undefined) next.agenda = {};
      return next;
    },

    10: function v10ToV11(old) {
      // Adds descriptions and checklists to planned items; existing data is unchanged.
      if (!isPlainObject(old)) throw new Error('Saved data is not an object.');
      var next = clone(old);
      next.schemaVersion = 11;
      return next;
    },

    7: function v7ToV8(old) {
      if (!isPlainObject(old)) throw new Error('Saved data is not an object.');
      var next = clone(old);
      next.schemaVersion = 8;
      if (next.timer === undefined) next.timer = null;
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
    var state = { schemaVersion: data.schemaVersion, habits: data.habits, days: data.days, focus: data.focus, agenda: data.agenda, settings: data.settings, timer: data.timer };
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
          if (h.amount) {
            item.amount = { unit: h.amount.unit, logged: loggedAmount(rec, h.id), goal: h.amount.goal };
            if (h.amount.display) item.amount.display = h.amount.display;
          }
          else if (rec.partial && rec.partial.indexOf(h.id) >= 0) item.partlyDone = true;
          return item;
        }),
        totalCompleted: s.completed,
        credit: Math.round(s.credit * 100) / 100,
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
      agenda: clone(state.agenda || {}),
      settings: clone(state.settings),
      timer: clone(state.timer === undefined ? null : state.timer),
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
    cleanPlanner: cleanPlanner,
    plannerHabit: plannerHabit,
    agendaFor: agendaFor,
    addAgendaItem: addAgendaItem,
    removeAgendaItem: removeAgendaItem,
    updateAgendaItem: updateAgendaItem,
    itemDetails: itemDetails,
    setItemNotes: setItemNotes,
    addItemTask: addItemTask,
    setItemTaskDone: setItemTaskDone,
    removeItemTask: removeItemTask,
    MAX_NOTES_LENGTH: MAX_NOTES_LENGTH,
    MAX_TASK_LENGTH: MAX_TASK_LENGTH,
    setAgendaSkip: setAgendaSkip,
    setAgendaDone: setAgendaDone,
    MAX_PLAN_TITLE: MAX_PLAN_TITLE,
    MAX_PLAN_AHEAD: MAX_PLAN_AHEAD,
    setWeekStart: setWeekStart,
    scheduleOn: scheduleOn,
    cleanSchedule: cleanSchedule,
    MAX_WORKOUTS: MAX_WORKOUTS,
    MAX_WORKOUT_LENGTH: MAX_WORKOUT_LENGTH,
    cleanSplit: cleanSplit,
    splitIndex: splitIndex,
    workoutOn: workoutOn,
    upcomingWorkouts: upcomingWorkouts,
    isWeeklySplit: isWeeklySplit,
    weekBounds: weekBounds,
    swapWorkout: swapWorkout,
    FOCUS_MS: FOCUS_MS,
    BREAK_MS: BREAK_MS,
    TIMER_CHECK_MINUTES: TIMER_CHECK_MINUTES,
    timerStatus: timerStatus,
    timerMinutes: timerMinutes,
    startTimer: startTimer,
    pauseTimer: pauseTimer,
    resumeTimer: resumeTimer,
    stopTimer: stopTimer,
    discardTimer: discardTimer,
    timerCatchUp: timerCatchUp,
    confirmTimer: confirmTimer,
    PARTIAL_CREDIT: PARTIAL_CREDIT,
    MIN_GOAL_MINUTES: MIN_GOAL_MINUTES,
    UNITS: UNITS,
    cleanAmount: cleanAmount,
    loggedAmount: loggedAmount,
    entryCredit: entryCredit,
    entryProgress: entryProgress,
    setHabitPartial: setHabitPartial,
    logAmount: logAmount,
    undoLog: undoLog,
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
