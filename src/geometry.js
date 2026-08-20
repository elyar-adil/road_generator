// Shared 2D ground-plane geometry and curve helpers.
//
// All points are {x, y} where y stores "world Z" for convenience. This module
// is the single home for the vector/curve primitives that road generation
// (intersections today, interchanges/segments later) composes. Keeping these in
// one place lets any future road primitive build on the same offset/trim/dash
// machinery instead of re-deriving it.

export const EPSILON = 1e-6;

export const v2 = (x, y) => ({ x, y });
const cloneV = (p) => ({ x: p.x, y: p.y });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const scl = (a, s) => ({ x: a.x * s, y: a.y * s });
export const lerp2 = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const dot = (a, b) => a.x * b.x + a.y * b.y;
export const len = (a) => Math.hypot(a.x, a.y);
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function normalize(v) {
  const length = len(v);
  return length > EPSILON ? scl(v, 1 / length) : { x: 0, y: 0 };
}

export function leftNormal(v) {
  const n = normalize(v);
  return { x: -n.y, y: n.x };
}

export function cubicPoint2(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  return v2(
    mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x,
    mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y,
  );
}

export function appendCubic2(path, p0, p1, p2, p3, segments = 8) {
  for (let i = 1; i <= segments; i += 1) path.push(cubicPoint2(p0, p1, p2, p3, i / segments));
}

// Cubic corner fillet between two edge points/directions. Identical curve used
// for the intersection curb fillet and for right-turn islands so edges match.
export function fillet(p0, edge0dir, p1, edge1dir, segN) {
  const chordVec = sub(p1, p0);
  const chord = len(chordVec);
  if (chord < 1e-4) return [];
  const d0 = len(edge0dir) > 1e-4 ? normalize(edge0dir) : normalize(chordVec);
  const d1 = len(edge1dir) > 1e-4 ? normalize(edge1dir) : normalize(chordVec);
  const bend = Math.abs(d0.x * d1.y - d0.y * d1.x);
  const handle = Math.min(chord * 0.42, Math.max(chord * 0.16, chord * (0.22 + 0.12 * bend)));
  const c0 = add(p0, scl(d0, handle));
  const c1 = sub(p1, scl(d1, handle));
  const pts = [];
  for (let i = 1; i < segN; i += 1) {
    pts.push(cubicPoint2(p0, c0, c1, p1, i / segN));
  }
  return pts;
}

export function polylineLength(path) {
  let total = 0;
  for (let i = 1; i < path.length; i += 1) total += distance(path[i - 1], path[i]);
  return total;
}

export function pointAndTangentAtDistance(path, wantedDistance) {
  if (!path?.length) return null;
  if (path.length === 1) return { point: cloneV(path[0]), tangent: { x: 1, y: 0 } };
  let remaining = Math.max(0, wantedDistance);
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1], b = path[i], segmentLength = distance(a, b);
    if (segmentLength < EPSILON) continue;
    if (remaining <= segmentLength || i === path.length - 1) {
      const t = Math.min(1, remaining / segmentLength);
      return {
        point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
        tangent: normalize(sub(b, a)),
      };
    }
    remaining -= segmentLength;
  }
  return { point: cloneV(path[path.length - 1]), tangent: normalize(sub(path[path.length - 1], path[path.length - 2])) };
}

// Dashes are laid out along the path as if the pattern originated at an
// abstract origin and continues with a fixed cadence. `phaseOffset` shifts that
// origin backwards so the first dash leading edge sits at `phaseOffset` from the
// path start; this lets a connector inherit another marking's dash phase.
export function buildDashedSegments(path, dashLength = 1, gapLength = 1, phaseOffset = 0) {
  const total = polylineLength(path);
  if (total <= EPSILON) return [];
  const period = dashLength + gapLength;
  const mStart = Math.floor((-dashLength - phaseOffset) / period) + 1;
  const segments = [];
  for (let m = mStart; ; m += 1) {
    const start = phaseOffset + m * period;
    if (start >= total - EPSILON) break;
    const end = start + dashLength;
    if (end <= 0) continue;
    const a = pointAndTangentAtDistance(path, Math.max(0, start))?.point;
    const b = pointAndTangentAtDistance(path, Math.min(end, total))?.point;
    if (a && b && distance(a, b) > EPSILON) segments.push([a, b]);
  }
  return segments;
}

export function trimPolyline(path, maxLength) {
  if (!path?.length || maxLength <= 0) return [];
  const trimmed = [cloneV(path[0])];
  let travelled = 0;
  for (let i = 1; i < path.length; i += 1) {
    const segmentLength = distance(path[i - 1], path[i]);
    if (segmentLength < EPSILON) continue;
    if (travelled + segmentLength >= maxLength) {
      const t = Math.max(0, Math.min(1, (maxLength - travelled) / segmentLength));
      trimmed.push(v2(
        path[i - 1].x + (path[i].x - path[i - 1].x) * t,
        path[i - 1].y + (path[i].y - path[i - 1].y) * t,
      ));
      return trimmed;
    }
    trimmed.push(cloneV(path[i]));
    travelled += segmentLength;
  }
  return trimmed;
}

export function trimPolylineByEnvelope(path, {
  forward, left, minLongitudinal, maxLongitudinal, minLateral, maxLateral,
  halfWidth, clearance = 0.18,
}) {
  if (!path?.length) return [];
  const safe = [cloneV(path[0])];
  const lower = minLateral + clearance;
  const upper = maxLateral - clearance;
  for (let i = 1; i < path.length; i += 1) {
    const point = path[i];
    const longitudinal = point.x * forward.x + point.y * forward.y;
    const lateral = point.x * left.x + point.y * left.y;
    const insideLongitudinal = longitudinal > minLongitudinal && longitudinal < maxLongitudinal;
    const overlapsLane = insideLongitudinal && lateral - halfWidth < upper && lateral + halfWidth > lower;
    if (overlapsLane) break;
    safe.push(cloneV(point));
  }
  return safe;
}

// Offset a path to the left/right by a fixed half-width.
export function offsetPolyline(path, halfWidth) {
  const left = [], right = [];
  for (let i = 0; i < path.length; i += 1) {
    const previous = path[Math.max(0, i - 1)], next = path[Math.min(path.length - 1, i + 1)];
    const n = leftNormal(sub(next, previous));
    left.push(add(path[i], scl(n, halfWidth)));
    right.push(add(path[i], scl(n, -halfWidth)));
  }
  return { left, right };
}

// Offset with a width taper starting at path index 0 (scaleAt(i) in [0,1]).
export function taperedOffsetPath(path, halfWidth, scaleAt) {
  const left = [], right = [];
  for (let i = 0; i < path.length; i += 1) {
    const previous = path[Math.max(0, i - 1)], next = path[Math.min(path.length - 1, i + 1)];
    const n = leftNormal(sub(next, previous));
    const scaleFactor = Math.min(1, scaleAt ? scaleAt(i) : 1);
    left.push(add(path[i], scl(n, halfWidth * scaleFactor)));
    right.push(add(path[i], scl(n, -halfWidth * scaleFactor)));
  }
  return { left, right };
}

// Split a centreline into `laneCount` evenly spaced lane centrelines, with an
// optional lateral taper (0 at the nose to full offset downstream).
export function offsetLanePaths(path, laneCount, laneWidth, taperPoints = 0) {
  const bundleWidth = laneCount * laneWidth;
  return Array.from({ length: laneCount }, (_, laneIndex) => path.map((point, index) => {
    const previous = path[Math.max(0, index - 1)], next = path[Math.min(path.length - 1, index + 1)];
    const n = leftNormal(sub(next, previous));
    const offset = bundleWidth / 2 - (laneIndex + 0.5) * laneWidth;
    const taper = taperPoints > 0 ? Math.min(1, index / taperPoints) : 1;
    return add(point, scl(n, offset * taper));
  }));
}

// Left/right (visual) turn curve from a source lane to a target lane, stopping
// at the closest point to the intersection origin so a waiting pocket never
// runs beyond the junction centre.
export function buildLeftTurnPath({
  start, startDirection, target, targetDirection, origin = { x: 0, y: 0 },
  samples = 24, handleScale = 1, maxProgress = 0.5,
}) {
  const d0 = normalize(startDirection), d1 = normalize(targetDirection);
  const chord = distance(start, target);
  if (chord < 1 || len(d0) < EPSILON || len(d1) < EPSILON) return [];
  const handle = Math.min(chord * 0.68, Math.max(3, chord * 0.38 * handleScale));
  const control1 = add(start, scl(d0, handle));
  const control2 = add(target, scl(d1, -handle));
  const count = Math.max(8, Math.round(samples));
  const points = [];
  const progress = Math.min(0.55, Math.max(0.38, maxProgress));
  for (let i = 0; i <= count; i += 1) points.push(cubicPoint2(start, control1, control2, target, (i / count) * progress));

  let closestIndex = points.length - 1;
  let closestDistance = distance(points[closestIndex], origin);
  for (let i = 1; i < points.length; i += 1) {
    const radius = distance(points[i], origin);
    if (radius < closestDistance - EPSILON) {
      closestDistance = radius;
      closestIndex = i;
    }
  }
  return closestIndex >= 2 ? points.slice(0, closestIndex + 1) : [];
}

export function lineIntersect(p1, p2, p3, p4) {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-6) return null;
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  return v2(p1.x + d1x * t, p1.y + d1y * t);
}

export function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i].x, yi = ring[i].y, xj = ring[j].x, yj = ring[j].y;
    const intersects = ((yi > point.y) !== (yj > point.y)) && (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

// First intersection of a ray (point + unit direction) with a boundary
// polyline; falls back to the nearest boundary point when the ray misses.
// With `closed` the boundary is treated as a ring (last point wraps to first).
export function rayBoundaryIntersect(point, direction, boundary, closed = false) {
  let best = null, bestDistance = Infinity;
  const count = boundary.length - (closed ? 0 : 1);
  for (let i = 0; i < count; i += 1) {
    const a = boundary[i], b = boundary[(i + 1) % boundary.length];
    const ab = sub(b, a);
    const denom = direction.x * ab.y - direction.y * ab.x;
    if (Math.abs(denom) < 1e-9) continue;
    const t = ((a.x - point.x) * ab.y - (a.y - point.y) * ab.x) / denom;
    const u = ((a.x - point.x) * direction.y - (a.y - point.y) * direction.x) / denom;
    if (t > 1e-3 && u >= -1e-4 && u <= 1 + 1e-4 && t < bestDistance) {
      bestDistance = t;
      best = add(point, scl(direction, t));
    }
  }
  if (best) return best;
  let nearest = null, nearestDistance = Infinity;
  for (let i = 0; i < count; i += 1) {
    const a = boundary[i], b = boundary[(i + 1) % boundary.length];
    const ab = sub(b, a);
    const abLength = len(ab) || 1;
    const u = clamp(((point.x - a.x) * ab.x + (point.y - a.y) * ab.y) / (abLength * abLength), 0, 1);
    const candidate = add(a, scl(ab, u));
    const dist = distance(candidate, point);
    if (dist < nearestDistance) { nearestDistance = dist; nearest = candidate; }
  }
  return nearest;
}

// Project a point into a local (u=forward, s=lateral) frame defined by g.
export function toLocal(g, p) {
  const d = sub(p, g.wp(0, 0));
  return { u: d.x * g.fwd.x + d.y * g.fwd.y, s: d.x * g.left.x + d.y * g.left.y };
}

// Last crossing of a polyline with the arm edge line s=targetS.
export function lastEdgeCrossing(points, g, targetS, minIndex) {
  for (let i = points.length - 1; i > minIndex; i -= 1) {
    const a = points[i - 1], b = points[i];
    const sa = toLocal(g, a).s, sb = toLocal(g, b).s;
    if ((sa - targetS) * (sb - targetS) < 0) {
      const t = (targetS - sa) / (sb - sa);
      return { index: i, point: lerp2(a, b, clamp(t, 0, 1)) };
    }
  }
  return null;
}

export function edgeLine(g, uFrom, uTo, s, step) {
  const count = Math.max(2, Math.round(Math.abs(uTo - uFrom) / step));
  const pts = [];
  for (let k = 0; k <= count; k += 1) pts.push(g.wp(uFrom + (uTo - uFrom) * k / count, s));
  return pts;
}