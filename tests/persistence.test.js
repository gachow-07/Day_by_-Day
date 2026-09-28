'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../js/storage.js');
const { core, stats, withHabits, play, FakeStorage, v2Doc } = require('./helpers.js');

const KEY = store.STORAGE_KEY;
const NOW = new Date('2026-09-28T12:00:00Z');
const START = '2026-09-01';

function sampleState() {
  let s = play(withHabits(START), START, '✓✓✓½✓');
  s = core.addHabit(s, 'Stretch', '2026-09-05').state;
  return core.setHabitStatus(s, 'h1', 'archived', '2026-09-05').state;
}

/* ---------------- storage ---------------- */

test('load returns an empty state when nothing is saved', () => {
  const r = store.load(new FakeStorage(), NOW);
  assert.deepEqual(r.state, core.emptyState());
  assert.equal(r.notice, null);
  assert.equal(r.readOnly, false);
});

test('save then load round-trips the state', () => {
  const storage = new FakeStorage();
  const s = sampleState();
  store.save(storage, s);
  assert.equal(JSON.parse(storage.getItem(KEY)).schemaVersion, core.SCHEMA_VERSION);
  assert.deepEqual(store.load(storage, NOW).state, s);
});

test('save refuses invalid state and leaves stored data alone', () => {
  const storage = new FakeStorage();
  const good = sampleState();
  store.save(storage, good);
  const before = storage.getItem(KEY);
  const bad = JSON.parse(JSON.stringify(good));
  bad.days['2026-09-02'].done.push('nope');
  assert.throws(() => store.save(storage, bad), /invalid/);
  assert.equal(storage.getItem(KEY), before);
});

const MALFORMED = {
  'invalid JSON': '{"schemaVersion": 3, "habits": ',
  'a JSON string': '"hello"',
  'a JSON array': '[1, 2, 3]',
  'null': 'null',
  'wrong field types': JSON.stringify({ schemaVersion: 3, habits: 'x', days: [] }),
  'an impossible date key': (() => {
    const s = withHabits(START);
    s.days['2026-02-30'] = s.days[START];
    return JSON.stringify(s);
  })(),
  'a record naming an unknown habit': (() => {
    const s = withHabits(START);
    s.days[START].habits.push({ id: 'ghost', name: 'Ghost' });
    return JSON.stringify(s);
  })(),
  'a duplicate habit id': (() => {
    const s = withHabits(START);
    s.habits.push(Object.assign({}, s.habits[0]));
    return JSON.stringify(s);
  })(),
  'an invalid habit status': (() => {
    const s = withHabits(START);
    s.habits[0].status = 'sleeping';
    return JSON.stringify(s);
  })(),
  'an archived habit without a date': (() => {
    const s = withHabits(START);
    s.habits[0].status = 'archived';
    return JSON.stringify(s);
  })(),
  'a completed habit that is not required that day': (() => {
    const s = withHabits(START);
    s.days[START].done = ['h1', 'h1'];
    return JSON.stringify(s);
  })(),
  'damaged old challenge data': JSON.stringify(v2Doc({ current: { number: 1, startDate: START, status: 'active', completedDates: ['2026-09-01', '2026-09-03'], checked: { date: START, habitIds: [] } } })),
  'a bad schemaVersion': JSON.stringify({ schemaVersion: 'three' })
};

for (const [label, raw] of Object.entries(MALFORMED)) {
  test('malformed saved data (' + label + ') is backed up and does not crash', () => {
    const storage = new FakeStorage({ [KEY]: raw });
    const r = store.load(storage, NOW);
    assert.deepEqual(r.state, core.emptyState());
    assert.equal(r.readOnly, false);
    assert.match(r.notice, /could not be read|damaged/);
    const backups = storage.keys().filter((k) => k.startsWith(store.BACKUP_PREFIX));
    assert.equal(backups.length, 1);
    assert.equal(storage.getItem(backups[0]), raw, 'original text is preserved');
    assert.equal(storage.getItem(KEY), raw, 'nothing is written over the original on load');
  });
}

test('malformed data that cannot be backed up is left untouched and saving is disabled', () => {
  const storage = new FakeStorage({ [KEY]: '{broken' });
  storage.failWrites = true;
  const r = store.load(storage, NOW);
  assert.equal(r.readOnly, true);
  assert.equal(storage.getItem(KEY), '{broken');
});

test('data from a newer schema version is not modified', () => {
  const raw = JSON.stringify({ schemaVersion: core.SCHEMA_VERSION + 1, whatever: true });
  const storage = new FakeStorage({ [KEY]: raw });
  const r = store.load(storage, NOW);
  assert.equal(r.readOnly, true);
  assert.match(r.notice, /version/);
  assert.equal(storage.getItem(KEY), raw);
  assert.equal(storage.keys().length, 1);
});

test('blocked storage is reported instead of crashing', () => {
  const storage = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); } };
  const r = store.load(storage, NOW);
  assert.equal(r.readOnly, true);
  assert.match(r.notice, /storage/);
});

/* ---------------- migration from the challenge format ---------------- */

test('challenge data (v2) becomes ongoing habits with day-by-day history', () => {
  const r = core.migrate(v2Doc());
  assert.equal(r.ok, true, r.message);
  assert.equal(r.fromVersion, 2);
  const s = r.state;
  assert.deepEqual(s.habits, [
    { id: 'h1', name: 'Workout', createdOn: '2026-09-01', status: 'active', archivedOn: null, icon: null, color: null, schedule: { type: 'daily' }, reminder: null },
    { id: 'h2', name: 'Read', createdOn: '2026-09-01', status: 'active', archivedOn: null, icon: null, color: null, schedule: { type: 'daily' }, reminder: null }
  ]);
  // Attempt 1: Sep 1–3 done, Sep 4 missed; attempt 2 began Sep 5: Sep 5–6 done; Sep 7 half-done.
  assert.deepEqual(Object.keys(s.days).sort(), ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07']);
  const states = Object.keys(s.days).sort().map((d) => stats.dayState(s, d, '2026-09-07'));
  assert.deepEqual(states, ['locked', 'locked', 'locked', 'missed', 'locked', 'locked', 'partial']);
  assert.deepEqual(s.days['2026-09-07'].done, ['h2'], 'today’s ticks carry over');
  const sum = stats.summary(s, '2026-09-07');
  assert.equal(sum.bestStreak, 3, 'old best streak is recovered from history');
  assert.equal(sum.currentStreak, 2);
  assert.equal(sum.totalLockedInDays, 5);
});

test('a v2 attempt that ended in a reported failure keeps its completed days', () => {
  const doc = v2Doc({
    attempts: [{ number: 1, startDate: '2026-09-01', endDate: '2026-09-02', daysCompleted: 2, reason: 'failed', endedOn: '2026-09-03' }],
    current: { number: 2, startDate: '2026-09-03', status: 'active', completedDates: [], checked: { date: '2026-09-03', habitIds: [] } }
  });
  const s = core.migrate(doc).state;
  assert.deepEqual(Object.keys(s.days).sort().map((d) => stats.dayState(s, d, '2026-09-10')), ['locked', 'locked', 'missed']);
});

test('an empty v2 state migrates to an empty tracker', () => {
  const r = core.migrate({ schemaVersion: 2, challenge: null, current: null, attempts: [], bestStreak: 0 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.state, core.emptyState());
});

test('load migrates v2 localStorage data, keeps a backup and saves the upgrade', () => {
  const raw = JSON.stringify(v2Doc());
  const storage = new FakeStorage({ [KEY]: raw });
  const r = store.load(storage, NOW);
  assert.equal(r.notice, null);
  assert.equal(r.state.habits.length, 2);
  assert.equal(JSON.parse(storage.getItem(KEY)).schemaVersion, core.SCHEMA_VERSION);
  const backups = storage.keys().filter((k) => k.startsWith(store.BACKUP_PREFIX + 'v2.'));
  assert.equal(backups.length, 1);
  assert.equal(storage.getItem(backups[0]), raw);
  assert.deepEqual(store.load(storage, NOW).state, r.state, 'loading again is a no-op');
  assert.equal(storage.keys().length, 2);
});

const V1 = {
  challengeName: '75 Hard',
  habits: ['Workout', 'Read', 'Water'],
  startDate: '2026-09-20',
  completedDays: ['2026-09-21', '2026-09-20'],
  checkedToday: { date: '2026-09-22', habits: [0, 2, 9] },
  history: [{ start: '2026-08-01', end: '2026-08-12', days: 12, reason: 'missed' }],
  best: 12
};

test('unversioned (v1) data upgrades all the way to the current schema', () => {
  const r = core.migrate(V1);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.fromVersion, 1);
  const s = r.state;
  assert.deepEqual(s.habits.map((h) => h.name), ['Workout', 'Read', 'Water']);
  assert.deepEqual(s.days['2026-09-22'].done, ['h1', 'h3']);
  assert.equal(stats.bestStreak(s, '2026-09-22'), 12);
  assert.equal(s.days['2026-08-13'].done.length, 0, 'the gap between attempts is recorded as missed');
});

test('damaged v1 data is rejected rather than half-migrated', () => {
  assert.equal(core.migrate({ challengeName: 'x', habits: ['a'], startDate: 'yesterday', completedDays: [] }).ok, false);
});

/* ---------------- export / import ---------------- */

test('export contains schemaVersion, the full history and computed stats', () => {
  const s = sampleState();
  const today = '2026-09-05';
  const doc = core.buildExport(s, NOW, stats.summary(s, today));
  assert.equal(doc.app, 'day-by-day');
  assert.equal(doc.schemaVersion, core.SCHEMA_VERSION);
  assert.equal(doc.exportedAt, NOW.toISOString());
  assert.deepEqual(doc.habits, s.habits);
  assert.deepEqual(doc.days, s.days);
  assert.equal(doc.dailyRecords.length, 5);
  assert.deepEqual(doc.dailyRecords[3], {
    date: '2026-09-04',
    habits: [{ id: 'h1', name: 'Workout', done: true }, { id: 'h2', name: 'Read', done: false }, { id: 'h3', name: 'Drink water', done: false }],
    totalCompleted: 1,
    totalPossible: 3,
    percentage: 33,
    lockedIn: false
  });
  assert.equal(doc.stats.bestStreak, 3);
  assert.equal(doc.stats.totalLockedInDays, 3);
  assert.equal(core.exportFileName('2026-09-28'), 'day-by-day-backup-2026-09-28.json');
});

test('export then import round-trips (computed fields are ignored)', () => {
  const s = sampleState();
  const r = core.parseImport(JSON.stringify(core.buildExport(s, NOW, stats.summary(s, '2026-09-05'))));
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(r.state, s);
});

test('old challenge backups can still be imported', () => {
  const r = core.parseImport(JSON.stringify(Object.assign({ app: 'day-by-day', exportedAt: NOW.toISOString() }, v2Doc())));
  assert.equal(r.ok, true, r.message);
  assert.equal(r.state.habits.length, 2);
});

const BAD_IMPORTS = {
  'an empty file': ['', /empty/],
  'invalid JSON': ['{ nope', /not valid JSON/],
  'an array': ['[]', /not contain/],
  'another app': [JSON.stringify({ app: 'other', schemaVersion: 3 }), /not exported from Day by Day/],
  'no schemaVersion': [JSON.stringify({ habits: [] }), /schemaVersion/],
  'a future schemaVersion': [JSON.stringify({ app: 'day-by-day', schemaVersion: 99 }), /version 99/],
  'damaged history': [
    JSON.stringify(Object.assign(core.buildExport(withHabits(START), NOW), { days: { [START]: { habits: [], done: ['h1'] } } })),
    /damaged/
  ]
};

for (const [label, [text, message]] of Object.entries(BAD_IMPORTS)) {
  test('import rejects ' + label + ' with a useful message', () => {
    const r = core.parseImport(text);
    assert.equal(r.ok, false);
    assert.match(r.message, message);
  });
}

test('a failed import leaves existing stored data untouched', () => {
  const storage = new FakeStorage();
  store.save(storage, sampleState());
  const before = storage.getItem(KEY);
  for (const [text] of Object.values(BAD_IMPORTS)) {
    const r = core.parseImport(text);
    assert.equal(r.ok, false);
    assert.throws(() => store.save(storage, r.state || {}));
  }
  assert.equal(storage.getItem(KEY), before);
});

/* ---------------- schema 3 -> 4 ---------------- */

/** A schema-3 document, as the previous version of the app saved it. */
function v3Doc() {
  return {
    schemaVersion: 3,
    habits: [
      { id: 'h1', name: 'Workout', createdOn: '2026-09-01', status: 'active', archivedOn: null },
      { id: 'h2', name: 'Read', createdOn: '2026-09-01', status: 'archived', archivedOn: '2026-09-04' }
    ],
    days: {
      '2026-09-01': { habits: [{ id: 'h1', name: 'Workout' }, { id: 'h2', name: 'Read' }], done: ['h1', 'h2'] },
      '2026-09-02': { habits: [{ id: 'h1', name: 'Workout' }, { id: 'h2', name: 'Read' }], done: ['h1', 'h2'] },
      '2026-09-03': { habits: [{ id: 'h1', name: 'Workout' }, { id: 'h2', name: 'Read' }], done: ['h1'] },
      '2026-09-04': { habits: [{ id: 'h1', name: 'Workout' }], done: ['h1'] }
    }
  };
}

test('schema 3 data upgrades to 4 without changing any record or statistic', () => {
  const old = v3Doc();
  const r = core.migrate(old);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.fromVersion, 3);
  assert.equal(r.state.schemaVersion, 4);
  assert.deepEqual(r.state.days, old.days, 'daily records are untouched');
  assert.deepEqual(r.state.habits.map((h) => [h.id, h.name, h.status, h.archivedOn]), [['h1', 'Workout', 'active', null], ['h2', 'Read', 'archived', '2026-09-04']]);
  assert.ok(r.state.habits.every((h) => h.schedule.type === 'daily' && h.icon === null && h.color === null && h.reminder === null));
  assert.deepEqual(r.state.focus, {});
  assert.deepEqual(r.state.settings, { weekStart: 0 });
  const sum = stats.summary(r.state, '2026-09-04');
  assert.deepEqual([sum.currentStreak, sum.bestStreak, sum.totalLockedInDays, sum.completionRate], [1, 2, 3, Math.round(6 / 7 * 100)]);
});

test('load upgrades schema 3 localStorage data and keeps a backup', () => {
  const raw = JSON.stringify(v3Doc());
  const storage = new FakeStorage({ [KEY]: raw });
  const r = store.load(storage, NOW);
  assert.equal(r.notice, null);
  assert.equal(JSON.parse(storage.getItem(KEY)).schemaVersion, 4);
  const backup = storage.keys().find((k) => k.startsWith(store.BACKUP_PREFIX + 'v3.'));
  assert.equal(storage.getItem(backup), raw);
});

test('schema 3 backups can still be imported', () => {
  const r = core.parseImport(JSON.stringify(Object.assign({ app: 'day-by-day' }, v3Doc())));
  assert.equal(r.ok, true, r.message);
  assert.equal(r.state.schemaVersion, 4);
});

const BAD_V4 = {
  'an unknown colour': (s) => { s.habits[0].color = 'plaid'; },
  'a bad icon name': (s) => { s.habits[0].icon = '<script>'; },
  'a bad schedule': (s) => { s.habits[0].schedule = { type: 'days', days: [] }; },
  'a bad reminder': (s) => { s.habits[0].reminder = '25:99'; },
  'a bad flex flag': (s) => { s.days[START].habits[0].flex = 'yes'; },
  'a flex goal without a target': (s) => { s.days[START].habits[0].flex = true; },
  'an over-long focus': (s) => { s.focus[START] = 'x'.repeat(141); },
  'a bad week start': (s) => { s.settings.weekStart = 3; }
};

for (const [label, mutate] of Object.entries(BAD_V4)) {
  test('validation rejects ' + label, () => {
    const s = withHabits(START);
    assert.deepEqual(core.validateState(s), []);
    mutate(s);
    assert.ok(core.validateState(s).length > 0);
  });
}

test('export and import round-trip goal details, focus and settings', () => {
  let s = withHabits(START, ['Run']);
  s = core.updateHabit(s, 'h1', { icon: 'footprints', color: 'sky', schedule: { type: 'days', days: [1, 3, 5] }, reminder: '07:30' }, START).state;
  s = core.setFocus(s, 'Deep work before noon', START).state;
  s = core.setWeekStart(s, 1).state;
  const doc = core.buildExport(s, NOW, stats.summary(s, START));
  assert.equal(doc.focus[START], 'Deep work before noon');
  assert.equal(doc.settings.weekStart, 1);
  const r = core.parseImport(JSON.stringify(doc));
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(r.state, s);
});
