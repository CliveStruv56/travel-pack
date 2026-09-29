// Usage: npm run link -- https://your-host/path/ trips/your-trip.travelpack.json
// Prints a setup link that opens the trip in Travel Pack as your own editable
// trip, ready to "Save to this phone".
// The trip travels in the part after '#', which browsers never send to the server.
import { readFileSync } from 'node:fs';
const [base, file] = process.argv.slice(2);
if (!base || !file) { console.error('Usage: npm run link -- <app url> <trip file>'); process.exit(1); }
const bundle = JSON.parse(readFileSync(file, 'utf8'));
const payload = { v: 1, editable: true, from: '', sharedAt: new Date().toISOString(), trip: bundle.trips[0] };
const cs = new Blob([JSON.stringify(payload)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
const b64 = Buffer.from(await new Response(cs).arrayBuffer()).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
console.log(`${base.replace(/#.*$/, '')}#share=${b64}`);
