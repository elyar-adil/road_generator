import { describe, expect, it } from 'vitest';
import { sweptTurn, polylineLength } from './geometry.js';

describe('swept-turn (vehicle trajectory) primitive', () => {
  it('builds a finite quarter-arc lane turn with straight lead-in/out', () => {
    // Left turn across a junction: approach along -x, depart along +y.
    const path = sweptTurn(
      { x: 11.39, y: -1.625 }, { x: -1, y: 0 },
      { x: -1.625, y: 11.39 }, { x: 0, y: 1 },
      8, 16,
    );
    expect(path).not.toBeNull();
    expect(path.length).toBeGreaterThan(10);
    // Endpoints preserved exactly (connects to the two lane centres).
    expect(path[0]).toEqual({ x: 11.39, y: -1.625 });
    expect(path.at(-1)).toEqual({ x: -1.625, y: 11.39 });
    path.forEach((p) => {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    });
    expect(polylineLength(path)).toBeGreaterThan(10);
  });

  it('returns null for (near-)parallel through moves so callers fall back', () => {
    const path = sweptTurn(
      { x: 11.39, y: -1.625 }, { x: -1, y: 0 },
      { x: -11.39, y: -1.625 }, { x: -1, y: 0 },
      8, 16,
    );
    expect(path).toBeNull();
  });

  it('traces the arc on the interior of the turn (away from approach line)', () => {
    const path = sweptTurn(
      { x: 11.39, y: -1.625 }, { x: -1, y: 0 },
      { x: -1.625, y: 11.39 }, { x: 0, y: 1 },
      8, 16,
    );
    // The midpoint of the swept path should swing into the junction interior
    // (positive y, away from the source straight run at y=-1.625).
    const mid = path[Math.floor(path.length / 2)];
    expect(mid.x).toBeLessThan(11.39);
    expect(mid.y).toBeGreaterThan(-1.625);
  });
});