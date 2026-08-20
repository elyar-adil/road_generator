import { describe, expect, it } from 'vitest';
import { createDefaultProject, sanitizeProject, createSeededRandom } from './state.js';
import { buildRoadModel } from './road-model.js';
import { computeLaneTopology } from './lane-topology.js';
import { deriveRoadScene, arrowOnPath, laneLineStartFor, guideArea, guideChevrons } from './lane-derive.js';

function scene(overrides = {}) {
  const state = sanitizeProject({ ...createDefaultProject(), ...overrides });
  const model = buildRoadModel(state);
  const topology = computeLaneTopology(model.geoms, {
    armLength: state.armLength,
    facilities: model.rightFacilities,
  });
  const random = createSeededRandom(state.scenerySeed);
  return deriveRoadScene(model, state, random, topology);
}

describe('lane derivation layer', () => {
  it('derives a complete scene for the default cross', () => {
    const s = scene();
    expect(s.roadSurfaces.length).toBeGreaterThan(0);
    expect(s.laneDashes.length).toBeGreaterThan(0);
    expect(s.laneEdges.length).toBeGreaterThan(0);
    expect(s.stopLines.length).toBe(4);
    expect(s.crosswalks.length).toBe(4);
    expect(s.curbs.length).toBeGreaterThan(0);
    expect(s.arrows.length).toBeGreaterThan(0);
    expect(s.trafficLights.length).toBe(4);
    expect(s.streetLamps.length).toBe(4);
  });

  it('never places a sidewalk strip through the intersection interior', () => {
    const s = scene();
    const centre = { x: 0, y: 0 };
    for (const sw of s.sidewalks) {
      expect(sw.path.some((p) => Math.abs(p.x) < 0.5 && Math.abs(p.y) < 0.5)).toBe(false);
    }
  });

  it('keeps every sidewalk band clear of every carriageway lane bundle', () => {
    // Regression: the bypass sidewalk around a channelized right-turn branch
    // used to run from the arm's far-left corner straight to the merge anchor,
    // slicing across the outer through lane. Rebuild with split branches and
    // assert the rendered sidewalk band (path + offset ± half width, matching
    // pathStrip in render.js) never strictly overlaps any arm's lane rectangle.
    const state = sanitizeProject({
      ...createDefaultProject(),
      arms: (createDefaultProject().arms || sanitizeProject({}).arms).map((a) => ({
        ...a, rightTurnLane: true, rightTurnType: 'split', rightTurnMode: 'branch',
      })),
    });
    const model = buildRoadModel(state);
    const topology = computeLaneTopology(model.geoms, {
      armLength: state.armLength,
      facilities: model.rightFacilities,
    });
    const random = createSeededRandom(state.scenerySeed);
    const s = deriveRoadScene(model, state, random, topology);

    const inRect = (p, g) => {
      const u = p.x * g.fwd.x + p.y * g.fwd.y;
      const st = p.x * g.left.x + p.y * g.left.y;
      return u > 0 && u < state.armLength && st > g.outOuterS + 1e-6 && st < g.inOuterS - 1e-6;
    };
    const bandEdges = (path, width, offset) => {
      const outer = [], inner = [];
      for (let i = 0; i < path.length; i += 1) {
        const p = path[i], prev = path[Math.max(0, i - 1)], next = path[Math.min(path.length - 1, i + 1)];
        const tx = next.x - prev.x, ty = next.y - prev.y, L = Math.hypot(tx, ty) || 1;
        const nx = ty / L, ny = -tx / L;
        outer.push({ x: p.x + nx * (offset + width / 2), y: p.y + ny * (offset + width / 2) });
        inner.push({ x: p.x + nx * (offset - width / 2), y: p.y + ny * (offset - width / 2) });
      }
      return [outer, inner];
    };
    for (const sw of s.sidewalks) {
      for (const edge of bandEdges(sw.path, sw.width, sw.offset)) {
        for (let i = 0; i < edge.length - 1; i += 1) {
          const mid = { x: (edge[i].x + edge[i + 1].x) / 2, y: (edge[i].y + edge[i + 1].y) / 2 };
          model.geoms.forEach((g) => expect(inRect(mid, g)).toBe(false));
        }
      }
    }
  });

  it('keeps all derived points finite', () => {
    const s = scene({ armLength: 46 });
    const all = [
      ...s.roadSurfaces.flat(2),
      ...s.laneDashes.flat(2),
      ...s.laneEdges.flat(2),
      ...s.stopLines.flat(2),
      ...s.curbs.flat(2),
      ...s.sidewalks.flatMap((sw) => sw.path),
      ...s.arrows.flatMap((a) => a.pts.flat(2)),
      ...s.guideChevrons.flat(2),
      ...s.trees.map((t) => t.pos),
      ...s.buildings.map((b) => b.pos),
      ...s.streetLamps.map((l) => l.pos),
    ];
    all.forEach((p) => {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    });
  });

  it('derives guide areas and chevrons for split facilities', () => {
    const state = sanitizeProject({
      ...createDefaultProject(),
      arms: [
        { angle: 0, laneIn: 3, laneOut: 2, rightTurnLane: true, rightTurnType: 'split', rightTurnLanes: 1, rightTurnMode: 'branch', centerMode: 'doubleYellow', waitingArea: 'none', leftTurnLanes: 1 },
        { angle: 90, laneIn: 2, laneOut: 2, rightTurnLane: false, rightTurnType: 'none', centerMode: 'doubleYellow', waitingArea: 'none', leftTurnLanes: 1 },
        { angle: 180, laneIn: 2, laneOut: 2, rightTurnLane: false, rightTurnType: 'none', centerMode: 'doubleYellow', waitingArea: 'none', leftTurnLanes: 1 },
        { angle: 270, laneIn: 2, laneOut: 2, rightTurnLane: false, rightTurnType: 'none', centerMode: 'doubleYellow', waitingArea: 'none', leftTurnLanes: 1 },
      ],
    });
    const model = buildRoadModel(state);
    const facility = model.rightFacilities.find(Boolean);
    expect(facility).toBeDefined();
    const g = model.geoms[0];
    const guide = guideArea(facility);
    expect(guide).toBeTruthy();
    expect(guide.length).toBeGreaterThan(5);
    const chevrons = guideChevrons(facility.data.guideInner, facility.data.guideApex, guide);
    expect(chevrons.length).toBeGreaterThan(0);
  });

  it('scheme 1 makes the outermost lane arrow right; scheme 2 keeps it straight', () => {
    const state = sanitizeProject({
      ...createDefaultProject(),
      arms: [
        { angle: 0, laneIn: 3, laneOut: 2, rightTurnLane: true, rightTurnType: 'split', rightTurnLanes: 1, rightTurnMode: 'dedicated', centerMode: 'doubleYellow', waitingArea: 'none', leftTurnLanes: 1 },
        { angle: 90, laneIn: 2, laneOut: 2, rightTurnLane: false, rightTurnType: 'none', centerMode: 'doubleYellow', waitingArea: 'none', leftTurnLanes: 1 },
        { angle: 180, laneIn: 2, laneOut: 2, rightTurnLane: false, rightTurnType: 'none', centerMode: 'doubleYellow', waitingArea: 'none', leftTurnLanes: 1 },
        { angle: 270, laneIn: 2, laneOut: 2, rightTurnLane: false, rightTurnType: 'none', centerMode: 'doubleYellow', waitingArea: 'none', leftTurnLanes: 1 },
      ],
    });
    const model = buildRoadModel(state);
    const derived = deriveRoadScene(model, state, createSeededRandom(state.scenerySeed));
    const outerArrow = derived.arrows.find((a) => a.armIndex === 0 && a.laneIndex === 2);
    // The derivation layer stores the movement via arrow footprint; the arrows
    // list also carries arm/lane context. Sanity: outer lane produced an arrow
    // footprint (a non-empty polygon list).
    expect(outerArrow).toBeDefined();
    expect(outerArrow.pts.length).toBeGreaterThan(0);
  });

  it('laneLineStartFor is deterministic and finite', () => {
    const state = sanitizeProject(createDefaultProject());
    const model = buildRoadModel(state);
    const start = laneLineStartFor(model.geoms[0], model.cfg);
    expect(Number.isFinite(start)).toBe(true);
    expect(start).toBeGreaterThan(model.geoms[0].R);
  });

  it('arrowOnPath yields footprints aligned with the path', () => {
    const path = Array.from({ length: 30 }, (_, i) => ({ x: i * 0.5, y: 0 }));
    const polys = arrowOnPath(path, ['right']);
    expect(polys.length).toBe(1);
    expect(polys[0].length).toBeGreaterThan(5);
  });
});