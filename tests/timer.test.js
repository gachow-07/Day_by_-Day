'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { core, stats, withHabits, openOn } = require('./helpers.js');

const MON = '2026-09-07';
const TUE = '2026-09-08';
const MIN = 60000;
const T0 = Date.UTC(2026, 8, 7, 14, 0, 0); // Monday 14:00

function study(date, goal) {
  const s = withHabits(date, ['Study', 'Read']);
  return core.updateHabit(s, 'h1', { amount: { unit: 'min', goal: goal || 120 } }, date).state;
}

const logged = (s, date) => core.loggedAmount(s.days[date], 'h1');

test('elapsed time comes from timestamps, with pauses taken out', () => {
  let s = core.startTimer(study(MON), 'h1', MON, T0).state;
  assert.deepEqual(s.timer, { habitId: 'h1', date: MON, startedAt: T0, pausedAt: null, pausedMs: 0, mode: 'free', logged: 0, checkAt: 180 });
  assert.equal(core.timerStatus(s.timer, T0 + 24 * MIN + 13000).elapsedMs, 24 * MIN + 13000);
  s = core.pauseTimer(s, T0 + 10 * MIN).state;
  assert.equal(core.timerStatus(s.timer, T0 + 60 * MIN).elapsedMs, 10 * MIN, 'nothing counts while paused');
  assert.equal(core.pauseTimer(s, T0 + 11 * MIN).unchanged, true);
  s = core.resumeTimer(s, T0 + 30 * MIN).state;
  assert.equal(s.timer.pausedMs, 20 * MIN);
  assert.equal(core.timerStatus(s.timer, T0 + 45 * MIN).elapsedMs, 25 * MIN);
  // Survives a save and reload: it's plain data
  const reloaded = core.migrate(JSON.parse(JSON.stringify(s))).state;
  assert.equal(core.timerStatus(reloaded.timer, T0 + 45 * MIN).elapsedMs, 25 * MIN);
});

test('stop logs the rounded minutes through the normal log', () => {
  let s = core.startTimer(study(MON), 'h1', MON, T0).state;
  const r = core.stopTimer(s, T0 + 24 * MIN + 29000);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.minutes, 24);
  assert.equal(r.state.timer, null);
  assert.deepEqual(r.state.days[MON].logs, { h1: [24] });
  assert.equal(core.stopTimer(core.startTimer(study(MON), 'h1', MON, T0).state, T0 + 24 * MIN + 30000).minutes, 25, 'rounds to nearest');
  // and undo works like any log
  assert.equal(core.undoLog(r.state, 'h1', MON).state.days[MON].logs, undefined);
});

test('sessions under a minute are skipped', () => {
  const s = core.startTimer(study(MON), 'h1', MON, T0).state;
  const r = core.stopTimer(s, T0 + 59000);
  assert.equal(r.skipped, true);
  assert.equal(r.minutes, 0);
  assert.equal(r.state.timer, null);
  assert.equal(r.state.days[MON].logs, undefined);
});

test('reaching the goal through the timer counts like a manual log', () => {
  let s = core.logAmount(study(MON, 60), 'h1', 30, MON).state;
  s = core.startTimer(s, 'h1', MON, T0).state;
  const r = core.stopTimer(s, T0 + 31 * MIN);
  assert.equal(r.done, true);
  assert.deepEqual(r.state.days[MON].done, ['h1']);
  assert.equal(core.recordSummary(r.state.days[MON]).credit, 1);
});

test('a session past midnight is logged to the day it started', () => {
  let s = core.startTimer(study(MON), 'h1', MON, Date.UTC(2026, 8, 7, 23, 30)).state;
  s = openOn(s, TUE);
  assert.equal(s.timer.date, MON, 'the new day does not move the timer');
  const r = core.stopTimer(s, Date.UTC(2026, 8, 8, 0, 20));
  assert.equal(r.minutes, 50);
  assert.equal(r.date, MON);
  assert.equal(logged(r.state, MON), 50);
  assert.equal(logged(r.state, TUE), 0);
});

test('only one timer at a time, and only for time goals', () => {
  const s = core.startTimer(study(MON), 'h1', MON, T0).state;
  assert.equal(core.startTimer(s, 'h1', MON, T0 + 1000).error, 'busy');
  assert.equal(core.startTimer(study(MON), 'h2', MON, T0).error, 'not-timed');
  const water = core.updateHabit(study(MON), 'h2', { amount: { unit: 'ml', goal: 2000 } }, MON).state;
  assert.equal(core.startTimer(water, 'h2', MON, T0).error, 'not-timed');
  assert.equal(core.startTimer(study(MON), 'h1', TUE, T0).error, 'not-timed', 'must be on that day');
});

test('focus mode: 25 min focus, 5 min break, each block logged once', () => {
  let s = core.startTimer(study(MON), 'h1', MON, T0, 'focus').state;
  let st = core.timerStatus(s.timer, T0 + 10 * MIN);
  assert.equal(st.phase, 'focus');
  assert.equal(st.phaseLeftMs, 15 * MIN);
  assert.equal(core.timerCatchUp(s, T0 + 24 * MIN).blocks, 0);
  let r = core.timerCatchUp(s, T0 + 26 * MIN);
  assert.equal(r.blocks, 1);
  assert.equal(r.minutes, 25);
  assert.equal(r.phase, 'break');
  s = r.state;
  assert.equal(logged(s, MON), 25);
  assert.equal(core.timerCatchUp(s, T0 + 28 * MIN).blocks, 0, 'not logged twice');
  st = core.timerStatus(s.timer, T0 + 28 * MIN);
  assert.equal(st.phase, 'break');
  assert.equal(st.phaseLeftMs, 2 * MIN);
  assert.equal(st.unloggedMs, 0, 'breaks do not count');
  // After a long absence it catches up block by block
  r = core.timerCatchUp(s, T0 + 95 * MIN);                  // 3 cycles + 5 min into the 4th
  assert.equal(r.blocks, 2);
  s = r.state;
  assert.equal(logged(s, MON), 75);
  // Stopping mid-block logs just the partial focus time
  const stop = core.stopTimer(s, T0 + 102 * MIN);            // 12 min into block 4
  assert.equal(stop.minutes, 12);
  assert.equal(logged(stop.state, MON), 87);
});

test('after 3 hours, nothing more is logged until "Still studying?" is answered', () => {
  let s = core.startTimer(study(MON, 600), 'h1', MON, T0, 'focus').state;
  // 4 h in: 8 blocks finished, but only 7 fit before the 3 h check (175 min)
  let r = core.timerCatchUp(s, T0 + 240 * MIN);
  assert.equal(r.blocks, 7);
  s = r.state;
  assert.equal(core.timerStatus(s.timer, T0 + 240 * MIN).needsCheck, true);
  assert.equal(core.timerCatchUp(s, T0 + 241 * MIN).blocks, 0);
  s = core.confirmTimer(s, T0 + 241 * MIN).state;
  assert.equal(core.timerStatus(s.timer, T0 + 241 * MIN).needsCheck, false);
  assert.equal(core.timerCatchUp(s, T0 + 241 * MIN).blocks, 1, 'the waiting block is logged after yes');
  // A free timer past 3 h: the app asks, and can log an edited amount
  let f = core.startTimer(study(MON), 'h1', MON, T0).state;
  assert.equal(core.timerStatus(f.timer, T0 + 200 * MIN).needsCheck, true);
  const edited = core.stopTimer(f, T0 + 200 * MIN, 90);
  assert.equal(edited.minutes, 90);
  assert.equal(core.stopTimer(f, T0 + 200 * MIN, -5).ok, false);
});

test('a day never goes over 24 hours of logged time', () => {
  let s = core.logAmount(study(MON, 1440), 'h1', 1430, MON).state;
  s = core.startTimer(s, 'h1', MON, T0).state;
  const r = core.stopTimer(s, T0 + 60 * MIN);
  assert.equal(r.minutes, 10);
  assert.equal(logged(r.state, MON), 1440);
});

test('the timer is validated, cleared with its goal, migrated and exported', () => {
  const s = core.startTimer(study(MON), 'h1', MON, T0).state;
  assert.deepEqual(core.validateState(s), []);
  for (const bad of [{ mode: 'pomodoro' }, { habitId: 'h9' }, { pausedAt: T0 - 1 }, { checkAt: 10 }, { extra: 1 }]) {
    const b = JSON.parse(JSON.stringify(s));
    Object.assign(b.timer, bad);
    assert.match(core.validateState(b).join(' '), /timer is invalid/, JSON.stringify(bad));
  }
  const fresh = core.addHabit(core.emptyState(), 'Typo', MON, { amount: { unit: 'min', goal: 30 } }).state;
  const timed = core.startTimer(fresh, 'h1', MON, T0).state;
  assert.equal(core.deleteHabit(timed, 'h1', MON).state.timer, null);
  const v7 = JSON.parse(JSON.stringify(study(MON)));
  v7.schemaVersion = 7;
  delete v7.timer;
  const m = core.migrate(v7);
  assert.equal(m.ok, true, m.message);
  assert.equal(m.state.timer, null);
  const back = core.parseImport(JSON.stringify(core.buildExport(s, new Date())));
  assert.equal(back.ok, true, back.message);
  assert.deepEqual(back.state.timer, s.timer);
  assert.equal(stats.summary(s, MON).totalTrackedDays, 1);
});
