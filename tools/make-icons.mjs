// Renders the app icons to PNG with headless Chromium: a plane's dotted trail
// arcing over an island sunset. `full` is the edge-to-edge maskable version
// (Android crops it to a circle or squircle, so the subject sits further in).
import { chromium } from 'playwright';

const PLANE = 'M12 1.5c.9 0 1.5.9 1.5 2V9l8 4.8v2.1l-8-2.5v4.8l2.4 1.8v1.7L12 20.8l-3.9.9v-1.7l2.4-1.8v-4.8l-8 2.5v-2.1l8-4.8V3.5c0-1.1.6-2 1.5-2z';

const scene = `
  <rect width="512" height="512" fill="url(#sky)"/>
  <circle cx="300" cy="352" r="78" fill="#ffd27a"/>
  <path d="M0 360 C70 330 120 335 170 350 C215 362 250 345 290 352 L290 512 L0 512Z" fill="#0d4a5e"/>
  <rect y="352" width="512" height="160" fill="url(#sea)"/>
  <path d="M0 392 Q64 376 128 392 T256 392 T384 392 T512 392" fill="none" stroke="#ffd27a" stroke-opacity=".55" stroke-width="7" stroke-linecap="round"/>
  <path d="M40 432 Q104 416 168 432 T296 432 T424 432 T552 432" fill="none" stroke="#fff" stroke-opacity=".25" stroke-width="7" stroke-linecap="round"/>
  <path d="M86 300 C150 150 300 110 410 150" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round" stroke-dasharray="1 24"/>
  <g transform="translate(410 150) rotate(78) scale(3.6) translate(-12 -12)" fill="#fff"><path d="${PLANE}"/></g>`;

const svg = (full) => `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0b3f5c"/><stop offset=".55" stop-color="#1f7a8c"/><stop offset=".78" stop-color="#f4a261"/><stop offset="1" stop-color="#e76f51"/>
    </linearGradient>
    <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0e5a73"/><stop offset="1" stop-color="#083247"/></linearGradient>
    <clipPath id="c"><rect x="16" y="16" width="480" height="480" rx="112"/></clipPath>
  </defs>
  ${full ? scene : `<g clip-path="url(#c)">${scene}</g>`}
</svg>`;

// Status-bar badge: Android shows only the alpha channel, so a white plane.
const badge = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 24 24"><g transform="rotate(45 12 12)" fill="#fff"><path d="${PLANE}"/></g></svg>`;

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 512, height: 512 } });
const shoot = async (name, size, s) => {
  await p.setViewportSize({ width: size, height: size });
  await p.setContent(`<style>html,body{margin:0;background:transparent}</style><img src="data:image/svg+xml;base64,${Buffer.from(s).toString('base64')}" width="${size}" height="${size}">`);
  await p.screenshot({ path: `app/icons/${name}.png`, omitBackground: true });
};
await shoot('icon-512', 512, svg(false));
await shoot('icon-192', 192, svg(false));
await shoot('maskable-512', 512, svg(true));
await shoot('badge-96', 96, badge);
await b.close();
console.log('icons ok');
