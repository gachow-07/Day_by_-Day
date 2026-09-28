/*
 * Day by Day — UI controller.
 *
 * Wires the DOM to the pure functions in core.js (habits and daily records),
 * stats.js (every number shown) and storage.js / sync.js / cloud.js
 * (persistence). This file only renders state and handles events.
 */
(function () {
  'use strict';

  var core = window.DayByDayCore;
  var stats = window.DayByDayStats;
  var store = window.DayByDayStorage;
  var sync = window.DayByDaySync;
  var cloud = window.DayByDayCloud;

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var RANGES = { '7': 7, '30': 30, '90': 90, all: 'all' };

  var storage = safeLocalStorage();
  var state = core.emptyState();
  var readOnly = false;
  var today = core.toDateKey(new Date());
  var activeTab = 'today';
  var statsStale = true;
  var chartRange = '30';
  var calMonth = null; // { y, m }
  var selectedDate = null;
  var renderedGoalSignature = null;
  var wasLockedIn = null;

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function svg(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) node.setAttribute(k, attrs[k]);
    return node;
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

  var DATE_STYLES = {
    long: { weekday: 'long', month: 'long', day: 'numeric' },
    day: { month: 'long', day: 'numeric' },
    short: { month: 'short', day: 'numeric' },
    full: { month: 'short', day: 'numeric', year: 'numeric' },
    weekday: { weekday: 'narrow' }
  };

  function formatDate(key, style) {
    return keyToLocalDate(key).toLocaleDateString(undefined, DATE_STYLES[style || 'full']);
  }

  function formatMonth(y, m) {
    return new Date(y, m - 1, 1, 12).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  function plural(n, word) {
    return n + ' ' + word + (n === 1 ? '' : 's');
  }

  /* ---------------- Announcements & notices ---------------- */

  var statusTimer = null;
  function announce(message) {
    var node = $('status');
    node.textContent = '';
    clearTimeout(statusTimer);
    // A short delay makes screen readers treat repeated text as new.
    statusTimer = setTimeout(function () { node.textContent = message; }, 50);
  }

  var noticeAction = null;

  /** Show the notice banner, optionally with one action button { label, run }. */
  function showNotice(message, action) {
    $('notice-text').textContent = message;
    noticeAction = action || null;
    var btn = $('notice-action');
    btn.hidden = !noticeAction;
    btn.textContent = noticeAction ? noticeAction.label : '';
    $('notice').hidden = false;
  }

  function hideNotice() {
    $('notice').hidden = true;
    $('notice-text').textContent = '';
    noticeAction = null;
    $('notice-action').hidden = true;
  }

  /* ---------------- Persistence ---------------- */

  /**
   * Save and adopt a new state. Returns false (and changes nothing) on failure.
   * opts.auto marks changes the app makes by itself (filling in missed days):
   * those are not pushed to the account, because every device works them
   * out the same way, and a device that is behind must not overwrite newer
   * progress from another device.
   */
  function commit(next, opts) {
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
    statsStale = true;
    render();
    if (!(opts && opts.auto)) cloudChanged();
    return true;
  }

  function checkForNewDay() {
    var now = core.toDateKey(new Date());
    if (now !== today) {
      today = now;
      calMonth = null;
      refreshDays();
      statsStale = true;
      render();
    }
  }

  /**
   * Bring daily records up to today: create today's record and record any
   * days the app wasn't opened as missed.
   */
  function refreshDays() {
    var r = core.ensureDays(state, today);
    if (!r.changed) return;
    if (waitingForAccount && r.missed.length) {
      // Fill in missed days only once the account's latest copy has arrived.
      evaluatePending = true;
      return;
    }
    // The streak as it looked on the last day the app was used (that day
    // still "in progress"), so we can explain if it has now ended.
    var earlier = core.sortedDates(state).filter(function (d) { return d < today; });
    var lastDay = earlier.length ? earlier[earlier.length - 1] : null;
    var before = lastDay ? stats.currentStreak(state, lastDay) : 0;
    if (!commit(r.state, { auto: true }) || before === 0 || stats.currentStreak(state, today) > 0) return;
    var why;
    if (r.missed.length) {
      why = 'You missed ' + (r.missed.length === 1
        ? formatDate(r.missed[0], 'long')
        : plural(r.missed.length, 'day') + ' since ' + formatDate(r.missed[0], 'short'));
    } else {
      var s = core.recordSummary(state.days[lastDay]);
      why = 'You finished ' + s.completed + ' of ' + s.total + ' goals on ' + formatDate(lastDay, 'long');
    }
    showNotice(why + ', so your ' + plural(before, 'day') + ' streak ended. It’s all still in Stats. Today is a fresh start.');
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


  /* ---------------- Tabs ---------------- */

  function selectTab(name, focus) {
    activeTab = name === 'stats' ? 'stats' : 'today';
    ['today', 'stats'].forEach(function (t) {
      var tab = $('tab-' + t);
      var on = t === activeTab;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      $('panel-' + t).hidden = !on;
    });
    if (focus) $('tab-' + activeTab).focus();
    try {
      history.replaceState(null, '', activeTab === 'stats' ? '#stats' : location.pathname + location.search);
    } catch (e) {
      // file:// pages may refuse; the tab still works.
    }
    if (activeTab === 'stats') renderStats();
    window.scrollTo(0, 0);
  }

  function onTabKey(event) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    var next = activeTab === 'today' ? 'stats' : 'today';
    if (event.key === 'Home') next = 'today';
    if (event.key === 'End') next = 'stats';
    selectTab(next, true);
  }

  /* ---------------- Today ---------------- */

  /** Today's record, or (while waiting for the account) a preview of it. */
  function todayRecord() {
    if (state.days[today]) return state.days[today];
    var active = core.activeHabits(state);
    return active.length ? { habits: active.map(function (h) { return { id: h.id, name: h.name }; }), done: [], preview: true } : null;
  }

  function buildGoalList(rec) {
    var list = $('goal-list');
    list.textContent = '';
    rec.habits.forEach(function (h) {
      var li = el('li');
      var label = el('label', 'goal');
      var box = el('input', 'goal-check');
      box.type = 'checkbox';
      box.id = 'goal-' + h.id;
      box.dataset.habitId = h.id;
      label.appendChild(box);
      label.appendChild(el('span', 'goal-box'));
      label.lastChild.setAttribute('aria-hidden', 'true');
      label.appendChild(el('span', 'goal-name', h.name));
      li.appendChild(label);
      list.appendChild(li);
    });
  }

  function renderToday() {
    var sum = stats.summary(state, today);
    var hasHabits = state.habits.length > 0;
    $('onboarding').hidden = hasHabits;
    $('streak-hero').hidden = !hasHabits;
    $('goals-card').hidden = !hasHabits;
    if (!hasHabits) {
      renderedGoalSignature = null;
      wasLockedIn = null;
      return;
    }

    $('streak-count').textContent = String(sum.currentStreak);
    $('streak-unit').textContent = sum.currentStreak === 1 ? 'Day' : 'Days';
    $('best-streak').textContent = plural(sum.bestStreak, 'day');
    $('streak-hero').setAttribute('aria-label', 'Locked In streak: ' + plural(sum.currentStreak, 'day') + '. Best: ' + plural(sum.bestStreak, 'day') + '.');
    $('today-date').textContent = formatDate(today, 'long');

    var rec = todayRecord();
    var card = $('goals-card');
    $('goals-empty').hidden = !!rec;
    $('goals-body').hidden = !rec;
    if (!rec) {
      renderedGoalSignature = null;
      card.classList.remove('is-locked');
      $('goals-status').textContent = 'No goals today';
      $('goals-hint').textContent = '';
      wasLockedIn = null;
      return;
    }

    var signature = JSON.stringify(rec.habits);
    if (signature !== renderedGoalSignature) {
      buildGoalList(rec);
      renderedGoalSignature = signature;
    }
    Array.prototype.forEach.call(document.querySelectorAll('#goal-list .goal-check'), function (box) {
      var done = rec.done.indexOf(box.dataset.habitId) >= 0;
      box.checked = done;
      box.parentNode.classList.toggle('is-done', done);
    });

    var s = core.recordSummary(rec);
    var bar = $('goals-progress');
    bar.setAttribute('aria-valuemax', String(s.total));
    bar.setAttribute('aria-valuenow', String(s.completed));
    bar.setAttribute('aria-valuetext', s.completed + ' of ' + s.total + ' goals completed');
    $('goals-progress-bar').style.width = (s.total ? (s.completed / s.total) * 100 : 0) + '%';
    $('goals-status').textContent = s.lockedIn ? 'LOCKED IN ✓' : s.completed + ' of ' + s.total + ' completed';
    card.classList.toggle('is-locked', s.lockedIn);
    $('goals-hint').textContent = s.lockedIn
      ? 'Every goal done. See you tomorrow.'
      : (s.total - s.completed) + ' to go to lock in today.';
    if (wasLockedIn === false && s.lockedIn) celebrate();
    wasLockedIn = s.lockedIn;
  }

  function celebrate() {
    var card = $('goals-card');
    var hero = $('streak-hero');
    card.classList.remove('celebrate');
    hero.classList.remove('celebrate');
    // Restart the animation even if it ran recently.
    void card.offsetWidth;
    card.classList.add('celebrate');
    hero.classList.add('celebrate');
    setTimeout(function () {
      card.classList.remove('celebrate');
      hero.classList.remove('celebrate');
    }, 1200);
  }

  function onGoalChange(event) {
    var box = event.target;
    if (!box.dataset || !box.dataset.habitId) return;
    checkForNewDay();
    if (holdForAccount() || !state.days[today]) {
      box.checked = !box.checked;
      return;
    }
    var r = core.setHabitDone(state, box.dataset.habitId, box.checked, today);
    if (!r.ok) {
      box.checked = !box.checked;
      announce(r.message);
      renderToday();
      return;
    }
    if (!commit(r.state)) {
      box.checked = !box.checked;
      return;
    }
    if (box.checked) {
      var row = box.parentNode;
      row.classList.remove('just-done');
      void row.offsetWidth;
      row.classList.add('just-done');
    }
    var s = core.recordSummary(state.days[today]);
    var name = box.parentNode.textContent;
    if (r.lockedIn) {
      announce('Locked in! All ' + s.total + ' goals done. Streak: ' + plural(stats.currentStreak(state, today), 'day') + '.');
    } else {
      announce(name + (box.checked ? ' done. ' : ' not done. ') + s.completed + ' of ' + s.total + ' completed.');
    }
  }

  /* ---------------- First goal (onboarding) ---------------- */

  function onFirstGoal(event) {
    event.preventDefault();
    var input = $('first-goal');
    var r = core.addHabit(state, input.value, today);
    var error = $('first-goal-error');
    if (!r.ok) {
      error.textContent = r.message;
      error.hidden = false;
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      return;
    }
    error.hidden = true;
    input.removeAttribute('aria-invalid');
    input.value = '';
    if (commit(r.state)) {
      announce('Added ' + core.findHabit(state, r.id).name + '. Add more goals with Edit.');
      $('edit-goals').focus();
    }
  }

  /* ---------------- Edit goals ---------------- */

  function openManage(focusAdd) {
    var dialog = $('goals-dialog');
    renderManage();
    $('manage-error').hidden = true;
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
    if (focusAdd || !state.habits.length) $('new-goal').focus();
    else $('manage-done').focus();
  }

  function closeManage() {
    var dialog = $('goals-dialog');
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else dialog.removeAttribute('open');
  }

  function manageError(message) {
    var box = $('manage-error');
    box.textContent = message || '';
    box.hidden = !message;
  }

  var ICONS = {
    up: 'M12 19V5M6 11l6-6 6 6',
    down: 'M12 5v14M6 13l6 6 6-6',
    pause: 'M9 5v14M15 5v14',
    remove: 'M6 6l12 12M18 6L6 18'
  };

  function iconButton(action, id, text, label, disabled) {
    var b = el('button', 'icon-btn');
    if (ICONS[action]) {
      var icon = svg('svg', { viewBox: '0 0 24 24', width: '18', height: '18', 'aria-hidden': 'true', focusable: 'false' });
      icon.appendChild(svg('path', { d: ICONS[action], fill: 'none', stroke: 'currentColor', 'stroke-width': '2.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      b.appendChild(icon);
    } else {
      b.textContent = text;
    }
    b.type = 'button';
    b.dataset.action = action;
    b.dataset.id = id;
    b.setAttribute('aria-label', label);
    b.title = label;
    if (disabled) b.disabled = true;
    return b;
  }

  function textButton(action, id, text, label, extra) {
    var b = el('button', 'btn btn-small ' + (extra || 'btn-secondary'), text);
    b.type = 'button';
    b.dataset.action = action;
    b.dataset.id = id;
    b.setAttribute('aria-label', label);
    return b;
  }

  function renderManage() {
    var groups = { active: [], paused: [], archived: [] };
    state.habits.forEach(function (h) { groups[h.status].push(h); });

    var active = $('manage-active');
    active.textContent = '';
    groups.active.forEach(function (h, i) {
      var li = el('li', 'manage-row');
      var input = el('input', 'manage-name');
      input.type = 'text';
      input.maxLength = 120;
      input.value = h.name;
      input.dataset.id = h.id;
      input.setAttribute('aria-label', 'Name of goal ' + (i + 1));
      input.autocomplete = 'off';
      li.appendChild(input);
      var tools = el('div', 'manage-tools');
      tools.appendChild(iconButton('up', h.id, '↑', 'Move ' + h.name + ' up', i === 0));
      tools.appendChild(iconButton('down', h.id, '↓', 'Move ' + h.name + ' down', i === groups.active.length - 1));
      tools.appendChild(iconButton('pause', h.id, '⏸', 'Pause ' + h.name));
      tools.appendChild(iconButton('remove', h.id, '✕', 'Remove ' + h.name));
      li.appendChild(tools);
      active.appendChild(li);
    });
    $('manage-active-empty').hidden = groups.active.length > 0;

    var paused = $('manage-paused');
    paused.textContent = '';
    groups.paused.forEach(function (h) {
      var li = el('li', 'manage-row is-inactive');
      li.appendChild(el('span', 'manage-label', h.name));
      var tools = el('div', 'manage-tools');
      tools.appendChild(textButton('resume', h.id, 'Resume', 'Resume ' + h.name));
      tools.appendChild(iconButton('remove', h.id, '✕', 'Remove ' + h.name));
      li.appendChild(tools);
      paused.appendChild(li);
    });
    $('manage-paused-section').hidden = groups.paused.length === 0;

    var archived = $('manage-archived');
    archived.textContent = '';
    groups.archived.forEach(function (h) {
      var li = el('li', 'manage-row is-inactive');
      var label = el('span', 'manage-label', h.name);
      label.appendChild(el('span', 'manage-sub', ' · archived ' + formatDate(h.archivedOn, 'short')));
      li.appendChild(label);
      var tools = el('div', 'manage-tools');
      tools.appendChild(textButton('restore', h.id, 'Restore', 'Restore ' + h.name));
      li.appendChild(tools);
      archived.appendChild(li);
    });
    $('manage-archived-section').hidden = groups.archived.length === 0;
    $('manage-archived-count').textContent = String(groups.archived.length);
  }

  /** Apply a habit change from the Edit sheet, then keep focus sensible. */
  function applyManage(r, message, focusKey) {
    if (!r.ok) {
      manageError(r.message);
      return false;
    }
    manageError('');
    if (!commit(r.state)) return false;
    renderManage();
    if (message) announce(message);
    var target = focusKey && document.querySelector('#goals-dialog [data-action="' + focusKey[0] + '"][data-id="' + focusKey[1] + '"]:not(:disabled)');
    if (target) target.focus();
    else if (!document.activeElement || !$('goals-dialog').contains(document.activeElement) || document.activeElement === document.body) $('new-goal').focus();
    return true;
  }

  function onAddGoal(event) {
    event.preventDefault();
    checkForNewDay();
    var input = $('new-goal');
    var r = core.addHabit(state, input.value, today);
    if (applyManage(r, r.ok ? 'Added ' + core.cleanName(input.value) + '.' : '')) {
      input.value = '';
      input.focus();
    }
  }

  function onRename(event) {
    var input = event.target;
    if (!input.classList.contains('manage-name')) return;
    var h = core.findHabit(state, input.dataset.id);
    if (!h || core.cleanName(input.value) === h.name) {
      if (h) input.value = h.name;
      return;
    }
    var r = core.renameHabit(state, h.id, input.value, today);
    if (!r.ok) {
      manageError(r.message);
      input.value = h.name;
      return;
    }
    manageError('');
    if (commit(r.state)) announce('Renamed to ' + core.findHabit(state, h.id).name + '. Past days keep the old name.');
  }

  function onManageClick(event) {
    var btn = event.target.closest('button[data-action]');
    if (!btn || btn.disabled) return;
    checkForNewDay();
    var id = btn.dataset.id;
    var h = core.findHabit(state, id);
    if (!h) return;
    var action = btn.dataset.action;
    if (action === 'up' || action === 'down') {
      var dir = action === 'up' ? -1 : 1;
      applyManage(core.moveHabit(state, id, dir, today), 'Moved ' + h.name + ' ' + action + '.', [action, id]);
    } else if (action === 'pause') {
      applyManage(core.setHabitStatus(state, id, 'paused', today), h.name + ' paused. It no longer counts from today.', ['resume', id]);
    } else if (action === 'resume') {
      applyManage(core.setHabitStatus(state, id, 'active', today), h.name + ' is active again from today.', ['pause', id]);
    } else if (action === 'restore') {
      applyManage(core.setHabitStatus(state, id, 'active', today), h.name + ' restored. It counts again from today.', ['pause', id]);
    } else if (action === 'remove') {
      removeGoal(h);
    }
  }

  function removeGoal(h) {
    var history = core.habitHistoryDates(state, h.id, today).length;
    var options = history
      ? {
          title: 'Archive “' + h.name + '”?',
          message: [
            'It has ' + plural(history, 'day') + ' of history, so it will be archived rather than deleted.',
            'Past days and stats keep it. You can restore it any time.'
          ],
          confirmLabel: 'Archive'
        }
      : {
          title: 'Delete “' + h.name + '”?',
          message: ['It has no history yet, so it will be removed completely.'],
          confirmLabel: 'Delete',
          danger: true
        };
    confirmDialog(options).then(function (ok) {
      if (!ok) return;
      var r = history ? core.setHabitStatus(state, h.id, 'archived', today) : core.deleteHabit(state, h.id, today);
      applyManage(r, history ? h.name + ' archived. Its history stays in Stats.' : h.name + ' deleted.');
    });
  }


  /* ---------------- Stats ---------------- */

  var STATE_LABELS = {
    locked: 'Locked In',
    partial: 'Partly done',
    missed: 'Nothing done',
    none: 'Not tracked',
    pending: 'In progress',
    future: 'Upcoming'
  };

  function renderStats() {
    if (activeTab !== 'stats') return;
    statsStale = false;
    var sum = stats.summary(state, today);
    var hasData = sum.totalTrackedDays > 0;
    $('stat-current').textContent = plural(sum.currentStreak, 'day');
    $('stat-best').textContent = plural(sum.bestStreak, 'day');
    $('stat-total').textContent = String(sum.totalLockedInDays);
    $('stat-total-sub').textContent = 'of ' + plural(sum.totalTrackedDays, 'tracked day');
    $('stat-rate').textContent = sum.completionRate + '%';
    $('stats-empty').hidden = hasData;
    $('analytics').hidden = !hasData;
    renderCalendar(sum);
    if (hasData) {
      renderDailyChart();
      renderHabitChart();
      renderHabitStats();
    }
  }

  /* Calendar */

  function monthOf(key) {
    return { y: Number(key.slice(0, 4)), m: Number(key.slice(5, 7)) };
  }

  function monthIndex(mo) {
    return mo.y * 12 + (mo.m - 1);
  }

  function renderCalendar(sum) {
    var now = monthOf(today);
    var first = sum.firstDay ? monthOf(sum.firstDay) : now;
    if (!calMonth) calMonth = now;
    if (monthIndex(calMonth) > monthIndex(now)) calMonth = now;
    if (monthIndex(calMonth) < monthIndex(first)) calMonth = first;
    $('cal-title').textContent = formatMonth(calMonth.y, calMonth.m);
    $('cal-prev').disabled = monthIndex(calMonth) <= monthIndex(first);
    $('cal-next').disabled = monthIndex(calMonth) >= monthIndex(now);

    var grid = $('cal-grid');
    grid.textContent = '';
    var weeks = stats.monthGrid(state, calMonth.y, calMonth.m, today);
    weeks[0].forEach(function (cell) {
      var head = el('div', 'cal-dow', formatDate(cell.date, 'weekday'));
      head.setAttribute('aria-hidden', 'true');
      grid.appendChild(head);
    });
    weeks.forEach(function (week) {
      week.forEach(function (cell) {
        if (!cell.inMonth) {
          grid.appendChild(el('div', 'cal-cell is-outside'));
          return;
        }
        var classes = 'cal-cell is-' + cell.state + (cell.isToday ? ' is-today' : '') + (cell.date === selectedDate ? ' is-selected' : '');
        var node;
        if (cell.state === 'future') {
          node = el('div', classes);
          node.setAttribute('aria-hidden', 'true');
        } else {
          node = el('button', classes);
          node.type = 'button';
          node.dataset.date = cell.date;
          node.setAttribute('aria-pressed', String(cell.date === selectedDate));
          var rec = state.days[cell.date];
          var detail = rec && rec.habits.length ? ', ' + rec.done.length + ' of ' + rec.habits.length + ' goals' : '';
          node.setAttribute('aria-label', formatDate(cell.date, 'day') + (cell.isToday ? ' (today)' : '') + ': ' + STATE_LABELS[cell.state] + detail);
        }
        node.appendChild(el('span', 'cal-num', String(cell.day)));
        if (cell.state === 'locked') {
          var mark = el('span', 'cal-mark', '✓');
          mark.setAttribute('aria-hidden', 'true');
          node.appendChild(mark);
        }
        grid.appendChild(node);
      });
    });
    renderDayDetail();
  }

  function onCalendarClick(event) {
    var btn = event.target.closest('button[data-date]');
    if (!btn) return;
    selectedDate = selectedDate === btn.dataset.date ? null : btn.dataset.date;
    renderCalendar(stats.summary(state, today));
    var again = document.querySelector('#cal-grid button[data-date="' + btn.dataset.date + '"]');
    if (again) again.focus();
  }

  function moveMonth(delta) {
    var i = monthIndex(calMonth) + delta;
    calMonth = { y: Math.floor(i / 12), m: (i % 12) + 1 };
    selectedDate = null;
    renderCalendar(stats.summary(state, today));
    announce(formatMonth(calMonth.y, calMonth.m));
  }

  function renderDayDetail() {
    var box = $('day-detail');
    box.textContent = '';
    if (!selectedDate || selectedDate.slice(0, 7) !== calMonth.y + '-' + (calMonth.m < 10 ? '0' : '') + calMonth.m) {
      box.hidden = true;
      return;
    }
    var d = stats.dayDetail(state, selectedDate, today);
    box.hidden = false;
    var head = el('div', 'detail-head');
    head.appendChild(el('h3', 'detail-title', formatDate(selectedDate, 'day') + (selectedDate === today ? ' · Today' : '')));
    var close = el('button', 'icon-btn', '✕');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close day details');
    close.addEventListener('click', function () {
      var date = selectedDate;
      selectedDate = null;
      renderCalendar(stats.summary(state, today));
      var cell = document.querySelector('#cal-grid button[data-date="' + date + '"]');
      if (cell) cell.focus();
    });
    head.appendChild(close);
    box.appendChild(head);
    if (!d.total) {
      box.appendChild(el('p', 'muted', 'No goals were tracked on this day.'));
      return;
    }
    box.appendChild(el('p', 'detail-sub', d.completed + ' / ' + d.total + ' Goals Completed' + (d.lockedIn ? ' · Locked In ✓' : '')));
    var ul = el('ul', 'detail-list');
    d.items.forEach(function (item) {
      var li = el('li', item.done ? 'is-done' : 'is-missed');
      var mark = el('span', 'detail-mark', item.done ? '✓' : '✗');
      mark.setAttribute('aria-hidden', 'true');
      li.appendChild(mark);
      li.appendChild(el('span', '', item.name));
      li.appendChild(el('span', 'visually-hidden', item.done ? ' (done)' : ' (not done)'));
      ul.appendChild(li);
    });
    box.appendChild(ul);
  }

  /* Chart 1: daily completion */

  var dailyPoints = [];
  var dailyFocus = -1;

  function renderDailyChart() {
    var wrap = $('chart-daily');
    var series = stats.dailySeries(state, today, RANGES[chartRange]);
    dailyPoints = series;
    dailyFocus = -1;
    wrap.textContent = '';
    hideTooltip();

    var W = Math.max(260, Math.floor(wrap.clientWidth || 320));
    var H = 180;
    var pad = { l: 38, r: 8, t: 10, b: 24 };
    var pw = W - pad.l - pad.r;
    var ph = H - pad.t - pad.b;
    var n = series.length;
    var band = pw / n;
    var asBars = n <= 31;

    var tracked = series.filter(function (p) { return p.percentage !== null; });
    var avg = tracked.length ? Math.round(tracked.reduce(function (a, p) { return a + p.percentage; }, 0) / tracked.length) : 0;
    var locked = tracked.filter(function (p) { return p.lockedIn; }).length;
    var rangeText = chartRange === 'all' ? 'all time' : 'the last ' + n + ' days';
    $('chart-daily-caption').textContent = tracked.length
      ? 'Average ' + avg + '% over ' + plural(tracked.length, 'tracked day') + ' · ' + locked + ' Locked In'
      : 'No tracked days in this range yet.';

    var root = svg('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, class: 'chart-svg', role: 'img', tabindex: '0',
      'aria-label': 'Daily completion for ' + rangeText + '. ' + $('chart-daily-caption').textContent + '. Use the arrow keys to read each day, or open the data table below.' });

    [0, 50, 100].forEach(function (v) {
      var y = pad.t + ph - (v / 100) * ph;
      root.appendChild(svg('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y, class: 'chart-grid' }));
      var t = svg('text', { x: pad.l - 6, y: y + 4, class: 'chart-axis', 'text-anchor': 'end' });
      t.textContent = v + '%';
      root.appendChild(t);
    });

    var xOf = function (i) { return pad.l + band * i + band / 2; };
    var yOf = function (pct) { return pad.t + ph - (pct / 100) * ph; };
    var marks = svg('g', {});
    root.appendChild(marks);

    if (asBars) {
      var bw = Math.max(2, Math.min(24, band - 2));
      series.forEach(function (p, i) {
        if (p.percentage === null) return;
        var x = xOf(i) - bw / 2;
        var base = pad.t + ph;
        if (p.percentage === 0) {
          marks.appendChild(svg('rect', { x: x, y: base - 2, width: bw, height: 2, class: 'chart-zero', 'data-i': i }));
          return;
        }
        var top = yOf(p.percentage);
        var r = Math.min(4, bw / 2, base - top);
        var d = 'M' + x + ',' + base + 'V' + (top + r) + 'Q' + x + ',' + top + ' ' + (x + r) + ',' + top +
          'H' + (x + bw - r) + 'Q' + (x + bw) + ',' + top + ' ' + (x + bw) + ',' + (top + r) + 'V' + base + 'Z';
        marks.appendChild(svg('path', { d: d, class: 'chart-bar', 'data-i': i }));
      });
    } else {
      var line = '';
      var area = '';
      var runStart = null;
      series.forEach(function (p, i) {
        if (p.percentage === null) {
          if (runStart !== null) area += 'L' + xOf(i - 1) + ',' + (pad.t + ph) + 'Z';
          runStart = null;
          return;
        }
        var x = xOf(i);
        var y = yOf(p.percentage);
        if (runStart === null) {
          line += 'M' + x + ',' + y;
          area += 'M' + x + ',' + (pad.t + ph) + 'L' + x + ',' + y;
          runStart = i;
        } else {
          line += 'L' + x + ',' + y;
          area += 'L' + x + ',' + y;
        }
      });
      if (runStart !== null) area += 'L' + xOf(n - 1) + ',' + (pad.t + ph) + 'Z';
      marks.appendChild(svg('path', { d: area, class: 'chart-area' }));
      marks.appendChild(svg('path', { d: line, class: 'chart-line' }));
    }

    // X labels: first, middle and last day (every day for a week).
    var labelIdx = n <= 7 ? series.map(function (_, i) { return i; }) : [0, Math.floor((n - 1) / 2), n - 1];
    labelIdx.forEach(function (i) {
      var anchor = n <= 7 ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
      var x = n <= 7 ? xOf(i) : i === 0 ? pad.l : i === n - 1 ? W - pad.r : xOf(i);
      var t = svg('text', { x: x, y: H - 6, class: 'chart-axis', 'text-anchor': anchor });
      t.textContent = n <= 7 ? formatDate(series[i].date, 'weekday') : (series[i].date === today ? 'Today' : formatDate(series[i].date, 'short'));
      root.appendChild(t);
    });

    var cross = svg('line', { x1: 0, x2: 0, y1: pad.t, y2: pad.t + ph, class: 'chart-cross', visibility: 'hidden' });
    root.appendChild(cross);
    var dot = svg('circle', { r: 5, class: 'chart-dot', visibility: 'hidden' });
    root.appendChild(dot);

    function focusIndex(i) {
      if (i < 0 || i >= n) return;
      dailyFocus = i;
      var p = series[i];
      Array.prototype.forEach.call(marks.querySelectorAll('.is-hover'), function (m) { m.classList.remove('is-hover'); });
      var mark = marks.querySelector('[data-i="' + i + '"]');
      if (mark) mark.classList.add('is-hover');
      if (!asBars) {
        cross.setAttribute('x1', xOf(i));
        cross.setAttribute('x2', xOf(i));
        cross.setAttribute('visibility', 'visible');
        if (p.percentage !== null) {
          dot.setAttribute('cx', xOf(i));
          dot.setAttribute('cy', yOf(p.percentage));
          dot.setAttribute('visibility', 'visible');
        } else {
          dot.setAttribute('visibility', 'hidden');
        }
      }
      showTooltip(wrap, xOf(i), p.percentage === null ? pad.t + ph / 2 : yOf(p.percentage), W,
        p.percentage === null ? '—' : p.percentage + '%',
        formatDate(p.date, 'short') + (p.percentage === null ? ' · not tracked' : ' · ' + p.completed + ' of ' + p.total + (p.lockedIn ? ' · Locked In' : '')));
    }

    function clear() {
      dailyFocus = -1;
      cross.setAttribute('visibility', 'hidden');
      dot.setAttribute('visibility', 'hidden');
      Array.prototype.forEach.call(marks.querySelectorAll('.is-hover'), function (m) { m.classList.remove('is-hover'); });
      hideTooltip();
    }

    root.addEventListener('pointermove', function (e) {
      var rect = root.getBoundingClientRect();
      var x = (e.clientX - rect.left) * (W / rect.width);
      var i = Math.floor((x - pad.l) / band);
      if (i >= 0 && i < n) focusIndex(i);
      else clear();
    });
    root.addEventListener('pointerleave', clear);
    root.addEventListener('blur', clear);
    root.addEventListener('focus', function () { if (dailyFocus < 0) focusIndex(n - 1); });
    root.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); focusIndex(Math.max(0, dailyFocus - 1)); }
      if (e.key === 'ArrowRight') { e.preventDefault(); focusIndex(Math.min(n - 1, dailyFocus + 1)); }
      if (e.key === 'Home') { e.preventDefault(); focusIndex(0); }
      if (e.key === 'End') { e.preventDefault(); focusIndex(n - 1); }
    });

    wrap.appendChild(root);
    wrap.appendChild(el('div', 'chart-tooltip'));
    wrap.lastChild.id = 'chart-tooltip';
    wrap.lastChild.hidden = true;
    wrap.lastChild.setAttribute('aria-hidden', 'true');

    // Table view: every value without hovering.
    var body = $('chart-daily-table');
    body.textContent = '';
    series.slice().reverse().forEach(function (p) {
      if (p.percentage === null) return;
      var tr = el('tr');
      tr.appendChild(el('td', '', formatDate(p.date, 'full')));
      tr.appendChild(el('td', 'num', p.completed + ' / ' + p.total));
      tr.appendChild(el('td', 'num', p.percentage + '%' + (p.lockedIn ? ' ✓' : '')));
      body.appendChild(tr);
    });
  }

  function showTooltip(wrap, x, y, W, value, label) {
    var tip = $('chart-tooltip');
    if (!tip) return;
    tip.textContent = '';
    tip.appendChild(el('strong', 'tip-value', value));
    tip.appendChild(el('span', 'tip-label', label));
    tip.hidden = false;
    var scale = wrap.clientWidth / W || 1;
    var left = x * scale;
    var tw = tip.offsetWidth;
    left = Math.max(0, Math.min(wrap.clientWidth - tw, left - tw / 2));
    tip.style.left = left + 'px';
    tip.style.top = Math.max(0, y * scale - tip.offsetHeight - 10) + 'px';
  }

  function hideTooltip() {
    var tip = $('chart-tooltip');
    if (tip) tip.hidden = true;
  }

  /* Chart 2: consistency per goal */

  function statusTag(s) {
    return s.status === 'active' ? '' : s.status === 'paused' ? 'paused' : 'archived';
  }

  function renderHabitChart() {
    var list = $('chart-habits');
    list.textContent = '';
    var rows = stats.habitStats(state, today)
      .filter(function (s) { return s.activeDays > 0; })
      .sort(function (a, b) { return b.completionRate - a.completionRate || b.activeDays - a.activeDays; });
    rows.forEach(function (s) {
      var li = el('li', 'hbar');
      var head = el('div', 'hbar-head');
      var name = el('span', 'hbar-name', s.name);
      if (statusTag(s)) name.appendChild(el('span', 'tag', statusTag(s)));
      head.appendChild(name);
      head.appendChild(el('span', 'hbar-value', s.completionRate + '%'));
      li.appendChild(head);
      var track = el('div', 'hbar-track');
      var fill = el('div', 'hbar-fill');
      fill.style.width = s.completionRate + '%';
      track.appendChild(fill);
      track.setAttribute('aria-hidden', 'true');
      li.appendChild(track);
      li.appendChild(el('span', 'visually-hidden', ': done on ' + s.completed + ' of ' + plural(s.activeDays, 'day') + ' it was a goal.'));
      li.title = s.name + ': ' + s.completed + ' of ' + plural(s.activeDays, 'day');
      list.appendChild(li);
    });
  }

  function renderHabitStats() {
    var list = $('habit-stats');
    list.textContent = '';
    stats.habitStats(state, today).forEach(function (s) {
      var li = el('li', 'habit-stat');
      var head = el('div', 'habit-stat-head');
      head.appendChild(el('h3', 'habit-stat-name', s.name));
      if (statusTag(s)) head.appendChild(el('span', 'tag', statusTag(s)));
      li.appendChild(head);
      var dl = el('dl', 'habit-stat-grid');
      [
        ['Completion', s.activeDays ? s.completionRate + '%' : '—'],
        ['Current streak', s.status === 'active' ? plural(s.currentStreak, 'day') : '—'],
        ['Best streak', plural(s.bestStreak, 'day')],
        ['Completed', plural(s.completed, 'time')]
      ].forEach(function (pair) {
        var div = el('div');
        div.appendChild(el('dt', '', pair[0]));
        div.appendChild(el('dd', '', pair[1]));
        dl.appendChild(div);
      });
      li.appendChild(dl);
      list.appendChild(li);
    });
  }

  function onRangeChange(event) {
    if (event.target.name !== 'range' || !RANGES[event.target.value]) return;
    chartRange = event.target.value;
    renderDailyChart();
  }

  /* ---------------- Render ---------------- */

  function render() {
    renderToday();
    $('reset-data').hidden = !state.habits.length && !Object.keys(state.days).length;
    $('export-data').disabled = !state.habits.length && !Object.keys(state.days).length;
    // Don't rebuild the editor under someone typing a new name.
    var typing = document.activeElement && document.activeElement.classList.contains('manage-name');
    if ($('goals-dialog').open && !typing) renderManage();
    if (activeTab === 'stats') renderStats();
  }

  /* ---------------- Export / import / reset ---------------- */

  function onExport() {
    downloadBackup(state, core.exportFileName(today));
  }

  function downloadBackup(data, fileName) {
    var doc = core.buildExport(data, new Date(), stats.summary(data, today));
    var blob = new Blob([JSON.stringify(doc, null, 2) + '\n'], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    announce('Backup downloaded as ' + a.download + '.');
  }

  function showImportError(message) {
    var box = $('import-error');
    box.textContent = '';
    box.appendChild(el('p', '', 'Import failed: ' + message + ' Your current data has not been changed.'));
    box.hidden = false;
  }

  function hasAnyData(s) {
    return s.habits.length > 0 || Object.keys(s.days).length > 0;
  }

  function onImportFile() {
    var input = $('import-file');
    var file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    $('import-error').hidden = true;
    if (file.size > 10 * 1024 * 1024) {
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
      var sum = stats.summary(s, today);
      var summary = hasAnyData(s)
        ? [plural(s.habits.length, 'goal') + ' and ' + plural(Object.keys(s.days).length, 'day') + ' of history. Best streak ' +
            plural(sum.bestStreak, 'day') + ', ' + sum.totalLockedInDays + ' Locked In days.']
        : ['The file contains no goals or history.'];
      summary.push(hasAnyData(state)
        ? 'This replaces your current goals and all of their history on this device.'
        : 'This will be saved on this device.');
      $('import-data').focus();
      return confirmDialog({
        title: 'Replace your data?',
        message: summary,
        confirmLabel: 'Replace data',
        danger: hasAnyData(state)
      }).then(function (confirmed) {
        if (!confirmed) {
          announce('Import cancelled. Nothing was changed.');
          return;
        }
        if (commit(s)) {
          hideNotice();
          selectedDate = null;
          calMonth = null;
          announce('Import complete.');
          refreshDays();
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
        'This permanently deletes every goal and all of your history and stats' + (cloudUser ? ', on this device and in your account.' : ' from this device.'),
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
        selectedDate = null;
        calMonth = null;
        announce('All data deleted.');
        selectTab('today');
        $('first-goal').focus();
      }
    });
  }

  /* ---------------- Account sign-in and sync ---------------- */

  var cloudUser = null;
  var syncMeta = sync.readMeta(storage);
  var knownRemoteRevision = 0;
  var syncBlocked = false;
  var pushTimer = null;
  var waitingForAccount = false;
  var evaluatePending = false;

  function setSyncStatus(kind, text) {
    var el = $('sync-status');
    el.dataset.state = kind;
    el.textContent = text;
  }

  function showAccountError(message) {
    var box = $('account-error');
    box.textContent = message;
    box.hidden = !message;
  }

  function saveMeta(meta) {
    syncMeta = meta;
    sync.writeMeta(storage, meta);
  }

  /**
   * True (and tells the user) when an action must wait: the account's latest
   * copy hasn't arrived yet and this device's copy looks out of date.
   */
  function holdForAccount() {
    if (!waitingForAccount || !core.ensureDays(state, today).missed.length) return false;
    announce('Checking your account for newer progress. Try again in a moment.');
    $('goals-hint').textContent = 'Checking your account for newer progress…';
    return true;
  }

  function stopWaitingForAccount() {
    if (!waitingForAccount) return;
    waitingForAccount = false;
    if (evaluatePending) {
      evaluatePending = false;
      refreshDays();
      render();
    }
  }

  function renderAccount() {
    var signedIn = !!cloudUser;
    $('account-signed-out').hidden = signedIn;
    $('account-signed-in').hidden = !signedIn;
    if (signedIn) $('account-name').textContent = cloudUser.email || cloudUser.name || 'your Google account';
    $('data-description').textContent = signedIn
      ? 'Your progress is saved on this device and in your account. You can still export a backup file.'
      : 'Everything is stored only in this browser. Export a backup to keep it safe or move it to another device.';
  }

  /** Called after every user change that was saved on this device. */
  function cloudChanged() {
    if (!cloudUser) return;
    saveMeta(sync.markDirty(syncMeta, new Date()));
    schedulePush();
  }

  function schedulePush() {
    if (!cloudUser || syncBlocked) return;
    clearTimeout(pushTimer);
    setSyncStatus('pending', 'Saving to your account…');
    // Short delay so ticking several habits in a row is one write.
    pushTimer = setTimeout(pushNow, 400);
  }

  function pushNow() {
    if (!cloudUser || syncBlocked) return;
    var uid = cloudUser.uid;
    var revision = Math.max(syncMeta.revision, knownRemoteRevision) + 1;
    var body = sync.toRemoteDoc(state, revision, new Date());
    cloud.write(body).then(function () {
      if (!cloudUser || cloudUser.uid !== uid) return;
      knownRemoteRevision = Math.max(knownRemoteRevision, revision);
      var unchanged = JSON.stringify(state) === JSON.stringify(body.state);
      if (unchanged) {
        saveMeta(sync.markSynced(syncMeta, uid, revision));
        setSyncStatus('synced', 'Saved to your account');
      } else {
        var m = sync.normalizeMeta(syncMeta);
        m.uid = uid;
        m.revision = revision;
        saveMeta(m);
      }
    }, function (e) {
      setSyncStatus('error', 'Not saved to your account yet: ' + e.message + ' Your progress is safe on this device.');
    });
  }

  function onCloudUser(user) {
    var wasSignedIn = !!cloudUser;
    cloudUser = user;
    syncBlocked = false;
    knownRemoteRevision = 0;
    renderAccount();
    if (user) {
      showAccountError('');
      setSyncStatus('pending', 'Checking your account…');
      if (!wasSignedIn) announce('Signed in as ' + (user.email || user.name) + '.');
    } else {
      clearTimeout(pushTimer);
      stopWaitingForAccount();
    }
  }

  function onCloudRemote(data) {
    if (!cloudUser) return;
    var uid = cloudUser.uid;
    var remote = sync.fromRemoteDoc(data);
    if (remote.exists && remote.ok) knownRemoteRevision = Math.max(knownRemoteRevision, remote.revision);
    var d = sync.decide({ local: state, meta: syncMeta, remote: remote, uid: uid });
    if (readOnly) {
      d = { action: 'blocked', message: 'Saving is disabled on this device (see the message at the top).' };
    }

    if (d.action === 'blocked') {
      syncBlocked = true;
      setSyncStatus('error', d.message + ' Your progress is safe on this device and nothing in your account was changed.');
    } else if (d.action === 'upload') {
      if (d.reason === 'first-sign-in') announce('Uploading your progress to your account.');
      if (syncMeta.uid !== uid) saveMeta(sync.markDirty(sync.markSynced(syncMeta, uid, remote.exists ? remote.revision : 0), new Date()));
      schedulePush();
    } else if (d.action === 'download') {
      adoptRemote(remote.state, d, uid);
    } else {
      saveMeta(sync.markSynced(syncMeta, uid, d.revision));
      setSyncStatus('synced', remote.exists ? 'Saved to your account' : 'Signed in. Your progress will be saved to your account.');
    }
    stopWaitingForAccount();
  }

  function adoptRemote(remoteState, decision, uid) {
    var replaced = state;
    if (decision.backupLocal) {
      try {
        storage.setItem(sync.backupKey(new Date()), JSON.stringify(replaced));
      } catch (e) {
        // The download button below still offers the copy for this session.
      }
    }
    try {
      store.save(storage, remoteState);
    } catch (e) {
      setSyncStatus('error', 'Could not save your account’s progress on this device: ' + e.message);
      return;
    }
    state = remoteState;
    saveMeta(sync.markSynced(syncMeta, uid, decision.revision));
    setSyncStatus('synced', 'Saved to your account');
    render();
    refreshDays();
    if (decision.backupLocal) {
      showNotice('Loaded the progress saved in your account. This device had different progress, which was kept as a backup.', {
        label: 'Download this device’s copy',
        run: function () { downloadBackup(replaced, 'day-by-day-this-device-' + today + '.json'); }
      });
    } else {
      announce('Loaded the latest progress from your account.');
    }
  }

  function onCloudError(message) {
    setSyncStatus('error', message);
    stopWaitingForAccount();
  }

  function onSignIn() {
    var btn = $('sign-in');
    btn.disabled = true;
    showAccountError('');
    cloud.signIn().then(function (r) {
      btn.disabled = false;
      if (r.cancelled) announce('Sign-in cancelled.');
      else if (!r.ok) showAccountError('Could not sign in: ' + r.message);
    }, function (e) {
      btn.disabled = false;
      showAccountError('Could not sign in: ' + (e && e.message ? e.message : 'unknown error'));
    });
  }

  function onSignOut() {
    confirmDialog({
      title: 'Sign out?',
      message: [
        'Your progress stays on this device, but changes will no longer be saved to your account.',
        'Sign in again at any time to catch up.'
      ],
      confirmLabel: 'Sign out'
    }).then(function (confirmed) {
      if (!confirmed) return;
      cloud.signOut().then(function () {
        announce('Signed out. Your progress is still on this device.');
        $('sign-in').focus();
      });
    });
  }

  function startCloud() {
    if (!cloud || !cloud.isConfigured()) return;
    $('account-view').hidden = false;
    $('footer-text').textContent = 'Day by Day works offline. Signing in is optional. No ads, no tracking.';
    renderAccount();
    $('sign-in').addEventListener('click', onSignIn);
    $('sign-out').addEventListener('click', onSignOut);
    if (syncMeta.uid) {
      // Previously signed in: wait briefly for the account's latest copy
      // before filling in missed days, so a device that is behind doesn't
      // announce a broken streak that another device's progress has avoided.
      waitingForAccount = true;
      setTimeout(stopWaitingForAccount, 6000);
    }
    cloud.start({ onUser: onCloudUser, onRemote: onCloudRemote, onError: onCloudError }).catch(function () {
      showAccountError('Sign-in could not be loaded. Check your connection; the app still works on this device.');
      stopWaitingForAccount();
    });
  }


  /* ---------------- Start-up ---------------- */

  function init() {
    var loaded = store.load(storage, new Date());
    state = loaded.state;
    readOnly = loaded.readOnly;
    if (loaded.notice) showNotice(loaded.notice);

    $('tab-today').addEventListener('click', function () { selectTab('today'); });
    $('tab-stats').addEventListener('click', function () { selectTab('stats'); });
    $('tab-today').addEventListener('keydown', onTabKey);
    $('tab-stats').addEventListener('keydown', onTabKey);

    $('goal-list').addEventListener('change', onGoalChange);
    $('first-goal-form').addEventListener('submit', onFirstGoal);
    $('edit-goals').addEventListener('click', function () { openManage(false); });
    $('add-goal-link').addEventListener('click', function () { openManage(true); });
    $('goals-empty-edit').addEventListener('click', function () { openManage(false); });
    $('manage-done').addEventListener('click', closeManage);
    $('add-goal-form').addEventListener('submit', onAddGoal);
    $('goals-dialog').addEventListener('click', onManageClick);
    $('goals-dialog').addEventListener('change', onRename);
    $('goals-dialog').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.classList.contains('manage-name')) {
        e.preventDefault();
        e.target.blur();
      }
    });
    $('goals-dialog').addEventListener('close', function () {
      manageError('');
      if (!$('goals-card').hidden) $('edit-goals').focus();
      else $('first-goal').focus();
    });

    $('cal-grid').addEventListener('click', onCalendarClick);
    $('cal-prev').addEventListener('click', function () { moveMonth(-1); });
    $('cal-next').addEventListener('click', function () { moveMonth(1); });
    $('range-control').addEventListener('change', onRangeChange);

    $('export-data').addEventListener('click', onExport);
    $('import-data').addEventListener('click', function () { $('import-file').click(); });
    $('import-file').addEventListener('change', onImportFile);
    $('reset-data').addEventListener('click', onReset);
    $('notice-dismiss').addEventListener('click', function () {
      hideNotice();
      $('main').focus();
    });
    $('notice-action').addEventListener('click', function () {
      if (noticeAction) noticeAction.run();
    });

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) checkForNewDay();
    });
    window.addEventListener('focus', checkForNewDay);
    setInterval(checkForNewDay, 30 * 1000);

    var resizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { if (activeTab === 'stats') renderDailyChart(); }, 150);
    });

    startCloud();
    refreshDays();
    selectTab(location.hash === '#stats' ? 'stats' : 'today');
    render();
  }

  init();
})();
