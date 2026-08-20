import { describe, expect, it } from 'vitest';
import {
  buildLaneTaper,
  buildSegmentSurface,
  buildSidewalkBounds,
  inboundLaneCentre,
  laneBundleBounds,
  outboundLaneCentre,
  placeStreetLights,
  segmentDividers,
} from './segment.js';
import { polylineLength } from './geometry.js';

// A straight origin frame heading +x.
const straight = {
  point: { x: 0, y: 0 },
  fwd: { x: 1, y: 0 },
  left: { x: 0, y: 1 },
};
const straightCentre = (len = 60) => Array.from({ length: len + 1 }, (_, i) => ({ x: i, y: 0 }));

describe('road segment primitives', () => {
  it('computes a two-way cross-section with median', () => {
    const b = laneBundleBounds(2, 3, 3.25, 1.2);
    expect(b.medW).toBe(1.2);
    // inbound outer = med/2 + laneOut * w
    expect(b.inOuterS).toBeCloseTo(0.6 + 9.75, 6);
    expect(b.outOuterS).toBeCloseTo(-(0.6 + 6.5), 6);
  });

  it('reserves no median when only one direction has lanes', () => {
    expect(laneBundleBounds(2, 0, 3.25, 1.5).medW).toBe(0);
  });

  it('centres inbound lanes on the right and outbound lanes on the left', () => {
    expect(inboundLaneCentre(0, 3.25, 0)).toBeCloseTo(-1.625, 6);
    expect(outboundLaneCentre(0, 3.25, 0)).toBeCloseTo(1.625, 6);
  });

  it('builds a diverge taper that feathers from zero to full split width', () => {
    const taper = buildLaneTaper({
      origin: straight, laneWidth: 3.25, splitLanes: 1,
      taperStart: 20, taperEnd: 34, side: 1,
    });
    expect(taper.splitWidth).toBeCloseTo(3.25, 6);
    // Inner edge stays on the base line (s=0).
    expect(taper.inner[0].x).toBeCloseTo(20, 6);
    expect(taper.inner[0].y).toBeCloseTo(0, 6);
    // Outer edge reaches full split width at the taper end.
    expect(taper.outer[0].y).toBeCloseTo(0, 6);
    expect(taper.outer.at(-1).y).toBeCloseTo(3.25, 6);
    // Split centreline sits at half the split width.
    expect(taper.centreline.at(-1).y).toBeCloseTo(1.625, 6);
  });

  it('builds a surface ring suitable for triangulation', () => {
    const { outer, inner, ring } = buildSegmentSurface(straightCentre(10), 6);
    expect(outer.length).toBe(inner.length);
    expect(ring.length).toBe(outer.length + inner.length);
    // outer is all +left, inner all -left relative to centreline
    expect(outer.every((p) => p.y > 0)).toBe(true);
    expect(inner.every((p) => p.y < 0)).toBe(true);
  });

  it('lays sidewalk bounds outside the carriageway', () => {
    const sw = buildSidewalkBounds(straightCentre(10), 6, 2.4, 0.25);
    // inner-left is inset from the road edge; outer-left further out.
    expect(sw.left.outer[0].y).toBeGreaterThan(sw.left.inner[0].y);
    // gap + sidewalk width off the road edge (half width 6 + gap .25 + width 2.4)
    expect(sw.left.outer[0].y).toBeCloseTo(6 + 0.25 + 2.4, 6);
  });

  it('places street lights at even spacing along a centreline', () => {
    const lights = placeStreetLights(straightCentre(60), { spacing: 20, start: 10, lateral: 1.5 });
    expect(lights.length).toBeGreaterThanOrEqual(2);
    expect(lights.every((l) => Math.abs(l.tangent.x - 1) < 1e-6)).toBe(true);
    // lateral offset to the +left
    expect(lights[0].point.y).toBeCloseTo(1.5, 6);
    expect(lights[1].u - lights[0].u).toBeCloseTo(20, 6);
  });

  it('emits dashed dividers with a fixed cadence', () => {
    const dividers = segmentDividers(straightCentre(20), [0], { dashLen: 1, gapLen: 1 });
    expect(dividers.length).toBeGreaterThan(5);
    dividers.forEach(([p0, p1]) => {
      expect(p1.x - p0.x).toBeCloseTo(1, 5);
    });
  });

  it('produces finite-energy results for curved inputs', () => {
    const curve = Array.from({ length: 21 }, (_, i) => ({ x: i, y: Math.sin(i / 5) }));
    const taper = buildLaneTaper({
      origin: { point: curve[0], fwd: { x: 1, y: 0 }, left: { x: 0, y: 1 } },
      laneWidth: 3.25, splitLanes: 2, taperStart: 10, taperEnd: 30,
    });
    expect(taper.outer.length).toBeGreaterThan(10);
    expect(taper.centreline.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });
});