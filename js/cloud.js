/*
 * Day by Day — Firebase adapter (sign-in and account storage).
 *
 * Only active when js/firebase-config.js provides a config. The Firebase SDK
 * is loaded on demand from Google's CDN, so the app stays dependency-free
 * and works exactly as before when sign-in is not configured.
 *
 * Each account's data is one Firestore document: users/{uid}. Decisions
 * about which copy wins are made in sync.js; this file only moves data.
 */
(function () {
  'use strict';

  var SDK_VERSION = '12.19.0';
  var SDK_BASE = 'https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/';

  var config = window.DAY_BY_DAY_FIREBASE_CONFIG || null;
  var sdk = null;
  var auth = null;
  var db = null;
  var currentUser = null;
  var stopListening = null;
  var stopHevy = null;

  function isConfigured() {
    return !!(config && config.apiKey && config.projectId && config.authDomain);
  }

  function loadSdk() {
    return Promise.all([
      import(SDK_BASE + 'firebase-app.js'),
      import(SDK_BASE + 'firebase-auth.js'),
      import(SDK_BASE + 'firebase-firestore.js')
    ]).then(function (mods) {
      sdk = { app: mods[0], auth: mods[1], firestore: mods[2] };
      return sdk;
    });
  }

  function friendlyError(e) {
    var code = (e && e.code) || '';
    if (code === 'auth/network-request-failed' || code === 'unavailable') return 'You appear to be offline. Try again when you are connected.';
    if (code === 'auth/unauthorized-domain') return 'Sign-in is not allowed on this web address yet. Add it under Authentication → Settings → Authorized domains in Firebase.';
    if (code === 'auth/operation-not-allowed') return 'Google sign-in is not turned on for this Firebase project yet.';
    if (code === 'auth/internal-error' || code === 'auth/web-storage-unsupported') {
      return 'Sign-in could not start. If you use an ad or privacy blocker, allow google.com for this site, then try again.';
    }
    if (code === 'auth/too-many-requests') return 'Too many attempts. Wait a minute and try again.';
    if (code === 'permission-denied') return 'Your account data could not be accessed (permission denied). Check the Firestore security rules.';
    return (e && e.message) || 'Something went wrong.';
  }

  /**
   * Start Firebase and listen for sign-in changes.
   * handlers.onUser(user|null)        — { uid, name, email } or null
   * handlers.onRemote(data|null)      — server-confirmed account document
   * handlers.onError(message)
   * handlers.onHevy(list)            — optional: recent Hevy workouts
   */
  function start(handlers) {
    if (!isConfigured()) return Promise.resolve(false);
    return loadSdk().then(function (s) {
      var app = s.app.initializeApp(config);
      auth = s.auth.getAuth(app);
      db = s.firestore.getFirestore(app);
      if (config.emulators) {
        // Local testing only (see README): point at the Firebase emulators.
        s.auth.connectAuthEmulator(auth, 'http://' + config.emulators.auth, { disableWarnings: true });
        var fs = config.emulators.firestore.split(':');
        s.firestore.connectFirestoreEmulator(db, fs[0], Number(fs[1]));
        // Emulator-only helper for automated tests: sign in without the popup.
        window.DayByDayCloud._emulatorSignIn = function (email) {
          var token = JSON.stringify({ sub: email, email: email, email_verified: true, name: email.split('@')[0] });
          return s.auth.signInWithCredential(auth, s.auth.GoogleAuthProvider.credential(token));
        };
      }
      s.auth.getRedirectResult(auth).catch(function (e) { handlers.onError(friendlyError(e)); });

      s.auth.onAuthStateChanged(auth, function (user) {
        if (stopListening) { stopListening(); stopListening = null; }
        if (stopHevy) { stopHevy(); stopHevy = null; }
        currentUser = user;
        handlers.onUser(user ? { uid: user.uid, name: user.displayName || '', email: user.email || '' } : null);
        if (!user) return;
        var ref = s.firestore.doc(db, 'users', user.uid);
        stopListening = s.firestore.onSnapshot(ref, function (snap) {
          // Ignore our own unconfirmed writes and anything answered from the
          // offline cache: "no document" from the cache doesn't mean the
          // account is empty, and acting on it could overwrite real data.
          if (snap.metadata.hasPendingWrites || snap.metadata.fromCache) return;
          handlers.onRemote(snap.exists() ? snap.data() : null);
        }, function (e) {
          handlers.onError(friendlyError(e));
        });
        // Workouts the Hevy webhook (functions/index.js) saved for this
        // account. Read-only for the app; only the function writes them.
        if (handlers.onHevy) {
          var hq = s.firestore.query(
            s.firestore.collection(db, 'users', user.uid, 'hevyWorkouts'),
            s.firestore.orderBy('receivedAt', 'desc'),
            s.firestore.limit(10)
          );
          stopHevy = s.firestore.onSnapshot(hq, function (snap) {
            if (snap.metadata.hasPendingWrites) return;
            handlers.onHevy(snap.docs.map(function (d) {
              return Object.assign({ id: d.id }, d.data());
            }));
          }, function () {
            // No Hevy rules deployed yet, or offline: ignore quietly.
          });
        }
      });
      return true;
    });
  }

  /** Resolves { ok: true }, { cancelled: true } or { ok: false, message }. */
  function signIn() {
    if (!auth) return Promise.resolve({ ok: false, message: 'Sign-in is still loading. Try again in a moment.' });
    var provider = new sdk.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    return sdk.auth.signInWithPopup(auth, provider).then(function () {
      return { ok: true };
    }, function (e) {
      var code = (e && e.code) || '';
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return { cancelled: true };
      if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
        return sdk.auth.signInWithRedirect(auth, provider).then(function () { return { ok: true }; });
      }
      return { ok: false, message: friendlyError(e) };
    });
  }

  function signOut() {
    if (!auth) return Promise.resolve();
    return sdk.auth.signOut(auth);
  }

  /** Write the account document (body from DayByDaySync.toRemoteDoc). */
  function write(body) {
    if (!currentUser) return Promise.reject(new Error('Not signed in.'));
    var ref = sdk.firestore.doc(db, 'users', currentUser.uid);
    var data = Object.assign({}, body, { updatedAt: sdk.firestore.serverTimestamp() });
    return sdk.firestore.setDoc(ref, data).catch(function (e) {
      throw new Error(friendlyError(e));
    });
  }

  window.DayByDayCloud = {
    isConfigured: isConfigured,
    start: start,
    signIn: signIn,
    signOut: signOut,
    write: write
  };
})();
