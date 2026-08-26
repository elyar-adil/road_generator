// Graft (嫁接) kernel: the shared operation of merging one road into another.
//
// A roundabout entry grafts onto the circulating carriageway, a right-turn slip
// lane grafts onto the target arm's inbound flow, and an interchange ramp will
// graft onto a mainline — all three are the same shape problem:
//
//   1. blend     a tangent cubic from the stem onto the target flow line
//   2. seam      constant-width edges handed over to the target (radial mouth
//                blend when the target is circular)
//   3. channel   a channelization island (导流岛) in the wedge the graft leaves
//                against whatever it bypasses, plus yield marks at the mouth
//
// Everything here is pure data (no THREE), so derivation layers and any future
// export pipeline consume the same primitives.

import {
  add, sub, scl, len, normalize,
  pointAndTangentAtDistance, buildDashedSegments,
} from './geometry.js';

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// 1. Blend curve
// ---------------------------------------------------------------------------

function cubicSample(p0, c1, c2, p3, segments = 128) {
  const pts = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments, m = 1 - t;
    pts.push({
      x: m * m * m * p0.x + 3 * m * m * t * c1.x + 3 * m * t * t * c2.x + t * t * t * p3.x,
      y: m * m * m * p0.y + 3 * m * m * t * c1.y + 3 * m * t * t * c2.y + t * t * t * p3.y,
    });
  }
  return pts;
}

// Cubic blend from `start` (heading startDir) to `end` (heading endDir).
// Handle lengths default to fractions of the chord; absolute handles override.
export function tangentBlend(start, startDir, end, endDir, {
  startScale = 0.3, endScale = 0.28, startHandle = null, endHandle = null,
  segments = 128,
} = {}) {
  const chord = len(sub(end, start)) || 1;
  const h0 = startHandle ?? chord * startScale;
  const h1 = endHandle ?? chord * endScale;
  return cubicSample(
    start,
    add(start, scl(normalize(startDir), h0)),
    add(end, scl(normalize(endDir), -h1)),
    end,
    segments,
  );
}

// ---------------------------------------------------------------------------
// 2. Seam blend onto a circular target carriageway
// ---------------------------------------------------------------------------
// A constant-distance offset of a curved approach wraps slightly around the
// target circle: near the seam the edge normals still carry an angular
// component, so the outer edge overshoots the slot angle by a few tenths of a
// degree and folds back. Fix inside the offset model: drop the overshot tail
// and blend both edges along concentric arcs onto their radial mouths. Both
// edges share one cutoff index and one arc-angle list, so index-aligned
// consumers keep exact branch widths everywhere.

export function blendEdgesToSeam(edges, joinRadii, seamAngle, { arcPoints = 6 } = {}) {
  const angleDelta = (point) => {
    const delta = Math.atan2(point.y, point.x) - seamAngle;
    return delta - Math.round(delta / TAU) * TAU;
  };
  const cuts = edges.map((points) => {
    for (let index = points.length - 1; index >= 0; index -= 1) {
      if (angleDelta(points[index]) <= 1e-9) return index;
    }
    return points.length - 2;
  });
  const cut = Math.max(2, Math.min(...cuts));
  const delta0 = Math.min(0, ...edges.map((points) => angleDelta(points[cut])));
  const tails = joinRadii.map((radius) => Array.from({ length: arcPoints }, (_, step) => {
    const angle = seamAngle + delta0 * (1 - (step + 1) / arcPoints);
    return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
  }));
  return edges.map((points, edge) => [...points.slice(0, cut + 1), ...tails[edge]]);
}

export function blendEdgesFromSeam(edges, joinRadii, seamAngle, { arcPoints = 6 } = {}) {
  const angleDelta = (point) => {
    const delta = Math.atan2(point.y, point.x) - seamAngle;
    return delta - Math.round(delta / TAU) * TAU;
  };
  const cuts = edges.map((points) => {
    const index = points.findIndex((point) => angleDelta(point) >= -1e-9);
    return index < 0 ? points.length - 2 : index;
  });
  const limit = Math.min(...edges.map((points) => points.length)) - 3;
  const cut = Math.min(limit, Math.max(...cuts));
  const delta0 = Math.max(0, ...edges.map((points) => angleDelta(points[cut])));
  const heads = joinRadii.map((radius) => Array.from({ length: arcPoints }, (_, step) => {
    const angle = seamAngle + delta0 * step / arcPoints;
    return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
  }));
  return edges.map((points, edge) => [...heads[edge], ...points.slice(cut)]);
}

// ---------------------------------------------------------------------------
// 3. Path queries
// ---------------------------------------------------------------------------

export function segmentRadiusIntersection(a, b, radius) {
  const delta = sub(b, a);
  const aa = delta.x * delta.x + delta.y * delta.y;
  const bb = 2 * (a.x * delta.x + a.y * delta.y);
  const cc = a.x * a.x + a.y * a.y - radius * radius;
  const root = Math.sqrt(Math.max(0, bb * bb - 4 * aa * cc));
  const candidates = [(-bb - root) / (2 * aa), (-bb + root) / (2 * aa)];
  const t = candidates.find((value) => value >= -1e-8 && value <= 1 + 1e-8) ?? 0.5;
  return add(a, scl(delta, Math.max(0, Math.min(1, t))));
}

export function pathPrefixOutsideRadius(path, radius) {
  if (!path.length) return [];
  const result = [path[0]];
  for (let index = 1; index < path.length; index += 1) {
    const previous = path[index - 1];
    const point = path[index];
    if (len(point) >= radius) result.push(point);
    else {
      result.push(segmentRadiusIntersection(previous, point, radius));
      break;
    }
  }
  return result;
}

export function pathSuffixOutsideRadius(path, radius) {
  if (!path.length) return [];
  for (let index = 1; index < path.length; index += 1) {
    if (len(path[index - 1]) < radius && len(path[index]) >= radius) {
      return [segmentRadiusIntersection(path[index - 1], path[index], radius), ...path.slice(index)];
    }
  }
  return path.slice();
}

// Distance along `path` at which it first crosses inward through `radius`
// (measured from the origin), or null when it never does.
export function pathDistanceAtRadius(path, radius) {
  let travelled = 0;
  for (let i = 1; i < path.length; i += 1) {
    const prev = path[i - 1];
    const point = path[i];
    const segLen = Math.hypot(point.x - prev.x, point.y - prev.y);
    const rPrev = Math.hypot(prev.x, prev.y);
    const rPoint = Math.hypot(point.x, point.y);
    if (rPrev >= radius && rPoint < radius) {
      return travelled + segLen * ((rPrev - radius) / Math.max(1e-9, rPrev - rPoint));
    }
    travelled += segLen;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 4. Channelization island (导流岛)
// ---------------------------------------------------------------------------

function pointSegmentDistance(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const lengthSq = abx * abx + aby * aby;
  const t = lengthSq < 1e-12 ? 0
    : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lengthSq));
  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
}

function distanceToPolyline(p, path) {
  let best = Infinity;
  for (let i = 1; i < path.length; i += 1) {
    const d = pointSegmentDistance(p, path[i - 1], path[i]);
    if (d < best) best = d;
  }
  return best;
}

// Walk `path` (fork -> nose) from its fork end until it separates from `other`
// by minWidth; return the interpolated fork-side cap point and the index of the
// first fully-separated point, or null when the wedge never widens that far.
function capPointFromFork(path, other, minWidth) {
  if (distanceToPolyline(path[0], other) >= minWidth) return { point: path[0], index: 0 };
  for (let index = 1; index < path.length; index += 1) {
    const dist = distanceToPolyline(path[index], other);
    if (dist >= minWidth) {
      const prevDist = distanceToPolyline(path[index - 1], other);
      const t = (minWidth - prevDist) / Math.max(1e-9, dist - prevDist);
      const a = path[index - 1], b = path[index];
      return {
        point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
        index,
      };
    }
  }
  return null;
}

// Semicircular cap arc from `from` to `to` (endpoints excluded), bulging away
// from `awayFrom`.
function roundedCap(from, to, awayFrom, segments) {
  const centre = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const radius = Math.hypot(from.x - to.x, from.y - to.y) / 2;
  if (radius < 1e-6) return null;
  const startAngle = Math.atan2(from.y - centre.y, from.x - centre.x);
  const endAngle = Math.atan2(to.y - centre.y, to.x - centre.x);
  const bulgeAngle = Math.atan2(centre.y - awayFrom.y, centre.x - awayFrom.x);
  let sweep = endAngle - startAngle;
  while (sweep > Math.PI) sweep -= TAU;
  while (sweep <= -Math.PI) sweep += TAU;
  // Two candidate arcs (short and long way); take whichever passes through
  // the bulge direction.
  const candidates = [sweep, sweep - Math.sign(sweep || 1) * TAU];
  let best = candidates[0];
  let bestScore = Infinity;
  for (const candidate of candidates) {
    let d = startAngle + candidate / 2 - bulgeAngle;
    while (d > Math.PI) d -= TAU;
    while (d <= -Math.PI) d += TAU;
    const score = Math.abs(d);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  const pts = [];
  for (let i = 1; i < segments; i += 1) {
    const angle = startAngle + best * i / segments;
    pts.push({ x: centre.x + radius * Math.cos(angle), y: centre.y + radius * Math.sin(angle) });
  }
  return pts;
}

// Closed island filling the wedge between two merge flanks, closed at the far
// end by `noseArc` (interior points bridging flankA's end to flankB's start).
//   flankA : fork -> nose boundary polyline (e.g. entry inner edge)
//   flankB : nose -> fork boundary polyline (e.g. exit inner edge)
// Real islands never taper to a needle at the fork: the body starts where the
// flanks separate by `minCapWidth` and the fork end is closed with a rounded
// cap. Returns [] when the wedge never widens that far.
export function channelizationIsland({
  flankA, flankB, noseArc = [], minCapWidth = 1.6, capSegments = 8,
}) {
  if (!flankA || flankA.length < 2 || !flankB || flankB.length < 2) return [];
  const forkToNoseB = [...flankB].reverse();
  const capA = capPointFromFork(flankA, forkToNoseB, minCapWidth);
  const capB = capPointFromFork(forkToNoseB, flankA, minCapWidth);
  if (!capA || !capB) return [];
  const trimmedA = capA.index === 0
    ? flankA.slice()
    : [capA.point, ...flankA.slice(capA.index)];
  const trimmedBRaw = capB.index === 0
    ? forkToNoseB.slice()
    : [capB.point, ...forkToNoseB.slice(capB.index)];
  if (trimmedA.length < 2 || trimmedBRaw.length < 2) return [];
  const noseMid = noseArc.length
    ? noseArc[Math.floor(noseArc.length / 2)]
    : { x: (trimmedA.at(-1).x + trimmedBRaw.at(-1).x) / 2, y: (trimmedA.at(-1).y + trimmedBRaw.at(-1).y) / 2 };
  const capArc = roundedCap(capB.point, capA.point, noseMid, capSegments);
  if (!capArc) return [];
  return [...capArc, ...trimmedA, ...noseArc, ...trimmedBRaw.reverse()];
}

// ---------------------------------------------------------------------------
// 5. Yield markings at the merge mouth
// ---------------------------------------------------------------------------

// Dashed give-way line across the branch at `seamDistance` along `centerline`,
// spanning the full bundle width, plus a small give-way triangle beside the
// branch just before the line, apex pointing back at the conflict point.
// `clampPoint` optionally projects each line end (used to keep the marks clear
// of a circular carriageway).
export function mergeYieldMarks({
  centerline, seamDistance, halfWidth,
  dashLen = 0.9, gapLen = 0.7,
  triangleBack = null, triangleOut = 1.05, triangleHalf = 0.42, triangleApex = 0.85,
  clampPoint = null,
}) {
  const pose = pointAndTangentAtDistance(centerline, Math.max(1, seamDistance));
  if (!pose) return { dashes: [], legs: [] };
  const rightN = { x: pose.tangent.y, y: -pose.tangent.x };
  const clamp = clampPoint ?? ((p) => p);
  const dashes = buildDashedSegments([
    clamp(add(pose.point, scl(rightN, halfWidth))),
    clamp(add(pose.point, scl(rightN, -halfWidth))),
  ], dashLen, gapLen);
  const legs = [];
  const back = triangleBack ?? halfWidth + triangleOut + 0.35;
  const triPose = pointAndTangentAtDistance(centerline, Math.max(1, seamDistance - back));
  if (triPose) {
    const t = triPose.tangent;
    const right = { x: t.y, y: -t.x };
    const centre = add(triPose.point, scl(right, halfWidth + triangleOut));
    const apex = add(centre, scl(right, -triangleApex));
    const b1 = add(centre, scl(t, triangleHalf));
    const b2 = add(centre, scl(t, -triangleHalf));
    legs.push([b1, b2], [b1, apex], [b2, apex]);
  }
  return { dashes, legs };
}
