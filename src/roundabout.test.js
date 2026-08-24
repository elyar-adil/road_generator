import { describe, expect, it } from 'vitest';
import {
  annulusSectorQuads,
  circlePolygon,
  computeRoundaboutLayout,
  lensPolygon,
  splitterIsland,
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

  it('builds pointed symmetric lens islands', () => {
    const lens = lensPolygon({ x: 0, y: 0 }, { x: 10, y: 0 }, 1.2, 20);
    // Closed, symmetric about the axis, widest in the middle, zero at ends.
    expect(lens[0]).toEqual({ x: 0, y: 0 });
    let maxHalf = 0;
    for (const p of lens) {
      expect(Math.abs(p.y)).toBeLessThanOrEqual(0.61);
      maxHalf = Math.max(maxHalf, Math.abs(p.y));
    }
    expect(maxHalf).toBeCloseTo(0.6, 6);
    // Symmetric about the axis: point i mirrors point (n-1-i).
    const n = lens.length;
    for (let i = 0; i < n; i += 1) {
      const p = lens[i], q = lens[n - 1 - i];
      expect(p.x).toBeCloseTo(q.x, 9);
      expect(p.y).toBeCloseTo(-q.y, 9);
    }
  });

  it('places the splitter island on the arm axis between island and inscribed radii', () => {
    const island = splitterIsland(37, 10, 18, 1.2, 3);
    const rad = 37 * Math.PI / 180;
    const axisPoint = (r) => ({ x: r * Math.cos(rad), y: r * Math.sin(rad) });
    // Both noses sit on the ray.
    expect(distance(island[0], axisPoint(10.5))).toBeLessThan(1e-9);
    const farNose = island.reduce((best, p) => (distance(p, { x: 0, y: 0 }) > distance(best, { x: 0, y: 0 }) ? p : best));
    expect(Math.abs(distance(farNose, { x: 0, y: 0 }) - 21)).toBeLessThan(1e-6);
    // Whole island stays outside the central island.
    for (const p of island) expect(distance(p, { x: 0, y: 0 })).toBeGreaterThan(10);
  });
});
