'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const theme = require('../js/theme.js');
const { FakeStorage } = require('./helpers.js');

test('unknown or damaged theme preferences fall back to auto', () => {
  for (const bad of [null, undefined, '', 'blue', 'DARK', 42]) {
    assert.equal(theme.normalizePreference(bad), 'auto');
  }
  assert.equal(theme.normalizePreference('dark'), 'dark');
});

test('auto follows the device setting; explicit choices override it', () => {
  assert.equal(theme.resolveTheme('auto', true), 'dark');
  assert.equal(theme.resolveTheme('auto', false), 'light');
  assert.equal(theme.resolveTheme('light', true), 'light');
  assert.equal(theme.resolveTheme('dark', false), 'dark');
  assert.equal(theme.resolveTheme('garbage', true), 'dark');
});

test('theme preference is saved separately from challenge data', () => {
  const storage = new FakeStorage();
  assert.equal(theme.readPreference(storage), 'auto');
  assert.equal(theme.writePreference(storage, 'dark'), true);
  assert.equal(theme.readPreference(storage), 'dark');
  assert.deepEqual(storage.keys(), ['day-by-day.theme']);
});

test('blocked storage does not break theming', () => {
  const blocked = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); } };
  assert.equal(theme.readPreference(blocked), 'auto');
  assert.equal(theme.writePreference(blocked, 'dark'), false);
});
