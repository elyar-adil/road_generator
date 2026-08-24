// Render layer: maps the derived scene (lane-derive.js) to THREE meshes.
//
// Everything here is presentation: materials, heights, colours. Geometry and
// placement decisions live in the derivation layer, so a different renderer
// (or an export pipeline) can consume the same scene data.
//
// Markings/surfaces are accumulated into a MarkBatch and flushed as one merged
// mesh per material (+cast-shadow variant), keeping draw calls in the low tens
// instead of one-per-dash.

import * as THREE from 'three';
import {
  add, scl, sub, len, buildDashedSegments,
} from './geometry.js';

export const ROAD_THEME = {
  asphalt: 0x2c2f36,
  curb: 0xb9b2a3,
  sidewalk: 0xa7a196,
  median: 0x6f8a5c,
  white: 0xf4f4f2,
  yellow: 0xf2c230,
  poleGray: 0x3a3f46,
  lightHousing: 0x22262b,
  ground: 0x4c6b3d,
  waitingSurface: 0x343941,
  buildingBase: [0x6b6f76, 0x7a6a5c, 0x5c6a78, 0x716357, 0x60686f],
};

const matCache = new Map();
export function matStd(color, roughness = 0.9) {
  const key = `${color}_${roughness}`;
  if (!matCache.has(key)) {
    matCache.set(key, new THREE.MeshStandardMaterial({
      color, roughness, metalness: 0.02, side: THREE.DoubleSide,
    }));
  }
  return matCache.get(key);
}

// Emissive materials (street-lamp heads, traffic-light lamps) are shared across
// every instance: the animation loop drives all lamps in sync, so one material
// per colour is enough and keeps them out of per-regenerate disposal.
const glowCache = new Map();
export function glowMat(color, emissive, intensity, roughness = 0.4) {
  const key = `g_${color}_${emissive}_${intensity}`;
  if (!glowCache.has(key)) {
    glowCache.set(key, new THREE.MeshStandardMaterial({
      color, emissive, emissiveIntensity: intensity, roughness,
    }));
  }
  return glowCache.get(key);
}

function lampMaterial(hex) {
  const key = `lamp_${hex}`;
  if (!glowCache.has(key)) {
    glowCache.set(key, new THREE.MeshStandardMaterial({
      color: hex, emissive: hex, emissiveIntensity: 0, roughness: 0.35,
    }));
  }
  return glowCache.get(key);
}

// ---------------------------------------------------------------- MESH PRIMITIVES

export function boxAlong(p0, p1, opt) {
  const dx = p1.x - p0.x, dz = p1.y - p0.y;
  const segLen = Math.hypot(dx, dz);
  if (segLen < 1e-5) return null;
  const ang = Math.atan2(dz, dx);
  const nx = -Math.sin(ang), nz = Math.cos(ang);
  const lateral = opt.lateral || 0;
  const extend = opt.extend !== undefined ? opt.extend : 0.15;
  const midx = (p0.x + p1.x) / 2 + nx * lateral;
  const midz = (p0.y + p1.y) / 2 + nz * lateral;
  const w = opt.width, h = opt.height, yBottom = opt.yBottom || 0;
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(segLen + extend, h, w),
    opt.material || matStd(opt.color || ROAD_THEME.curb, opt.rough),
  );
  mesh.position.set(midx, yBottom + h / 2, midz);
  mesh.rotation.y = -ang;
  if (opt.castShadow) mesh.castShadow = true;
  if (opt.receiveShadow !== false) mesh.receiveShadow = true;
  return mesh;
}

export function flatPoly(pts2D, y, color, { rough = 0.9 } = {}) {
  const shapePts = pts2D.map((p) => new THREE.Vector2(p.x, p.y));
  let faces;
  try {
    faces = THREE.ShapeUtils.triangulateShape(shapePts, []);
  } catch (e) {
    return null;
  }
  const positions = [];
  shapePts.forEach((p) => positions.push(p.x, y, p.y));
  const indices = [];
  faces.forEach((f) => indices.push(f[0], f[1], f[2]));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, matStd(color, rough));
  mesh.receiveShadow = true;
  return mesh;
}

// Thin flat strip along an open polyline (centreline overlay etc.). Built as
// an explicit triangle strip - never passed through the ear-cutting
// triangulator, whose flipped ears turn dense near-collinear slivers into
// garbage polygons.
export function pathRibbon(path, width, y, color, { rough = 0.9 } = {}) {
  if (!path || path.length < 2) return null;
  const half = width / 2;
  const left = [], right = [];
  for (let i = 0; i < path.length; i += 1) {
    const prev = path[Math.max(0, i - 1)], next = path[Math.min(path.length - 1, i + 1)];
    const t = sub(next, prev);
    const tl = len(t) || 1;
    const nx = t.y / tl, ny = -t.x / tl; // right normal of the tangent
    left.push(add(path[i], scl({ x: nx, y: ny }, -half)));
    right.push(add(path[i], scl({ x: nx, y: ny }, half)));
  }
  const count = path.length;
  const positions = new Float32Array(count * 2 * 3);
  for (let i = 0; i < count; i += 1) {
    positions[i * 6 + 0] = left[i].x; positions[i * 6 + 1] = y; positions[i * 6 + 2] = left[i].y;
    positions[i * 6 + 3] = right[i].x; positions[i * 6 + 4] = y; positions[i * 6 + 5] = right[i].y;
  }
  const indices = [];
  for (let i = 0; i < count - 1; i += 1) {
    const l0 = i * 2, r0 = i * 2 + 1, l1 = i * 2 + 2, r1 = i * 2 + 3;
    indices.push(l0, r0, l1, r1, l1, r0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, matStd(color, rough));
  mesh.receiveShadow = true;
  return mesh;
}

// ---------------------------------------------------------------- MARK BATCHING

// Template data of a unit cube; every batched marking box is an affine
// (scale -> rotate Y -> translate) copy of these vertices.
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const BOX_POS = UNIT_BOX.attributes.position.array;
const BOX_NORM = UNIT_BOX.attributes.normal.array;
const BOX_UV = UNIT_BOX.attributes.uv.array;
const BOX_IDX = UNIT_BOX.index.array;
const BOX_VERT_COUNT = BOX_POS.length / 3;

function pushBatchBox(part, p0, p1, opt) {
  const dx = p1.x - p0.x, dz = p1.y - p0.y;
  const segLen = Math.hypot(dx, dz);
  if (segLen < 1e-5) return;
  const ang = Math.atan2(dz, dx);
  const nx = -Math.sin(ang), nz = Math.cos(ang);
  const lateral = opt.lateral || 0;
  const extend = opt.extend !== undefined ? opt.extend : 0.15;
  const cx = (p0.x + p1.x) / 2 + nx * lateral;
  const cz = (p0.y + p1.y) / 2 + nz * lateral;
  const sx = segLen + extend, sy = opt.height, sz = opt.width;
  const cy = (opt.yBottom || 0) + sy / 2;
  const cos = Math.cos(-ang), sin = Math.sin(-ang);
  const start = part.vertexCount;
  for (let i = 0; i < BOX_POS.length; i += 3) {
    const x = BOX_POS[i] * sx, y = BOX_POS[i + 1] * sy, z = BOX_POS[i + 2] * sz;
    part.positions.push(x * cos + z * sin + cx, y + cy, -x * sin + z * cos + cz);
    const nxv = BOX_NORM[i], nyv = BOX_NORM[i + 1], nzv = BOX_NORM[i + 2];
    part.normals.push(nxv * cos + nzv * sin, nyv, -nxv * sin + nzv * cos);
  }
  for (let i = 0; i < BOX_UV.length; i += 1) part.uvs.push(BOX_UV[i]);
  for (let i = 0; i < BOX_IDX.length; i += 1) part.indices.push(BOX_IDX[i] + start);
  part.vertexCount += BOX_VERT_COUNT;
}

function pushBatchPoly(part, pts, y) {
  const shapePts = pts.map((p) => new THREE.Vector2(p.x, p.y));
  let faces;
  try {
    faces = THREE.ShapeUtils.triangulateShape(shapePts, []);
  } catch (e) {
    return false;
  }
  const start = part.vertexCount;
  for (const p of pts) {
    part.positions.push(p.x, y, p.y);
    part.normals.push(0, 1, 0);
    part.uvs.push(0, 0);
  }
  part.vertexCount += pts.length;
  for (const f of faces) part.indices.push(f[0] + start, f[1] + start, f[2] + start);
  return true;
}

// Accumulates boxes and flat polygons grouped by (material, castShadow) and
// flushes them as one merged BufferGeometry mesh per group.
export class MarkBatch {
  constructor() {
    this.parts = new Map();
  }

  part(color, rough, cast) {
    const key = `${color}|${rough}|${cast ? 1 : 0}`;
    let part = this.parts.get(key);
    if (!part) {
      part = { positions: [], normals: [], uvs: [], indices: [], vertexCount: 0, cast };
      this.parts.set(key, part);
    }
    return part;
  }

  box(p0, p1, opt) {
    const color = opt.color === undefined ? ROAD_THEME.curb : opt.color;
    const rough = opt.rough === undefined ? 0.9 : opt.rough;
    pushBatchBox(this.part(color, rough, Boolean(opt.castShadow)), p0, p1, opt);
  }

  poly(pts, y, color, rough = 0.9) {
    if (!pts || pts.length < 3) return null;
    return pushBatchPoly(this.part(color, rough, false), pts, y);
  }

  flush(group) {
    this.parts.forEach((part, key) => {
      if (!part.indices.length) return;
      const [color, rough, cast] = key.split('|');
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(part.positions, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(part.normals, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(part.uvs, 2));
      geo.setIndex(part.indices);
      const mesh = new THREE.Mesh(geo, matStd(Number(color), Number(rough)));
      mesh.castShadow = cast === '1';
      mesh.receiveShadow = true;
      group.add(mesh);
    });
  }
}

function pathStripRing(path, width, offset) {
  if (!path || path.length < 2) return null;
  const outer = [], inner = [];
  for (let i = 0; i < path.length; i += 1) {
    const p = path[i];
    const prev = path[Math.max(0, i - 1)], next = path[Math.min(path.length - 1, i + 1)];
    const tangent = sub(next, prev), tangentLen = len(tangent) || 1;
    const normal = { x: tangent.y / tangentLen, y: -tangent.x / tangentLen };
    outer.push(add(p, scl(normal, offset + width / 2)));
    inner.push(add(p, scl(normal, offset - width / 2)));
  }
  return outer.concat(inner.reverse());
}

function addDashSegments(batch, segments, width, yBottom, theme) {
  segments.forEach(([p0, p1]) => {
    batch.box(p0, p1, {
      lateral: 0, width, height: 0.008, yBottom,
      color: theme.white, rough: 0.6, extend: 0,
    });
  });
}

function addGuardrail(batch, group, rail, theme) {
  const { posts, rail: span, yBottom, height } = rail;
  const railMat = matStd(0xc9cdd2, 0.35);
  posts.forEach((p) => {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, height, 6), railMat);
    post.position.set(p.x, yBottom + height / 2, p.y);
    post.castShadow = true;
    group.add(post);
  });
  batch.box(span.p0, span.p1, {
    lateral: 0, width: 0.07, height: 0.08, yBottom: yBottom + height * 0.62,
    color: 0xd7dade, rough: 0.35, extend: 0,
  });
}

function addArrows(batch, arrows, theme) {
  arrows.forEach(({ pts }) => {
    const polys = Array.isArray(pts[0]) ? pts : [pts];
    polys.forEach((poly) => batch.poly(poly, 0.092, theme.white, 0.75));
  });
}

function buildTrafficLight(theme) {
  const group = new THREE.Group();
  const poleMat = matStd(theme.poleGray, 0.5);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 4.3, 10), poleMat);
  pole.position.y = 2.15;
  pole.castShadow = true;
  group.add(pole);
  const housing = new THREE.Mesh(new THREE.BoxGeometry(0.55, 1.5, 0.4), matStd(theme.lightHousing, 0.4));
  housing.position.set(0, 3.9, 0.18);
  housing.castShadow = true;
  group.add(housing);
  const make = (color) => lampMaterial(color);
  const onOff = [0xd0342c, 0xf2c230, 0x2fbf71];
  const lamps = onOff.map((hex) => ({
    mesh: new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 10), make(hex)),
    on: hex,
    off: 0x221f1d,
  }));
  lamps.forEach((lamp, index) => {
    lamp.mesh.position.set(0, 3.95 - index * 0.42, 0.44);
    group.add(lamp.mesh);
  });
  return { group, lamps };
}

// Render a derived scene into `group`. Returns { lampSets } for animation.
export function renderRoadScene(derived, group, theme = ROAD_THEME) {
  const lampSets = [];
  const batch = new MarkBatch();

  // road surfaces: plain point arrays render at base height; {pts, y} entries
  // layer above (roundabout branch ribbons overlap stems/annulus).
  derived.roadSurfaces.forEach((entry) => {
    const pts = Array.isArray(entry) ? entry : entry.pts;
    const y = Array.isArray(entry) ? 0.01 : (entry.y ?? 0.01);
    batch.poly(pts, y, theme.asphalt, 0.95);
  });

  // median islands
  derived.medianIslands.forEach((pts) => {
    batch.poly(pts, 0.145, theme.median, 1);
    for (let i = 0; i < pts.length - 1; i += 1) {
      batch.box(pts[i], pts[i + 1], {
        lateral: 0, width: 0.18, height: 0.14, yBottom: 0.01,
        color: theme.curb, rough: 0.85, extend: 0.03, castShadow: true,
      });
    }
  });

  // double yellow centre lines
  derived.yellowLines.forEach(([p0, p1]) => {
    batch.box(p0, p1, {
      lateral: 0, width: 0.1, height: 0.01, yBottom: 0.015,
      color: theme.yellow, rough: 0.6, extend: 0,
    });
  });

  // longitudinal lane dashes + edge lines
  addDashSegments(batch, derived.laneDashes, 0.15, 0.09, theme);
  derived.laneEdges.forEach(([p0, p1]) => {
    batch.box(p0, p1, {
      lateral: 0, width: 0.12, height: 0.008, yBottom: 0.015,
      color: theme.white, rough: 0.6, extend: 0,
    });
  });

  // guardrails
  derived.guardrails.forEach((rail) => addGuardrail(batch, group, rail, theme));

  // stop lines
  derived.stopLines.forEach(([p0, p1]) => {
    batch.box(p0, p1, {
      lateral: 0, width: 0.5, height: 0.01, yBottom: 0.09,
      color: theme.white, rough: 0.6, extend: 0,
    });
  });

  // crosswalks
  derived.crosswalks.forEach(({ bars }) => {
    bars.forEach(([p0, p1]) => {
      batch.box(p0, p1, {
        lateral: 0, width: 0.5, height: 0.006, yBottom: 0.014,
        color: theme.white, rough: 0.6, extend: 0,
      });
    });
  });

  // right-turn branch pedestrian crossings + yield lines
  derived.branchCrossings.forEach(([p0, p1]) => {
    batch.box(p0, p1, {
      lateral: 0, width: 0.42, height: 0.008, yBottom: 0.092,
      color: theme.white, rough: 0.6, extend: 0,
    });
  });
  derived.branchYieldLines.forEach(([p0, p1]) => {
    batch.box(p0, p1, {
      lateral: 0, width: 0.32, height: 0.01, yBottom: 0.094,
      color: theme.white, rough: 0.6, extend: 0,
    });
  });

  // arrows
  addArrows(batch, derived.arrows, theme);

  // waiting areas: surface + dashed side lines + closing stop line + arrows
  derived.waitingAreas.forEach((wa) => {
    batch.poly(wa.left.concat(wa.right.slice().reverse()), 0.013, theme.waitingSurface, 1);
    addDashSegments(batch, wa.dashes, 0.15, 0.09, theme);
    batch.box(wa.left.at(-1), wa.right.at(-1), {
      lateral: 0, width: 0.5, height: 0.01, yBottom: 0.09,
      color: theme.white, rough: 0.6, extend: 0,
    });
    addArrows(batch, wa.arrows.map((pts) => ({ pts })), theme);
  });

  // guide areas: planted -> raised island with curb ring; hatched -> flat with
  // white boundary edge
  derived.guideAreas.forEach(({ pts, planted }) => {
    if (!pts) return;
    batch.poly(pts, planted ? 0.145 : 0.086, planted ? theme.median : theme.asphalt, 1);
    for (let index = 0; index < pts.length; index += 1) {
      const next = (index + 1) % pts.length;
      batch.box(pts[index], pts[next], planted
        ? {
            lateral: 0, width: 0.18, height: 0.14, yBottom: 0.02,
            color: theme.curb, rough: 0.85, extend: 0.03, castShadow: true,
          }
        : {
            lateral: 0, width: 0.15, height: 0.008, yBottom: 0.094,
            color: theme.white, rough: 0.6, extend: 0,
          });
    }
  });

  // guide chevrons
  addDashSegments(batch, derived.guideChevrons.map(([p0, p1]) => [p0, p1]), 0.35, 0.096, theme);

  // roundabout entry markings: dashed give-way line + solid give-way triangle
  (derived.entryMarks || []).forEach(({ dashes, legs }) => {
    addDashSegments(batch, dashes, 0.3, 0.094, theme);
    legs.forEach(([p0, p1]) => batch.box(p0, p1, {
      lateral: 0, width: 0.26, height: 0.01, yBottom: 0.094,
      color: theme.white, rough: 0.6, extend: 0,
    }));
  });

  // sidewalks + curbs
  derived.sidewalks.forEach((sw) => {
    const ring = pathStripRing(sw.path, sw.width, sw.offset);
    if (ring) batch.poly(ring, 0.075, theme.sidewalk, 1);
  });
  derived.curbs.forEach(([p0, p1]) => {
    batch.box(p0, p1, {
      lateral: 0, width: 0.32, height: 0.15, yBottom: 0.0,
      color: theme.curb, rough: 0.85, extend: 0.05, castShadow: true,
    });
  });

  // right-turn branch surfaces + dividers
  derived.branchSurfaces.forEach(({ pts }) => batch.poly(pts, 0.082, theme.asphalt, 0.95));
  // branch dividers (dashed, waiting-area cadence)
  derived.branchDividers.forEach((div) => {
    addDashSegments(batch, buildDashedSegments(div, 1.0, 1.0), 0.15, 0.09, theme);
  });

  // flush all merged marking/surface meshes into the group
  batch.flush(group);

  // traffic lights
  derived.trafficLights.forEach(({ pos, heading }) => {
    const { group: lightGroup, lamps } = buildTrafficLight(theme);
    lightGroup.position.set(pos.x, 0, pos.y);
    lightGroup.rotation.y = heading;
    group.add(lightGroup);
    lampSets.push(lamps);
  });

  // street lamps
  derived.streetLamps.forEach(({ pos, dir }) => {
    const poleMat = matStd(0x2c3036, 0.5);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 3.6, 8), poleMat);
    pole.position.set(pos.x, 1.8, pos.y);
    pole.castShadow = true;
    group.add(pole);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.9, 6), poleMat);
    arm.rotation.z = Math.PI / 2.6;
    arm.position.set(pos.x + 0.35 * dir.x, 3.5, pos.y + 0.35 * dir.y);
    group.add(arm);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), glowMat(0xfff1c2, 0xffdd88, 0.9));
    lamp.position.set(pos.x + 0.75 * dir.x, 3.35, pos.y + 0.75 * dir.y);
    group.add(lamp);
  });

  // buildings + trees
  derived.buildings.forEach((b) => {
    const body = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.d), matStd(b.color, 0.8));
    body.position.set(b.pos.x, b.h / 2, b.pos.y);
    body.rotation.y = b.rot;
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(b.w * 1.02, 0.3, b.d * 1.02), matStd(0x2a2d33, 0.9));
    roof.position.set(b.pos.x, b.h + 0.15, b.pos.y);
    roof.rotation.y = b.rot;
    group.add(roof);
  });
  derived.trees.forEach((t) => {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.17, 1.6, 6), matStd(0x5a4330, 0.9));
    trunk.position.set(t.pos.x, 0.8, t.pos.y);
    trunk.castShadow = true;
    group.add(trunk);
    const foliage = new THREE.Mesh(new THREE.ConeGeometry(1.3, 2.6, 8), matStd(0x2f6b3a, 0.9));
    foliage.position.set(t.pos.x, 2.6, t.pos.y);
    foliage.castShadow = true;
    group.add(foliage);
  });

  return { lampSets };
}
