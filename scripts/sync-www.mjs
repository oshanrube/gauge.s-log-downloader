// Collects the app shell into www/, which is what Capacitor bundles into the
// native binaries (capacitor.config.json -> webDir).
//
// index.html stays at the repo root so GitHub Pages keeps serving the PWA from
// there unchanged; this just mirrors it plus its assets into the build folder.
import { mkdir, copyFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'www');

// sw.js is copied for parity with the hosted app, but the native build does not
// register it — see the IS_NATIVE branch at the bottom of index.html.
const SHELL = ['index.html', 'manifest.json', 'icon-192.png', 'icon-512.png', 'sw.js'];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const file of SHELL) {
  await copyFile(join(root, file), join(out, file));
}

console.log(`Copied ${SHELL.length} shell file(s) into www/`);
