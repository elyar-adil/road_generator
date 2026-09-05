import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { matStd } from './render.js';
import { makeRoad, roadPoint, samplePath } from './corridor.js';
import { randomFromSeed } from './sd-map.js';
import { SEMANTIC_COLORS } from './semantics.js';
export { SEMANTIC_COLORS } from './semantics.js';

const CLASS_COLORS = { local: 0x8da9b8, collector: 0x65bfbe, arterial: 0xffc875, highway: 0xbe9cff };
const TURN_COLORS = { straight: 0x53b7ff, left: 0x6ae49b, right: 0xffa66e };
const semanticMaterials = new Map();
const semanticMaterial = kind => {
  if (!semanticMaterials.has(kind)) semanticMaterials.set(kind, new THREE.MeshBasicMaterial({ color: SEMANTIC_COLORS[kind], side: THREE.DoubleSide, toneMapped: false }));
  return semanticMaterials.get(kind);
};

function geometry(points, indices) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(points.flatMap(p => [p.x, p.y, p.z]), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(points.flatMap(p => [p.x / 4, p.z / 4]), 2));
  g.setIndex(indices); g.computeVertexNormals();
  return g;
}

function polygon(ring, y) {
  if (ring.length < 3) return null;
  const faces = THREE.ShapeUtils.triangulateShape(ring.map(p => new THREE.Vector2(p.x, p.z)), []);
  return geometry(ring.map(p => ({ ...p, y: y ?? p.y })), faces.flatMap(f => [f[0], f[2], f[1]]));
}

function quad(a, b, c, d) { return geometry([a, b, c, d], [0, 1, 2, 0, 2, 3]); }

class Batch {
  constructor(semantic) { this.parts = new Map(); this.semantic = semantic; }
  add(geo, material, kind = 'road') {
    if (!geo) return;
    const mat = this.semantic ? semanticMaterial(kind) : material;
    const key = `${kind}-${mat.uuid}`;
    if (!this.parts.has(key)) this.parts.set(key, { geos: [], mat, kind });
    this.parts.get(key).geos.push(geo);
  }
  box(x, y, z, w, h, d, material, kind, angle = 0) {
    const geo = new THREE.BoxGeometry(w, h, d); geo.rotateY(angle); geo.translate(x, y, z); this.add(geo, material, kind);
  }
  flush(group) {
    for (const { geos, mat, kind } of this.parts.values()) {
      const merged = mergeGeometries(geos);
      geos.forEach(g => g.dispose());
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = kind; mesh.userData.semanticClass = kind;
      mesh.castShadow = ['building', 'bridge', 'vegetation'].includes(kind);
      mesh.receiveShadow = true; group.add(mesh);
    }
  }
}

function strip(road, left, right, from = 0, to = road.path.at(-1).s, lift = 0) {
  if (to - from < 0.01) return null;
  const stations = [from, ...road.path.filter(p => p.s > from && p.s < to).map(p => p.s), to];
  const points = stations.flatMap(s => [roadPoint(road, s, left, lift), roadPoint(road, s, right, lift)]);
  const indices = [];
  for (let i = 0; i < stations.length - 1; i++) { const n = i * 2; indices.push(n, n + 1, n + 2, n + 1, n + 3, n + 2); }
  return geometry(points, indices);
}

function marking(batch, road, offset, width, from, to, color = 0xe9ebe4, lift = 0.028) {
  batch.add(strip(road, offset - width / 2, offset + width / 2, from, to, lift), matStd(color, 0.8), 'marking');
}

function dashed(batch, road, offset, from, to, color, dash = 3, gap = 5, width = 0.15, lift = 0.03) {
  for (let s = from; s < to; s += dash + gap) marking(batch, road, offset, width, s, Math.min(to, s + dash), color, lift);
}

function sweepWalls(batch, road, left, right, from, to, depth, mat, kind = 'bridge') {
  const stations = [from, ...road.path.filter(p => p.s > from && p.s < to).map(p => p.s), to];
  for (let i = 1; i < stations.length; i++) for (const side of [left, right]) {
    const a = roadPoint(road, stations[i - 1], side), b = roadPoint(road, stations[i], side);
    batch.add(quad(a, b, { ...b, y: b.y - depth }, { ...a, y: a.y - depth }), mat, kind);
  }
  for (const s of [from, to]) {
    const a = roadPoint(road, s, left), b = roadPoint(road, s, right);
    batch.add(quad(a, b, { ...b, y: b.y - depth }, { ...a, y: a.y - depth }), mat, kind);
  }
  batch.add(strip(road, left, right, from, to, -depth), mat, kind);
}

function arrow(batch, path, station, color, size = 2, lift = 0.08) {
  const p = samplePath(path, station), n = { x: -p.tz, z: p.tx };
  const point = (u, v) => ({ x: p.x + p.tx * u + n.x * v, y: p.y + lift, z: p.z + p.tz * u + n.z * v });
  batch.add(polygon([point(size, 0), point(-size * 0.4, size * 0.45), point(-size * 0.4, -size * 0.45)]), matStd(color), 'marking');
}

const facadeCache = new Map();
function facadeMaterial(variant) {
  if (facadeCache.has(variant)) return facadeCache.get(variant);
  const rand = randomFromSeed(variant + 73), data = new Uint8Array(64 * 64 * 4);
  const base = [[163, 154, 140], [130, 147, 151], [175, 173, 163], [133, 119, 105], [157, 169, 177], [187, 174, 151]][variant];
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const window = x > 10 && x < 51 && y > 15 && y < 52;
    const color = window ? [65, 88, 103] : base, noise = rand() * 9 - 4;
    const index = (y * 64 + x) * 4;
    for (let c = 0; c < 3; c++) data[index + c] = color[c] + noise + (window ? y * 0.25 : 0);
    data[index + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, 64, 64);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true; texture.colorSpace = THREE.SRGBColorSpace; texture.needsUpdate = true;
  const mat = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.8, side: THREE.DoubleSide });
  facadeCache.set(variant, mat); return mat;
}

function building(batch, b) {
  const bottom = 0.55, top = bottom + b.h;
  for (let i = 0; i < b.ring.length; i++) {
    const p = b.ring[i], q = b.ring[(i + 1) % b.ring.length], len = Math.hypot(q.x - p.x, q.z - p.z);
    const wall = quad({ ...p, y: bottom }, { ...q, y: bottom }, { ...q, y: top }, { ...p, y: top });
    wall.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, len / 3, 0, len / 3, b.floors, 0, b.floors], 2));
    batch.add(wall, facadeMaterial(b.variant), 'building');
  }
  batch.add(polygon(b.ring, top), matStd(0x787c7d), 'building');
  batch.add(polygon(b.ring.slice().reverse(), bottom), matStd(0x787c7d), 'building');
  const roof = b.ring.map(p => ({ x: b.x + (p.x - b.x) * 0.4, z: b.z + (p.z - b.z) * 0.4 }));
  batch.add(polygon(roof, top + 0.8), matStd(0xa2a6a5), 'building');
  for (let i = 0; i < roof.length; i++) batch.add(quad({ ...roof[i], y: top }, { ...roof[(i + 1) % roof.length], y: top },
    { ...roof[(i + 1) % roof.length], y: top + 0.8 }, { ...roof[i], y: top + 0.8 }), matStd(0xa2a6a5), 'building');
}

// Small deterministic branching grammar, down to individual diamond leaves.
// Every tree is reproducible from its own semantic seed, without asset files.
function tree(batch, tree) {
  const rand = randomFromSeed(tree.seed), size = tree.size;
  const trunk = new THREE.CylinderGeometry(0.09 * size / 5, 0.17 * size / 5, size * 0.7, 5);
  trunk.translate(tree.x, size * 0.35, tree.z); batch.add(trunk, matStd(0x6b5945), 'vegetation');
  for (let i = 0; i < 7; i++) {
    const angle = i * 2.4 + rand() * 0.5, y = size * (0.35 + i * 0.065);
    const a = new THREE.Vector3(tree.x, y, tree.z);
    const b = new THREE.Vector3(tree.x + Math.cos(angle) * size * 0.25, y + size * 0.15, tree.z + Math.sin(angle) * size * 0.25);
    const branch = new THREE.CylinderGeometry(0.03, 0.065, a.distanceTo(b), 4);
    branch.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()));
    branch.translate(...a.clone().add(b).multiplyScalar(0.5).toArray()); batch.add(branch, matStd(0x6b5945), 'vegetation');
    for (let leaf = 0; leaf < 14; leaf++) {
      const cx = b.x + (rand() - 0.5) * size * 0.32, cy = b.y + (rand() - 0.5) * size * 0.23, cz = b.z + (rand() - 0.5) * size * 0.32;
      const radius = size * (0.045 + rand() * 0.025), theta = rand() * Math.PI * 2;
      const ux = Math.cos(theta) * radius, uz = Math.sin(theta) * radius;
      batch.add(quad({ x: cx - ux, y: cy, z: cz - uz }, { x: cx + uz * 0.5, y: cy + radius * 0.35, z: cz - ux * 0.5 },
        { x: cx + ux, y: cy + radius * 0.2, z: cz + uz }, { x: cx - uz * 0.5, y: cy - radius * 0.35, z: cz + ux * 0.5 }),
      matStd([0x527745, 0x698849, 0x3f6b42][leaf % 3]), 'vegetation');
    }
  }
}

export function renderCity(city, group, cfg) {
  const mode = cfg.cityView, schematic = mode === 'sd', hd = mode === 'hd';
  // Planning projection exposes subsurface lanes; physical elevations remain in
  // the authoring/HD data and are used by the scene and export views.
  if(hd) city={...city,
    roads:city.roads.map(r=>({...r,path:r.path.map(p=>({...p,y:0.32+Math.abs(r.layer)*0.02}))})),
    lanes:city.lanes.map(l=>({...l,path:l.path.map(p=>({...p,y:0.4}))})),
    connectors:city.connectors.map(c=>({...c,path:c.path.map(p=>({...p,y:0.4}))})),
  };
  const batch = new Batch(mode === 'semantic');
  const geography=city.sd.geography;
  if(geography){
    const river=makeRoad('river',geography.river.points.map(p=>({...p,y:schematic?0.12:0.02})));
    batch.add(strip(river,-geography.river.width/2-7,geography.river.width/2+7),matStd(schematic?0x304b46:0x798975),'block');
    batch.add(strip(river,-geography.river.width/2,geography.river.width/2,0,river.path.at(-1).s,0.015),matStd(schematic?0x315d71:0x527d88,0.4),'water');
    for(const park of geography.parks){
      const ring=Array.from({length:48},(_,i)=>{const a=i/48*Math.PI*2,dx=Math.cos(a)*park.rx,dz=Math.sin(a)*park.rz;
        return {x:park.x+dx*Math.cos(park.angle)-dz*Math.sin(park.angle),z:park.z+dx*Math.sin(park.angle)+dz*Math.cos(park.angle)};});
      batch.add(polygon(ring,0.045),matStd(schematic?0x293e31:0x587746),'block');
    }
  }
  if (schematic) {
    for (const block of city.blocks) batch.add(polygon(block.ring, 0.05), matStd(block.park ? 0x355343 : 0x263946), 'block');
    for (const road of city.roads) {
      const flat = makeRoad(road.id, road.path.map(p => ({ ...p, y: 0.4 + Math.abs(road.layer) * 0.05 })));
      if (road.layer < 0) dashed(batch, flat, 0, 0, flat.path.at(-1).s, CLASS_COLORS[road.kind], 12, 7, 2.4);
      else {
        const width={local:1.5,collector:2.1,arterial:3.0,highway:4.0}[road.kind];
        batch.add(strip(flat,-width-0.6,width+0.6,0,flat.path.at(-1).s,-0.03),matStd(0x142026),'topology');
        batch.add(strip(flat,-width,width),matStd(CLASS_COLORS[road.kind]),'topology');
      }
    }
    for (const node of city.sd.nodes) {
      const degree=city.sd.edges.filter(e=>e.from===node.id||e.to===node.id).length;
      if(!cfg.sdNodesVisible&&degree<3)continue;
      const radius=cfg.sdNodesVisible?3.2:1.4;
      const g = new THREE.CylinderGeometry(radius,radius,0.12,12); g.translate(node.x, 0.7, node.z);
      batch.add(g, matStd(0xe3f3ec), 'topology');
    }
    batch.flush(group); return;
  }
  for (const road of city.roads) {
    const from = road.trimStart, to = road.path.at(-1).s - road.trimEnd;
    const left = -road.width / 2, right = road.width / 2;
    batch.add(strip(road, left, right, from, to), matStd(hd ? 0x253039 : 0x34383b, 0.95), 'road');
    if (!hd) sweepWalls(batch, road, left, right, from, to, road.depth, matStd(0x959b9b), road.structure ? 'bridge' : 'road');
    if (!hd && cfg.showSidewalk && road.layer===0 && road.kind!=='highway') {
      for(const side of [-1,1]){
        const inner=side*(road.width/2+0.2),outer=side*(road.width/2+cfg.sidewalkWidth);
        batch.add(strip(road,Math.min(inner,outer),Math.max(inner,outer),from,to,0.15),matStd(0xacaaa1),'sidewalk');
        const curb=makeRoad('curb',road.path.map(p=>({...roadPoint(road,p.s,inner),y:p.y+0.15})));
        batch.add(strip(curb,-0.14,0.14,from,to),matStd(0xc2c0b4),'sidewalk');
        sweepWalls(batch,curb,-0.14,0.14,from,to,0.15,matStd(0xc2c0b4),'sidewalk');
      }
    }
    const m0 = road.markingStart, m1 = road.path.at(-1).s - road.markingEnd;
    if (!hd) {
      const centre = -road.centreOffset;
      if (road.median) for (const side of [-1, 1]) marking(batch, road, centre + side * Math.max(0.12, road.median / 2), 0.12, m0, m1, 0xead38a);
      for (const dir of [1, -1]) {
        const count = dir === 1 ? road.lanesForward : road.lanesBackward;
        for (let i = 1; i < count; i++) dashed(batch, road, centre + dir * (road.median / 2 + i * road.laneWidth), m0, m1, 0xe9ebe4, road.kind === 'highway' ? 6 : 3, road.kind === 'highway' ? 9 : 5);
      }
      for (const side of [left + road.shoulder, right - road.shoulder]) marking(batch, road, side, 0.15, m0, m1);
      if (cfg.showCrosswalk && road.kind !== 'highway') {
        for (const [station, trim, crossing] of [[from + 3, road.trimStart, road.crossingStart], [to - 3, road.trimEnd, road.crossingEnd]]) {
          if (trim < 1 || !crossing) continue;
          for (let offset = left + 0.6; offset < right - 0.5; offset += 1) batch.add(strip(road, offset, Math.min(right - 0.4, offset + 0.48), station - 1.3, station + 1.3, 0.035), matStd(0xe9ebe4), 'marking');
        }
      }
    }
    if (!hd && road.structure) {
      for (const offset of [left + 0.3, right - 0.3]) {
        const rail = makeRoad('barrier', road.path.map(p => ({ ...roadPoint(road, p.s, offset), y: p.y + 0.85 })));
        batch.add(strip(rail, -0.18, 0.18, from + 4, to - 4), matStd(0xbfc2bb), 'bridge');
        sweepWalls(batch, rail, -0.24, 0.24, from + 4, to - 4, 0.85, matStd(0xbfc2bb));
      }
    }
  }
  for (const junction of city.junctions) batch.add(polygon(junction.ring, junction.y), matStd(hd ? 0x253039 : 0x34383b), 'road');
  for (const lane of city.lanes) {
    if (hd) batch.add(strip(makeRoad(lane.id, lane.path), -0.22, 0.22, 0, lane.path.at(-1).s, 0.09), matStd(lane.direction === 1 ? 0x72cfdf : 0xddc48a), 'topology');
    if (hd || cfg.showArrows) arrow(batch, lane.path, Math.max(2, lane.path.at(-1).s - 14), hd ? 0xb6eee6 : 0xe9ebe4, hd ? 1.8 : 1.5);
  }
  if (hd || cfg.showTopology) for (const connector of city.connectors) {
    batch.add(strip(makeRoad(connector.id, connector.path), -0.2, 0.2, 0, connector.path.at(-1).s, 0.1), matStd(TURN_COLORS[connector.movement]), 'topology');
    arrow(batch, connector.path, connector.path.at(-1).s * 0.6, TURN_COLORS[connector.movement], 0.9, 0.12);
  }
  if (!hd) {
    for (const block of city.blocks) batch.add(polygon(block.ring, 0.11), matStd(block.park ? 0x6b8656 : 0x829071), 'block');
    if (cfg.showBuildings) { city.buildings.forEach(b => building(batch, b)); city.trees.forEach(t => tree(batch, t)); }
    for (const support of city.supports) {
      const capHeight = 0.65;
      batch.box(support.x, (support.top - capHeight) / 2, support.z, 1.4, support.top - capHeight, 1.4, matStd(0xb3b4a9), 'bridge');
      batch.box(support.x, support.top - capHeight / 2, support.z, 2.2, capHeight, support.width, matStd(0xb3b4a9), 'bridge', -Math.atan2(support.tz || 0, support.tx || 1));
    }
  }
  batch.flush(group);
  group.userData = { generator: 'sd-hd-city-v1', seeds: city.seeds, units: 'metres' };
}
