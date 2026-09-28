/*
 * Day by Day — cloud sync decisions.
 *
 * Pure functions that decide what to do when the signed-in account's copy
 * and this device's copy differ. The Firebase wiring lives in cloud.js; this
 * file never touches the network, so every rule here is unit tested.
 *
 * Model
 *   - This device's localStorage copy is always the working copy, so the app
 *     works offline.
 *   - The account copy is one Firestore document with a `revision` counter
 *     that goes up by one on every write.
 *   - Sync metadata stored on this device records which account and which
 *     revision the local copy was last in step with, and whether the user has
 *     changed it since ("dirty").
 */
(function (root, factory) {
  'use strict';
  var core = typeof module === 'object' && module.exports ? require('./core.js') : root.DayByDayCore;
  var api = factory(core);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DayByDaySync = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';

  var META_KEY = 'day-by-day.sync';
  var BACKUP_PREFIX = 'day-by-day.backup.replaced-by-sync.';

  /* ---------------- Metadata ---------------- */

  function emptyMeta() {
    return { uid: null, revision: 0, dirty: false, changedAt: '' };
  }

  function normalizeMeta(raw) {
    if (!raw || typeof raw !== 'object') return emptyMeta();
    return {
      uid: typeof raw.uid === 'string' && raw.uid ? raw.uid : null,
      revision: Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0,
      dirty: raw.dirty === true,
      changedAt: typeof raw.changedAt === 'string' ? raw.changedAt : ''
    };
  }

  function readMeta(storage) {
    try {
      return normalizeMeta(JSON.parse(storage.getItem(META_KEY)));
    } catch (e) {
      return emptyMeta();
    }
  }

  function writeMeta(storage, meta) {
    try {
      storage.setItem(META_KEY, JSON.stringify(normalizeMeta(meta)));
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ---------------- Account documents ---------------- */

  function hasData(state) {
    return !!(state && ((state.habits && state.habits.length) || (state.days && Object.keys(state.days).length)));
  }

  function sameData(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  /** Firestore document body for a state. JSON round-trip drops undefined. */
  function toRemoteDoc(state, revision, now) {
    return {
      schemaVersion: core.SCHEMA_VERSION,
      state: JSON.parse(JSON.stringify(state)),
      revision: revision,
      clientUpdatedAt: (now || new Date()).toISOString()
    };
  }

  /**
   * Read an account document. Returns
   *   { exists: false }                                  no document yet
   *   { exists: true, ok: true, state, revision, clientUpdatedAt }
   *   { exists: true, ok: false, error, message }        unreadable / newer
   */
  function fromRemoteDoc(data) {
    if (data === null || data === undefined) return { exists: false };
    if (typeof data !== 'object' || !data.state || typeof data.state !== 'object') {
      return { exists: true, ok: false, error: 'invalid', message: 'The copy in your account is damaged.' };
    }
    var migrated = core.migrate(data.state);
    if (!migrated.ok) {
      return {
        exists: true,
        ok: false,
        error: migrated.error,
        message: migrated.error === 'incompatible'
          ? 'Your account was updated by a newer version of Day by Day. Reload the page to get the latest version.'
          : 'The copy in your account is damaged: ' + migrated.message
      };
    }
    return {
      exists: true,
      ok: true,
      state: migrated.state,
      revision: Number.isInteger(data.revision) && data.revision >= 0 ? data.revision : 0,
      clientUpdatedAt: typeof data.clientUpdatedAt === 'string' ? data.clientUpdatedAt : ''
    };
  }

  /* ---------------- Decisions ---------------- */

  /*
   * Every decision returns { action, ... } where action is one of
   *   'none'      already in step; just record the revision
   *   'upload'    write this device's copy to the account
   *   'download'  replace this device's copy with the account's
   *   'blocked'   the account copy can't be read; don't write, tell the user
   * `backupLocal: true` means this device's copy must be saved as a backup
   * before it is replaced, because it holds changes the account doesn't.
   */

  function newerOf(localUpdatedAt, remoteUpdatedAt) {
    return (localUpdatedAt || '') > (remoteUpdatedAt || '') ? 'local' : 'remote';
  }

  /**
   * Decide what to do when the account copy is read — at sign-in, and every
   * time it changes afterwards.
   *   local           this device's state
   *   meta            this device's sync metadata
   *   remote          result of fromRemoteDoc()
   *   uid             signed-in account
   */
  function decide(input) {
    var local = input.local;
    var meta = normalizeMeta(input.meta);
    var remote = input.remote;
    var uid = input.uid;

    if (!remote.exists) {
      // First sign-in with this account: move this device's progress up.
      return hasData(local) ? { action: 'upload', reason: 'first-sign-in' } : { action: 'none', revision: 0 };
    }
    if (!remote.ok) return { action: 'blocked', message: remote.message };

    if (sameData(local, remote.state)) return { action: 'none', revision: remote.revision };

    if (meta.uid !== uid) {
      // This device was never in step with this account.
      if (!hasData(local)) return { action: 'download', revision: remote.revision };
      if (!hasData(remote.state)) return { action: 'upload', reason: 'account-empty' };
      // Both have different progress. The account wins; keep this device's copy.
      return { action: 'download', revision: remote.revision, backupLocal: true, reason: 'different-device-data' };
    }

    if (remote.revision === meta.revision) {
      return meta.dirty ? { action: 'upload', reason: 'local-changes' } : { action: 'none', revision: remote.revision };
    }

    if (!meta.dirty) return { action: 'download', revision: remote.revision };

    // Both sides changed since they were last in step: newest change wins,
    // and if that is the account's, keep a backup of this device's copy.
    if (newerOf(meta.changedAt, remote.clientUpdatedAt) === 'local') {
      return { action: 'upload', reason: 'conflict-local-newer' };
    }
    return { action: 'download', revision: remote.revision, backupLocal: true, reason: 'conflict-remote-newer' };
  }

  /** Metadata after the user changes something on this device. */
  function markDirty(meta, now) {
    var m = normalizeMeta(meta);
    m.dirty = true;
    m.changedAt = (now || new Date()).toISOString();
    return m;
  }

  /** Metadata once this device and account `uid` are in step at `revision`. */
  function markSynced(meta, uid, revision) {
    var m = normalizeMeta(meta);
    m.uid = uid;
    m.revision = revision;
    m.dirty = false;
    return m;
  }

  /** Backup key for a device copy replaced by sync. */
  function backupKey(now) {
    return BACKUP_PREFIX + (now || new Date()).toISOString();
  }

  return {
    META_KEY: META_KEY,
    BACKUP_PREFIX: BACKUP_PREFIX,
    emptyMeta: emptyMeta,
    normalizeMeta: normalizeMeta,
    readMeta: readMeta,
    writeMeta: writeMeta,
    markDirty: markDirty,
    markSynced: markSynced,
    hasData: hasData,
    toRemoteDoc: toRemoteDoc,
    fromRemoteDoc: fromRemoteDoc,
    decide: decide,
    backupKey: backupKey
  };
});
