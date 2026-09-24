// Add USGS 3DEP elevation (feet) at every tee and green centre to a course.json.
// Public domain data, no key, no rate limit published — but be polite.
//   node add-elevation.js <key>
const fs = require('fs'), path = require('path');
const dir = __dirname, KEY = process.argv[2];
const file = path.join(dir, 'courses', KEY, 'course.json');
const course = JSON.parse(fs.readFileSync(file, 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const q = async p => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`https://epqs.nationalmap.gov/v1/json?x=${p.lon}&y=${p.lat}&units=Feet&wkid=4326&includeDate=false`,
        { headers: { 'User-Agent': 'golfbums-prototype/1.0 (seth@golfbums.co)' } });
      if (!r.ok) { await sleep(800); continue; }
      const j = await r.json();
      const v = Number(j.value);
      if (isFinite(v)) return Math.round(v * 10) / 10;
    } catch (_) { await sleep(800); }
  }
  return null;
};

(async () => {
  let ok = 0, miss = 0;
  for (const h of course.holes) {
    h.green.elev = await q(h.green.center);
    h.green.elev === null ? miss++ : ok++;
    for (const t of h.tees) { t.elev = await q(t.center); t.elev === null ? miss++ : ok++; }
    await sleep(120);
  }
  fs.writeFileSync(file, JSON.stringify(course));
  const rises = course.holes.filter(h => h.green.elev != null && h.tees[0] && h.tees[0].elev != null)
    .map(h => ({ hole: h.hole, rise: Math.round(h.green.elev - h.tees[0].elev) }));
  console.log(`  elevation: ${ok} points resolved, ${miss} missing`);
  console.log('tee→green rise (ft): ' + rises.map(r => `${r.hole}:${r.rise > 0 ? '+' : ''}${r.rise}`).join('  '));
})();
