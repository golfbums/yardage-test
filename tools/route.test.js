/**
 * Regression test for route.js against the three courses we have already mapped and
 * checked by hand: Prairie Pines (9), Pueblo Country Club (18) and Buffalo Dunes (18).
 * 45 holes of ground truth.
 *
 * Each course.js is the ANSWER, so the test strips it back to what OSM would hand us —
 * a shuffled bag of greens and tee polygons with no hole numbers on them — and asks the
 * router to put the numbers back. Anything short of 45/45 is a regression.
 *
 * Note what this does and does not cover. The mapped course.js files carry greens and
 * tees but no fairway rings, cart paths or golf=hole centrelines, so stages 2 (chain)
 * and 3 (anchor) are tested here and stage 1 (pairing) is not. Pairing needs a live
 * Overpass pull; see ROUTING.md.
 *
 *   node tools/route.test.js
 */
'use strict';

const path = require('path');
const R = require('./route');
const G = require('./geo');

const COURSES = ['prairie-pines', 'pcc', 'buffalo-dunes'];

function load(key) {
  global.window = {};
  delete require.cache[require.resolve(path.join('..', key, 'course.js'))];
  require(path.join('..', key, 'course.js'));
  return global.window.COURSE;
}

/** Deterministic shuffle, so a failure is reproducible. */
function shuffle(a, seed) {
  const out = a.slice();
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

let failures = 0;

for (const key of COURSES) {
  const C = load(key);
  const truth = C.holes.map(h => h.hole);
  const n = C.holes.length;

  // The card: par always, yardage only where the club publishes it.
  const card = {
    name: C.name,
    holes: C.holes.map(h => ({ hole: h.hole, par: h.par, yds: h.cardYds ?? undefined,
      handicap: h.handicap ?? null })),
  };

  // --- what OSM would give us, with every hole number thrown away
  const greens = C.holes.map(h => ({ id: 'g' + h.hole, center: h.green.center, ring: h.green.ring }));
  const tees = [];
  C.holes.forEach(h => h.tees.forEach((t, i) =>
    tees.push({ id: 't' + h.hole + '-' + i, center: t.center, ring: t.ring })));

  // ---- Test A: chain + anchor, with pairing supplied (what OSM geometry pins down)
  const units = shuffle(C.holes.map(h => ({
    green: { id: 'g' + h.hole, center: h.green.center },
    tees: h.tees.map((t, i) => ({ id: 't' + h.hole + '-' + i, center: t.center })),
    teeCenter: G.centroid(h.tees.map(t => t.center)),
    play: G.dist(h.tees[0].center, h.green.center),
    evidence: ['fixture'], score: 100, _truth: h.hole,
  })), 7);

  const clubhouse = C.clubhouse || R.inferClubhouse(units);
  const cands = R.chainHoles(units, clubhouse, R.cartGraph([]));
  // same arbitration route() uses: the chain the scorecard likes best wins
  let pick = null;
  for (const c of cands) {
    const a = R.anchorChain(c.cycle, units, card);
    if (!pick || a.parMiss < pick.a.parMiss ||
        (a.parMiss === pick.a.parMiss && a.parGap > pick.a.parGap)) pick = { c, a };
  }
  const { a: anchor } = pick;
  const got = anchor.order.map(i => units[i]._truth);
  const okA = got.join(',') === truth.join(',');
  if (!okA) failures++;

  console.log(`\n=== ${C.name} (${n} holes) ===`);
  console.log(`  chain+anchor : ${okA ? 'PASS' : 'FAIL'}  ${got.join(' ')}`);
  console.log(`  anchor       : ${anchor.reason}`);
  console.log(`  decided      : ${anchor.decided}` +
    (anchor.ydErr === null ? '' : `, mean yardage error ${Math.round(anchor.ydErr)} yds`));

  // ---- Test B: the whole router, from the bare bag of polygons
  const out = R.route({ greens: shuffle(greens, 11), tees: shuffle(tees, 13),
    clubhouse: C.clubhouse || null, fairways: [], cartpaths: [], holeWays: [] }, card);
  const pairedRight = out.holes.filter(h => {
    const g = h.green.id, t = h.tees[0] && h.tees[0].id;
    return g === 'g' + h.hole && t && t.startsWith('t' + h.hole + '-');
  }).length;
  console.log(`  bare router  : ${pairedRight}/${n} correct` +
    `  [method=${out.method}, confidence=${out.confidence}]` +
    `  — expected to refuse: no fairways or cart paths to pair on`);

  // ---- Test C: the whole router, end to end, with hole centrelines present.
  //
  // Each mapped hole already stores its true `line` — tee, any dogleg bends, green —
  // which is precisely what OSM carries as a `golf=hole` way. So this is real geometry
  // from a real course, shuffled and stripped of hole numbers, not a shape invented to
  // suit the test. It exercises the whole pipeline: pairing, chaining, anchoring.
  //
  // Not covered even so: fairway polygons and cart paths, which no mapped course.js
  // carries. Those need a live Overpass pull — see ROUTING.md.
  const holeWays = C.holes.map(h => ({
    id: 'w' + h.hole, center: G.centroid(h.line), line: h.line,
  }));

  const full = R.route({ greens: shuffle(greens, 11), tees: shuffle(tees, 13),
    clubhouse: C.clubhouse || null, fairways: [], cartpaths: [],
    holeWays: shuffle(holeWays, 17) }, card);
  // Two different things, worth scoring apart. Getting the NUMBER on a green right is
  // the whole job — that is the bug this router exists to prevent. Which tee boxes hang
  // off that hole is a lesser matter: a stray forward tee shifts one yardage, a wrong
  // number moves every yardage on the course onto the wrong hole.
  const greensRight = full.holes.filter(h => h.green.id === 'g' + h.hole).length;
  const teesRight = full.holes.filter(h =>
    h.green.id === 'g' + h.hole &&
    h.tees.every(t => t.id.startsWith('t' + h.hole + '-'))).length;
  const okC = greensRight === n;
  if (!okC) failures++;
  console.log(`  +centrelines : ${okC ? 'PASS' : 'FAIL'}  numbering ${greensRight}/${n}` +
    `, tees clean ${teesRight}/${n}` +
    `  [confidence=${full.confidence}, verified=${full.diagnostics.verified}]`);
  if (!okC) console.log('    review:', full.review.slice(0, 3).join(' | '));
}

console.log(`\n${failures === 0 ? 'ALL CHAIN+ANCHOR TESTS PASS' : failures + ' COURSE(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
