'use strict';

// GitHub Pages lets browsers cache CSS/JS for several minutes. Every local
// stylesheet and script in index.html carries the same ?v= tag, so bumping it
// makes browsers fetch fresh files right after a deploy.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const refs = Array.from(html.matchAll(/(?:href|src)="((?:css|js)\/[^"]+)"/g), (m) => m[1]);

test('index.html references its stylesheet and scripts', () => {
  assert.ok(refs.length >= 5, 'found ' + refs.length + ' asset references');
});

test('every local CSS/JS reference has the same cache-busting version', () => {
  const versions = new Set();
  for (const ref of refs) {
    const m = /\?v=([\w.-]+)$/.exec(ref);
    assert.ok(m, ref + ' is missing a ?v= version tag');
    versions.add(m[1]);
    const file = ref.replace(/\?.*$/, '');
    assert.ok(fs.existsSync(path.join(__dirname, '..', file)), file + ' does not exist');
  }
  assert.equal(versions.size, 1, 'all assets should share one version, found: ' + Array.from(versions).join(', '));
});
