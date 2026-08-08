// Post-processes the adaptive-icon XML that `capacitor-assets generate` emits.
//
// The generator insets BOTH layers by 16.7%, which leaves the background
// covering only the central 72dp of the 108dp canvas — exactly the mask, with
// nothing to spare. Launchers that apply parallax shift the layers a few dp on
// scroll and expose transparent edges. Android's guidance is that the
// background fills the full canvas, so the inset is dropped from that layer
// and kept on the foreground (which is what defines the safe zone).
//
// Re-run automatically as part of `npm run icons`; the generator overwrites
// these files every time.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'android/app/src/main/res/mipmap-anydpi-v26');

const FIXED = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <!-- Full-bleed: the background must cover all 108dp, not just the mask. -->
    <background android:drawable="@mipmap/ic_launcher_background" />
    <foreground>
        <inset android:drawable="@mipmap/ic_launcher_foreground" android:inset="16.7%" />
    </foreground>
</adaptive-icon>
`;

let patched = 0;
for (const file of await readdir(dir)) {
  if (!file.endsWith('.xml')) continue;
  const path = join(dir, file);
  if ((await readFile(path, 'utf8')).includes('<background>')) {
    await writeFile(path, FIXED);
    patched++;
  }
}

console.log(`Made the adaptive-icon background full-bleed in ${patched} file(s).`);
