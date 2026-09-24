// Shared geometry. Everything public is in YARDS; lat/lon are degrees.
'use strict';

const M_PER_YD = 0.9144;
const R_EARTH = 6371008.8; // metres

const toRad = deg => deg * Math.PI / 180;

/** Great-circle distance between two {lat,lon} points, in yards. */
function dist(a, b) {
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h)) / M_PER_YD;
}

/**
 * Local flat projection in yards about an origin. Golf courses are ~1 km across,
 * so a tangent plane is accurate to well under a yard and lets us do real linear
 * algebra (PCA, projections) instead of spherical trigonometry.
 */
function planer(origin) {
  const k = Math.cos(toRad(origin.lat));
  const yPerDeg = (R_EARTH * Math.PI / 180) / M_PER_YD;
  return {
    to: p => ({ x: (p.lon - origin.lon) * yPerDeg * k, y: (p.lat - origin.lat) * yPerDeg }),
    from: q => ({ lat: origin.lat + q.y / yPerDeg, lon: origin.lon + q.x / (yPerDeg * k) }),
  };
}

/** Arithmetic mean of a ring/line of {lat,lon}. */
function centroid(pts) {
  const n = pts.length;
  return { lat: pts.reduce((a, p) => a + p.lat, 0) / n, lon: pts.reduce((a, p) => a + p.lon, 0) / n };
}

/** Bearing a→b in degrees clockwise from north. */
function bearing(a, b) {
  const e = (b.lon - a.lon) * Math.cos(toRad(a.lat)), n = b.lat - a.lat;
  return (Math.atan2(e, n) * 180 / Math.PI + 360) % 360;
}

/** Smallest absolute difference between two bearings, 0..180. */
function bearingDelta(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Principal axis of a polygon ring, as the two extreme points along it.
 * A fairway is a long thin blob; its principal axis runs tee→green (in some
 * order), which is the single most useful thing a fairway tells us.
 * Returns {a, b, length, ratio} where ratio is long-axis / short-axis spread —
 * high ratio means "genuinely elongated", i.e. trustworthy.
 */
function principalAxis(ring) {
  const o = centroid(ring), pl = planer(o);
  const P = ring.map(pl.to);
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of P) { sxx += p.x * p.x; sxy += p.x * p.y; syy += p.y * p.y; }
  const n = P.length; sxx /= n; sxy /= n; syy /= n;
  // principal eigenvector of the 2x2 covariance matrix
  const tr = sxx + syy, det = sxx * syy - sxy * sxy;
  const l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l2 = tr / 2 - Math.sqrt(Math.max(0, tr * tr / 4 - det));
  let vx, vy;
  if (Math.abs(sxy) > 1e-9) { vx = l1 - syy; vy = sxy; }
  else if (sxx >= syy) { vx = 1; vy = 0; }
  else { vx = 0; vy = 1; }
  const m = Math.hypot(vx, vy) || 1; vx /= m; vy /= m;
  let lo = Infinity, hi = -Infinity, loP = null, hiP = null;
  for (let i = 0; i < P.length; i++) {
    const t = P[i].x * vx + P[i].y * vy;
    if (t < lo) { lo = t; loP = ring[i]; }
    if (t > hi) { hi = t; hiP = ring[i]; }
  }
  return {
    a: loP, b: hiP, length: hi - lo,
    ratio: l2 > 1e-6 ? Math.sqrt(l1 / l2) : 999,
  };
}

/** Shortest distance from point p to segment ab, in yards. */
function pointToSegment(p, a, b) {
  const pl = planer(a);
  const P = pl.to(p), A = pl.to(a), B = pl.to(b);
  const dx = B.x - A.x, dy = B.y - A.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return dist(p, a);
  let t = ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(P.x - (A.x + t * dx), P.y - (A.y + t * dy));
}

/** Shortest distance from p to a polyline, in yards. */
function pointToLine(p, line) {
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) best = Math.min(best, pointToSegment(p, line[i], line[i + 1]));
  return line.length === 1 ? dist(p, line[0]) : best;
}

/** Is point p inside ring (even-odd rule)? Ring is [{lat,lon}...]. */
function inRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].lon, yi = ring[i].lat, xj = ring[j].lon, yj = ring[j].lat;
    if ((yi > p.lat) !== (yj > p.lat) &&
        p.lon < (xj - xi) * (p.lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Total length of a polyline, in yards. */
function pathLength(line) {
  let t = 0;
  for (let i = 0; i < line.length - 1; i++) t += dist(line[i], line[i + 1]);
  return t;
}

/** Do segments p1p2 and p3p4 cross? Used to penalise routings that criss-cross. */
function segmentsCross(p1, p2, p3, p4) {
  const pl = planer(p1);
  const [A, B, C, D] = [p1, p2, p3, p4].map(pl.to);
  const cr = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const d1 = cr(C, D, A), d2 = cr(C, D, B), d3 = cr(A, B, C), d4 = cr(A, B, D);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

module.exports = {
  M_PER_YD, dist, planer, centroid, bearing, bearingDelta,
  principalAxis, pointToSegment, pointToLine, inRing, pathLength, segmentsCross,
};
