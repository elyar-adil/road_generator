import { describe, expect, it } from 'vitest';
import {
  annulusSectorQuads,
  circlePolygon,
  computeRoundaboutLayout,
  splitterIsland,
  teardropPolygon,
} from './roundabout.js';
import { distance, pointInRing } from './geometry.js';

describe('roundabout layout', () => {
  const arms = [
    { laneIn: 2, laneOut: 2 },
    { laneIn: 3, laneOut: 2 },
  ];

  it('derives the inscribed radius from the core-size knob', () => {
    expect(computeRoundaboutLayout({ arms, laneWidth: 3.25, intersectionSize: 36 }).inscribedR).toBe(18);
    // Never below a driveable minimum.
    expect(computeRoundaboutLayout({ arms, laneWidth: 3.25, intersectionSize: 10 }).inscribedR).toBe(12);
  });

  it('sizes the circulating width from the widest bundle and clamps it', () => {
    const wide = computeRoundaboutLayout({ arms: [{ laneIn: 6, laneOut: 6 }], laneWidth: 4.2, intersectionSize: 60 });
    expect(wide.circWidth).toBe(10);
    expect(wide.islandR).toBe(20);

    const narrow = computeRoundaboutLayout({ arms: [{ laneIn: 1, laneOut: 1 }], laneWidth: 2.6, intersectionSize: 30 });
    expect(narrow.circWidth).toBeCloseTo(5.5, 9);
  });

  it('keeps the central island at least minimally planted', () => {
    const tiny = computeRoundaboutLayout({
      arms: [{ laneIn: 6, laneOut: 6 }], laneWidth: 4.2, intersectionSize: 24,
    });
    expect(tiny.islandR).toBeGreaterThanOrEqual(4);
  });
});

describe('roundabout polygons', () => {
  const C = { x: 3, y: -2 };

  it('closes circle polygons on the centre', () => {
    const ring = circlePolygon(C, 8, 24);
    expect(ring).toHaveLength(24);
    for (const p of ring) expect(distance(p, C)).toBeCloseTo(8, 9);
    expect(pointInRing({ x: C.x + 1, y: C.y }, ring)).toBe(true);
    expect(pointInRing({ x: C.x + 9, y: C.y }, ring)).toBe(false);
  });

  it('emits annulus sectors that tile the ring without gaps', () => {
    const quads = annulusSectorQuads(C, 6, 12, 16);
    expect(quads).toHaveLength(16);
    for (const quad of quads) {
      expect(quad).toHaveLength(4);
      for (const p of quad) {
        const r = distance(p, C);
        expect(r).toBeGreaterThanOrEqual(6 - 1e-9);
        expect(r).toBeLessThanOrEqual(12 + 1e-9);
      }
      // Convex quads: consistent winding via signed-area crosses.
      const [a, b, c, d] = quad;
      const cross2 = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
      const signs = [
        Math.sign(cross2(a, b, c)),
        Math.sign(cross2(b, c, d)),
        Math.sign(cross2(c, d, a)),
        Math.sign(cross2(d, a, b)),
      ];
      expect(new Set(signs).size).toBe(1);
    }
    // Mid-wall point belongs to some sector; the polygon union covers it.
    const midWall = { x: C.x + 9, y: C.y };
    expect(quads.some((quad) => pointInRing(midWall, quad))).toBe(true);
    // Holes stay empty.
    expect(quads.some((quad) => pointInRing({ x: C.x, y: C.y }, quad))).toBe(false);
  });

  it('builds teardrop islands: blunt nose, full body, rounded outer end', () => {
    const W = 2;
    const lens = teardropPolygon({ x: 0, y: 0 }, { x: 10, y: 0 }, W, { segments: 40 });
    // Closed, symmetric about the axis.
    const n = lens.length;
    for (let i = 0; i < n; i += 1) {
      const p = lens[i], q = lens[n - 1 - i];
      expect(p.x).toBeCloseTo(q.x, 9);
      expect(p.y).toBeCloseTo(-q.y, 9);
    }
    const halfAt = (x) => Math.max(...lens.filter((p) => Math.abs(p.x - x) < 0.26).map((p) => Math.abs(p.y)));
    // Nose starts as an exact point...
    expect(lens[0]).toEqual({ x: 0, y: 0 });
    expect(halfAt(0.3)).toBeLessThan(W * 0.35);
    // ...reaches full width in the body...
    expect(halfAt(5)).toBeCloseTo(W / 2, 1);
    // ...and rounds off before the outer end.
    expect(halfAt(9.7)).toBeLessThan(W * 0.5 * 0.8);
  });

  it('places the splitter island on the approach side of the ring only', () => {
    const inscribedR = 18;
    const island = splitterIsland(37, inscribedR, { reach: 9, width: 2 });
    const rad = 37 * Math.PI / 180;
    const axisPoint = (r) => ({ x: r * Math.cos(rad), y: r * Math.sin(rad) });
    // Nose kisses the seam circle; the far cap sits at reach.
    expect(distance(island[0], axisPoint(inscribedR - 0.3))).toBeLessThan(1e-6);
    const radii = island.map((p) => distance(p, { x: 0, y: 0 }));
    expect(Math.min(...radii)).toBeGreaterThanOrEqual(inscribedR - 0.35);
    expect(Math.max(...radii)).toBeLessThanOrEqual(inscribedR + 9 + 1e-9);
    // Never reaches into the circulatory carriageway band.
    const deepest = Math.min(...radii);
    expect(deepest).toBeGreaterThan(inscribedR - 0.4);
  });
});
