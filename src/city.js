import { deriveHDMap, crossSection } from './hd-map.js';
import { generateSDMap, splitAtGradeCrossings, validateSDMap, extractBlocks, polygonArea, randomFromSeed, hashSeed } from './sd-map.js';
import { distanceToRoad } from './corridor.js';
import { SEMANTIC_CLASSES } from './semantics.js';

function clip(ring, nx, nz, constant) {
  const out = [];
  ring.forEach((p, i) => {
    const q = ring[(i + 1) % ring.length], a = p.x * nx + p.z * nz - constant, b = q.x * nx + q.z * nz - constant;
    if (a >= -1e-7) out.push(p);
    if ((a < 0) !== (b < 0)) { const t = a / (a - b); out.push({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t }); }
  });
  return out;
}

// Half-plane erosion guarantees parcels remain behind all road setbacks,
// including after a junction is moved. For non-convex faces, this conservatively
// keeps only the intersection of inward half-planes (or skips an empty result).
function inset(ring, distances) {
  let result = ring;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 1e-6) continue;
    const nx = -(b.z - a.z) / len, nz = (b.x - a.x) / len;
    result = clip(result, nx, nz, nx * a.x + nz * a.z + (Array.isArray(distances) ? distances[i] : distances));
    if (result.length < 3) return [];
  }
  return result;
}

const bounds = ring => ({ minX: Math.min(...ring.map(p => p.x)), maxX: Math.max(...ring.map(p => p.x)),
  minZ: Math.min(...ring.map(p => p.z)), maxZ: Math.max(...ring.map(p => p.z)) });

export function splitParcels(ring, random, depth = 0) {
  const b = bounds(ring), w = b.maxX - b.minX, d = b.maxZ - b.minZ;
  if (Math.max(w, d) < 46 || depth >= 8) return [ring];
  const axis = w > d ? 'x' : 'z', t = 0.4 + random() * 0.2;
  const cut = axis === 'x' ? b.minX + w * t : b.minZ + d * t;
  const a = clip(ring, axis === 'x' ? 1 : 0, axis === 'z' ? 1 : 0, cut);
  const c = clip(ring, axis === 'x' ? -1 : 0, axis === 'z' ? -1 : 0, -cut);
  if (a.length < 3 || c.length < 3) return [ring];
  return [...splitParcels(a, random, depth + 1), ...splitParcels(c, random, depth + 1)];
}

function deriveDistricts(sd, hd, cfg) {
  const edges = new Map(sd.edges.map(e => [e.id, e])), blocks = [], parcels = [], buildings = [], trees = [];
  const extent = Math.max(100, ...sd.nodes.map(n => Math.max(Math.abs(n.x), Math.abs(n.z))));
  const centres = sd.geography?.centres || [{ x: extent * 0.4, z: extent * 0.3 }, { x: -extent * 0.4, z: -extent * 0.4 }];
  const river = sd.geography?.river;
  const riverX = river?.points?.length > 1 ? (z => {
    let best = river.points[0], distance = Infinity;
    for (let i = 0; i < river.points.length - 1; i++) {
      const a = river.points[i], b = river.points[i + 1], dx = b.x - a.x, dz = b.z - a.z;
      const t = Math.max(0, Math.min(1, ((0 - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)));
      const p = { x: a.x + t * dx, z: a.z + t * dz }, d = Math.abs(p.z - z);
      if (d < distance) { distance = d; best = p; }
    }
    return best.x;
  }) : () => Infinity;
  const noise = (x, z, seed) => {
    const a = Math.sin(x * 0.017 + seed * 0.13) * 43758.5453;
    const b = Math.sin(z * 0.023 - seed * 0.07) * 24634.6345;
    return (a - Math.floor(a) + b - Math.floor(b)) * 0.5;
  };
  const elevated = hd.roads.filter(r => r.layer !== 0);
  for (const face of extractBlocks(sd)) {
    const seed = hashSeed(cfg.scenerySeed, face.id), rand = randomFromSeed(seed);
    const distances = face.edgeIds.map(id => crossSection(edges.get(id), cfg.laneWidth).width / 2 + cfg.sidewalkWidth + 1);
    const ring = inset(face.ring, distances);
    if (ring.length < 3 || polygonArea(ring) < 100) continue;
    const centreDistance = Math.min(...centres.map(c => Math.hypot((c.x - (face.ring[0]?.x || 0)), (c.z - (face.ring[0]?.z || 0)))));
    const blockScale = Math.sqrt(polygonArea(ring));
    const park = rand() < 0.055 + (blockScale > 180 ? 0.09 : 0) || face.ring.length > 9 && rand() < 0.12;
    blocks.push({ id: face.id, ring, park, seed });
    const lots = splitParcels(ring, rand);
    lots.forEach((lot, i) => {
      const id = `${face.id}/parcel-${i}`, lotSeed = hashSeed(seed, i), pr = randomFromSeed(lotSeed);
      const footprint = inset(lot, 2.5), area = polygonArea(footprint);
      if (footprint.length < 3 || area < 60) return;
      const b = bounds(footprint), x = (b.minX + b.maxX) / 2, z = (b.minZ + b.maxZ) / 2;
      // Interior lots become courtyards. Every building must have road frontage.
      const hasFrontage = lot.some(p => ring.some((a, k) => {
        const c = ring[(k + 1) % ring.length], dx = c.x - a.x, dz = c.z - a.z;
        return Math.abs(dx * (p.z - a.z) - dz * (p.x - a.x)) / (Math.hypot(dx, dz) || 1) < 1;
      }));
      const blocked = elevated.some(road => distanceToRoad({ x, z }, road) < road.width / 2 + Math.hypot(b.maxX - b.minX, b.maxZ - b.minZ) / 2 + 4);
      const arterialFrontage = face.edgeIds.some(id => ['arterial', 'highway'].includes(edges.get(id)?.class));
      const nearRiver = Math.abs(x - riverX(z)) < (river?.width || 0) * 2.5;
      const urbanity = Math.max(...centres.map(c => Math.exp(-Math.hypot(x - c.x, z - c.z) / (extent * 0.30))));
      const localVariation = noise(x, z, lotSeed % 997);
      const targetDensity = Math.min(0.98, cfg.cityDensity * (0.62 + urbanity * 0.48) + (arterialFrontage ? 0.12 : 0) - (nearRiver ? 0.08 : 0) + (localVariation - 0.5) * 0.18);
      const planted = park || !hasFrontage || blocked || pr() > targetDensity;
      parcels.push({ id, blockId: face.id, seed: lotSeed, ring: lot, use: planted ? 'green' : 'building' });
      if (planted) {
        if (!blocked) trees.push({ x, z, size: 4 + pr() * 4, seed: lotSeed });
        return;
      }
      const arterialRoad = face.edgeIds.some(id => ['arterial', 'highway'].includes(edges.get(id)?.class));
      const heightBias = arterialRoad ? 1.35 : 1;
      const floors = Math.max(2, Math.round(2 + urbanity ** 1.65 * heightBias * (8 + pr() * 29) + pr() * 2));
      buildings.push({ id: `${id}/building`, parcelId: id, blockId: face.id, seed: lotSeed, ring: footprint,
        x, z, h: floors * 3.2, floors, variant: Math.floor(pr() * 6),
        style: floors > 16 ? 'tower' : arterialRoad && floors > 8 ? 'mixed-use' : nearRiver ? 'waterfront' : 'residential' });
    });
  }
  return { blocks, parcels, buildings, trees, extent: extent + 35 };
}

export function buildCity(cfg) {
  const sd = splitAtGradeCrossings(cfg.sdMap || generateSDMap(cfg));
  const validation = validateSDMap(sd);
  if (!validation.valid) return { type: 'city', sd, validation, roads: [], lanes: [], connectors: [], junctions: [], facilities: [], supports: [],
    blocks: [], parcels: [], buildings: [], trees: [], extent: cfg.citySize / 2, warnings: validation.errors };
  const hd = deriveHDMap(sd, cfg);
  const districts = deriveDistricts(sd, hd, cfg);
  return { type: 'city', sd, validation, ...hd, ...districts, warnings: [...validation.warnings, ...hd.warnings],
    seeds: { roads: sd.seed, details: cfg.scenerySeed },
    roadArea: Math.round(hd.roads.reduce((a, r) => a + (r.path.at(-1).s - r.trimStart - r.trimEnd) * r.width, 0)) };
}

export function createSceneDocument(city) {
  return { format: 'procedural-city-scene', version: 1, generator: 'sd-hd-city-v1',
    coordinates: { units: 'metres', up: '+Y', north: '-Z', handedness: 'right' },
    seeds: city.seeds, semanticClasses: SEMANTIC_CLASSES,
    sdMap: city.sd, hdMap: { roads: city.roads, lanes: city.lanes, connectors: city.connectors },
    facilities: city.facilities, supports: city.supports, blocks: city.blocks, parcels: city.parcels,
    buildings: city.buildings, trees: city.trees, validation: city.validation, warnings: city.warnings };
}
