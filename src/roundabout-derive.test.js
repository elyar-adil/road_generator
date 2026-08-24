import { describe, expect, it } from 'vitest';
import { createDefaultProject, createSeededRandom, sanitizeProject } from './state.js';
import { buildRoadModel } from './road-model.js';
import { deriveRoadScene } from './lane-derive.js';

function roundaboutScene(overrides = {}) {
  const state = sanitizeProject({ ...createDefaultProject(), junctionType: 'roundabout', ...overrides });
  const model = buildRoadModel(state);
  const scene = deriveRoadScene(model, state, createSeededRandom(state.scenerySeed));
  return { state, model, scene };
}

describe('roundabout derivation', () => {
  it('produces the circulatory annulus, central island and splitter islands', () => {
    const { model, scene } = roundaboutScene();
    const { inscribedR, islandR } = model.roundabout;

    // Exactly one central island ring on the island radius; approaches may add
    // their own planted medians beyond it.
    const central = scene.medianIslands.find((ring) =>
      ring.every((p) => Math.abs(Math.hypot(p.x, p.y) - islandR) < 1e-6));
    expect(central).toBeDefined();
    for (const ring of scene.medianIslands) {
      for (const p of ring) {
        expect(Math.hypot(p.x, p.y)).toBeGreaterThanOrEqual(islandR - 1e-6);
      }
    }

    // One planted splitter island per approach.
    expect(scene.guideAreas).toHaveLength(4);
    expect(scene.guideAreas.every((g) => g.planted)).toBe(true);
    for (const g of scene.guideAreas) {
      for (const p of g.pts) {
        const r = Math.hypot(p.x, p.y);
        expect(r).toBeGreaterThan(islandR);
        expect(r).toBeLessThanOrEqual(inscribedR + 3 + 1e-9);
      }
    }
  });

  it('suppresses signal-controlled markings and lights', () => {
    const { scene } = roundaboutScene();
    expect(scene.stopLines).toHaveLength(0);
    expect(scene.crosswalks).toHaveLength(0);
    expect(scene.arrows).toHaveLength(0);
    expect(scene.waitingAreas).toHaveLength(0);
    expect(scene.trafficLights).toHaveLength(0);
    expect(scene.branchSurfaces).toHaveLength(0);
  });

  it('keeps approach markings but truncates pavement at the circle', () => {
    const { model, scene } = roundaboutScene();
    const { inscribedR } = model.roundabout;
    expect(scene.laneDashes.length).toBeGreaterThan(0);
    expect(scene.laneEdges.length).toBeGreaterThan(0);

    // Approach quads start at the geom station R (>= inscribed overlap) and no
    // surface vertex falls inside the central island.
    for (const g of model.geoms) {
      expect(g.R).toBeGreaterThanOrEqual(inscribedR + 0.2);
    }
    for (const poly of scene.roadSurfaces) {
      for (const p of poly) {
        expect(Math.hypot(p.x, p.y)).toBeGreaterThanOrEqual(model.roundabout.islandR - 0.01);
      }
    }
  });

  it('wraps sidewalks and curbs around the ring without crossing the island', () => {
    const { model, scene } = roundaboutScene();
    expect(scene.sidewalks).toHaveLength(4);
    // Each gap contributes arm-edge + arc curb segments; the ring is fully covered.
    expect(scene.curbs.length).toBeGreaterThanOrEqual(4 * 8);
    const limit = model.roundabout.islandR - 0.01;
    for (const sw of scene.sidewalks) {
      expect(sw.path.length).toBeGreaterThanOrEqual(10);
      for (const p of sw.path) {
        expect(Math.hypot(p.x, p.y)).toBeGreaterThan(limit);
      }
    }
    // One street lamp per splitter nose.
    expect(scene.streetLamps).toHaveLength(4);
  });
});
