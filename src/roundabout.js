// Roundabout (环岛) geometry kernel - pure data, no THREE.
//
// Compact urban layout rules:
//   inscribedR = intersectionSize / 2      (the same 核心尺寸 knob as cross
//                                           nodes keeps the editor coherent)
//   circWidth  = circulating carriageway width, sized from the widest arm
//                bundle and clamped to a sane urban range
//   islandR    = inscribedR - circWidth    (raised central island radius)
//
// Arm conventions carry over from the intersection model: each arm points AWAY
// from the centre (+u), outbound traffic on the +s (left) side, inbound on the
// -s side; a splitter island therefore sits on the arm axis between the two
// directions, playing the role the median plays on straight roads.

import { createStraightFrame } from './frame.js';
import {
  add, scl, sub, len, normalize, offsetPolyline,
} from './geometry.js';

const TAU = Math.PI * 2;

export function computeRoundaboutLayout({ arms, laneWidth, intersectionSize }) {
  const widestLanes = arms.reduce((max, arm) => Math.max(max, arm.laneIn, arm.laneOut), 1);
  const circLanes = Math.max(1, widestLanes);
  const circWidth = circLanes * laneWidth;
  const islandClearance = Math.max(4, laneWidth * 1.25);
  const inscribedR = Math.max(12, intersectionSize / 2, circWidth + islandClearance);
  const islandR = inscribedR - circWidth;
  return { inscribedR, circLanes, circWidth, islandR };
}

// Closed regular polygon (CCW) approximating a circle.
export function circlePolygon(center, radius, segments = 48) {
  const pts = [];
  for (let i = 0; i < segments; i += 1) {
    const a = TAU * i / segments;
    pts.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) });
  }
  return pts;
}

// The circulating carriageway as independent convex sector quads. Emitted as a
// strip instead of one cut ring so the render layer's hole-free triangulator
// stays usable; every quad lands inside [rInner, rOuter].
export function annulusSectorQuads(center, rInner, rOuter, segments = 48) {
  const quads = [];
  for (let i = 0; i < segments; i += 1) {
    const a0 = TAU * i / segments;
    const a1 = TAU * (i + 1) / segments;
    quads.push([
      { x: center.x + rInner * Math.cos(a0), y: center.y + rInner * Math.sin(a0) },
      { x: center.x + rOuter * Math.cos(a0), y: center.y + rOuter * Math.sin(a0) },
      { x: center.x + rOuter * Math.cos(a1), y: center.y + rOuter * Math.sin(a1) },
      { x: center.x + rInner * Math.cos(a1), y: center.y + rInner * Math.sin(a1) },
    ]);
  }
  return quads;
}

export function roundaboutArmSlots(anglesDeg) {
  const angles = anglesDeg.map((angle) => angle * Math.PI / 180);
  return angles.map((theta, index) => {
    let previous = angles[(index - 1 + angles.length) % angles.length];
    let next = angles[(index + 1) % angles.length];
    while (previous >= theta) previous -= TAU;
    while (next <= theta) next += TAU;
    const lowerBisector = (previous + theta) / 2;
    const upperBisector = (theta + next) / 2;
    return {
      lowerBisector,
      upperBisector,
      // The upper gap bisector is shared with the next arm: this arm enters
      // there and the next arm exits there. The lower one is shared with the
      // previous arm in the same way.
      footIn: upperBisector,
      footOut: lowerBisector,
    };
  });
}

// ---------------------------------------------------------------------------
// Approach Y-geometry.
//
// A real approach forks around its splitter island: the outbound branch peels
// off the ring tangentially (exits ride the circle's own direction before
// straightening), the inbound branch curves from the stem onto the ring along
// the tangent too, and the island is simply the wedge the Y leaves against the
// circle. Everything below is pure data consumed by the derivation layer.
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

function tangentCurve(start, startDir, end, endDir, startScale = 0.3, endScale = 0.28) {
  const chord = len(sub(end, start)) || 1;
  const startHandle = chord * startScale;
  const endHandle = chord * endScale;
  return cubicSample(
    start,
    add(start, scl(normalize(startDir), startHandle)),
    add(end, scl(normalize(endDir), -endHandle)),
    end,
  );
}

// Geometry of one forked approach. All lengths in metres, angles in radians.
//   entryPath : stem -> ring, arrives along the circulating tangent
//   exitPath  : ring -> stem, departs along the circulating tangent
//   footIn / footOut : polar angles of the branch mouths
export function roundaboutApproach({
  angleDeg, coreR, laneWidth, laneIn, laneOut, medW = 0, forkReach = 9,
  slotAngle = Math.PI / 4, targetFootIn = null, targetFootOut = null,
}) {
  const theta = angleDeg * Math.PI / 180;
  const frame = createStraightFrame({ x: 0, y: 0 }, angleDeg);
  const widthIn = Math.max(laneWidth, laneIn * laneWidth);
  const widthOut = Math.max(laneWidth, laneOut * laneWidth);
  const halfIn = widthIn / 2;
  const halfOut = widthOut / 2;

  // Fallback for standalone geometry tests. Scene derivation supplies shared
  // adjacent-road bisectors through targetFootIn/targetFootOut.
  const slotOffset = slotAngle / 2;
  const footIn = targetFootIn ?? theta + (laneIn > 0 && laneOut > 0 ? slotOffset : 0);
  const footOut = targetFootOut ?? theta - (laneIn > 0 && laneOut > 0 ? slotOffset : 0);

  const ringPoint = (radius, phi) => ({ x: radius * Math.cos(phi), y: radius * Math.sin(phi) });
  // Both entry and exit bend to the driver's right, which gives CCW circulation
  // in the project's world plane.
  const ringTangent = (phi) => ({ x: -Math.sin(phi), y: Math.cos(phi) });

  const effectiveForkReach = Math.max(forkReach, Math.max(widthIn, widthOut) * 0.7 + 2);
  const forkU = coreR + effectiveForkReach;
  const inward = scl(frame.fwd, -1);
  // Each slot owns a radial target segment exactly one branch-width long. Put
  // the branch centreline through that segment's midpoint and arrive along the
  // circle tangent; a constant half-width offset then lands its outer edge on
  // the outside circle and its inner edge one full road width farther inward.
  const joinRIn = coreR - halfIn;
  const joinROut = coreR - halfOut;
  const entryPath = tangentCurve(
    frame.wp(forkU, medW / 2 + halfIn), inward,
    ringPoint(joinRIn, footIn), ringTangent(footIn),
  );
  const exitPath = tangentCurve(
    ringPoint(joinROut, footOut), ringTangent(footOut),
    frame.wp(forkU, -(medW / 2 + halfOut)), frame.fwd, 0.3, 0.3,
  );
  const entryOffsets = offsetPolyline(entryPath, halfIn);
  const exitOffsets = offsetPolyline(exitPath, halfOut);
  // A constant-distance offset of a curved approach wraps slightly around the
  // ring: near the seam the edge normals still carry an angular component, so
  // the outer edge overshoots the slot angle by a few tenths of a degree and
  // folds back, reversing the final segment against the circulating tangent.
  // Fix inside the offset model: drop the overshot tail and blend both edges
  // along concentric arcs onto their radial mouths. The two edges always share
  // one cutoff index and one arc-angle list, so index-aligned consumers keep
  // exact branch widths everywhere.
  const polarAngle = (point) => Math.atan2(point.y, point.x);
  const angleDelta = (point, base) => {
    const delta = polarAngle(point) - base;
    return delta - Math.round(delta / TAU) * TAU;
  };
  const SEAM_ARC_POINTS = 6;
  const blendEntryToSeam = (offsets, joinRadii, footAngle) => {
    const cuts = offsets.map((points) => {
      for (let index = points.length - 1; index >= 0; index -= 1) {
        if (angleDelta(points[index], footAngle) <= 1e-9) return index;
      }
      return points.length - 2;
    });
    const cut = Math.max(2, Math.min(...cuts));
    const delta0 = Math.min(0, ...offsets.map((points) => angleDelta(points[cut], footAngle)));
    const tails = joinRadii.map((radius) => Array.from({ length: SEAM_ARC_POINTS }, (_, step) => {
      const delta = delta0 * (1 - (step + 1) / SEAM_ARC_POINTS);
      const angle = footAngle + delta;
      return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
    }));
    return offsets.map((points, edge) => [...points.slice(0, cut + 1), ...tails[edge]]);
  };
  const blendExitFromSeam = (offsets, joinRadii, footAngle) => {
    const cuts = offsets.map((points) => {
      const index = points.findIndex((point) => angleDelta(point, footAngle) >= -1e-9);
      return index < 0 ? points.length - 2 : index;
    });
    const limit = Math.min(...offsets.map((points) => points.length)) - 3;
    const cut = Math.min(limit, Math.max(...cuts));
    const delta0 = Math.max(0, ...offsets.map((points) => angleDelta(points[cut], footAngle)));
    const heads = joinRadii.map((radius) => Array.from({ length: SEAM_ARC_POINTS }, (_, step) => {
      const delta = delta0 * step / SEAM_ARC_POINTS;
      const angle = footAngle + delta;
      return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
    }));
    return offsets.map((points, edge) => [...heads[edge], ...points.slice(cut)]);
  };
  const [entryInner, entryOuter] = blendEntryToSeam(
    [entryOffsets.left, entryOffsets.right],
    [coreR - widthIn, coreR], footIn,
  );
  const [exitInner, exitOuter] = blendExitFromSeam(
    [exitOffsets.left, exitOffsets.right],
    [coreR - widthOut, coreR], footOut,
  );
  const entryLast = entryOuter.length - 1;
  const entryOuterTarget = ringPoint(coreR, footIn);
  const entryInnerTarget = ringPoint(coreR - widthIn, footIn);
  entryOuter[entryLast] = entryOuterTarget;
  entryInner[entryLast] = entryInnerTarget;
  const exitOuterTarget = ringPoint(coreR, footOut);
  const exitInnerTarget = ringPoint(coreR - widthOut, footOut);
  exitOuter[0] = exitOuterTarget;
  exitInner[0] = exitInnerTarget;
  const entryRing = entryOuter.concat(entryInner.slice().reverse());
  const exitRing = exitOuter.concat(exitInner.slice().reverse());
  const entryOuterFoot = Math.atan2(entryOuter.at(-1).y, entryOuter.at(-1).x);
  const exitOuterFoot = Math.atan2(exitOuter[0].y, exitOuter[0].x);

  return {
    theta, frame, forkU, halfIn, halfOut,
    entryPath, exitPath, entryInner, entryOuter, exitInner, exitOuter,
    entrySurface: { outer: entryOuter, inner: entryInner, strips: [entryOuter, entryInner], ring: entryRing },
    exitSurface: { outer: exitOuter, inner: exitInner, strips: [exitOuter, exitInner], ring: exitRing },
    footIn, footOut, entryOuterFoot, exitOuterFoot, slotAngle, joinRIn, joinROut,
    ringTangentAtFootIn: ringTangent(footIn),
  };
}

function segmentRadiusIntersection(a, b, radius) {
  const delta = sub(b, a);
  const aa = delta.x * delta.x + delta.y * delta.y;
  const bb = 2 * (a.x * delta.x + a.y * delta.y);
  const cc = a.x * a.x + a.y * a.y - radius * radius;
  const root = Math.sqrt(Math.max(0, bb * bb - 4 * aa * cc));
  const candidates = [(-bb - root) / (2 * aa), (-bb + root) / (2 * aa)];
  const t = candidates.find((value) => value >= -1e-8 && value <= 1 + 1e-8) ?? 0.5;
  return add(a, scl(delta, Math.max(0, Math.min(1, t))));
}

function pathPrefixOutsideRadius(path, radius) {
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

function pathSuffixOutsideRadius(path, radius) {
  if (!path.length) return [];
  for (let index = 1; index < path.length; index += 1) {
    if (len(path[index - 1]) < radius && len(path[index]) >= radius) {
      return [segmentRadiusIntersection(path[index - 1], path[index], radius), ...path.slice(index)];
    }
  }
  return path.slice();
}

// Splitter island filling the wedge between the Y branches and the ring.
// Flanks follow the branch inner edges from the fork cap down to where they
// cross the outer circle, then a ring arc closes the bottom — zero self-
// intersections guaranteed because no flank edge ever goes inside coreR.
export function forkIslandPolygon({ entryInner, exitInner, coreR, theta = 0, forkU = null, medW = 0 }) {
  if (!entryInner?.length || !exitInner?.length) return [];
  const entryFlank = pathPrefixOutsideRadius(entryInner, coreR);
  const exitFlank = pathSuffixOutsideRadius(exitInner, coreR);
  const entryCrossAngle = Math.atan2(entryFlank.at(-1).y, entryFlank.at(-1).x);
  const exitCrossAngle = Math.atan2(exitFlank[0].y, exitFlank[0].x);
  let sweep = exitCrossAngle - entryCrossAngle;
  while (sweep > Math.PI) sweep -= TAU;
  while (sweep <= -Math.PI) sweep += TAU;
  const steps = Math.max(2, Math.ceil(Math.abs(sweep) / (2 * Math.PI / 180)));
  const ringArc = Array.from({ length: steps + 1 }, (_, index) => {
    const angle = entryCrossAngle + sweep * index / steps;
    return { x: coreR * Math.cos(angle), y: coreR * Math.sin(angle) };
  });
  return [
    ...entryFlank,
    ...ringArc.slice(1, -1),
    ...exitFlank,
  ];
}
