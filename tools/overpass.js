/**
 * overpass.js — pull one golf course out of OpenStreetMap and normalise it into the
 * shape route.js expects.
 *
 *   node tools/overpass.js "Prairie Pines" 37.5790 -101.7395 > /tmp/pp-osm.json
 *   node tools/overpass.js --area 3600123456 > /tmp/x-osm.json
 *
 * Pull EVERYTHING listed below, not just tees and greens. Cart paths and fairways are
 * what let the router pair a tee with its green at all; without them it refuses (which
 * is the correct behaviour, but it means no course gets mapped). See ROUTING.md.
 */
'use strict';

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

/** Everything on a golf course that tells us something about routing. */
const query = (lat, lon, radius = 1500) => `[out:json][timeout:120];
(
  way(around:${radius},${lat},${lon})["golf"];
  relation(around:${radius},${lat},${lon})["golf"];
  way(around:${radius},${lat},${lon})["leisure"="golf_course"];
  relation(around:${radius},${lat},${lon})["leisure"="golf_course"];
  node(around:${radius},${lat},${lon})["golf"];
  // cart paths are often plain highways inside the course rather than golf=cartpath
  way(around:${radius},${lat},${lon})["highway"]["golf_cart"];
  way(around:${radius},${lat},${lon})["highway"="service"]["service"="driveway"];
  way(around:${radius},${lat},${lon})["highway"~"^(path|footway|track)$"];
  // the clubhouse anchors both nines
  way(around:${radius},${lat},${lon})["building"="clubhouse"];
  way(around:${radius},${lat},${lon})["amenity"="clubhouse"];
  node(around:${radius},${lat},${lon})["amenity"="clubhouse"];
);
out body geom;`;

async function fetchOsm(lat, lon, radius) {
  const body = new URLSearchParams({ data: query(lat, lon, radius) }).toString();
  let lastErr;
  for (const url of MIRRORS) {
    try {
      const r = await fetch(url, {
        method: 'POST', body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded',
                   'User-Agent': 'golfbums-yardage/1.0 (course mapping)' },
      });
      if (!r.ok) { lastErr = new Error(`${url} → HTTP ${r.status}`); continue; }
      return await r.json();
    } catch (e) { lastErr = e; }
  }
  throw new Error(`every Overpass mirror failed. Last: ${lastErr && lastErr.message}\n` +
    `If this is a Claude Code cloud session, the environment's network policy is probably ` +
    `blocking overpass-api.de — add it to the allowed domains, or run this from the desktop.`);
}

const centroid = pts => ({
  lat: pts.reduce((a, p) => a + p.lat, 0) / pts.length,
  lon: pts.reduce((a, p) => a + p.lon, 0) / pts.length,
});

/** Overpass JSON → {tees,greens,fairways,holeWays,cartpaths,clubhouse,bunkers,water}. */
function normalise(osm) {
  const out = { tees: [], greens: [], fairways: [], holeWays: [], cartpaths: [],
                bunkers: [], water: [], clubhouse: null };
  for (const el of osm.elements || []) {
    const t = el.tags || {};
    const geom = el.geometry ? el.geometry.map(p => ({ lat: p.lat, lon: p.lon })) : null;
    const pt = el.type === 'node' ? { lat: el.lat, lon: el.lon } : (geom && centroid(geom));
    if (!pt) continue;
    const base = { id: el.id, center: pt, ref: t.ref ?? null, tags: t };

    switch (t.golf) {
      case 'tee':          out.tees.push({ ...base, ring: geom }); break;
      case 'green':        out.greens.push({ ...base, ring: geom }); break;
      case 'fairway':      out.fairways.push({ ...base, ring: geom }); break;
      case 'hole':         out.holeWays.push({ ...base, line: geom,
                             par: t.par ? +t.par : null }); break;
      case 'cartpath':
      case 'path':         out.cartpaths.push({ ...base, line: geom }); break;
      case 'bunker':       out.bunkers.push({ ...base, ring: geom }); break;
      case 'water_hazard':
      case 'lateral_water_hazard': out.water.push({ ...base, ring: geom }); break;
      case 'clubhouse':    out.clubhouse = pt; break;
      default: break;
    }
    // paths inside the course that aren't tagged golf=* but walk like a cart path
    if (!t.golf && geom && geom.length > 1 &&
        (t.golf_cart || /^(path|footway|track)$/.test(t.highway || '') ||
         (t.highway === 'service' && t.service === 'driveway'))) {
      out.cartpaths.push({ ...base, line: geom });
    }
    if (!out.clubhouse && (t.building === 'clubhouse' || t.amenity === 'clubhouse')) {
      out.clubhouse = pt;
    }
  }
  return out;
}

async function main() {
  const a = process.argv.slice(2);
  if (a.length < 3) {
    console.error('usage: node tools/overpass.js "<name>" <lat> <lon> [radius_m]');
    process.exit(2);
  }
  const [name, lat, lon, radius] = [a[0], +a[1], +a[2], a[3] ? +a[3] : 1500];
  const raw = await fetchOsm(lat, lon, radius);
  const n = normalise(raw);
  n.name = name;
  const counts = Object.fromEntries(Object.entries(n)
    .filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length]));
  console.error(`${name}: ${JSON.stringify(counts)} clubhouse=${n.clubhouse ? 'yes' : 'NO'}`);
  if (!n.fairways.length && !n.cartpaths.length && !n.holeWays.length) {
    console.error('WARNING: no fairways, cart paths or hole centrelines — the router will ' +
      'refuse to pair tees with greens. Check the radius, or map those features first.');
  }
  process.stdout.write(JSON.stringify(n));
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });

module.exports = { query, fetchOsm, normalise };
