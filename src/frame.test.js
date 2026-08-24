import { describe, expect, it } from 'vitest';
import { createStraightFrame, createPolylineFrame } from './frame.js';
import { distance } from './geometry.js';

describe('straight frame', () => {
  it('maps (u,s) with the classic arm trigonometry', () => {
    const f = createStraightFrame({ x: 0, y: 0 }, 37);
    const a = 37 * Math.PI / 180;
    const p = f.wp(10, -2);
    expect(p.x).toBeCloseTo(10 * Math.cos(a) + 2 * Math.sin(a), 9);
    expect(p.y).toBeCloseTo(10 * Math.sin(a) - 2 * Math.cos(a), 9);
    expect(f.fwdAt(0).x).toBeCloseTo(Math.cos(a), 9);
    expect(f.leftAt(5).y).toBeCloseTo(Math.cos(a), 9);
  });

  it('supports a non-zero origin', () => {
    const f = createStraightFrame({ x: 5, y: -3 }, 0);
    expect(f.wp(2, 1)).toEqual({ x: 7, y: -2 });
  });
});

// Quarter circle of radius R centred at the origin, sampled every 6 degrees.
function quarterCircle(R, stepDeg = 6) {
  const pts = [];
  for (let deg = 0; deg <= 90; deg += stepDeg) {
    const rad = deg * Math.PI / 180;
    pts.push({ x: R * Math.cos(rad), y: R * Math.sin(rad) });
  }
  return pts;
}

describe('polyline frame', () => {
  const R = 20;
  const frame = createPolylineFrame(quarterCircle(R));

  it('reports the arc length as its extent', () => {
    expect(frame.length).toBeCloseTo(Math.PI * R / 2, 1);
  });

  it('keeps station points on the centreline within chord sagitta', () => {
    for (const u of [0, 5, 12.7, frame.length]) {
      const p = frame.wp(u, 0);
      // Chords cut inside the circle; sampling every 6° keeps error < 0.05.
      expect(Math.abs(distance(p, { x: 0, y: 0 }) - R)).toBeLessThan(0.06);
    }
    // Endpoints land exactly on samples.
    expect(frame.wp(0, 0)).toEqual({ x: R, y: 0 });
  });

  it('applies lateral offsets along the local normal', () => {
    for (const u of [1.4, 8, frame.length - 0.3]) {
      const left = frame.wp(u, 1.5);
      const right = frame.wp(u, -2.5);
      expect(distance(left, right)).toBeCloseTo(4, 6);
      // The arc runs counter-clockwise (curving left), so +s = left points to
      // the inside of the curve.
      expect(distance(left, { x: 0, y: 0 })).toBeLessThan(
        distance(frame.wp(u, 0), { x: 0, y: 0 }),
      );
      expect(distance(right, { x: 0, y: 0 })).toBeGreaterThan(R);
    }
  });

  it('returns tangents perpendicular to the radius within the chord sagitta', () => {
    // A chord's direction is exactly perpendicular to the radius at the arc
    // midpoint only; with 6° samples the worst-case dot error is R·sin(3°).
    const tolerance = R * Math.sin(3 * Math.PI / 180) + 1e-9;
    for (const u of [0.01, 7.3, frame.length - 0.01]) {
      const fwd = frame.fwdAt(u);
      const radial = frame.wp(u, 0);
      expect(Math.abs(fwd.x * radial.x + fwd.y * radial.y)).toBeLessThan(tolerance);
    }
  });

  it('extrapolates past both ends along the end tangents', () => {
    const before = frame.wp(-4, 0);
    // Backwards from (R,0) along the reversed start tangent (heading +y):
    // drops below the x-axis while drifting slightly outside the circle.
    expect(before.x).toBeGreaterThan(R);
    expect(before.y).toBeLessThan(0);
    const after = frame.wp(frame.length + 4, 0);
    // Forwards from (0,R) along the end tangent (heading -x): rises above R.
    expect(after.y).toBeGreaterThan(R);
    expect(after.x).toBeLessThan(0);
  });

  it('tolerates duplicate consecutive points', () => {
    const pts = [...quarterCircle(10, 30), quarterCircle(10, 30)[3]];
    const f = createPolylineFrame(pts);
    expect(Number.isFinite(f.wp(1, 0).x)).toBe(true);
  });

  it('rejects polylines without extent', () => {
    expect(() => createPolylineFrame([{ x: 1, y: 1 }])).toThrow();
    expect(() => createPolylineFrame([{ x: 1, y: 1 }, { x: 1, y: 1 }])).toThrow();
  });
});
