'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../js/storage.js');
const { core, newChallenge, completeDays, FakeStorage } = require('./helpers.js');

const KEY = store.STORAGE_KEY;
const NOW = new Date('2026-09-28T12:00:00Z');
const START = '2026-09-01';

function sampleState() {
  let s = completeDays(newChallenge(START), START, 4);
  s = core.reportFailure(s, '2026-09-05').state;
  return completeDays(s, '2026-09-05', 2);
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
  bad.current.completedDates.push('2026-01-01');
  assert.throws(() => store.save(storage, bad), /invalid/);
  assert.equal(storage.getItem(KEY), before);
});

const MALFORMED = {
  'invalid JSON': '{"schemaVersion": 2, "challenge": ',
  'a JSON string': '"hello"',
  'a JSON array': '[1, 2, 3]',
  'null': 'null',
  'wrong field types': JSON.stringify({ schemaVersion: 2, challenge: 'x', current: 5, attempts: {}, bestStreak: -1 }),
  'an impossible date': (() => {
    const s = newChallenge(START);
    s.current.startDate = '2026-02-30';
    return JSON.stringify(s);
  })(),
  'non-consecutive completed days': (() => {
    const s = completeDays(newChallenge(START), START, 2);
    s.current.completedDates = ['2026-09-01', '2026-09-03'];
    return JSON.stringify(s);
  })(),
  'unknown habit ids': (() => {
    const s = newChallenge(START);
    s.current.checked.habitIds = ['nope'];
    return JSON.stringify(s);
  })(),
  'a bad schemaVersion': JSON.stringify({ schemaVersion: 'two' })
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

/* ---------------- migration ---------------- */

const V1 = {
  challengeName: '75 Hard',
  habits: ['Workout', 'Read', 'Water'],
  startDate: '2026-09-20',
  completedDays: ['2026-09-21', '2026-09-20'],
  checkedToday: { date: '2026-09-22', habits: [0, 2, 9] },
  history: [
    { start: '2026-08-01', end: '2026-08-12', days: 12, reason: 'missed' },
    { start: '2026-08-14', end: '2026-08-15', days: 2, reason: 'failed' }
  ],
  best: 12
};

test('migrates unversioned (v1) data to the current schema', () => {
  const r = core.migrate(V1);
  assert.equal(r.ok, true);
  assert.equal(r.fromVersion, 1);
  assert.equal(r.migrated, true);
  const s = r.state;
  assert.equal(s.schemaVersion, core.SCHEMA_VERSION);
  assert.equal(s.challenge.name, '75 Hard');
  assert.equal(s.challenge.targetDays, 75);
  assert.deepEqual(s.challenge.habits, [
    { id: 'h1', name: 'Workout' },
    { id: 'h2', name: 'Read' },
    { id: 'h3', name: 'Water' }
  ]);
  assert.deepEqual(s.current.completedDates, ['2026-09-20', '2026-09-21']);
  assert.deepEqual(s.current.checked, { date: '2026-09-22', habitIds: ['h1', 'h3'] });
  assert.equal(s.current.number, 3);
  assert.equal(s.attempts.length, 2);
  assert.equal(s.attempts[1].reason, 'failed');
  assert.equal(core.bestStreak(s), 12);
  assert.deepEqual(core.validateState(s), []);
});

test('load migrates v1 localStorage data, keeps a backup and saves the upgrade', () => {
  const raw = JSON.stringify(V1);
  const storage = new FakeStorage({ [KEY]: raw });
  const r = store.load(storage, NOW);
  assert.equal(r.notice, null);
  assert.equal(r.state.challenge.name, '75 Hard');
  assert.equal(JSON.parse(storage.getItem(KEY)).schemaVersion, core.SCHEMA_VERSION);
  const backups = storage.keys().filter((k) => k.startsWith(store.BACKUP_PREFIX + 'v1.'));
  assert.equal(backups.length, 1);
  assert.equal(storage.getItem(backups[0]), raw);
  // Loading again is a no-op.
  const again = store.load(storage, NOW);
  assert.deepEqual(again.state, r.state);
  assert.equal(storage.keys().length, 2);
});

test('an empty v1 object migrates to an empty state', () => {
  const r = core.migrate({});
  assert.equal(r.ok, true);
  assert.deepEqual(r.state, core.emptyState());
});

test('damaged v1 data is rejected rather than half-migrated', () => {
  const r = core.migrate({ challengeName: 'x', habits: ['a'], startDate: 'yesterday', completedDays: [] });
  assert.equal(r.ok, false);
});

/* ---------------- export / import ---------------- */

test('export contains schemaVersion and the complete history', () => {
  const s = sampleState();
  const doc = core.buildExport(s, NOW);
  assert.equal(doc.app, 'day-by-day');
  assert.equal(doc.schemaVersion, core.SCHEMA_VERSION);
  assert.equal(doc.exportedAt, NOW.toISOString());
  assert.deepEqual(doc.challenge, s.challenge);
  assert.deepEqual(doc.current, s.current);
  assert.deepEqual(doc.attempts, s.attempts);
  assert.equal(doc.bestStreak, 4);
  assert.equal(core.exportFileName('2026-09-28'), 'day-by-day-backup-2026-09-28.json');
});

test('export then import round-trips', () => {
  const s = sampleState();
  const r = core.parseImport(JSON.stringify(core.buildExport(s, NOW)));
  assert.equal(r.ok, true);
  assert.deepEqual(r.state, s);
});

const BAD_IMPORTS = {
  'an empty file': ['', /empty/],
  'invalid JSON': ['{ nope', /not valid JSON/],
  'an array': ['[]', /not contain/],
  'another app': [JSON.stringify({ app: 'other', schemaVersion: 2 }), /not exported from Day by Day/],
  'no schemaVersion': [JSON.stringify({ challenge: null }), /schemaVersion/],
  'a future schemaVersion': [JSON.stringify({ app: 'day-by-day', schemaVersion: 99 }), /version 99/],
  'a damaged history': [
    JSON.stringify(Object.assign(core.buildExport(newChallenge(START), NOW), { attempts: [{ number: 1 }] })),
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
  // The app only calls store.save() after parseImport succeeds and the user
  // confirms; this checks the pieces it relies on.
  const storage = new FakeStorage();
  const s = sampleState();
  store.save(storage, s);
  const before = storage.getItem(KEY);
  for (const [text] of Object.values(BAD_IMPORTS)) {
    const r = core.parseImport(text);
    assert.equal(r.ok, false);
    assert.throws(() => store.save(storage, r.state || {}));
  }
  assert.equal(storage.getItem(KEY), before);
});

test('importing a v1 file with a schemaVersion of 1 is migrated', () => {
  const r = core.parseImport(JSON.stringify(Object.assign({ schemaVersion: 1 }, V1)));
  assert.equal(r.ok, true);
  assert.equal(r.state.challenge.name, '75 Hard');
});
