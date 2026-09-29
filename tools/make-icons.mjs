// Renders the app icons to PNG with headless Chromium.
import { chromium } from 'playwright';
const glyph = (s) => `
  <g transform="translate(${256 - 128 * s} ${256 - 128 * s}) scale(${s * 10.667})" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="7" width="18" height="13" rx="2.5"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
    <path d="M7 13.5h10" stroke-dasharray="0.01 2.6" stroke-width="1.9"/>
  </g>`;
const svg = (maskable) => `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0e7490"/><stop offset="1" stop-color="#0b3f5c"/></linearGradient></defs>
  ${maskable ? '<rect width="512" height="512" fill="url(#g)"/>' : '<rect x="16" y="16" width="480" height="480" rx="112" fill="url(#g)"/>'}
  ${glyph(maskable ? 0.9 : 1.1)}
</svg>`;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 512, height: 512 } });
for (const [name, mask, size] of [['icon-512', false, 512], ['icon-192', false, 192], ['maskable-512', true, 512]]) {
  await p.setViewportSize({ width: size, height: size });
  await p.setContent(`<style>html,body{margin:0;background:transparent}</style><img src="data:image/svg+xml;base64,${Buffer.from(svg(mask)).toString('base64')}" width="${size}" height="${size}">`);
  await p.screenshot({ path: `app/icons/${name}.png`, omitBackground: true });
}
await b.close();
console.log('icons ok');
