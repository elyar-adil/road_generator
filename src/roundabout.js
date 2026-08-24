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

const TAU = Math.PI * 2;

export function computeRoundaboutLayout({ arms, laneWidth, intersectionSize }) {
  const inscribedR = Math.max(12, intersectionSize / 2);
  const widestLanes = arms.reduce((max, arm) => Math.max(max, arm.laneIn, arm.laneOut), 1);
  const circWidth = Math.min(10, Math.max(5.5, widestLanes * laneWidth * 1.05));
  const islandR = Math.max(4, inscribedR - circWidth);
  return { inscribedR, circWidth, islandR };
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

// Pointed-both-ends splitter island (lens) between p0 and p1. Width profile
// follows sin(pi·t), so both noses taper to zero - the classic give-way island
// silhouette.
export function lensPolygon(p0, p1, maxWidth, segments = 16) {
  const axis = { x: p1.x - p0.x, y: p1.y - p0.y };
  const length = Math.hypot(axis.x, axis.y) || 1;
  const normal = { x: -axis.y / length, y: axis.x / length };
  const left = [], right = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const half = Math.max(0, Math.sin(Math.PI * t)) * maxWidth / 2;
    const bx = p0.x + axis.x * t, by = p0.y + axis.y * t;
    left.push({ x: bx + normal.x * half, y: by + normal.y * half });
    right.push({ x: bx - normal.x * half, y: by - normal.y * half });
  }
  return left.concat(right.reverse());
}

// Splitter island on an arm's axis, spanning radially from just outside the
// central island to just past the inscribed circle.
export function splitterIsland(angleDeg, islandR, inscribedR, maxWidth = 1.2, reach = 3) {
  const frame = createStraightFrame({ x: 0, y: 0 }, angleDeg);
  return lensPolygon(
    frame.wp(islandR + 0.5, 0),
    frame.wp(inscribedR + reach, 0),
    maxWidth,
  );
}
