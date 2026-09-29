// Usage: npm run add-link -- <app url> <bookings.json> [trip id]
// bookings.json holds one booking object or an array of them, in the app's item
// format. Prints a link that adds them to an existing trip on the phone without
// touching anything else; a booking whose id already exists there is replaced.
import { readFileSync } from 'node:fs';
import { addLink } from '../app/share.js';

const [base, file, tripId = ''] = process.argv.slice(2);
if (!base || !file) { console.error('Usage: npm run add-link -- <app url> <bookings.json> [trip id]'); process.exit(1); }
const data = JSON.parse(readFileSync(file, 'utf8'));
const items = Array.isArray(data) ? data : [data];
for (const it of items) {
  if (!it.id || !it.type || !it.date) { console.error(`Each booking needs id, type and date: ${JSON.stringify(it).slice(0, 80)}`); process.exit(1); }
}
console.log(await addLink(items, { tripId, base }));
