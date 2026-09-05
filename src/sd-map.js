import { segmentIntersection } from './map-utils.js';
export { hashSeed, randomFromSeed, segmentIntersection } from './map-utils.js';
import { growUrbanMap } from './urban-growth.js';
// Authoring layer. SD stores roads and intent, never meshes or lane connectors.
// x/z = horizontal metres; y = elevation. Positive z points south.
export const SD_VERSION = 1;
export const ROAD_CLASSES = ['local', 'collector', 'arterial', 'highway'];
const clamp = (v, a, b, fallback) => Math.min(b, Math.max(a, Number.isFinite(Number(v)) ? Number(v) : fallback));
const identifier = v => String(v ?? '').slice(0, 100);
const length = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

function sanitizeGeography(g) {
  if (!g?.river || !Array.isArray(g.river.points)) return undefined;
  const point = p => ({ x: clamp(p.x, -20000, 20000, 0), z: clamp(p.z, -20000, 20000, 0) });
  return { generator: 'organic-growth-v2',
    river: { points: g.river.points.slice(0, 300).map(point), width: clamp(g.river.width, 10, 300, 60) },
    centres: (g.centres || []).slice(0, 20).map(c => ({ ...point(c), radius: clamp(c.radius, 10, 5000, 300),
      weight: clamp(c.weight, 0, 4, 1), angle: clamp(c.angle, -10, 10, 0), style: ['historic', 'urban', 'suburban'].includes(c.style) ? c.style : 'urban' })),
    parks: (g.parks || []).slice(0, 40).map(p => ({ ...point(p), rx: clamp(p.rx, 10, 3000, 100), rz: clamp(p.rz, 10, 3000, 100),
      angle: clamp(p.angle, -10, 10, 0), kind: p.kind === 'hill' ? 'hill' : 'park' })),
  };
}

export function sanitizeSDMap(value) {
  if (!value || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) return null;
  return { version: SD_VERSION, seed: Math.round(clamp(value.seed, 1, 99999999, 1)),
    nodes: value.nodes.slice(0, 1200).map(n => ({ id: identifier(n.id),
      x: clamp(n.x, -10000, 10000, 0), z: clamp(n.z, -10000, 10000, 0), y: clamp(n.y, -100, 100, 0) })),
    edges: value.edges.slice(0, 2400).map(e => ({ id: identifier(e.id), from: identifier(e.from), to: identifier(e.to),
      class: ROAD_CLASSES.includes(e.class) ? e.class : 'local',
      lanesForward: Math.round(clamp(e.lanesForward, 0, 4, 1)), lanesBackward: Math.round(clamp(e.lanesBackward, 0, 4, 1)),
      layer: Math.round(clamp(e.layer, -1, 1, 0)),
      ...(e.crossing === 'water' ? { crossing: 'water' } : {}),
      ...(Number.isFinite(e.bridgeHeight) ? { bridgeHeight: clamp(e.bridgeHeight, 0, 20, 3) } : {}),
    })),
    ...(value.geography ? { geography: sanitizeGeography(value.geography) } : {}),
  };
}

export function generateSDMap(cfg) {
  return growUrbanMap(cfg);
}

// Normalize same-level crossings into real junctions. Different layers retain
// independent edges; a geometric crossing is never a lane connection by itself.
export function splitAtGradeCrossings(source) {
  const map = structuredClone(source), nodes = new Map(map.nodes.map(n => [n.id, n]));
  const cuts = new Map(map.edges.map(e => [e.id, [{ t: 0, id: e.from }, { t: 1, id: e.to }]]));
  for (let i = 0; i < map.edges.length; i++) for (let j = i + 1; j < map.edges.length; j++) {
    const a = map.edges[i], b = map.edges[j];
    if (a.layer !== 0 || b.layer !== 0) continue;
    const ap = nodes.get(a.from), aq = nodes.get(a.to), bp = nodes.get(b.from), bq = nodes.get(b.to);
    if (!ap || !aq || !bp || !bq) continue;
    const p = segmentIntersection(ap, aq, bp, bq);
    if (!p) continue;
    const aInside = p.t > 1e-5 && p.t < 1 - 1e-5, bInside = p.u > 1e-5 && p.u < 1 - 1e-5;
    if (!aInside && !bInside) continue;
    const id = !aInside ? (p.t < 0.5 ? a.from : a.to) : !bInside ? (p.u < 0.5 ? b.from : b.to)
      : `cross-${p.x.toFixed(3)}-${p.z.toFixed(3)}`;
    if (!nodes.has(id)) { const node = { id, x: p.x, z: p.z, y: 0 }; nodes.set(id, node); map.nodes.push(node); }
    if (aInside) cuts.get(a.id).push({ t: p.t, id });
    if (bInside) cuts.get(b.id).push({ t: p.u, id });
  }
  map.edges = map.edges.flatMap(e => {
    const cut = cuts.get(e.id).sort((a, b) => a.t - b.t).filter((c, i, list) => i === 0 || c.t - list[i - 1].t > 1e-5);
    return cut.length === 2 ? [e] : cut.slice(1).map((c, i) => ({ ...e, id: `${e.id}:${i}`, from: cut[i].id, to: c.id }));
  });
  return map;
}

export function validateSDMap(map) {
  const errors = [], warnings = [], nodes = new Map(), adjacency = new Map(), edgeIds = new Set(), pairs = new Set();
  for (const n of map.nodes) {
    if (!n.id || nodes.has(n.id)) errors.push('SD 节点 ID 缺失或重复');
    if (![n.x, n.y, n.z].every(Number.isFinite)) errors.push(`节点 ${n.id} 坐标无效`);
    nodes.set(n.id, n); adjacency.set(n.id, []);
  }
  for (const e of map.edges) {
    if (!e.id || edgeIds.has(e.id)) errors.push('SD 道路 ID 缺失或重复');
    edgeIds.add(e.id);
    const a = nodes.get(e.from), b = nodes.get(e.to);
    if (!a || !b) { errors.push(`道路 ${e.id} 引用了不存在的节点`); continue; }
    if (e.from === e.to || length(a, b) < 12) errors.push(`道路 ${e.id} 长度不足 12 m`);
    if (e.lanesForward + e.lanesBackward < 1) errors.push(`道路 ${e.id} 没有可行驶车道`);
    const pair = [e.from, e.to].sort().join('>') + `/${e.layer}`;
    if (pairs.has(pair)) errors.push(`道路 ${e.id} 与同层道路重复`);
    pairs.add(pair);
    adjacency.get(e.from).push(e.to); adjacency.get(e.to).push(e.from);
  }
  for (const [id, neighbors] of adjacency) {
    const origin = nodes.get(id);
    for (let i = 0; i < neighbors.length; i++) for (let j = i + 1; j < neighbors.length; j++) {
      const a = nodes.get(neighbors[i]), b = nodes.get(neighbors[j]);
      const cross = (a.x - origin.x) * (b.z - origin.z) - (a.z - origin.z) * (b.x - origin.x);
      const dot = (a.x - origin.x) * (b.x - origin.x) + (a.z - origin.z) * (b.z - origin.z);
      const angle = Math.abs(Math.atan2(cross, dot));
      if (angle < 0.02) errors.push(`节点 ${id} 存在重叠的道路方向`);
      else if (angle < Math.PI / 9) warnings.push(`节点 ${id} 夹角较小，请检查车道和转弯空间`);
    }
  }
  let components = 0;
  const visited = new Set();
  for (const id of nodes.keys()) {
    if (visited.has(id)) continue;
    components++; const queue = [id]; visited.add(id);
    for (let i = 0; i < queue.length; i++) for (const next of adjacency.get(queue[i]) || []) {
      if (!visited.has(next)) { visited.add(next); queue.push(next); }
    }
  }
  if (components > 1) warnings.push(`路网有 ${components} 个独立连通分量`);
  const isolated = [...adjacency.values()].filter(a => a.length === 0).length;
  if (isolated) warnings.push(`${isolated} 个节点尚未连接道路`);
  return { valid: !errors.length, errors: [...new Set(errors)], warnings, components };
}

// Half-edge face traversal produces bounded city blocks from the actual graph.
// Repositioning a node changes its adjacent polygons; no stored block geometry
// or generator grid indices are consulted downstream.
export function extractBlocks(map) {
  const nodes = new Map(map.nodes.map(n => [n.id, n]));
  const outgoing = new Map(map.nodes.map(n => [n.id, []]));
  for (const edge of map.edges.filter(e => e.layer === 0)) {
    outgoing.get(edge.from)?.push({ to: edge.to, edgeId: edge.id });
    outgoing.get(edge.to)?.push({ to: edge.from, edgeId: edge.id });
  }
  for (const [id, list] of outgoing) {
    const p = nodes.get(id);
    list.sort((a, b) => Math.atan2(nodes.get(a.to).z - p.z, nodes.get(a.to).x - p.x) - Math.atan2(nodes.get(b.to).z - p.z, nodes.get(b.to).x - p.x));
  }
  const seen = new Set(), faces = [];
  for (const [start, list] of outgoing) for (const first of list) {
    const ring = [], edgeIds = [];
    let from = start, to = first.to;
    for (let step = 0; step <= map.edges.length * 2; step++) {
      const key = `${from}>${to}`;
      if (seen.has(key)) break;
      seen.add(key); ring.push(nodes.get(from));
      const options = outgoing.get(to), reverse = options.findIndex(o => o.to === from);
      edgeIds.push(outgoing.get(from).find(o => o.to === to).edgeId);
      const next = options[(reverse - 1 + options.length) % options.length];
      from = to; to = next.to;
      if (from === start && to === first.to) {
        const area = polygonArea(ring);
        if (area > 100) faces.push({ id: `block-${[...edgeIds].sort().join('_')}`, ring, edgeIds, area });
        break;
      }
    }
  }
  return faces;
}

export function polygonArea(ring) {
  return ring.reduce((a, p, i) => { const q = ring[(i + 1) % ring.length]; return a + p.x * q.z - q.x * p.z; }, 0) / 2;
}
