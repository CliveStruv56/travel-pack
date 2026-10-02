// Weather from Open-Meteo (free, no account, works from the browser). Results
// are cached on the phone so the last forecast is still there with no signal.
import { db } from './db.js';

const GEO = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const MAX_AGE = 3 * 3600000;

/** "Kirkwall (Hatston)" → ["Kirkwall (Hatston)", "Kirkwall"]; "London Heathrow T2" → … "London Heathrow", "London". */
export function placeCandidates(name) {
  const s = String(name || '').replace(/\s+/g, ' ').trim();
  if (!s) return [];
  const out = [s];
  const noParen = s.replace(/\s*\(.*?\)\s*/g, ' ').trim();
  if (noParen !== s) out.push(noParen);
  const first = noParen.split(',')[0].trim();
  if (first !== noParen) out.push(first);
  const words = first.split(' ');
  for (let n = words.length - 1; n >= 1; n--) out.push(words.slice(0, n).join(' '));
  return [...new Set(out)].filter((x) => x.length > 2);
}

export async function geocode(name) {
  const key = 'geo:' + name.toLowerCase();
  const hit = await db.get('meta', key);
  if (hit !== undefined) return hit;
  if (!navigator.onLine) return null;
  for (const q of placeCandidates(name)) {
    try {
      const r = await fetch(`${GEO}?${new URLSearchParams({ name: q, count: '1', language: 'en', format: 'json' })}`, { signal: AbortSignal.timeout(10000) });
      const j = await r.json();
      const g = j.results?.[0];
      if (g) {
        const out = { lat: Math.round(g.latitude * 100) / 100, lon: Math.round(g.longitude * 100) / 100, label: g.name };
        await db.put('meta', out, key);
        return out;
      }
    } catch { return null; }
  }
  await db.put('meta', null, key);
  return null;
}

export async function forecast(lat, lon, { force = false } = {}) {
  const key = `wx:${lat},${lon}`;
  const hit = await db.get('meta', key);
  if (hit && (!navigator.onLine || (!force && Date.now() - hit.at < MAX_AGE))) return hit.data;
  if (!navigator.onLine) return hit?.data || null;
  try {
    const p = new URLSearchParams({
      latitude: lat, longitude: lon, timezone: 'Europe/London', wind_speed_unit: 'mph', forecast_days: '16',
      hourly: 'temperature_2m,precipitation_probability,weather_code,wind_speed_10m,wind_gusts_10m,visibility',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_gusts_10m_max',
    });
    const r = await fetch(`${FORECAST}?${p}`, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return hit?.data || null;
    const data = await r.json();
    await db.put('meta', { at: Date.now(), data }, key);
    return data;
  } catch {
    return hit?.data || null;
  }
}

const WMO = [
  [[0], 'Clear', '☀️'], [[1], 'Mostly clear', '🌤️'], [[2], 'Partly cloudy', '⛅'], [[3], 'Overcast', '☁️'],
  [[45, 48], 'Fog', '🌫️'], [[51, 53, 55, 56, 57], 'Drizzle', '🌦️'], [[61, 63, 80, 81], 'Rain', '🌧️'],
  [[65, 82, 66, 67], 'Heavy rain', '🌧️'], [[71, 73, 75, 77, 85, 86], 'Snow', '🌨️'], [[95, 96, 99], 'Thunderstorms', '⛈️'],
];
export function describeCode(c) {
  const row = WMO.find(([codes]) => codes.includes(c));
  return row ? { label: row[1], emoji: row[2] } : { label: '', emoji: '🌡️' };
}

export function daily(data, date) {
  const i = data?.daily?.time?.indexOf(date) ?? -1;
  if (i < 0) return null;
  const d = data.daily;
  return {
    code: d.weather_code[i], max: Math.round(d.temperature_2m_max[i]), min: Math.round(d.temperature_2m_min[i]),
    rain: d.precipitation_probability_max?.[i], gusts: Math.round(d.wind_gusts_10m_max?.[i] ?? 0),
  };
}

export function hourly(data, date, time) {
  const h = data?.hourly;
  if (!h?.time) return null;
  const want = `${date}T${(time || '12:00').slice(0, 2)}:00`;
  const i = h.time.indexOf(want);
  if (i < 0) return null;
  return {
    code: h.weather_code[i], temp: Math.round(h.temperature_2m[i]), rain: h.precipitation_probability?.[i],
    wind: Math.round(h.wind_speed_10m[i]), gusts: Math.round(h.wind_gusts_10m[i]), visibility: h.visibility?.[i],
  };
}

/**
 * How likely weather is to disrupt a leg. A rough guide, not a prediction:
 * small island aircraft are grounded by strong crosswinds and fog well before
 * larger aircraft; ferries by severe gales.
 */
export function legRisk(kind, points) {
  const reasons = [];
  let level = 0;
  const [watchG, highG] = kind === 'ferry' ? [42, 55] : [38, 50];
  for (const p of points) {
    if (!p.w) continue;
    const { gusts, visibility, code } = p.w;
    if (gusts >= highG) { level = Math.max(level, 2); reasons.push(`gusts ${gusts} mph at ${p.place}`); }
    else if (gusts >= watchG) { level = Math.max(level, 1); reasons.push(`gusts ${gusts} mph at ${p.place}`); }
    if (kind !== 'ferry' && (visibility != null && visibility < 1000 || code === 45 || code === 48)) { level = Math.max(level, 2); reasons.push(`fog at ${p.place}`); }
    if (code >= 95) { level = Math.max(level, 1); reasons.push(`thunderstorms at ${p.place}`); }
    if (code >= 71 && code <= 86 && code !== 80 && code !== 81 && code !== 82) { level = Math.max(level, 1); reasons.push(`snow at ${p.place}`); }
  }
  return { level, reasons };
}

const ISLANDS = /\b(sanday|stronsay|westray|papa westray|eday|north ronaldsay|kirkwall|hoy|lerwick|sumburgh|tingwall|fair isle|foula|unst|stornoway|benbecula|barra|tiree|coll|islay|colonsay|campbeltown|wick|scilly|st mary'?s|alderney|guernsey|jersey|lundy)\b/i;

export function isWeatherSensitive(it) {
  if (typeof it.weatherSensitive === 'boolean') return it.weatherSensitive;
  if (it.type === 'ferry') return true;
  if (it.type === 'flight') return ISLANDS.test(`${it.from} ${it.to}`);
  return false;
}
