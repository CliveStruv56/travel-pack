// Turn an email's HTML into readable plain text (enough for a person or a
// model to read a booking confirmation; not a general HTML renderer).
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', pound: '£', euro: '€', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', copy: '©', reg: '®', trade: '™' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<(script|style|head|title)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|table|section|article)>/gi, '\n');
  s = s.replace(/<\/t[dh]>/gi, ' | ');
  s = s.replace(/<li[^>]*>/gi, '• ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  // Zero-width and other invisible padding that marketing emails stuff in.
  s = s.replace(/[​-‏͏­⁠﻿]/g, '');
  s = s.replace(/[ \t\f\v ]+/g, ' ');
  s = s.replace(/ *\| *(\| *)+/g, ' | ');
  s = s.split('\n').map((l) => l.trim().replace(/^\|\s*|\s*\|$/g, '').trim()).filter((l, i, a) => l || (a[i - 1] && a[i - 1].trim())).join('\n');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}
