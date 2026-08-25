import { describe, expect, it } from 'vitest';
import {
  annulusSectorQuads,
  computeRoundaboutLayout,
  forkIslandPolygon,
  roundaboutArmSlots,
  roundaboutApproach,
} from './roundabout.js';
import { len, sub, pointInRing } from './geometry.js';

function properIntersections(poly) {
  const orient = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const crosses = (a, b, c, d) => orient(a, b, c) * orient(a, b, d) < -1e-8
    && orient(c, d, a) * orient(c, d, b) < -1e-8;
  let count = 0;
  for (let i = 0; i < poly.length; i += 1) {
    for (let j = i + 2; j < poly.length; j += 1) {
      if (i === 0 && j === poly.length - 1) continue;
      if (crosses(poly[i], poly[(i + 1) % poly.length], poly[j], poly[(j + 1) % poly.length])) count += 1;
    }
  }
  return count;
}

describe('roundabout layout', () => {
  it('derives the inscribed radius from the core-size knob', () => {
    const arms = [{ laneIn: 2, laneOut: 2 }, { laneIn: 3, laneOut: 2 }];
    expect(computeRoundaboutLayout({ arms, laneWidth: 3.25, intersectionSize: 36 }).inscribedR).toBe(18);
    expect(computeRoundaboutLayout({ arms, laneWidth: 3.25, intersectionSize: 10 }).inscribedR).toBe(9.75 + 1.25 * 3.25);
  });

  it('scales the ring to real circulating lanes', () => {
    const wide = computeRoundaboutLayout({
      arms: [{ laneIn: 6, laneOut: 6 }], laneWidth: 4.2, intersectionSize: 60,
    });
    expect(wide.circLanes).toBe(6);
    expect(wide.circWidth).toBeCloseTo(25.2, 9);
    expect(wide.inscribedR).toBeCloseTo(30.45, 9);
    expect(wide.islandR).toBeCloseTo(5.25, 9);

    const narrow = computeRoundaboutLayout({
      arms: [{ laneIn: 1, laneOut: 1 }], laneWidth: 2.6, intersectionSize: 30,
    });
    expect(narrow.circLanes).toBe(1);
    expect(narrow.circWidth).toBeCloseTo(2.6, 9);
    expect(narrow.inscribedR).toBe(15);
  });

  it('keeps the central island at least minimally planted', () => {
    const tiny = computeRoundaboutLayout({
      arms: [{ laneIn: 6, laneOut: 6 }], laneWidth: 4.2, intersectionSize: 24,
    });
    expect(tiny.islandR).toBeGreaterThanOrEqual(4);
    expect(tiny.inscribedR).toBeGreaterThanOrEqual(tiny.circWidth + 4.2 * 1.25);
  });
});

describe('approach Y-geometry', () => {
  const coreR = 18;
  const ap = roundaboutApproach({ angleDeg: 0, coreR, laneWidth: 3.25, laneIn: 2, laneOut: 2, medW: 0 });

  it('allocates the two connection centres to adjacent equal slots', () => {
    expect(ap.footIn).toBeCloseTo(Math.PI / 8, 9);
    expect(ap.footOut).toBeCloseTo(-Math.PI / 8, 9);
    expect(Math.hypot(ap.entryOuter.at(-1).x, ap.entryOuter.at(-1).y)).toBeCloseTo(coreR, 9);
    expect(Math.hypot(ap.entryInner.at(-1).x, ap.entryInner.at(-1).y)).toBeCloseTo(coreR - ap.halfIn * 2, 9);
    expect(Math.hypot(ap.exitOuter[0].x, ap.exitOuter[0].y)).toBeCloseTo(coreR, 9);
    expect(Math.hypot(ap.exitInner[0].x, ap.exitInner[0].y)).toBeCloseTo(coreR - ap.halfOut * 2, 9);
  });

  it('uses adjacent-arm bisectors for uneven road angles', () => {
    const slots = roundaboutArmSlots([0, 70, 200, 290]);
    expect(slots[1].footIn).toBeCloseTo(135 * Math.PI / 180, 9);
    expect(slots[1].footOut).toBeCloseTo(35 * Math.PI / 180, 9);
    expect(slots[1].footIn).toBeCloseTo(slots[2].footOut, 9);
    expect(slots[1].footOut).toBeCloseTo(slots[0].footIn, 9);
  });

  it('joins the seam tangentially without reversing along either branch', () => {
    const tangentAt = (phi) => ({ x: -Math.sin(phi), y: Math.cos(phi) });
    const dir = (a, b) => { const d = sub(b, a); return { x: d.x / len(d), y: d.y / len(d) }; };
    const entryEndDir = dir(ap.entryOuter.at(-2), ap.entryOuter.at(-1));
    const exitStartDir = dir(ap.exitOuter[0], ap.exitOuter[1]);
    const tIn = tangentAt(ap.footIn), tOut = tangentAt(ap.footOut);
    expect(entryEndDir.x * tIn.x + entryEndDir.y * tIn.y).toBeGreaterThan(0.96);
    expect(exitStartDir.x * tOut.x + exitStartDir.y * tOut.y).toBeGreaterThan(0.96);
    const entryRadii = ap.entryPath.map((p) => Math.hypot(p.x, p.y));
    const exitRadii = ap.exitPath.map((p) => Math.hypot(p.x, p.y));
    expect(entryRadii.every((r, i) => i === 0 || r <= entryRadii[i - 1] + 1e-6)).toBe(true);
    expect(exitRadii.every((r, i) => i === 0 || r >= exitRadii[i - 1] - 1e-6)).toBe(true);
  });

  it('puts entry clockwise of the axis and exit counter-clockwise', () => {
    expect(ap.footIn).toBeGreaterThan(ap.theta);
    expect(ap.footOut).toBeLessThan(ap.theta);
    expect(ap.forkU).toBeGreaterThanOrEqual(coreR + 9);
  });

  it('builds a closed island wedge between the Y and the seam arc', () => {
    const poly = forkIslandPolygon({
      entryInner: ap.entryInner,
      exitInner: ap.exitInner,
      coreR, theta: ap.theta, forkU: ap.forkU, medW: 0,
    });
    // A point between the rounded nose and fork cap sits inside the island.
    expect(pointInRing({ x: (coreR + ap.forkU) / 2, y: 0 }, poly)).toBe(true);
    expect(Math.min(...poly.map((point) => len(point)))).toBeGreaterThan(coreR + 1.2);
    expect(properIntersections(poly)).toBe(0);
  });

  it('keeps wide and asymmetric branch ribbons simple', () => {
    const wide = roundaboutApproach({
      angleDeg: 0, coreR: 30, laneWidth: 4.2, laneIn: 6, laneOut: 3, medW: 4, forkReach: 22,
    });
    for (const [surface, expectedWidth] of [
      [wide.entrySurface, wide.halfIn * 2],
      [wide.exitSurface, wide.halfOut * 2],
    ]) {
      const widths = surface.outer.map((point, index) => len(sub(point, surface.inner[index])));
      expect(Math.min(...widths)).toBeCloseTo(expectedWidth, 9);
      expect(Math.max(...widths)).toBeCloseTo(expectedWidth, 9);
    }
  });

  it('curves more sharply for a smaller roundabout', () => {
    const maxTurn = (path) => Math.max(...path.slice(1, -1).map((point, index) => {
      const before = sub(point, path[index]);
      const after = sub(path[index + 2], point);
      return Math.acos(Math.max(-1, Math.min(1,
        (before.x * after.x + before.y * after.y) / (len(before) * len(after)),
      )));
    }));
    const small = roundaboutApproach({
      angleDeg: 0, coreR: 15, laneWidth: 3.25, laneIn: 2, laneOut: 2,
      forkReach: 15 * 0.78, slotAngle: Math.PI / 4,
    });
    const large = roundaboutApproach({
      angleDeg: 0, coreR: 30, laneWidth: 3.25, laneIn: 2, laneOut: 2,
      forkReach: 30 * 0.78, slotAngle: Math.PI / 4,
    });
    expect(maxTurn(small.entryPath)).toBeGreaterThan(maxTurn(large.entryPath));
  });
});
