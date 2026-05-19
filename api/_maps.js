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

// Single-shot geocode attempt against Nominatim. Internal helper used by
// geocodeAddress (cascade). Returns [lon, lat] or null.
async function geocodeAddressOnce(query) {
  if (!query || typeof query !== 'string' || query.trim().length === 0) return null;
  const url = `${NOMINATIM_SEARCH_URL}?q=${encodeURIComponent(query)}&format=json&limit=1&countrycodes=us`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': NOMINATIM_USER_AGENT,
        'Accept': 'application/json'
      }
    });
    if (!res.ok) {
      console.warn(`[maps] nominatim status=${res.status} for "${query.substring(0, 80)}"`);
      return null;
    }
    const arr = await res.json();
    if (!Array.isArray(arr) || arr.length === 0) {
      return null; // no match (not a hard failure)
    }
    const lat = parseFloat(arr[0].lat);
    const lon = parseFloat(arr[0].lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return null;
    }
    return [lon, lat];
  } catch (err) {
    console.warn(`[maps] nominatim threw on "${query.substring(0, 80)}": ${err.message}`);
    return null;
  }
}

// Best-effort extraction of address parts from a free-form US address string.
// Recognized shapes:
//   "1234 Main St, Oviedo, FL 32765"  → street + city + state + zip
//   "Oviedo, FL 32765"                → city + state + zip
//   "Oviedo, FL"                       → city + state
//   "FL"                                → state
// Best-effort extraction. Handles 2-letter state abbreviations AND full
// state names ("Florida" → "FL"). US states only.
const US_STATE_NAME_TO_ABBR = {
  alabama:'AL', alaska:'AK', arizona:'AZ', arkansas:'AR', california:'CA',
  colorado:'CO', connecticut:'CT', delaware:'DE', florida:'FL', georgia:'GA',
  hawaii:'HI', idaho:'ID', illinois:'IL', indiana:'IN', iowa:'IA', kansas:'KS',
  kentucky:'KY', louisiana:'LA', maine:'ME', maryland:'MD', massachusetts:'MA',
  michigan:'MI', minnesota:'MN', mississippi:'MS', missouri:'MO', montana:'MT',
  nebraska:'NE', nevada:'NV', 'new hampshire':'NH', 'new jersey':'NJ',
  'new mexico':'NM', 'new york':'NY', 'north carolina':'NC',
  'north dakota':'ND', ohio:'OH', oklahoma:'OK', oregon:'OR',
  pennsylvania:'PA', 'rhode island':'RI', 'south carolina':'SC',
  'south dakota':'SD', tennessee:'TN', texas:'TX', utah:'UT', vermont:'VT',
  virginia:'VA', washington:'WA', 'west virginia':'WV', wisconsin:'WI',
  wyoming:'WY', 'district of columbia':'DC', dc:'DC'
};
function normalizeStateToken(token) {
  if (!token) return null;
  const t = token.trim().toLowerCase();
  if (/^[a-z]{2}$/i.test(t)) return t.toUpperCase();
  return US_STATE_NAME_TO_ABBR[t] || null;
}

function extractAddressParts(addr) {
  if (!addr || typeof addr !== 'string') return {};
  const parts = { street: null, city: null, state: null, zip: null };
  const cleaned = addr.trim().replace(/\bUSA\b/i, '').replace(/,\s*$/, '').trim();

  // Zip (5 digits, optional 5-4)
  const zipMatch = cleaned.match(/\b(\d{5}(?:-\d{4})?)\b/);
  if (zipMatch) parts.zip = zipMatch[1];

  // State: prefer 2-letter abbreviation at end. If absent, try full state name.
  let stateMatch = cleaned.match(/,?\s*([A-Z]{2})\b(?:\s+\d{5}(?:-\d{4})?)?\s*$/);
  if (stateMatch) {
    parts.state = stateMatch[1].toUpperCase();
  } else {
    // Try full state name, possibly followed by zip: "Oviedo, Florida" or "Bradenton, Florida 34209"
    for (const [name, abbr] of Object.entries(US_STATE_NAME_TO_ABBR)) {
      const re = new RegExp(`,?\\s*${name.replace(/ /g, '\\s+')}\\b(?:\\s+\\d{5}(?:-\\d{4})?)?\\s*$`, 'i');
      if (re.test(cleaned)) {
        parts.state = abbr;
        break;
      }
    }
  }

  // City: token between last two commas before state, e.g. "Street, City, ST..."
  // Or first token if no street: "City, ST..."
  const segments = cleaned.split(',').map(s => s.trim()).filter(Boolean);
  if (segments.length >= 2 && parts.state) {
    // Find segment whose token (after stripping zip) equals state abbr OR full name
    let stateIdx = -1;
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i].replace(/\s+\d{5}(?:-\d{4})?\s*$/, '').trim();
      if (normalizeStateToken(seg) === parts.state) { stateIdx = i; break; }
    }
    if (stateIdx >= 1) {
      parts.city = segments[stateIdx - 1];
    }
    if (stateIdx >= 2) {
      parts.street = segments.slice(0, stateIdx - 1).join(', ');
    }
  }

  return parts;
}

// Build the geocoding cascade for a single input address. Each entry is
// tried in order until one returns coords. Confidence reflects how much
// precision was preserved.
//
// Cascade levels (most → least specific):
//   0 = original full address              (confidence: high)
//   1 = suite-stripped full address        (confidence: high)
//   2 = street + city + state (no zip)     (confidence: high)
//   3 = city + state + zip                 (confidence: medium)
//   4 = city + state                       (confidence: medium)
//   5 = zip only                           (confidence: low)
//   6 = state only                         (confidence: very_low — center of state)
function buildGeocodeCascade(addressString) {
  const attempts = [];
  const seen = new Set();
  const add = (query, level, confidence) => {
    if (!query) return;
    const q = query.trim();
    if (!q || seen.has(q.toLowerCase())) return;
    seen.add(q.toLowerCase());
    attempts.push({ query: q, level, confidence });
  };

  const original = (addressString || '').trim();
  const cleaned = cleanAddressForGeocoding(original);
  const parts = extractAddressParts(original);

  // Level 0: original
  add(original, 0, 'high');
  // Level 1: suite-stripped
  if (cleaned && cleaned !== original) add(cleaned, 1, 'high');
  // Level 2: street + city + state (no zip)
  if (parts.street && parts.city && parts.state) {
    add(`${parts.street}, ${parts.city}, ${parts.state}`, 2, 'high');
  }
  // Level 3: city + state + zip
  if (parts.city && parts.state && parts.zip) {
    add(`${parts.city}, ${parts.state} ${parts.zip}`, 3, 'medium');
  }
  // Level 4: city + state
  if (parts.city && parts.state) {
    add(`${parts.city}, ${parts.state}`, 4, 'medium');
  }
  // Level 5: zip only (gives a centroid)
  if (parts.zip) {
    add(parts.zip, 5, 'low');
  }
  // Level 6: state only (very rough centroid)
  if (parts.state) {
    add(parts.state, 6, 'very_low');
  }
  return attempts;
}

// Geocode a free-form address string with a cascading fallback.
// Returns [lon, lat] or null. (For confidence / used_query / level metadata,
// see geocodeAddressWithMeta below.)
async function geocodeAddress(addressString) {
  const result = await geocodeAddressWithMeta(addressString);
  return result ? result.coords : null;
}

// Geocode with full metadata. Use this when you care which cascade level
// produced the match (e.g. to flag low-precision drive estimates).
// Returns { coords, used_query, level, confidence } or null.
async function geocodeAddressWithMeta(addressString) {
  if (!addressString || typeof addressString !== 'string' || addressString.trim().length === 0) {
    return null;
  }
  const attempts = buildGeocodeCascade(addressString);
  const tried = [];
  for (const attempt of attempts) {
    tried.push(`[${attempt.level}] "${attempt.query.substring(0, 60)}"`);
    const coords = await geocodeAddressOnce(attempt.query);
    if (coords) {
      if (attempt.level > 0) {
        console.log(`[maps] geocoded via cascade level ${attempt.level} (confidence=${attempt.confidence}): "${(addressString || '').substring(0, 60)}" -> "${attempt.query.substring(0, 60)}"`);
      }
      return {
        coords,
        used_query: attempt.query,
        level: attempt.level,
        confidence: attempt.confidence
      };
    }
    // Be polite to Nominatim between attempts (free tier policy)
    if (attempts.length > 1) await new Promise(r => setTimeout(r, 250));
  }
  console.warn(`[maps] geocode cascade exhausted for "${(addressString || '').substring(0, 60)}". Tried: ${tried.join(', ')}`);
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
  geocodeAddressWithMeta,
  getDriveRoute,
  getDriveFromTerraGenieHQ,
  driveTimeToD2DPoints,
  getOriginCoords,
  cleanAddressForGeocoding,
  extractAddressParts,
  buildGeocodeCascade,
  // Exposed for testing / direct use
  ORIGIN_ADDRESS,
  HQ_COORDS_HARDCODED,
  isValidLonLat
};
