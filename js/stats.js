/*
 * Day by Day — statistics.
 *
 * Every number the app shows (streaks, totals, rates, charts, calendar,
 * insights) is calculated here from the daily records, never from a stored
 * counter. Pure functions; tested directly with Node.
 *
 * Definitions
 *   Tracked day       a record with at least one required goal. Days with no
 *                     required goals (everything paused, or nothing scheduled)
 *                     are neutral: they neither count nor break a streak.
 *   Locked In day     a tracked day with every required goal done.
 *   Locked-in streak  consecutive Locked In days (the headline streak).
 *   Goal streak       consecutive days (or weeks, for times-per-week goals)
 *                     on which one goal was done. A goal can have a long
 *                     streak while the locked-in streak is 0, because the
 *                     locked-in streak needs every goal.
 *   Today             counts as soon as it is Locked In. Until then it is "in
 *                     progress" and does not break a streak.
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

  /* Minimum real data before each insight appears. */
  var MIN = {
    patternDays: 7,        // tracked days before weekly patterns and analytics
    trendDays: 3,          // tracked days needed in each 7-day window for a trend
    weekdaySamples: 2,     // tracked occurrences of every compared weekday
    weekdayDays: 14,       // tracked days before strongest/weakest weekday
    opportunityDays: 7,    // days a goal must have been due before it's called out
    chartDays: 3           // tracked days in range before the daily chart is drawn
  };

  function summaryOf(state, d) {
    return core.recordSummary(state.days[d]);
  }

  /** Tracked records up to and including `today`, oldest first. */
  function trackedDays(state, today) {
    return core.sortedDates(state)
      .filter(function (d) { return d <= today; })
      .map(function (d) { return { date: d, summary: summaryOf(state, d) }; })
      .filter(function (d) { return d.summary.total > 0; });
  }

  /**
   * Walk back from the most recent entry counting a run. `ok(entry)` says
   * whether it continues the run; `isCurrent(entry)` marks the in-progress
   * period (today, or this week), which is skipped while not yet done.
   */
  function runBack(entries, isCurrent, ok) {
    var n = 0;
    for (var i = entries.length - 1; i >= 0; i--) {
      var e = entries[i];
      if (isCurrent(e) && !ok(e)) continue;
      if (!ok(e)) break;
      n++;
    }
    return n;
  }

  function bestRun(entries, ok) {
    var best = 0;
    var run = 0;
    entries.forEach(function (e) {
      run = ok(e) ? run + 1 : 0;
      if (run > best) best = run;
    });
    return best;
  }

  function isLocked(d) {
    return d.summary.lockedIn;
  }

  function isDay(today) {
    return function (e) { return e.date === today; };
  }

  function currentStreak(state, today) {
    return runBack(trackedDays(state, today), isDay(today), isLocked);
  }

  function bestStreak(state, today) {
    return bestRun(trackedDays(state, today), isLocked);
  }

  function totals(days) {
    var done = 0;
    var possible = 0;
    var locked = 0;
    days.forEach(function (d) {
      done += d.summary.credit;
      possible += d.summary.total;
      if (d.summary.lockedIn) locked++;
    });
    return { done: done, possible: possible, locked: locked, days: days.length,
      rate: possible ? Math.round((done / possible) * 100) : null };
  }

  /** Headline numbers for Today and Stats (and exports). */
  function summary(state, today) {
    var days = trackedDays(state, today);
    var t = totals(days);
    return {
      currentStreak: runBack(days, isDay(today), isLocked),
      bestStreak: bestRun(days, isLocked),
      totalLockedInDays: t.locked,
      totalTrackedDays: days.length,
      completionRate: t.rate === null ? 0 : t.rate,
      firstDay: days.length ? days[0].date : null
    };
  }

  /* ---------------- Weeks ---------------- */

  /** First day of the week containing `date` (weekStart 0 = Sunday, 1 = Monday). */
  function weekStartOf(date, weekStart) {
    var back = (core.dayOfWeek(date) - (weekStart || 0) + 7) % 7;
    return core.addDays(date, -back);
  }

  /** Tracked-day totals for the 7 days ending `end` (inclusive). */
  function windowTotals(state, end) {
    var start = core.addDays(end, -6);
    return totals(trackedDays(state, end).filter(function (d) { return d.date >= start; }));
  }

  /**
   * Past 7 days compared with the 7 days before. Only returned when both
   * windows have enough tracked days to be meaningful.
   */
  function weekOverWeek(state, today) {
    var thisWeek = windowTotals(state, today);
    var lastWeek = windowTotals(state, core.addDays(today, -7));
    if (thisWeek.days < MIN.trendDays || lastWeek.days < MIN.trendDays) {
      return { available: false, thisWeek: thisWeek, lastWeek: lastWeek };
    }
    return { available: true, thisWeek: thisWeek, lastWeek: lastWeek, change: thisWeek.rate - lastWeek.rate };
  }

  /**
   * Completion rate by weekday over the last 12 weeks. Strongest and weakest
   * are only named when there is enough data and they actually differ.
   */
  function weekdayStrength(state, today) {
    var from = core.addDays(today, -83);
    var days = trackedDays(state, today).filter(function (d) { return d.date >= from; });
    var byDow = [0, 1, 2, 3, 4, 5, 6].map(function (dow) { return { dow: dow, done: 0, possible: 0, days: 0 }; });
    days.forEach(function (d) {
      var b = byDow[core.dayOfWeek(d.date)];
      b.done += d.summary.credit;
      b.possible += d.summary.total;
      b.days++;
    });
    byDow.forEach(function (b) { b.rate = b.possible ? Math.round((b.done / b.possible) * 100) : null; });
    var sampled = byDow.filter(function (b) { return b.days >= MIN.weekdaySamples; });
    var enough = days.length >= MIN.weekdayDays && sampled.length >= 2;
    var result = { available: false, days: byDow, trackedDays: days.length };
    if (!enough) return result;
    var sorted = sampled.slice().sort(function (a, b) { return b.rate - a.rate || a.dow - b.dow; });
    var strongest = sorted[0];
    var weakest = sorted[sorted.length - 1];
    if (strongest.rate - weakest.rate < 5) return result;
    result.available = true;
    result.strongest = strongest;
    result.weakest = weakest;
    return result;
  }

  /* ---------------- Per-goal ---------------- */

  /**
   * Per-goal statistics. Every-day and chosen-day goals are measured over the
   * days they were due; times-per-week goals over the weeks they ran (a week
   * counts when its target was met). Includes paused and archived goals that
   * have history. Current name and status come from the goal list.
   */
  function habitStats(state, today, weekStart) {
    var dates = core.sortedDates(state).filter(function (d) { return d <= today; });
    var thisWeek = weekStartOf(today, weekStart);
    return state.habits.map(function (h) {
      var daily = [];
      var weeks = {};
      var weekOrder = [];
      dates.forEach(function (d) {
        var rec = state.days[d];
        var entry = null;
        for (var i = 0; i < rec.habits.length; i++) if (rec.habits[i].id === h.id) entry = rec.habits[i];
        if (!entry) return;
        var done = rec.done.indexOf(h.id) >= 0;
        if (!entry.flex) {
          daily.push({ date: d, done: done, credit: core.entryCredit(rec, entry) });
          return;
        }
        var w = weekStartOf(d, weekStart);
        if (!weeks[w]) { weeks[w] = { date: w, count: 0, target: entry.target }; weekOrder.push(w); }
        if (done) weeks[w].count++;
        weeks[w].target = entry.target;
      });
      var weekly = h.schedule && h.schedule.type === 'weekly' || (!daily.length && weekOrder.length > 0);
      var base = { id: h.id, name: h.name, status: h.status, icon: h.icon, color: h.color, schedule: h.schedule };
      if (weekly) {
        var list = weekOrder.map(function (w) { var x = weeks[w]; x.met = x.count >= x.target; return x; });
        var current = thisWeek;
        var counted = list.filter(function (x) { return x.date !== current || x.met; });
        var met = counted.filter(function (x) { return x.met; }).length;
        var cw = weeks[current];
        return Object.assign(base, {
          unit: 'week',
          activeDays: list.length,
          periods: counted.length,
          completed: list.reduce(function (a, x) { return a + x.count; }, 0),
          completionRate: counted.length ? Math.round((met / counted.length) * 100) : 0,
          currentStreak: runBack(list, function (x) { return x.date === current; }, function (x) { return x.met; }),
          bestStreak: bestRun(list, function (x) { return x.met; }),
          thisWeek: cw ? { count: cw.count, target: cw.target } : null
        });
      }
      var completed = daily.filter(function (d) { return d.done; }).length;
      var credit = daily.reduce(function (a, d) { return a + d.credit; }, 0);
      var ok = function (d) { return d.done; };
      return Object.assign(base, {
        unit: 'day',
        activeDays: daily.length,
        periods: daily.length,
        completed: completed,
        completionRate: daily.length ? Math.round((credit / daily.length) * 100) : 0,
        currentStreak: runBack(daily, isDay(today), ok),
        bestStreak: bestRun(daily, ok)
      });
    }).filter(function (s) { return s.activeDays > 0 || s.status === 'active'; });
  }

  /** This week's progress for times-per-week goals shown today. */
  function weeklyProgress(state, today, weekStart, habitId) {
    var start = weekStartOf(today, weekStart);
    var count = 0;
    for (var i = 0; i < 7; i++) {
      var d = core.addDays(start, i);
      if (d > today) break;
      var rec = state.days[d];
      if (rec && rec.done.indexOf(habitId) >= 0) count++;
    }
    return count;
  }

  /**
   * One goal's recent history as week columns for a contribution grid.
   * Each cell is { date, state } where state is:
   *   'done'     the goal was done that day
   *   'missed'   it was due (every-day/chosen-day goal) and not done
   *   'open'     a times-per-week goal that wasn't done that day (not a miss)
   *   'pending'  today, due and not done yet
   *   'none'     not due that day (not scheduled, paused, or before it existed)
   *   'future'   after today
   * Also returns totals for the window: due and done (required days only),
   * and doneAll (every done day, including times-per-week goals).
   */
  function habitGrid(state, habitId, today, weeks, weekStart) {
    var n = Math.max(1, Math.round(weeks) || 1);
    var start = core.addDays(weekStartOf(today, weekStart), -(n - 1) * 7);
    var cols = [];
    var due = 0;
    var done = 0;
    var doneAll = 0;
    for (var w = 0; w < n; w++) {
      var col = [];
      for (var i = 0; i < 7; i++) {
        var d = core.addDays(start, w * 7 + i);
        var cell = { date: d, state: 'none' };
        if (d > today) {
          cell.state = 'future';
        } else {
          var rec = state.days[d];
          var entry = null;
          if (rec) for (var k = 0; k < rec.habits.length; k++) if (rec.habits[k].id === habitId) entry = rec.habits[k];
          if (entry) {
            var isDone = rec.done.indexOf(habitId) >= 0;
            if (isDone) doneAll++;
            if (!entry.flex && !(d === today && !isDone)) {
              due++;
              if (isDone) done++;
            }
            var part = !isDone && core.entryCredit(rec, entry) > 0;
            cell.state = isDone ? 'done' : part ? 'partial' : d === today ? 'pending' : entry.flex ? 'open' : 'missed';
          }
        }
        col.push(cell);
      }
      cols.push(col);
    }
    return { start: start, weeks: cols, due: due, done: done, doneAll: doneAll };
  }

  /* ---------------- Insights ---------------- */

  var DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  /**
   * Plain-language insights, each only when supported by enough real data.
   * Returns { trackedDays, needed, items: [{ id, tone, text }] } where
   * `needed` is how many more tracked days unlock weekly patterns (0 = unlocked).
   * `dayName(dow)` names a weekday (English by default).
   */
  function insights(state, today, dayName) {
    var name = dayName || function (dow) { return DAY_NAMES[dow]; };
    var tracked = trackedDays(state, today).length;
    var out = { trackedDays: tracked, needed: Math.max(0, MIN.patternDays - tracked), items: [] };
    if (out.needed) return out;

    var wow = weekOverWeek(state, today);
    if (wow.available) {
      var ch = wow.change;
      out.items.push({
        id: 'trend',
        tone: ch > 0 ? 'up' : ch < 0 ? 'down' : 'flat',
        text: wow.thisWeek.rate + '% of goals done this week, ' +
          (ch === 0 ? 'the same as last week.' : (ch > 0 ? 'up ' : 'down ') + Math.abs(ch) + ' points on last week.')
      });
    } else {
      var w = windowTotals(state, today);
      if (w.days) out.items.push({ id: 'week', tone: 'flat', text: w.rate + '% of goals done this week.' });
    }

    // Biggest opportunity: the active every-day goal done least often in the last 30 days.
    var from = core.addDays(today, -29);
    var recent = state.habits.filter(function (h) { return h.status === 'active'; }).map(function (h) {
      var due = 0;
      var done = 0;
      core.sortedDates(state).forEach(function (d) {
        if (d < from || d > today) return;
        var rec = state.days[d];
        if (!rec.habits.some(function (x) { return x.id === h.id && !x.flex; })) return;
        if (d === today && rec.done.indexOf(h.id) < 0) return; // today isn't over
        due++;
        if (rec.done.indexOf(h.id) >= 0) done++;
      });
      return { name: h.name, due: due, rate: due ? Math.round((done / due) * 100) : null };
    }).filter(function (x) { return x.due >= MIN.opportunityDays; });
    if (recent.length >= 2) {
      recent.sort(function (a, b) { return a.rate - b.rate; });
      var low = recent[0];
      var next = recent[1];
      if (low.rate < 85 && next.rate - low.rate >= 10) {
        out.items.push({ id: 'opportunity', tone: 'focus', text: low.name + ' has the most room to grow: ' + low.rate + '% this month.' });
      }
    }

    var wd = weekdayStrength(state, today);
    if (wd.available) {
      out.items.push({ id: 'weekday', tone: 'flat', dow: wd.strongest.dow, weakDow: wd.weakest.dow,
        text: name(wd.strongest.dow) + 's are your most consistent (' + wd.strongest.rate + '%). ' + name(wd.weakest.dow) + 's are hardest (' + wd.weakest.rate + '%).' });
    }
    return out;
  }

  /* ---------------- Chart & calendar ---------------- */

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
      var s = summaryOf(state, d);
      var has = s.total > 0;
      out.push({
        date: d,
        percentage: has ? s.percentage : null,
        completed: has ? s.completed : 0,
        total: has ? s.total : 0,
        lockedIn: has ? s.lockedIn : false
      });
    }
    return out;
  }

  /**
   * How a calendar day went: 'locked', 'partial', 'missed', 'none', 'future',
   * or 'pending' for today while nothing is ticked yet (the day isn't over,
   * so it isn't a miss).
   */
  function dayState(state, date, today) {
    if (date > today) return 'future';
    var s = summaryOf(state, date);
    if (!s.total) return 'none';
    if (s.lockedIn) return 'locked';
    if (s.credit > 0) return 'partial';
    return date === today ? 'pending' : 'missed';
  }

  /**
   * Weeks for a month view, starting on `weekStart` (0 = Sunday, default).
   * Each cell: { date, day, inMonth, state, isToday, percentage }.
   */
  function monthGrid(state, year, month, today, weekStart) {
    var first = year + '-' + (month < 10 ? '0' : '') + month + '-01';
    var start = weekStartOf(first, weekStart);
    var lead = core.daysBetween(start, first);
    var dim = core.daysInMonth(year, month);
    var weeks = Math.ceil((lead + dim) / 7);
    var rows = [];
    for (var w = 0; w < weeks; w++) {
      var row = [];
      for (var i = 0; i < 7; i++) {
        var d = core.addDays(start, w * 7 + i);
        var s = summaryOf(state, d);
        row.push({
          date: d,
          day: Number(d.slice(8)),
          inMonth: d.slice(0, 7) === first.slice(0, 7),
          state: dayState(state, d, today),
          isToday: d === today,
          percentage: s.total ? s.percentage : null
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
      focus: state.focus && state.focus[date] ? state.focus[date] : '',
      items: rec ? rec.habits.map(function (h) {
        return { id: h.id, name: h.name, done: rec.done.indexOf(h.id) >= 0, flexible: !!h.flex, workout: h.workout || null,
          progress: core.entryProgress(rec, h), minutes: h.minutes || null, logged: h.minutes ? core.loggedMinutes(rec, h.id) : null };
      }) : []
    };
  }

  return {
    MIN: MIN,
    trackedDays: trackedDays,
    currentStreak: currentStreak,
    bestStreak: bestStreak,
    summary: summary,
    weekStartOf: weekStartOf,
    windowTotals: windowTotals,
    weekOverWeek: weekOverWeek,
    weekdayStrength: weekdayStrength,
    habitStats: habitStats,
    weeklyProgress: weeklyProgress,
    habitGrid: habitGrid,
    insights: insights,
    dailySeries: dailySeries,
    dayState: dayState,
    monthGrid: monthGrid,
    dayDetail: dayDetail
  };
});
