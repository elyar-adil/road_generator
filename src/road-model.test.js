import { describe, expect, it } from 'vitest';
import { createDefaultProject, sanitizeProject } from './state.js';
import {
  buildRoadModel, buildCornerFillets, leftTurnLaneCapacity, rightTurnLaneCapacity,
} from './road-model.js';

describe('road model (layer 1)', () => {
  it('builds per-road geometry and topology for a standard cross', () => {
    const model = buildRoadModel(sanitizeProject(createDefaultProject()));
    expect(model.geoms).toHaveLength(4);
    model.geoms.forEach((g) => {
      expect(Number.isFinite(g.R)).toBe(true);
      expect(g.fwd.x * g.left.x + g.fwd.y * g.left.y).toBeCloseTo(0, 6); // fwd ⟂ left
      expect(g.farLeft.x).not.toBe(g.nearLeft.x); // far end beyond junction
    });
    // Every arm of a cross has straight/left/right reachable.
    model.availPerArm.forEach((set) => {
      expect(set.has('straight')).toBe(true);
    });
    expect(model.filletPts).toHaveLength(4);
    model.filletPts.forEach((pts) => {
      expect(pts.length).toBeGreaterThan(0);
      pts.forEach((p) => expect(Number.isFinite(p.x)).toBe(true));
    });
  });

  it('keeps road geometries finite for corner filleting', () => {
    const model = buildRoadModel(sanitizeProject(createDefaultProject()));
    const fillets = buildCornerFillets(model.geoms, model.cfg);
    expect(fillets.every((f) => f.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)))).toBe(true);
  });

  it('detects movement targets via layer-1 connectivity', () => {
    const model = buildRoadModel(sanitizeProject(createDefaultProject()));
    // arm at angle 0 (heading +x): straight target is arm at 180.
    const angle0 = model.geoms.findIndex((g) => g.arm.angle === 0);
    expect(model.straightTargets[angle0]).not.toBe(null);
    expect(model.leftTargets[angle0]).not.toBe(null);
    expect(model.rightTargets[angle0]).not.toBe(null);
  });

  it('computes lane capacities', () => {
    const arm = { laneIn: 4, laneOut: 2, leftTurnLanes: 2 };
    expect(leftTurnLaneCapacity(arm, { arm: { laneOut: 2 } })).toBe(2);
    const rightArm = { laneIn: 3, laneOut: 2, rightTurnLane: true, rightTurnType: 'split', rightTurnLanes: 1 };
    expect(rightTurnLaneCapacity(rightArm, { arm: { laneOut: 2 } })).toBe(1);
  });
});