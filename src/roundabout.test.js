import { describe, expect, it } from 'vitest';
import {
  annulusSectorQuads,
  circlePolygon,
  computeRoundaboutLayout,
  forkIslandPolygon,
  roundaboutApproach,
} from './roundabout.js';
import { distance, len, sub, pointInRing } from './geometry.js';

describe('roundabout layout', () => {
  it('derives the inscribed radius from the core-size knob', () => {
    const arms = [{ laneIn: 2, laneOut: 2 }, { laneIn: 3, laneOut: 2 }];
    expect(computeRoundaboutLayout({ arms, laneWidth: 3.25, intersectionSize: 36 }).inscribedR).toBe(18);
    expect(computeRoundaboutLayout({ arms, laneWidth: 3.25, intersectionSize: 10 }).inscribedR).toBe(12);
  });

  it('scales the ring to real circulating lanes', () => {
    const wide = computeRoundaboutLayout({
      arms: [{ laneIn: 6, laneOut: 6 }], laneWidth: 4.2, intersectionSize: 60,
    });
    expect(wide.circLanes).toBe(3);
    expect(wide.circWidth).toBeCloseTo(12.6, 9);

    const narrow = computeRoundaboutLayout({
      arms: [{ laneIn: 1, laneOut: 1 }], laneWidth: 2.6, intersectionSize: 30,
    });
    expect(narrow.circLanes).toBe(1);
    expect(narrow.circWidth).toBeCloseTo(2.99, 9);
  });

  it('keeps the central island at least minimally planted', () => {
    const tiny = computeRoundaboutLayout({
      arms: [{ laneIn: 6, laneOut: 6 }], laneWidth: 4.2, intersectionSize: 24,
    });
    expect(tiny.islandR).toBeGreaterThanOrEqual(4);
  });
});

describe('approach Y-geometry', () => {
  const coreR = 18;
  const ap = roundaboutApproach({ angleDeg: 0, coreR, laneWidth: 3.25, laneIn: 2, laneOut: 2, medW: 0 });

  it('lands both branches exactly on the seam circle', () => {
    const lastEntry = ap.entryPath.at(-1);
    const firstExit = ap.exitPath[0];
    for (const p of [lastEntry, firstExit]) {
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(coreR, 6);
    }
  });

  it('arrives and departs along the CCW ring tangent (smooth merge/diverge)', () => {
    const tangentAt = (phi) => ({ x: -Math.sin(phi), y: Math.cos(phi) });
    const dir = (a, b) => { const d = sub(b, a); return { x: d.x / len(d), y: d.y / len(d) }; };
    // exitPath is stored ring->fork, so its first chord leaves along -tangent.
    const entryEndDir = dir(ap.entryPath.at(-2), ap.entryPath.at(-1));
    const exitStartDir = dir(ap.exitPath[0], ap.exitPath[1]);
    const tIn = tangentAt(ap.footIn), tOut = tangentAt(ap.footOut);
    expect(Math.abs(entryEndDir.x * tIn.x + entryEndDir.y * tIn.y)).toBeGreaterThan(0.99);
    expect(Math.abs(exitStartDir.x * tOut.x + exitStartDir.y * tOut.y)).toBeGreaterThan(0.99);
  });

  it('puts entry clockwise of the axis and exit counter-clockwise', () => {
    expect(ap.footIn).toBeLessThan(ap.theta);
    expect(ap.footOut).toBeGreaterThan(ap.theta);
    expect(ap.forkU).toBe(coreR + 9);
  });

  it('builds a closed island wedge between the Y and the seam arc', () => {
    const seamGrid = circlePolygon({ x: 0, y: 0 }, coreR, 64);
    const poly = forkIslandPolygon({
      entryInner: ap.entryPath.map((p) => ({ ...p })),
      exitInner: ap.exitPath.map((p) => ({ ...p })),
      coreR,
      footIn: ap.footIn,
      footOut: ap.footOut,
      seamGrid,
    });
    // A point on the axis just outside the ring sits inside the wedge.
    expect(pointInRing({ x: coreR + 2, y: 0 }, poly)).toBe(true);
  });
});

