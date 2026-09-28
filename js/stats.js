/*
 * Day by Day — statistics.
 *
 * Every number the app shows (streaks, totals, rates, charts, calendar) is
 * calculated here from the daily records, never from a stored counter.
 * Pure functions; tested directly with Node.
 *
 * Definitions
 *   Tracked day     a record with at least one required habit. Days with no
 *                   required habits (everything paused) are neutral: they
 *                   neither count nor break a streak.
 *   Locked In day   a tracked day with every required habit done.
 *   Today           counts as soon as it is Locked In. Until then it is "in
 *                   progress" and does not break the current streak.
 */
(function (root, factory) {
  'use strict';
  var core = typeof module === 'object' && module.exports ? require('./core.js') : root.DayByDayCore;
  var api = factory(core);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DayByDayStats = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';

  /** Tracked records up to and including `today`, oldest first. */
  function trackedDays(state, today) {
    return core.sortedDates(state)
      .filter(function (d) { return d <= today && state.days[d].habits.length > 0; })
      .map(function (d) { return { date: d, summary: core.recordSummary(state.days[d]) }; });
  }

  /**
   * Walk back from the most recent tracked day counting a run. `ok(day)`
   * says whether a day continues the run; today is skipped while it isn't
   * finished yet.
   */
  function runBack(days, today, ok) {
    var n = 0;
    for (var i = days.length - 1; i >= 0; i--) {
      var d = days[i];
      if (d.date === today && !ok(d)) continue;
      if (!ok(d)) break;
      n++;
    }
    return n;
  }

  function bestRun(days, ok) {
    var best = 0;
    var run = 0;
    days.forEach(function (d) {
      run = ok(d) ? run + 1 : 0;
      if (run > best) best = run;
    });
    return best;
  }

  function isLocked(d) {
    return d.summary.lockedIn;
  }

  function currentStreak(state, today) {
    return runBack(trackedDays(state, today), today, isLocked);
  }

  function bestStreak(state, today) {
    return bestRun(trackedDays(state, today), isLocked);
  }

  /** Headline numbers for the Today and Stats tabs (and exports). */
  function summary(state, today) {
    var days = trackedDays(state, today);
    var done = 0;
    var possible = 0;
    var locked = 0;
    days.forEach(function (d) {
      done += d.summary.completed;
      possible += d.summary.total;
      if (d.summary.lockedIn) locked++;
    });
    return {
      currentStreak: runBack(days, today, isLocked),
      bestStreak: bestRun(days, isLocked),
      totalLockedInDays: locked,
      totalTrackedDays: days.length,
      completionRate: possible ? Math.round((done / possible) * 100) : 0,
      firstDay: days.length ? days[0].date : null
    };
  }

  /**
   * Daily completion for the chart. `range` is 7, 30, 90 or 'all'.
   * One entry per calendar day ending today; days with no tracked record
   * have percentage null (a gap, not a zero).
   */
  function dailySeries(state, today, range) {
    var days = trackedDays(state, today);
    var start;
    if (range === 'all') {
      start = days.length ? days[0].date : today;
    } else {
      start = core.addDays(today, -(Number(range) - 1));
    }
    var out = [];
    var span = core.daysBetween(start, today);
    for (var i = 0; i <= span; i++) {
      var d = core.addDays(start, i);
      var rec = state.days[d];
      var s = rec && rec.habits.length ? core.recordSummary(rec) : null;
      out.push({
        date: d,
        percentage: s ? s.percentage : null,
        completed: s ? s.completed : 0,
        total: s ? s.total : 0,
        lockedIn: s ? s.lockedIn : false
      });
    }
    return out;
  }

  /**
   * Per-habit statistics, calculated only over the days each habit was
   * required. Includes paused and archived habits that have history.
   * Current name and status come from the habit list.
   */
  function habitStats(state, today) {
    var dates = core.sortedDates(state).filter(function (d) { return d <= today; });
    return state.habits.map(function (h) {
      var days = [];
      dates.forEach(function (d) {
        var rec = state.days[d];
        if (!rec.habits.some(function (x) { return x.id === h.id; })) return;
        days.push({ date: d, done: rec.done.indexOf(h.id) >= 0 });
      });
      var completed = days.filter(function (d) { return d.done; }).length;
      var ok = function (d) { return d.done; };
      return {
        id: h.id,
        name: h.name,
        status: h.status,
        activeDays: days.length,
        completed: completed,
        completionRate: days.length ? Math.round((completed / days.length) * 100) : 0,
        currentStreak: runBack(days, today, ok),
        bestStreak: bestRun(days, ok)
      };
    }).filter(function (s) { return s.activeDays > 0 || s.status === 'active'; });
  }

  /**
   * How a calendar day went: 'locked', 'partial', 'missed', 'none', 'future',
   * or 'pending' for today while nothing is ticked yet (the day isn't over,
   * so it isn't a miss).
   */
  function dayState(state, date, today) {
    if (date > today) return 'future';
    var rec = state.days[date];
    if (!rec || !rec.habits.length) return 'none';
    var s = core.recordSummary(rec);
    if (s.lockedIn) return 'locked';
    if (s.completed > 0) return 'partial';
    return date === today ? 'pending' : 'missed';
  }

  /**
   * Weeks for a month view (Sunday first). Each cell:
   * { date, day, inMonth, state, isToday, percentage }.
   */
  function monthGrid(state, year, month, today) {
    var first = year + '-' + (month < 10 ? '0' : '') + month + '-01';
    var dow = new Date(year, month - 1, 1).getDay();
    var start = core.addDays(first, -dow);
    var dim = core.daysInMonth(year, month);
    var weeks = Math.ceil((dow + dim) / 7);
    var rows = [];
    for (var w = 0; w < weeks; w++) {
      var row = [];
      for (var i = 0; i < 7; i++) {
        var d = core.addDays(start, w * 7 + i);
        var rec = state.days[d];
        row.push({
          date: d,
          day: Number(d.slice(8)),
          inMonth: d.slice(0, 7) === first.slice(0, 7),
          state: dayState(state, d, today),
          isToday: d === today,
          percentage: rec && rec.habits.length ? core.recordSummary(rec).percentage : null
        });
      }
      rows.push(row);
    }
    return rows;
  }

  /** Detail for one date: names as they were on that day. */
  function dayDetail(state, date, today) {
    var rec = state.days[date];
    var s = core.recordSummary(rec);
    return {
      date: date,
      state: dayState(state, date, today),
      completed: s.completed,
      total: s.total,
      lockedIn: s.lockedIn,
      items: rec ? rec.habits.map(function (h) { return { id: h.id, name: h.name, done: rec.done.indexOf(h.id) >= 0 }; }) : []
    };
  }

  return {
    trackedDays: trackedDays,
    currentStreak: currentStreak,
    bestStreak: bestStreak,
    summary: summary,
    dailySeries: dailySeries,
    habitStats: habitStats,
    dayState: dayState,
    monthGrid: monthGrid,
    dayDetail: dayDetail
  };
});
