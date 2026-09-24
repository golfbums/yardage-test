// Resolve a course's routing from open data, with no human input.
//
// WHAT THE DATA ACTUALLY LOOKS LIKE (measured, not assumed):
//   · The hole number is often already in OSM — on golf=hole, or on the FAIRWAY as `ref`,
//     or on the tee/green. Read it before inferring anything.
//   · A green sits 19-31 m from one end of its fairway. That binding is TIGHT, so the
//     green is what orients a fairway, not the tee.
//   · A tee sits 45-118 m from the other end. Looser, because tee boxes sit back from
//     where the mown fairway starts.
//   · On a par 3 the "fairway" is a stub (29-70 yds here) and its axis means nothing —
//     the nearest tee to a stub is usually the NEXT hole's. Par 3s need the scorecard.
//
// So: geometry decides the green, the scorecard decides the tee where geometry can't, and
// the whole assignment is solved globally so no tee is used twice. Then it verifies, and
// anything that fails goes to a golfer rather than getting published.
//
//   node route.js <key> <cardKey>

const fs = require('fs'), path = require('path');
const dir = __dirname;
const key = process.argv[2];
if (!key) { console.error('usage: node route.js <key>'); process.exit(1); }
const CD = path.join(dir, 'courses', key);

const R = 6378137, toR = x => x * Math.PI / 180;
const m = (a, b) => { const dLat = toR(b.lat - a.lat), dLon = toR(b.lon - a.lon); const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };
const yd = d => Math.round(d / 0.9144);
const cen = r => ({ lat: r.reduce((s, p) => s + p.lat, 0) / r.length, lon: r.reduce((s, p) => s + p.lon, 0) / r.length });

const geom = JSON.parse(fs.readFileSync(path.join(CD, 'geom.json'), 'utf8'));
const els = geom.elements.filter(e => e.geometry && e.tags);
const isPractice = t => /practice|putting|chipping|range|driving/i.test((t.name || '') + ' ' + (t.description || ''));
const num = v => (v == null || v === '' ? null : Number(String(v).match(/\d+/) || NaN));

const greens = els.filter(e => e.tags.golf === 'green' && !isPractice(e.tags)).map(e => ({ id: e.id, ring: e.geometry, c: cen(e.geometry), ref: num(e.tags.ref) }));
const tees = els.filter(e => e.tags.golf === 'tee').map(e => ({ id: e.id, ring: e.geometry, c: cen(e.geometry), ref: num(e.tags.ref) }));
const fairways = els.filter(e => e.tags.golf === 'fairway' && !isPractice(e.tags)).map(e => ({ id: e.id, ring: e.geometry, ref: num(e.tags.ref) }));
const cartWays = els.filter(e => /cartpath|path/.test(e.tags.golf || '') || e.tags.highway === 'path').map(e => e.geometry);
const holeWays = els.filter(e => e.tags.golf === 'hole').map(e => ({ id: e.id, line: e.geometry, ref: num(e.tags.ref), par: num(e.tags.par) }));

const card = JSON.parse(fs.readFileSync(path.join(CD, 'card.json'), 'utf8'));
if (!card || !card.holes || !card.holes.length) { console.error('  courses/' + key + '/card.json has no per-hole data — the agent must fill it first'); process.exit(1); }
const N = card.holes.length;
const teeName = Object.keys(card.holes[0].yardsByTee || {})[0];
const cardYds = card.holes.map(h => h.yardsByTee[teeName]);
const cardPar = card.holes.map(h => h.par);

const { walkTable } = require('./paths.js');
// The cart paths are the course's own answer to "where do you go next". Where the network
// reaches, a path distance beats a straight line — it can't cut across a pond or another
// hole. OSM path coverage is patchy, so treat unreachable as weak evidence, not proof.
const WALK = walkTable(cartWays, greens.map(g => g.c), tees.map(t => t.c));
if (WALK.ok) console.log(`  cart paths: ${cartWays.length} ways, ${WALK.stats.reachablePairs}/${WALK.stats.totalPairs} green-to-tee pairs reachable`);
else console.log('  cart paths: none mapped — falling back to straight-line walks');
const gIdx = new Map(greens.map((g, i) => [g.id, i]));
const tIdx = new Map(tees.map((t, i) => [t.id, i]));
const pathWalk = (green, tee) => {
  if (!WALK.ok) return null;
  const d = WALK.dist(gIdx.get(green.id), tIdx.get(tee.id));
  return d == null ? null : yd(d);
};

const ref0 = greens[0].c;
const XY = p => ({ x: (p.lon - ref0.lon) * Math.cos(toR(ref0.lat)) * 111320, y: (p.lat - ref0.lat) * 110540 });
const LL = q => ({ lat: ref0.lat + q.y / 110540, lon: ref0.lon + q.x / (Math.cos(toR(ref0.lat)) * 111320) });
function axis(ring) {
  const pts = ring.map(XY);
  const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length, my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) { const dx = p.x - mx, dy = p.y - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), ux = Math.cos(th), uy = Math.sin(th);
  let lo = Infinity, hi = -Infinity, pl, ph;
  for (const p of pts) { const t = (p.x - mx) * ux + (p.y - my) * uy; if (t < lo) { lo = t; pl = p; } if (t > hi) { hi = t; ph = p; } }
  return { a: LL(pl), b: LL(ph), len: hi - lo };
}

console.log(`${key}: ${greens.length} greens, ${tees.length} tees, ${fairways.length} fairways, ${holeWays.length} hole ways`);
console.log(`  hole numbers on — hole:${holeWays.filter(h => h.ref).length} fairway:${fairways.filter(f => f.ref).length} tee:${tees.filter(t => t.ref).length} green:${greens.filter(g => g.ref).length}`);

// ── Step 1: get a per-hole anchor, ideally straight from a ref ──────────────
// anchor = { hole, green, teeEnd (a point), fwLen }
let anchors = null, source = null;
const numberedFw = fairways.filter(f => f.ref);
const numberedHole = holeWays.filter(h => h.ref);

if (numberedHole.length >= N) {
  const byRef = new Map(numberedHole.map(h => [h.ref, h]));
  anchors = [];
  for (let n = 1; n <= N; n++) {
    const hw = byRef.get(n); if (!hw) { anchors = null; break; }
    const end = hw.line[hw.line.length - 1], start = hw.line[0];
    const g = greens.slice().sort((a, b) => m(a.c, end) - m(b.c, end))[0];
    anchors.push({ hole: n, green: g, teeEnd: start, fwLen: yd(m(start, end)) });
  }
  if (anchors) source = 'golf=hole ref';
}
if (!anchors && numberedFw.length >= N) {
  const byRef = new Map(numberedFw.map(f => [f.ref, f]));
  anchors = [];
  for (let n = 1; n <= N; n++) {
    const fw = byRef.get(n); if (!fw) { anchors = null; break; }
    const ax = axis(fw.ring);
    // THE GREEN ORIENTS THE FAIRWAY — it is bound within ~30 m, the tee is not
    const gA = greens.map(g => ({ g, d: m(ax.a, g.c) })).sort((x, y) => x.d - y.d)[0];
    const gB = greens.map(g => ({ g, d: m(ax.b, g.c) })).sort((x, y) => x.d - y.d)[0];
    const useA = gA.d <= gB.d;
    anchors.push({ hole: n, green: (useA ? gA : gB).g, greenOff: Math.round((useA ? gA : gB).d), teeEnd: useA ? ax.b : ax.a, fwLen: yd(ax.len) });
  }
  if (anchors) source = 'fairway ref';
}
if (!anchors) { console.error('  no hole numbering found — falling back needs tier 2/3'); process.exit(1); }
console.log(`  anchored by ${source}; green offsets ${anchors.map(a => a.greenOff ?? '-').join(',')} m`);

// ── Step 2: choose a tee per hole, globally ────────────────────────────────
// A long fairway gives a trustworthy tee end; a stub (par 3) does not, so there the card
// picks. Scale the card to whichever tee set OSM mapped, iterating since that depends on
// the choice.
const STUB = 110;                                   // yards of fairway below which the axis is noise
let chosen = anchors.map(a => tees.map(t => ({ t, d: m(a.teeEnd, t.c) })).sort((x, y) => x.d - y.d)[0].t);

for (let iter = 0; iter < 6; iter++) {
  const tot = chosen.reduce((s, t, i) => s + yd(m(t.c, anchors[i].green.c)), 0);
  const set = (card.teeSets || []).map(t => ({ n: t.name, total: t.totalYards, d: Math.abs(t.totalYards - tot) })).sort((x, y) => x.d - y.d)[0];
  const sc = set ? set.total / cardYds.reduce((x, y) => x + y, 0) : 1;
  const want = cardYds.map(v => v * sc);

  const cands = anchors.map((a, i) => {
    const trust = a.fwLen >= STUB;                  // is the tee end meaningful?
    return tees.map(t => {
      const off = m(a.teeEnd, t.c);
      const err = Math.abs(yd(m(t.c, a.green.c)) - want[i]);
      // Trust geometry where the fairway is long; trust the card on stubs.
      const base = trust ? off * 1.0 + err * 0.35 : err * 1.0 + off * 0.12;
      return { t, cost: base, base, off, err, trust };
    }).filter(c => c.off < 320).sort((x, y) => x.cost - y.cost).slice(0, 6);
  });

  let best = null; const used = new Set(), pick = [];
  (function rec(i, cost) {
    if (best && cost >= best.cost) return;
    if (i === N) { best = { cost, pick: pick.slice() }; return; }
    for (const c of cands[i]) {
      const reused = used.has(c.t.id);
      // You walk off a green onto the next tee. Anything past ~160 yds is not a golf
      // course, and it is the strongest single tell that a tee is on the wrong hole.
      // Where the fairway is a stub (par 3) its axis says nothing, so the walk off the
      // previous green is the only geometry left — weight it hard there, softly elsewhere.
      let wpen = 0;
      if (i > 0) {
        const prevGreen = anchors[i - 1].green;
        const byPath = pathWalk(prevGreen, c.t);
        const straight = yd(m(prevGreen.c, c.t.c));
        if (byPath != null) {
          // Real walking distance: trust it. A short ride means the next hole.
          if (byPath > 500) continue;
          wpen = byPath > 180 ? (byPath - 180) * 1.1 : 0;
        } else {
          // Not on the path network, or the network is broken here. Mild penalty only —
          // OSM path coverage is incomplete and absence is not evidence of absence.
          if (straight > 420) continue;
          wpen = (straight > 260 ? (straight - 260) * 0.8 : 0) + 40;
        }
      }
      const had = used.has(c.t.id);
      used.add(c.t.id); pick.push(c.t);
      rec(i + 1, cost + c.base + wpen + (reused ? 55 : 0));
      pick.pop(); if (!had) used.delete(c.t.id);
    }
  })(0, 0);
  if (!best) break;
  const changed = best.pick.some((t, i) => t.id !== chosen[i].id);
  chosen = best.pick;
  if (!changed) break;
}

// ── Step 3: verify against the card ────────────────────────────────────────
const measured = chosen.map((t, i) => yd(m(t.c, anchors[i].green.c)));
const total = measured.reduce((a, b) => a + b, 0);
const set = (card.teeSets || []).map(t => ({ n: t.name, total: t.totalYards, d: Math.abs(t.totalYards - total) })).sort((x, y) => x.d - y.d)[0];
const sc = set ? set.total / cardYds.reduce((a, b) => a + b, 0) : 1;
const expect = cardYds.map(v => Math.round(v * sc));
const errs = measured.map((v, i) => Math.abs(v - expect[i]));
const med = errs.slice().sort((a, b) => a - b)[Math.floor(N / 2)];
const walks = chosen.slice(1).map((t, i) => yd(m(anchors[i].green.c, t.c)));

console.log('  hole : ' + anchors.map(a => String(a.hole).padStart(4)).join(''));
console.log('  par  : ' + cardPar.map(v => String(v).padStart(4)).join(''));
console.log('  map  : ' + measured.map(v => String(v).padStart(4)).join(''));
console.log('  card : ' + expect.map(v => String(v).padStart(4)).join('') + `   (${teeName} → ${set ? set.n : '?'})`);
console.log('  err  : ' + errs.map(v => String(v).padStart(4)).join(''));
console.log(`  total ${total} vs ${set ? set.n + ' ' + set.total : '?'} | median ${med} yds, worst ${Math.max(...errs)} | walks ${walks.join(',')}`);
const pass = med <= 30 && Math.max(...errs) <= 90 && Math.max(...walks) <= 260;
console.log(`  VERDICT: ${pass ? 'PASS' : 'FAIL — needs a golfer'}`);

fs.writeFileSync(path.join(CD, 'routing.json'), JSON.stringify({
  course: key, source, pass, medianErr: med, teeSet: set ? set.n : null,
  holes: anchors.map((a, i) => ({ hole: a.hole, tee: chosen[i].id, green: a.green.id, yds: measured[i] })),
}));
console.log(`  wrote courses/${key}/routing.json`);
