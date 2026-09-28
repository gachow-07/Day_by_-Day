'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const plans = require('../js/plans.js');

test('without billing everyone is on Early access with every Pro feature', () => {
  const p = plans.currentPlan();
  assert.equal(p.id, 'early-access');
  assert.equal(p.billingAvailable, false);
  for (const f of plans.FEATURES) assert.equal(plans.can(f.id), true, f.id);
  assert.equal(plans.limit('activeGoals'), null);
  assert.equal(plans.limit('historyDays'), null);
});

test('the Free plan: 5 goals, 30 days of history, basic streaks and stats only', () => {
  const free = plans.planFor('free');
  assert.equal(plans.limit('activeGoals', free), 5);
  assert.equal(plans.limit('historyDays', free), 30);
  assert.equal(plans.can('streaks', free), true);
  assert.equal(plans.can('basicStats', free), true);
  for (const f of ['flexibleSchedules', 'reminders', 'reflections', 'weeklyReview', 'fullHistory', 'advancedTrends', 'export', 'sharing', 'quickCheckIn']) {
    assert.equal(plans.can(f, free), false, f);
  }
});

test('the Pro plan includes everything with no limits', () => {
  const pro = plans.planFor('pro');
  for (const f of plans.FEATURES) assert.equal(plans.can(f.id, pro), true);
  assert.equal(plans.limit('activeGoals', pro), null);
});

test('unknown features and limits are never granted by accident', () => {
  assert.equal(plans.can('teleport'), false);
  assert.equal(plans.limit('nothing'), null);
  assert.equal(plans.planFor('platinum').id, 'early-access');
});
