/*
 * Day by Day — service worker for offline use.
 *
 * Caches the app shell on install so the app opens without a connection.
 * Pages use network-first (so updates arrive promptly), falling back to the
 * cached copy offline; versioned assets use cache-first. Only same-origin
 * GET requests are handled; Firebase sign-in and sync go straight to the
 * network (sync catches up when you're back online).
 *
 * Keep VERSION equal to the ?v= tag in index.html (a test checks this).
 */
'use strict';

var VERSION = '29';
var CACHE = 'day-by-day-v' + VERSION;
var ASSETS = [
  './',
  'index.html',
  'css/styles.css?v=' + VERSION,
  'js/theme.js?v=' + VERSION,
  'js/icons.js?v=' + VERSION,
  'js/core.js?v=' + VERSION,
  'js/stats.js?v=' + VERSION,
  'js/plans.js?v=' + VERSION,
  'js/storage.js?v=' + VERSION,
  'js/sync.js?v=' + VERSION,
  'js/firebase-config.js?v=' + VERSION,
  'js/cloud.js?v=' + VERSION,
  'js/app.js?v=' + VERSION,
  'fonts/instrument-sans-latin-var.woff2',
  'fonts/jetbrains-mono-latin-var.woff2',
  'icon.svg',
  'manifest.webmanifest'
];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) { return cache.addAll(ASSETS); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('day-by-day-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (cache) { cache.put('index.html', copy); });
      return res;
    }).catch(function () {
      return caches.match('index.html');
    }));
    return;
  }

  event.respondWith(caches.match(req).then(function (hit) {
    return hit || fetch(req).then(function (res) {
      if (res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
      }
      return res;
    });
  }));
});
