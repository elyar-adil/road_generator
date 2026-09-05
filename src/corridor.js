// Shared, renderer-independent 3D road geometry. x/z are plan coordinates;
// y is elevation in metres. Distances and markings use arc length.
export const smoothstep = t => { t = Math.max(0, Math.min(1, t)); return t * t * t * (10 + t * (-15 + 6 * t)); };
export const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

export function stationPath(points) {
  let s = 0;
  return points.map((p, i) => {
    if (i) s += distance(points[i - 1], p);
    return { ...p, s };
  });
}

export function samplePath(path, station) {
  const s = Math.max(0, Math.min(path.at(-1).s, station));
  let lo = 0, hi = path.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (path[mid].s < s) lo = mid; else hi = mid; }
  const a = path[lo], b = path[hi], t = (s - a.s) / (b.s - a.s || 1);
  const d = distance(a, b) || 1;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t, s, tx: (b.x - a.x) / d, tz: (b.z - a.z) / d };
}

export function offsetPoint(p, offset, lift = 0, crossfall = 0) {
  return { x: p.x - p.tz * offset, y: p.y + lift - offset * crossfall, z: p.z + p.tx * offset };
}

export function roadPoint(road, s, offset = 0, lift = 0) {
  return offsetPoint(samplePath(road.path, s), offset, lift, road.crossfall || 0);
}

export function makeRoad(id, points, options = {}) {
  return { id, kind: 'street', width: 7, lanes: 2, laneWidth: 3.5, shoulder: 0,
    crossfall: 0, depth: 0.2, ...options, path: stationPath(points) };
}

export function linePoints(a, b, height = () => 0.24, spacing = 3) {
  const count = Math.max(1, Math.ceil(distance(a, b) / spacing));
  return Array.from({ length: count + 1 }, (_, i) => {
    const t = i / count, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
    return { x, z, y: height(x, z, t) };
  });
}

export function cubicPoints(a, b, c, d, steps = 120) {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps, u = 1 - t;
    return { x: u ** 3 * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t ** 3 * d.x,
      z: u ** 3 * a.z + 3 * u * u * t * b.z + 3 * u * t * t * c.z + t ** 3 * d.z, y: 0 };
  });
}

export function maxGrade(path) {
  return path.slice(1).reduce((max, p, i) => Math.max(max, Math.abs(p.y - path[i].y) / (distance(p, path[i]) || 1)), 0);
}

// The 1.875 factor is the maximum derivative of the quintic easing function.
// Both grade and change of grade vanish at the ends of each approach.
export function bridgeProfile(height, plateau, grade = 0.045) {
  const approach = 1.875 * height / grade;
  const end = plateau + approach;
  return { end, plateau, approach, heightAt: u => height * (1 - smoothstep((Math.abs(u) - plateau) / approach)) };
}

export function distanceToRoad(point, road) {
  let nearest = Infinity;
  for (let i = 1; i < road.path.length; i++) {
    const a = road.path[i - 1], b = road.path[i];
    const dx = b.x - a.x, dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
    nearest = Math.min(nearest, Math.hypot(point.x - a.x - t * dx, point.z - a.z - t * dz));
  }
  return nearest;
}

// Supports are screened against the full width of every other corridor, so
// a pier cannot be placed in a crossing road or a merge lane.
export function bridgeSupports(roads, spacing = 26) {
  const supports = [];
  for (const road of roads.filter(r => r.structure)) {
    for (let s = 16; s < road.path.at(-1).s - 12; s += spacing) {
      const p = roadPoint(road, s);
      const top = p.y - road.depth - road.width * Math.abs(road.crossfall || 0) / 2;
      if (top < 1.3) continue;
      if (roads.some(other => other !== road && distanceToRoad(p, other) < other.width / 2 + 2.2)) continue;
      const tangent = samplePath(road.path, s);
      supports.push({ ...p, tx: tangent.tx, tz: tangent.tz, top, width: Math.min(road.width - 0.6, 9), roadId: road.id, station: s });
    }
  }
  return supports;
}
