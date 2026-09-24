/**
 * route.js — work out which green belongs to which tee, and what number the hole is,
 * from OpenStreetMap geometry plus the club's published scorecard. No human in the loop.
 *
 * Why this exists: an earlier pass numbered Buffalo Dunes' holes nine off. It had the
 * right chain of holes and simply started counting in the wrong place, which no amount
 * of staring at the map catches. The routine below separates the three things that can
 * independently go wrong, and gates each one on evidence:
 *
 *   0. REF      — OSM already says which hole is which. Believe it, but check the card.
 *   1. PAIRING  — which tees play to which green. Proximity CANNOT do this: measured on
 *                 three mapped courses, a tee's own green ranks 2nd–15th nearest, because
 *                 your green is far away precisely by virtue of being the one you hit to.
 *                 Needs the hole centreline, the fairway's long axis, or a cart path.
 *   2. CHAIN    — the order you play them in. A course is NOT one cheap loop: 9→10 and
 *                 18→1 are long by design because both nines return to the clubhouse.
 *                 Model it as two paths hung off a clubhouse depot and solve exactly.
 *   3. ANCHOR   — where hole 1 sits in that chain. This is the one that bit us. The chain
 *                 is rotationally free, so score all 2N labellings against the scorecard's
 *                 par sequence and take the winner only if it beats the runner-up clearly.
 *
 * Every stage reports its own confidence, and the router refuses rather than guesses when
 * the evidence is thin — a flagged course costs a phone call, a silently rotated one costs
 * every yardage on it.
 */
'use strict';

const G = require('./geo');

// ---------------------------------------------------------------------------
// Tunables. These are golf facts, not magic numbers; each says why.
// ---------------------------------------------------------------------------
const K = {
  PLAY_MIN_YDS: 80,       // shorter than any real hole, from any tee
  PLAY_MAX_YDS: 700,      // longer than any real hole, from the tips
  WALK_TYPICAL_YDS: 120,  // green to the next tee; measured median across 3 courses: 51–74
  SNAP_YDS: 6,            // cart-path vertices this close are the same junction
  PATH_HOP_YDS: 45,       // how far you'll walk off the path to reach a tee or green
  AXIS_RATIO_MIN: 1.8,    // a fairway below this is too round to trust its long axis
  VERIFY_ABS_YDS: 25,     // per-hole tolerance against the card…
  VERIFY_PCT: 0.12,       // …or this fraction, whichever is larger
  ANCHOR_PAR_MARGIN: 2,   // winner must beat runner-up by this many par mismatches
  ANCHOR_YDS_MARGIN: 15,  // …or this many yards of mean error
};

const sum = a => a.reduce((x, y) => x + y, 0);
const median = a => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/** Par implied by raw length, when the card doesn't break par out per hole. */
const parFromYards = y => (y < 250 ? 3 : y > 460 ? 5 : 4);

// ===========================================================================
// Stage 1 — work out which tees play to which green
// ===========================================================================
/**
 * Score how much we believe "this tee plays to this green". Returns null if impossible.
 *
 * Note this scores ONE tee polygon, not a pre-clustered complex. Clustering tees by
 * proximity first is tempting and wrong: at Prairie Pines an 80-yard threshold merged
 * two different holes' tees into one complex, because a hole's back tee routinely sits
 * closer to the previous hole's tee than to its own forward tee. Assign each tee on its
 * own evidence, then group by the green it landed on.
 *
 * Evidence, strongest first:
 *   golf=hole centreline  — OSM literally drew the hole. One endpoint is the tee.
 *   fairway long axis     — a fairway is a thin blob pointing tee→green.
 *   cart path             — a path runs the length of the hole.
 *   plausible length      — weak alone, but it rules pairs out cheaply.
 */
/**
 * Does the run a→b actually go FROM this tee TO this green?
 *
 * "One end near the tee, the other near the green" is not enough, and this is the trap
 * that cost us a round: on a course where holes sit side by side, a NEIGHBOURING hole's
 * fairway routinely has one end near your tee and the other near your green, and scores
 * exactly as well as your own. Measured on Prairie Pines, the loose test gave four wrong
 * greens the same score as the right one.
 *
 * So demand three things a genuine hole satisfies and a neighbour's doesn't:
 *   heads and tails — it starts near the tee and finishes near the green;
 *   direction       — it points the way the hole plays, within `bearing` degrees;
 *   no detour       — tee→start→end→green is barely longer than tee→green itself.
 *
 * Returns a quality in (0,1], or 0 for "not this hole". The quality matters as much as
 * the veto: a plain yes/no leaves neighbouring holes tied on equal scores, and a tie is
 * decided by array order, which is to say by luck. Your own fairway fits your own hole
 * better than the next hole's does, and a graded score is what says so.
 */
function runsAlong(T, Gp, a, b, o) {
  const play = G.dist(T, Gp);
  const [near, far] = G.dist(T, a) <= G.dist(T, b) ? [a, b] : [b, a];
  const head = G.dist(T, near), tail = G.dist(far, Gp), span = G.dist(near, far);
  const headMax = Math.max(70, play * o.head), tailMax = Math.max(60, play * o.tail);
  if (head > headMax || tail > tailMax) return 0;
  if (span < play * o.cover) return 0;
  const turn = G.bearingDelta(G.bearing(T, Gp), G.bearing(near, far));
  if (turn > o.bearing) return 0;
  const detour = (head + span + tail) / Math.max(play, 1);
  if (detour > o.detour) return 0;
  const q = [
    1 - head / headMax,
    1 - tail / tailMax,
    1 - turn / o.bearing,
    1 - Math.max(0, detour - 1) / (o.detour - 1),
  ];
  return Math.max(0.05, q.reduce((a2, b2) => a2 + b2, 0) / q.length);
}

function pairScore(tee, green, ctx) {
  const T = tee.center, Gp = green.center;
  const play = G.dist(T, Gp);
  if (play < K.PLAY_MIN_YDS || play > K.PLAY_MAX_YDS) return null;

  let score = 0;
  const why = [];

  // -- golf=hole centreline: decisive when present
  let best = 0;
  for (const hw of ctx.holeWays) {
    const ends = [hw.line[0], hw.line[hw.line.length - 1]];
    best = Math.max(best, runsAlong(T, Gp, ends[0], ends[1],
      { head: 0.25, tail: 0.20, cover: 0.55, bearing: 35, detour: 1.30 }));
  }
  if (best > 0) { score += 100 * best; why.push('centreline'); }

  // -- fairway long axis running from this tee to this green
  best = 0;
  for (const fw of ctx.fairways) {
    if (fw.axis.ratio < K.AXIS_RATIO_MIN) continue;
    best = Math.max(best, runsAlong(T, Gp, fw.axis.a, fw.axis.b,
      { head: 0.35, tail: 0.30, cover: 0.40, bearing: 30, detour: 1.32 }));
  }
  if (best > 0) { score += 55 * best; why.push('fairway'); }

  // -- the tee→green line runs along a cart path for most of its length
  if (ctx.cartpaths.length) {
    const steps = 8;
    let on = 0;
    for (let i = 1; i < steps; i++) {
      const f = i / steps;
      const p = { lat: tee.center.lat + (green.center.lat - tee.center.lat) * f,
                  lon: tee.center.lon + (green.center.lon - tee.center.lon) * f };
      if (Math.min(...ctx.cartpaths.map(c => G.pointToLine(p, c.line))) < 55) on++;
    }
    if (on >= steps - 3) { score += 30; why.push('cartpath'); }
  }

  // -- does this length appear on the card at all?
  if (ctx.cardYards.length) {
    const near = Math.min(...ctx.cardYards.map(y => Math.abs(y - play)));
    if (near < 30) { score += 18; why.push('card-length'); }
    else if (near > 90) score -= 20;
  }

  // -- all else equal, prefer the nearer green
  score -= play / 200;
  return { score, play, why };
}

/** Hungarian algorithm (O(n³)) — the assignment maximising total score. Instant at n=40. */
function assign(scoreMatrix) {
  const n = scoreMatrix.length, m = scoreMatrix[0].length;
  const size = Math.max(n, m), INF = 1e12;
  // pad to square, and flip sign because the classic formulation minimises
  const c = Array.from({ length: size }, (_, i) => Array.from({ length: size }, (_, j) =>
    (i < n && j < m && scoreMatrix[i][j] !== null) ? -scoreMatrix[i][j] : INF));
  const u = new Float64Array(size + 1), v = new Float64Array(size + 1);
  const p = new Int32Array(size + 1), way = new Int32Array(size + 1);
  for (let i = 1; i <= size; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(size + 1).fill(Infinity);
    const used = new Uint8Array(size + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= size; j++) {
        if (used[j]) continue;
        const cur = c[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= size; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const greenOf = new Array(n).fill(-1);
  for (let j = 1; j <= size; j++) {
    const i = p[j] - 1, jj = j - 1;
    if (i >= 0 && i < n && jj < m && c[i][jj] < INF) greenOf[i] = jj;
  }
  return greenOf;
}

/**
 * When OSM carries a `golf=hole` centreline for every hole, don't treat it as one vote
 * among several — treat it as the skeleton. A centreline IS the hole: one end is the tee,
 * the other is the green. Matching centrelines to greens (globally, 1:1) and then hanging
 * tees off the far end is both simpler and far more accurate than scoring every
 * tee against every green and hoping the right pair wins.
 *
 * Returns null when there aren't enough centrelines to go round, so the caller falls
 * back to the general scoring path.
 */
function pairViaCentrelines(tees, greens, ctx) {
  const W = ctx.holeWays;
  if (W.length < greens.length) return null;

  // Which green does each centreline finish at? Decide globally: two adjacent holes can
  // each end near the other's green, and only a joint assignment gets both right.
  const M = W.map(w => greens.map(g => {
    const a = w.line[0], b = w.line[w.line.length - 1];
    const d = Math.min(G.dist(a, g.center), G.dist(b, g.center));
    return d > 70 ? null : 70 - d;
  }));
  const pick = assign(M);
  const lanes = [];
  pick.forEach((gi, wi) => {
    if (gi < 0) return;
    const w = W[wi], g = greens[gi];
    const a = w.line[0], b = w.line[w.line.length - 1];
    const teeEnd = G.dist(a, g.center) > G.dist(b, g.center) ? a : b;
    lanes.push({ green: g, gi, way: w, teeEnd });
  });
  if (lanes.length < greens.length) return null;

  // Every tee joins the hole whose centreline it sits ON, in that line's first stretch.
  //
  // Measuring to the tee END instead is the obvious thing and it is wrong twice over: a
  // hole's forward tees can be 130 yds down the line from its back tee (Buffalo Dunes'
  // 11th has six boxes over that spread), while on a tight course another hole's tee
  // sits well inside the same radius (Pueblo's 1st tee is a hundred yards from the 3rd's).
  // Distance to the line itself separates them: your forward tee is on your line, and
  // the neighbouring hole's tee is not.
  const owner = tees.map(t => {
    let best = -1, bd = Infinity;
    lanes.forEach((ln, li) => {
      const d = G.pointToLine(t.center, ln.way.line);
      if (d > 50) return;
      // tees live in the first stretch of a hole, never past about halfway
      const along = G.dist(t.center, ln.teeEnd);
      if (along > G.dist(ln.teeEnd, ln.green.center) * 0.6) return;
      // Sitting on the line is not enough on a course where holes run alongside each
      // other — Pueblo's 1st tee lies within fifty yards of the 3rd's centreline. Being
      // near where that line STARTS is what settles it, so weigh both.
      const cost = d + 0.5 * along;
      if (cost < bd) { bd = cost; best = li; }
    });
    return best;
  });

  const units = [], unpaired = [];
  lanes.forEach((ln, li) => {
    const mine = tees.filter((_t, ti) => owner[ti] === li);
    if (!mine.length) { unpaired.push(ln.gi); return; }
    let back = mine[0], play = -1;
    for (const t of mine) {
      const d = G.dist(t.center, ln.green.center);
      if (d > play) { play = d; back = t; }
    }
    units.push({ green: ln.green, tees: mine, teeCenter: back.center,
      play, evidence: ['centreline'], score: 100 });
  });
  return unpaired.length ? null : { units, unpaired, shared: 0 };
}

/**
 * Pair tees with greens in two phases.
 *
 * Phase A picks ONE anchor tee per green, globally, with the Hungarian algorithm rather
 * than letting each tee grab its own favourite. Greedy fails here in a specific way:
 * two neighbouring holes can each score the other's green as well as their own, and a
 * per-tee argmax happily takes both wrong answers. A global assignment cannot, because
 * swapping them costs total score.
 *
 * Phase B hangs the remaining tee boxes — the forward tees — on whichever anchored hole
 * they line up behind. A tee that lines up behind nothing is left out rather than forced
 * onto the nearest hole; it is usually a practice tee.
 */
function pairHoles(tees, greens, ctx) {
  const skeleton = pairViaCentrelines(tees, greens, ctx);
  if (skeleton) return skeleton;

  const S = tees.map(t => greens.map(g => pairScore(t, g, ctx)));
  const pick = assign(S.map(row => row.map(s => (s ? s.score : null))));

  const anchorOf = new Map();                       // green index -> anchor tee index
  pick.forEach((gi, ti) => { if (gi >= 0) anchorOf.set(gi, ti); });

  pick.forEach((gi, ti) => {
    if (gi >= 0) return;                            // already an anchor
    let bestG = -1, bestS = -Infinity;
    for (const [g2, a2] of anchorOf) {
      const s = S[ti][g2];
      if (!s) continue;
      // a forward tee sits behind the anchor tee, on the same line to the green
      const turn = G.bearingDelta(G.bearing(tees[ti].center, greens[g2].center),
                                  G.bearing(tees[a2].center, greens[g2].center));
      if (turn > 25) continue;
      if (G.dist(tees[ti].center, tees[a2].center) > 220) continue;
      if (s.score > bestS) { bestS = s.score; bestG = g2; }
    }
    pick[ti] = bestG;
  });

  // Phase C: shared tees. Two holes really can play from one tee box — Prairie Pines'
  // 2nd and 6th leave from the same one, nought yards apart — and a tee can only be
  // assigned once, so the second hole comes out with no tee at all. Where a green is
  // orphaned, let it share the tee that scores best for it, and mark it as shared.
  const shared = [];
  greens.forEach((g, gi) => {
    if (pick.some(p => p === gi)) return;
    let bestT = -1, bestS = -Infinity;
    tees.forEach((_t, ti) => {
      const s = S[ti][gi];
      if (s && s.score > bestS) { bestS = s.score; bestT = ti; }
    });
    if (bestT >= 0 && bestS > 0) shared.push([gi, bestT]);
  });

  const units = [], unpaired = [];
  greens.forEach((g, gi) => {
    let mine = tees.filter((_t, ti) => pick[ti] === gi);
    const share = shared.find(s => s[0] === gi);
    if (!mine.length && share) mine = [tees[share[1]]];
    if (!mine.length) { unpaired.push(gi); return; }
    // The scorecard quotes one tee set, so the hole's length is the BACK tee's — the
    // longest of the complex. Measuring from the complex's centroid reads a long hole
    // short and turns par 5s into par 4s, which then poisons the anchor in stage 3.
    let back = mine[0], play = -1;
    for (const t of mine) {
      const d = G.dist(t.center, g.center);
      if (d > play) { play = d; back = t; }
    }
    const s = pairScore(back, g, ctx);
    const why = s ? s.why.slice() : [];
    if (share) why.push('shared-tee');
    units.push({
      green: g, tees: mine, teeCenter: back.center,
      play, evidence: why, score: s ? s.score : 0,
    });
  });
  return { units, unpaired, shared: shared.length };
}

// ===========================================================================
// Stage 2 — chain the holes into playing order
// ===========================================================================
/**
 * Walking distance green→tee along the cart-path network, when there is one.
 *
 * This matters beyond realism: straight-line cost invites shortcuts between holes that
 * happen to sit back to back but have no path between them (Pueblo CC's 7th green is a
 * stone's throw from the 15th tee, and a straight-line solver jumped straight to it).
 * A path network has no such edge, so the false shortcut disappears.
 */
function cartGraph(cartpaths) {
  const nodes = [], edges = new Map();
  const key = p => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
  const idOf = new Map();
  const nodeId = p => {
    for (const [k, i] of idOf) {                     // snap to a nearby existing junction
      if (G.dist(nodes[i], p) <= K.SNAP_YDS) return i;
      void k;
    }
    const i = nodes.length; nodes.push(p); idOf.set(key(p), i); edges.set(i, []); return i;
  };
  for (const c of cartpaths) {
    let prev = null;
    for (const p of c.line) {
      const i = nodeId(p);
      if (prev !== null && prev !== i) {
        const w = G.dist(nodes[prev], nodes[i]);
        edges.get(prev).push([i, w]); edges.get(i).push([prev, w]);
      }
      prev = i;
    }
  }
  return { nodes, edges };
}

function networkWalk(graph, from, to) {
  if (!graph.nodes.length) return null;
  // enter and leave the network at whatever junction is closest, if that's close at all
  let src = -1, srcD = Infinity, dst = -1, dstD = Infinity;
  graph.nodes.forEach((n, i) => {
    const a = G.dist(from, n); if (a < srcD) { srcD = a; src = i; }
    const b = G.dist(to, n); if (b < dstD) { dstD = b; dst = i; }
  });
  if (srcD > K.PATH_HOP_YDS || dstD > K.PATH_HOP_YDS) return null;
  const dst_ = dst;
  const d = new Float64Array(graph.nodes.length).fill(Infinity);
  d[src] = 0;
  const seen = new Uint8Array(graph.nodes.length);
  for (;;) {
    let u = -1, best = Infinity;
    for (let i = 0; i < d.length; i++) if (!seen[i] && d[i] < best) { best = d[i]; u = i; }
    if (u < 0 || u === dst_) break;
    seen[u] = 1;
    for (const [v, w] of graph.edges.get(u)) if (d[u] + w < d[v]) d[v] = d[u] + w;
  }
  return isFinite(d[dst_]) ? d[dst_] + srcD + dstD : null;
}

/**
 * Exact minimum Hamiltonian cycle over `n` nodes (Held–Karp). n ≤ 20 is instant.
 *
 * `opts.depots` says the first d nodes are clubhouse copies, and `opts.legSize` how many
 * holes each nine must contain. That constraint is not a nicety: left free, the solver
 * split Pueblo Country Club into legs of sixteen and two, because paying for one long
 * walk beats paying for two. Golf does not work that way — each nine is nine holes — and
 * pinning it down removes the cheap shortcut the solver was reaching for.
 */
function heldKarp(C, opts) {
  const n = C.length, FULL = 1 << n, INF = 1e15;
  const dep = (opts && opts.depots) || 0, legSize = (opts && opts.legSize) || 0;
  const depotMask = (1 << dep) - 1;
  const bits = m => { let c = 0; while (m) { m &= m - 1; c++; } return c; };
  const dp = new Float64Array(FULL * n).fill(INF);
  const pa = new Int16Array(FULL * n).fill(-1);
  dp[1 * n + 0] = 0;
  for (let mask = 1; mask < FULL; mask++) {
    if (!(mask & 1)) continue;
    const depotsIn = dep ? bits(mask & depotMask) : 0;
    const holes = bits(mask) - depotsIn;
    for (let u = 0; u < n; u++) {
      if (!(mask >> u & 1)) continue;
      const cur = dp[mask * n + u];
      if (cur >= INF) continue;
      for (let v = 1; v < n; v++) {
        if (mask >> v & 1) continue;
        if (dep) {
          // a nine may only close once it holds exactly legSize holes, and may not
          // take on more than its quota before that
          if (v < dep) { if (holes !== legSize * depotsIn) continue; }
          else if (holes + 1 > legSize * depotsIn) continue;
        }
        const nm = mask | (1 << v), nc = cur + C[u][v];
        if (nc < dp[nm * n + v]) { dp[nm * n + v] = nc; pa[nm * n + v] = u; }
      }
    }
  }
  let best = INF, end = -1;
  for (let u = 1; u < n; u++) {
    const t = dp[(FULL - 1) * n + u] + C[u][0];
    if (t < best) { best = t; end = u; }
  }
  if (end < 0) return { cost: Infinity, order: [] };
  const order = [];
  let mask = FULL - 1, u = end;
  while (u >= 0) { order.push(u); const p = pa[mask * n + u]; mask ^= (1 << u); u = p; }
  return { cost: best, order: order.reverse() };
}

/**
 * When OSM has no clubhouse, infer one: the node with the tightest knot of other
 * tees and greens around it. Hole 1's tee, 9's green, 10's tee and 18's green all
 * crowd the clubhouse, so that knot is where it is. Being a little off is survivable
 * — the depot's job is to stop the solver shortcutting across the property, and
 * stage 3 fixes the numbering afterwards regardless.
 */
function inferClubhouse(units) {
  const pts = [];
  units.forEach(u => { pts.push(u.green.center); u.tees.forEach(t => pts.push(t.center)); });
  let best = null, bestScore = Infinity;
  for (const p of pts) {
    const ds = pts.map(q => G.dist(p, q)).sort((a, b) => a - b);
    const s = sum(ds.slice(0, 6));
    if (s < bestScore) { bestScore = s; best = p; }
  }
  return best;
}

/**
 * Chain the holes, one way per candidate, and let the caller pick with the scorecard.
 *
 * Two models, because neither is right on its own:
 *
 *   'depot' hangs both nines off the clubhouse, forcing each to hold nine holes. This is
 *      what a golf course actually is, and it is the only thing that gets Pueblo Country
 *      Club right — a free solver shortcuts its 7th green to its 15th tee to dodge the
 *      long walk in from the 9th.
 *   'loop' is the plain cheapest cycle, no depot at all. Where the clubhouse isn't tagged
 *      in OSM we only have a guess at it, and hanging a hard nine-nine constraint off a
 *      guessed point is worse than not constraining at all: it broke Buffalo Dunes, which
 *      the plain loop gets exactly right.
 *
 * So build both and let stage 3 judge them against the card. The scorecard arbitrates
 * everywhere else in this pipeline; there's no reason to bet the routing on a guess here.
 */
function chainHoles(units, clubhouse, graph) {
  const n = units.length;
  const nines = Math.max(1, Math.round(n / 9));
  const walk = (fromGreen, toUnit) => {
    const straights = toUnit.tees.map(t => G.dist(fromGreen, t.center));
    const net = toUnit.tees.map(t => networkWalk(graph, fromGreen, t.center)).filter(x => x !== null);
    return net.length ? Math.min(...net) : Math.min(...straights);
  };
  const out = [];

  if (clubhouse && nines > 1) {
    // nodes 0..nines-1 are copies of the clubhouse; the rest are holes
    const N = n + nines, BIG = 1e9;
    const C = Array.from({ length: N }, () => new Array(N).fill(BIG));
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        if (i === j) continue;
        if (i < nines && j < nines) continue;               // a nine may not be empty
        const fromGreen = i < nines ? clubhouse : units[i - nines].green.center;
        if (j < nines) C[i][j] = G.dist(fromGreen, clubhouse);
        else C[i][j] = walk(fromGreen, units[j - nines]);
      }
    }
    const r = heldKarp(C, { depots: nines, legSize: Math.round(n / nines) });
    if (r.order.length) {
      const legs = [];
      let leg = [];
      for (const i of r.order) {
        if (i < nines) { if (leg.length) legs.push(leg); leg = []; }
        else leg.push(i - nines);
      }
      if (leg.length) legs.push(leg);
      out.push({ kind: 'depot', cycle: r.order.filter(i => i >= nines).map(i => i - nines),
        legs: legs.map(l => l.length), cost: r.cost });
    }
  }

  const P = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) =>
    i === j ? 1e9 : walk(units[i].green.center, units[j])));
  const plain = heldKarp(P);
  if (plain.order.length) {
    out.push({ kind: 'loop', cycle: plain.order, legs: [n], cost: plain.cost });
  }
  return out;
}

// ===========================================================================
// Stage 3 — anchor: decide where hole 1 is
// ===========================================================================
/**
 * The chain is a ring with no marked beginning; rotating it by nine turns the back
 * nine into the front and every yardage on the course becomes someone else's. So try
 * all N rotations in both directions and score each against the scorecard.
 *
 * Par sequence is the workhorse: a course's run of 3s and 5s is close to a fingerprint.
 * Across our three mapped courses the true rotation won outright every time (mismatches
 * 0 vs 2, 1 vs 7, 2 vs 6). Yardages, when the card lists them, sharpen it further.
 * If the winner is not clearly ahead, we say so instead of picking.
 */
function anchorChain(cycle, units, card) {
  const n = cycle.length;
  const cardPar = card.holes.map(h => h.par);
  const cardYds = card.holes.map(h => h.yds ?? null);
  const haveYds = cardYds.every(y => typeof y === 'number');

  const cands = [];
  for (const dir of [1, -1]) {
    for (let s = 0; s < n; s++) {
      const idx = [];
      for (let i = 0; i < n; i++) idx.push((((dir === 1 ? s + i : s - i) % n) + n) % n);
      const seq = idx.map(i => units[cycle[i]]);
      const parMiss = seq.reduce((a, u, i) =>
        a + (parFromYards(u.play) === cardPar[i] ? 0 : 1), 0);
      const ydErr = haveYds
        ? sum(seq.map((u, i) => Math.abs(u.play - cardYds[i]))) / n
        : null;
      cands.push({ dir, start: s, idx, parMiss, ydErr });
    }
  }
  const byPar = cands.slice().sort((a, b) =>
    a.parMiss - b.parMiss || ((a.ydErr ?? 0) - (b.ydErr ?? 0)));
  const winner = byPar[0];
  const rival = byPar.find(c => c.parMiss > winner.parMiss ||
    (haveYds && c.ydErr - winner.ydErr > 1e-6)) || byPar[1];

  const parGap = rival ? rival.parMiss - winner.parMiss : 0;
  const ydGap = haveYds && rival ? rival.ydErr - winner.ydErr : 0;
  const decided = parGap >= K.ANCHOR_PAR_MARGIN || ydGap >= K.ANCHOR_YDS_MARGIN;

  return {
    order: winner.idx.map(i => cycle[i]),
    parMiss: winner.parMiss, ydErr: winner.ydErr,
    parGap, ydGap, decided,
    reason: decided
      ? `par sequence matched with ${winner.parMiss} mismatch(es); next best was ${rival.parMiss}`
      : `AMBIGUOUS — best labelling (${winner.parMiss} par mismatches) is not clearly ahead of the next (${rival ? rival.parMiss : '—'})`,
  };
}

// ===========================================================================
// Stage 0 — believe OSM's own hole numbers when they're complete and agree with the card
// ===========================================================================
function fromRefs(greens, tees, card, ctx) {
  const refOf = o => {
    const r = parseInt(o.ref ?? o.tags?.ref, 10);
    return Number.isInteger(r) ? r : null;
  };
  const n = card.holes.length;
  const byRef = new Map();
  for (const g of greens) { const r = refOf(g); if (r) byRef.set(r, g); }
  if (byRef.size !== n) return null;
  for (let h = 1; h <= n; h++) if (!byRef.has(h)) return null;

  const units = [];
  for (let h = 1; h <= n; h++) {
    const g = byRef.get(h);
    // prefer tees carrying the same ref; otherwise whatever scores best against this green
    let mine = tees.filter(t => refOf(t) === h);
    if (!mine.length) {
      const scored = tees.map(t => ({ t, s: pairScore(t, g, ctx) }))
        .filter(x => x.s).sort((a, b) => b.s.score - a.s.score);
      if (!scored.length) return null;
      mine = [scored[0].t];
    }
    let back = mine[0], play = -1;
    for (const t of mine) {
      const d = G.dist(t.center, g.center);
      if (d > play) { play = d; back = t; }
    }
    units.push({ green: g, tees: mine, teeCenter: back.center,
      play, evidence: ['osm-ref'], score: 100 });
  }
  // sanity: the par sequence those refs imply must broadly match the card
  const miss = units.reduce((a, u, i) => a + (parFromYards(u.play) === card.holes[i].par ? 0 : 1), 0);
  if (miss > Math.max(2, Math.round(n * 0.2))) return null;
  return units;
}

// ===========================================================================
// Public entry point
// ===========================================================================
/**
 * @param {object} osm    {tees,greens,fairways,holeWays,cartpaths,clubhouse}
 *                        each feature: {id, center, ring?|line?, ref?}
 * @param {object} card   {name, holes:[{hole,par,yds?,handicap?}], tee?}
 * @returns {object}      {holes, confidence, method, review, diagnostics}
 */
function route(osm, card) {
  const greens = osm.greens || [];
  const tees = osm.tees || [];
  const n = card.holes.length;
  const review = [];

  const ctx = {
    holeWays: (osm.holeWays || []).filter(h => h.line && h.line.length > 1),
    fairways: (osm.fairways || []).filter(f => f.ring && f.ring.length > 3)
      .map(f => ({ ...f, axis: G.principalAxis(f.ring) })),
    cartpaths: (osm.cartpaths || []).filter(c => c.line && c.line.length > 1),
    cardYards: card.holes.map(h => h.yds).filter(y => typeof y === 'number'),
  };

  if (greens.length !== n) {
    review.push(`OSM has ${greens.length} greens but the card lists ${n} holes`);
  }

  if (tees.length < n) review.push(`only ${tees.length} tee polygons for ${n} holes`);

  // --- Stage 0
  let units = fromRefs(greens, tees, card, ctx);
  let method = 'osm-ref';
  let anchor = null, chain = null;

  if (!units) {
    // --- Stage 1
    method = 'derived';
    const paired = pairHoles(tees, greens, ctx);
    units = paired.units;
    if (paired.unpaired.length) review.push(`${paired.unpaired.length} green(s) could not be paired with a tee`);
    const thin = units.filter(u => !u.evidence.some(e => e === 'centreline' || e === 'fairway' || e === 'cartpath'));
    if (thin.length) review.push(`${thin.length} hole(s) paired on length alone — no centreline, fairway or cart path to confirm`);

    // --- Stage 2 + 3, decided together. Each way of chaining the holes gets scored
    // against the card, and the one the card likes best wins.
    const clubhouse = osm.clubhouse || inferClubhouse(units);
    const graph = cartGraph(ctx.cartpaths);
    const cands = chainHoles(units, clubhouse, graph);
    if (!osm.clubhouse) review.push('clubhouse not tagged in OSM — inferred from where tees and greens crowd together');
    if (!ctx.cartpaths.length) review.push('no cart paths in OSM — walking distances are straight lines');

    let bestPair = null;
    for (const c of cands) {
      const a = anchorChain(c.cycle, units, card);
      const better = !bestPair ||
        a.parMiss < bestPair.a.parMiss ||
        (a.parMiss === bestPair.a.parMiss && a.parGap > bestPair.a.parGap);
      if (better) bestPair = { c, a };
    }
    if (!bestPair) {
      review.push('could not chain the holes at all');
      return { name: card.name, holes: [], method, confidence: 'refused', review, diagnostics: {} };
    }
    chain = bestPair.c; anchor = bestPair.a;
    if (!anchor.decided) review.push(`hole 1 is not pinned down: ${anchor.reason}`);
    units = anchor.order.map(i => units[i]);
  }

  // --- Stage 4: label, and check every hole against the card
  const holes = units.map((u, i) => {
    const c = card.holes[i];
    const tol = Math.max(K.VERIFY_ABS_YDS, (c.yds || u.play) * K.VERIFY_PCT);
    const verified = typeof c.yds === 'number' ? Math.abs(u.play - c.yds) <= tol : null;
    if (verified === false) review.push(`hole ${c.hole}: mapped ${Math.round(u.play)} yds vs card ${c.yds}`);
    return {
      hole: c.hole, par: c.par, handicap: c.handicap ?? null,
      cardYds: c.yds ?? null, yds: Math.round(u.play),
      green: u.green, tees: u.tees, line: [u.teeCenter, u.green.center],
      evidence: u.evidence, verified,
    };
  });

  const verifiedCount = holes.filter(h => h.verified === true).length;
  const checkable = holes.filter(h => h.verified !== null).length;
  const confidence =
    method === 'osm-ref' ? 'high'
    : !anchor || !anchor.decided ? 'refused'
    // No yardages on the card is not the same as yardages that disagree. The routing can
    // be sound and simply have nothing to check itself against; say that, rather than
    // reporting a clean course as low confidence and sending someone hunting for a fault.
    : !checkable ? 'unverified'
    : verifiedCount / checkable >= 0.8 ? 'high'
    : verifiedCount / checkable >= 0.5 ? 'medium'
    : 'low';

  return {
    name: card.name, holes, method, confidence, review,
    diagnostics: {
      teeComplexes: units.length,
      chainCost: chain ? Math.round(chain.cost) : null,
      chainKind: chain ? chain.kind : null,
      legs: chain ? chain.legs : null,
      anchor: anchor && { parMiss: anchor.parMiss, parGap: anchor.parGap,
        ydErr: anchor.ydErr === null ? null : Math.round(anchor.ydErr),
        ydGap: Math.round(anchor.ydGap || 0), decided: anchor.decided, reason: anchor.reason },
      verified: `${verifiedCount}/${checkable}`,
    },
  };
}

module.exports = { route, K, pairScore, pairHoles, chainHoles, anchorChain,
  heldKarp, cartGraph, networkWalk, inferClubhouse, parFromYards };
