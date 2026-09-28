# Day by Day

A lightweight, mobile-friendly habit challenge tracker inspired by 75 Hard.

Create a challenge with a list of daily habits. **Every habit must be completed every calendar day.** If you miss a full day, or report a failure yourself, the current attempt restarts at Day 1. Previous attempts and your best streak stay visible.

- Plain HTML, CSS and JavaScript. No framework, no build step, no runtime dependencies.
- Works offline. Data is stored only in your browser's `localStorage`.
- No accounts, analytics, payments or cloud sync.

## Running the app

You need only a modern browser. Pick either option:

1. **Open the file directly:** double-click `index.html`, or open it with your browser's *File → Open*.
2. **Use the bundled dev server** (Node.js 18 or later, no `npm install` needed):

   ```sh
   npm start            # http://127.0.0.1:8000/
   PORT=8080 npm start  # choose another port
   ```

To use it on a phone, host the folder on any static web host (GitHub Pages, Netlify, etc.). There is nothing to build.

## How it works

| Situation | What happens |
| --- | --- |
| You check off every habit and press **Complete Day N** | The day is recorded and your streak goes up by one. |
| You press complete again on the same date | Nothing changes. Each date can only be completed once. |
| You open the app the day after a completed day | You are on the next day, with all habits unchecked. |
| A whole calendar day passes without being completed | The next time you open the app, the attempt ends ("Missed") and a new attempt starts today at Day 1. |
| You press **I missed a habit today** and confirm | The attempt ends ("Failed") and a new attempt starts today at Day 1. |
| You complete the final day | The challenge is marked complete. **Start a new attempt** begins again. |

Your best streak is the longest run of completed days across all attempts, and it is never lowered by a restart. Days are the device's local calendar days. If the clock is set backwards, the app neither restarts nor records anything.

## Testing

Tests use Node's built-in test runner, so nothing needs to be installed.

```sh
npm test         # run the unit tests
npm run check    # syntax-check every script
npm run validate # both of the above
```

The tests in `tests/` cover:

- completing a normal day, and being blocked until every habit is checked
- preventing duplicate completion on the same date
- opening the app the day after a completed day
- restarting after a full missed calendar day
- manual failure and restart
- best-streak preservation across restarts
- month and year boundaries, daylight saving changes, and leap years (including skipping Feb 29)
- malformed saved data (bad JSON, wrong types, impossible dates, broken invariants, blocked storage)
- migrating older saved data, and export/import validation

## Backing up your data

Everything lives in this browser only. Clearing site data, or switching browser or device, will lose it unless you have a backup.

- **Export data** downloads `day-by-day-backup-YYYY-MM-DD.json`. The file holds the challenge, the current attempt, every previous attempt, the best streak and a `schemaVersion`.
- **Import data** loads a backup file. The file is fully checked **before anything is saved**:
  - Files that aren't JSON, weren't made by Day by Day, lack `schemaVersion`, come from a newer version, or contain inconsistent history are rejected with an explanation. Your current data is not touched.
  - For a valid file, the app shows a summary and asks you to confirm before it replaces your current data.
  - After an import, missed-day rules are applied, so an old backup may begin a new attempt.

### Saved-data format and migrations

Data is stored under the `localStorage` key `day-by-day` as JSON with a `schemaVersion` field. The current version is **2**.

- Data without a `schemaVersion` is treated as version 1, the unversioned prototype format, and upgraded automatically. The original is first copied to `day-by-day.backup.v1.<timestamp>`.
- Saved data that can't be read is copied to `day-by-day.backup.unreadable.<timestamp>` and left in place. The app then offers to start fresh or import a backup.
- If the data comes from a *newer* version of the app, it is left untouched and saving is disabled.

To change the format: bump `SCHEMA_VERSION` in `js/core.js`, add a step to `MIGRATIONS`, update `validateState`, and add tests.

## Accessibility

- A visible focus ring (3px, high-contrast blue) on every interactive element, plus a "Skip to main content" link.
- Every control has a real label. Habit checkboxes are native inputs inside `<label>`s, and the progress bar has ARIA values.
- Screen-reader announcements go through a polite live region (habit checked, day complete, restart, import results). Errors use `role="alert"`.
- Confirmations use the native modal `<dialog>`. It traps focus, starts on **Cancel**, closes with Escape, and returns focus to the button that opened it.
- Colour pairs meet WCAG 2.1 AA: body text is 14.9:1 or higher, muted text 6.4:1, white on green buttons 6.5:1, red danger text 7.3:1, the focus ring 6:1, and control borders 4.1:1.
- The layout works at 320px width, and motion is reduced when `prefers-reduced-motion` is set.

## Project structure

```
index.html          Markup for every view and the confirmation dialog
icon.svg            Favicon
css/styles.css      All styles (colour tokens at the top)
js/core.js          Pure logic: dates, streaks, completion, restarts,
                    validation, migrations, import/export (no DOM, no storage)
js/storage.js       localStorage load/save, migration on load, corrupt-data backup
js/app.js           UI controller: renders state and wires up events
scripts/serve.js    Optional zero-dependency static server (npm start)
tests/              node:test suites and helpers (a fake localStorage)
package.json        npm scripts only; there are no dependencies
```

`core.js` and `storage.js` are plain scripts. In the browser they attach `DayByDayCore` and `DayByDayStorage` to `window`, and in Node they export via `module.exports`. That is why the app works from `file://` without a bundler, and why the tests can `require()` the same files.
