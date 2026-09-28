/*
 * Day by Day — plans and feature entitlements.
 *
 * Defines what the Free and Pro plans include, and answers "can this user
 * use feature X?" from one place. Billing is NOT implemented: there is no
 * payment provider and nothing here takes money. Until billing exists,
 * everyone is on "Early access", which includes every Pro feature, so no
 * existing feature or data is ever locked away.
 *
 * To add billing later: have currentPlan() return 'free' or 'pro' from a
 * verified subscription record, and keep all feature checks going through
 * can() / limit().
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DayByDayPlans = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Every gated feature, with how each plan treats it (for the comparison table). */
  var FEATURES = [
    { id: 'goals', label: 'Active goals', free: 'Up to 5', pro: 'Unlimited' },
    { id: 'streaks', label: 'Locked-in and goal streaks', free: true, pro: true },
    { id: 'basicStats', label: 'Calendar and basic stats', free: true, pro: true },
    { id: 'fullHistory', label: 'History', free: 'Last 30 days', pro: 'Full history' },
    { id: 'flexibleSchedules', label: 'Flexible schedules (weekdays, chosen days, times per week)', free: false, pro: true },
    { id: 'reminders', label: 'Reminders', free: false, pro: true },
    { id: 'quickCheckIn', label: 'Install as an app with a quick check-in shortcut', free: false, pro: true },
    { id: 'reflections', label: 'Daily focus', free: false, pro: true },
    { id: 'weeklyReview', label: 'Weekly review and insights', free: false, pro: true },
    { id: 'advancedTrends', label: 'Advanced trends (90 days, all time, weekdays)', free: false, pro: true },
    { id: 'export', label: 'Data export', free: false, pro: true },
    { id: 'sharing', label: 'Shareable weekly summary', free: false, pro: true }
  ];

  var PLANS = {
    free: {
      id: 'free',
      name: 'Free',
      limits: { activeGoals: 5, historyDays: 30 },
      features: {}
    },
    pro: {
      id: 'pro',
      name: 'Pro',
      limits: { activeGoals: null, historyDays: null },
      features: {}
    }
  };
  FEATURES.forEach(function (f) {
    PLANS.free.features[f.id] = f.free === true;
    PLANS.pro.features[f.id] = true;
  });

  var EARLY_ACCESS = {
    id: 'early-access',
    name: 'Early access',
    description: 'All Pro features are included while paid plans are being prepared. Nothing is charged, and you’ll be told before anything changes.',
    billingAvailable: false,
    limits: PLANS.pro.limits,
    features: PLANS.pro.features
  };

  /** The plan in effect. Without billing, always Early access. */
  function currentPlan() {
    return EARLY_ACCESS;
  }

  function planFor(id) {
    return id === 'free' || id === 'pro' ? PLANS[id] : EARLY_ACCESS;
  }

  /** Whether `feature` is included in `plan` (default: the current plan). */
  function can(feature, plan) {
    var p = plan || currentPlan();
    return p.features[feature] === true;
  }

  /** A numeric limit (e.g. 'activeGoals'); null means no plan limit. */
  function limit(name, plan) {
    var p = plan || currentPlan();
    return Object.prototype.hasOwnProperty.call(p.limits, name) ? p.limits[name] : null;
  }

  return {
    FEATURES: FEATURES,
    PLANS: PLANS,
    currentPlan: currentPlan,
    planFor: planFor,
    can: can,
    limit: limit
  };
});
