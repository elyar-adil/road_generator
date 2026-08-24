// Road frames: the mapping from (u = longitudinal station, s = lateral offset)
// to a world-plane point.
//
// Every layer above the raw geometry talks to roads through this contract:
//   frame.wp(u, s)     world point at station u, lateral offset s (+s = left)
//   frame.fwdAt(u)     unit forward tangent at station u
//   frame.leftAt(u)    unit left normal at station u
//   frame.length       usable longitudinal extent (Infinity for rays)
//
// Two interchangeable kernels ship here:
//   - createStraightFrame: a fixed-heading ray from an origin (intersection
//     arms today).
//   - createPolylineFrame: an arc-length-parameterised centreline sampled from
//     a polyline (curved approaches, ramp alignments later). Stations beyond
//     either end extrapolate along the end tangent, so callers can treat the
//     frame as locally straight past its data. Note +s is always the LEFT of
//     travel: on a left-curving arc that is the inside of the curve.
//
// Consumers must go through wp/fwdAt instead of storing trig themselves; that
// is the seam that lets a roundabout carriageway or a ramp reuse every marking
// and surface primitive unchanged.

import { EPSILON, v2, add, scl, sub, distance, normalize, leftNormal } from './geometry.js';

export function createStraightFrame(origin = v2(0, 0), angleDeg = 0) {
  const a = angleDeg * Math.PI / 180;
  const fwd = v2(Math.cos(a), Math.sin(a));
  const left = v2(-Math.sin(a), Math.cos(a));
  const base = v2(origin.x, origin.y);
  return {
    kind: 'straight',
    origin: base,
    length: Infinity,
    fwd,
    left,
    fwdAt: () => fwd,
    leftAt: () => left,
    wp: (u, s) => add(add(base, scl(fwd, u)), scl(left, s)),
  };
}

export function createPolylineFrame(points) {
  const pts = [];
  for (const p of points || []) {
    const last = pts[pts.length - 1];
    if (!last || distance(last, p) > EPSILON) pts.push(v2(p.x, p.y));
  }
  if (pts.length < 2) throw new Error('polyline frame needs at least 2 distinct points');

  const cum = [0];
  for (let i = 1; i < pts.length; i += 1) cum.push(cum[i - 1] + distance(pts[i - 1], pts[i]));
  const total = cum[cum.length - 1];

  const pose = (u) => {
    const n = pts.length;
    if (u <= 0) {
      // Extrapolate backwards along the first segment tangent.
      const fwd = normalize(sub(pts[1], pts[0]));
      return { point: add(pts[0], scl(fwd, u)), fwd };
    }
    if (u >= total) {
      // Extrapolate forwards along the last segment tangent.
      const fwd = normalize(sub(pts[n - 1], pts[n - 2]));
      return { point: add(pts[n - 1], scl(fwd, u - total)), fwd };
    }
    let lo = 0;
    let hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= u) lo = mid; else hi = mid;
    }
    const seg = sub(pts[lo + 1], pts[lo]);
    return { point: add(pts[lo], scl(seg, (u - cum[lo]) / (cum[lo + 1] - cum[lo]))), fwd: normalize(seg) };
  };

  return {
    kind: 'polyline',
    points: pts,
    length: total,
    fwdAt: (u) => pose(u).fwd,
    leftAt: (u) => leftNormal(pose(u).fwd),
    wp: (u, s) => {
      const { point, fwd } = pose(u);
      return add(point, scl(leftNormal(fwd), s));
    },
  };
}
