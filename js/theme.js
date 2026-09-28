/*
 * Day by Day — theme preference (Auto / Light / Dark).
 *
 * Loaded in <head> so the saved theme is applied before first paint. The
 * preference is a per-device display setting, so it is stored under its own
 * key and is not part of challenge data, exports or imports.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DayByDayTheme = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var THEME_KEY = 'day-by-day.theme';
  var PREFERENCES = ['auto', 'light', 'dark'];
  var THEME_COLORS = { light: '#1d6b47', dark: '#121416' };

  /** Anything unknown (missing, damaged, old) falls back to 'auto'. */
  function normalizePreference(value) {
    return PREFERENCES.indexOf(value) >= 0 ? value : 'auto';
  }

  /** The theme actually shown for a preference and the device setting. */
  function resolveTheme(preference, systemPrefersDark) {
    var pref = normalizePreference(preference);
    if (pref === 'auto') return systemPrefersDark ? 'dark' : 'light';
    return pref;
  }

  function readPreference(storage) {
    try {
      return normalizePreference(storage.getItem(THEME_KEY));
    } catch (e) {
      return 'auto';
    }
  }

  function writePreference(storage, preference) {
    try {
      storage.setItem(THEME_KEY, normalizePreference(preference));
      return true;
    } catch (e) {
      return false;
    }
  }

  return {
    THEME_KEY: THEME_KEY,
    PREFERENCES: PREFERENCES,
    THEME_COLORS: THEME_COLORS,
    normalizePreference: normalizePreference,
    resolveTheme: resolveTheme,
    readPreference: readPreference,
    writePreference: writePreference
  };
});

/* Browser wiring. Skipped under Node. */
(function () {
  'use strict';
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  var theme = window.DayByDayTheme;
  var storage = null;
  try {
    storage = window.localStorage;
  } catch (e) {
    storage = null;
  }
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var preference = storage ? theme.readPreference(storage) : 'auto';

  function apply() {
    var root = document.documentElement;
    // 'auto' leaves the attribute off so the CSS media query decides.
    if (preference === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', preference);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme.THEME_COLORS[theme.resolveTheme(preference, media && media.matches)]);
  }

  apply();

  if (media) {
    var onSystemChange = function () { if (preference === 'auto') apply(); };
    if (media.addEventListener) media.addEventListener('change', onSystemChange);
    else if (media.addListener) media.addListener(onSystemChange);
  }

  document.addEventListener('DOMContentLoaded', function () {
    var radios = document.querySelectorAll('input[name="theme"]');
    Array.prototype.forEach.call(radios, function (radio) {
      radio.checked = radio.value === preference;
      radio.addEventListener('change', function () {
        if (!radio.checked) return;
        preference = theme.normalizePreference(radio.value);
        if (storage) theme.writePreference(storage, preference);
        apply();
      });
    });
  });
})();
