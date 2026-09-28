/*
 * Day by Day — localStorage persistence.
 *
 * All saved data lives under one key as a versioned JSON document. Older
 * versions are upgraded through DayByDayCore.migrate(). Data that cannot be
 * read is copied to a backup key before anything else is written, so a bug
 * or a damaged value never silently destroys a user's history.
 *
 * `storage` is injected (window.localStorage in the browser, a fake in
 * tests) so this module can run under Node.
 */
(function (root, factory) {
  'use strict';
  var core = typeof module === 'object' && module.exports ? require('./core.js') : root.DayByDayCore;
  var api = factory(core);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DayByDayStorage = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';

  var STORAGE_KEY = 'day-by-day';
  var BACKUP_PREFIX = 'day-by-day.backup.';

  function backupKey(reason, now) {
    return BACKUP_PREFIX + reason + '.' + (now || new Date()).toISOString();
  }

  /**
   * Load saved state.
   * Returns { state, notice, readOnly }:
   *   notice   — message to show the user (or null)
   *   readOnly — true when saving must be disabled to protect data this
   *              version of the app cannot understand
   */
  function load(storage, now) {
    var raw;
    try {
      raw = storage.getItem(STORAGE_KEY);
    } catch (e) {
      return {
        state: core.emptyState(),
        readOnly: true,
        notice: 'Your browser is blocking storage, so progress cannot be saved on this device.'
      };
    }
    if (raw === null || raw === undefined) return { state: core.emptyState(), notice: null, readOnly: false };

    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return recoverFromBadData(storage, raw, 'Your saved data could not be read', now);
    }

    var migrated = core.migrate(parsed);
    if (!migrated.ok) {
      if (migrated.error === 'incompatible') {
        // Written by a newer app version. Leave it untouched.
        return { state: core.emptyState(), readOnly: true, notice: migrated.message + ' Nothing has been changed.' };
      }
      return recoverFromBadData(storage, raw, 'Your saved data was damaged', now);
    }

    if (migrated.migrated) {
      try {
        storage.setItem(backupKey('v' + migrated.fromVersion, now), raw);
        storage.setItem(STORAGE_KEY, JSON.stringify(migrated.state));
      } catch (e) {
        // Still usable in memory; the next successful save will persist it.
      }
    }
    return { state: migrated.state, notice: null, readOnly: false };
  }

  function recoverFromBadData(storage, raw, reason, now) {
    var key = backupKey('unreadable', now);
    try {
      storage.setItem(key, raw);
    } catch (e) {
      // If the copy cannot be made, do not risk overwriting the original.
      return {
        state: core.emptyState(),
        readOnly: true,
        notice: reason + ' and could not be backed up, so it has been left untouched. Saving is disabled.'
      };
    }
    return {
      state: core.emptyState(),
      readOnly: false,
      notice: reason + '. A copy was kept in this browser under "' + key + '". You can start fresh or import a backup.'
    };
  }

  /** Validate and persist state. Throws if the state is invalid or storage fails. */
  function save(storage, state) {
    var errors = core.validateState(state);
    if (errors.length) throw new Error('Refusing to save invalid data: ' + errors[0]);
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  return { STORAGE_KEY: STORAGE_KEY, BACKUP_PREFIX: BACKUP_PREFIX, load: load, save: save };
});
