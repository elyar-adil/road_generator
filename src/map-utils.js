// Pure numerical helpers shared by SD authoring and street growth.
export const hashSeed = (seed, key) => {
  let h = seed >>> 0;
  for (const c of String(key)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h || 1;
};
export function randomFromSeed(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let t = Math.imul(value ^ (value >>> 15), value | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function segmentIntersection(a, b, c, d) {
  const ux = b.x - a.x, uz = b.z - a.z, vx = d.x - c.x, vz = d.z - c.z;
  const cross = ux * vz - uz * vx;
  if (Math.abs(cross) < 1e-7) return null;
  const t = ((c.x - a.x) * vz - (c.z - a.z) * vx) / cross;
  const u = ((c.x - a.x) * uz - (c.z - a.z) * ux) / cross;
  if (t < -1e-6 || t > 1 + 1e-6 || u < -1e-6 || u > 1 + 1e-6) return null;
  return { x: a.x + ux * t, z: a.z + uz * t, t, u };
}

