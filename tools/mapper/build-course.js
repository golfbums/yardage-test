// Assemble courses/<key>/course.json — the shape the yardage page reads (see ../../pcc/course.js) —
// from geom.json (OpenStreetMap), routing.json (which tee and green is each hole) and card.json.
//   node build-course.js <key>
// Then: node add-elevation.js <key>  →  copy to ../../<key>/course.js as window.COURSE=…
const fs = require('fs'), path = require('path');
const key = process.argv[2]; if (!key) { console.error('usage: node build-course.js <key>'); process.exit(1); }
const CD = path.join(__dirname, 'courses', key);
const geom = JSON.parse(fs.readFileSync(path.join(CD, 'geom.json'), 'utf8'));
const routing = JSON.parse(fs.readFileSync(path.join(CD, 'routing.json'), 'utf8'));
const card = JSON.parse(fs.readFileSync(path.join(CD, 'card.json'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(CD, 'meta.json'), 'utf8'));

const R = 6378137, toR = x => x * Math.PI / 180;
const m = (a, b) => { const dLat = toR(b.lat - a.lat), dLon = toR(b.lon - a.lon); const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };
const yd = d => Math.round(d / 0.9144);
const r6 = x => Math.round(x * 1e6) / 1e6;
const P = p => ({ lat: r6(p.lat), lon: r6(p.lon) });
const cen = r => ({ lat: r.reduce((s, p) => s + p.lat, 0) / r.length, lon: r.reduce((s, p) => s + p.lon, 0) / r.length });
const els = geom.elements.filter(e => e.geometry && e.tags);
const isPractice = t => /practice|putting|chipping|range|driving/i.test((t.name || '') + ' ' + (t.description || ''));
const ringOf = e => e.geometry.map(P);
const greens = els.filter(e => e.tags.golf === 'green' && !isPractice(e.tags)).map(e => ({ id: e.id, ring: ringOf(e) }));
const tees = els.filter(e => e.tags.golf === 'tee').map(e => ({ id: e.id, ring: ringOf(e), c: cen(e.geometry) }));
const fairways = els.filter(e => e.tags.golf === 'fairway' && !isPractice(e.tags)).map(e => ({ ring: ringOf(e), ref: Number(e.tags.ref) || null }));
const bunkers = els.filter(e => e.tags.golf === 'bunker').map(e => ringOf(e));
const water = els.filter(e => e.tags.natural === 'water' || /water_hazard/.test(e.tags.golf || '')).map(e => ringOf(e));
const holeWays = els.filter(e => e.tags.golf === 'hole').map(e => ({ ref: Number(e.tags.ref), line: e.geometry.map(P), par: Number(e.tags.par) || null, hcp: Number(e.tags.handicap) || null }));
const club = els.find(e => e.tags.golf === 'clubhouse' || e.tags.building === 'clubhouse');
const clubhouse = club ? P(cen(club.geometry)) : null;

// distance from a point to a polyline, in metres (local flat projection)
function distToLine(p, line) {
  let best = 1e9; const kx = 111320 * Math.cos(toR(p.lat)), ky = 111320;
  for (let k = 0; k + 1 < line.length; k++) {
    const a = line[k], b = line[k + 1]; const ax = (a.lon - p.lon) * kx, ay = (a.lat - p.lat) * ky, bx = (b.lon - p.lon) * kx, by = (b.lat - p.lat) * ky;
    const dx = bx - ax, dy = by - ay; const l2 = dx * dx + dy * dy || 1; let t = -(ax * dx + ay * dy) / l2; t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(ax + dx * t, ay + dy * t));
  }
  return best;
}
const ringDist = (ring, line) => Math.min(...ring.map(p => distToLine(p, line)));

// where the approach line (last leg into the green) crosses the green outline: front, then back
function frontBack(from, ring, center) {
  const kx = 111320 * Math.cos(toR(center.lat)), ky = 111320;
  const T = { x: (center.lon - from.lon) * kx, y: (center.lat - from.lat) * ky }; const L2 = Math.hypot(T.x, T.y) || 1; const ux = T.x / L2, uy = T.y / L2;
  const hits = [];
  for (let i = 0; i < ring.length; i++) {
    const a = { x: (ring[i].lon - from.lon) * kx, y: (ring[i].lat - from.lat) * ky }, b = { x: (ring[(i + 1) % ring.length].lon - from.lon) * kx, y: (ring[(i + 1) % ring.length].lat - from.lat) * ky };
    const dx = b.x - a.x, dy = b.y - a.y; const den = ux * dy - uy * dx; if (Math.abs(den) < 1e-9) continue;
    const t = (a.x * dy - a.y * dx) / den, u = (a.x * uy - a.y * ux) / den; if (u >= 0 && u <= 1 && t > 0) hits.push(t);
  }
  hits.sort((a, b) => a - b);
  const at = t => P({ lat: from.lat + uy * t / ky, lon: from.lon + ux * t / kx });
  if (hits.length >= 2) return { front: at(hits[0]), back: at(hits[hits.length - 1]), depth: yd(hits[hits.length - 1] - hits[0]) };
  return { front: at(L2 - 11), back: at(L2 + 11), depth: 24 };
}

const cardHole = n => card.holes.find(h => h.hole === n) || {};
const teeNames = (card.teeSets || []).map(t => t.name);
const holes = routing.holes.map(rh => {
  const n = rh.hole; const g = greens.find(x => x.id === rh.green); const t0 = tees.find(x => x.id === rh.tee);
  const gc = cen(g.ring);
  // the line: the volunteers' hole way where there is one (run tee → green), else tee → green
  const hw = holeWays.find(h => h.ref === n); let line;
  if (hw && hw.line.length >= 2) { line = hw.line.slice(); if (m(line[0], gc) < m(line[line.length - 1], gc)) line.reverse(); }
  else line = [P(t0.c), P(gc)];
  // every tee pad that belongs to this hole: nearest to this hole's start, back to front
  const start = line[0];
  // routing may name this hole's pads outright (tier-2 routing read from the photo); else take the nearby pads
  const mine = rh.tees ? rh.tees.map(id => tees.find(x => x.id === id)).filter(Boolean).sort((a, b) => m(b.c, gc) - m(a.c, gc)) : tees.filter(t => { const dS = m(t.c, start); if (dS > 140) return false; const nearest = holeWays.length ? holeWays.slice().sort((a, b) => distToLine(t.c, a.line) - distToLine(t.c, b.line))[0] : null; return !nearest || nearest.ref === n || m(t.c, t0.c) < 60; })
    .sort((a, b) => m(b.c, gc) - m(a.c, gc)).slice(0, 6);
  if (!mine.find(t => t.id === t0.id)) mine.unshift(t0);
  const ch = cardHole(n);
  // one pad per tee set, back to front: colour them in card order; otherwise nearest card yardage
  const inOrder = rh.tees && ch.yardsByTee && mine.length === teeNames.length;
  const teesOut = mine.map((t, i) => {
    const yds = yd(m(t.c, gc));
    let color = null; if (inOrder) color = teeNames[i].toLowerCase(); else if (ch.yardsByTee) { const best = teeNames.map(nm => ({ nm, d: Math.abs(ch.yardsByTee[nm] - yds) })).sort((a, b) => a.d - b.d)[0]; if (best && best.d <= 30) color = best.nm.toLowerCase(); }
    return { center: P(t.c), color, yds, elev: null, ring: t.ring };
  });
  const approachFrom = line.length >= 2 ? line[line.length - 2] : P(t0.c);
  const fb = frontBack(approachFrom, g.ring, gc);
  const fw = fairways.filter(f => f.ref === n).map(f => f.ring);
  if (!fw.length) fairways.filter(f => !f.ref).forEach(f => { const nearest = holeWays.slice().sort((a, b) => ringDist(f.ring, a.line) - ringDist(f.ring, b.line))[0]; if (nearest && nearest.ref === n && ringDist(f.ring, line) < 60) fw.push(f.ring); });
  return {
    hole: n, par: ch.par || (hw && hw.par) || null, handicap: ch.handicap || (hw && hw.hcp) || null,
    line,
    green: { ring: g.ring, center: P(gc), front: fb.front, back: fb.back, depthYds: fb.depth, elev: null },
    tees: teesOut,
    fairways: fw,
    bunkers: bunkers.filter(b => ringDist(b, line) < 70),
    water: water.filter(w => ringDist(w, line) < 110),
  };
});
const course = {
  name: meta.matchedName || card.course, source: 'OpenStreetMap contributors (ODbL); scorecard OpenGolfAPI (ODbL); elevation USGS 3DEP',
  cardTee: routing.teeSet || null, par: card.par || holes.reduce((s, h) => s + (h.par || 0), 0), clubhouse, holes,
};
fs.writeFileSync(path.join(CD, 'course.json'), JSON.stringify(course));
const teeCounts = holes.map(h => h.tees.length), fwCounts = holes.map(h => h.fairways.length);
console.log(`${key}: ${holes.length} holes · tees per hole ${teeCounts.join(',')} · fairways per hole ${fwCounts.join(',')} · bunkers ${holes.reduce((s, h) => s + h.bunkers.length, 0)} · water ${holes.reduce((s, h) => s + h.water.length, 0)} · clubhouse ${clubhouse ? 'yes' : 'no'}`);
console.log('  green depth (yds): ' + holes.map(h => h.green.depthYds).join(' '));
console.log('  wrote courses/' + key + '/course.json');
