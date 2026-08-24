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

const cfgArmLength = (model) => model.cfg.armLength;

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

    // One teardrop splitter island per approach, entirely on the approach side.
    expect(scene.guideAreas).toHaveLength(4);
    expect(scene.guideAreas.every((g) => g.planted)).toBe(true);
    for (const g of scene.guideAreas) {
      for (const p of g.pts) {
        const r = Math.hypot(p.x, p.y);
        expect(r).toBeGreaterThanOrEqual(inscribedR - 0.35);
        expect(r).toBeLessThanOrEqual(inscribedR + 9 + 1e-9);
      }
    }
  });

  it('suppresses only signal-controlled facilities', () => {
    const { scene } = roundaboutScene();
    expect(scene.stopLines).toHaveLength(0);
    expect(scene.waitingAreas).toHaveLength(0);
    expect(scene.trafficLights).toHaveLength(0);
    expect(scene.branchSurfaces).toHaveLength(0);
    // Pedestrian crossings stay: they sit behind the splitter noses.
    expect(scene.crosswalks).toHaveLength(4);
  });

  it('keeps every entry yield arc on its own arm sector (branch-cut regression)', () => {
    const { model, scene } = roundaboutScene();
    const { inscribedR } = model.roundabout;
    // The default project includes an arm pointing at exactly 180 deg, whose
    // crossings straddle the atan2 branch cut.
    scene.entryMarks.forEach((entry) => {
      const axis = model.geoms[entry.armIndex].arm.angle * Math.PI / 180;
      expect(entry.dashes.length).toBeGreaterThan(0);
      expect(entry.dashes.length).toBeLessThan(30); // never a map-wide sweep
      entry.dashes.forEach(([p0, p1]) => {
        [p0, p1].forEach((p) => {
          expect(Math.abs(Math.hypot(p.x, p.y) - (inscribedR + 0.12))).toBeLessThan(0.05);
          let d = Math.atan2(p.y, p.x) - axis;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          // Inbound lanes sit clockwise of the axis.
          expect(d).toBeLessThan(0.05);
          expect(d).toBeGreaterThan(-1.1);
        });
      });
    });
  });

  it('dashes circulating lane dividers across open gaps', () => {
    const { state, model, scene } = roundaboutScene();
    const { islandR, inscribedR } = model.roundabout;
    const ringWidth = inscribedR - islandR;
    const circLanes = Math.max(1, Math.floor((ringWidth - 0.4) / state.laneWidth));
    expect(circLanes).toBeGreaterThanOrEqual(2); // default core is wide enough
    const dividerDashes = scene.laneDashes.filter(([p]) => {
      const r = Math.hypot(p.x, p.y);
      return r > islandR + 0.1 && r < inscribedR - 0.1;
    });
    expect(dividerDashes.length).toBeGreaterThanOrEqual((circLanes - 1) * 6);
  });

  it('marks every entry with a give-way line, triangle and flow arrow', () => {
    const { scene } = roundaboutScene();
    expect(scene.entryMarks).toHaveLength(4);
    for (const entry of scene.entryMarks) {
      expect(entry.dashes.length).toBeGreaterThan(2);
      expect(entry.legs).toHaveLength(3);
    }
    // One counter-clockwise circulating arrow per approach.
    const flowArrows = scene.arrows.filter((a) => a.onBranch);
    expect(flowArrows).toHaveLength(4);
    for (const arrow of flowArrows) {
      // pts is a list of polygons (nested), matching the render-layer contract.
      const polys = Array.isArray(arrow.pts[0]) ? arrow.pts : [arrow.pts];
      expect(polys.some((poly) => poly.length > 2)).toBe(true);
    }
  });

  it('keeps approach markings but truncates pavement at the circle', () => {
    const { model, scene } = roundaboutScene();
    const { inscribedR } = model.roundabout;
    expect(scene.laneDashes.length).toBeGreaterThan(0);
    expect(scene.laneEdges.length).toBeGreaterThan(0);

    // Every approach starts exactly on the shared seam circle.
    for (const g of model.geoms) {
      expect(g.R).toBeCloseTo(inscribedR, 9);
    }
    for (const poly of scene.roadSurfaces) {
      for (const p of poly) {
        expect(Math.hypot(p.x, p.y)).toBeGreaterThanOrEqual(model.roundabout.islandR - 0.01);
      }
    }
  });

  it('trims each approach along the seam arc, not a chord (no gaps to the ring)', () => {
    const { model, scene } = roundaboutScene();
    const { inscribedR } = model.roundabout;
    // Approach polygons contain their far corners; count how many of their
    // vertices sit exactly on the seam circle. A chord-trimmed arm would have
    // only its two corner crossings near the radius and a straight run
    // between them; an arc-trimmed arm carries the full grid slice.
    let armsWithArcEdge = 0;
    for (const poly of scene.roadSurfaces) {
      const hasFarCorner = poly.some((p) => Math.hypot(p.x, p.y) > cfgArmLength(model) - 1e-6);
      if (!hasFarCorner) continue;
      const onSeam = poly.filter((p) => Math.abs(Math.hypot(p.x, p.y) - inscribedR) < 1e-6).length;
      if (onSeam >= 8) armsWithArcEdge += 1;
    }
    expect(armsWithArcEdge).toBe(4);
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
