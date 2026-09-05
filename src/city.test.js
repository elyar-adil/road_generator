import { describe, expect, it } from 'vitest';
import { createDefaultProject, sanitizeProject, createProjectDocument, parseProjectDocument } from './state.js';
import { generateSDMap, splitAtGradeCrossings, validateSDMap, extractBlocks, polygonArea } from './sd-map.js';
import { buildCity, createSceneDocument } from './city.js';
import { deriveHDMap } from './hd-map.js';
import { distanceToRoad, roadPoint } from './corridor.js';

const config = () => ({ ...createDefaultProject(), junctionType: 'city', scenerySeed: 42 });
const edge = (id, from, to, layer = 0) => ({ id, from, to, layer, class: 'local', lanesForward: 1, lanesBackward: 1 });
const node = (id, x, z) => ({ id, x, z, y: 0 });
const crossing = layer => ({ version: 1, seed: 42, nodes: [node('w', -100, 0), node('e', 100, 0), node('n', 0, -100), node('s', 0, 100)],
  edges: [edge('ew', 'w', 'e'), edge('ns', 'n', 's', layer)] });
const city = buildCity(config());

describe('SD authoring graph', () => {
  it('generates a deterministic, connected road hierarchy', () => {
    const a = generateSDMap(config()), b = generateSDMap(config());
    expect(a).toEqual(b);
    expect(validateSDMap(a)).toMatchObject({ valid: true, components: 1 });
    expect(new Set(a.edges.map(e => e.class))).toEqual(new Set(['local', 'collector', 'arterial']));
    expect(generateSDMap({ ...config(), scenerySeed: 43 }).nodes).not.toEqual(a.nodes);
  });

  it('inserts a real junction at a same-level crossing and is idempotent', () => {
    const normalized = splitAtGradeCrossings(crossing(0));
    expect(normalized.nodes).toHaveLength(5);
    expect(normalized.edges).toHaveLength(4);
    expect(validateSDMap(normalized).components).toBe(1);
    expect(splitAtGradeCrossings(normalized)).toEqual(normalized);
  });

  it('does not connect a bridge or tunnel to the road it crosses', () => {
    for (const layer of [-1, 1]) {
      const normalized = splitAtGradeCrossings(crossing(layer));
      expect(normalized.edges).toHaveLength(2);
      expect(normalized.nodes).toHaveLength(4);
      const hd = deriveHDMap(normalized, config());
      expect(hd.connectors).toHaveLength(0);
      expect(hd.facilities).toEqual(expect.arrayContaining([expect.objectContaining({ type: layer > 0 ? 'bridge' : 'tunnel' })]));
    }
  });

  it('snaps a T junction to the existing endpoint identity', () => {
    const input = { nodes: [node('w', -100, 0), node('e', 100, 0), node('t', 0, 0), node('s', 0, 100)],
      edges: [edge('ew', 'w', 'e'), edge('ts', 't', 's')] };
    const normalized = splitAtGradeCrossings(input);
    expect(normalized.nodes).toHaveLength(4);
    expect(normalized.edges.filter(e => e.from === 't' || e.to === 't')).toHaveLength(3);
  });

  it('rejects broken references, duplicates and collapsed roads', () => {
    expect(validateSDMap({ nodes: [node('a', 0, 0), node('a', 1, 0)], edges: [edge('bad', 'a', 'missing')] }).valid).toBe(false);
    expect(validateSDMap({ nodes: [node('a', 0, 0), node('b', 1, 0)], edges: [edge('tiny', 'a', 'b')] }).valid).toBe(false);
  });

  it('extracts only bounded faces from the edited graph', () => {
    const map = { nodes: [node('a', 0, 0), node('b', 100, 0), node('c', 100, 100), node('d', 0, 100)],
      edges: [edge('ab', 'a', 'b'), edge('bc', 'b', 'c'), edge('cd', 'c', 'd'), edge('da', 'd', 'a')] };
    expect(extractBlocks(map)).toHaveLength(1);
    expect(extractBlocks(map)[0].area).toBe(10000);
    map.nodes[2].x = 150;
    expect(extractBlocks(map)[0].area).toBe(12500);
  });

  it('preserves authored SD through project export, import and sanitization', () => {
    const project = sanitizeProject({ ...config(), sdMap: city.sd });
    const restored = parseProjectDocument(JSON.stringify(createProjectDocument(project)));
    expect(restored).toEqual(project);
    expect(restored.sdMap).toEqual(city.sd);
    const old = createProjectDocument(createDefaultProject()); old.version = 3; delete old.project.config.sdMap;
    expect(parseProjectDocument(JSON.stringify(old)).sdMap).toBeNull();
  });
});

describe('HD and city derivation', () => {
  it('uses directed lane endpoints for every turn connection', () => {
    const lanes = new Map(city.lanes.map(l => [l.id, l]));
    expect(city.connectors.length).toBeGreaterThan(100);
    for (const c of city.connectors) {
      const a = lanes.get(c.fromLane), b = lanes.get(c.toLane);
      expect(a.to).toBe(b.from);
      expect(c.nodeId).toBe(a.to);
      expect(a.edgeId).not.toBe(b.edgeId);
      expect(a.successors).toContain(b.id); expect(b.predecessors).toContain(a.id);
      for (const axis of ['x', 'y', 'z']) {
        expect(c.path[0][axis]).toBeCloseTo(a.path.at(-1)[axis], 5);
        expect(c.path.at(-1)[axis]).toBeCloseTo(b.path[0][axis], 5);
      }
    }
  });

  it('keeps forward and backward lanes on opposite sides of the SD road', () => {
    const map = { nodes: [node('a', -100, 0), node('b', 100, 0)], edges: [edge('ab', 'a', 'b')] };
    const hd = deriveHDMap(map, config());
    expect(hd.lanes.find(l => l.direction === 1).path[0].z).toBeGreaterThan(0);
    expect(hd.lanes.find(l => l.direction === -1).path[0].z).toBeLessThan(0);
    expect(hd.lanes.find(l => l.direction === -1).path[0].x).toBeGreaterThan(0);
  });

  it('rebuilds the dependent lane geometry after a node edit', () => {
    const sd = structuredClone(city.sd), affected = sd.nodes[6];
    affected.x += 8;
    const next = buildCity({ ...config(), sdMap: sd });
    const id = city.lanes.find(l => l.from === affected.id).id;
    expect(next.lanes.find(l => l.id === id).path).not.toEqual(city.lanes.find(l => l.id === id).path);
    expect(next.blocks.map(b => b.ring)).not.toEqual(city.blocks.map(b => b.ring));
  });

  it('generates continuous river-bridge approaches and avoids supports in roads', () => {
    const bridge = city.roads.find(r => r.structure);
    expect(city.maxGrade).toBeLessThan(0.06);
    expect(bridge.path[0].y).toBeCloseTo(0.32);
    expect(bridge.path.at(-1).y).toBeCloseTo(0.32);
    const facility = city.facilities.find(f => f.edgeId === bridge.id);
    expect(facility.crossing).toBe('water');
    expect(roadPoint(bridge, bridge.path.at(-1).s / 2).y - 0.32).toBeCloseTo(facility.height, 4);
    expect(roadPoint(bridge, bridge.path.at(-1).s / 2).y - bridge.depth).toBeGreaterThan(1);
    for (const support of city.supports) {
      for (const road of city.roads.filter(r => r.id !== support.roadId)) expect(distanceToRoad(support, road)).toBeGreaterThanOrEqual(road.width / 2 + 2.2);
    }
  });

  it('keeps buildings inside their parcel, with stable independent seeds', () => {
    expect(city.buildings.length).toBeGreaterThan(100);
    const parcels = new Map(city.parcels.map(p => [p.id, p]));
    for (const b of city.buildings) {
      const parcel = parcels.get(b.parcelId);
      expect(polygonArea(b.ring)).toBeLessThan(polygonArea(parcel.ring));
      for (const point of b.ring) for (let i = 0; i < parcel.ring.length; i++) {
        const a = parcel.ring[i], q = parcel.ring[(i + 1) % parcel.ring.length];
        expect((q.x - a.x) * (point.z - a.z) - (q.z - a.z) * (point.x - a.x)).toBeGreaterThanOrEqual(-0.001);
      }
    }
    const sparse = buildCity({ ...config(), cityDensity: 0.3 });
    expect(sparse.sd).toEqual(city.sd);
    const denseBuildings = new Map(city.buildings.map(b => [b.id, b]));
    for (const b of sparse.buildings) expect(b).toEqual(denseBuildings.get(b.id));
  });

  it('exports topology and semantic data without renderer objects', () => {
    const document = JSON.parse(JSON.stringify(createSceneDocument(city)));
    expect(document.coordinates).toMatchObject({ units: 'metres', up: '+Y', north: '-Z' });
    expect(document.sdMap).toEqual(city.sd);
    expect(document.hdMap.lanes).toHaveLength(city.lanes.length);
    expect(document.buildings[0]).toHaveProperty('seed');
  });
});
