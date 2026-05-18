// api/_maps.js — Driving-distance helper for TerraGenie ICP D2D scoring.
//
// Two-step flow per lead:
//   1. Geocode the destination address → [longitude, latitude] via OSM Nominatim
//      (free, no key, respect 1 req/sec usage policy and User-Agent header).
//   2. Get the driving route from TerraGenie HQ (5322 Ridgeway Dr, Orlando, FL
//      32819) to the destination via OpenRouteService POST /v2/directions/
//      driving-car (free tier, ORS_API_KEY env var, 2000 req/day cap).
//
// The HQ origin gets geocoded once per Vercel cold start and cached in module
// memory. Destinations are geocoded on demand.
//
// All public functions return null on any failure path so the calling
// enrichment pipeline can degrade gracefully (D2D score falls back to
// geography-blind scoring per the fallback chain Rob approved).

const ORS_DIRECTIONS_URL = 'https://api.openrouteservice.org/v2/directions/driving-car';
const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_USER_AGENT = 'TerraGenie-Enrichment/1.0 (https://terragenie.us)';

// Origin: TerraGenie HQ. Coords hardcoded from OSM Nominatim lookup of
// "Ridgeway Drive, Dr Phillips, FL" on 2026-05-18 (Nominatim does not index
// the specific street number 5322, but the street centerline is within a
// few hundred meters of the address). Hardcoding eliminates a cold-start
// geocode call and any dependency on Nominatim availability.
//
// If TerraGenie's HQ ever moves, override via env ORIGIN_COORDS_LON_LAT
// (e.g., "-81.4787,28.4813") or update these constants.
const ORIGIN_ADDRESS = '5322 Ridgeway Dr, Orlando, FL 32819';
const HQ_COORDS_HARDCODED = [-81.4786716, 28.4812721]; // [lon, lat]

function getOriginCoords() {
  const override = process.env.ORIGIN_COORDS_LON_LAT;
  if (override) {
    const parts = override.split(',').map(s => parseFloat(s.trim()));
    if (parts.length === 2 && isValidLonLat(parts)) return parts;
    console.warn(`[maps] ORIGIN_COORDS_LON_LAT invalid: "${override}", falling back to hardcoded`);
  }
  return HQ_COORDS_HARDCODED;
}

// ─── Coord validation ──────────────────────────────────────────────────────

function isValidLonLat(coords) {
  if (!Array.isArray(coords) || coords.length !== 2) return false;
  const [lon, lat] = coords;
  return typeof lon === 'number' && typeof lat === 'number'
    && Number.isFinite(lon) && Number.isFinite(lat)
    && lon >= -180 && lon <= 180
    && lat >= -90 && lat <= 90;
}

// ─── Geocoding (OSM Nominatim) ─────────────────────────────────────────────

// Strip suite/unit/apt/ste/#/floor/building modifiers from an address.
// Nominatim's free tier does not index individual unit numbers, and the
// presence of a unit modifier causes the whole geocode to fail rather than
// fall back to the street-level match. Stripping these recovers the match
// without losing meaningful location precision (a 6-story building's suite
// 375 vs suite 104 is irrelevant for drive-time scoring).
//
// Examples:
//   "2222 Ocoee Apopka Rd Suite 104, Ocoee, FL 34761"
//     -> "2222 Ocoee Apopka Rd, Ocoee, FL 34761"
//   "5401 S Kirkman Rd, Suite 375, Orlando, FL 32819"
//     -> "5401 S Kirkman Rd, Orlando, FL 32819"
//   "100 Main St Apt 5B, Tampa FL"
//     -> "100 Main St, Tampa FL"
function cleanAddressForGeocoding(addressString) {
  if (!addressString || typeof addressString !== 'string') return addressString;
  // Strip "Suite/Ste/Unit/Apt/Apartment/Floor/Bldg/Building XXX" patterns,
  // with or without leading comma. Do NOT include "fl" as a token (it
  // collides with the state "FL" + zip pattern, e.g. "FL 34761" was being
  // stripped). "Floor" spelled out is still caught.
  let out = addressString
    .replace(/,?\s*(?:suite|ste|unit|apt|apartment|floor|bldg|building)\s+[\w\-#]+/gi, '')
    .replace(/,?\s*#\s*[\w\-]+/g, '')
    // Collapse double commas + extra whitespace caused by the strip
    .replace(/,\s*,/g, ',')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/,\s*$/, '')
    .trim();
  return out;
}

// Geocode a free-form address string to [longitude, latitude].
// Tries the address as-given first, then a cleaned version with suite/unit
// modifiers stripped (Nominatim free tier limitation workaround).
// Returns null on failure or no match.
async function geocodeAddress(addressString) {
  if (!addressString || typeof addressString !== 'string' || addressString.trim().length === 0) {
    return null;
  }
  const original = addressString.trim();
  const cleaned = cleanAddressForGeocoding(original);
  const attempts = cleaned && cleaned !== original ? [original, cleaned] : [original];

  for (const q of attempts) {
    const url = `${NOMINATIM_SEARCH_URL}?q=${encodeURIComponent(q)}&format=json&limit=1&countrycodes=us`;
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': NOMINATIM_USER_AGENT,
          'Accept': 'application/json'
        }
      });
      if (!res.ok) {
        console.warn(`[maps] nominatim status=${res.status} for "${q.substring(0, 80)}"`);
        continue;
      }
      const arr = await res.json();
      if (!Array.isArray(arr) || arr.length === 0) {
        console.warn(`[maps] nominatim no match for "${q.substring(0, 80)}"`);
        // brief sleep before retry attempt to be polite to Nominatim
        if (attempts.length > 1) await new Promise(r => setTimeout(r, 200));
        continue;
      }
      const lat = parseFloat(arr[0].lat);
      const lon = parseFloat(arr[0].lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        console.warn(`[maps] nominatim returned non-numeric coords for "${q.substring(0, 80)}"`);
        continue;
      }
      if (q !== original) {
        console.log(`[maps] geocoded via cleaned fallback: "${original.substring(0, 60)}" -> "${q.substring(0, 60)}"`);
      }
      return [lon, lat];
    } catch (err) {
      console.warn(`[maps] nominatim threw on "${q.substring(0, 80)}": ${err.message}`);
      continue;
    }
  }
  return null;
}

// ─── ORS Directions ────────────────────────────────────────────────────────

// Get driving distance + duration between two [lon, lat] coord pairs.
// Returns { distance_meters, distance_miles, distance_km, duration_seconds,
//           duration_minutes } on success, null on failure.
async function getDriveRoute(originCoords, destCoords) {
  const apiKey = process.env.ORS_API_KEY;
  if (!apiKey) {
    console.warn('[maps] ORS_API_KEY not set, skipping drive route');
    return null;
  }
  if (!isValidLonLat(originCoords) || !isValidLonLat(destCoords)) {
    console.warn('[maps] invalid coords passed to getDriveRoute');
    return null;
  }
  const body = { coordinates: [originCoords, destCoords] };
  try {
    const res = await fetch(ORS_DIRECTIONS_URL, {
      method: 'POST',
      headers: {
        'Authorization': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[maps] ORS status=${res.status}: ${text.substring(0, 200)}`);
      return null;
    }
    const data = await res.json();
    // ORS v2 directions/driving-car returns either { routes: [...] } or
    // { features: [...] } depending on output flag. Default is `routes`.
    const summary = data && data.routes && data.routes[0] && data.routes[0].summary;
    if (!summary || typeof summary.distance !== 'number' || typeof summary.duration !== 'number') {
      console.warn('[maps] ORS response missing route summary');
      return null;
    }
    const meters = summary.distance;
    const seconds = summary.duration;
    return {
      distance_meters: meters,
      distance_miles: +(meters / 1609.344).toFixed(2),
      distance_km: +(meters / 1000).toFixed(2),
      duration_seconds: seconds,
      duration_minutes: +(seconds / 60).toFixed(1)
    };
  } catch (err) {
    console.warn(`[maps] getDriveRoute threw: ${err.message}`);
    return null;
  }
}

// ─── High-level wrapper for the enrichment pipeline ─────────────────────────

// Get the driving distance + duration from TerraGenie HQ to a destination
// address. Geocodes the destination, looks up the route, returns a clean
// summary object. Origin is geocoded once per cold start.
//
// Returns null on any failure (no key, geocoding miss, ORS down). Calling
// code should treat null as "drive time unavailable, use geography-blind
// scoring" per Rob's approved fallback chain.
async function getDriveFromTerraGenieHQ(destinationAddress) {
  if (!destinationAddress) return null;

  const originCoords = getOriginCoords();
  const destCoords = await geocodeAddress(destinationAddress);
  if (!destCoords) return null;

  const route = await getDriveRoute(originCoords, destCoords);
  if (!route) return null;

  return {
    distance_miles: route.distance_miles,
    distance_km: route.distance_km,
    duration_minutes: route.duration_minutes,
    origin_coords: originCoords,
    dest_coords: destCoords,
    origin_address: ORIGIN_ADDRESS,
    dest_address: destinationAddress
  };
}

// ─── ICP D2D tier mapping (per Rob's spec) ──────────────────────────────────

// Map drive duration in minutes to the D2D points contribution. Tier
// thresholds and point values per Rob's locked spec (2026-05-18):
//   < 45 min        → +35
//   45 to 90 min    → +25
//   90 to 150 min   → +10
//   150 to 240 min  → -5
//   240 to 360 min  → -15
//   >= 360 min      → -20
// Returns 0 if minutes is null/undefined/NaN (D2D defaults to geo-blind).
function driveTimeToD2DPoints(minutes) {
  if (minutes == null || !Number.isFinite(minutes)) return 0;
  if (minutes < 45) return 35;
  if (minutes < 90) return 25;
  if (minutes < 150) return 10;
  if (minutes < 240) return -5;
  if (minutes < 360) return -15;
  return -20;
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  geocodeAddress,
  getDriveRoute,
  getDriveFromTerraGenieHQ,
  driveTimeToD2DPoints,
  getOriginCoords,
  cleanAddressForGeocoding,
  // Exposed for testing / direct use
  ORIGIN_ADDRESS,
  HQ_COORDS_HARDCODED,
  isValidLonLat
};
