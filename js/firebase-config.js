/*
 * Firebase settings for optional sign-in and account sync.
 *
 * Sign-in stays hidden while this is null. To turn it on, replace null with
 * the `firebaseConfig` object from Firebase console → Project settings →
 * General → Your apps → Web app. For example:
 *
 *   window.DAY_BY_DAY_FIREBASE_CONFIG = {
 *     apiKey: '...',
 *     authDomain: 'your-project.firebaseapp.com',
 *     projectId: 'your-project',
 *     appId: '...'
 *   };
 *
 * These values identify the project and are safe to publish. Access to data
 * is controlled by the Firestore rules in firestore.rules.
 */
window.DAY_BY_DAY_FIREBASE_CONFIG = null;
