/*
 * Day by Day — UI controller.
 *
 * Wires the DOM to the pure functions in core.js (goals and daily records),
 * stats.js (every number and insight shown), plans.js (feature
 * entitlements) and storage.js / sync.js / cloud.js (persistence). This
 * file only renders state and handles events.
 */
(function () {
  'use strict';

  var core = window.DayByDayCore;
  var stats = window.DayByDayStats;
  var plans = window.DayByDayPlans;
  var icons = window.DayByDayIcons;
  var store = window.DayByDayStorage;
  var sync = window.DayByDaySync;
  var cloud = window.DayByDayCloud;

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var RANGES = { '7': 7, '30': 30, '90': 90, all: 'all' };
  var TABS = ['today', 'stats', 'settings'];
  var NOTIFY_KEY = 'day-by-day.notify';
  var REMINDED_KEY = 'day-by-day.reminded';
  var WIDE = window.matchMedia ? window.matchMedia('(min-width: 1024px)') : { matches: false };
  var SIDEBAR = window.matchMedia ? window.matchMedia('(min-width: 768px)') : { matches: false };

  var storage = safeLocalStorage();
  var state = core.emptyState();
  var readOnly = false;
  var today = core.toDateKey(new Date());
  var activeTab = 'today';
  var chartRange = '30';
  var calMonth = null; // { y, m }
  var selectedDate = null;
  var renderedGoalSignature = null;
  var wasLockedIn = null;
  var editingId = null; // goal open in the goal form (null = new goal)

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

  function icon(name, size) {
    var s = icons.create(name, size);
    return s || document.createTextNode('');
  }

  /** A span holding an icon, for placing in flex layouts. */
  function iconSpan(name, size, className) {
    var span = el('span', className || '');
    span.appendChild(icon(name, size));
    return span;
  }

  function safeLocalStorage() {
    try {
      return window.localStorage;
    } catch (e) {
      return {
        getItem: function () { throw e; },
        setItem: function () { throw e; },
        removeItem: function () {}
      };
    }
  }

  function readPref(key, fallback) {
    try {
      var v = storage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch (e) {
      return fallback;
    }
  }

  function writePref(key, value) {
    try {
      storage.setItem(key, JSON.stringify(value));
    } catch (e) {
      // Preferences are conveniences; ignore blocked storage.
    }
  }

  function weekStart() {
    return state.settings ? state.settings.weekStart : 0;
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
    weekday: { weekday: 'narrow' },
    dowShort: { weekday: 'short' },
    dowLong: { weekday: 'long' }
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



  /* ---------------- Tooltips for icon-only controls ---------------- */

  var tipTarget = null;

  function showTip(target) {
    var text = target.getAttribute('data-tip') || target.getAttribute('aria-label');
    if (!text) return;
    var tip = $('tooltip');
    tip.textContent = text;
    tip.hidden = false;
    var r = target.getBoundingClientRect();
    var tw = tip.offsetWidth;
    var th = tip.offsetHeight;
    var left = Math.max(8, Math.min(window.innerWidth - tw - 8, r.left + r.width / 2 - tw / 2));
    var top = r.top - th - 8;
    if (top < 8) top = r.bottom + 8;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
    tipTarget = target;
  }

  function hideTip() {
    $('tooltip').hidden = true;
    tipTarget = null;
  }

  function initTooltips() {
    function find(e) {
      return e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
    }
    document.addEventListener('pointerover', function (e) { var t = find(e); if (t && e.pointerType !== 'touch') showTip(t); });
    document.addEventListener('pointerout', function (e) { var t = find(e); if (t && t === tipTarget) hideTip(); });
    document.addEventListener('focusin', function (e) { var t = find(e); if (t && e.target.matches(':focus-visible')) showTip(t); });
    document.addEventListener('focusout', function (e) { var t = find(e); if (t) hideTip(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && tipTarget) hideTip(); });
    window.addEventListener('scroll', hideTip, { passive: true });
  }

  /* ---------------- Tabs / navigation ---------------- */

  function selectTab(name, focus) {
    activeTab = TABS.indexOf(name) >= 0 ? name : 'today';
    TABS.forEach(function (t) {
      var tab = $('tab-' + t);
      var on = t === activeTab;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      $('panel-' + t).hidden = !on;
    });
    if (focus) $('tab-' + activeTab).focus();
    try {
      history.replaceState(null, '', activeTab === 'today' ? location.pathname + location.search : '#' + activeTab);
    } catch (e) {
      // file:// pages may refuse; the tab still works.
    }
    document.title = (activeTab === 'today' ? 'Today' : activeTab === 'stats' ? 'Stats' : 'Settings') + ' · Day by Day';
    if (activeTab === 'stats') renderStats();
    if (activeTab === 'settings') renderSettings();
    window.scrollTo(0, 0);
  }

  function onTabKey(event) {
    var vertical = SIDEBAR.matches;
    var prev = vertical ? 'ArrowUp' : 'ArrowLeft';
    var next = vertical ? 'ArrowDown' : 'ArrowRight';
    if ([prev, next, 'Home', 'End'].indexOf(event.key) < 0) return;
    event.preventDefault();
    var i = TABS.indexOf(activeTab);
    var target = TABS[(i + (event.key === prev ? TABS.length - 1 : 1)) % TABS.length];
    if (event.key === 'Home') target = TABS[0];
    if (event.key === 'End') target = TABS[TABS.length - 1];
    selectTab(target, true);
  }

  function syncNavOrientation() {
    $('tablist').setAttribute('aria-orientation', SIDEBAR.matches ? 'vertical' : 'horizontal');
  }


  /* ---------------- Today ---------------- */

  var RING_C = 2 * Math.PI * 52;

  function formatTime(hhmm) {
    var p = hhmm.split(':').map(Number);
    return new Date(2000, 0, 1, p[0], p[1]).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function dayShort(dow) {
    // 2026-09-06 is a Sunday.
    return formatDate(core.addDays('2026-09-06', dow), 'dowShort');
  }

  function scheduleText(sch) {
    if (!sch || sch.type === 'daily') return 'Every day';
    if (sch.type === 'weekdays') return 'Weekdays';
    if (sch.type === 'weekly') return plural(sch.times, 'time') + ' a week';
    var order = weekStart() === 1 ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];
    return order.filter(function (d) { return sch.days.indexOf(d) >= 0; }).map(dayShort).join(', ');
  }

  /** Today's record, or (while waiting for the account) a preview of it. */
  function todayRecord() {
    if (state.days[today]) return state.days[today];
    var preview = [];
    core.activeHabits(state).forEach(function (h) {
      var how = core.scheduleOn(h, today);
      if (how) preview.push(how === 'flex' ? { id: h.id, name: h.name, flex: true, target: h.schedule.times } : { id: h.id, name: h.name });
    });
    return preview.length ? { habits: preview, done: [], preview: true } : null;
  }

  function goalChip(habit, small) {
    if (!habit || (!habit.icon && !habit.color)) return null;
    var chip = el('span', 'goal-chip' + (small ? ' sm' : ''));
    chip.setAttribute('aria-hidden', 'true');
    if (habit.color) chip.dataset.color = habit.color;
    chip.appendChild(icon(habit.icon || 'target', small ? 14 : 18));
    return chip;
  }

  function buildGoalRow(entry) {
    var habit = core.findHabit(state, entry.id);
    var li = el('li');
    var label = el('label', 'goal');
    if (habit && habit.color) label.dataset.color = habit.color;
    var box = el('input', 'goal-check');
    box.type = 'checkbox';
    box.id = 'goal-' + entry.id;
    box.dataset.habitId = entry.id;
    label.appendChild(box);
    var mark = el('span', 'goal-box');
    mark.setAttribute('aria-hidden', 'true');
    mark.appendChild(icon('check', 16));
    label.appendChild(mark);
    var chip = goalChip(habit);
    if (chip) label.appendChild(chip);
    var text = el('span', 'goal-text');
    text.appendChild(el('span', 'goal-name', entry.name));
    var meta = el('span', 'goal-meta');
    meta.dataset.metaFor = entry.id;
    text.appendChild(meta);
    label.appendChild(text);
    li.appendChild(label);
    return li;
  }

  function goalMeta(entry, done) {
    var habit = core.findHabit(state, entry.id);
    if (entry.flex) {
      var count = stats.weeklyProgress(state, today, weekStart(), entry.id);
      var met = count >= entry.target;
      return count + ' of ' + entry.target + ' this week' + (met ? ' · target met' : '');
    }
    if (habit && habit.reminder && !done) return 'Reminder at ' + formatTime(habit.reminder);
    return '';
  }

  function renderToday() {
    var sum = stats.summary(state, today);
    var hasHabits = state.habits.length > 0;
    $('today-date').textContent = formatDate(today, 'long');
    $('onboarding').hidden = hasHabits;
    $('hero').hidden = !hasHabits;
    $('goals-card').hidden = !hasHabits;
    $('focus-card').hidden = !hasHabits || !plans.can('reflections');
    if (!hasHabits) {
      renderedGoalSignature = null;
      wasLockedIn = null;
      return;
    }

    // Streak
    $('streak-count').textContent = String(sum.currentStreak);
    $('streak-unit').textContent = sum.currentStreak === 1 ? 'day' : 'days';
    $('best-streak').textContent = plural(sum.bestStreak, 'day');

    var rec = todayRecord();
    var required = rec ? rec.habits.filter(function (h) { return !h.flex; }) : [];
    var flexible = rec ? rec.habits.filter(function (h) { return h.flex; }) : [];
    var s = core.recordSummary(rec);

    // Goal lists (rebuilt only when the goals change, so focus is kept)
    var signature = JSON.stringify(rec ? rec.habits : []) + JSON.stringify(state.habits.map(function (h) { return [h.icon, h.color]; }));
    if (signature !== renderedGoalSignature) {
      var list = $('goal-list');
      var flexList = $('flex-list');
      list.textContent = '';
      flexList.textContent = '';
      required.forEach(function (e) { list.appendChild(buildGoalRow(e)); });
      flexible.forEach(function (e) { flexList.appendChild(buildGoalRow(e)); });
      renderedGoalSignature = signature;
    }
    $('goal-list').hidden = !required.length;
    $('flex-section').hidden = !flexible.length;
    var done = rec ? rec.done : [];
    Array.prototype.forEach.call(document.querySelectorAll('#goals-card .goal-check'), function (box) {
      var id = box.dataset.habitId;
      var isDone = done.indexOf(id) >= 0;
      box.checked = isDone;
      box.parentNode.classList.toggle('is-done', isDone);
      var entry = rec.habits.filter(function (h) { return h.id === id; })[0];
      var meta = document.querySelector('[data-meta-for="' + id + '"]');
      meta.textContent = entry ? goalMeta(entry, isDone) : '';
      meta.hidden = !meta.textContent;
    });

    // Empty state for days with nothing due
    var nothingDue = !required.length;
    $('goals-empty').hidden = !nothingDue;
    if (nothingDue) {
      $('goals-empty-text').textContent = !core.activeHabits(state).length
        ? 'All your goals are paused, so nothing is due today. Days with nothing due don’t count toward or against your streak.'
        : flexible.length
          ? 'No everyday goals are due today, so today won’t affect your locked-in streak. Your times-per-week goals are below.'
          : 'Nothing is scheduled for today, so it won’t affect your locked-in streak.';
    }

    // Hero ring, progress and message
    var hero = $('hero');
    var ratio = s.total ? s.completed / s.total : 0;
    $('ring-fill').style.strokeDashoffset = String(RING_C * (1 - ratio));
    $('ring-fill').style.opacity = ratio > 0 ? '1' : '0';
    $('ring-count').textContent = s.total ? s.completed + '/' + s.total : '—';
    hero.classList.toggle('is-locked', s.lockedIn);
    var bar = $('today-progress');
    bar.hidden = !s.total;
    bar.setAttribute('aria-valuemax', String(s.total));
    bar.setAttribute('aria-valuenow', String(s.completed));
    bar.setAttribute('aria-valuetext', s.completed + ' of ' + s.total + ' goals done');
    $('today-progress-bar').style.width = (ratio * 100) + '%';
    $('hero-status').textContent = heroMessage(s, sum);
    if (wasLockedIn === false && s.lockedIn) celebrate();
    wasLockedIn = s.lockedIn;

    // Focus
    var focus = state.focus[today] || '';
    var input = $('focus-input');
    if (document.activeElement !== input) input.value = focus;
  }

  function heroMessage(s, sum) {
    if (!s.total) return 'Nothing is due today.';
    if (s.lockedIn) return 'Day locked in. ' + (sum.currentStreak > 1 ? sum.currentStreak + ' days in a row.' : 'Your streak has started.');
    var left = s.total - s.completed;
    if (left === 1) return 'One more goal to lock in today.';
    if (s.completed === 0) return 'Check off all ' + s.total + ' goals to lock in today.';
    return left + ' more goals to lock in today.';
  }

  function celebrate() {
    var hero = $('hero');
    hero.classList.remove('celebrate');
    void hero.offsetWidth;
    hero.classList.add('celebrate');
    setTimeout(function () { hero.classList.remove('celebrate'); }, 1400);
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
    var name = box.parentNode.querySelector('.goal-name').textContent;
    if (r.lockedIn && box.checked) {
      announce('Day locked in. All ' + plural(s.total, 'goal') + ' done. Locked-in streak: ' + plural(stats.currentStreak(state, today), 'day') + '.');
    } else {
      announce(name + (box.checked ? ' done. ' : ' not done. ') + (s.total ? s.completed + ' of ' + s.total + ' goals done today.' : ''));
    }
  }

  function onFocusSubmit(event) {
    event.preventDefault();
    saveFocus();
  }

  function saveFocus() {
    var input = $('focus-input');
    var current = state.focus[today] || '';
    var value = input.value.replace(/\s+/g, ' ').trim();
    if (value === current) return;
    var r = core.setFocus(state, value, today);
    if (!r.ok) {
      $('focus-status').textContent = r.message;
      return;
    }
    if (commit(r.state)) {
      $('focus-status').textContent = value ? 'Saved for today.' : 'Cleared.';
      setTimeout(function () { $('focus-status').textContent = ''; }, 2500);
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
      announce('Added ' + core.findHabit(state, r.id).name + '. Add more goals any time.');
      $('add-goal').focus();
    }
  }


  /* ---------------- Dialog helpers ---------------- */

  var dialogOpeners = {};

  function openDialog(id, focusEl) {
    var dialog = $(id);
    dialogOpeners[id] = document.activeElement;
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
    if (focusEl) focusEl.focus();
  }

  function closeDialog(id) {
    var dialog = $(id);
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else dialog.removeAttribute('open');
  }

  /** Return focus to whatever opened a dialog (once it closes). */
  function restoreFocus(id, fallback) {
    var opener = dialogOpeners[id];
    dialogOpeners[id] = null;
    if (opener && document.contains(opener) && !opener.closest('[hidden]') && typeof opener.focus === 'function') opener.focus();
    else if (fallback) fallback.focus();
  }

  /* ---------------- Edit goals ---------------- */

  function openManage() {
    renderManage();
    manageError('');
    openDialog('goals-dialog', state.habits.length ? $('manage-done') : $('manage-add'));
  }

  function manageError(message) {
    var box = $('manage-error');
    box.textContent = message || '';
    box.hidden = !message;
  }

  function goalSub(h) {
    var parts = [scheduleText(h.schedule)];
    if (h.reminder) parts.push('Reminder at ' + formatTime(h.reminder));
    if (h.status === 'paused') parts.unshift('Paused');
    if (h.status === 'archived') parts = ['Archived ' + formatDate(h.archivedOn, 'short')];
    return parts.join(' · ');
  }

  function manageRow(h, index, total) {
    var li = el('li', 'manage-row');
    li.dataset.id = h.id;
    if (h.status === 'active') {
      var handle = el('button', 'drag-handle');
      handle.type = 'button';
      handle.dataset.dragId = h.id;
      handle.setAttribute('aria-label', 'Reorder ' + h.name + ', position ' + (index + 1) + ' of ' + total);
      handle.setAttribute('aria-describedby', 'reorder-help');
      handle.dataset.tip = 'Drag to reorder';
      handle.appendChild(icon('grip-vertical', 18));
      li.appendChild(handle);
    }
    var chip = goalChip(h, true);
    if (chip) li.appendChild(chip);
    var text = el('span', 'manage-text');
    text.appendChild(el('span', 'manage-name', h.name));
    text.appendChild(el('span', 'manage-sub', goalSub(h)));
    li.appendChild(text);
    if (h.status === 'archived') {
      li.appendChild(actionButton('restore', h.id, 'Restore', 'Restore ' + h.name));
    } else {
      if (h.status === 'paused') li.appendChild(actionButton('resume', h.id, 'Resume', 'Resume ' + h.name));
      li.appendChild(actionButton('edit', h.id, 'Edit', 'Edit ' + h.name));
    }
    return li;
  }

  function actionButton(action, id, text, label) {
    var b = el('button', 'btn btn-secondary btn-sm', text);
    b.type = 'button';
    b.dataset.action = action;
    b.dataset.id = id;
    b.setAttribute('aria-label', label);
    return b;
  }

  function renderManage() {
    var groups = { active: [], paused: [], archived: [] };
    state.habits.forEach(function (h) { groups[h.status].push(h); });
    [['active', 'manage-active'], ['paused', 'manage-paused'], ['archived', 'manage-archived']].forEach(function (g) {
      var list = $(g[1]);
      list.textContent = '';
      groups[g[0]].forEach(function (h, i) { list.appendChild(manageRow(h, i, groups[g[0]].length)); });
    });
    var max = activeLimit();
    $('manage-active-count').textContent = groups.active.length + (max ? ' of ' + max : '');
    $('manage-active-empty').hidden = groups.active.length > 0;
    $('reorder-help').hidden = groups.active.length < 2;
    $('manage-paused-section').hidden = !groups.paused.length;
    $('manage-archived-section').hidden = !groups.archived.length;
    $('manage-archived-count').textContent = String(groups.archived.length);
    $('manage-add').disabled = groups.active.length >= max;
  }

  /** Active-goal limit: the plan's, or the app's technical maximum. */
  function activeLimit() {
    var planLimit = plans.limit('activeGoals');
    return planLimit === null ? core.MAX_ACTIVE_HABITS : Math.min(planLimit, core.MAX_ACTIVE_HABITS);
  }

  function onManageClick(event) {
    var btn = event.target.closest('button[data-action]');
    if (!btn || btn.disabled) return;
    checkForNewDay();
    var h = core.findHabit(state, btn.dataset.id);
    if (!h) return;
    var action = btn.dataset.action;
    if (action === 'edit') {
      openGoalForm(h.id);
    } else if (action === 'resume' || action === 'restore') {
      var r = core.setHabitStatus(state, h.id, 'active', today);
      if (!r.ok) { manageError(r.message); return; }
      if (commit(r.state)) {
        renderManage();
        announce(h.name + (action === 'resume' ? ' resumed' : ' restored') + '. It counts again from today.');
        var again = document.querySelector('#manage-active [data-action="edit"][data-id="' + h.id + '"]');
        if (again) again.focus();
      }
    }
  }

  /* Reorder: keyboard (arrow keys on the handle) and pointer drag. */

  function moveTo(id, index, viaKeyboard) {
    var r = core.reorderHabit(state, id, index, today);
    if (!r.ok) { manageError(r.message); return; }
    if (r.unchanged) return;
    if (!commit(r.state)) return;
    renderManage();
    var active = core.activeHabits(state);
    var pos = active.map(function (h) { return h.id; }).indexOf(id);
    announce('Moved ' + active[pos].name + ' to position ' + (pos + 1) + ' of ' + active.length + '.');
    if (viaKeyboard) {
      var handle = document.querySelector('#manage-active [data-drag-id="' + id + '"]');
      if (handle) handle.focus();
    }
  }

  function onHandleKey(event) {
    var handle = event.target.closest('[data-drag-id]');
    if (!handle) return;
    var id = handle.dataset.dragId;
    var ids = core.activeHabits(state).map(function (h) { return h.id; });
    var i = ids.indexOf(id);
    var to = null;
    if (event.key === 'ArrowUp') to = i - 1;
    if (event.key === 'ArrowDown') to = i + 1;
    if (event.key === 'Home') to = 0;
    if (event.key === 'End') to = ids.length - 1;
    if (to === null) return;
    event.preventDefault();
    if (to < 0 || to >= ids.length) {
      announce('Already at the ' + (to < 0 ? 'top' : 'bottom') + '.');
      return;
    }
    moveTo(id, to, true);
  }

  var drag = null;

  function onHandleDown(event) {
    var handle = event.target.closest('[data-drag-id]');
    if (!handle || event.button > 0) return;
    event.preventDefault();
    var row = handle.closest('.manage-row');
    var rows = Array.prototype.slice.call($('manage-active').children);
    drag = {
      id: handle.dataset.dragId,
      row: row,
      rows: rows,
      from: rows.indexOf(row),
      to: rows.indexOf(row),
      startY: event.clientY,
      mids: rows.map(function (r) { var b = r.getBoundingClientRect(); return b.top + b.height / 2; }),
      step: row.getBoundingClientRect().height + 8
    };
    handle.setPointerCapture(event.pointerId);
    row.classList.add('is-dragging');
  }

  function onHandleMove(event) {
    if (!drag) return;
    var dy = event.clientY - drag.startY;
    drag.row.style.transform = 'translateY(' + dy + 'px)';
    var y = drag.mids[drag.from] + dy;
    var to;
    if (y > drag.mids[drag.from]) {
      to = drag.from;
      drag.mids.forEach(function (m, i) { if (i > drag.from && y > m) to = i; });
    } else {
      to = drag.from;
      for (var k = drag.from - 1; k >= 0; k--) if (y < drag.mids[k]) to = k;
    }
    drag.to = to;
    drag.rows.forEach(function (r, i) {
      if (r === drag.row) return;
      var shift = 0;
      if (drag.from < to && i > drag.from && i <= to) shift = -drag.step;
      if (drag.from > to && i < drag.from && i >= to) shift = drag.step;
      r.style.transform = shift ? 'translateY(' + shift + 'px)' : '';
    });
  }

  function onHandleUp() {
    if (!drag) return;
    var d = drag;
    drag = null;
    d.rows.forEach(function (r) { r.style.transform = ''; });
    d.row.classList.remove('is-dragging');
    if (d.to !== d.from) moveTo(d.id, d.to, false);
  }

  /* ---------------- Goal form ---------------- */

  function titleCase(name) {
    return name.replace(/-/g, ' ').replace(/^\w/, function (c) { return c.toUpperCase(); });
  }

  var COLOR_NAMES = { jade: 'Jade', teal: 'Teal', sky: 'Sky', indigo: 'Indigo', violet: 'Violet', rose: 'Rose', amber: 'Amber', slate: 'Slate' };

  function choice(name, value, content, label, checked) {
    var l = el('label', 'choice');
    l.dataset.tip = label;
    var input = el('input');
    input.type = 'radio';
    input.name = name;
    input.value = value;
    input.checked = !!checked;
    input.setAttribute('aria-label', label);
    l.appendChild(input);
    var face = el('span', 'choice-face');
    face.setAttribute('aria-hidden', 'true');
    face.appendChild(content);
    l.appendChild(face);
    return l;
  }

  function buildGoalFormChoices(h) {
    var iconsBox = $('gf-icons');
    iconsBox.textContent = '';
    iconsBox.appendChild(choice('gf-icon', '', document.createTextNode('None'), 'No icon', !h || !h.icon));
    icons.GOAL_ICONS.forEach(function (name) {
      iconsBox.appendChild(choice('gf-icon', name, icon(name, 20), titleCase(name) + ' icon', h && h.icon === name));
    });
    var colors = $('gf-colors');
    colors.textContent = '';
    colors.appendChild(choice('gf-color', '', document.createTextNode('None'), 'No colour', !h || !h.color));
    core.GOAL_COLORS.forEach(function (c) {
      var dot = el('span', 'color-dot');
      dot.dataset.color = c;
      colors.appendChild(choice('gf-color', c, dot, COLOR_NAMES[c], h && h.color === c));
    });
    var days = $('gf-days');
    days.textContent = '';
    var order = weekStart() === 1 ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];
    var chosen = h && h.schedule.type === 'days' ? h.schedule.days : [1, 3, 5];
    order.forEach(function (d) {
      var l = el('label', 'choice');
      var input = el('input');
      input.type = 'checkbox';
      input.value = String(d);
      input.checked = chosen.indexOf(d) >= 0;
      input.setAttribute('aria-label', formatDate(core.addDays('2026-09-06', d), 'dowLong'));
      l.appendChild(input);
      var face = el('span', 'choice-face', dayShort(d));
      face.setAttribute('aria-hidden', 'true');
      l.appendChild(face);
      days.appendChild(l);
    });
  }

  function syncScheduleFields() {
    var type = document.querySelector('input[name="gf-schedule"]:checked').value;
    $('gf-days').hidden = type !== 'days';
    $('gf-times-wrap').hidden = type !== 'weekly';
    $('gf-remind-wrap').hidden = !$('gf-remind').checked;
  }

  function reminderHint() {
    if (!plans.can('reminders')) return 'Reminders are part of Pro.';
    var on = readPref(NOTIFY_KEY, true);
    if (!on) return 'Reminders are turned off in Settings → Notifications.';
    if (!('Notification' in window)) return 'Reminders appear inside Day by Day while it’s open.';
    if (Notification.permission !== 'granted') return 'Reminders appear inside Day by Day while it’s open. Allow notifications in Settings to also get a system notification.';
    return 'You’ll get a notification at this time if the goal isn’t done yet and Day by Day is open.';
  }

  function openGoalForm(id) {
    var h = id ? core.findHabit(state, id) : null;
    if (!h && core.activeHabits(state).length >= activeLimit()) {
      manageError('You can have up to ' + activeLimit() + ' active goals. Pause or archive one to add another.');
      announce('Goal limit reached.');
      return;
    }
    editingId = h ? h.id : null;
    $('goal-form-title').textContent = h ? 'Edit goal' : 'New goal';
    $('gf-save').textContent = h ? 'Save changes' : 'Add goal';
    $('gf-name').value = h ? h.name : '';
    $('gf-name').removeAttribute('aria-invalid');
    $('gf-name-error').hidden = true;
    $('gf-schedule-error').hidden = true;
    $('gf-error').hidden = true;
    buildGoalFormChoices(h);
    var sch = h ? h.schedule : { type: 'daily' };
    document.querySelector('input[name="gf-schedule"][value="' + sch.type + '"]').checked = true;
    $('gf-times').value = String(sch.type === 'weekly' ? sch.times : 3);
    var flexOk = plans.can('flexibleSchedules');
    Array.prototype.forEach.call(document.querySelectorAll('input[name="gf-schedule"]'), function (r) {
      r.disabled = !flexOk && r.value !== 'daily';
    });
    $('gf-remind').checked = !!(h && h.reminder);
    $('gf-remind').disabled = !plans.can('reminders');
    $('gf-time').value = h && h.reminder ? h.reminder : '09:00';
    $('gf-remind-hint').textContent = reminderHint();
    syncScheduleFields();

    var status = $('gf-status');
    status.hidden = !h || h.status === 'archived';
    if (h && h.status !== 'archived') {
      var history = core.habitHistoryDates(state, h.id, today).length;
      $('gf-pause').textContent = h.status === 'paused' ? 'Resume goal' : 'Pause goal';
      $('gf-pause').dataset.icon = '';
      $('gf-remove').textContent = history ? 'Archive goal' : 'Delete goal';
      $('gf-status-hint').textContent = (h.status === 'paused'
        ? 'Paused goals aren’t due and don’t affect your streak. '
        : 'Pause a goal for a break; it won’t be due until you resume it. ') +
        (history
          ? 'Archiving removes it from your list but keeps its ' + plural(history, 'day') + ' of history in Stats.'
          : 'It has no history yet, so deleting removes it completely.');
    }
    openDialog('goal-form-dialog', $('gf-name'));
  }

  function readGoalForm() {
    var type = document.querySelector('input[name="gf-schedule"]:checked').value;
    var schedule = { type: type };
    if (type === 'days') {
      schedule.days = Array.prototype.filter.call($('gf-days').querySelectorAll('input'), function (i) { return i.checked; })
        .map(function (i) { return Number(i.value); });
    }
    if (type === 'weekly') schedule.times = Number($('gf-times').value);
    var iconInput = document.querySelector('input[name="gf-icon"]:checked');
    var colorInput = document.querySelector('input[name="gf-color"]:checked');
    return {
      name: $('gf-name').value,
      icon: iconInput && iconInput.value ? iconInput.value : null,
      color: colorInput && colorInput.value ? colorInput.value : null,
      schedule: schedule,
      reminder: $('gf-remind').checked ? ($('gf-time').value || null) : null
    };
  }

  function onGoalFormSubmit(event) {
    event.preventDefault();
    checkForNewDay();
    var v = readGoalForm();
    var nameError = core.habitNameError(v.name);
    $('gf-name-error').textContent = nameError;
    $('gf-name-error').hidden = !nameError;
    $('gf-name').setAttribute('aria-invalid', String(!!nameError));
    var sch = core.cleanSchedule(v.schedule);
    $('gf-schedule-error').textContent = sch.error || '';
    $('gf-schedule-error').hidden = !sch.error;
    if ($('gf-remind').checked && !v.reminder) {
      $('gf-error').textContent = 'Choose a reminder time, or turn off the reminder.';
      $('gf-error').hidden = false;
      return;
    }
    if (nameError) { $('gf-name').focus(); return; }
    if (sch.error) { $('gf-schedule').querySelector('input:checked').focus(); return; }
    var r = editingId
      ? core.updateHabit(state, editingId, v, today)
      : core.addHabit(state, v.name, today, { icon: v.icon, color: v.color, schedule: v.schedule, reminder: v.reminder });
    if (!r.ok) {
      $('gf-error').textContent = r.message;
      $('gf-error').hidden = false;
      return;
    }
    var wasNew = !editingId;
    if (!commit(r.state)) return;
    var name = core.cleanName(v.name);
    closeDialog('goal-form-dialog');
    if ($('goals-dialog').open) renderManage();
    announce(wasNew ? 'Added ' + name + '.' : 'Saved ' + name + '. Changes apply from today.');
  }

  function onGoalPause() {
    var h = core.findHabit(state, editingId);
    if (!h) return;
    var to = h.status === 'paused' ? 'active' : 'paused';
    var r = core.setHabitStatus(state, h.id, to, today);
    if (!r.ok) { $('gf-error').textContent = r.message; $('gf-error').hidden = false; return; }
    if (commit(r.state)) {
      closeDialog('goal-form-dialog');
      if ($('goals-dialog').open) renderManage();
      announce(to === 'paused' ? h.name + ' paused. It isn’t due from today.' : h.name + ' resumed. It counts again from today.');
    }
  }

  function onGoalRemove() {
    var h = core.findHabit(state, editingId);
    if (!h) return;
    var history = core.habitHistoryDates(state, h.id, today).length;
    var options = history
      ? {
          title: 'Archive “' + h.name + '”?',
          message: [
            'It will leave your goal list, but its ' + plural(history, 'day') + ' of history stay in your calendar and stats.',
            'You can restore it any time from Edit goals.'
          ],
          confirmLabel: 'Archive goal'
        }
      : {
          title: 'Delete “' + h.name + '”?',
          message: ['It has no history yet, so it will be removed completely.'],
          confirmLabel: 'Delete goal',
          danger: true
        };
    confirmDialog(options).then(function (ok) {
      if (!ok) return;
      var r = history ? core.setHabitStatus(state, h.id, 'archived', today) : core.deleteHabit(state, h.id, today);
      if (!r.ok) { $('gf-error').textContent = r.message; $('gf-error').hidden = false; return; }
      if (commit(r.state)) {
        closeDialog('goal-form-dialog');
        if ($('goals-dialog').open) renderManage();
        announce(history ? h.name + ' archived. Its history stays in Stats.' : h.name + ' deleted.');
      }
    });
  }


  /* ---------------- Stats ---------------- */

  var STATE_LABELS = {
    locked: 'Locked In',
    partial: 'Partly done',
    missed: 'Missed',
    none: 'Not tracked',
    pending: 'In progress',
    future: 'Upcoming'
  };

  var INSIGHT_ICONS = { up: 'trending-up', down: 'trending-down', flat: 'minus', focus: 'target' };

  function dayLong(dow) {
    return formatDate(core.addDays('2026-09-06', dow), 'dowLong');
  }

  function renderStats() {
    if (activeTab !== 'stats') return;
    var sum = stats.summary(state, today);
    var ins = stats.insights(state, today, dayLong);
    var wow = stats.weekOverWeek(state, today);

    // Summary
    $('stat-current').textContent = plural(sum.currentStreak, 'day');
    $('stat-best').textContent = plural(sum.bestStreak, 'day');
    $('stat-best-sub').textContent = sum.bestStreak && sum.bestStreak === sum.currentStreak ? 'You’re on your best run' : 'Your longest run so far';
    $('stat-rate').textContent = sum.totalTrackedDays ? sum.completionRate + '%' : '—';
    $('stat-total').textContent = String(sum.totalLockedInDays);
    $('stat-total-sub').textContent = 'of ' + plural(sum.totalTrackedDays, 'tracked day');
    var trend = $('stat-trend');
    trend.textContent = '';
    trend.hidden = !wow.available;
    if (wow.available) {
      trend.className = 'delta ' + (wow.change > 0 ? 'is-up' : wow.change < 0 ? 'is-down' : '');
      trend.appendChild(icon(wow.change > 0 ? 'trending-up' : wow.change < 0 ? 'trending-down' : 'minus', 14));
      trend.appendChild(document.createTextNode((wow.change > 0 ? '+' : '') + wow.change + ' pts'));
      trend.setAttribute('aria-label', (wow.change === 0 ? 'No change' : (wow.change > 0 ? 'Up ' : 'Down ') + Math.abs(wow.change) + ' points') + ' versus the previous 7 days');
      $('stat-rate-sub').textContent = 'Past 7 days: ' + wow.thisWeek.rate + '%, vs ' + wow.lastWeek.rate + '% the week before';
    } else {
      $('stat-rate-sub').textContent = 'Goals done of goals due';
    }

    // Early data
    var early = $('early-card');
    early.hidden = ins.needed === 0 || !state.habits.length;
    if (!early.hidden) {
      $('early-title').textContent = ins.needed === stats.MIN.patternDays
        ? 'Your first weekly pattern is 7 days away'
        : 'Complete ' + plural(ins.needed, 'more day') + ' to reveal your first weekly pattern';
      $('early-text').textContent = 'After a week of check-ins, Stats shows how this week compares with the last, which goals need attention and which days are your strongest. You’ve tracked ' + plural(ins.trackedDays, 'day') + ' so far.';
      $('early-progress').setAttribute('aria-valuenow', String(ins.trackedDays));
      $('early-progress-bar').style.width = Math.min(100, (ins.trackedDays / stats.MIN.patternDays) * 100) + '%';
    }

    // Insights
    var card = $('insights-card');
    card.hidden = !ins.items.length || !plans.can('weeklyReview');
    $('share-week').hidden = !plans.can('sharing');
    var list = $('insight-list');
    list.textContent = '';
    ins.items.forEach(function (item) {
      var li = el('li');
      var badge = iconSpan(INSIGHT_ICONS[item.tone] || 'info', 16, 'insight-icon is-' + item.tone);
      badge.setAttribute('aria-hidden', 'true');
      li.appendChild(badge);
      li.appendChild(el('p', '', item.text));
      list.appendChild(li);
    });

    renderCalendar(sum);
    renderAnalytics(sum);
    renderGoalStreaks();
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
    var atStart = monthIndex(calMonth) <= monthIndex(first);
    var atEnd = monthIndex(calMonth) >= monthIndex(now);
    $('cal-prev').disabled = atStart;
    $('cal-next').disabled = atEnd;
    $('cal-prev').hidden = atStart && atEnd;
    $('cal-next').hidden = atStart && atEnd;

    var grid = $('cal-grid');
    grid.textContent = '';
    var weeks = stats.monthGrid(state, calMonth.y, calMonth.m, today, weekStart());
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
          var s = core.recordSummary(state.days[cell.date]);
          var detail = s.total ? ', ' + s.completed + ' of ' + s.total + ' goals' : '';
          node.setAttribute('aria-label', formatDate(cell.date, 'day') + (cell.isToday ? ' (today)' : '') + ': ' + STATE_LABELS[cell.state] + detail);
        }
        node.appendChild(el('span', '', String(cell.day)));
        if (cell.state === 'locked') {
          var mark = iconSpan('check', 10, 'cal-mark');
          mark.setAttribute('aria-hidden', 'true');
          node.appendChild(mark);
        }
        grid.appendChild(node);
      });
    });
    renderDayPanel();
  }

  function renderDayDetail(box, date) {
    box.textContent = '';
    var d = stats.dayDetail(state, date, today);
    box.appendChild(el('p', 'detail-date', formatDate(date, 'long') + (date === today ? ' · Today' : '')));
    var sub = el('p', 'detail-sub');
    if (d.total) sub.appendChild(document.createTextNode(d.completed + ' of ' + d.total + ' goals completed'));
    var badge = el('span', 'detail-badge is-' + d.state, STATE_LABELS[d.state]);
    sub.appendChild(badge);
    box.appendChild(sub);
    if (d.focus) {
      var f = el('p', 'detail-focus');
      f.appendChild(el('span', 'visually-hidden', 'Focus: '));
      f.appendChild(document.createTextNode(d.focus));
      box.appendChild(f);
    }
    if (!d.items.length) {
      box.appendChild(el('p', 'detail-empty', 'No goals were due on this day, so it doesn’t count toward or against your streak.'));
      return;
    }
    var ul = el('ul', 'detail-list');
    d.items.forEach(function (item) {
      var li = el('li', item.done ? 'is-done' : 'is-missed');
      li.appendChild(icon(item.done ? 'circle-check' : 'x', 18));
      var text = el('span');
      text.appendChild(document.createTextNode(item.name));
      if (item.flexible) text.appendChild(el('span', 'detail-flex', ' · weekly goal'));
      text.appendChild(el('span', 'visually-hidden', item.done ? ' (done)' : ' (not done)'));
      li.appendChild(text);
      ul.appendChild(li);
    });
    box.appendChild(ul);
  }

  function renderDayPanel() {
    var body = $('day-panel-body');
    var inMonth = selectedDate && selectedDate.slice(0, 7) === calMonth.y + '-' + (calMonth.m < 10 ? '0' : '') + calMonth.m;
    if (!inMonth) {
      body.textContent = '';
      body.appendChild(el('p', 'detail-date', 'Day details'));
      body.appendChild(el('p', 'detail-empty', 'Select a day in the calendar to see which goals were done.'));
      return;
    }
    renderDayDetail(body, selectedDate);
  }

  function onCalendarClick(event) {
    var btn = event.target.closest('button[data-date]');
    if (!btn) return;
    var date = btn.dataset.date;
    selectedDate = date;
    renderCalendar(stats.summary(state, today));
    var again = document.querySelector('#cal-grid button[data-date="' + date + '"]');
    if (WIDE.matches) {
      if (again) again.focus();
      announce(formatDate(date, 'day') + ' details shown beside the calendar.');
      return;
    }
    // Phones and tablets: a bottom sheet that doesn't push the page around.
    $('day-dialog-title').textContent = 'Day details';
    renderDayDetail($('day-dialog-body'), date);
    dialogOpeners['day-dialog'] = again;
    if (typeof $('day-dialog').showModal === 'function') $('day-dialog').showModal();
    $('day-dialog-close').focus();
  }

  function moveMonth(delta) {
    var i = monthIndex(calMonth) + delta;
    calMonth = { y: Math.floor(i / 12), m: (i % 12) + 1 };
    renderCalendar(stats.summary(state, today));
  }

  /* Analytics */

  function renderAnalytics(sum) {
    var has = sum.totalTrackedDays > 0;
    renderDailyChart();
    renderWeekdayChart();
    renderGoalHistory();
    $('analytics').hidden = !has && !state.habits.length;
  }

  function renderWeekdayChart() {
    var box = $('weekday-chart');
    box.textContent = '';
    var wd = stats.weekdayStrength(state, today);
    if (!wd.available) {
      var need = Math.max(0, stats.MIN.weekdayDays - wd.trackedDays);
      var empty = el('div', 'empty');
      empty.appendChild(icon('calendar-days', 22));
      empty.appendChild(el('p', '', need
        ? 'Track ' + plural(need, 'more day') + ' to see your strongest and weakest days of the week.'
        : 'Your days of the week are about even so far. Once one stands out, it will show here.'));
      box.appendChild(empty);
      return;
    }
    var order = weekStart() === 1 ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];
    box.appendChild(el('p', 'caption', 'Completion rate for each day of the week over the last 12 weeks.'));
    var ul = el('ul', 'weekday-bars');
    ul.setAttribute('aria-label', 'Completion by weekday');
    order.forEach(function (dow) {
      var b = wd.days[dow];
      var li = el('li');
      var label = dayLong(dow) + ': ' + (b.rate === null ? 'no data' : b.rate + '%') +
        (dow === wd.strongest.dow ? ', strongest' : dow === wd.weakest.dow ? ', weakest' : '');
      li.setAttribute('aria-label', label);
      var value = el('span', 'wd-value', b.rate === null ? '—' : b.rate + '%');
      value.setAttribute('aria-hidden', 'true');
      li.appendChild(value);
      var bar = el('span', 'wd-bar' + (b.rate !== null ? ' has-data' : '') + (dow === wd.strongest.dow ? ' is-best' : '') + (dow === wd.weakest.dow ? ' is-worst' : ''));
      bar.style.height = (b.rate === null ? 2 : Math.max(4, b.rate * 0.9)) + 'px';
      bar.setAttribute('aria-hidden', 'true');
      li.appendChild(bar);
      var name = el('span', 'wd-label', dayShort(dow));
      name.setAttribute('aria-hidden', 'true');
      li.appendChild(name);
      var tag = el('span', 'wd-tag', dow === wd.strongest.dow ? 'Best' : dow === wd.weakest.dow ? 'Hardest' : '');
      tag.setAttribute('aria-hidden', 'true');
      li.appendChild(tag);
      ul.appendChild(li);
    });
    box.appendChild(ul);
  }

  function statusTag(s) {
    return s.status === 'active' ? '' : s.status === 'paused' ? 'Paused' : 'Archived';
  }

  function unitText(n, unit) {
    return plural(n, unit);
  }

  /* Goal history: one card per goal with a contribution grid (a dropdown) */

  var GH_KEY = 'day-by-day.goal-history-open';
  var GH_STATE_TEXT = { done: 'done', missed: 'missed', open: 'not done (weekly goal)', pending: 'not done yet', none: 'not due', future: '' };

  function goalHistoryWeeks() {
    var list = $('goal-history-list');
    var width = list.clientWidth || 320;
    // Card padding (2 × 16) and 16px per week column (12px cell + 4px gap):
    // as many weeks as fit, up to a year.
    return Math.max(8, Math.min(53, Math.floor((width - 32 + 4) / 16)));
  }

  function renderGoalHistory() {
    var card = $('goal-history-card');
    var goals = state.habits.filter(function (h) {
      return h.status === 'active' || core.habitHistoryDates(state, h.id, today).length || (state.days[today] && state.days[today].habits.some(function (e) { return e.id === h.id; }));
    });
    card.hidden = !goals.length;
    if (!goals.length) return;

    var rec = state.days[today];
    var dueToday = rec ? rec.habits.filter(function (e) { return !e.flex; }) : [];
    var doneToday = dueToday.filter(function (e) { return rec.done.indexOf(e.id) >= 0; }).length;
    $('goal-history-summary').textContent = plural(goals.length, 'goal') +
      (dueToday.length ? ' · ' + doneToday + ' of ' + dueToday.length + ' done today' : '');

    var open = readPref(GH_KEY, false);
    $('goal-history-toggle').setAttribute('aria-expanded', String(open));
    $('goal-history-body').hidden = !open;
    if (!open) return;

    var weeks = goalHistoryWeeks();
    $('gh-caption').textContent = 'The last ' + weeks + ' weeks, newest on the right. Each square is a day; each column is a week starting on ' + (weekStart() === 1 ? 'Monday' : 'Sunday') + '.';
    var statsById = {};
    stats.habitStats(state, today, weekStart()).forEach(function (st) { statsById[st.id] = st; });
    var list = $('goal-history-list');
    list.textContent = '';
    goals.forEach(function (h) {
      var st = statsById[h.id];
      var grid = stats.habitGrid(state, h.id, today, weeks, weekStart());
      var li = el('li', 'gh-card');
      li.dataset.color = h.color || 'jade';

      // Header: icon, name, streak line, today's status
      var head = el('div', 'gh-head');
      var chip = el('span', 'goal-chip');
      chip.dataset.color = h.color || 'jade';
      chip.setAttribute('aria-hidden', 'true');
      chip.appendChild(icon(h.icon || 'target', 18));
      head.appendChild(chip);
      var text = el('div', 'gh-text');
      var name = el('h3', 'gh-name', h.name);
      text.appendChild(name);
      var meta = el('p', 'gh-meta');
      var unit = st ? st.unit : 'day';
      var streak = st && h.status === 'active' ? st.currentStreak : 0;
      var flame = iconSpan('flame', 14, 'gh-flame');
      flame.setAttribute('aria-hidden', 'true');
      meta.appendChild(flame);
      meta.appendChild(document.createTextNode(
        (h.status === 'active' ? streak + '-' + unit + ' streak' : statusTag(st || h)) +
        (st && st.periods ? ' · ' + st.completionRate + '% ' + (unit === 'week' ? 'of weeks met' : 'done') : '')));
      text.appendChild(meta);
      head.appendChild(text);

      var todayEntry = rec && rec.habits.filter(function (e) { return e.id === h.id; })[0];
      if (todayEntry) {
        var isDone = rec.done.indexOf(h.id) >= 0;
        var badge = el('span', 'gh-status' + (isDone ? ' is-done' : ''));
        badge.appendChild(icon(isDone ? 'check' : 'circle-check', 18));
        badge.setAttribute('role', 'img');
        badge.setAttribute('aria-label', isDone ? 'Done today' : 'Not done yet today');
        badge.dataset.tip = isDone ? 'Done today' : 'Not done yet today';
        if (!isDone) badge.firstChild.style.opacity = '0';
        head.appendChild(badge);
      }
      li.appendChild(head);

      // Weekly goals: this week's progress bar
      if (st && st.unit === 'week' && st.thisWeek) {
        var wk = el('div', 'gh-week');
        var bar = el('div', 'progress progress-sm');
        bar.setAttribute('role', 'progressbar');
        bar.setAttribute('aria-label', h.name + ' this week');
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', String(st.thisWeek.target));
        bar.setAttribute('aria-valuenow', String(Math.min(st.thisWeek.count, st.thisWeek.target)));
        var fill = el('div', 'progress-bar');
        fill.style.width = Math.min(100, (st.thisWeek.count / st.thisWeek.target) * 100) + '%';
        bar.appendChild(fill);
        wk.appendChild(bar);
        wk.appendChild(el('span', 'gh-week-text', st.thisWeek.count + ' / ' + st.thisWeek.target + ' this week'));
        li.appendChild(wk);
      }

      // Contribution grid (weeks as columns, days as rows)
      var g = el('div', 'gh-grid');
      g.style.gridTemplateColumns = 'repeat(' + weeks + ', minmax(0, 1fr))';
      g.setAttribute('role', 'img');
      var summary = unit === 'week'
        ? h.name + ': done on ' + plural(grid.doneAll, 'day') + ' in the last ' + weeks + ' weeks.'
        : h.name + ': done on ' + grid.done + ' of ' + plural(grid.due, 'day') + ' it was due in the last ' + weeks + ' weeks.';
      g.setAttribute('aria-label', summary);
      grid.weeks.forEach(function (col) {
        col.forEach(function (cell) {
          var sq = el('span', 'gh-cell is-' + cell.state);
          if (cell.state !== 'future') sq.title = formatDate(cell.date, 'full') + ': ' + GH_STATE_TEXT[cell.state];
          g.appendChild(sq);
        });
      });
      li.appendChild(g);
      list.appendChild(li);
    });
  }

  function onGoalHistoryToggle() {
    var open = $('goal-history-toggle').getAttribute('aria-expanded') !== 'true';
    writePref(GH_KEY, open);
    renderGoalHistory();
    announce(open ? 'Goal history expanded.' : 'Goal history collapsed.');
  }

  function renderGoalStreaks() {
    var list = $('habit-stats');
    list.textContent = '';
    var all = stats.habitStats(state, today, weekStart());
    $('goal-streaks-card').hidden = !all.length;
    all.forEach(function (s) {
      var li = el('li', 'habit-stat');
      var head = el('div', 'habit-stat-head');
      var chip = goalChip(s, true);
      if (chip) head.appendChild(chip);
      head.appendChild(el('h3', 'habit-stat-name', s.name));
      if (statusTag(s)) head.appendChild(el('span', 'tag', statusTag(s)));
      head.appendChild(el('span', 'tag', scheduleText(s.schedule)));
      li.appendChild(head);
      var dl = el('dl', 'habit-stat-grid');
      var unit = s.unit;
      [
        [unit === 'week' ? 'Weeks target met' : 'Completion rate', s.periods ? s.completionRate + '%' : '—'],
        ['Goal streak', s.status === 'active' ? unitText(s.currentStreak, unit) : '—'],
        ['Best goal streak', unitText(s.bestStreak, unit)],
        [unit === 'week' ? (s.thisWeek ? 'This week' : 'Times done') : 'Times done',
          unit === 'week' && s.thisWeek ? s.thisWeek.count + ' of ' + s.thisWeek.target : plural(s.completed, 'time')]
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

  /* Weekly summary to share (Web Share, or copied to the clipboard) */

  function weeklySummaryText() {
    var w = stats.windowTotals(state, today);
    var sum = stats.summary(state, today);
    var lines = ['Day by Day: my past 7 days'];
    if (w.days) lines.push(w.rate + '% of goals done, ' + w.locked + ' of ' + plural(w.days, 'tracked day') + ' Locked In.');
    lines.push('Locked-in streak: ' + plural(sum.currentStreak, 'day') + ' (best ' + plural(sum.bestStreak, 'day') + ').');
    return lines.join('\n');
  }

  function onShareWeek() {
    var text = weeklySummaryText();
    if (navigator.share) {
      navigator.share({ title: 'My week in Day by Day', text: text }).catch(function () {});
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        announce('Weekly summary copied to the clipboard.');
        showNotice('Weekly summary copied. Paste it wherever you like.');
      }, function () {
        showNotice(text);
      });
      return;
    }
    showNotice(text);
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

    var tracked = series.filter(function (p) { return p.percentage !== null; });
    var enough = tracked.length >= stats.MIN.chartDays;
    $('chart-daily-empty').hidden = enough;
    $('chart-daily-details').hidden = !enough;
    if (!enough) {
      var need = stats.MIN.chartDays - tracked.length;
      $('chart-daily-caption').textContent = '';
      $('chart-daily-empty-text').textContent = tracked.length
        ? 'Track ' + plural(need, 'more day') + ' in this range to see your daily completion trend. One or two points aren’t a trend yet.'
        : 'No tracked days in this range yet. Check in on Today and your trend will build here.';
      return;
    }
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

    // Line with a light area wash; untracked days break the line.
    var line = '';
    var area = '';
    var runStart = null;
    var base = pad.t + ph;
    series.forEach(function (p, i) {
      if (p.percentage === null) {
        if (runStart !== null) area += 'L' + xOf(i - 1) + ',' + base + 'Z';
        runStart = null;
        return;
      }
      var x = xOf(i);
      var y = yOf(p.percentage);
      if (runStart === null) {
        line += 'M' + x + ',' + y;
        area += 'M' + x + ',' + base + 'L' + x + ',' + y;
        runStart = i;
      } else {
        line += 'L' + x + ',' + y;
        area += 'L' + x + ',' + y;
      }
    });
    if (runStart !== null) area += 'L' + xOf(n - 1) + ',' + base + 'Z';
    marks.appendChild(svg('path', { d: area, class: 'chart-area' }));
    marks.appendChild(svg('path', { d: line, class: 'chart-line' }));

    // A dot per day for short ranges; on longer ranges only for days with no
    // tracked neighbour, which would otherwise have no visible line.
    series.forEach(function (p, i) {
      if (p.percentage === null) return;
      var alone = (i === 0 || series[i - 1].percentage === null) && (i === n - 1 || series[i + 1].percentage === null);
      if (n > 14 && !alone) return;
      marks.appendChild(svg('circle', { cx: xOf(i), cy: yOf(p.percentage), r: alone ? 5 : 4, class: 'chart-point', 'data-i': i }));
    });

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


  /* ---------------- Settings ---------------- */

  function renderSettings() {
    Array.prototype.forEach.call(document.querySelectorAll('input[name="weekstart"]'), function (r) {
      r.checked = Number(r.value) === weekStart();
    });
    renderNotifications();
    renderPlan();
    renderNetwork();
    $('export-data').disabled = !plans.can('export') || (!state.habits.length && !Object.keys(state.days).length);
    $('reset-data').disabled = !state.habits.length && !Object.keys(state.days).length;
  }

  function onWeekStart(event) {
    if (event.target.name !== 'weekstart') return;
    var r = core.setWeekStart(state, Number(event.target.value));
    if (r.ok && commit(r.state)) {
      renderedGoalSignature = null;
      announce('Weeks now start on ' + (weekStart() === 1 ? 'Monday' : 'Sunday') + '.');
    }
  }

  function renderNotifications() {
    var on = readPref(NOTIFY_KEY, true);
    $('notify-toggle').checked = on;
    var text = $('notify-permission-text');
    var btn = $('notify-permission');
    btn.hidden = true;
    if (!('Notification' in window)) {
      text.textContent = 'This browser doesn’t support system notifications. Reminders still appear inside Day by Day.';
    } else if (Notification.permission === 'granted') {
      text.textContent = 'Allowed. Reminders can appear as system notifications while Day by Day is open.';
    } else if (Notification.permission === 'denied') {
      text.textContent = 'Blocked in your browser’s site settings. Reminders still appear inside Day by Day.';
    } else {
      text.textContent = 'Not allowed yet. Allow them to get reminders as system notifications, not just inside the app.';
      btn.hidden = false;
    }
  }

  function onNotifyToggle() {
    writePref(NOTIFY_KEY, $('notify-toggle').checked);
    announce($('notify-toggle').checked ? 'Reminders on.' : 'Reminders off.');
  }

  function onNotifyPermission() {
    if (!('Notification' in window)) return;
    Notification.requestPermission().then(function () {
      renderNotifications();
      announce(Notification.permission === 'granted' ? 'Notifications allowed.' : 'Notifications not allowed.');
    });
  }

  function renderPlan() {
    var p = plans.currentPlan();
    $('plan-name').textContent = p.name;
    $('plan-description').textContent = p.description;
    var body = $('plan-table-body');
    if (body.children.length) return;
    plans.FEATURES.forEach(function (f) {
      var tr = el('tr');
      tr.appendChild(el('td', '', f.label));
      [f.free, f.pro].forEach(function (v) {
        var td = el('td');
        if (v === true || v === false) {
          td.className = v ? 'plan-yes' : 'plan-no';
          td.appendChild(icon(v ? 'check' : 'minus', 18));
          td.appendChild(el('span', 'visually-hidden', v ? 'Included' : 'Not included'));
        } else {
          td.textContent = v;
        }
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
  }

  function renderNetwork() {
    var offline = navigator.onLine === false;
    $('net-status').hidden = !offline;
  }

  /* ---------------- Reminders ---------------- */

  /**
   * Checked every 30 seconds while the app is open: a goal with a reminder
   * time that has passed today, is due today and isn't done gets one
   * reminder per day, in the app and (if allowed) as a system notification.
   */
  function checkReminders() {
    if (!plans.can('reminders') || !readPref(NOTIFY_KEY, true)) return;
    var rec = state.days[today];
    if (!rec) return;
    var now = new Date();
    var hhmm = (now.getHours() < 10 ? '0' : '') + now.getHours() + ':' + (now.getMinutes() < 10 ? '0' : '') + now.getMinutes();
    var sent = readPref(REMINDED_KEY, {});
    if (sent.date !== today) sent = { date: today, ids: [] };
    var due = rec.habits.filter(function (entry) {
      var h = core.findHabit(state, entry.id);
      return h && h.reminder && h.reminder <= hhmm && rec.done.indexOf(entry.id) < 0 && sent.ids.indexOf(entry.id) < 0;
    });
    if (!due.length) return;
    due.forEach(function (entry) { sent.ids.push(entry.id); });
    writePref(REMINDED_KEY, sent);
    var names = due.map(function (e) { return e.name; });
    var body = names.length === 1 ? names[0] + ' isn’t checked off yet today.' : names.join(', ') + ' aren’t checked off yet today.';
    showNotice('Reminder: ' + body, { label: 'Go to Today', run: function () { hideNotice(); selectTab('today', true); } });
    if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
      try {
        var n = new Notification('Day by Day', { body: body, tag: 'dbd-' + today, icon: 'icon.svg' });
        n.onclick = function () { window.focus(); selectTab('today'); n.close(); };
      } catch (e) {
        // Some browsers only allow notifications from a service worker.
      }
    }
  }

  /* ---------------- Offline ---------------- */

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
    navigator.serviceWorker.register('sw.js').catch(function () {
      // The app still works online; offline loading just isn't available.
    });
  }

  /* ---------------- Render ---------------- */

  function render() {
    renderToday();
    // Don't rebuild the editor under a drag.
    if ($('goals-dialog').open && !drag) renderManage();
    if (activeTab === 'stats') renderStats();
    if (activeTab === 'settings') renderSettings();
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
    renderSyncLast();
  }

  function renderSyncLast() {
    var line = $('sync-last');
    if (!line) return;
    if (!cloudUser || !syncMeta.syncedAt) {
      line.textContent = '';
      return;
    }
    var t = new Date(syncMeta.syncedAt);
    line.textContent = 'Last successful sync: ' + t.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + '.';
  }

  /**
   * True (and tells the user) when an action must wait: the account's latest
   * copy hasn't arrived yet and this device's copy looks out of date.
   */
  function holdForAccount() {
    if (!waitingForAccount || !core.ensureDays(state, today).missed.length) return false;
    announce('Checking your account for newer progress. Try again in a moment.');
    $('hero-status').textContent = 'Checking your account for newer progress…';
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
      ? 'Your progress is saved on this device and in your account. Export a backup file any time.'
      : 'Everything is stored in this browser. Export a backup file to keep it safe or move it to another device.';
    $('privacy-account-note').textContent = signedIn ? ' and in your private account, which only you can read' : '';
    renderSyncLast();
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
    $('footer-text').textContent = 'Day by Day works offline. Signing in is optional.';
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
    icons.hydrate(document);
    var loaded = store.load(storage, new Date());
    state = loaded.state;
    readOnly = loaded.readOnly;
    if (loaded.notice) showNotice(loaded.notice);

    initTooltips();
    syncNavOrientation();
    if (SIDEBAR.addEventListener) SIDEBAR.addEventListener('change', syncNavOrientation);
    TABS.forEach(function (t) {
      $('tab-' + t).addEventListener('click', function () { selectTab(t); });
      $('tab-' + t).addEventListener('keydown', onTabKey);
    });

    // Today
    $('goals-card').addEventListener('change', onGoalChange);
    $('first-goal-form').addEventListener('submit', onFirstGoal);
    $('focus-form').addEventListener('submit', onFocusSubmit);
    $('focus-input').addEventListener('blur', saveFocus);
    $('edit-goals').addEventListener('click', openManage);
    $('add-goal').addEventListener('click', function () { openGoalForm(null); });

    // Edit goals
    $('manage-done').addEventListener('click', function () { closeDialog('goals-dialog'); });
    $('manage-add').addEventListener('click', function () { openGoalForm(null); });
    $('goals-dialog').addEventListener('click', onManageClick);
    $('goals-dialog').addEventListener('keydown', onHandleKey);
    $('manage-active').addEventListener('pointerdown', onHandleDown);
    $('manage-active').addEventListener('pointermove', onHandleMove);
    $('manage-active').addEventListener('pointerup', onHandleUp);
    $('manage-active').addEventListener('pointercancel', onHandleUp);
    $('goals-dialog').addEventListener('close', function () {
      manageError('');
      restoreFocus('goals-dialog', state.habits.length ? $('edit-goals') : $('first-goal'));
    });

    // Goal form
    $('goal-form').addEventListener('submit', onGoalFormSubmit);
    $('goal-form').addEventListener('change', function (e) {
      if (e.target.name === 'gf-schedule' || e.target.id === 'gf-remind') syncScheduleFields();
    });
    $('goal-form-close').addEventListener('click', function () { closeDialog('goal-form-dialog'); });
    $('gf-cancel').addEventListener('click', function () { closeDialog('goal-form-dialog'); });
    $('gf-pause').addEventListener('click', onGoalPause);
    $('gf-remove').addEventListener('click', onGoalRemove);
    $('goal-form-dialog').addEventListener('close', function () {
      var fallback = $('goals-dialog').open ? $('manage-add') : state.habits.length ? $('add-goal') : $('first-goal');
      restoreFocus('goal-form-dialog', fallback);
      editingId = null;
    });

    // Stats
    $('cal-grid').addEventListener('click', onCalendarClick);
    $('cal-prev').addEventListener('click', function () { moveMonth(-1); });
    $('cal-next').addEventListener('click', function () { moveMonth(1); });
    $('range-control').addEventListener('change', onRangeChange);
    $('share-week').addEventListener('click', onShareWeek);
    $('goal-history-toggle').addEventListener('click', onGoalHistoryToggle);
    $('early-action').addEventListener('click', function () { selectTab('today', true); });
    $('day-dialog-close').addEventListener('click', function () { closeDialog('day-dialog'); });
    $('day-dialog').addEventListener('close', function () { restoreFocus('day-dialog', $('cal-grid')); });
    WIDE.addEventListener && WIDE.addEventListener('change', function () {
      if (WIDE.matches && $('day-dialog').open) closeDialog('day-dialog');
    });

    // Settings
    $('weekstart-control').addEventListener('change', onWeekStart);
    $('notify-toggle').addEventListener('change', onNotifyToggle);
    $('notify-permission').addEventListener('click', onNotifyPermission);
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
    window.addEventListener('online', function () { renderNetwork(); });
    window.addEventListener('offline', function () { renderNetwork(); });

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) checkForNewDay();
    });
    window.addEventListener('focus', checkForNewDay);
    setInterval(function () {
      checkForNewDay();
      checkReminders();
    }, 30 * 1000);

    var resizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (activeTab !== 'stats') return;
        renderDailyChart();
        renderGoalHistory();
      }, 150);
    });

    startCloud();
    refreshDays();
    selectTab(location.hash.slice(1));
    render();
    checkReminders();
    registerServiceWorker();
  }

  init();
})();
