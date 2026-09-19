import { describe, it, expect } from 'vitest';
import { buildRouteGraph, planRoute, routePath, routePlan, signalPhase, SIGNAL_CYCLE, EgoController } from './ego.js';
import { buildCity } from './city.js';
import { createDefaultProject } from './state.js';

const config = () => ({ ...createDefaultProject(), junctionType: 'city', cityBlockSize: 180, scenerySeed: 42 });
const city = buildCity(config());

describe('ego routing', () => {
  it('builds a graph that only allows directions with lanes', () => {
    const adj = buildRouteGraph(city);
    expect(adj.size).toBe(city.sd.nodes.length);
    for (const edge of city.sd.edges) {
      if (edge.lanesForward === 0) expect(adj.get(edge.from).some(h => h.to === edge.to)).toBe(false);
      else expect(adj.get(edge.from).some(h => h.to === edge.to)).toBe(true);
    }
  });

  it('plans a connected node route between any two junctions', () => {
    const ids = city.sd.nodes.map(n => n.id);
    const route = planRoute(city, ids[0], ids[ids.length - 1]);
    expect(route[0]).toBe(ids[0]);
    expect(route.at(-1)).toBe(ids.at(-1));
    for (let i = 0; i + 1 < route.length; i++) {
      const linked = city.sd.edges.some(e =>
        (e.from === route[i] && e.to === route[i + 1]) || (e.from === route[i + 1] && e.to === route[i]));
      expect(linked, `hop ${route[i]}->${route[i + 1]}`).toBe(true);
    }
  });

  it('expands a route into a drivable polyline on the road network', () => {
    const ids = city.sd.nodes.map(n => n.id);
    const path = routePath(city, planRoute(city, ids[0], ids[ids.length - 1]));
    expect(path).not.toBeNull();
    expect(path.length).toBeGreaterThan(10);
    for (const p of path) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.z)).toBe(true);
    }
    // Stations strictly increase and total length beats the straight line.
    expect(path.at(-1).s).toBeGreaterThan(0);
    const straight = Math.hypot(path.at(-1).x - path[0].x, path.at(-1).z - path[0].z);
    expect(path.at(-1).s).toBeGreaterThan(straight);
  });

  it('keeps the car on the right-most lane of each traversed edge', () => {
    const edge = city.sd.edges.find(e => e.lanesForward >= 2);
    expect(edge).toBeDefined();
    const path = routePath(city, [edge.from, edge.to]);
    const lane = city.lanes.find(l => l.edgeId === edge.id && l.from === edge.from && l.index === edge.lanesForward - 1);
    const mid = path[Math.floor(path.length / 2)];
    const nearestLane = city.lanes
      .filter(l => l.edgeId === edge.id)
      .map(l => ({ l, d: Math.hypot(l.path[Math.floor(l.path.length / 2)].x - mid.x, l.path[Math.floor(l.path.length / 2)].z - mid.z) }))
      .sort((a, b) => a.d - b.d)[0];
    expect(nearestLane.l.id).toBe(lane.id);
  });
});

describe('signal cycle', () => {
  it('alternates NS and EW greens with yellow and all-red clearances', () => {
    expect(signalPhase(0)).toEqual({ ns: 'green', ew: 'red' });
    expect(signalPhase(6.5).ns).toBe('yellow');
    expect(signalPhase(7.5)).toEqual({ ns: 'red', ew: 'red' });
    expect(signalPhase(9).ew).toBe('green');
    expect(signalPhase(14.5).ew).toBe('yellow');
    expect(signalPhase(15.5)).toEqual({ ns: 'red', ew: 'red' });
    expect(signalPhase(SIGNAL_CYCLE + 1).ns).toBe('green');
    expect(signalPhase(-1)).toEqual(signalPhase(SIGNAL_CYCLE - 1));
  });

  it('labels every junction stop line with the approach axis', () => {
    const ids = city.sd.nodes.map(n => n.id);
    const plan = routePlan(city, planRoute(city, ids[0], ids.at(-1)));
    expect(plan.boundaries.length).toBeGreaterThan(0);
    for (const b of plan.boundaries) {
      expect(['ns', 'ew']).toContain(b.axis);
      expect(b.s).toBeGreaterThan(0);
      expect(b.s).toBeLessThan(plan.path.at(-1).s + 1);
    }
    // Stop lines are sorted along the route.
    for (let i = 1; i < plan.boundaries.length; i++)
      expect(plan.boundaries[i].s).toBeGreaterThanOrEqual(plan.boundaries[i - 1].s);
  });
});

describe('ego signal compliance', () => {
  const redTime = axis => axis === 'ns' ? 10 : 2;
  const greenTime = axis => axis === 'ns' ? 2 : 10;

  it('holds at a red stop line and clears the junction on green', () => {
    const ego = new EgoController(city, { speed: 30 });
    const ids = city.sd.nodes.map(n => n.id);
    expect(ego.navigateTo(ids.at(-1))).toBe(true);
    const boundary = ego.boundaries[0];
    expect(boundary).toBeDefined();
    // Approach the stop line from 25m out with the approach signal at red.
    ego.s = Math.max(0, boundary.s - 25);
    ego.speed = 10;
    for (let i = 0; i < 200; i++) ego.update(0.1, redTime(boundary.axis));
    expect(ego.s).toBeLessThanOrEqual(boundary.s + 0.6);
    expect(ego.s).toBeGreaterThan(boundary.s - 3);
    expect(ego.waiting).not.toBeNull();
    // Green for this approach: the car crosses the stop line.
    for (let i = 0; i < 200; i++) ego.update(0.1, greenTime(boundary.axis));
    expect(ego.s).toBeGreaterThan(boundary.s + 0.5);
  });

  it('does not stop when the approach signal is green', () => {
    const ego = new EgoController(city, { speed: 30 });
    const ids = city.sd.nodes.map(n => n.id);
    expect(ego.navigateTo(ids.at(-1))).toBe(true);
    const boundary = ego.boundaries[0];
    ego.s = Math.max(0, boundary.s - 25);
    ego.speed = 12;
    let held = false;
    for (let i = 0; i < 120 && ego.s <= boundary.s; i++) {
      ego.update(0.1, greenTime(boundary.axis));
      if (ego.waiting) held = true;
    }
    expect(held).toBe(false);
    expect(ego.s).toBeGreaterThan(boundary.s);
  });
});

describe('ego controller', () => {
  it('advances along the route and arrives at the target', () => {
    const ego = new EgoController(city, { speed: 40 });
    const ids = city.sd.nodes.map(n => n.id);
    const target = ids[ids.length - 1];
    expect(ego.navigateTo(target)).toBe(true);
    expect(ego.mode).toBe('nav');
    let steps = 0;
    while (!ego.arrived && steps < 100000) { ego.update(0.1); steps++; }
    expect(ego.arrived).toBe(true);
    const pose = ego.currentPose();
    const node = city.sd.nodes.find(n => n.id === target);
    expect(Math.hypot(pose.x - node.x, pose.z - node.z)).toBeLessThan(60);
  });

  it('keeps roaming by starting a new leg after each arrival', () => {
    const ego = new EgoController(city, { speed: 40 });
    ego.startRoam();
    expect(ego.mode).toBe('roam');
    const firstTarget = ego.target;
    let steps = 0;
    while (ego.target === firstTarget && steps < 200000) { ego.update(0.1); steps++; }
    expect(ego.target).not.toBe(firstTarget);
    ego.stop();
    expect(ego.mode).toBe('idle');
  });
});
