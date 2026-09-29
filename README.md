# Day by Day

**Day by Day turns a tiny daily check-in into a clear weekly plan for becoming more consistent.**

Add the goals you want to stay consistent with. Each day you check them off; when every goal due that day is done, the day is **Locked In** and your locked-in streak grows. Miss a goal (or a whole day) and the streak resets, but nothing is ever deleted: every day stays in your history, and Stats turns it into plain-language weekly insights.

Open the app → check off your goals → leave.

- Plain HTML, CSS and JavaScript. No framework, no build step, no runtime dependencies. The Instrument Sans typeface and a subset of [Lucide](https://lucide.dev) icons are bundled (`fonts/`, `js/icons.js`, licences included).
- Works offline, including opening the app with no connection (a service worker caches it). Data is always saved in your browser's `localStorage` first.
- Can be installed as an app (web manifest), with a **Check in today** shortcut.
- Optional **Sign in with Google** saves your progress to your account and syncs it across devices (Firebase; see [Sign-in and sync](#sign-in-and-sync)). Sign-in stays hidden until it is configured.
- Light and dark themes. **Auto** follows your device setting; **Light** or **Dark** overrides it. The choice is saved per device and is not part of exported data.
- **No ads, no tracking.** No analytics, no third-party trackers, and data is never sold or shared.

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

**Whenever you change a file in `css/` or `js/`, bump that number in every link _and_ `VERSION` in `sw.js`** (for example, `11` to `12`). The service worker caches exactly those versions for offline use, so a new `VERSION` is what tells installed copies to update. `npm test` fails if the links and `sw.js` don't all share one version.

## How it works

The app has three sections: a left sidebar on screens 768px and wider, and a bottom tab bar on phones (it respects the safe area and never covers content).

- **Today:** your locked-in streak in large type, your best streak, and the past six days as small tiles next to a larger tile for today, which fills as you check goals off. Below: an optional one-line **Focus**, then today's goals. Ticking a goal saves instantly. When the last one is done, today's tile settles into its completed state (a small lift and drop, then a check draws in, all under a second) and the line reads **Locked in**. There's no confetti, and with reduced motion the tile simply changes. Times-per-week goals sit in a **This week** group with their weekly progress.
- **Stats:** the locked-in streak leads, with best streak, completion rate (and its change on last week), locked-in days and tracked days in one row below (hover a label for its definition). Then this week's insights as short sentences, a full-width month calendar (choosing a day opens its details in a temporary panel beside the calendar on wide screens, or a bottom sheet on phones; Escape or ✕ closes it), daily completion (7 / 30 / 90 days / all time) and by weekday, and **Goals**, a dropdown (closed by default, remembered per device) with each goal's streak, best streak, completion rate and a grid of up to a year of days in the goal's colour. Until there's a week of check-ins, the top shows how many days are left as seven tiles.
- **Settings:** Appearance (theme, week start), Reminders, Account (when sign-in is set up), Plan, and Your data (export, import, delete everything).

| Situation | What happens |
| --- | --- |
| You tick every goal for today | Today is Locked In and your streak goes up by one. Unticking takes it back. |
| Today isn't finished yet | Your streak still shows yesterday's run. Today only counts once it's Locked In. |
| A day ends with some goals not done | That day is recorded as partial and the streak resets. Next morning the app tells you why. |
| You don't open the app for a day or more | Those days are recorded as missed (nothing done) the next time you open it, and the streak resets. |
| Every goal is paused, or nothing is scheduled that day | The day is neutral: it neither counts toward nor breaks your streak. |
| A goal is times-per-week | It shows every day and can be ticked any day, but it doesn't decide whether a day is Locked In; it's tracked by week. |

**Definitions.** A *Locked In day* is a day where every goal due that day was done. The **locked-in streak** is the run of consecutive Locked In days ending today (or yesterday, while today is in progress); the *best locked-in streak* is the longest such run ever. A **goal streak** is different: the days (or weeks, for times-per-week goals) in a row that one goal was done. A goal can have a long goal streak while the locked-in streak is 0, because the locked-in streak needs every goal; Stats explains this next to the goal streaks. *Completion rate* is goals done ÷ goals due over every tracked day. Days are the device's local calendar days. If the clock is set backwards, nothing is back-filled or rewritten.

**Insights only appear with enough real data.** Weekly patterns need 7 tracked days (until then Stats says exactly how many more are needed). Week-over-week change needs 3 tracked days in each of the last two 7-day windows. Strongest and weakest weekdays need 14 tracked days and at least two of each weekday compared. A "biggest opportunity" is named only when one goal is clearly behind the others. The daily chart is drawn once there are 3 tracked days in the range. Nothing is ever filled in with sample data.

### Managing goals

**Edit goals** lists your goals. Drag a handle to reorder (or focus it and use ↑/↓), and use **Edit** to open a goal. The goal form has: name, an optional icon (86 to choose from, grouped into Fitness, Food and health, Rest and mind, Learning and work, Home and money, People and fun, and Other) and colour, a **schedule** (every day, weekdays, selected days, or a number of times per week), an optional **reminder** time, an optional **workout split**, and status actions (**Pause**/**Resume**, **Archive** or **Delete**) with a plain explanation of each.

- Changes apply **from today**. Every day keeps its own record of which goals were required and what they were called, so renaming, pausing or removing a goal never changes past days or their stats, and a new goal never counts against days before it existed.
- Removing a goal that has history **archives** it: it leaves today's list but stays in history and Stats, and can be restored. A goal with no history yet (for example a typo added today) is deleted outright.
- Up to 20 active goals (the planned Free plan allows 5; see Plans).

### Partly done and time goals

Not every day is all or nothing:

- **Partly done.** Open a goal's **⋯** menu and choose **Partly done**. Its box fills halfway. Ticking the goal later makes it fully done.
- **Time goals.** In the goal form, set **Track** to **Time, logged in pieces** and give a daily goal, such as 2 h for "Study". The goal then shows a **Log** button: add **+15 min**, **+30 min**, **+1 h** or **+2 h**, or **Other amount…** for anything else. **Undo last** takes back the most recent entry. The box fills as time adds up, and the goal is done when the entries reach the goal. Ticking the box logs whatever is left; unticking takes back the latest entries.

Partial progress never makes a day Locked In or continues a streak, but it does count toward completion rates: a partly done goal counts as half, and a time goal counts by the share logged (1 h of 2 h is half). A day with only partial progress shows as **Partial** (yellow) on the calendar rather than missed, and the Goals history grid shows it as a half-filled square.

### Workout splits

Turn on **Rotate through workouts** in a goal's form and list the workouts in order, one per line (for example Legs, Chest, Back, Shoulders), then pick today's workout. Each day the goal is due, Today shows that day's workout on the goal, and the split moves on to the next one. Days the goal isn't scheduled are skipped, so leave rest days out of the schedule. For a times-per-week goal the split moves on each time you check it off instead.

Did a different workout? Tap the **⋯** button on the right of the goal and pick what you actually did. The two workouts swap places: today becomes the one you did, and the one you were meant to do moves to the day that workout was planned. For example, on leg day with shoulders planned for Wednesday, choosing Shoulders makes today shoulder day and moves legs to Wednesday. Choosing the original workout again swaps them back. The menu shows when each workout is next planned, and **Edit split** opens the goal form. Each day's record keeps the workout done that day, and it appears in the calendar's day details and in exports.

### Reminders

Set a reminder time on a goal, and after that time Day by Day shows one reminder a day for goals that aren't done: inside the app, and as a system notification if you allow notifications in **Settings → Notifications**. Browsers only run web apps while they're open (in a tab or installed), so reminders can't arrive once the app is fully closed. Settings says this plainly. Turning off **Show reminders** stops them on that device.

## Plans

`js/plans.js` defines the Free and Pro plans and answers every "can this user use X?" question (`can(feature)`, `limit(name)`):

- **Free:** up to 5 active goals, basic streaks and statistics, 30 days of history.
- **Pro:** unlimited goals, flexible schedules, reminders, install/quick check-in, daily focus, weekly review and insights, full history, advanced trends, data export, shareable weekly summary.

**Billing is not implemented.** There is no payment provider and nothing takes money. Until billing exists, everyone is on **Early access**, which includes every Pro feature, so nothing you use today is locked. Settings → Subscription shows the plan and the Free/Pro comparison, with no buy or upgrade buttons. To add billing later, have `currentPlan()` return `'free'` or `'pro'` from a verified subscription and keep feature checks going through `can()`/`limit()`.

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
- migrating older saved data (schema 3, the old challenge format and the original prototype) with identical stats, and export/import validation
- schedules (weekdays, selected days, times per week), neutral unscheduled days, flexible goals not affecting Locked In, weekly goal stats, drag reordering, daily focus and week start
- insights and their data minimums: week-over-week change, strongest and weakest weekday, biggest opportunity
- partly done and time goals: logging in pieces, reaching the goal, undo, ticking and unticking a timed goal, partial credit in completion rates without Locked In or streaks, calendar and grid states, switching a goal to or from timed, validation, the v5 → 6 migration, and export/import
- workout splits: rotation on due days only and over many weeks, times-per-week splits, swapping a workout (and swapping back), re-anchoring when the schedule changes, validation, the v4 → 5 migration, and workouts in day details and exports
- plan entitlements (Early access grants everything; Free and Pro limits)
- theme preference handling (fallback to Auto, blocked storage)
- sync decisions: first-sign-in upload, fresh-device download, live changes, conflicts, stale devices, unreadable account data
- every CSS/JS link in `index.html` carrying the same cache-busting version, and the service worker caching that same version

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

Data is stored under the `localStorage` key `day-by-day` as JSON with a `schemaVersion` field. The current version is **6**:

```js
{
  schemaVersion: 6,
  habits: [{
    id: 'h1', name: 'Workout', createdOn: '2026-09-01', status: 'active', archivedOn: null,
    icon: 'dumbbell',              // Lucide icon name or null
    color: 'jade',                 // jade | teal | sky | indigo | violet | rose | amber | slate | null
    schedule: { type: 'daily' },   // | { type: 'weekdays' } | { type: 'days', days: [1, 3, 5] } | { type: 'weekly', times: 3 }
    reminder: '07:30',             // 'HH:MM' or null
    split: { workouts: ['Legs', 'Chest', 'Back'], start: '2026-09-01', offset: 0 }
                                   // or null. The day the goal is due on `start` gets workouts[offset],
                                   // and each later due day (or, for times-per-week goals, each day
                                   // after one it was done) the next workout.
    minutes: 120                   // a daily time goal (5-1440) logged in pieces, or null
  }],
  days: {
    '2026-09-01': { habits: [{ id: 'h1', name: 'Workout', workout: 'Legs' }, { id: 'h2', name: 'Run', flex: true, target: 3 },
                             { id: 'h3', name: 'Study', minutes: 120 }, { id: 'h4', name: 'Read' }],
                    done: ['h1'], logs: { h3: [60, 30] }, partial: ['h4'] }
    // one record per date: the goals shown that day, with their names then, and which were done.
    // flex entries (times per week) don't count toward Locked In. workout is that day's split workout.
    // logs are a timed goal's entries (it's done when they reach its minutes); partial lists
    // untimed goals marked partly done. Both count toward completion rates, never toward Locked In.
  },
  focus: { '2026-09-01': 'Finish the essay draft' },   // optional daily intention
  settings: { weekStart: 0 }                           // 0 = Sunday, 1 = Monday
}
```

Streaks and all statistics are calculated from `days` (see `js/stats.js`); no counters are stored.

- **Version 5 → 6:** goals gain `minutes: null` (no time goal). Records are unchanged; `logs` and `partial` are optional. The original is first copied to `day-by-day.backup.v5.<timestamp>`.
- **Version 4 → 5:** goals gain `split: null` (no workout split). Nothing else changes. The original is first copied to `day-by-day.backup.v4.<timestamp>`.
- **Version 3 → 4:** existing goals become "every day" goals with no icon, colour or reminder, and daily records are untouched, so every streak and statistic is exactly the same (a test checks this). The original is first copied to `day-by-day.backup.v3.<timestamp>`. An account still holding version 3 data is converted when it's downloaded and saved back as version 4 on your next change. A device still running an older app version is told to reload.

- **Version 2 → 3** (the old fixed-length challenge format): the challenge's habits become goals. Every day the old app recorded as complete, in any attempt, becomes a fully done record, so old streaks and your best streak carry over. Days the old app knew were missed or failed become days with nothing done (it didn't store partial progress for them), and today's ticks are kept. The original is first copied to `day-by-day.backup.v2.<timestamp>`.
- Data without a `schemaVersion` is treated as version 1, the unversioned prototype format, and upgraded through version 2. The original is first copied to `day-by-day.backup.v1.<timestamp>`.
- Saved data that can't be read is copied to `day-by-day.backup.unreadable.<timestamp>` and left in place. The app then offers to start fresh or import a backup.
- If the data comes from a *newer* version of the app, it is left untouched and saving is disabled.

To change the format: bump `SCHEMA_VERSION` in `js/core.js`, add a step to `MIGRATIONS`, update `validateState`, and add tests.

## Design system

The idea is *building consistency one day at a time*, so the one recurring shape is the **day tile**, a small rounded square. It is the mark (three tiles stepping up, the newest one done), the week strip and today's tile on Today, the goal checkboxes, the calendar days, the early-data progress and the Goal history grids. Nothing else is decorative.

- **Layout before containers.** Sections are grouped by type, spacing and hairlines. Only genuinely separate regions get a surface: dialogs and sheets, the workout menu, and the temporary day panel.
- **Type.** [Instrument Sans](https://github.com/Instrument/instrument-sans) (variable, Latin, bundled). Page titles 32px semibold, section titles 18px, body 16px, labels 14px, metadata 13px. Statistics and calendar numbers use tabular figures, and the streak is set large with tight tracking.
- **Colour.** Warm neutrals in both themes (no pure black or white). Mint is kept for completion, active navigation and the main action. Past Locked In days use a quieter green, so only today's completion is bright. Partial days are amber and missed days a muted rose.
- **Icons** only for navigation and real controls, plus a goal's own icon (plain, in its colour).
- **Copy** is short and plain. Definitions live in tooltips rather than under every number.

All styles come from tokens at the top of `css/styles.css`: colours for both themes, an 8px spacing scale, the type scale, 6/8/10/14px radii, and motion durations and easing curves.

## Accessibility

- A visible 2px focus ring on every interactive element, plus a "Skip to main content" link.
- Every form field has a visible label. Goal checkboxes are native inputs inside `<label>`s (styled, but operable with Space), and today's tile and the early-data tiles are progress bars with ARIA values.
- Sections are an ARIA tab list: ↑/↓ in the sidebar, ←/→ in the bottom bar. Each panel starts with a real `<h1>`.
- Every icon is decorative and hidden from screen readers. Icon-only buttons (month arrows, drag handles, close buttons, icon and colour choices) have an accessible name and a matching tooltip on hover or keyboard focus.
- Reordering works with the keyboard: focus a goal's handle and press ↑/↓ (or Home/End). Each move is announced.
- Calendar days are buttons labelled with the date and how it went; future days aren't focusable. Locked In days also show a check, so the calendar never relies on colour alone. Day details open beside the calendar on wide screens (Escape closes them and returns focus to the day) and in a bottom sheet on phones.
- Charts: the daily chart is keyboard-readable (focus it and use ←/→) and has a **Data table**. The weekday chart prints every value. Each Goal history grid has a text summary for screen readers ("done on 43 of 45 days it was due"), a legend, and day-by-day details on hover; the dropdown is a button with `aria-expanded`.
- Screen-reader announcements go through a polite live region (goal done, day locked in, goal changes, moves, import results); errors use `role="alert"`.
- All dialogs (Edit goals, the goal form, day details, confirmations) are native modal `<dialog>`s: focus is trapped, Escape closes, and focus returns to what opened them. Destructive confirmations start on **Cancel**.
- Colour pairs meet WCAG 2.1 AA in both themes: text 4.5:1 or better on every surface, and 3:1 or better for focus rings, control borders, calendar marks and goal icons (checked with a script).
- Works from 320px wide, at 200% zoom and up to wide desktops without horizontal scrolling, and the fixed navigation never covers content. Animations are short and subtle, and are switched off with `prefers-reduced-motion`. Windows high-contrast mode keeps ticks, bars and Locked In days visible.

## Project structure

```
index.html          Markup: navigation, Today / Stats / Settings, goal editor, goal form,
                    day details sheet, confirmation dialog
icon.svg            App icon (favicon and install icon)
manifest.webmanifest  Install metadata and the "Check in today" shortcut
sw.js               Service worker: caches the app for offline use
fonts/              Instrument Sans (variable, Latin) and its licence (OFL)
css/styles.css      All styles; design tokens (light and dark) at the top
js/icons.js         Bundled Lucide icons (ISC licence) and a tiny helper
js/plans.js         Free / Pro plan definitions and feature entitlements
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

`core.js`, `stats.js`, `plans.js`, `storage.js`, `sync.js` and `theme.js` are plain scripts. In the browser they attach `DayByDayCore`, `DayByDayStats`, `DayByDayPlans`, `DayByDayStorage`, `DayByDaySync` and `DayByDayTheme` to `window`, and in Node they export via `module.exports`. That is why the app works from `file://` without a bundler, and why the tests can `require()` the same files.
