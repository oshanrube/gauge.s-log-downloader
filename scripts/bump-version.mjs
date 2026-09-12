// Moves the patch version, in every file that has to agree about it.
//
// package.json is the source of truth for the release tag; sw.js and index.html
// carry APP_VERSION, which keys the service worker cache. If those drift, an
// installed app keeps serving the old shell from cache and a release reaches
// nobody — so a mismatch fails the build rather than shipping quietly.
//
//   node scripts/bump-version.mjs          # print the next version, change nothing
//   node scripts/bump-version.mjs --write  # write it into all three files
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(join(root, file), 'utf8');

export function nextPatch(version) {
  const parts = version.split('.').map(Number);
  if (parts.length !== 3 || parts.some(n => !Number.isInteger(n) || n < 0)) {
    throw new Error(`not a version this can bump: ${version}`);
  }
  parts[2]++;
  return parts.join('.');
}

export function edits(current, next) {
  return [
    ['package.json', `"version": "${current}"`, `"version": "${next}"`],
    ['sw.js', `const APP_VERSION = '${current}'`, `const APP_VERSION = '${next}'`],
    ['index.html', `const APP_VERSION = '${current}'`, `const APP_VERSION = '${next}'`],
  ];
}

export function currentVersion() {
  return JSON.parse(read('package.json')).version;
}

export function bump({ write = false } = {}) {
  const current = currentVersion();
  const next = nextPatch(current);

  for (const [file, from, to] of edits(current, next)) {
    const before = read(file);
    if (!before.includes(from)) {
      throw new Error(`${file}: expected to find ${JSON.stringify(from)} — version strings have drifted`);
    }
    if (write) writeFileSync(join(root, file), before.split(from).join(to));
  }
  return { current, next };
}

// Only act when run directly, so the test suite can import the pieces.
if (process.argv[1] && process.argv[1].endsWith('bump-version.mjs')) {
  const { current, next } = bump({ write: process.argv.includes('--write') });
  process.stderr.write(`${current} -> ${next}\n`);
  process.stdout.write(next);
}
