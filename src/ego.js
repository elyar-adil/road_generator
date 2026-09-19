// Ego vehicle: random roaming plus GPS-style navigation over the SD graph.
// Routing happens on the node graph (Dijkstra), the node sequence is then
// expanded into a drivable polyline that follows the right-most HD lane of
// every traversed edge, with cubic transitions across junctions.
import * as THREE from 'three';
import { cubicPoints, samplePath, smoothstep, stationPath } from './corridor.js';
import { JUNCTION_SPEC as SPEC } from './junction-spec.js';

// The citywide signal cycle every consumer (lamp renderer, ego, background
// traffic) must agree on: NS green 0-6s, yellow 6-7s, EW green 8-14s,
// yellow 14-15s, 1s all-red clearances between phases.
export const SIGNAL_CYCLE = 16;
export function signalPhase(time) {
  const phase = ((time % SIGNAL_CYCLE) + SIGNAL_CYCLE) % SIGNAL_CYCLE;
  return {
    ns: phase < 6 ? 'green' : phase < 7 ? 'yellow' : 'red',
    ew: phase >= 8 && phase < 14 ? 'green' : phase >= 14 && phase < 15 ? 'yellow' : 'red',
  };
}

export function buildRouteGraph(city) {
  const nodes = new Map(city.sd.nodes.map(n => [n.id, n]));
  const adj = new Map(city.sd.nodes.map(n => [n.id, []]));
  for (const edge of city.sd.edges) {
    const a = nodes.get(edge.from), b = nodes.get(edge.to);
    if (!a || !b) continue;
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (edge.lanesForward > 0) adj.get(edge.from).push({ to: edge.to, edgeId: edge.id, length });
    if (edge.lanesBackward > 0) adj.get(edge.to).push({ to: edge.from, edgeId: edge.id, length });
  }
  return adj;
}

export function planRoute(city, fromId, toId) {
  if (fromId === toId) return [fromId];
  const adj = buildRouteGraph(city);
  const best = new Map([[fromId, 0]]), prev = new Map(), queue = [[0, fromId]];
  while (queue.length) {
    queue.sort((a, b) => a[0] - b[0]);
    const [dist, id] = queue.shift();
    if (dist > (best.get(id) ?? Infinity)) continue;
    if (id === toId) break;
    for (const hop of adj.get(id) ?? []) {
      const next = dist + hop.length;
      if (next < (best.get(hop.to) ?? Infinity)) {
        best.set(hop.to, next);
        prev.set(hop.to, id);
        queue.push([next, hop.to]);
      }
    }
  }
  if (!best.has(toId)) return null;
  const route = [toId];
  while (route[0] !== fromId) route.unshift(prev.get(route[0]));
  return route;
}

// Node-id sequence -> drivable polyline along the right-most lane of every
// traversed edge (right-hand traffic), smoothed across each junction.
// Returns the station path plus junction boundaries (stop-line station,
// node id and signal axis) so drivers can obey traffic signals.
export function routePlan(city, route, options = {}) {
  const roads = new Map(city.roads.map(r => [r.id, r]));
  const laneFor = (fromId, toId) => {
    const edge = city.sd.edges.find(e => (e.from === fromId && e.to === toId) || (e.from === toId && e.to === fromId));
    if (!edge) return null;
    const road = roads.get(edge.id);
    if (!road) return null;
    const forward = edge.from === fromId;
    const count = forward ? road.lanesForward : road.lanesBackward;
    if (count < 1) return null;
    const index = options.lanePick === 'random' ? Math.floor(Math.random() * count) : count - 1;
    return city.lanes.find(l => l.edgeId === edge.id && l.from === fromId && l.to === toId && l.index === index) ?? null;
  };
  const tangent = (path, atEnd) => {
    const a = atEnd ? path.at(-2) : path[0], b = atEnd ? path.at(-1) : path[1];
    const d = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return { x: (b.x - a.x) / d, z: (b.z - a.z) / d };
  };
  const pieces = [], marks = [], starts = [], points = [];
  for (let i = 0; i + 1 < route.length; i++) {
    const lane = laneFor(route[i], route[i + 1]);
    if (!lane) continue;
    const len = lane.path.at(-1).s;
    const t = tangent(lane.path, true);
    // Stop target: stop line (5.2m upstream of the trim) minus half a car.
    marks.push({ station: Math.max(0, len - SPEC.stopLineGap - 2.2), nodeId: route[i + 1],
      axis: Math.abs(t.x) >= Math.abs(t.z) ? 'ew' : 'ns' });
    if (pieces.length) {
      const from = pieces.at(-1).path.at(-1), to = lane.path[0];
      if (from && to && (from.x !== to.x || from.z !== to.z)) {
        const outT = tangent(pieces.at(-1).path, true), inT = tangent(lane.path, false);
        const handle = Math.hypot(to.x - from.x, to.z - from.z) * 0.4;
        points.push(...cubicPoints(from, { x: from.x + outT.x * handle, z: from.z + outT.z * handle },
          { x: to.x - inT.x * handle, z: to.z - inT.z * handle }, to, 10)
          .slice(1, -1).map((p, j, arr) => ({ ...p, y: from.y + (to.y - from.y) * smoothstep((j + 1) / (arr.length + 1)) })));
      }
    }
    starts.push(points.length);
    points.push(...lane.path);
    pieces.push(lane);
  }
  if (!pieces.length) return null;
  const path = stationPath(points);
  // Junction stop lines are located after the full path is assembled so the
  // transition curves between lane pieces count toward the station.
  const boundaries = marks.map((m, i) => ({ ...m, s: path[starts[i]].s + m.station }));
  return { path, boundaries };
}

export function routePath(city, route, options = {}) {
  return routePlan(city, route, options)?.path ?? null;
}

export function createEgoCar() {
  const group = new THREE.Group();
  // 双色车身 + 深色侧窗带,让方块车在街景里读出"轿车"的分层轮廓。
  const paint = new THREE.MeshStandardMaterial({ color: 0xdfe3e6, roughness: 0.32, metalness: 0.45 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.55, 4.5), paint);
  body.position.y = 0.62; body.castShadow = true;
  const skirt = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.22, 4.3), new THREE.MeshStandardMaterial({ color: 0x2c3034, roughness: 0.7 }));
  skirt.position.y = 0.38;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.65, 0.5, 2.1), new THREE.MeshStandardMaterial({ color: 0x232a31, roughness: 0.16, metalness: 0.55 }));
  cabin.position.set(0, 1.12, -0.25); cabin.castShadow = true;
  const cabinRoof = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.08, 1.9), paint);
  cabinRoof.position.set(0, 1.39, -0.25);
  group.add(body, skirt, cabin, cabinRoof);
  const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.24, 12);
  wheelGeo.rotateZ(Math.PI / 2);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1c1e20, roughness: 0.9 });
  const hubGeo = new THREE.CylinderGeometry(0.15, 0.15, 0.26, 8);
  hubGeo.rotateZ(Math.PI / 2);
  const hubMat = new THREE.MeshStandardMaterial({ color: 0x9aa1a8, roughness: 0.35, metalness: 0.7 });
  for (const [x, z] of [[-0.85, 1.45], [0.85, 1.45], [-0.85, -1.45], [0.85, -1.45]]) {
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.position.set(x, 0.34, z);
    const hub = new THREE.Mesh(hubGeo, hubMat);
    hub.position.set(x, 0.34, z);
    group.add(wheel, hub);
  }
  group.visible = false;
  return group;
}

// GPS-style ribbon above the route; rebuilt whenever the route changes.
export function createRouteLine(path, color = 0x35b6ff) {
  // 贴地细带:导航指示是 UI 层,不该压过场景 —— 半透明、0.28m 宽、
  // 紧贴路面,远看是一条引导线而不是一条跑道。
  const half = 0.14, lift = 0.09, positions = [], indices = [];
  path.forEach((p, i) => {
    const n = path[Math.min(i + 1, path.length - 1)], pv = path[Math.max(i - 1, 0)];
    const tx = n.x - pv.x, tz = n.z - pv.z, d = Math.hypot(tx, tz) || 1;
    const nx = -tz / d * half, nz = tx / d * half;
    positions.push(p.x - nx, p.y + lift, p.z - nz, p.x + nx, p.y + lift, p.z + nz);
    if (i) { const k = i * 2; indices.push(k - 2, k - 1, k, k - 1, k + 1, k); }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, toneMapped: false, depthWrite: false }));
}

export class EgoController {
  constructor(city, options = {}) {
    this.maxSpeed = options.speed ?? 12;
    this.accel = options.accel ?? 2.4;        // m/s² straight-line acceleration
    this.brake = options.brake ?? 4.2;        // m/s² braking
    this.latAccelMax = options.latAccel ?? 2.4; // comfortable lateral acceleration
    this.speed = 0;
    this.setCity(city);
    this.mode = 'idle';
  }

  setCity(city) {
    this.city = city;
    this.adj = buildRouteGraph(city);
    const ids = city.sd.nodes.map(n => n.id);
    this.nodeId = ids[Math.floor(Math.random() * ids.length)];
    this.path = null;
    this.boundaries = [];
    this.waiting = null;
    this.time = 0;
    this.s = 0;
    this.speed = 0;
    this.arrived = true;
    this.routeVersion = 0;
  }

  spawnNear(point) {
    let best = null, dist = Infinity;
    for (const n of this.city.sd.nodes) {
      const d = Math.hypot(n.x - point.x, n.z - point.z);
      if (d < dist) { dist = d; best = n; }
    }
    if (best) this.nodeId = best.id;
  }

  currentPose() {
    return this.path ? samplePath(this.path, this.s) : null;
  }

  remaining() {
    return this.path ? Math.max(0, this.path.at(-1).s - this.s) : 0;
  }

  #nearestNodeId() {
    const pose = this.currentPose();
    if (!pose) return this.nodeId;
    let best = null, dist = Infinity;
    for (const n of this.city.sd.nodes) {
      const d = Math.hypot(n.x - pose.x, n.z - pose.z);
      if (d < dist) { dist = d; best = n.id; }
    }
    return best ?? this.nodeId;
  }

  #beginLeg(route, mode) {
    const plan = routePlan(this.city, route);
    if (!plan) return false;
    this.path = plan.path;
    this.boundaries = plan.boundaries;
    this.s = 0;
    this.arrived = false;
    this.waiting = null;
    this.mode = mode;
    this.target = route.at(-1);
    this.routeVersion++;
    return true;
  }

  navigateTo(nodeId, mode = 'nav') {
    const from = this.#nearestNodeId();
    const route = planRoute(this.city, from, nodeId);
    return route ? this.#beginLeg(route, mode) : false;
  }

  startRoam() {
    if (this.arrived || !this.path) this.#nextRoamLeg();
    if (this.mode === 'idle') this.mode = 'roam';
  }

  #nextRoamLeg() {
    const from = this.#nearestNodeId();
    const far = this.city.sd.nodes.filter(n => {
      if (n.id === from) return false;
      return Math.hypot(n.x - this.#nodeX(from), n.z - this.#nodeZ(from)) > 300;
    });
    const pool = far.length ? far : this.city.sd.nodes.filter(n => n.id !== from);
    // Try several candidates so one unroutable target can't kill the roam.
    for (let tries = 0; tries < 6 && pool.length; tries++) {
      const pick = pool[Math.floor(Math.random() * pool.length)];
      if (this.navigateTo(pick.id, 'roam')) return;
    }
    this.mode = 'idle';
    this.arrived = true;
  }

  #nodeX(id) { return this.city.sd.nodes.find(n => n.id === id)?.x ?? 0; }
  #nodeZ(id) { return this.city.sd.nodes.find(n => n.id === id)?.z ?? 0; }

  stop() {
    this.mode = 'idle';
  }

  // Next stop line the car must obey, or null when the way is clear. The
  // controller shares signalPhase() with the lamp renderer, so the car, the
  // signals and any future background traffic always agree on the cycle.
  #signalStop(time) {
    for (const b of this.boundaries) {
      if (b.s < this.s - 0.5) continue;      // already crossed
      const light = signalPhase(time)[b.axis];
      if (light === 'green') return null;
      // Yellow with no room to brake comfortably: clear the junction instead.
      if (light === 'yellow' && b.s - this.s < this.speed * this.speed / (2 * this.brake)) return null;
      return b;
    }
    return null;
  }

  update(dt, time) {
    // Vehicle dynamics: acceleration/braking limits plus corner-speed caps
    // from sampled path curvature with a braking-distance envelope, so the
    // car slows into turns and speeds up on straights instead of gliding.
    // `time` is the shared traffic clock (trafficTime in the app); when it is
    // omitted the controller runs its own clock for headless use.
    this.time += dt;
    const now = time ?? this.time;
    if (!this.path || this.mode === 'idle' || this.arrived) {
      this.waiting = null;
      this.speed = Math.max(0, this.speed - 5 * dt);
      return;
    }
    const total = this.path.at(-1).s;
    let target = this.maxSpeed;
    for (const ahead of [0, 8, 18, 30, 44]) {
      const s = Math.min(total, this.s + ahead);
      const k = this.#curvatureAt(s);
      const corner = Math.sqrt(this.latAccelMax / Math.max(k, 1e-4));
      target = Math.min(target, Math.sqrt(corner * corner + 2 * this.brake * ahead));
    }
    const stop = this.#signalStop(now);
    this.waiting = null;
    if (stop) {
      const gap = stop.s - this.s;
      if (gap <= 0.25) {
        this.waiting = stop;
        target = 0;
      } else {
        target = Math.min(target, Math.sqrt(Math.max(0, 2 * this.brake * (gap - 0.15))));
      }
    }
    if (this.speed < target) this.speed = Math.min(target, this.speed + this.accel * dt);
    else this.speed = Math.max(target, this.speed - this.brake * dt);
    this.s = Math.min(total, this.s + this.speed * dt);
    this.nodeId = this.#nearestNodeId();
    if (this.s >= total - 0.01) {
      this.arrived = true;
      this.waiting = null;
      this.speed = 0;
      if (this.mode === 'roam') this.#nextRoamLeg();
    }
  }

  #curvatureAt(s) {
    const total = this.path.at(-1).s;
    const a = samplePath(this.path, Math.max(0.01, s - 3));
    const b = samplePath(this.path, Math.min(total, s + 3));
    const d = Math.abs(Math.atan2(b.tz, b.tx) - Math.atan2(a.tz, a.tx));
    return Math.min(d, Math.PI * 2 - d) / 6;
  }
}
