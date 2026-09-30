/*
 * Day by Day — Hevy webhook (Firebase Cloud Function, 2nd gen).
 *
 * Hevy calls this when you finish a workout. It checks the secret
 * Authorization header, fetches the workout from Hevy's API, and saves a
 * summary to users/{OWNER_UID}/hevyWorkouts/{workoutId}. The app listens
 * there (js/cloud.js) and ticks your workout goal (js/app.js).
 *
 * Setup (see README → Hevy):
 *   firebase functions:secrets:set HEVY_API_KEY
 *   firebase functions:secrets:set HEVY_WEBHOOK_TOKEN
 *   firebase deploy --only functions,firestore:rules   (asks for OWNER_UID)
 */
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret, defineString } = require('firebase-functions/params');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

const HEVY_API_KEY = defineSecret('HEVY_API_KEY');
const HEVY_WEBHOOK_TOKEN = defineSecret('HEVY_WEBHOOK_TOKEN');
const OWNER_UID = defineString('OWNER_UID', {
  description: 'Your Firebase Auth user UID (Firebase console → Authentication → Users)'
});
const TIMEZONE = defineString('TIMEZONE', { default: 'America/Los_Angeles' });

function dayKey(date, timeZone) {
  return date.toLocaleDateString('en-CA', { timeZone }); // YYYY-MM-DD
}

exports.hevyWebhook = onRequest(
  { secrets: [HEVY_API_KEY, HEVY_WEBHOOK_TOKEN], region: 'us-central1' },
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).send('POST only');

    const auth = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!auth || auth !== HEVY_WEBHOOK_TOKEN.value()) return res.status(401).send('Unauthorized');

    const body = req.body || {};
    const workoutId = (body.payload && body.payload.workoutId) || body.workoutId || body.workout_id || body.id;
    if (!workoutId || !/^[\w-]{1,100}$/.test(String(workoutId))) {
      console.warn('No workout id in webhook body', JSON.stringify(body).slice(0, 500));
      return res.status(400).send('No workoutId');
    }

    try {
      const r = await fetch('https://api.hevyapp.com/v1/workouts/' + encodeURIComponent(workoutId), {
        headers: { 'api-key': HEVY_API_KEY.value(), accept: 'application/json' }
      });
      if (!r.ok) throw new Error('Hevy API ' + r.status + ': ' + (await r.text()).slice(0, 200));
      const data = await r.json();
      const w = data.workout || data;

      const start = new Date(w.start_time);
      const end = new Date(w.end_time);
      let volumeKg = 0;
      let sets = 0;
      for (const ex of w.exercises || []) {
        for (const s of ex.sets || []) {
          sets++;
          if (s.weight_kg && s.reps) volumeKg += s.weight_kg * s.reps;
        }
      }
      const duration = Math.round((end - start) / 60000);

      await db.collection('users').doc(OWNER_UID.value())
        .collection('hevyWorkouts').doc(String(workoutId))
        .set({
          day: dayKey(isNaN(start) ? new Date() : start, TIMEZONE.value()),
          title: String(w.title || 'Workout').slice(0, 80),
          startTime: w.start_time || null,
          durationMin: duration > 0 ? duration : null,
          exerciseCount: (w.exercises || []).length,
          sets,
          volumeLb: Math.round(volumeKg * 2.20462),
          receivedAt: admin.firestore.FieldValue.serverTimestamp()
        });

      return res.status(200).send('ok');
    } catch (err) {
      console.error(err);
      return res.status(500).send('Error');
    }
  }
);
