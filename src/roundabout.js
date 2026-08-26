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
  add, scl, offsetPolyline,
} from './geometry.js';
import {
  tangentBlend,
  blendEdgesToSeam, blendEdgesFromSeam,
  pathPrefixOutsideRadius, pathSuffixOutsideRadius,
  channelizationIsland,
} from './graft.js';

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
// circle. Both branches are grafts (see graft.js): a tangent blend from the
// stem onto the circulating flow, seam-blended onto a radial mouth. Everything
// below is pure data consumed by the derivation layer.
// ---------------------------------------------------------------------------

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
  const entryPath = tangentBlend(
    frame.wp(forkU, medW / 2 + halfIn), inward,
    ringPoint(joinRIn, footIn), ringTangent(footIn),
  );
  const exitPath = tangentBlend(
    ringPoint(joinROut, footOut), ringTangent(footOut),
    frame.wp(forkU, -(medW / 2 + halfOut)), frame.fwd,
    { startScale: 0.3, endScale: 0.3 },
  );
  const entryOffsets = offsetPolyline(entryPath, halfIn);
  const exitOffsets = offsetPolyline(exitPath, halfOut);
  const [entryInner, entryOuter] = blendEdgesToSeam(
    [entryOffsets.left, entryOffsets.right],
    [coreR - widthIn, coreR], footIn,
  );
  const [exitInner, exitOuter] = blendEdgesFromSeam(
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

// Splitter island filling the wedge between the Y branches and the ring.
// Flanks follow the branch inner edges from the fork down to where they cross
// the outer circle, a ring arc closes the nose, and the graft kernel's
// channelization island trims the fork end to a rounded cap so wide entries on
// small rings never render as needle slivers.
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
  const noseArc = Array.from({ length: steps + 1 }, (_, index) => {
    const angle = entryCrossAngle + sweep * index / steps;
    return { x: coreR * Math.cos(angle), y: coreR * Math.sin(angle) };
  });
  return channelizationIsland({
    flankA: entryFlank,
    flankB: exitFlank,
    noseArc: noseArc.slice(1, -1),
    // With a stem median the island caps at the median width so the two chain
    // seamlessly; a bare fork needs a real island body (1.6m) or none at all.
    minCapWidth: medW > 0 ? medW : 1.6,
  });
}
