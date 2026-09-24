// Pull one course's geometry from OpenStreetMap. Free, ODbL, no key.
//
//   node fetch.js <key> "<Course Name, Town, State>"
//   node fetch.js prairie-pines "Prairie Pines Golf Course, Johnson City, Kansas"
//
// Writes courses/<key>/geom.json and courses/<key>/meta.json.
// Geocoding by name often fails for small municipal courses, so it falls back to
// searching Overpass by name inside a box around the town.

const fs = require('fs'), path = require('path');
const UA = 'golfbums-course-mapper/1.0 (seth@golfbums.co)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const [key, query] = process.argv.slice(2);
if (!key || !query) { console.error('usage: node fetch.js <key> "<Course Name, Town, State>"'); process.exit(1); }
const out = path.join(__dirname, 'courses', key);

const MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
async function overpass(q) {
  for (const host of MIRRORS) {
    try {
      const r = await fetch(host, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (r.ok) return r.json();
      console.log(`  ${host} -> HTTP ${r.status}`);
    } catch (e) { console.log(`  ${host} -> ${e.message}`); }
    await sleep(2000);
  }
  return null;
}
async function geocode(q) {
  const r = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5`, { headers: { 'User-Agent': UA } });
  await sleep(1200);                      // Nominatim asks for max 1 req/sec
  return r.ok ? r.json() : [];
}

(async () => {
  console.log(`${key}: locating "${query}"`);
  let lat = null, lon = null, matched = null;

  const hits = await geocode(query);
  const best = hits.find(h => h.class === 'leisure' || /golf/i.test(h.display_name)) || hits[0];
  if (best) { lat = Number(best.lat); lon = Number(best.lon); matched = best.display_name; }

  // A town-centre hit is not the course. Confirm there is actually a golf course here.
  let confirmed = false;
  if (lat != null) {
    const near = await overpass(`[out:json][timeout:60];(way["leisure"="golf_course"](around:2500,${lat},${lon});relation["leisure"="golf_course"](around:2500,${lat},${lon}););out center tags;`);
    const cands = (near && near.elements) || [];
    if (cands.length) {
      // prefer a name match when the geocoder landed on a town
      const words = query.toLowerCase().split(/[,\s]+/).filter(w => w.length > 3);
      const scored = cands.map(c => ({ c, hits: words.filter(w => (c.tags.name || '').toLowerCase().includes(w)).length }))
        .sort((a, b) => b.hits - a.hits);
      const pick = scored[0].c;
      if (pick.center) { lat = pick.center.lat; lon = pick.center.lon; }
      matched = pick.tags.name || matched;
      confirmed = true;
      if (cands.length > 1) console.log(`  note: ${cands.length} courses within 2.5 km — picked "${matched}"`);
    }
  }
  if (!confirmed) { console.error(`  FAILED to locate a golf course for "${query}"`); process.exit(2); }
  console.log(`  found "${matched}" at ${lat},${lon}`);

  const d = await overpass(`[out:json][timeout:120];
(
  way["golf"](around:2000,${lat},${lon});
  relation["golf"](around:2000,${lat},${lon});
  way["natural"="water"](around:2000,${lat},${lon});
  way["leisure"="golf_course"](around:2000,${lat},${lon});
);
out geom;`);
  if (!d) { console.error('  Overpass failed on every mirror'); process.exit(3); }

  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'geom.json'), JSON.stringify(d));

  const els = (d.elements || []).filter(e => e.geometry && e.tags);
  const isPractice = t => /practice|putting|chipping|range|driving/i.test(t.name || '');
  const count = f => els.filter(f).length;
  const greens = count(e => e.tags.golf === 'green' && !isPractice(e.tags));
  const tees = count(e => e.tags.golf === 'tee');
  const fairways = els.filter(e => e.tags.golf === 'fairway' && !isPractice(e.tags));
  const holeWays = els.filter(e => e.tags.golf === 'hole');
  const carts = count(e => /cartpath|path/.test(e.tags.golf || '') || e.tags.highway === 'path');

  const meta = {
    key, query, matchedName: matched, lat, lon, fetched: 'see git history',
    counts: { greens, tees, fairways: fairways.length, holeWays: holeWays.length, cartPaths: carts,
      bunkers: count(e => e.tags.golf === 'bunker'), water: count(e => e.tags.natural === 'water' || /water_hazard/.test(e.tags.golf || '')) },
    holeNumbersOn: {
      holeWay: holeWays.filter(h => h.tags.ref).length,
      fairway: fairways.filter(f => f.tags.ref).length,
      tee: count(e => e.tags.golf === 'tee' && e.tags.ref),
      green: count(e => e.tags.golf === 'green' && e.tags.ref),
    },
  };
  fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta, null, 2));

  const hn = meta.holeNumbersOn;
  const numbered = Math.max(hn.holeWay, hn.fairway, Math.min(hn.tee, hn.green));
  console.log(`  ${greens} greens, ${tees} tees, ${fairways.length} fairways, ${holeWays.length} hole ways, ${carts} cart paths`);
  console.log(`  hole numbers present on ${numbered} features  (${numbered >= 9 ? 'TIER 1 — read them' : 'must be inferred'})`);
  console.log(`  wrote courses/${key}/`);
})();
