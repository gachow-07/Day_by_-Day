/*
 * Day by Day — UI controller.
 *
 * Wires the DOM to the pure functions in core.js and the persistence in
 * storage.js. All business rules (dates, streaks, restarts, validation)
 * live in core.js; this file only renders state and handles events.
 */
(function () {
  'use strict';

  var core = window.DayByDayCore;
  var store = window.DayByDayStorage;

  var DEFAULT_HABITS = [
    'Follow a diet (no cheat meals, no alcohol)',
    'Two 45-minute workouts (one outdoors)',
    'Drink a gallon of water',
    'Read 10 pages of non-fiction',
    'Take a progress photo'
  ];

  var storage = safeLocalStorage();
  var state = core.emptyState();
  var readOnly = false;
  var today = core.toDateKey(new Date());
  var renderedHabitSignature = null;

  function $(id) {
    return document.getElementById(id);
  }

  function safeLocalStorage() {
    try {
      return window.localStorage;
    } catch (e) {
      return {
        getItem: function () { throw e; },
        setItem: function () { throw e; }
      };
    }
  }

  /* ---------------- Formatting ---------------- */

  function keyToLocalDate(key) {
    var p = key.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2], 12);
  }

  function formatDate(key, withWeekday) {
    var opts = { month: 'short', day: 'numeric', year: 'numeric' };
    if (withWeekday) {
      opts = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' };
    }
    return keyToLocalDate(key).toLocaleDateString(undefined, opts);
  }

  function plural(n, word) {
    return n + ' ' + word + (n === 1 ? '' : 's');
  }

  /* ---------------- Announcements & notices ---------------- */

  var statusTimer = null;
  function announce(message) {
    var el = $('status');
    el.textContent = '';
    clearTimeout(statusTimer);
    // A short delay makes screen readers treat repeated text as new.
    statusTimer = setTimeout(function () { el.textContent = message; }, 50);
  }

  function showNotice(message) {
    $('notice-text').textContent = message;
    $('notice').hidden = false;
  }

  function hideNotice() {
    $('notice').hidden = true;
    $('notice-text').textContent = '';
  }

  /* ---------------- Persistence ---------------- */

  /** Save and adopt a new state. Returns false (and changes nothing) on failure. */
  function commit(next) {
    if (readOnly) {
      showNotice('Saving is disabled on this device, so that change was not kept. See the message above for details.');
      return false;
    }
    try {
      store.save(storage, next);
    } catch (e) {
      showNotice('Could not save your progress: ' + e.message);
      return false;
    }
    state = next;
    render();
    return true;
  }

  function checkForNewDay() {
    var now = core.toDateKey(new Date());
    if (now !== today) {
      today = now;
      evaluate();
      render();
    }
  }

  function evaluate() {
    var r = core.evaluateMissedDays(state, today);
    if (r.restarted && commit(r.state)) {
      var last = r.state.attempts[r.state.attempts.length - 1];
      var msg = 'You missed ' + formatDate(r.missedDate, true) + ', so attempt ' + last.number + ' ended after ' +
        plural(last.daysCompleted, 'day') + '. Attempt ' + r.state.current.number + ' starts today at Day 1.';
      showNotice(msg);
    }
  }

  /* ---------------- Confirm dialog ---------------- */

  /**
   * Show a modal confirmation. Resolves true when confirmed.
   * The native <dialog> traps focus, closes on Escape and returns focus.
   */
  function confirmDialog(options) {
    var dialog = $('confirm-dialog');
    var opener = document.activeElement;
    $('confirm-title').textContent = options.title;
    var msg = $('confirm-message');
    msg.textContent = '';
    options.message.forEach(function (line) {
      var p = document.createElement('p');
      p.textContent = line;
      msg.appendChild(p);
    });
    var ok = $('confirm-ok');
    ok.textContent = options.confirmLabel;
    ok.className = 'btn ' + (options.danger ? 'btn-danger' : 'btn-primary');

    if (typeof dialog.showModal !== 'function') {
      return Promise.resolve(window.confirm(options.title + '\n\n' + options.message.join('\n')));
    }

    return new Promise(function (resolve) {
      function onClose() {
        dialog.removeEventListener('close', onClose);
        if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
        resolve(dialog.returnValue === 'confirm');
      }
      dialog.returnValue = '';
      dialog.addEventListener('close', onClose);
      dialog.showModal();
      $('confirm-cancel').focus();
    });
  }

  /* ---------------- Setup view ---------------- */

  function addHabitInput(value, focus) {
    var list = $('habit-inputs');
    if (list.children.length >= 20) {
      announce('You can add up to 20 habits.');
      return;
    }
    var li = document.createElement('li');
    var input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 120;
    input.autocomplete = 'off';
    input.value = value || '';
    input.className = 'habit-input';
    var remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-icon';
    remove.textContent = '✕';
    remove.addEventListener('click', function () {
      var next = li.nextElementSibling || li.previousElementSibling;
      li.remove();
      relabelHabitInputs();
      announce('Habit removed.');
      var target = next ? next.querySelector('input') : $('add-habit');
      target.focus();
    });
    li.appendChild(input);
    li.appendChild(remove);
    list.appendChild(li);
    relabelHabitInputs();
    if (focus) input.focus();
  }

  function relabelHabitInputs() {
    Array.prototype.forEach.call($('habit-inputs').children, function (li, i) {
      li.querySelector('input').setAttribute('aria-label', 'Habit ' + (i + 1));
      li.querySelector('button').setAttribute('aria-label', 'Remove habit ' + (i + 1));
    });
  }

  function resetSetupForm() {
    $('setup-form').reset();
    $('habit-inputs').textContent = '';
    DEFAULT_HABITS.forEach(function (h) { addHabitInput(h, false); });
    $('setup-errors').hidden = true;
  }

  function onSetupSubmit(event) {
    event.preventDefault();
    var input = {
      name: $('challenge-name').value,
      targetDays: Number($('challenge-days').value),
      habits: Array.prototype.map.call(document.querySelectorAll('.habit-input'), function (el) { return el.value; })
    };
    var errors = core.validateChallengeInput(input);
    var box = $('setup-errors');
    $('challenge-name').setAttribute('aria-invalid', String(!input.name.trim()));
    $('challenge-days').setAttribute('aria-invalid', String(errors.some(function (e) { return e.indexOf('Length') === 0; })));
    if (errors.length) {
      box.textContent = '';
      var ul = document.createElement('ul');
      errors.forEach(function (e) {
        var li = document.createElement('li');
        li.textContent = e;
        ul.appendChild(li);
      });
      box.appendChild(ul);
      box.hidden = false;
      box.focus();
      return;
    }
    box.hidden = true;
    if (commit(core.createChallenge(input, today))) {
      hideNotice();
      announce('Challenge started. Day 1 of ' + input.targetDays + '.');
      $('day-heading').focus();
    }
  }

  /* ---------------- Tracker view ---------------- */

  function buildHabitList() {
    var list = $('habit-list');
    list.textContent = '';
    state.challenge.habits.forEach(function (habit) {
      var li = document.createElement('li');
      var label = document.createElement('label');
      label.className = 'habit';
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.id = 'habit-' + habit.id;
      box.dataset.habitId = habit.id;
      var name = document.createElement('span');
      name.className = 'habit-name';
      name.textContent = habit.name;
      label.appendChild(box);
      label.appendChild(name);
      li.appendChild(label);
      list.appendChild(li);
    });
  }

  function onHabitChange(event) {
    var box = event.target;
    if (!box.dataset || !box.dataset.habitId) return;
    checkForNewDay();
    var r = core.setHabitChecked(state, box.dataset.habitId, box.checked, today);
    if (!r.ok) {
      box.checked = !box.checked;
      announce(r.message);
      return;
    }
    if (!commit(r.state)) {
      box.checked = !box.checked;
      return;
    }
    var done = core.checkedHabitIds(state, today).length;
    var total = state.challenge.habits.length;
    var name = box.parentNode.textContent;
    announce(name + (box.checked ? ' checked. ' : ' unchecked. ') + done + ' of ' + total + ' habits done.' +
      (done === total ? ' You can now complete the day.' : ''));
  }

  function onCompleteDay() {
    checkForNewDay();
    var r = core.completeDay(state, today);
    if (!r.ok) {
      announce(r.message);
      $('complete-hint').textContent = r.message;
      return;
    }
    if (!commit(r.state)) return;
    var n = core.currentStreak(state);
    if (r.challengeComplete) {
      announce('Day ' + n + ' complete. You finished the whole challenge!');
      $('new-attempt').focus();
    } else {
      announce('Day ' + n + ' complete. See you tomorrow for Day ' + (n + 1) + '.');
      $('day-heading').focus();
    }
  }

  function onReportFailure() {
    checkForNewDay();
    var cur = state.current;
    confirmDialog({
      title: 'Restart at Day 1?',
      message: [
        'This ends attempt ' + cur.number + ' with a streak of ' + plural(cur.completedDates.length, 'day') + '.',
        'Your history and best streak are kept. A new attempt starts today at Day 1.'
      ],
      confirmLabel: 'Restart at Day 1',
      danger: true
    }).then(function (confirmed) {
      if (!confirmed) {
        announce('Cancelled. Your streak is unchanged.');
        return;
      }
      var r = core.reportFailure(state, today);
      if (!r.ok) { announce(r.message); return; }
      if (commit(r.state)) {
        showNotice('Attempt ' + cur.number + ' ended. Attempt ' + state.current.number + ' starts today at Day 1.');
        announce('Restarted. Day 1 of attempt ' + state.current.number + '.');
        $('day-heading').focus();
      }
    });
  }

  function onNewAttempt() {
    var r = core.startNewAttempt(state, today);
    if (!r.ok) { announce(r.message); return; }
    if (commit(r.state)) {
      announce('New attempt started. Day 1.');
      $('day-heading').focus();
    }
  }

  function reasonText(a) {
    if (a.reason === 'completed') return 'Completed';
    if (a.reason === 'failed') return 'Reported failure on ' + formatDate(a.endedOn);
    return a.missedDate ? 'Missed ' + formatDate(a.missedDate) : 'Missed a day';
  }

  function renderHistory() {
    var list = $('history-list');
    list.textContent = '';
    var attempts = state.attempts.slice().reverse();
    $('history-empty').hidden = attempts.length > 0;
    attempts.forEach(function (a) {
      var li = document.createElement('li');
      var title = document.createElement('div');
      title.className = 'history-title';
      title.textContent = 'Attempt ' + a.number + ' · ' + plural(a.daysCompleted, 'day');
      var badge = document.createElement('span');
      badge.className = 'badge badge-' + a.reason;
      badge.textContent = a.reason === 'completed' ? 'Finished' : a.reason === 'failed' ? 'Failed' : 'Missed';
      title.appendChild(badge);
      var meta = document.createElement('div');
      meta.className = 'history-meta';
      var range = a.endDate ? formatDate(a.startDate) + ' – ' + formatDate(a.endDate) : 'Started ' + formatDate(a.startDate);
      meta.textContent = range + ' · ' + reasonText(a);
      li.appendChild(title);
      li.appendChild(meta);
      list.appendChild(li);
    });
  }

  function renderTracker() {
    var c = state.challenge;
    var cur = state.current;
    var signature = JSON.stringify(c.habits);
    if (signature !== renderedHabitSignature) {
      buildHabitList();
      renderedHabitSignature = signature;
    }

    var finished = cur.status === 'completed';
    var completedToday = core.isDayCompleted(state, today);
    var day = finished ? cur.completedDates.length : core.dayNumber(state, today);
    var streak = core.currentStreak(state);

    $('challenge-title').textContent = c.name;
    $('attempt-number').textContent = cur.number;
    var heading = $('day-heading');
    heading.setAttribute('tabindex', '-1');
    heading.textContent = 'Day ' + day + ' ';
    var of = document.createElement('span');
    of.className = 'of';
    of.textContent = 'of ' + c.targetDays;
    heading.appendChild(of);
    $('today-date').textContent = 'Today is ' + formatDate(today, true);

    var progress = $('progress');
    progress.setAttribute('aria-valuemax', String(c.targetDays));
    progress.setAttribute('aria-valuenow', String(streak));
    $('progress-bar').style.width = Math.min(100, (streak / c.targetDays) * 100) + '%';
    $('progress-label').textContent = streak + ' of ' + plural(c.targetDays, 'day') + ' completed';

    $('active-panel').hidden = finished;
    $('finished-panel').hidden = !finished;
    $('report-failure').hidden = finished;
    if (finished) {
      $('finished-text').textContent = 'You completed all ' + plural(c.targetDays, 'day') + ' of ' + c.name +
        ', finishing on ' + formatDate(cur.completedDates[cur.completedDates.length - 1]) + '.';
    }

    var checked = core.checkedHabitIds(state, today);
    Array.prototype.forEach.call(document.querySelectorAll('#habit-list input'), function (box) {
      var on = checked.indexOf(box.dataset.habitId) >= 0;
      box.checked = on;
      box.disabled = completedToday || finished;
      box.parentNode.classList.toggle('is-done', on);
    });

    var btn = $('complete-day');
    var hint = $('complete-hint');
    var remaining = c.habits.length - checked.length;
    if (completedToday) {
      btn.textContent = 'Day ' + day + ' complete ✓';
      btn.disabled = true;
      hint.textContent = 'Nice work. Come back tomorrow for Day ' + (day + 1) + '.';
    } else {
      btn.textContent = 'Complete Day ' + day;
      btn.disabled = remaining > 0;
      hint.textContent = remaining > 0
        ? 'Check off ' + (remaining === c.habits.length ? 'all ' + c.habits.length : remaining + ' more') +
          (remaining === 1 ? ' habit' : ' habits') + ' to complete today.'
        : 'All habits done. Complete the day to keep your streak.';
    }

    $('stat-current').textContent = streak;
    $('stat-best').textContent = core.bestStreak(state);
    $('stat-attempts').textContent = cur.number;
    renderHistory();
  }

  function render() {
    var hasChallenge = !!state.challenge;
    var setupWasHidden = $('setup-view').hidden;
    $('setup-view').hidden = hasChallenge;
    $('today-view').hidden = !hasChallenge;
    $('reset-data').hidden = !hasChallenge;
    $('export-data').disabled = !hasChallenge && state.attempts.length === 0;
    if (hasChallenge) {
      renderTracker();
    } else {
      renderedHabitSignature = null;
      if (setupWasHidden || !$('habit-inputs').children.length) resetSetupForm();
    }
  }

  /* ---------------- Export / import / reset ---------------- */

  function onExport() {
    var doc = core.buildExport(state, new Date());
    var blob = new Blob([JSON.stringify(doc, null, 2) + '\n'], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = core.exportFileName(today);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    announce('Backup downloaded as ' + a.download + '.');
  }

  function showImportError(message) {
    var box = $('import-error');
    box.textContent = '';
    var p = document.createElement('p');
    p.textContent = 'Import failed: ' + message + ' Your current data has not been changed.';
    box.appendChild(p);
    box.hidden = false;
  }

  function onImportFile() {
    var input = $('import-file');
    var file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    $('import-error').hidden = true;
    if (file.size > 5 * 1024 * 1024) {
      showImportError('The file is too large to be a Day by Day backup.');
      $('import-data').focus();
      return;
    }
    readFileText(file).then(function (text) {
      var parsed = core.parseImport(text);
      if (!parsed.ok) {
        showImportError(parsed.message);
        $('import-data').focus();
        return;
      }
      var s = parsed.state;
      var summary = s.challenge
        ? ['“' + s.challenge.name + '”: attempt ' + s.current.number + ', ' + plural(s.current.completedDates.length, 'day') +
            ' in the current streak, ' + plural(s.attempts.length, 'previous attempt') + ', best streak ' + core.bestStreak(s) + '.']
        : ['The file contains no active challenge.'];
      summary.push(state.challenge
        ? 'This replaces your current challenge and all of its history on this device.'
        : 'This will be saved on this device.');
      $('import-data').focus();
      return confirmDialog({
        title: 'Replace your data?',
        message: summary,
        confirmLabel: 'Replace data',
        danger: !!state.challenge
      }).then(function (confirmed) {
        if (!confirmed) {
          announce('Import cancelled. Nothing was changed.');
          return;
        }
        if (commit(s)) {
          hideNotice();
          announce('Import complete.');
          evaluate();
        }
      });
    }, function () {
      showImportError('The file could not be read.');
    });
  }

  function readFileText(file) {
    if (typeof file.text === 'function') return file.text();
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result)); };
      reader.onerror = reject;
      reader.readAsText(file);
    });
  }

  function onReset() {
    confirmDialog({
      title: 'Delete everything?',
      message: [
        'This permanently deletes “' + state.challenge.name + '”, every attempt and your best streak from this device.',
        'Export a backup first if you might want it back.'
      ],
      confirmLabel: 'Delete everything',
      danger: true
    }).then(function (confirmed) {
      if (!confirmed) {
        announce('Cancelled. Nothing was deleted.');
        return;
      }
      if (commit(core.emptyState())) {
        hideNotice();
        announce('Challenge deleted.');
        $('challenge-name').focus();
      }
    });
  }

  /* ---------------- Start-up ---------------- */

  function init() {
    var loaded = store.load(storage, new Date());
    state = loaded.state;
    readOnly = loaded.readOnly;
    if (loaded.notice) showNotice(loaded.notice);

    $('setup-form').addEventListener('submit', onSetupSubmit);
    $('add-habit').addEventListener('click', function () { addHabitInput('', true); });
    $('habit-list').addEventListener('change', onHabitChange);
    $('complete-day').addEventListener('click', onCompleteDay);
    $('report-failure').addEventListener('click', onReportFailure);
    $('new-attempt').addEventListener('click', onNewAttempt);
    $('export-data').addEventListener('click', onExport);
    $('import-data').addEventListener('click', function () { $('import-file').click(); });
    $('import-file').addEventListener('change', onImportFile);
    $('reset-data').addEventListener('click', onReset);
    $('notice-dismiss').addEventListener('click', function () {
      hideNotice();
      $('main').focus();
    });

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) checkForNewDay();
    });
    window.addEventListener('focus', checkForNewDay);
    setInterval(checkForNewDay, 30 * 1000);

    evaluate();
    render();
  }

  init();
})();
