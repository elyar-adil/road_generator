// Reusable road-segment primitives.
//
// A road in the general sense (an intersection arm today, a highway stretch or
// interchange ramp later) is a centreline polyline carrying a bundle of lanes.
// This module exposes the cross-section and longitudinal helpers that any such
// segment needs: lane-lateral geometry, a diverge/merge taper where a lane peels
// off or joins, sidewalk edge boundaries, and street-light placement. These are
// pure functions over polylines so they compose into arbitrary road networks
// (diverge -> ramp -> merge -> interchange).

import {
  add, scl, leftNormal,
  polylineLength, pointAndTangentAtDistance, offsetPolyline, buildDashedSegments,
} from './geometry.js';

// Cross-section of a two-way carriageway, mirroring the intersection arm model:
// inbound traffic on the right (-left) side, outbound on the left (+left) side.
// Returns the median half-width actually reserved and the outer lateral bounds.
export function laneBundleBounds(laneIn, laneOut, laneWidth, medianWidth = 0) {
  const medW = laneIn > 0 && laneOut > 0 ? Math.max(0, medianWidth) : 0;
  const inOuterS = medW / 2 + laneOut * laneWidth;
  const outOuterS = -(medW / 2 + laneIn * laneWidth);
  return { medW, inOuterS, outOuterS };
}

// Lateral coordinate of the centre of an inbound lane (median-side = index 0).
export function inboundLaneCentre(medW, laneWidth, index) {
  return -(medW / 2 + (index + 0.5) * laneWidth);
}

// Lateral coordinate of the centre of an outbound lane (median-side = index 0).
export function outboundLaneCentre(medW, laneWidth, index) {
  return medW / 2 + (index + 0.5) * laneWidth;
}

// Straight widening/taper for a lane group that peels off (diverge) or joins
// (merge) a carriageway.
//
//   origin: {point, fwd, left, s} base frame (s is positive in the +left dir)
//   laneWidth, splitLanes: how many lanes are leaving the bundle (side sign)
//   taperStart, taperEnd: longitudinal stations of the taper along `fwd`
//   side: +1 splits off the +left side, -1 the +right side
//
// Returns the wedge polygon { outer, inner } and the split-bundle centreline
// placed at the +side edge of the remaining carriageway.
export function buildLaneTaper({
  origin, laneWidth, splitLanes, taperStart, taperEnd, side = 1,
}) {
  const { point, fwd, left } = origin;
  const splitWidth = splitLanes * laneWidth;
  const stations = Math.max(2, Math.round((taperEnd - taperStart) / 0.5));
  const mu = (i) => taperStart + (taperEnd - taperStart) * (i / stations);
  const outer = [], inner = [];
  // Coupled boundary: one edge follows the existing carriageway edge line, the
  // other feathers from zero width at the taper start to full split width at
  // the taper end, so the split lane peels off as a widening wedge.
  for (let i = 0; i <= stations; i += 1) {
    const p = add(point, scl(fwd, mu(i)));
    const growth = i / stations;
    outer.push(add(p, scl(left, side * splitWidth * growth)));
    inner.push(add(p, scl(left, 0)));
  }
  // Split-bundle centreline: lands `splitWidth/2` to the +side of the base edge.
  const s = side * (splitWidth / 2);
  const centreline = [];
  for (let i = 0; i <= stations; i += 1) {
    const p = add(point, scl(fwd, mu(i)));
    centreline.push(add(p, scl(left, s)));
  }
  return { outer, inner, centreline, stations, splitWidth };
}

// Builds a straight carriageway surface polygon (outer + inner boundary) given
// a centreline, half width, and optional start/end taper overrides. Returns a
// ring suitable for triangulation (outer then reversed inner).
export function buildSegmentSurface(centreline, halfWidth) {
  const { left, right } = offsetPolyline(centreline, halfWidth);
  return { outer: left, inner: right, ring: left.concat(right.slice().reverse()) };
}

// Sidewalk edges: both boundaries of a sidewalk strip laid just beyond a
// carriageway edge line. `center` is the road centreline whose left/right edges
// sit at `roadHalfWidth` ± `gap`.
export function buildSidewalkBounds(centreline, roadHalfWidth, sidewalkWidth, gap = 0.25) {
  const innerLeft = offsetPolyline(centreline, roadHalfWidth + gap).left;
  const innerRight = offsetPolyline(centreline, -(roadHalfWidth + gap)).right;
  const outerLeft = offsetPolyline(centreline, roadHalfWidth + gap + sidewalkWidth).left;
  const outerRight = offsetPolyline(centreline, -(roadHalfWidth + gap + sidewalkWidth)).right;
  return {
    left: { inner: innerLeft, outer: outerLeft },
    right: { inner: innerRight, outer: outerRight },
  };
}

// Street-light pole positions along a centreline at a fixed lateral offset.
// Returns [{ point, tangent, u }] so poles/lanterns can be oriented along the
// road. `spacing` is approximate; starts at `start`, stops before `end`.
export function placeStreetLights(centreline, {
  spacing = 24, start = 8, end = Infinity, lateral = 0.5,
}) {
  const total = polylineLength(centreline);
  const stop = Math.min(total, end);
  const result = [];
  let u = start;
  while (u < stop) {
    const pose = pointAndTangentAtDistance(centreline, u);
    if (!pose) break;
    const normal = leftNormal(pose.tangent);
    result.push({
      point: add(pose.point, scl(normal, lateral)),
      tangent: pose.tangent,
      u,
    });
    u += spacing;
  }
  return result;
}

// Dashed lane-divider markings along the length of a segment, returning array
// of [p0, p1] dash segments for the given lateral offset(s).
export function segmentDividers(centreline, lateralOffsets, { dashLen = 2.6, gapLen = 2.2 } = {}) {
  const dividers = [];
  lateralOffsets.forEach((offset) => {
    const offsetPath = offsetPolyline(centreline, offset).left;
    buildDashedSegments(offsetPath, dashLen, gapLen).forEach(([p0, p1]) => dividers.push([p0, p1]));
  });
  return dividers;
}