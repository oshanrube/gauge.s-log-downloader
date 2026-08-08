// Generates the source artwork for the app icon and splash screens.
//
// The mark is a gauge dial whose needle is a download arrow: a full "track"
// arc with a brighter "value" arc over part of it, and a bold download glyph
// in the middle. It has to stay legible at ~48px in a launcher, so there is
// no fine detail — just three heavy shapes.
//
// Output feeds `npx capacitor-assets generate`, which fans these out into
// every Android/iOS density. Run via `npm run icons`.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assets = join(root, 'assets');

// Matches the app UI gradient (see .icon-wrap / #downloadBtn in index.html)
const INDIGO = '#6366f1';
const VIOLET = '#8b5cf6';
const INK = '#0f1117';

const R = 250;                 // gauge radius
const TRACK_FROM = 150;        // arc opens at the bottom
const TRACK_TO = 390;
const VALUE_TO = 290;          // needle "reading" — about 58% of the sweep
const STROKE = 34;

const rad = deg => (deg * Math.PI) / 180;
// y grows downward, so increasing the angle sweeps clockwise on screen.
const pt = deg => [R * Math.cos(rad(deg)), R * Math.sin(rad(deg))];
const fmt = n => Number(n.toFixed(2));

function arc(from, to) {
  const [x1, y1] = pt(from);
  const [x2, y2] = pt(to);
  const largeArc = to - from > 180 ? 1 : 0;
  return `M ${fmt(x1)} ${fmt(y1)} A ${R} ${R} 0 ${largeArc} 1 ${fmt(x2)} ${fmt(y2)}`;
}

// The mark, drawn around the gauge centre at (0,0). Its bounding box runs
// y -250..125 (arc top to the open ends), so it is nudged down when centred.
const GLYPH = `
  <g fill="none" stroke="#ffffff" stroke-linecap="round">
    <path d="${arc(TRACK_FROM, TRACK_TO)}" stroke-width="${STROKE}" stroke-opacity="0.32"/>
    <path d="${arc(TRACK_FROM, VALUE_TO)}" stroke-width="${STROKE}"/>
  </g>
  <g fill="#ffffff">
    <rect x="-40" y="-188" width="80" height="132" rx="15"/>
    <path d="M -118 -84 L 118 -84 L 0 74 Z"/>
  </g>`;

const GLYPH_CENTER_Y = -62.5; // (-250 + 125) / 2

/** Places the mark on a canvas, scaled and optically centred. */
function mark(size, scale) {
  const c = size / 2;
  return `<g transform="translate(${c} ${fmt(c - GLYPH_CENTER_Y * scale)}) scale(${scale})">${GLYPH}</g>`;
}

const gradient = `
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${INDIGO}"/>
    <stop offset="1" stop-color="${VIOLET}"/>
  </linearGradient>`;

function svg(size, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>${gradient}</defs>
  ${body}
</svg>`;
}

// Full-bleed square. iOS applies its own corner mask and rejects transparency,
// so no rounding is baked in here.
const icon = size => svg(size, `
  <rect width="${size}" height="${size}" fill="url(#bg)"/>
  ${mark(size, (size / 1024) * 1.22)}`);

// Adaptive-icon layers. capacitor-assets wraps the foreground in a 16.7%
// inset, shrinking it to the 72dp safe zone, so the mark is drawn oversized
// here to land at roughly 60% of the visible area once that inset applies.
const iconForeground = svg(1024, mark(1024, 1.2));
const iconBackground = svg(1024, `<rect width="1024" height="1024" fill="url(#bg)"/>`);

// Splash: dark app background with a small centred mark.
const splash = svg(2732, `
  <rect width="2732" height="2732" fill="${INK}"/>
  ${mark(2732, 1.1)}`);

const render = (source, file, size) =>
  sharp(Buffer.from(source)).resize(size, size).png({ compressionLevel: 9 }).toFile(file);

await mkdir(assets, { recursive: true });

await Promise.all([
  writeFile(join(assets, 'icon.svg'), icon(1024)),
  render(icon(1024), join(assets, 'icon.png'), 1024),
  render(iconForeground, join(assets, 'icon-foreground.png'), 1024),
  render(iconBackground, join(assets, 'icon-background.png'), 1024),
  render(splash, join(assets, 'splash.png'), 2732),
  render(splash, join(assets, 'splash-dark.png'), 2732),
  // PWA icons at the repo root. manifest.json uses the 512 for `maskable`
  // too, so these are full-bleed with the mark inset.
  render(icon(512), join(root, 'icon-512.png'), 512),
  render(icon(192), join(root, 'icon-192.png'), 192),
]);

console.log('Wrote icon + splash sources to assets/ and refreshed the PWA icons.');
