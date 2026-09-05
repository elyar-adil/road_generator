// Population-guided street growth with local geometric constraints. A fourfold
// direction field blends neighborhood orientations, radial streets and river
// tangents, following the global-goal/local-constraint approach to street design.
import { hashSeed, randomFromSeed, segmentIntersection } from './map-utils.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const project = (p, a, b) => {
  const dx = b.x - a.x, dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
  const q = { x: a.x + t * dx, z: a.z + t * dz };
  return { ...q, t, distance: dist(p, q) };
};

export function growUrbanMap(cfg) {
  const random = randomFromSeed(hashSeed(cfg.scenerySeed, 'organic-streets-v2'));
  const half = cfg.citySize / 2, scale = half / 900;
  const organic = cfg.cityOrganic ?? 0.8;
  const phase = random() * Math.PI * 2, rotation = -0.35 + random() * 0.7;
  const riverWidth = (48 + random() * 20) * scale;
  const riverX = z => half * (0.12 * Math.sin(z / half * 2.6 + phase) + 0.05 * Math.sin(z / half * 6.5 + phase * 0.5));
  const riverAngle = z => Math.atan2(1, (riverX(z + 1) - riverX(z - 1)) / 2);
  const bank = 175 * scale;
  const centres = [
    { x: riverX(-half * 0.25) - half * 0.4, z: -half * 0.25, radius: half * 0.4, weight: 1.05, angle: 0.12 + random() * 0.25, style: 'historic' },
    { x: riverX(half * 0.22) + half * 0.38, z: half * 0.22, radius: half * 0.45, weight: 0.95, angle: -0.3 + random() * 0.3, style: 'urban' },
    { x: -half * 0.56, z: half * 0.52, radius: half * 0.32, weight: 0.6, angle: -0.3, style: 'suburban' },
  ];
  const parks = [{ x: -half * 0.72, z: -half * 0.68, rx: half * 0.13, rz: half * 0.13, kind: 'hill' },
    { x: half * 0.64, z: -half * 0.42, rx: half * 0.15, rz: half * 0.12, kind: 'park' }];
  const land = (p, margin = 0) => Math.abs(p.x - riverX(p.z)) > riverWidth / 2 + 18 * scale + margin;
  const inPark = p => parks.some(k => ((p.x - k.x) / k.rx) ** 2 + ((p.z - k.z) / k.rz) ** 2 < 1);
  const density = p => Math.min(1, centres.reduce((t, c) => t + c.weight * Math.exp(-((p.x - c.x) ** 2 + (p.z - c.z) ** 2) / (c.radius ** 2)), 0));
  const inside = p => { const a = Math.atan2(p.z, p.x);
    return Math.hypot(p.x * 0.95, p.z) < half * (0.86 + 0.075 * Math.sin(a * 3 + phase) + 0.05 * Math.cos(a * 5 - phase)); };
  function field(p, previous) {
    let x = 0, z = 0;
    for (const c of centres) {
      const d = dist(p, c), w = Math.exp(-d * d / (c.radius * c.radius * 0.7));
      const a = c.angle + (0.07+0.12*organic) * Math.sin(p.x / (half * 0.3) + phase) + (0.05+0.12*organic) * Math.cos(p.z / (half * 0.38));
      const blend = c.style === 'historic' ? Math.min(0.6, d / (c.radius * 1.7)) : 0;
      const radial = Math.atan2(p.z - c.z, p.x - c.x);
      x += w * (blend * Math.cos(radial * 4) + (1 - blend) * Math.cos(a * 4));
      z += w * (blend * Math.sin(radial * 4) + (1 - blend) * Math.sin(a * 4));
    }
    const influence = 0.7 * Math.exp(-Math.abs(p.x - riverX(p.z)) / (half * 0.2));
    x += influence * Math.cos(riverAngle(p.z) * 4); z += influence * Math.sin(riverAngle(p.z) * 4);
    const base = Math.atan2(z, x) / 4;
    const direction = [0, 1, 2, 3].map(i => base + i * Math.PI / 2).sort((a, b) => Math.abs(wrap(a - previous)) - Math.abs(wrap(b - previous)))[0];
    const bend = 0.12 + 0.16 * organic;
    return previous + Math.max(-bend, Math.min(bend, wrap(direction - previous)));
  }
  const nodes = [], edges = [], byId = new Map();
  let nodeIndex = 0, edgeIndex = 0;
  function addNode(p) { const n = { id: `n${++nodeIndex}`, x: p.x, z: p.z, y: 0 }; nodes.push(n); byId.set(n.id, n); return n; }
  function addEdge(a, b, cls, layer = 0, extra = {}) {
    const e = { id: `r${++edgeIndex}`, from: a.id, to: b.id, class: cls, layer,
      lanesForward: cls === 'arterial' ? 2 : 1, lanesBackward: cls === 'arterial' ? 2 : 1, ...extra };
    edges.push(e); return e;
  }
  function splitEdge(e, p) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (dist(p, a) < 24 * scale) return a;
    if (dist(p, b) < 24 * scale) return b;
    const n = addNode(p), oldTo = e.to; e.to = n.id;
    edges.push({ ...e, id: `r${++edgeIndex}`, from: n.id, to: oldTo }); return n;
  }
  function angleClear(a, b) {
    const proposed = Math.atan2(b.z - a.z, b.x - a.x);
    return edges.filter(e => e.from === a.id || e.to === a.id).every(e => {
      const n = byId.get(e.from === a.id ? e.to : e.from);
      return Math.abs(wrap(Math.atan2(n.z - a.z, n.x - a.x) - proposed)) > Math.PI / 6;
    });
  }
  // Snapping changes a segment's direction: validate the adjusted segment too,
  // otherwise it can cut a tiny unintended junction into a neighboring street.
  function visible(a,b,ignore=null){
    return !edges.some(e=>{
      if(e===ignore||e.from===a.id||e.to===a.id||e.from===b.id||e.to===b.id)return false;
      const hit=segmentIntersection(a,b,byId.get(e.from),byId.get(e.to));
      return hit&&hit.t>1e-5&&hit.t<1-1e-5;
    });
  }
  function addConstrained(start, wanted, cls) {
    if (!inside(wanted) || !land(wanted, 7 * scale) || inPark(wanted)) return null;
    if ([0.25, 0.5, 0.75].some(t => {const p={ x: start.x + (wanted.x - start.x) * t, z: start.z + (wanted.z - start.z) * t };
      return !land(p,5*scale)||inPark(p);})) return null;
    if (!angleClear(start, wanted)) return null;
    let hit = null, hitEdge = null;
    for (const e of edges) {
      if (e.from === start.id || e.to === start.id) continue;
      const p = segmentIntersection(start, wanted, byId.get(e.from), byId.get(e.to));
      if (p && p.t > 0.001 && (!hit || p.t < hit.t)) { hit = p; hitEdge = e; }
    }
    function connectToSegment(e, p) {
      if (e.layer !== 0 || dist(start, p) < 32 * scale) return null;
      const a = byId.get(e.from), b = byId.get(e.to);
      const angle = Math.abs(wrap(Math.atan2(p.z - start.z, p.x - start.x) - Math.atan2(b.z - a.z, b.x - a.x)));
      if (Math.min(angle, Math.PI - angle) < Math.PI / 6) return null;
      const near = dist(p, a) < 24 * scale ? a : dist(p, b) < 24 * scale ? b : null;
      if (near && (!angleClear(near, start) || !angleClear(start, near))) return null;
      if(!visible(start,near||p,e))return null;
      const target = near || splitEdge(e, p); addEdge(start, target, cls); return { node: target, terminal: true };
    }
    if (hit) return connectToSegment(hitEdge, hit);
    const nearby = nodes.filter(n => n.id !== start.id && dist(n, wanted) < 29 * scale).sort((a, b) => dist(a, wanted) - dist(b, wanted));
    if (nearby.length) {
      const n = nearby[0];
      if (dist(start, n) < 32 * scale || !angleClear(start, n) || !angleClear(n, start)) return null;
      if(!visible(start,n))return null;
      addEdge(start, n, cls); return { node: n, terminal: true };
    }
    let closest = null;
    for (const e of edges.filter(e => e.from !== start.id && e.to !== start.id)) {
      const p = project(wanted, byId.get(e.from), byId.get(e.to));
      if (!closest || p.distance < closest.p.distance) closest = { e, p };
    }
    if (closest && closest.p.distance < 24 * scale) return connectToSegment(closest.e, closest.p);
    const midpoint = { x: (start.x + wanted.x) / 2, z: (start.z + wanted.z) / 2 };
    if (edges.some(e => e.from !== start.id && e.to !== start.id && project(midpoint, byId.get(e.from), byId.get(e.to)).distance < 24 * scale)) return null;
    const end = addNode(wanted); addEdge(start, end, cls); return { node: end, terminal: false };
  }
  // Riverbank corridors and deliberately scarce crossings form the skeleton.
  const bankNodes = [[], []], samples = 18;
  for (const [index, side] of [[0, -1], [1, 1]]) for (let i = 0; i <= samples; i++) {
    const z = -half * 0.85 + i / samples * half * 1.7;
    const n = addNode({ x: riverX(z) + side * bank, z }); bankNodes[index].push(n);
    if (i) addEdge(bankNodes[index][i - 1], n, 'arterial');
  }
  for (const i of [5, 12]) addEdge(bankNodes[0][i], bankNodes[1][i], 'arterial', 1, { crossing: 'water', bridgeHeight: 2.6 * scale });
  // An older settlement has a small radial core and a former wall road. Later
  // neighborhood streets grow into this skeleton rather than erasing its form.
  const oldTown=centres[0],ring=[];
  for(let i=0;i<20;i++){
    const a=i/20*Math.PI*2, radius=half*0.145*(1+0.07*Math.sin(a*3+phase));
    ring.push(addNode({x:oldTown.x+Math.cos(a)*radius,z:oldTown.z+Math.sin(a)*radius*0.88}));
    if(i)addEdge(ring[i-1],ring[i],'collector');
  }
  addEdge(ring.at(-1),ring[0],'collector');
  const hub=addNode(oldTown);
  for(const i of [0,4,8,12,16])addEdge(hub,ring[i],'collector');
  for(const candidate of [...bankNodes[0]].sort((a,b)=>dist(a,ring[0])-dist(b,ring[0]))){
    if(addConstrained(candidate,ring[0],'arterial'))break;
  }
  for (const [index, side] of [[0, -1], [1, 1]]) for (const i of [2, 5, 9, 12, 16]) {
    let current = bankNodes[index][i], heading = side < 0 ? Math.PI : 0;
    for (let step = 0; step < 10; step++) {
      heading = field(current, heading) + 0.025 * Math.sin(step * 0.7 + i);
      const stride = (90 + random() * 20) * scale;
      const result = addConstrained(current, { x: current.x + Math.cos(heading) * stride, z: current.z + Math.sin(heading) * stride }, 'arterial');
      if (!result || result.terminal) break;
      current = result.node;
    }
  }
  // Central neighborhoods fill first. Spacing increases as population falls.
  const queue = [];
  for (const n of [...nodes]) {
    const incident = edges.find(e => e.layer === 0 && (e.from === n.id || e.to === n.id));
    if (!incident) continue;
    const other = byId.get(incident.from === n.id ? incident.to : incident.from);
    const heading = Math.atan2(n.z - other.z, n.x - other.x);
    for (const sign of [-1, 1]) queue.push({ node: n, heading: heading + sign * Math.PI / 2, priority: random() * 4, depth: 0 });
  }
  let attempts = 0;
  const nodeBudget = Math.min(1100, Math.round(680 * (cfg.citySize / 1800) ** 1.4 * (120 / cfg.cityBlockSize)));
  while (queue.length && nodes.length < nodeBudget && attempts++ < 6000) {
    queue.sort((a, b) => a.priority - b.priority);
    const task = queue.shift(), population = density(task.node);
    if (task.depth > 14 || population < 0.12 || (task.depth > 2 && random() > 0.58 + population * 0.42)) continue;
    const heading = field(task.node, task.heading);
    const stride = cfg.cityBlockSize * (0.48 + (1 - population) * 0.35) * (0.9 + random() * 0.2);
    const end = { x: task.node.x + Math.cos(heading) * stride, z: task.node.z + Math.sin(heading) * stride };
    const result = addConstrained(task.node, end, task.depth < 2 && population < 0.6 ? 'collector' : 'local');
    if (!result || result.terminal) continue;
    const priority = task.priority + 1 + (1 - density(end)) * 3;
    queue.push({ node: result.node, heading, priority, depth: task.depth + 1 });
    for (const sign of [-1, 1]) if (random() < 0.45 + population * 0.4) queue.push({ node: result.node,
      heading: heading + sign * Math.PI / 2, priority: priority + 0.4 + random(), depth: task.depth + 1 });
  }
  const rotate = p => ({ x: p.x * Math.cos(rotation) - p.z * Math.sin(rotation), z: p.x * Math.sin(rotation) + p.z * Math.cos(rotation) });
  nodes.forEach(n => Object.assign(n, rotate(n)));
  const river = Array.from({ length: 81 }, (_, i) => { const z = -half * 1.5 + i / 80 * half * 3; return rotate({ x: riverX(z), z }); });
  return { version: 1, seed: cfg.scenerySeed, nodes, edges,
    geography: { river: { points: river, width: riverWidth }, centres: centres.map(c => ({ ...c, ...rotate(c), angle: c.angle + rotation })),
      parks: parks.map(p => ({ ...p, ...rotate(p), angle: rotation })), generator: 'organic-growth-v2' } };
}
