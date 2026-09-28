# Day by Day

A lightweight, mobile-friendly daily goal tracker built around one question: **how many days in a row have I been Locked In?**

Add the daily goals you want to stay consistent with. Each day you check them off; when every goal for that day is done, the day is **Locked In** and your streak grows. Miss a goal (or a whole day) and the streak resets, but nothing is ever deleted: every day stays in your history and Stats. There is no challenge length and nothing to "finish". It just keeps going.

Open the app → check off your goals → leave.

- Plain HTML, CSS and JavaScript. No framework, no build step, no npm dependencies.
- Works offline. Data is always saved in your browser's `localStorage` first.
- Optional **Sign in with Google** saves your progress to your account and syncs it across devices (Firebase; see [Sign-in and sync](#sign-in-and-sync)). Sign-in stays hidden until it is configured.
- Light and dark themes. **Auto** follows your device setting; **Light** or **Dark** overrides it. The choice is saved per device and is not part of exported data.
- No analytics, ads or payments.

## Running the app

You need only a modern browser. Pick either option:

1. **Open the file directly:** double-click `index.html`, or open it with your browser's *File → Open*.
2. **Use the bundled dev server** (Node.js 18 or later, no `npm install` needed):

   ```sh
   npm start            # http://127.0.0.1:8000/
   PORT=8080 npm start  # choose another port
   ```

To use it on a phone, host the folder on any static web host (GitHub Pages, Netlify, etc.). There is nothing to build.

### Publishing updates (cache busting)

GitHub Pages lets browsers keep CSS and JavaScript for about 10 minutes. Without a fix, visitors could briefly get new HTML with old styles. Every stylesheet and script link in `index.html` therefore ends in the same version tag, such as `css/styles.css?v=3`.

**Whenever you change a file in `css/` or `js/`, bump that number in every link** (for example, `v=3` to `v=4`). `npm test` fails if the links don't all share one version.

## How it works

The app has three tabs.

- **Today:** your current Locked In streak (and your best), then **Today's Goals** with a progress bar. Ticking a goal saves instantly. When every goal is done the card switches to **LOCKED IN ✓**. **Edit** opens the goal editor.
- **Stats:** current streak, best streak, total Locked In days and completion rate; a month calendar of how every day went (tap a day for its details); a daily-completion chart (7 / 30 / 90 days / all time); a habit-consistency chart; and per-goal stats.
- **Settings:** your account (sign in/out and sync status) and your data (export, import, delete everything).

| Situation | What happens |
| --- | --- |
| You tick every goal for today | Today is Locked In and your streak goes up by one. Unticking takes it back. |
| Today isn't finished yet | Your streak still shows yesterday's run. Today only counts once it's Locked In. |
| A day ends with some goals not done | That day is recorded as partial and the streak resets. Next morning the app tells you why. |
| You don't open the app for a day or more | Those days are recorded as missed (nothing done) the next time you open it, and the streak resets. |
| Every goal is paused | The day is neutral: it neither counts toward nor breaks your streak. |

**Definitions.** A *Locked In day* is a day where every goal required that day was done. The *current streak* is the run of consecutive Locked In days ending today (or yesterday, while today is in progress); *best streak* is the longest such run ever. *Completion rate* is goals done ÷ goals due over every tracked day. Days are the device's local calendar days. If the clock is set backwards, nothing is back-filled or rewritten.

### Managing goals

In **Edit goals** you can add, rename (edit the name in place), reorder (↑ ↓), pause (a temporary break; resume any time) and remove goals.

- Changes apply **from today**. Every day keeps its own record of which goals were required and what they were called, so renaming, pausing or removing a goal never changes past days or their stats, and a new goal never counts against days before it existed.
- Removing a goal that has history **archives** it: it leaves today's list but stays in history and Stats, and can be restored. A goal with no history yet (for example a typo added today) is deleted outright.
- Up to 20 active goals.

## Testing

Tests use Node's built-in test runner, so nothing needs to be installed.

```sh
npm test         # run the unit tests
npm run check    # syntax-check every script
npm run validate # both of the above
```

The tests in `tests/` cover:

- Locked In days, partial days, today-in-progress, and the brief's worked example (✓✓✓✗✓✓ → current 2, best 3, total 5)
- days the app wasn't opened being filled in as missed; no duplicate daily records; future dates can't be ticked
- adding, renaming, reordering, pausing, archiving, restoring and deleting goals without rewriting history
- per-goal stats counted only over the days each goal was required; daily series, calendar grid and day details
- month and year boundaries, daylight saving changes, and leap years (including skipping Feb 29)
- malformed saved data (bad JSON, wrong types, impossible dates, broken invariants, blocked storage)
- migrating older saved data (the old challenge format and the original prototype), and export/import validation
- theme preference handling (fallback to Auto, blocked storage)
- sync decisions: first-sign-in upload, fresh-device download, live changes, conflicts, stale devices, unreadable account data
- every CSS/JS link in `index.html` carrying the same cache-busting version

## Sign-in and sync

Sign-in is optional and **off until configured**. With no config, the Account card is hidden and the app never contacts Google.

### Turning it on

1. In the [Firebase console](https://console.firebase.google.com), create a project. Google Analytics can stay off.
2. Go to **Authentication → Sign-in method** and enable **Google**.
3. In **Authentication → Settings → Authorized domains**, add your site's domain, for example `gachow-07.github.io`.
4. Go to **Firestore Database → Create database** and choose production mode.
5. On the **Rules** tab, replace everything with the contents of [`firestore.rules`](firestore.rules), then click **Publish**.
6. Open **Project settings → General → Your apps → Web app** and copy the `firebaseConfig` object into [`js/firebase-config.js`](js/firebase-config.js).
7. Bump the `?v=` tag in `index.html` (see above), commit and push.

The config values identify your project and are safe to publish. Data access is controlled by the rules: each signed-in person can read and write only their own document, `users/{uid}`, and writes must have the expected shape.

### How sync works

- This device's copy is the working copy. Changes are saved locally first, then written to your account shortly afterwards. Offline, the app keeps working and catches up later.
- **First sign-in:** progress already on this device is uploaded to your account. If the account already has different progress (for example from another phone), the account's copy is kept. This device's copy is saved as a backup, and a **Download this device's copy** button appears.
- **Other devices:** changes from another signed-in device appear automatically. If both devices changed while out of touch, the newer change wins, and the replaced copy is backed up the same way.
- **Missed days:** days the app fills in on its own (missed days, today's empty record) are never uploaded by themselves. Every device works them out from the same data, so a device that hasn't been opened for a while can't wipe out newer progress from another device. When you were signed in last time, the app also waits briefly for your account's latest copy before filling in missed days.
- **Updating from the challenge version:** an account still holding the old challenge-format data is converted when it's downloaded, and saved back in the new format on your next change. A device still running the old version is told to reload to get the update.
- **Signing out** keeps your progress on the device and stops syncing.
- Your theme choice stays per device and isn't synced.

Sync code: `js/sync.js` makes every decision (unit tested in `tests/sync.test.js`), `js/cloud.js` talks to Firebase, and `js/app.js` connects the two.

### Testing against the Firebase emulators (optional)

The automated `npm test` suite needs nothing installed. To try sign-in end to end without a real project, run the [Firebase emulators](https://firebase.google.com/docs/emulator-suite) (`firebase emulators:start --only auth,firestore` with `firestore.rules`). Then add `emulators: { auth: '127.0.0.1:9099', firestore: '127.0.0.1:8080' }` to a local, uncommitted copy of the config. In emulator mode only, `DayByDayCloud._emulatorSignIn(email)` signs in without the Google popup.

## Backing up your data

If you are not signed in, everything lives in this browser only. Clearing site data, or switching browser or device, will lose it unless you have a backup. Signed in, your account holds a copy too, but a backup file is still a good idea.

- **Export data** downloads `day-by-day-backup-YYYY-MM-DD.json` with a `schemaVersion`, your goals, and every daily record. For convenience it also includes computed `dailyRecords` (date, each goal and whether it was done, totals, percentage, Locked In) and a `stats` summary (streaks, totals, completion rate). Import only reads the stored fields and recalculates everything else.
- **Import data** loads a backup file. The file is fully checked **before anything is saved**:
  - Files that aren't JSON, weren't made by Day by Day, lack `schemaVersion`, come from a newer version, or contain inconsistent history are rejected with an explanation. Your current data is not touched.
  - For a valid file, the app shows a summary and asks you to confirm before it replaces your current data.
  - After an import, days since the backup's last record are filled in as missed.
  - Backups from the old challenge version can still be imported; they are converted like saved data (below).

### Saved-data format and migrations

Data is stored under the `localStorage` key `day-by-day` as JSON with a `schemaVersion` field. The current version is **3**:

```js
{
  schemaVersion: 3,
  habits: [{ id: 'h1', name: 'Workout', createdOn: '2026-09-01', status: 'active', archivedOn: null }],
  //        status: 'active' | 'paused' | 'archived'; array order is display order
  days: {
    '2026-09-01': { habits: [{ id: 'h1', name: 'Workout' }], done: ['h1'] }
    // one record per date: the goals required that day, with their names then, and which were done
  }
}
```

Streaks and all statistics are calculated from `days` (see `js/stats.js`); no counters are stored.

- **Version 2 → 3** (the old fixed-length challenge format): the challenge's habits become goals. Every day the old app recorded as complete, in any attempt, becomes a fully done record, so old streaks and your best streak carry over. Days the old app knew were missed or failed become days with nothing done (it didn't store partial progress for them), and today's ticks are kept. The original is first copied to `day-by-day.backup.v2.<timestamp>`.
- Data without a `schemaVersion` is treated as version 1, the unversioned prototype format, and upgraded through version 2. The original is first copied to `day-by-day.backup.v1.<timestamp>`.
- Saved data that can't be read is copied to `day-by-day.backup.unreadable.<timestamp>` and left in place. The app then offers to start fresh or import a backup.
- If the data comes from a *newer* version of the app, it is left untouched and saving is disabled.

To change the format: bump `SCHEMA_VERSION` in `js/core.js`, add a step to `MIGRATIONS`, update `validateState`, and add tests.

## Accessibility

- A visible focus ring (3px, high-contrast blue) on every interactive element, plus a "Skip to main content" link.
- Every control has a real label. Goal checkboxes are native inputs inside `<label>`s (styled, but still operable with Space), and the progress bar has ARIA values.
- Today and Stats are an ARIA tab list (arrow keys switch tabs). Calendar days are buttons labelled with the date and how it went; future days aren't focusable. Locked In days also show a ✓, so the calendar never relies on colour alone.
- Charts: the daily chart is keyboard-readable (focus it and use ←/→ for each day's tooltip) and has a **Show daily data** table; the consistency chart prints each value next to its bar.
- Screen-reader announcements go through a polite live region (goal ticked, Locked In, goal changes, import results). Errors use `role="alert"`.
- **Edit goals** and confirmations use the native modal `<dialog>`: focus is trapped, Escape closes, and focus returns to the button that opened it. Confirmations start on **Cancel**.
- Colour pairs meet WCAG 2.1 AA in both themes.
  - Light: body text 14.9:1 or higher, muted text 6.4:1, white on green buttons 6.5:1, red danger text 7.3:1, focus ring 6:1, control borders 4.1:1.
  - Dark: body text 13.9:1 or higher, muted text 7.3:1, dark text on green buttons 8.7:1, danger text 7.5:1, focus ring 7.9:1, control borders 4.5:1.
  - Calendar day numbers: at least 6.3:1 on every day state in both themes.
- The theme switch is a labelled radio group, so arrow keys change the theme.
- The layout works from 320px wide up to desktop. Animations (tick pop, Locked In glow) are subtle and switched off when `prefers-reduced-motion` is set. Windows high-contrast mode keeps ticks, bars and Locked In days visible.

## Project structure

```
index.html          Markup: Today and Stats tabs, Edit goals sheet, confirmation dialog
icon.svg            Favicon
css/styles.css      All styles; light and dark colour tokens at the top
js/theme.js         Auto/Light/Dark preference, applied before first paint
js/sync.js          Pure sync decisions: upload / download / conflicts
js/cloud.js         Firebase adapter: Google sign-in, users/{uid} document
js/firebase-config.js  Firebase web config (null = sign-in hidden)
firestore.rules     Firestore security rules to paste into the console
js/core.js          Pure logic: dates, goals, daily records, validation,
                    migrations, import/export (no DOM, no storage)
js/stats.js         Every number shown: streaks, totals, rates, chart series,
                    calendar grid, day details (calculated from daily records)
js/storage.js       localStorage load/save, migration on load, corrupt-data backup
js/app.js           UI controller: renders state and wires up events
scripts/serve.js    Optional zero-dependency static server (npm start)
tests/              node:test suites and helpers (a fake localStorage)
package.json        npm scripts only; there are no dependencies
```

`core.js`, `stats.js`, `storage.js`, `sync.js` and `theme.js` are plain scripts. In the browser they attach `DayByDayCore`, `DayByDayStats`, `DayByDayStorage`, `DayByDaySync` and `DayByDayTheme` to `window`, and in Node they export via `module.exports`. That is why the app works from `file://` without a bundler, and why the tests can `require()` the same files.
