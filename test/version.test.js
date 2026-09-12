// The version lives in three files that must agree: package.json names the
// release tag, and APP_VERSION in sw.js and index.html keys the service worker
// cache. Drift means an installed app keeps serving the old shell from cache,
// so a release reaches nobody — silently.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const load = () => import('../scripts/bump-version.mjs');

test('the patch number moves', async () => {
    const { nextPatch } = await load();
    assert.strictEqual(nextPatch('1.26.0'), '1.26.1');
    assert.strictEqual(nextPatch('1.9.9'), '1.9.10');
    assert.strictEqual(nextPatch('0.0.0'), '0.0.1');
});

test('a version it cannot parse is refused rather than mangled', async () => {
    const { nextPatch } = await load();
    for (const bad of ['1.26', '1.26.0-beta', 'latest', '', 'v1.26.0']) {
        assert.throws(() => nextPatch(bad), `"${bad}" should not bump`);
    }
});

test('all three files carry the current version', async () => {
    // A dry run resolves every replacement without writing, so this fails the
    // moment one of the files drifts out of step with package.json.
    const { bump, currentVersion, nextPatch } = await load();
    const result = bump();
    assert.strictEqual(result.current, currentVersion());
    assert.strictEqual(result.next, nextPatch(currentVersion()));
});

test('a dry run leaves the files alone', async () => {
    const { readFileSync } = require('node:fs');
    const { join } = require('node:path');
    const files = ['package.json', 'sw.js', 'index.html']
        .map(f => join(__dirname, '..', f));
    const before = files.map(f => readFileSync(f, 'utf8'));

    const { bump } = await load();
    bump();

    files.forEach((f, i) => {
        assert.strictEqual(readFileSync(f, 'utf8'), before[i], `${f} must not be touched`);
    });
});
