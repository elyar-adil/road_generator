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
  add, scl, sub, len, normalize, dot,
  lineIntersect, EPSILON,
} from './geometry.js';

const TAU = Math.PI * 2;

export function computeRoundaboutLayout({ arms, laneWidth, intersectionSize }) {
  const inscribedR = Math.max(12, intersectionSize / 2);
  // The circulating carriageway is a real multi-lane road: its lane count
  // matches the busiest approach's one-way bundle (clamped to sane rotaries).
  const widestLanes = arms.reduce((max, arm) => Math.max(max, arm.laneIn, arm.laneOut), 1);
  const circLanes = Math.min(3, Math.max(1, widestLanes));
  const circWidth = Math.max(laneWidth * 1.15, circLanes * laneWidth);
  const islandR = Math.max(4, inscribedR - circWidth);
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

// ---------------------------------------------------------------------------
// Approach Y-geometry.
//
// A real approach forks around its splitter island: the outbound branch peels
// off the ring tangentially (exits ride the circle's own direction before
// straightening), the inbound branch curves from the stem onto the ring along
// the tangent too, and the island is simply the wedge the Y leaves against the
// circle. Everything below is pure data consumed by the derivation layer.
// ---------------------------------------------------------------------------

function cubicSample(p0, c1, c2, p3, segments = 26) {
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

// Branch centreline: straight run colinear with the stem, one constant-radius
// arc, straight lead-out arriving EXACTLY along the ring tangent. Among the
// two tangent-continuous solutions we keep only the one whose arc centre sits
// on the same side of the chord as `hugPoint` - the small corner arc hugging
// the island, never the giant detour loop around the far quadrant.
function hugArc(start, u, end, v, r, hugPoint, segN = 26) {
  const un = normalize(u), vn = normalize(v);
  const nu = { x: -un.y, y: un.x }, nv = { x: -vn.y, y: vn.x };
  const c1 = add(start, scl(nu, r));
  const c2 = sub(end, scl(nv, r));
  const C = lineIntersect(c1, add(c1, un), c2, add(c2, vn));
  if (!C) return null;
  // Tangency must sit ahead on the entry run and behind on the exit run.
  if (dot(sub(C, start), un) <= EPSILON || dot(sub(C, end), vn) >= -EPSILON) return null;
  const t1 = sub(C, scl(nu, r));
  const t2 = sub(C, scl(nv, r));
  const chord = sub(end, start);
  const side = (p) => Math.sign(chord.x * (p.y - start.y) - chord.y * (p.x - start.x));
  const centreSide = side(C);
  if (centreSide === 0 || centreSide !== side(hugPoint)) return null;

  let sweep = Math.atan2(t2.y - C.y, t2.x - C.x) - Math.atan2(t1.y - C.y, t1.x - C.x);
  while (sweep > Math.PI) sweep -= Math.PI * 2;
  while (sweep < -Math.PI) sweep += Math.PI * 2;

  const path = [{ ...start }, { ...t1 }];
  for (let i = 1; i < segN; i += 1) {
    const a = Math.atan2(t1.y - C.y, t1.x - C.x) + sweep * i / segN;
    path.push({ x: C.x + r * Math.cos(a), y: C.y + r * Math.sin(a) });
  }
  path.push({ ...t2 }, { ...end });
  return path;
}

function flarePath(start, startDir, end, endDir, halfWidth, hugPoint) {
  for (const r of [halfWidth * 2.4 + 5, halfWidth * 1.6 + 4, halfWidth + 3, Math.max(4, halfWidth)]) {
    const path = hugArc(start, startDir, end, endDir, r, hugPoint);
    if (path && path.length >= 8) return path;
  }
  // Last resort: gentle Bezier (rare; only for extreme geometries).
  const chord = len(sub(end, start)) || 1;
  const handle = chord * 0.45;
  return cubicSample(
    start,
    add(start, scl(normalize(startDir), handle)),
    add(end, scl(normalize(endDir), -handle)),
    end,
  );
}

// Geometry of one forked approach. All lengths in metres, angles in radians.
//   entryPath : stem -> ring, arrives along the CCW ring tangent
//   exitPath  : ring -> stem, departs along the CCW ring tangent
//   footIn / footOut : polar angles where the branches meet the seam circle
export function roundaboutApproach({ angleDeg, coreR, laneWidth, laneIn, laneOut, medW = 0, forkReach = 9 }) {
  const theta = angleDeg * Math.PI / 180;
  const frame = createStraightFrame({ x: 0, y: 0 }, angleDeg);
  const halfIn = Math.max(laneWidth, laneIn * laneWidth) / 2;
  const halfOut = Math.max(laneWidth, laneOut * laneWidth) / 2;

  // Foot angular offsets keep the branch's outer edge clear of the island nose.
  const deltaIn = Math.asin(Math.min(0.6, (halfIn + 1.1) / coreR));
  const deltaOut = Math.asin(Math.min(0.6, (halfOut + 1.1) / coreR));
  const footIn = theta - deltaIn;   // inbound side = clockwise of the axis
  const footOut = theta + deltaOut; // outbound side = counter-clockwise

  const ringPoint = (phi) => ({ x: coreR * Math.cos(phi), y: coreR * Math.sin(phi) });
  // CCW circulation tangent at polar angle phi.
  const ringTangent = (phi) => ({ x: -Math.sin(phi), y: Math.cos(phi) });

  const forkU = coreR + forkReach;
  const sIn = -(medW / 2 + halfIn);
  const sOut = medW / 2 + halfOut;

  const startIn = frame.wp(forkU, sIn);
  const endIn = ringPoint(footIn);
  // Hug point = where the axis meets the ring: the arc must stay on the island
  // side of its chord, giving the compact corner flare of a real Y fork.
  const hugPoint = ringPoint(theta);
  const entryPath = flarePath(startIn, scl(frame.fwd, -1), endIn, ringTangent(footIn), halfIn, hugPoint);

  const startOut = ringPoint(footOut);
  const endOut = frame.wp(forkU, sOut);
  const exitPath = flarePath(endOut, frame.fwd, startOut, ringTangent(footOut), halfOut, hugPoint);
  exitPath.reverse(); // store ring -> fork so both paths read outward-in

  return {
    theta, frame, forkU, halfIn, halfOut,
    entryPath, exitPath, footIn, footOut,
    ringTangentAtFootIn: ringTangent(footIn),
  };
}

// Wedge region the forked Y leaves against the seam circle: walked as
// entry-inner-edge (fork -> ring), seam arc (footIn -> footOut, CCW under the
// axis), exit-inner-edge (ring -> fork); the closure edge forms the blunt
// fork-end cap automatically.
export function forkIslandPolygon({ entryInner, exitInner, coreR, footIn, footOut, seamGrid }) {
  const step = TAU / seamGrid.length;
  const i0 = Math.ceil((footIn + 1e-9) / step);
  const i1 = Math.floor((footOut - 1e-9) / step);
  const arc = [];
  for (let k = i0; k <= i1; k += 1) {
    arc.push(seamGrid[((k % seamGrid.length) + seamGrid.length) % seamGrid.length]);
  }
  return [...entryInner, ...arc, ...exitInner];
}
