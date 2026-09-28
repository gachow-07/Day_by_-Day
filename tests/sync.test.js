'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sync = require('../js/sync.js');
const { core, withHabits, openOn, play, FakeStorage, v2Doc } = require('./helpers.js');

const UID = 'user-a';
const START = '2026-09-01';
const EMPTY = core.emptyState();

function remoteOf(state, revision, clientUpdatedAt) {
  return sync.fromRemoteDoc(Object.assign(sync.toRemoteDoc(state, revision, new Date(clientUpdatedAt || '2026-09-10T10:00:00Z'))));
}

const threeDays = play(withHabits(START), START, '✓✓✓');
const fiveDays = play(threeDays, '2026-09-04', '✓✓');
const otherChallenge = play(withHabits(START, ['Something else']), START, '✓');

/* ---------------- metadata ---------------- */

test('sync metadata defaults safely and survives damaged storage', () => {
  assert.deepEqual(sync.readMeta(new FakeStorage()), sync.emptyMeta());
  assert.deepEqual(sync.readMeta(new FakeStorage({ [sync.META_KEY]: '{bad' })), sync.emptyMeta());
  assert.deepEqual(sync.normalizeMeta({ uid: 5, revision: -1, dirty: 'yes' }), sync.emptyMeta());
  const storage = new FakeStorage();
  const meta = sync.markDirty(sync.markSynced(sync.emptyMeta(), UID, 4), new Date('2026-09-10T00:00:00Z'));
  sync.writeMeta(storage, meta);
  assert.deepEqual(sync.readMeta(storage), { uid: UID, revision: 4, dirty: true, changedAt: '2026-09-10T00:00:00.000Z' });
});

/* ---------------- account documents ---------------- */

test('account documents round-trip and keep schemaVersion', () => {
  const doc = sync.toRemoteDoc(fiveDays, 7, new Date('2026-09-05T08:00:00Z'));
  assert.equal(doc.schemaVersion, core.SCHEMA_VERSION);
  assert.equal(doc.revision, 7);
  assert.equal(doc.clientUpdatedAt, '2026-09-05T08:00:00.000Z');
  const back = sync.fromRemoteDoc(JSON.parse(JSON.stringify(doc)));
  assert.equal(back.ok, true);
  assert.deepEqual(back.state, fiveDays);
  assert.equal(back.revision, 7);
});

test('missing, damaged and newer account documents are recognised', () => {
  assert.deepEqual(sync.fromRemoteDoc(null), { exists: false });
  assert.equal(sync.fromRemoteDoc({ revision: 1 }).ok, false);
  const broken = sync.toRemoteDoc(threeDays, 1);
  broken.state.days['2026-09-01'].done = ['nobody'];
  assert.match(sync.fromRemoteDoc(broken).message, /damaged/);
  const newer = { state: { schemaVersion: 99 }, revision: 1 };
  assert.match(sync.fromRemoteDoc(newer).message, /newer version/);
});

/* ---------------- decisions ---------------- */

test('first sign-in uploads this device’s progress to an empty account', () => {
  const d = sync.decide({ local: threeDays, meta: sync.emptyMeta(), remote: { exists: false }, uid: UID });
  assert.equal(d.action, 'upload');
  assert.equal(d.reason, 'first-sign-in');
});

test('first sign-in with nothing anywhere does nothing', () => {
  assert.equal(sync.decide({ local: EMPTY, meta: sync.emptyMeta(), remote: { exists: false }, uid: UID }).action, 'none');
});

test('signing in on a fresh device downloads the account’s progress', () => {
  const d = sync.decide({ local: EMPTY, meta: sync.emptyMeta(), remote: remoteOf(fiveDays, 3), uid: UID });
  assert.equal(d.action, 'download');
  assert.equal(d.revision, 3);
  assert.equal(d.backupLocal, undefined);
});

test('an empty account copy is replaced by this device’s progress', () => {
  const d = sync.decide({ local: threeDays, meta: sync.emptyMeta(), remote: remoteOf(EMPTY, 2), uid: UID });
  assert.equal(d.action, 'upload');
});

test('different progress on a new device: the account wins and this device is backed up', () => {
  const d = sync.decide({ local: otherChallenge, meta: sync.emptyMeta(), remote: remoteOf(fiveDays, 3), uid: UID });
  assert.equal(d.action, 'download');
  assert.equal(d.backupLocal, true);
});

test('identical copies need no transfer', () => {
  const d = sync.decide({ local: fiveDays, meta: sync.emptyMeta(), remote: remoteOf(fiveDays, 9), uid: UID });
  assert.deepEqual(d, { action: 'none', revision: 9 });
});

test('local changes since the last sync are uploaded', () => {
  const meta = sync.markDirty(sync.markSynced(sync.emptyMeta(), UID, 4));
  const d = sync.decide({ local: fiveDays, meta, remote: remoteOf(threeDays, 4), uid: UID });
  assert.equal(d.action, 'upload');
});

test('changes from another device are downloaded when this device has none', () => {
  const meta = sync.markSynced(sync.emptyMeta(), UID, 4);
  const d = sync.decide({ local: threeDays, meta, remote: remoteOf(fiveDays, 5), uid: UID });
  assert.equal(d.action, 'download');
  assert.equal(d.revision, 5);
  assert.equal(d.backupLocal, undefined);
});

test('a device that is behind and only auto-restarted takes the account’s newer progress', () => {
  // Device B last synced at 3 days, then sat unused; opening it restarts
  // the attempt locally. That automatic restart is not a user change, so
  // it must not beat device A's real progress.
  const stale = openOn(threeDays, '2026-09-06'); // back-fills Sep 4–5 as missed
  const meta = sync.markSynced(sync.emptyMeta(), UID, 4);
  const d = sync.decide({ local: stale, meta, remote: remoteOf(fiveDays, 6), uid: UID });
  assert.equal(d.action, 'download');
});

test('conflicting changes: the newer change wins, and a losing device copy is backed up', () => {
  const meta = sync.markDirty(sync.markSynced(sync.emptyMeta(), UID, 4), new Date('2026-09-10T12:00:00Z'));
  const older = sync.decide({ local: otherChallenge, meta, remote: remoteOf(fiveDays, 5, '2026-09-10T09:00:00Z'), uid: UID });
  assert.equal(older.action, 'upload');
  assert.equal(older.reason, 'conflict-local-newer');
  const newer = sync.decide({ local: otherChallenge, meta, remote: remoteOf(fiveDays, 5, '2026-09-10T15:00:00Z'), uid: UID });
  assert.equal(newer.action, 'download');
  assert.equal(newer.backupLocal, true);
});

test('an unreadable account copy is never overwritten', () => {
  const meta = sync.markDirty(sync.markSynced(sync.emptyMeta(), UID, 4));
  for (const doc of [{ state: { schemaVersion: 99 }, revision: 9 }, { state: 'nope' }]) {
    const d = sync.decide({ local: fiveDays, meta, remote: sync.fromRemoteDoc(doc), uid: UID });
    assert.equal(d.action, 'blocked');
    assert.ok(d.message);
  }
});

test('an account still holding old challenge data is upgraded on download', () => {
  const remote = sync.fromRemoteDoc({ schemaVersion: 2, state: v2Doc(), revision: 3, clientUpdatedAt: '' });
  assert.equal(remote.ok, true, remote.message);
  assert.equal(remote.state.schemaVersion, core.SCHEMA_VERSION);
  const d = sync.decide({ local: EMPTY, meta: sync.emptyMeta(), remote, uid: UID });
  assert.equal(d.action, 'download');
});
