import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { matStd } from './render.js';
import { makeRoad, roadPoint, samplePath, smoothstep, distanceToRoad } from './corridor.js';
import { randomFromSeed, hashSeed } from './sd-map.js';
import { ARROW_LENGTH, arrowPolygons } from './lane-derive.js';
import { JUNCTION_SPEC as SPEC } from './junction-spec.js';
import { SEMANTIC_COLORS } from './semantics.js';
export { SEMANTIC_COLORS } from './semantics.js';

const CLASS_COLORS = { local: 0x8da9b8, collector: 0x65bfbe, arterial: 0xffc875, highway: 0xbe9cff };
const TURN_COLORS = { straight: 0x53b7ff, left: 0x6ae49b, right: 0xffa66e };
const semanticMaterials = new Map();
const semanticMaterial = kind => {
  if (!semanticMaterials.has(kind)) semanticMaterials.set(kind, new THREE.MeshBasicMaterial({ color: SEMANTIC_COLORS[kind], side: THREE.DoubleSide, toneMapped: false }));
  return semanticMaterials.get(kind);
};
// 语义视图里新缝进来的小物件归并到既有类别,类别清单保持稳定。
const SEMANTIC_OF = { wire: 'furniture', sign: 'furniture', tuft: 'vegetation' };

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

// Flat ring strip between two boundaries with matching point order (same
// count, same start) — used for sidewalk collars and roundabout carriageways
// where a triangulated polygon-with-hole is not robust.
function ribbon(batch, inner, outer, y, material, kind = 'sidewalk') {
  const n = Math.min(inner.length, outer.length);
  if (n < 3) return;
  const points = [];
  for (let i = 0; i < n; i++) {
    const a = inner[i], b = outer[i];
    points.push({ x: a.x, y: y ?? a.y, z: a.z }, { x: b.x, y: y ?? b.y, z: b.z });
  }
  const indices = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, k = i * 2;
    indices.push(k, k + 1, j * 2, k + 1, j * 2 + 1, j * 2);
  }
  batch.add(geometry(points, indices), material, kind);
}

// Road surface strip between a fixed inner offset and a station-dependent
// outer offset (both in metres) — used for junction approach widening tapers.
function variableStrip(batch, road, innerAt, outerAt, s0, s1, lift, material, kind) {
  const lo = Math.min(s0, s1), hi = Math.max(s0, s1), step = 2;
  const points = [];
  for (let s = lo; s < hi; s += step) points.push(roadPoint(road, s, innerAt(s), lift), roadPoint(road, s, outerAt(s), lift));
  points.push(roadPoint(road, hi, innerAt(hi), lift), roadPoint(road, hi, outerAt(hi), lift));
  const n = points.length / 2, indices = [];
  for (let i = 0; i + 1 < n; i++) {
    const k = i * 2;
    indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
  }
  batch.add(geometry(points, indices), material, kind);
}

function quad(a, b, c, d) { return geometry([a, b, c, d], [0, 1, 2, 0, 2, 3]); }

export class Batch {
  constructor(semantic) { this.parts = new Map(); this.semantic = semantic; }
  add(geo, material, kind = 'road') {
    if (!geo) return;
    const semKind = SEMANTIC_OF[kind] || kind;
    const mat = this.semantic ? semanticMaterial(semKind) : material;
    // 语义视图按 kind 合并且无光照:统一剥掉 color/uv/normal 只留
    // position,否则同一 kind 里属性不一致(如树叶无 uv)会合并失败。
    if (this.semantic) ['color', 'uv', 'normal', 'aLeafCard'].forEach(name => geo.attributes[name] && geo.deleteAttribute(name));
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
      mesh.name = kind; mesh.userData.semanticClass = SEMANTIC_OF[kind] || kind;
      mesh.castShadow = ['building', 'bridge', 'vegetation', 'furniture', 'sign'].includes(kind);
      mesh.receiveShadow = true; group.add(mesh);
    }
  }
}

export function collectKind(batch, kind) {
  const out = [];
  for (const { geos, kind: k } of batch.parts.values()) if (k === kind) out.push(...geos);
  return out;
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
  batch.add(strip(road, offset - width / 2, offset + width / 2, from, to, lift),
    color === 0xe9ebe4 ? paintMaterial() : matStd(color, 0.8), 'marking');
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

// Design-spec drive arrows (shapes shared with the local junction editor)
// placed on each approach lane just upstream of the junction trim. Shape
// units are centimetres, so scale = metres / ARROW_LENGTH. The tipGap keeps
// the arrow clear of the crosswalk band, which scene view paints at
// [trim-4.3, trim-1.7]; the arrow must sit in front of that, never on it.
// The lateral axis matches lane-derive's arrowOnPath frame: with hd-map
// labelling a turn 'right' when cross(dir, out) > 0, the arrow heads land on
// the side the connectors actually bend toward.
export function driveArrows(batch, lane, types) {
  const path = lane.path, total = path.at(-1).s;
  const tipGap = SPEC.arrow.tipGap, footprint = SPEC.arrow.footprint;
  const length = Math.min(footprint, total - tipGap - 1.5);
  if (length < 2.4) return;
  const scale = length / ARROW_LENGTH;
  const pose = samplePath(path, total - tipGap - length);
  const n = { x: pose.tz, z: -pose.tx };
  const at = (l, f) => ({ x: pose.x + (n.x * l + pose.tx * f) * scale,
    y: pose.y + 0.045, z: pose.z + (n.z * l + pose.tz * f) * scale });
  for (const poly of arrowPolygons(types))
    batch.add(polygon(poly.map(([l, f]) => at(l, f))), paintMaterial(), 'marking');
}

const facadeCache = new Map();
// Procedural ground materials. All road strips share world-space UVs
// (uv = x/4, z/4), so a 256px tile maps to a 4m patch — asphalt speckle
// lands at ~1.6cm/px, paving joints at 0.5m. A pixel function may return a
// fourth component: a 0..1 height, baked here into a tangent-space normal
// map (derivative tangents, no geometry attributes needed) so aggregate,
// paver joints and grass clumps catch raking sunlight instead of looking
// painted on.
const surfaceMats = new Map();
function proceduralMaterial(key, pixel, options = {}) {
  if (surfaceMats.has(key)) return surfaceMats.get(key);
  const rand = randomFromSeed(key.length * 131 + 7), size = options.size ?? 256;
  const data = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  let hasHeight = false;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const c = pixel(x, y, rand);
    const i = (y * size + x) * 4;
    for (let k = 0; k < 3; k++) data[i + k] = Math.max(0, Math.min(255, c[k]));
    data[i + 3] = 255;
    if (c.length > 3) { hasHeight = true; height[y * size + x] = c[3]; }
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true; texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 16;
  texture.needsUpdate = true;
  const mat = new THREE.MeshStandardMaterial({ map: texture, roughness: options.roughness ?? 0.95, metalness: options.metalness ?? 0 });
  if (hasHeight) {
    const nd = new Uint8Array(size * size * 4), bump = options.bump ?? 2.2;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const l = height[y * size + (x + size - 1) % size], r = height[y * size + (x + 1) % size];
      const u = height[((y + size - 1) % size) * size + x], d = height[((y + 1) % size) * size + x];
      const nx = (l - r) * bump, ny = (u - d) * bump;
      const len = Math.hypot(nx, ny, 1) || 1, i = (y * size + x) * 4;
      nd[i] = (nx / len * 0.5 + 0.5) * 255; nd[i + 1] = (ny / len * 0.5 + 0.5) * 255;
      nd[i + 2] = (1 / len * 0.5 + 0.5) * 255; nd[i + 3] = 255;
    }
    const normalMap = new THREE.DataTexture(nd, size, size);
    normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
    normalMap.magFilter = THREE.LinearFilter; normalMap.minFilter = THREE.LinearMipmapLinearFilter;
    normalMap.generateMipmaps = true; normalMap.needsUpdate = true;
    mat.normalMap = normalMap;
    mat.normalScale = new THREE.Vector2(options.normalScale ?? 0.6, options.normalScale ?? 0.6);
  }
  surfaceMats.set(key, mat);
  return mat;
}
// 旧沥青:多尺度叠加 —— 低频修补/泛白斑块、中频摊铺团块、高频骨料颗粒,
// 再掺少量亮石子。height 让骨料在斜射阳光下闪出颗粒感。
function asphaltMaterial() {
  return proceduralMaterial('asphalt', (x, y, rand) => {
    const patch = Math.sin(x * 0.043 + Math.sin(y * 0.031) * 2.7) * Math.cos(y * 0.037 + x * 0.017) * 6;
    const clump = (rand() - 0.5) * 22;
    const grain = (rand() - 0.5) * 13;
    const stone = rand() < 0.045 ? 24 : 0;
    const v = 62 + patch + clump * 0.5 + grain + stone;
    return [v * 0.97, v, v * 1.05, 0.5 + (grain + stone) / 56 + (clump < -9 ? -0.14 : 0)];
  }, { roughness: 0.97, bump: 1.7, normalScale: 0.5 });
}
// 人行道/街区铺装:0.5×0.25m 错缝砖 + 凹缝、逐块色差与污渍。height 把缝
// 压下去,转角的铺装就有了勾缝的立体感,不再是一张印在地上的图。
function pavingMaterial() {
  return proceduralMaterial('paving', (x, y, rand) => {
    const row = Math.floor(y / 16), off = (row % 2) * 16;
    const gx = (x + off) % 32, gy = y % 16;
    const joint = gx < 2 || gy < 2 ? -30 : 0;
    const bond = (Math.floor((x + off) / 32) + row) % 2 ? 5 : 0;
    const stain = Math.sin((x + row * 11) * 0.021) * Math.cos(y * 0.019) * 7;
    const n = (rand() - 0.5) * 7;
    const v = 152 + joint + bond + stain + n;
    return [v, v * 0.985, v * 0.94, 0.6 + (joint ? -0.42 : 0) + (rand() - 0.5) * 0.08];
  }, { roughness: 0.88, bump: 2.6, normalScale: 0.7 });
}
// 草地:低频色斑 + 细小叶簇 + 少量枯黄斑,压低饱和度(真草坪从不是纯绿)。
function grassMaterial() {
  return proceduralMaterial('grass', (x, y, rand) => {
    const patch = Math.sin(x * 0.09 + y * 0.05) * Math.sin(y * 0.07 + 1.3) * 10;
    const dry = Math.sin(x * 0.017 + 1.1) * Math.cos(y * 0.013) > 0.74;
    const blade = rand() < 0.09 ? 20 : (rand() - 0.5) * 13;
    const col = [76 + patch + blade, 98 + patch + blade, 54 + patch * 0.7 + blade * 0.8];
    if (dry) { col[0] += 32; col[1] += 16; col[2] -= 6; }
    return [...col, 0.5 + blade / 60 + (rand() - 0.5) * 0.3];
  }, { roughness: 0.98, bump: 1.4, normalScale: 0.55 });
}
// One texture tile covers a 3m x 12.8m facade patch (FOUR storeys), so a wall
// repeats it every 3m horizontally and every four floors vertically — 四行
// 窗型/明暗各不相同,打破"每一层都一模一样"的复印感。24 种_tile 按风格分组,
// 墙面再叠加逐栋的顶点色色调与 15% 概率的 U 镜像。
const FACADE_SPECS = [
  { base: [198, 188, 168], window: [96, 104, 112], cols: 2, sill: 0.34 },      // 0 residential warm
  { base: [176, 179, 176], window: [88, 97, 106], cols: 2, sill: 0.32 },       // 1 residential gray
  { base: [216, 211, 197], window: [112, 142, 154], cols: 3, sill: 0.28 },     // 2 waterfront light
  { base: [156, 100, 80], window: [64, 56, 54], cols: 2, sill: 0.36, brick: true }, // 3 brick
  { base: [208, 196, 168], window: [98, 118, 128], cols: 3, sill: 0.3 },       // 4 mixed-use beige
  { base: [150, 151, 149], window: [80, 92, 100], cols: 4, sill: 0.24, band: true }, // 5 concrete band
  { base: [190, 148, 120], window: [84, 90, 96], cols: 2, sill: 0.32 },        // 6 terracotta
  { base: [132, 136, 142], window: [98, 130, 142], cols: 3, sill: 0.3 },       // 7 blue-gray
  { base: [76, 90, 100], window: [134, 170, 186], cols: 4, glass: true },      // 8 glass tower
  { base: [66, 80, 88], window: [120, 160, 152], cols: 5, glass: true },       // 9 green glass
  { base: [90, 94, 106], window: [150, 152, 160], cols: 4, glass: true },      // 10 neutral glass
  { base: [112, 98, 90], window: [128, 150, 158], cols: 3, glass: true },      // 11 bronze glass
  { base: [58, 62, 70], window: [110, 150, 168], cols: 6, glass: true },       // 12 dark curtain wall
  { base: [168, 170, 172], window: [96, 118, 130], cols: 5, glass: true },     // 13 silver fins
  { base: [122, 96, 72], window: [150, 138, 116], cols: 4, glass: true },      // 14 champagne glass
  { base: [70, 92, 96], window: [128, 164, 170], cols: 5, glass: true },       // 15 teal glass
  { base: [214, 212, 206], window: [104, 116, 126], cols: 4, sill: 0.26 },     // 16 white slab
  { base: [142, 138, 130], window: [88, 96, 104], cols: 4, sill: 0.26, band: true }, // 17 gray grid
  { base: [186, 172, 148], window: [96, 110, 118], cols: 3, sill: 0.3 },       // 18 sandstone
  { base: [84, 86, 90], window: [118, 128, 136], cols: 5, sill: 0.22 },        // 19 dark granite
  { base: [226, 222, 212], window: [100, 110, 118], cols: 2, sill: 0.4 },      // 20 white minimal
  { base: [164, 132, 96], window: [76, 64, 54], cols: 2, sill: 0.36 },         // 21 wood tone
  { base: [142, 74, 60], window: [70, 58, 52], cols: 2, sill: 0.36, brick: true }, // 22 red brick
  { base: [172, 178, 164], window: [92, 104, 110], cols: 3, sill: 0.34 },      // 23 pastel sage
];
function facadeMaterial(variant) {
  const key = variant % FACADE_SPECS.length;
  if (facadeCache.has(key)) return facadeCache.get(key);
  const spec = FACADE_SPECS[key];
  const S = 128, data = new Uint8Array(S * S * 4);
  const rand = randomFromSeed(key * 131 + 17);
  // 逐窗明暗 hash:每扇窗的玻璃亮度/色温略有不同 —— 远看是真实幕墙的
  // 随机反光,近看不是千篇一律的色块。
  const cellHash = (i, j) => {
    const s = Math.sin(i * 127.1 + j * 311.7 + key * 74.7) * 43758.5453;
    return s - Math.floor(s);
  };
  // 四个楼层行各自抽一个窗型:矮窗 / 通高窗 / 带形窗。
  const rowStyle = row => cellHash(row * 7.3, key * 3.1);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const v = y / S;          // v=0 楼层底,v=1 覆盖 4 层
    const u = x / S;
    const row = Math.min(3, Math.floor(v * 4));
    const f = v * 4 - row;    // 本层内 0..1
    const col = Math.floor(u * spec.cols);
    const cf = u * spec.cols - col;
    const style = rowStyle(row);
    const wTop = 0.8 + (style - 0.5) * 0.14;
    const wBot = spec.glass ? 0.1 : Math.max(0.26, 0.32 + spec.sill * 0.4 - (style - 0.5) * 0.18);
    const mullion = spec.glass && cf > 0.92;   // 幕墙竖向窗棂
    let color;
    if (col < spec.cols && cf < (spec.glass ? 0.92 : 0.6) && f > wBot && f < wTop && !mullion) {
      const h = cellHash(col + key * 31, row * 17.3 + Math.floor(key * 5.7));
      const sheen = Math.floor(f * 8) % 4 === 0 ? 12 : 0;   // 窗内微弱横向反光条
      color = spec.window.map((c, k) => c * (0.5 + h * 0.85) + sheen + (rand() - 0.5) * 8);
    } else if (f > 0.9 || f < 0.08) {
      color = spec.base.map(c => c * 0.55 + 8);             // 楼板/层间梁深色带
    } else if (mullion) {
      color = spec.base.map(c => c * 0.45);
    } else {
      color = spec.base.map(c => c + (rand() - 0.5) * 10);
      if (spec.brick && y % 7 < 2) color = color.map(c => c + 16);
    }
    const index = (y * S + x) * 4;
    for (let c = 0; c < 3; c++) data[index + c] = Math.max(0, Math.min(255, color[c]));
    data[index + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, S, S);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true; texture.colorSpace = THREE.SRGBColorSpace; texture.needsUpdate = true;
  // vertexColors are set per wall so identical tiles never read as clones.
  // 玻璃塔楼:低粗糙度 + 金属度,靠天空 IBL 反射出高层幕墙的镜面感;
  // 实墙保持高粗糙度、弱反射,只接收适度环境光。
  const mat = spec.glass
    ? new THREE.MeshStandardMaterial({ map: texture, roughness: 0.34, metalness: 0.45, vertexColors: true, side: THREE.DoubleSide, envMapIntensity: 0.85 })
    : new THREE.MeshStandardMaterial({ map: texture, roughness: 0.82, vertexColors: true, side: THREE.DoubleSide, envMapIntensity: 0.55 });
  facadeCache.set(key, mat); return mat;
}

// 底层店面/门厅/入户:一张 4.2m x 3.2m 的贴图覆盖整个首层(不做纵向平铺),
// 商铺是石材基座 + 横向分格的玻璃橱窗 + 招牌带,住宅是门窗 + 台阶,写字楼
// 是通高玻璃与石柱。街景的真实感八成来自首层,没有它楼群就是一堆方盒。
const groundFloorCache = new Map();
function groundFloorMaterial(kind) {
  if (groundFloorCache.has(kind)) return groundFloorCache.get(kind);
  const S = 256, data = new Uint8Array(S * S * 4);
  const rand = randomFromSeed(kind.length * 977 + 41);
  const put = (x, y, c, a = 255) => {
    const i = (y * S + x) * 4;
    for (let k = 0; k < 3; k++) data[i + k] = Math.max(0, Math.min(255, c[k]));
    data[i + 3] = a;
  };
  const house = kind === 'home';
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S;
    let c;
    const grime = (rand() - 0.5) * 9 + (v < 0.1 ? -14 : 0);   // 底部积灰
    if (house) {
      const door = u > 0.42 && u < 0.58 && v > 0.08 && v < 0.78;
      const win = ((u > 0.07 && u < 0.37) || (u > 0.63 && u < 0.93)) && v > 0.32 && v < 0.84;
      if (door) {
        const panel = (x % 24 < 2 || y % 40 < 2) ? -18 : 0;
        c = [76 + panel + grime, 62 + panel + grime, 50 + panel + grime];
      } else if (win) {
        const frame = u < 0.095 || u > 0.915 || v < 0.35 || v > 0.81;
        c = frame ? [196, 192, 182] : [70 + 14 * (1 - v) + grime, 82 + 16 * (1 - v) + grime, 88 + 14 * (1 - v) + grime];
      } else c = [196 + grime, 190 + grime, 178 + grime];
    } else if (kind === 'lobby') {
      const pier = u < 0.06 || u > 0.94;
      const mullion = !pier && (x % 42 < 2);
      if (pier) c = [176 + grime, 172 + grime, 164 + grime];
      else if (mullion) c = [70, 74, 78];
      else {
        const sha = rand() < 0.03 ? 30 : 0;
        c = [72 + 20 * (1 - v) + grime + sha, 86 + 26 * (1 - v) + grime + sha, 96 + 30 * (1 - v) + grime + sha];
      }
    } else {
      const pier = u < 0.045 || (u > 0.49 && u < 0.535) || u > 0.955;
      const transom = !pier && v > 0.66 && v < 0.70;
      if (pier) c = [166 + grime, 162 + grime, 154 + grime];
      else if (transom) c = [58, 60, 64];
      else {
        const lit = rand() < 0.05;
        const sha = lit ? 34 + rand() * 26 : 0;
        c = [58 + 16 * (1 - v) + grime + sha, 68 + 18 * (1 - v) + grime + sha, 76 + 18 * (1 - v) + grime + sha];
      }
    }
    if (v < 0.13) {   // 石材基座,带勾缝
      const joint = (y % 26 < 2 || x % 64 < 2) ? -24 : 0;
      c = [96 + joint + grime * 0.6, 92 + joint + grime * 0.6, 86 + joint + grime * 0.6];
    } else if (v > 0.87 && !house) {   // 招牌/雨棚带
      c = [c[0] * 0.62, c[1] * 0.64, c[2] * 0.68];
    }
    put(x, y, c);
  }
  const texture = new THREE.DataTexture(data, S, S);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true; texture.needsUpdate = true;
  const mat = new THREE.MeshStandardMaterial({ map: texture, vertexColors: true, roughness: 0.78, side: THREE.DoubleSide, envMapIntensity: 0.5 });
  groundFloorCache.set(kind, mat);
  return mat;
}

// 店招:中国街景最有辨识度的一层。每 4m 一块招牌,底色/文字轮换,横向
// 沿街重复;无 DOM 的测试环境退化为纯色板。
const SIGN_TEXTS = ['便利店', '家常菜', '药房', '理发店', '五金建材', '水果超市', '快递驿站', '兰州拉面', '烟酒商行', '房产中介', '早餐铺', '打印照相'];
const SIGN_STYLES = [['#bf3a2b', '#fff7e6'], ['#1a5fb4', '#ffffff'], ['#e8b60f', '#3a2a08'],
  ['#167f45', '#ffffff'], ['#7a1f1f', '#ffe9c9'], ['#f2f2ec', '#b03030']];
let signMaterialsCache;
function signMaterials() {
  if (signMaterialsCache !== undefined) return signMaterialsCache;
  if (typeof document === 'undefined') { signMaterialsCache = null; return null; }
  signMaterialsCache = SIGN_TEXTS.map((text, i) => {
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 96;
    const ctx = canvas.getContext('2d');
    const [bg, fg] = SIGN_STYLES[i % SIGN_STYLES.length];
    ctx.fillStyle = bg; ctx.fillRect(0, 0, 512, 96);
    ctx.strokeStyle = 'rgba(0,0,0,0.22)'; ctx.lineWidth = 6; ctx.strokeRect(4, 4, 504, 88);
    ctx.fillStyle = fg;
    ctx.font = 'bold 58px "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, 256, 52);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping; texture.anisotropy = 8;
    return new THREE.MeshStandardMaterial({ map: texture, roughness: 0.55, side: THREE.FrontSide, envMapIntensity: 0.4 });
  });
  return signMaterialsCache;
}
// 单块招牌:v 取竖向 0..1,u 取整张 0..1 —— 每块正好一个完整店名。
// 必须离开墙面 0.15m,否则和上层墙体共面,深度测试五五开。uv 方向固定为
// "外法线左转 90°"(见 building 里的排序),不依赖环的绕向,店名不会镜像。
function addSignBoard(batch, a, b, y0, y1, material) {
  // 双面两块:正面朝外、背面朝内,各自配正确的 u 方向。招牌本来就两面都
  // 有字,这样无论环的绕向如何,街上看到的店名都不会镜像。
  const front = quad({ ...a, y: y0 }, { ...b, y: y0 }, { ...b, y: y1 }, { ...a, y: y1 });
  front.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  batch.add(front, material, 'sign');
  const back = quad({ ...a, y: y1 }, { ...b, y: y1 }, { ...b, y: y0 }, { ...a, y: y0 });
  back.setAttribute('uv', new THREE.Float32BufferAttribute([1, 1, 0, 1, 0, 0, 1, 0], 2));
  batch.add(back, material, 'sign');
}

// 首层墙面:UV 不做纵向平铺,水平按 4.2m 重复,让门窗/柱网保持真实尺度。
function addBaseWall(batch, a, b, y0, material, tint, mirror = 1) {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const wall = quad({ ...a, y: y0 }, { ...b, y: y0 }, { ...b, y: y0 + 3.2 }, { ...a, y: y0 + 3.2 });
  const u1 = len / 4.2 * mirror;
  wall.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, u1, 0, u1, 1, 0, 1], 2));
  const colors = new Float32Array(12);
  for (let i = 0; i < 4; i++) colors.set(tint, i * 3);
  wall.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  batch.add(wall, material, 'building');
}

function addWall(batch, a, b, y0, y1, material, tint, floors, mirror = 1) {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const wall = quad({ ...a, y: y0 }, { ...b, y: y0 }, { ...b, y: y1 }, { ...a, y: y1 });
  const u1 = len / 3 * mirror, v1 = floors / 4;   // 纹理纵向覆盖 4 层
  wall.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, u1, 0, u1, v1, 0, v1], 2));
  const colors = new Float32Array(12);
  for (let i = 0; i < 4; i++) colors.set(tint, i * 3);
  wall.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  batch.add(wall, material, 'building');
}

function ringBounds(ring) {
  const xs = ring.map(p => p.x), zs = ring.map(p => p.z);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}

const ROOF_TONES = [0x7b7f80, 0x716f6a, 0x84837c, 0x6d7472];
// 屋顶不是一块纯色板:砾石屋面 + 分格缝 + 局部污渍,俯视时楼顶才不塑料。
const roofMatCache = new Map();
function roofMaterial(tone) {
  if (roofMatCache.has(tone)) return roofMatCache.get(tone);
  const base = [(tone >> 16) & 255, (tone >> 8) & 255, tone & 255];
  const mat = proceduralMaterial(`roof-${tone.toString(16)}`, (x, y, rand) => {
    const n = (rand() - 0.5) * 17 + (rand() < 0.03 ? 12 : 0);
    const seam = (Math.floor(x / 64) * 7 + Math.floor(y / 64) * 13) % 29 === 0 ? -9 : 0;
    const stain = Math.sin(x * 0.021 + y * 0.017) * 5;
    return [base[0] + n + seam + stain, base[1] + n + seam + stain, base[2] + n + seam + stain,
      0.5 + (n + seam) / 64];
  }, { roughness: 0.94, bump: 1.3, normalScale: 0.45 });
  roofMatCache.set(tone, mat);
  return mat;
}
const PITCHED_TONES = [0x9a5a40, 0x8a5038, 0x7d6a52];
// Low parapet wall around a roof deck; the deck itself spans the full
// footprint so roofs never read as a small plateau floating on the slab.
function parapet(batch, ring, deckY, height, material) {
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    batch.add(quad({ ...p, y: deckY }, { ...q, y: deckY }, { ...q, y: deckY + height }, { ...p, y: deckY + height }),
      material, 'building');
  }
}
function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > z) !== (b.z > z) && x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function roofProps(batch, ring, top, rand, floors) {
  const b = ringBounds(ring), w = b.maxX - b.minX, d = b.maxZ - b.minZ;
  if (w < 9 || d < 9) return;
  // A prop is only placed when its whole footprint (plus a small margin)
  // sits inside the roof ring — bounding-box sampling alone lets props
  // overhang irregular parcel shapes.
  const place = (hw, hd) => {
    hw += 0.35; hd += 0.35;
    if (w < 2 * hw + 1 || d < 2 * hd + 1) return null;
    for (let tries = 0; tries < 8; tries++) {
      const x = b.minX + hw + rand() * (w - 2 * hw);
      const z = b.minZ + hd + rand() * (d - 2 * hd);
      if ([[-1, -1], [1, -1], [-1, 1], [1, 1]].every(([sx, sz]) => pointInRing(x + sx * hw, z + sz * hd, ring)))
        return { x, z };
    }
    return null;
  };
  const housing = place(1.25 + rand(), 1.1 + rand() * 0.8);
  if (housing) batch.box(housing.x, top + 1.35, housing.z, 3 + rand() * 2, 2.5, 2.2 + rand() * 1.6, matStd(0x9aa0a2), 'building');
  for (let i = 0, n = 1 + Math.floor(rand() * 3); i < n; i++) {
    const unit = place(0.5 + rand() * 0.5, 0.4 + rand() * 0.3);
    if (unit) batch.box(unit.x, top + 0.5, unit.z, 1 + rand(), 0.8, 0.8 + rand() * 0.6, matStd(0xb7bcbd), 'building');
  }
  if (floors > 16) {
    const tank = place(0.9, 0.9);
    if (tank) batch.box(tank.x, top + 1.6, tank.z, 1.8, 2.6, 1.8, matStd(0x8d9294), 'building');
    // 屋顶天线:高层天际线的剪影细节,远看也能把塔楼和方盒区分开。
    if (rand() < 0.75) {
      const mast = place(0.3, 0.3);
      if (mast) {
        const h = 3.5 + rand() * 3.5;
        const pole = new THREE.CylinderGeometry(0.04, 0.07, h, 5);
        pole.translate(mast.x, top + h / 2, mast.z);
        batch.add(pole, matStd(0xb7bcbd, 0.6), 'building');
        const tip = new THREE.SphereGeometry(0.1, 6, 6);
        tip.translate(mast.x, top + h, mast.z);
        batch.add(tip, matStd(0xb7bcbd, 0.6), 'building');
      }
    }
  }
}

// 逐层挑出的楼层线:住宅/混合用途是阳台板(顶面 + 立缘),玻璃塔楼是
// 深色层间带。阳台板色调随立面变体三选一,避免在深色楼墙上读成刺眼的
// 白色条纹;材质保持缓存共享,不增加 draw call 数量级。
const BALCONY_TONES = [0xa8a49a, 0x8f8b82, 0x77736b];
function balconies(batch, b, ring, baseY, topY) {
  const spec = FACADE_SPECS[b.variant % FACADE_SPECS.length];
  if (b.pitched) return;
  const glass = spec.glass;
  const slabMat = glass ? matStd(0x2b3136, 0.6) : matStd(BALCONY_TONES[b.variant % BALCONY_TONES.length], 0.85);
  const depth = glass ? 0.14 : 0.42, thickness = glass ? 0.09 : 0.15;
  let cx = 0, cz = 0;
  ring.forEach(p => { cx += p.x; cz += p.z; });
  cx /= ring.length; cz /= ring.length;
  for (let f = 1, y = baseY + 3.2; y < topY - 0.6; f++, y = baseY + f * 3.2) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], c = ring[(i + 1) % ring.length];
      const mx = (a.x + c.x) / 2, mz = (a.z + c.z) / 2;
      const ex = mx - cx, ez = mz - cz, el = Math.hypot(ex, ez) || 1;
      const nx = ex / el, nz = ez / el; // 向外
      const b2 = { x: c.x + nx * depth, z: c.z + nz * depth, y: y };
      const a2 = { x: a.x + nx * depth, z: a.z + nz * depth, y: y };
      batch.add(quad({ ...a, y }, { ...c, y }, b2, a2), slabMat, 'building');        // 顶面
      batch.add(quad({ ...c, y }, b2, { ...b2, y: y - thickness }, { ...c, y: y - thickness }), slabMat, 'building'); // 立缘
    }
  }
}

function building(batch, b) {
  const rand = randomFromSeed(b.seed), bottom = 0.03, top = bottom + b.h;
  // 逐栋差异三件套:明度色调、分通道色相偏移、15% 概率 U 镜像。
  const tint = 0.82 + rand() * 0.36;
  const wallTint = [tint * (0.92 + rand() * 0.16), tint * (0.96 + rand() * 0.08), tint * (0.86 + rand() * 0.28)];
  const mirror = rand() < 0.15 ? -1 : 1;
  const facade = facadeMaterial(b.variant);
  if (b.pitched) {
    for (let i = 0; i < b.ring.length; i++)
      addWall(batch, b.ring[i], b.ring[(i + 1) % b.ring.length], bottom, top, facade, wallTint, b.floors, mirror);
    const apex = { x: b.x, y: top + 1.5 + rand() * 1.3, z: b.z };
    for (let i = 0; i < b.ring.length; i++) {
      const p = b.ring[i], q = b.ring[(i + 1) % b.ring.length];
      batch.add(geometry([{ ...p, y: top }, { ...q, y: top }, apex], [0, 1, 2]),
        matStd(PITCHED_TONES[Math.floor(rand() * PITCHED_TONES.length)], 0.85), 'building');
    }
    return;
  }
  const towerRing = b.tierRing, podiumFloors = b.podiumFloors || 0;
  const podiumTop = bottom + podiumFloors * 3.2;
  const tone = ROOF_TONES[b.variant % ROOF_TONES.length], edge = ROOF_TONES[(b.variant + 1) % ROOF_TONES.length];
  // 首层永远是"有人用"的楼层:商铺玻璃、写字楼门厅或住宅门窗。上面的
  // 标准层从 3.2m 起算,楼层计数相应减一。
  const baseKind = b.style === 'mixed-use' ? 'shop'
    : FACADE_SPECS[b.variant % FACADE_SPECS.length].glass || towerRing ? 'lobby' : 'home';
  for (let i = 0; i < b.ring.length; i++)
    addBaseWall(batch, b.ring[i], b.ring[(i + 1) % b.ring.length], bottom,
      groundFloorMaterial(baseKind), wallTint, mirror);
  const signs = baseKind === 'lobby' ? null : signMaterials();
  if (signs) {
    // 首层顶部一条连续店招带:每 4m 一块、3.2m 招牌 + 0.8m 间隔,逐块换店名,
    // 少量留空(卷帘门/入口)。整条街因此像不同店铺,而不是一家连锁店。
    for (let i = 0; i < b.ring.length; i++) {
      const a = b.ring[i], c = b.ring[(i + 1) % b.ring.length];
      const len = Math.hypot(c.x - a.x, c.z - a.z);
      if (len < 2.5) continue;
      const ux = (a.x + c.x) / 2 - b.x, uz = (a.z + c.z) / 2 - b.z, ul = Math.hypot(ux, uz) || 1;
      const ox = ux / ul, oz = uz / ul;                                  // 外法线
      // uv 的 u 轴固定取外法线左转 90°:站在街上看,文字永远从左到右。
      const forward = oz * (c.x - a.x) - ox * (c.z - a.z) >= 0;
      const a2 = forward ? a : c, c2 = forward ? c : a;
      const off = { x: ox * 0.15, z: oz * 0.15 };
      const dx = (c2.x - a2.x) / len, dz = (c2.z - a2.z) / len;
      const pitch = 4, plate = Math.min(3.2, len - 0.8);
      for (let s = 0.4; s + plate <= len - 0.4 + 1e-6; s += pitch) {
        if (rand() < 0.18) continue;
        addSignBoard(batch,
          { x: a2.x + dx * s + off.x, z: a2.z + dz * s + off.z },
          { x: a2.x + dx * (s + plate) + off.x, z: a2.z + dz * (s + plate) + off.z },
          bottom + 3.3, bottom + 4.2, signs[Math.floor(rand() * signs.length)]);
      }
    }
  }
  const ground = 1, lower = bottom + 3.2;
  for (let i = 0; i < b.ring.length; i++)
    addWall(batch, b.ring[i], b.ring[(i + 1) % b.ring.length], lower, towerRing ? podiumTop : top,
      facade, wallTint, (towerRing ? podiumFloors : b.floors) - ground, mirror);
  if (towerRing) {
    balconies(batch, b, b.ring, lower, podiumTop);
    // Podium deck spans the whole parcel; the tower deck spans the tier.
    batch.add(polygon(b.ring, podiumTop + 0.3), roofMaterial(tone), 'building');
    parapet(batch, b.ring, podiumTop + 0.3, 0.4, matStd(edge));
    // 超高层的顶部退台冠层:天际线剪影立刻和"一根方柱"区分开。
    const crown = b.floors > 22 ? scaleRing(towerRing, 0.76 + rand() * 0.1) : null;
    const towerTop = crown ? top - 6.4 : top;
    for (let i = 0; i < towerRing.length; i++)
      addWall(batch, towerRing[i], towerRing[(i + 1) % towerRing.length], podiumTop + 0.3, towerTop,
        facade, wallTint, (b.floors - podiumFloors) * (crown ? 0.78 : 1), mirror);
    balconies(batch, b, towerRing, podiumTop + 0.3, towerTop);
    batch.add(polygon(towerRing, towerTop), roofMaterial(tone), 'building');
    batch.add(polygon(towerRing.slice().reverse(), podiumTop + 0.3), roofMaterial(tone), 'building');
    parapet(batch, towerRing, towerTop, 0.45 + rand() * 0.3, matStd(edge));
    if (crown) {
      for (let i = 0; i < crown.length; i++)
        addWall(batch, crown[i], crown[(i + 1) % crown.length], towerTop, top, facade, wallTint,
          Math.max(1, Math.round((b.floors - podiumFloors) * 0.22)), mirror);
      batch.add(polygon(crown, top), roofMaterial(tone), 'building');
      parapet(batch, crown, top, 0.5 + rand() * 0.3, matStd(edge));
      roofProps(batch, crown, top, rand, b.floors);
    } else roofProps(batch, towerRing, top, rand, b.floors);
  } else {
    balconies(batch, b, b.ring, lower, top);
    batch.add(polygon(b.ring, top), roofMaterial(tone), 'building');
    batch.add(polygon(b.ring.slice().reverse(), bottom), matStd(0x787c7d), 'building');
    parapet(batch, b.ring, top, 0.45 + rand() * 0.3, matStd(edge));
    roofProps(batch, b.ring, top, rand, b.floors);
  }
}

// 以环自身质心为基准的收缩,用于塔楼冠层退台。
function scaleRing(ring, k) {
  let cx = 0, cz = 0;
  ring.forEach(p => { cx += p.x; cz += p.z; });
  cx /= ring.length; cz /= ring.length;
  return ring.map(p => ({ x: cx + (p.x - cx) * k, z: cz + (p.z - cz) * k }));
}

// Deterministic street tree: tapered trunk and visible branches carrying the
// crown, which is a cloud of alpha-tested leaf-cluster cards. Cards beat
// thousands of individual leaf triangles on every axis that matters here:
// far fewer vertices, and the crown reads as continuous foliage instead of
// scattered confetti. Tones are baked as vertex colours so every tree in the
// city still merges into one draw call. 枝干用手工数组直接生成(每棵树只产出
// 木/叶两个几何体),避免上万个临时 Cylinder Geometry 拖垮合并阶段。
const LEAF_TONES = [0x5f8348, 0x6f9152, 0x4e7340, 0x7d9a55, 0x8a9d5e].map(c => new THREE.Color(c));
let leafCardTextureCache = null;
export function leafCardTexture() {
  if (leafCardTextureCache) return leafCardTextureCache;
  const S = 64, data = new Uint8Array(S * S * 4);
  const rand = randomFromSeed(9931);
  // 一格里画十几片椭圆叶:叶簇卡片贴图,颜色接近白(靠顶点色染色),
  // 单叶带明暗差异,糊成一片时仍有层次。
  for (let i = 0; i < 26; i++) {
    const cx = 6 + rand() * 52, cy = 6 + rand() * 52, ang = rand() * Math.PI;
    const len = 5.5 + rand() * 5.5, wid = 2.4 + rand() * 2.4;
    const ca = Math.cos(ang), sa = Math.sin(ang), shade = 0.72 + rand() * 0.36;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const u = dx * ca + dy * sa, v = -dx * sa + dy * ca;
      if (u * u / (len * len) + v * v / (wid * wid) > 1) continue;
      const idx = (y * S + x) * 4;
      // 纯明度贴图:叶色完全交给顶点色,避免贴图与顶点色相乘后压成黑叶。
      const v255 = 226 * shade;
      data[idx] = v255; data[idx + 1] = v255; data[idx + 2] = v255; data[idx + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, S, S);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true; texture.needsUpdate = true;
  leafCardTextureCache = texture;
  return texture;
}
let leafCardMaterialCache = null;
function leafCardMaterial() {
  if (!leafCardMaterialCache) leafCardMaterialCache = new THREE.MeshStandardMaterial({
    map: leafCardTexture(), color: 0xffffff, vertexColors: true, roughness: 0.88,
    side: THREE.DoubleSide, alphaTest: 0.45,
  });
  return leafCardMaterialCache;
}
function tree(batch, tree) {
  const rand = randomFromSeed(tree.seed), size = tree.size;
  const trunkH = size * (0.36 + rand() * 0.12);
  const woodPos = [], woodNorm = [], woodIdx = [];
  let wv = 0;
  const addBranch = (x0, y0, z0, bx, by, bz, r0, r1) => {
    const dx = bx - x0, dy = by - y0, dz = bz - z0;
    const len = Math.hypot(dx, dy, dz) || 0.01;
    const ux = dx / len, uy = dy / len, uz = dz / len;
    let px = -uy, py = ux, pz = 0;
    const pl = Math.hypot(px, py, pz);
    if (pl < 0.05) { px = 1; py = 0; pz = 0; } else { px /= pl; py /= pl; pz /= pl; }
    const qx = uy * pz - uz * py, qy = uz * px - ux * pz, qz = ux * py - uy * px;
    const sides = 5;
    for (let i = 0; i < sides; i++) {
      const a0 = i / sides * Math.PI * 2, a1 = (i + 1) / sides * Math.PI * 2;
      const ring = (t, r, a) => {
        const c = Math.cos(a) * r, s = Math.sin(a) * r;
        return [x0 + ux * len * t + px * c + qx * s, y0 + uy * len * t + py * c + qy * s, z0 + uz * len * t + pz * c + qz * s,
          Math.cos(a) * px + Math.sin(a) * qx, Math.cos(a) * py + Math.sin(a) * qy, Math.cos(a) * pz + Math.sin(a) * qz];
      };
      const v00 = ring(0, r0, a0), v01 = ring(0, r0, a1), v10 = ring(1, r1, a0), v11 = ring(1, r1, a1);
      woodPos.push(...v00.slice(0, 3), ...v10.slice(0, 3), ...v11.slice(0, 3), ...v01.slice(0, 3));
      woodNorm.push(...v00.slice(3), ...v10.slice(3), ...v11.slice(3), ...v01.slice(3));
      woodIdx.push(wv, wv + 1, wv + 2, wv, wv + 2, wv + 3);
      wv += 4;
    }
  };
  addBranch(tree.x, 0, tree.z, tree.x, trunkH, tree.z, 0.07 + size * 0.032, 0.05 + size * 0.016);
  const branches = 8 + Math.floor(rand() * 4);
  const leafPos = [], leafColor = [], leafIdx = [], leafUv = [], leafNorm = [];
  let v = 0;
  const addCard = (cx, cy, cz, nx, ny, nz, s, tone, shade) => {
    // 卡片法向随机,基向量取法向与一个稳定的参考轴的叉积。
    let ux = -nz, uy = 0, uz = nx;
    const ul = Math.hypot(ux, uy, uz);
    if (ul < 0.05) { ux = 1; uy = 0; uz = 0; } else { ux /= ul; uy /= ul; uz /= ul; }
    const bx = ny * uz - nz * uy, by = nz * ux - nx * uz, bz = nx * uy - ny * ux;
    const h = s * 0.5;
    // 顶点法向向上偏置:真实树叶透光且叶面散射,若照卡片的随机法向直渲,
    // 背光的一半叶片会黑掉,树冠变成剪影。把法向混向天顶,再靠顶点色做
    // 冠内明暗,得到"半透明"的观感。
    const nnx = nx * 0.4, nny = ny * 0.4 + 1.0, nnz = nz * 0.4;
    const nl = Math.hypot(nnx, nny, nnz) || 1;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      leafPos.push(cx + (ux * su + bx * sv) * h, cy + (uy * su + by * sv) * h, cz + (uz * su + bz * sv) * h);
      leafNorm.push(nnx / nl, nny / nl, nnz / nl);
    }
    leafUv.push(0, 0, 1, 0, 1, 1, 0, 1);
    for (let k = 0; k < 4; k++) leafColor.push(tone.r * shade, tone.g * shade, tone.b * shade);
    leafIdx.push(v, v + 1, v + 2, v, v + 2, v + 3); v += 4;
  };
  for (let i = 0; i < branches; i++) {
    const angle = (i + rand() * 0.7) * (Math.PI * 2 / branches);
    const y = trunkH * (0.55 + (i / branches) * 0.6);
    const reach = size * (0.16 + rand() * 0.16);
    const bx = tree.x + Math.cos(angle) * reach, bz = tree.z + Math.sin(angle) * reach;
    const by = y + size * (0.18 + rand() * 0.24);
    addBranch(tree.x, y, tree.z, bx, by, bz, 0.05, 0.02);
    // 树冠 = 枝梢周围的椭球壳卡片云:每根枝 12-18 张随机朝向的叶簇卡,
    // 顶部亮、内部与底部暗(廉价的冠内 AO),远看是一团连续的叶,近看
    // 每张卡上有几十片叶子。
    const cr = size * (0.16 + rand() * 0.08);
    const cards = 22 + Math.floor(rand() * 10);
    const tone = LEAF_TONES[Math.floor(rand() * LEAF_TONES.length)];
    for (let c = 0; c < cards; c++) {
      const th = rand() * Math.PI * 2, ph = Math.acos(2 * rand() - 1);
      const rr = cr * (0.35 + rand() * 0.75);
      const px = bx + Math.sin(ph) * Math.cos(th) * rr;
      const py = by + Math.cos(ph) * rr * 0.85;
      const pz = bz + Math.sin(ph) * Math.sin(th) * rr;
      const nth = rand() * Math.PI * 2, nph = Math.acos(2 * rand() - 1);
      const nx = Math.sin(nph) * Math.cos(nth), ny = Math.cos(nph) * 0.6, nz = Math.sin(nph) * Math.sin(nth);
      const s = size * (0.15 + rand() * 0.13);
      const lift = Math.max(0, Math.min(1, (py - 0.4 * size) / (size * 0.9)));
      const shade = (0.74 + rand() * 0.36) * (0.78 + 0.3 * lift);
      addCard(px, py, pz, nx, ny, nz, s, tone, shade);
    }
  }
  const wood = new THREE.BufferGeometry();
  wood.setAttribute('position', new THREE.Float32BufferAttribute(woodPos, 3));
  wood.setAttribute('normal', new THREE.Float32BufferAttribute(woodNorm, 3));
  wood.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(wv * 2).fill(0), 2));
  wood.setIndex(woodIdx);
  batch.add(wood, matStd(0x6b5945), 'vegetation');
  const leaves = new THREE.BufferGeometry();
  leaves.setAttribute('position', new THREE.Float32BufferAttribute(leafPos, 3));
  leaves.setAttribute('color', new THREE.Float32BufferAttribute(leafColor, 3));
  leaves.setAttribute('normal', new THREE.Float32BufferAttribute(leafNorm, 3));
  leaves.setAttribute('uv', new THREE.Float32BufferAttribute(leafUv, 2));
  // 标记叶簇卡顶点,供 GTAO 法向通道按 alpha 裁剪(见 main.js)。
  leaves.setAttribute('aLeafCard', new THREE.Float32BufferAttribute(new Array(v).fill(1), 1));
  leaves.setIndex(leafIdx);
  batch.add(leaves, leafCardMaterial(), 'vegetation');
}

// Street furniture: pole + curved-arm street light, merged into the
// 'furniture' batch so a city's worth of lamps stays a single draw call.
function streetLight(batch, road, s, side, cfg) {  const pose = roadPoint(road, s, side * (road.width / 2 + cfg.sidewalkWidth + 0.5));
  const tangent = samplePath(road.path, s);
  const inward = { x: side * tangent.tz, z: -side * tangent.tx };
  const yaw = Math.atan2(-inward.z, inward.x);
  const pole = new THREE.CylinderGeometry(0.06, 0.1, 7.6, 6);
  pole.translate(pose.x, pose.y + 3.8, pose.z);
  batch.add(pole, matStd(0x4a5560, 0.6), 'furniture');
  const armLen = 2.4;
  const arm = new THREE.BoxGeometry(armLen, 0.09, 0.09);
  arm.translate(armLen / 2, 0, 0);
  arm.rotateY(yaw);
  arm.translate(pose.x, pose.y + 7.45, pose.z);
  batch.add(arm, matStd(0x4a5560, 0.6), 'furniture');
  const head = new THREE.BoxGeometry(0.3, 0.13, 0.8);
  head.translate(armLen - 0.25, -0.14, 0);
  head.rotateY(yaw);
  head.translate(pose.x, pose.y + 7.45, pose.z);
  batch.add(head, matStd(0xd8e2e8, 0.4), 'furniture');
}

// Bus stop shelter: platform, two posts, roof slab and an ad panel — the
// single most recognisable piece of Chinese street furniture.
function busStop(batch, road, s, side, cfg) {
  const pose = roadPoint(road, s, side * (road.width / 2 + cfg.sidewalkWidth + 1.7));
  const tangent = samplePath(road.path, s);
  const yaw = Math.atan2(-tangent.tz, tangent.tx);
  const platform = new THREE.BoxGeometry(6.2, 0.14, 2.4);
  platform.rotateY(yaw); platform.translate(pose.x, pose.y + 0.07, pose.z);
  batch.add(platform, matStd(0xb9b7ae, 0.9), 'furniture');
  const roof = new THREE.BoxGeometry(4.6, 0.12, 1.7);
  roof.rotateY(yaw); roof.translate(pose.x, pose.y + 3.05, pose.z);
  batch.add(roof, matStd(0x3f4a52, 0.5), 'furniture');
  for (const off of [-1.9, 1.9]) {
    const post = new THREE.BoxGeometry(0.12, 2.9, 0.12);
    post.rotateY(yaw); post.translate(pose.x - tangent.tx * off, pose.y + 1.5, pose.z - tangent.tz * off);
    batch.add(post, matStd(0x4a5560, 0.6), 'furniture');
  }
  const panel = new THREE.BoxGeometry(1.7, 1.1, 0.1);
  panel.rotateY(yaw); panel.translate(pose.x + tangent.tx * 1.9, pose.y + 1.9, pose.z + tangent.tz * 1.9);
  batch.add(panel, matStd(0x2b6cb8, 0.4), 'furniture');
}

// ---------------------------------------------------------------- 写实街道层
// 真实街景的可信度来自"多余"的小物件:磨旧的标线漆、电线杆与下垂的线缆、
// 蓝底指路牌、人行道金属栏杆、路口护柱、分隔带草丛。以下全部程序化生成,
// 且在无 DOM 的测试环境(node/vitest)里安全降级为纯色材质。

// 标线漆面:纯净色一压平就穿帮,加一层斑驳磨损的白漆纹理(4m 平铺,
// 与路面同一套世界坐标 UV)。
let paintMaterialCache = null;
function paintMaterial() {
  if (paintMaterialCache) return paintMaterialCache;
  const rand = randomFromSeed(4211), size = 128;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const mottle = (rand() - 0.5) * 22 + (rand() < 0.045 ? -42 : 0) + (rand() < 0.04 ? 10 : 0);
    const wheel = Math.sin(x * 0.21 + Math.sin(y * 0.043) * 3.1) * 4; // 车辙方向的暗淡条痕
    const v = 240 + mottle + wheel;
    const i = (y * size + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = Math.max(0, Math.min(255, v));
    data[i + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true; texture.colorSpace = THREE.SRGBColorSpace; texture.needsUpdate = true;
  paintMaterialCache = new THREE.MeshStandardMaterial({ color: 0xf2f3ec, map: texture, roughness: 0.62 });
  return paintMaterialCache;
}

// 城市边界外的草地地面:逐像素噪点为主 + 极低频斑块,repeat 由
// main.configureSceneExtent 依据地面缩放设置(约 2.8m 一格)。贴图只能给出
// 小尺度细节,再在片元里按世界坐标叠一层公里级草场色斑/枯黄变化,大片
// 绿地才不会是一块均匀的塑料板。
export function groundMaterial() {
  const mat = proceduralMaterial('ground', (x, y, rand) => {
    // 斑块幅度压到 2:世界坐标 UV 在大尺度下会暴露 sin 网格的"绗缝"感。
    const patch = Math.sin(x * 0.031 + Math.sin(y * 0.017) * 2.6) * Math.cos(y * 0.023 + x * 0.011) * 2;
    const n = (rand() - 0.5) * 10 + (rand() < 0.035 ? 11 : 0);
    return [86 + patch + n, 100 + patch + n, 72 + patch * 0.6 + n * 0.8];
  });
  mat.onBeforeCompile = shader => {
    shader.vertexShader = 'varying vec3 vGroundPos;\n' + shader.vertexShader
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGroundPos = (modelMatrix * vec4(position, 1.0)).xyz;');
    shader.fragmentShader = 'varying vec3 vGroundPos;\n' + shader.fragmentShader
      .replace('#include <map_fragment>', `#include <map_fragment>
        {
          float g1 = sin(vGroundPos.x * 0.0041) * cos(vGroundPos.z * 0.0033);
          float g2 = sin(vGroundPos.x * 0.0137 + 1.7) * sin(vGroundPos.z * 0.0111);
          float dry = clamp(g1 * 0.62 + g2 * 0.38, -1.0, 1.0);
          diffuseColor.rgb *= 1.0 + dry * 0.3;
          diffuseColor.g *= 1.0 + dry * 0.12;
        }`);
  };
  return mat;
}

// 河面:低粗糙度 + 金属感,反射天空穹顶烘焙出的 IBL,才有水的观感。
let waterMaterialCache = null;
function waterMaterial() {
  if (!waterMaterialCache) waterMaterialCache = new THREE.MeshStandardMaterial({ color: 0x3f7186, roughness: 0.16, metalness: 0.45, envMapIntensity: 1.5 });
  return waterMaterialCache;
}

// 人行道金属栏杆 / 护柱共用的镀锌钢材质。
let steelMaterialCache = null;
function steelMaterial() {
  if (!steelMaterialCache) steelMaterialCache = new THREE.MeshStandardMaterial({ color: 0xb4bac0, roughness: 0.38, metalness: 0.72 });
  return steelMaterialCache;
}

// --- 蓝色标志牌纹理(canvas;无 DOM 时返回 null,材质退化为纯色蓝底) ---
const SIGN_BLUE = '#1259a8';
const signTextureCache = new Map();
function signTexture(kind, seed) {
  if (typeof document === 'undefined') return null;
  const key = `${kind}-${seed}`;
  if (signTextureCache.has(key)) return signTextureCache.get(key);
  const canvas = document.createElement('canvas');
  const rand = randomFromSeed(hashSeed(seed, `sign/${kind}`));
  const destinations = ['市中心 Center', '国际会展中心 Convention Ctr', '火车站 Railway Station',
    '滨海公园 Waterfront Park', '人民医院 General Hospital', '大学城 University Town'];
  let ctx;
  if (kind === 'guide') {
    canvas.width = 512; canvas.height = 224;
    ctx = canvas.getContext('2d');
    ctx.fillStyle = SIGN_BLUE; ctx.fillRect(0, 0, 512, 224);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 6;
    ctx.strokeRect(12, 12, 488, 200);
    ctx.fillStyle = '#ffffff'; ctx.textBaseline = 'middle';
    let prevText = -1;
    for (let row = 0; row < 2; row++) {
      const y = 68 + row * 94;
      const dir = ['up', 'left', 'right'][(Math.floor(rand() * 3) + row) % 3];
      drawSignArrow(ctx, 64, y, dir);
      ctx.font = 'bold 44px "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'left';
      let pick = Math.floor(rand() * destinations.length);
      if (pick === prevText) pick = (pick + 1 + Math.floor(rand() * (destinations.length - 1))) % destinations.length;
      prevText = pick;
      const text = destinations[pick];
      ctx.fillText(text.slice(0, text.indexOf(' ')), 116, y - 12);
      ctx.font = '26px "Helvetica Neue", Arial, sans-serif';
      ctx.fillText(text.slice(text.indexOf(' ') + 1), 116, y + 26);
    }
  } else {
    canvas.width = 256; canvas.height = 256;
    ctx = canvas.getContext('2d');
    ctx.fillStyle = SIGN_BLUE; ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 8;
    ctx.beginPath(); ctx.moveTo(128, 30); ctx.lineTo(232, 214); ctx.lineTo(24, 214); ctx.closePath(); ctx.stroke();
    // 过街行人剪影:头、躯干、四肢
    ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 15; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.arc(128, 108, 15, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(126, 128); ctx.lineTo(118, 168); ctx.lineTo(94, 200); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(118, 168); ctx.lineTo(148, 192); ctx.lineTo(154, 208); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(124, 136); ctx.lineTo(96, 158); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(124, 136); ctx.lineTo(156, 152); ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  signTextureCache.set(key, texture);
  return texture;
}

function drawSignArrow(ctx, x, y, dir) {
  ctx.save(); ctx.translate(x, y);
  if (dir === 'left') ctx.rotate(-Math.PI / 2);
  if (dir === 'right') ctx.rotate(Math.PI / 2);
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 13; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(0, 30); ctx.lineTo(0, -22); ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.moveTo(0, -40); ctx.lineTo(-16, -16); ctx.lineTo(16, -16); ctx.closePath(); ctx.fill();
  ctx.restore();
}

// 标志牌 = 纹理板(纯色兜底)+ 由调用方布设的立柱。yaw 让板面法线对准来车方向。
function signBoard(batch, p, yaw, w, h, y, texture) {
  const material = texture
    ? new THREE.MeshStandardMaterial({ color: 0xffffff, map: texture, roughness: 0.5, metalness: 0.12 })
    : matStd(0x15599f, 0.5);
  const board = new THREE.BoxGeometry(w, h, 0.07);
  board.rotateY(yaw);
  board.translate(p.x, y, p.z);
  batch.add(board, material, 'sign');
}

// 沿主干路/次干路接近路口的方向布牌:上游 ~28m 一块导向牌,横道前 ~10m
// 一块行人过街标志,全部位于右侧人行道外缘。
function roadSigns(batch, city, cfg) {
  const rand = randomFromSeed(hashSeed(cfg.scenerySeed ?? 7, 'signs'));
  for (const road of city.roads) {
    if (road.layer !== 0 || road.kind === 'local' || road.kind === 'highway') continue;
    if (!road.crossingEnd || road.trimEnd < 4) continue;
    const total = road.path.at(-1).s;
    const lateral = road.width / 2 + cfg.sidewalkWidth + 0.55;
    if (road.kind === 'arterial' && rand() < 0.85) {
      const s = total - road.trimEnd - 27 - rand() * 7;
      const p = roadPoint(road, s, lateral);
      const tangent = samplePath(road.path, s);
      const yaw = Math.atan2(-tangent.tx, -tangent.tz);
      const n = { x: -tangent.tz, z: tangent.tx };
      signBoard(batch, p, yaw, 3.1, 1.15, p.y + 3.15, signTexture('guide', Math.round(p.x * 7 + p.z)));
      for (const side of [-1.3, 1.3]) {
        const post = new THREE.CylinderGeometry(0.06, 0.06, 3.15, 8);
        post.translate(p.x + n.x * side, p.y + 3.15 / 2, p.z + n.z * side);
        batch.add(post, matStd(0x8d9296, 0.55), 'sign');
      }
    }
    if (rand() < 0.72) {
      const s = total - road.trimEnd - 10.5;
      const p = roadPoint(road, s, lateral);
      const tangent = samplePath(road.path, s);
      const yaw = Math.atan2(-tangent.tx, -tangent.tz);
      signBoard(batch, p, yaw, 0.85, 0.85, p.y + 2.35, signTexture('crossing', Math.round(p.x * 3 + p.z)));
      const post = new THREE.CylinderGeometry(0.045, 0.045, 2.35, 8);
      post.translate(p.x, p.y + 2.35 / 2, p.z);
      batch.add(post, matStd(0x8d9296, 0.55), 'sign');
    }
  }
}

// 电线杆 + 悬链线:支路与次干路两侧交替立杆,杆顶双层横担,四根线缆以
// 抛物线垂度连向相邻杆。线缆用两块正交薄片代替圆柱,任意角度可见。
function wireCatenary(batch, a, b, sag, mat) {
  const segments = 8, width = 0.09;
  const verts = [], uvs = [], idx = [];
  let v = 0;
  for (let i = 0; i < segments; i++) {
    const t0 = i / segments, t1 = (i + 1) / segments;
    const at = s => ({ x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s - sag * 4 * s * (1 - s), z: a.z + (b.z - a.z) * s });
    const p = at(t0), q = at(t1);
    const dx = q.x - p.x, dy = q.y - p.y, dz = q.z - p.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    const ux = dx / len, uy = dy / len, uz = dz / len;
    const frames = [[-uz, 0, ux], [uy * ux, -(ux * ux + uz * uz), uy * uz]]; // 水平横向 + u×横向
    for (const [nx, ny, nz] of frames) {
      verts.push(
        p.x - nx * width / 2, p.y - ny * width / 2, p.z - nz * width / 2,
        p.x + nx * width / 2, p.y + ny * width / 2, p.z + nz * width / 2,
        q.x + nx * width / 2, q.y + ny * width / 2, q.z + nz * width / 2,
        q.x - nx * width / 2, q.y - ny * width / 2, q.z - nz * width / 2);
      uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
      idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
      v += 4;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  batch.add(g, mat, 'wire');
}

function utilityPoles(batch, city, cfg) {
  const rand = randomFromSeed(hashSeed(cfg.scenerySeed ?? 7, 'utility'));
  const poleMat = matStd(0x4d4844, 0.85);
  const wireMat = matStd(0x17191d, 0.6);
  const transformerMat = matStd(0x8a8f8d, 0.6);
  // 城市路网由 40-90m 的短路段组成,杆必须按"路段内等距 + 跨路口就近连接"
  // 布设,线缆才能像真实街道一样连续贯穿。
  const poles = [];
  for (const road of city.roads) {
    if (road.layer !== 0 || road.kind === 'highway') continue;
    const total = road.path.at(-1).s;
    if (total < 44) continue;
    const arterial = road.kind === 'arterial';
    const spacing = arterial ? 34 : 27;
    const side = Math.round(road.trimStart) % 2 ? -1 : 1;
    const offset = side * (road.width / 2 + cfg.sidewalkWidth + (arterial ? 1.2 : 0.9));
    let last = null;
    for (let s = 8; s < total - 6; s += spacing) {
      const p = roadPoint(road, s, offset);
      const tangent = samplePath(road.path, s);
      const height = (arterial ? 9 : 8.2) + rand() * 0.7;
      const pole = new THREE.CylinderGeometry(0.09, 0.13, height, 7);
      pole.translate(p.x, p.y + height / 2, p.z);
      batch.add(pole, poleMat, 'furniture');
      const n = { x: -tangent.tz, z: tangent.tx };
      for (const [drop, armLen] of [[0.5, 1.9], [0.95, 1.5]]) {
        const arm = new THREE.BoxGeometry(armLen, 0.08, 0.08);
        arm.rotateY(Math.atan2(tangent.tx, tangent.tz) + Math.PI / 2);
        arm.translate(p.x, p.y + height - drop, p.z);
        batch.add(arm, poleMat, 'furniture');
      }
      if (rand() < 0.12) {
        const transformer = new THREE.CylinderGeometry(0.3, 0.3, 0.75, 9);
        transformer.translate(p.x + n.x * 0.38, p.y + height - 1.9, p.z + n.z * 0.38);
        batch.add(transformer, transformerMat, 'furniture');
      }
      const node = { p, n, height, s, road, prev: last, next: null, linked: new Set() };
      if (last) { last.next = node; }
      last = node;
      poles.push(node);
    }
  }
  // 线缆:路段内相邻杆直连;路段末端与 32m 内最近的异路段杆相连,穿过路口。
  const span = (a, b, sagBase) => {
    for (const [side, drop, sag] of [[-0.72, 0.5, sagBase], [0.72, 0.5, sagBase], [-0.48, 0.95, sagBase * 0.8], [0.48, 0.95, sagBase * 0.8]])
      wireCatenary(batch,
        { x: a.p.x + a.n.x * side, y: a.p.y + a.height - drop, z: a.p.z + a.n.z * side },
        { x: b.p.x + b.n.x * side, y: b.p.y + b.height - drop, z: b.p.z + b.n.z * side },
        sag + rand() * 0.25, wireMat);
  };
  let spans = 0;
  for (const node of poles) {
    if (node.prev && spans < 620) { span(node, node.prev, 0.55); spans++; }
  }
  for (const node of poles) {
    if (spans >= 620) break;
    if (!node.next) { // 路段末端
      let best = null, bestD = 32;
      for (const other of poles) {
        if (other.road === node.road || node.linked.has(other)) continue;
        const d = Math.hypot(other.p.x - node.p.x, other.p.z - node.p.z);
        if (d > 9 && d < bestD) { bestD = d; best = other; }
      }
      if (best) { span(node, best, 0.7); node.linked.add(best); best.linked.add(node); spans++; }
    }
  }
}

// 主干路双侧人行道金属护栏:双道横杆 + 每 3m 一根竖杆,顺着路缘弯曲。
function sidewalkRailings(batch, city, cfg) {
  const railMat = steelMaterial();
  for (const road of city.roads) {
    if (road.layer !== 0 || road.kind !== 'arterial') continue;
    const total = road.path.at(-1).s;
    for (const side of [-1, 1]) {
      const offset = side * (road.width / 2 + cfg.sidewalkWidth - 0.12);
      const start = road.trimStart + 8, end = total - road.trimEnd - 8;
      for (let s = start; s < end; s += 3) {
        const s2 = Math.min(end, s + 3);
        const a = roadPoint(road, s, offset), b = roadPoint(road, s2, offset);
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        if (len < 0.05) continue;
        for (const h of [0.52, 1.02])
          batch.box((a.x + b.x) / 2, a.y + h, (a.z + b.z) / 2, len, 0.05, 0.045, railMat, 'furniture',
            Math.atan2(-(b.z - a.z), b.x - a.x));
        const post = new THREE.CylinderGeometry(0.022, 0.022, 1.06, 5);
        post.translate(b.x, b.y + 0.53, b.z);
        batch.add(post, railMat, 'furniture');
      }
    }
  }
}

// 路口环形人行道边缘的护柱:沿 walkRing 每 ~6.5m 一根,跳过正对道路
// 开口的区段(用 distanceToRoad 过滤),再稍微向路口中心收拢。
function junctionBollards(batch, city) {
  const capMat = matStd(0x3c4045, 0.5);
  for (const junction of city.junctions) {
    if (!junction.walkRing || junction.cx === undefined) continue;
    const incidentRoads = city.sd.edges
      .filter(e => e.from === junction.id || e.to === junction.id)
      .map(e => city.roads.find(r => r.id === e.id)).filter(r => r && r.layer === 0);
    const ring = junction.walkRing, jy = (junction.y ?? 0) + 0.15;
    let acc = 3;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      let s = acc;
      for (; s < len; s += 6.5) {
        const t = s / len;
        const x = junction.cx + (a.x + (b.x - a.x) * t - junction.cx) * 0.94;
        const z = junction.cz + (a.z + (b.z - a.z) * t - junction.cz) * 0.94;
        if (incidentRoads.some(r => distanceToRoad({ x, z }, r) < r.width / 2 + 2.4)) continue;
        const post = new THREE.CylinderGeometry(0.085, 0.095, 0.78, 9);
        post.translate(x, jy + 0.39, z);
        batch.add(post, steelMaterial(), 'furniture');
        const cap = new THREE.CylinderGeometry(0.088, 0.088, 0.05, 9);
        cap.translate(x, jy + 0.8, z);
        batch.add(cap, capMat, 'furniture');
      }
      acc = s - len;
    }
  }
}

// 灌木团:低多边形球 + flatShading,几个缓存绿色抖动 —— 绿篱、树冠、
// 环岛共用的"植物体块"原语。索引几何,可与合批管线直接合并。
const bushMaterials = new Map();
function bushMaterial(color) {
  if (!bushMaterials.has(color)) bushMaterials.set(color, new THREE.MeshStandardMaterial({ color, roughness: 0.95, flatShading: true }));
  return bushMaterials.get(color);
}
const BUSH_GREENS = [0x3f7038, 0x4c7f40, 0x37632f, 0x568a45];
function bush(batch, x, y, z, r, squish, rand, tones = BUSH_GREENS) {
  const geo = new THREE.SphereGeometry(r, 7, 5);
  geo.scale(1, squish, 1);
  geo.translate(x, y + r * squish * 0.62, z);
  batch.add(geo, bushMaterial(tones[Math.floor(rand() * tones.length)]), 'vegetation');
}

// 观赏草丛:两片交叉的 alpha 裁剪面片,顶点色控制浓淡。散布在公园、
// 绿地地块与环岛中心岛 —— 数字孪生街景里最提气的一层细节。
let tuftMaterialCache = null;function tuftMaterial() {
  if (tuftMaterialCache) return tuftMaterialCache;
  const size = 64, rand = randomFromSeed(9137);
  const data = new Uint8Array(size * size * 4);
  const blades = Array.from({ length: 10 }, () => ({
    x: 6 + rand() * (size - 12), w: 2.1 + rand() * 2.5, lean: (rand() - 0.5) * 20, tint: rand(),
  }));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const v = 1 - y / size; // 1 = 底部
    let tint = -1;
    for (const b of blades) {
      const cx = b.x + b.lean * (1 - v);
      if (Math.abs(x - cx) < b.w * (0.3 + v * 0.7)) { tint = b.tint; break; }
    }
    const i = (y * size + x) * 4;
    data[i] = 58 + tint * 34;
    data[i + 1] = tint < 0 ? 0 : 124 + tint * 58 - v * 22;
    data[i + 2] = 48 + tint * 26;
    data[i + 3] = tint < 0 ? 0 : 255;
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true; texture.colorSpace = THREE.SRGBColorSpace; texture.needsUpdate = true;
  tuftMaterialCache = new THREE.MeshStandardMaterial({ map: texture, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.95, vertexColors: true });
  return tuftMaterialCache;
}

function grassTufts(batch, city, cfg) {
  const rand = randomFromSeed(hashSeed(cfg.scenerySeed ?? 7, 'tufts'));
  const pos = [], uvs = [], colors = [], indices = [];
  let v = 0, budget = 7000;
  const addTuft = (x, z, y, s) => {
    if (budget-- <= 0) return;
    const shade = 0.75 + rand() * 0.45;
    for (let k = 0; k < 2; k++) {
      const a = rand() * Math.PI + k * Math.PI / 2;
      const hx = Math.cos(a) * s / 2, hz = Math.sin(a) * s / 2;
      pos.push(x - hx, y, z - hz, x + hx, y, z + hz, x + hx, y + s * 0.95, z + hz, x - hx, y + s * 0.95, z - hz);
      uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
      for (let c = 0; c < 4; c++) colors.push(shade, shade * (0.95 + rand() * 0.12), shade * 0.88);
      indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
      v += 4;
    }
  };
  const scatter = (ring, density, size) => {
    const xs = ring.map(p => p.x), zs = ring.map(p => p.z);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
    const n = Math.min(64, Math.max(4, Math.round((maxX - minX) * (maxZ - minZ) * density)));
    for (let k = 0; k < n * 3 && k < 160; k++) {
      const x = minX + rand() * (maxX - minX), z = minZ + rand() * (maxZ - minZ);
      if (!pointInRing(x, z, ring)) continue;
      addTuft(x, z, 0.31, size * (0.75 + rand() * 0.5));
    }
  };
  for (const block of city.blocks) if (block.park) scatter(block.ring, 0.03, 0.7);
  for (const parcel of city.parcels) if (parcel.use === 'green') scatter(parcel.ring, 0.05, 0.62);
  // 主干路中央分隔带:灌木之间的草丛填补,贴着草地条带。
  for (const road of city.roads) {
    if (road.layer !== 0 || road.kind === 'highway' || (road.median ?? 0) < 1.5) continue;
    const total = road.path.at(-1).s;
    for (let s = road.trimStart + 9; s < total - road.trimEnd - 9; s += 2.1) {
      const p = roadPoint(road, s, (rand() - 0.5) * 0.5);
      addTuft(p.x, p.z, p.y + 0.12, 0.45 + rand() * 0.25);
    }
  }
  for (const junction of city.junctions) if (junction.roundabout) {
    const R = Math.max(junction.radius, 18) * 0.42;
    const rbRand = randomFromSeed(hashSeed(cfg.scenerySeed ?? 7, `island/${junction.id}`));
    for (let k = 0; k < 14; k++) {
      const a = rbRand() * Math.PI * 2, r = R * (0.2 + rbRand() * 0.65);
      bush(batch, junction.cx + Math.cos(a) * r, junction.y + 0.16, junction.cz + Math.sin(a) * r,
        0.45 + rbRand() * 0.45, 0.7 + rbRand() * 0.3, rbRand);
    }
    for (let k = 0; k < 12; k++) {
      const a = rand() * Math.PI * 2, r = R * (0.15 + rand() * 0.75);
      addTuft(junction.cx + Math.cos(a) * r, junction.cz + Math.sin(a) * r, junction.y + 0.17, 0.5 + rand() * 0.3);
    }
  }
  if (!v) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  batch.add(geo, tuftMaterial(), 'tuft');
}

const SIGNAL_ON = { red: 0xff453a, yellow: 0xffc53d, green: 0x3ddc84 };
const SIGNAL_OFF = { red: 0x38100e, yellow: 0x3a2c0d, green: 0x0e3320 };
// Animated traffic signals at major junction approaches: pole + vertical
// head + three independent lamps. Returns lamp groups for main.js's phase
// driver (NS/EW alternate, so cross streets actually take turns).
export function cityTrafficLights(city, cfg) {
  const group = new THREE.Group(), lampGroups = [];
  if (!cfg.showLights) return { group, lampGroups };
  const roads = new Map(city.roads.map(r => [r.id, r]));
  const rand = randomFromSeed(hashSeed(cfg.scenerySeed ?? 7, 'signals'));
  let built = 0;
  for (const junction of city.junctions) {
    if (built >= 36) break;
    if (junction.roundabout) continue;
    const incident = city.sd.edges.filter(e => e.from === junction.id || e.to === junction.id);
    const major = incident.some(e => e.class === 'arterial' || e.class === 'collector');
    if (incident.length < 3 || junction.radius < 9 || !major) continue;
    if (incident.length < 4 && rand() < 0.35) continue;
    const approaches = [];
    for (const edge of incident) {
      const road = roads.get(edge.id);
      if (!road || road.layer !== 0 || road.kind === 'highway') continue;
      const atEnd = road.to === junction.id;
      if ((atEnd ? road.lanesForward : road.lanesBackward) < 1) continue;
      const s = atEnd ? road.path.at(-1).s - road.trimEnd - 6.4 : road.trimStart + 6.4;
      const tangent = samplePath(road.path, s);
      const dir = atEnd ? { x: tangent.tx, z: tangent.tz } : { x: -tangent.tx, z: -tangent.tz };
      const kerb = atEnd ? road.width / 2 : -(road.width / 2);
      approaches.push({ p: roadPoint(road, s, kerb + 0.55), dir });
    }
    if (approaches.length < 2) continue;
    built++;
    const staticGeos = [];
    for (const { p, dir } of approaches) {
      const pole = new THREE.CylinderGeometry(0.08, 0.11, 5.4, 8);
      pole.translate(p.x, p.y + 2.7, p.z);
      staticGeos.push(pole);
      const head = new THREE.BoxGeometry(0.44, 1.3, 0.34);
      head.translate(p.x, p.y + 4.9, p.z);
      staticGeos.push(head);
      const face = { x: -dir.x * 0.22, z: -dir.z * 0.22 };
      const lamps = [];
      [['red', 0.38], ['yellow', 0], ['green', -0.38]].forEach(([role, dy]) => {
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8),
          new THREE.MeshStandardMaterial({ color: SIGNAL_OFF[role], emissive: SIGNAL_OFF[role], emissiveIntensity: 0.25, toneMapped: false }));
        mesh.position.set(p.x + face.x, p.y + 4.9 + dy, p.z + face.z);
        group.add(mesh);
        lamps.push({ mesh, role, on: SIGNAL_ON[role], off: SIGNAL_OFF[role] });
        // 遮阳檐:真实信号灯每只灯珠上方都有一片挡光板,白天也清晰可辨。
        const yaw = Math.atan2(dir.x, dir.z);
        const hood = new THREE.BoxGeometry(0.36, 0.05, 0.34);
        hood.translate(0, 0.15, 0.08);
        hood.rotateY(yaw);
        hood.translate(p.x + face.x, p.y + 4.9 + dy, p.z + face.z);
        staticGeos.push(hood);
      });
      lampGroups.push({ axis: Math.abs(dir.x) >= Math.abs(dir.z) ? 'ew' : 'ns', lamps });
    }
    if (staticGeos.length) {
      const merged = mergeGeometries(staticGeos);
      staticGeos.forEach(g => g.dispose());
      if (merged) { const m = new THREE.Mesh(merged, matStd(0x39424a, 0.6)); m.castShadow = true; group.add(m); }
    }
  }
  return { group, lampGroups };
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
    batch.add(strip(river,-geography.river.width/2,geography.river.width/2,0,river.path.at(-1).s,0.015),schematic?matStd(0x315d71,0.4):waterMaterial(),'water');
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
  const laneMovements = new Map();
  for (const connector of city.connectors) {
    if (!laneMovements.has(connector.fromLane)) laneMovements.set(connector.fromLane, new Set());
    laneMovements.get(connector.fromLane).add(connector.movement);
  }
  const lanesByEdge = new Map();
  for (const lane of city.lanes) {
    if (!lanesByEdge.has(lane.edgeId)) lanesByEdge.set(lane.edgeId, []);
    lanesByEdge.get(lane.edgeId).push(lane);
  }
  for (const road of city.roads) {
    const from = road.trimStart, to = road.path.at(-1).s - road.trimEnd;
    const left = -road.width / 2, right = road.width / 2;
    batch.add(strip(road, left, right, from, to), hd ? matStd(0x253039, 0.95) : asphaltMaterial(), 'road');
    if (!hd) sweepWalls(batch, road, left, right, from, to, road.depth, matStd(0x959b9b), road.structure ? 'bridge' : 'road');
    if (!hd && cfg.showSidewalk && road.layer===0 && road.kind!=='highway') {
      for(const side of [-1,1]){
        const inner=side*(road.width/2+0.2),outer=side*(road.width/2+cfg.sidewalkWidth);
        batch.add(strip(road,Math.min(inner,outer),Math.max(inner,outer),from,to,0.15),pavingMaterial(),'sidewalk');
        const curb=makeRoad('curb',road.path.map(p=>({...roadPoint(road,p.s,inner),y:p.y+0.15})));
        batch.add(strip(curb,-0.14,0.14,from,to),pavingMaterial(),'sidewalk');
        sweepWalls(batch,curb,-0.14,0.14,from,to,0.15,pavingMaterial(),'sidewalk');
      }
    }
    const m0 = road.markingStart, m1 = road.path.at(-1).s - road.markingEnd;
    if (!hd) {
      const centre = -road.centreOffset;
      if (road.median) for (const side of [-1, 1]) marking(batch, road, centre + side * Math.max(0.15, road.median / 2), 0.15, m0, m1, 0xead38a);
      // GB 5768.3 导向车道线: 距停止线 30m 内车道分界线变为实线,之外恢复虚线。
      // 短路段自适应: 路口间距不足时缩小乃至省略实线段,保证虚线始终存在。
      const GUIDE = SPEC.guideZone, SOLID0 = SPEC.solidZoneGap;
      const usable = to - from;
      const guideLen = usable < 44 ? 0 : Math.min(GUIDE, (usable - 24) / 2);
      const dashLo = road.crossingStart ? from + SOLID0 + guideLen : m0;
      const dashHi = road.crossingEnd ? to - SOLID0 - guideLen : m1;
      for (const dir of [1, -1]) {
        const count = dir === 1 ? road.lanesForward : road.lanesBackward;
        for (let i = 1; i < count; i++) {
          const offset = centre + dir * (road.median / 2 + i * road.laneWidth);
          dashed(batch, road, offset, dashLo, dashHi, 0xe9ebe4, road.kind === 'highway' ? 6 : 3, road.kind === 'highway' ? 9 : 5);
          if (road.crossingEnd && guideLen >= 6) marking(batch, road, offset, 0.15, to - SOLID0 - guideLen, to - SOLID0);
          if (road.crossingStart && guideLen >= 6) marking(batch, road, offset, 0.15, from + SOLID0, from + SOLID0 + guideLen);
        }
      }
      // Left-turn waiting boxes (左转待转区) on approaches whose innermost
      // lane carries a left movement and has company (lanes >= 2).
      if (cfg.showCrosswalk && road.kind !== 'highway') {
        for (const [base, atEnd, dir] of [[to, true, 1], [from, false, -1]]) {
          const count = atEnd ? road.lanesForward : road.lanesBackward;
          if (count < 2) continue;
          const nodeId = atEnd ? road.to : road.from;
          const lane = (lanesByEdge.get(road.id) ?? []).find(l => l.direction === dir && l.index === 0 && l.to === nodeId);
          const moves = lane && laneMovements.get(lane.id);
          if (!moves || !moves.has('left')) continue;
          const inner = centre + dir * (road.median / 2 + 0.2), outer = centre + dir * (road.median / 2 + road.laneWidth - 0.2);
          const lo = Math.min(inner, outer), hi = Math.max(inner, outer), cap = base + dir * SPEC.waitingBox.depth;
          const s0 = Math.min(base - dir * 5.2, cap), s1 = Math.max(base - dir * 5.2, cap);
          marking(batch, road, inner, 0.12, s0, s1);
          marking(batch, road, outer, 0.12, s0, s1);
          marking(batch, road, lo, hi, Math.min(cap - dir * 0.15, cap), Math.max(cap - dir * 0.15, cap));
        }
      }
      for (const side of [left + road.shoulder, right - road.shoulder]) marking(batch, road, side, 0.15, m0, m1);
      if (road.layer === 0 && road.kind !== 'local' && road.kind !== 'highway') {
        const total = road.path.at(-1).s;
        let side = road.trimStart % 2 < 1 ? 1 : -1;
        for (let s = road.trimStart + 16; s < total - road.trimEnd - 16; s += 34) {
          streetLight(batch, road, s, side, cfg);
          side = -side;
        }
      }
      if (road.layer === 0 && road.kind === 'arterial' && road.crossingStart) {
        // One bus stop shelter per arterial leg, halfway between junctions.
        const total = road.path.at(-1).s;
        const span = total - road.trimStart - road.trimEnd;
        if (span > 120) busStop(batch, road, road.trimStart + span * 0.45, road.trimStart % 2 < 1 ? 1 : -1, cfg);
      }
      // Approach widening taper (進入路口車道漸變): arterial/collector
      // junction approaches gain one extra queue lane over the last ~58 m,
      // eating the verge the way real Chinese arterials do.
      if (road.layer === 0 && road.kind !== 'local') {
        for (const [base, crossing, toward, count] of [
          [to, road.crossingEnd, 1, road.lanesForward],
          [from, road.crossingStart, -1, road.lanesBackward],
        ]) {
          if (!crossing || count < 2) continue;
          const edgeSide = toward === 1 ? right - 0.15 : left + 0.15;
          const gAt = s => toward === 1 ? base - s : s - base;
          const extraAt = s => SPEC.taperLaneW * smoothstep(Math.max(0, Math.min(1, 1 - (gAt(s) - 4) / SPEC.taperLen)));
          const outerAt = s => edgeSide + toward * (0.2 + extraAt(s));
          variableStrip(batch, road, s => edgeSide, outerAt, base - toward * (SPEC.taperLen + 4), base - toward * 4, 0.012, asphaltMaterial(), 'road');
          variableStrip(batch, road, outerAt, s => outerAt(s) + toward * 0.16, base - toward * (SPEC.taperLen + 4), base - toward * 4, 0.17, paintMaterial(), 'marking');
        }
      }
      // Planted median belt on arterials; concrete crash barrier on highways.
      if (road.median >= 1.5 && road.layer === 0) {
        if (road.kind === 'highway') {
          sweepWalls(batch, road, -road.median / 2 + 0.25, road.median / 2 - 0.25, from, to, 0.8, matStd(0xb3b4a9), 'road');
        } else {
          batch.add(strip(road, -road.median / 2 + 0.15, road.median / 2 - 0.15, from, to, 0.12), grassMaterial(), 'block');
          // 灌木球绿篱替代纯色方盒:flatShading 低多边形团块 + 色彩/尺寸抖动。
          const hedgeRand = randomFromSeed(hashSeed(cfg.scenerySeed ?? 7, `hedge/${road.id}`));
          for (let s = from + 6; s < to - 6; s += 1.15) {
            const p = roadPoint(road, s, (hedgeRand() - 0.5) * Math.max(0.3, road.median * 0.42));
            bush(batch, p.x, p.y + 0.1, p.z, 0.3 + hedgeRand() * 0.24, 0.68 + hedgeRand() * 0.25, hedgeRand);
          }
        }
      }
      if (road.kind === 'highway' && road.layer === 0) {
        for (const side of [left + 0.25, right - 0.25]) {
          const rail = makeRoad('rail', road.path.map(p => ({ ...roadPoint(road, p.s, side), y: p.y + 0.7 })));
          batch.add(strip(rail, -0.09, 0.09, from + 4, to - 4), matStd(0xcfd2cc, 0.6), 'road');
        }
      }
      // GB 5768.3: crosswalk bars 45cm wide at 60cm pitch, crossing depth 4m;
      // stop line 35cm across the approach, just upstream of the crosswalk.
      if (cfg.showCrosswalk && road.kind !== 'highway') {
        for (const [base, trim, crossing, toward] of [[from, road.trimStart, road.crossingStart, -1], [to, road.trimEnd, road.crossingEnd, 1]]) {
          if (trim < 1 || !crossing) continue;
          const centre = base - toward * SPEC.crosswalk.gap;
          for (let offset = left + 0.6; offset < right - 0.5; offset += SPEC.crosswalk.pitch)
            batch.add(strip(road, offset, Math.min(right - 0.4, offset + SPEC.crosswalk.barW), centre - SPEC.crosswalk.depth / 2, centre + SPEC.crosswalk.depth / 2, 0.035), paintMaterial(), 'marking');
          const inner = toward * road.median / 2;
          const kerb = toward === 1 ? right - 0.2 : left + 0.2;
          const s1 = base - toward * (SPEC.stopLineGap - SPEC.stopLineW / 2), s2 = base - toward * (SPEC.stopLineGap + SPEC.stopLineW / 2);
          batch.add(strip(road, Math.min(inner, kerb), Math.max(inner, kerb), Math.min(s1, s2), Math.max(s1, s2), 0.035), paintMaterial(), 'marking');
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
  for (const junction of city.junctions) {
    batch.add(polygon(junction.ring, junction.y), hd ? matStd(0x253039) : asphaltMaterial(), 'road');
    // Sidewalk collar: only the CORNER wedges between road mouths — the
    // junction box stays asphalt. Inner edge = the junction fillet curve at
    // sidewalk level; outer edge = a quadratic from one mouth's sidewalk end
    // to the next, bulged ~3m outward to slide under the block corner chamfer.
    // 外沿高程按 sin 弧从人行道面沉到地块面以下:转角读作缘石坡道,
    // 既不悬空也不留裸地。
    if (!hd && cfg.showSidewalk && junction.walkRing && junction.cx !== undefined
      && junction.ring.length % 9 === 0 && junction.walkRing.length === junction.ring.length) {
      const n = junction.ring.length, center = { x: junction.cx, z: junction.cz };
      const walkY = junction.y + 0.15;
      for (let i = 0; i < n; i += 9) {
        const A = junction.walkRing[(i + 9) % n], B = junction.walkRing[i + 1];
        const mx = (A.x + B.x) / 2 - center.x, mz = (A.z + B.z) / 2 - center.z;
        const md = Math.hypot(mx, mz) || 1, mk = (md + 3) / md;
        const C = { x: center.x + mx * mk, z: center.z + mz * mk };
        const pts = [];
        for (let k = 1; k <= 9; k++) pts.push({ ...junction.ring[(i + k) % n], y: walkY });
        for (let k = 0; k <= 6; k++) {
          const t = k / 6, u = 1 - t;
          pts.push({ x: u * u * A.x + 2 * u * t * C.x + t * t * B.x,
            z: u * u * A.z + 2 * u * t * C.z + t * t * B.z,
            y: walkY - 0.4 * Math.sin(Math.PI * t) });
        }
        batch.add(polygon(pts, walkY), pavingMaterial(), 'sidewalk');
      }
    }
    if (!hd && junction.roundabout) {
      const R = Math.max(junction.radius, 18), islandR = R * 0.42;
      const circle = (r, n) => Array.from({ length: n }, (_, i) => {
        const a = i / n * Math.PI * 2;
        return { x: junction.cx + Math.cos(a) * r, z: junction.cz + Math.sin(a) * r };
      });
      ribbon(batch, circle(islandR + 0.45, 48), circle(R * 0.96, 48), junction.y + 0.012, asphaltMaterial(), 'road');
      ribbon(batch, circle(islandR, 36), circle(islandR + 0.45, 36), junction.y + 0.07, matStd(0x8f8d84), 'road');
      batch.add(polygon(circle(islandR, 36), junction.y + 0.16), grassMaterial(), 'block');
      const rbRand = randomFromSeed((cfg.scenerySeed ?? 7) + Math.round(junction.cx) * 31 + Math.round(junction.cz));
      for (let k = 0; k < 5; k++) {
        const a = k / 5 * Math.PI * 2 + rbRand() * 0.9, r = islandR * (0.2 + rbRand() * 0.5);
        tree(batch, { x: junction.cx + Math.cos(a) * r, z: junction.cz + Math.sin(a) * r, size: 4.5 + rbRand() * 3.2,
          seed: Math.round((cfg.scenerySeed ?? 7) + Math.round(junction.cx) * 17 + Math.round(junction.cz) * 5 + k * 977) });
      }
    }
  }
  for (const lane of city.lanes) {
    if (hd) {
      batch.add(strip(makeRoad(lane.id, lane.path), -0.22, 0.22, 0, lane.path.at(-1).s, 0.09), matStd(lane.direction === 1 ? 0x72cfdf : 0xddc48a), 'topology');
      arrow(batch, lane.path, Math.max(2, lane.path.at(-1).s - 14), 0xb6eee6, 1.8);
      continue;
    }
    if (cfg.showArrows && laneMovements.has(lane.id)) driveArrows(batch, lane, [...laneMovements.get(lane.id)]);
  }
  if (hd || cfg.showTopology) for (const connector of city.connectors) {
    batch.add(strip(makeRoad(connector.id, connector.path), -0.2, 0.2, 0, connector.path.at(-1).s, 0.1), matStd(TURN_COLORS[connector.movement]), 'topology');
    arrow(batch, connector.path, connector.path.at(-1).s * 0.6, TURN_COLORS[connector.movement], 0.9, 0.12);
  }
  if (!hd) {
    // 街区面抬到与人行道同一基准(路床 0.32 - 15cm 路缘):建筑地块整面
    // 铺砖、绿地铺草,裙墙落到地面 —— 建筑与人行道之间不再有裸土断层。
    // 基面 0.29 比地块面低 1.2cm:未被细分的地块角落也有铺装兜底。
    for (const block of city.blocks) {
      batch.add(polygon(block.ring, 0.29), block.park ? grassMaterial() : matStd(0x8b8d84, 0.95), 'block');
      const ring = block.ring;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        batch.add(quad({ ...a, y: 0.3 }, { ...b, y: 0.3 }, { ...b, y: 0.02 }, { ...a, y: 0.02 }), matStd(0x8b8d88, 0.9), 'block');
      }
    }
    for (const parcel of city.parcels)
      batch.add(polygon(parcel.ring, 0.302), parcel.use === 'green' ? grassMaterial() : pavingMaterial(),
        parcel.use === 'green' ? 'block' : 'sidewalk');
    if (cfg.showBuildings) { city.buildings.forEach(b => building(batch, b)); city.trees.forEach(t => tree(batch, t)); }
    // 写实街道层:电线杆与线缆、标志牌、主干路护栏、路口护柱、草丛。
    utilityPoles(batch, city, cfg);
    roadSigns(batch, city, cfg);
    sidewalkRailings(batch, city, cfg);
    junctionBollards(batch, city);
    if (cfg.showBuildings) grassTufts(batch, city, cfg);
    for (const support of city.supports) {
      const capHeight = 0.65;
      batch.box(support.x, (support.top - capHeight) / 2, support.z, 1.4, support.top - capHeight, 1.4, matStd(0xb3b4a9), 'bridge');
      batch.box(support.x, support.top - capHeight / 2, support.z, 2.2, capHeight, support.width, matStd(0xb3b4a9), 'bridge', -Math.atan2(support.tz || 0, support.tx || 1));
    }
  }
  batch.flush(group);
  group.userData = { generator: 'sd-hd-city-v1', seeds: city.seeds, units: 'metres' };
}
