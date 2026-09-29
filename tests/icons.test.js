'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// icons.js is a browser script; run it in its own global context.
const sandbox = { window: {}, document: {} };
sandbox.self = sandbox.window;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'icons.js'), 'utf8'), sandbox);
const icons = sandbox.DayByDayIcons;

test('every goal icon in the picker exists, has a label and appears once', () => {
  assert.ok(icons.GOAL_ICONS.length >= 80, 'a good range of icons');
  assert.equal(new Set(icons.GOAL_ICONS).size, icons.GOAL_ICONS.length, 'no duplicates');
  for (const name of icons.GOAL_ICONS) {
    assert.ok(icons.has(name), name + ' is bundled');
    assert.match(name, /^[a-z0-9-]{1,32}$/, name + ' is a valid stored icon name');
    assert.ok(icons.GOAL_ICON_LABELS[name] && icons.GOAL_ICON_LABELS[name].trim(), name + ' has a label');
  }
  for (const g of icons.GOAL_ICON_GROUPS) assert.ok(g.label && g.icons.length, 'groups are named and not empty');
});

test('icons chosen before the picker grew are still offered', () => {
  for (const name of ['target', 'dumbbell', 'footprints', 'bike', 'book-open', 'pen-line', 'graduation-cap', 'briefcase',
    'brain', 'heart', 'droplet', 'apple', 'leaf', 'moon', 'bed', 'sun', 'music']) {
    assert.ok(icons.GOAL_ICONS.includes(name), name);
  }
});
