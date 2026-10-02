// Runs the AI module through the real @anthropic-ai/sdk against a local fake of
// the Messages API, checking what actually goes over the wire. Skipped where
// the SDK isn't installed (it is in CI and on the server).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

let hasSdk = true;
try { await import('@anthropic-ai/sdk'); } catch { hasSdk = false; }

test('real SDK sends a structured-output request with server-side fallback', { skip: !hasSdk && 'SDK not installed' }, async () => {
  let seen = null;
  const fake = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    seen = { path: req.url, headers: req.headers, body: JSON.parse(body) };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
      content: [{ type: 'text', text: JSON.stringify({ summary: 'none', items: [] }) }],
    }));
  });
  await new Promise((r) => fake.listen(0, r));
  process.env.ANTHROPIC_BASE_URL = `http://localhost:${fake.address().port}`;
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const ai = await import('./ai.mjs');
  ai.setClient(null);
  const out = await ai.extractBookings({ text: 'Booking ref ABC123', source: 'email' });
  fake.close();
  assert.deepEqual(out, { summary: 'none', items: [] });
  assert.match(seen.path, /^\/v1\/messages/);
  assert.equal(seen.headers['x-api-key'], 'sk-test');
  assert.match(seen.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(seen.body.model, 'claude-opus-5-5');
  assert.equal(seen.body.fallbacks, 'default');
  assert.equal(seen.body.output_config.format.type, 'json_schema');
  assert.equal(seen.body.betas, undefined, 'betas travel as a header, not in the body');
});
