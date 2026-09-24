// The cart paths ARE the routing. A course draws the walk from each green to the next
// tee as an actual path on the ground; we've been approximating it with a straight line,
// which walks through ponds and across other holes.
//
// Build a graph from the path ways, snap greens and tees onto it, and measure the real
// distance you'd travel. A tee that is a short ride from the previous green is on the
// next hole. A tee that is close as the crow flies but miles by path is not.

const R = 6378137, toR = x => x * Math.PI / 180;
const m = (a, b) => { const dLat = toR(b.lat - a.lat), dLon = toR(b.lon - a.lon); const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };

function buildGraph(ways, snapTol = 9) {
  const nodes = [];                       // {lat, lon}
  const adj = [];                         // adj[i] = [[j, dist], ...]
  const key = p => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
  const grid = new Map();                 // coarse spatial hash so junctions merge
  const cell = p => `${Math.round(p.lat / 0.0001)},${Math.round(p.lon / 0.0001)}`;

  function nodeFor(p) {
    // look in this cell and its neighbours for an existing node within snapTol
    const cy = Math.round(p.lat / 0.0001), cx = Math.round(p.lon / 0.0001);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const list = grid.get(`${cy + dy},${cx + dx}`);
      if (!list) continue;
      for (const i of list) if (m(nodes[i], p) <= snapTol) return i;
    }
    const i = nodes.length; nodes.push({ lat: p.lat, lon: p.lon }); adj.push([]);
    const c = cell(p); if (!grid.has(c)) grid.set(c, []); grid.get(c).push(i);
    return i;
  }

  for (const w of ways) {
    let prev = null;
    for (const p of w) {
      const i = nodeFor(p);
      if (prev !== null && prev !== i) {
        const d = m(nodes[prev], nodes[i]);
        adj[prev].push([i, d]); adj[i].push([prev, d]);
      }
      prev = i;
    }
  }
  return { nodes, adj };
}

// Dijkstra from one node to all others
function distsFrom(graph, src) {
  const n = graph.nodes.length;
  const dist = new Array(n).fill(Infinity); dist[src] = 0;
  const seen = new Array(n).fill(false);
  // n is small (hundreds) so a linear scan is fine and keeps this dependency-free
  for (let k = 0; k < n; k++) {
    let u = -1, best = Infinity;
    for (let i = 0; i < n; i++) if (!seen[i] && dist[i] < best) { best = dist[i]; u = i; }
    if (u === -1) break;
    seen[u] = true;
    for (const [v, d] of graph.adj[u]) if (dist[u] + d < dist[v]) dist[v] = dist[u] + d;
  }
  return dist;
}

// Nearest graph node to a point, plus how far off the path it is
function snap(graph, p) {
  let bi = -1, bd = Infinity;
  graph.nodes.forEach((n, i) => { const d = m(n, p); if (d < bd) { bd = d; bi = i; } });
  return { node: bi, off: bd };
}

/**
 * walkTable(ways, froms, tos)
 *   ways  : array of path geometries (arrays of {lat,lon})
 *   froms : array of {lat,lon} you walk FROM (green centres)
 *   tos   : array of {lat,lon} you walk TO (tee centres)
 * returns { ok, dist(i,j), offFrom[i], offTo[j], stats }
 *   dist(i,j) = metres along the cart paths from froms[i] to tos[j], or null if the
 *   network doesn't connect them (which is itself informative).
 */
function walkTable(ways, froms, tos) {
  if (!ways.length) return { ok: false, dist: () => null, offFrom: [], offTo: [], stats: { reason: 'no paths mapped' } };
  const g = buildGraph(ways);
  const sf = froms.map(p => snap(g, p));
  const st = tos.map(p => snap(g, p));
  const tables = sf.map(s => (s.node >= 0 ? distsFrom(g, s.node) : null));
  const reach = [];
  const dist = (i, j) => {
    const t = tables[i]; if (!t || st[j].node < 0) return null;
    const d = t[st[j].node];
    return isFinite(d) ? d + sf[i].off + st[j].off : null;   // include the walk on and off the path
  };
  for (let i = 0; i < froms.length; i++) for (let j = 0; j < tos.length; j++) if (dist(i, j) !== null) reach.push(1);
  return {
    ok: true, dist,
    offFrom: sf.map(s => Math.round(s.off)), offTo: st.map(s => Math.round(s.off)),
    stats: { nodes: g.nodes.length, edges: g.adj.reduce((s, a) => s + a.length, 0) / 2, reachablePairs: reach.length, totalPairs: froms.length * tos.length },
  };
}

module.exports = { walkTable, buildGraph, distsFrom, snap };
