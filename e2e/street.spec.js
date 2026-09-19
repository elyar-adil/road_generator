import { test, expect } from '@playwright/test';

// Street-level visual captures for realism review. Deterministic seed and
// poses derived from the SD map, so shots are comparable between runs.
test('street-level captures of the generated city', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => localStorage.setItem('intersection-studio.project.v2',
    JSON.stringify({ junctionType: 'city', cityView: 'scene', projectName: '街景', scenerySeed: 42, showGrid: false })));
  await page.goto('/?mode=city');
  await page.locator('[data-city-view=scene]').click();
  await expect(page.locator('[data-city-view=scene]')).toHaveClass(/active/);

  const shot = async (name, poses) => {
    for (const pose of poses) {
      await page.evaluate(p => window.__studio.placeCamera(p.from, p.to), pose);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.waitForTimeout(120);
      await page.locator('canvas').screenshot({ path: `artifacts/realism/${name}.png` });
    }
  };

  const poses = await page.evaluate(() => {
    const sd = window.__studio.state.sdMap;
    const nodes = new Map(sd.nodes.map(n => [n.id, n]));
    const rank = { local: 0, collector: 1, arterial: 2, highway: 3 };
    const edges = sd.edges
      .filter(e => e.layer === 0 && nodes.has(e.from) && nodes.has(e.to))
      .map(e => {
        const a = nodes.get(e.from), b = nodes.get(e.to);
        return { a, b, len: Math.hypot(b.x - a.x, b.z - a.z), class: e.class };
      })
      .sort((a, b) => (rank[b.class] - rank[a.class]) || (b.len - a.len));
    const main = edges[0];
    const dir = { x: (main.b.x - main.a.x) / main.len, z: (main.b.z - main.a.z) / main.len };
    const n = { x: -dir.z, z: dir.x };
    const at = t => ({ x: main.a.x + (main.b.x - main.a.x) * t, z: main.a.z + (main.b.z - main.a.z) * t });
    const p1 = at(0.3), p2 = at(0.3 + 45 / main.len);
    const degree = new Map();
    for (const e of sd.edges) { degree.set(e.from, (degree.get(e.from) || 0) + 1); degree.set(e.to, (degree.get(e.to) || 0) + 1); }
    const hub = [...degree.entries()].sort((a, b) => b[1] - a[1])[0];
    const centre = nodes.get(hub[0]);
    // Building whose facade is closest to a ground road, then stand on that
    // road looking down the street at its base: the storefront/entrance view.
    const city = window.__studio.city();
    const segDistance = (px, pz, a, b) => {
      const dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (pz - a.z) * dz) / len2));
      return { d: Math.hypot(px - a.x - t * dx, pz - a.z - t * dz), x: a.x + t * dx, z: a.z + t * dz };
    };
    const candidates = edges.filter(e => e.class !== 'highway').slice(0, 12);
    let shop = null, shopAt = null, shopEdge = null, shopDist = Infinity;
    for (const b of city.buildings) {
      for (const e of candidates) {
        const s = segDistance(b.x, b.z, e.a, e.b);
        if (s.d < shopDist) { shopDist = s.d; shop = b; shopAt = { x: s.x, z: s.z }; shopEdge = e; }
      }
    }
    if (!shop) { shop = city.buildings[0]; shopAt = p1; shopEdge = main; }
    const shopSpan = Math.max(6, ...shop.ring.map(p => Math.hypot(p.x - shop.x, p.z - shop.z)));
    return {
      lane: [
        { from: { x: p1.x + n.x * 7, y: 1.7, z: p1.z + n.z * 7 }, to: { x: p2.x, y: 1.3, z: p2.z } },
      ],
      sidewalk: [
        { from: { x: p1.x + n.x * 10, y: 1.65, z: p1.z + n.z * 10 }, to: { x: p2.x + n.x * 3, y: 1.4, z: p2.z + n.z * 3 } },
      ],
      junction: [
        { from: { x: centre.x + n.x * 34 + dir.x * -20, y: 1.75, z: centre.z + n.z * 34 + dir.z * -20 },
          to: { x: centre.x, y: 1.2, z: centre.z } },
      ],
      shopfront: (() => {
        const edgeDir = { x: (shopEdge.b.x - shopEdge.a.x) / shopEdge.len, z: (shopEdge.b.z - shopEdge.a.z) / shopEdge.len };
        const tx = -edgeDir.z, tz = edgeDir.x;    // along the street
        const ux = shopAt.x - shop.x, uz = shopAt.z - shop.z, ul = Math.hypot(ux, uz) || 1;
        return [{
          from: { x: shopAt.x + tx * shopSpan * 1.1, y: 1.7, z: shopAt.z + tz * shopSpan * 1.1 },
          to: { x: shop.x + (ux / ul) * shopSpan * 0.3, y: 3.2, z: shop.z + (uz / ul) * shopSpan * 0.3 },
        }];
      })(),
      aerial: [
        { from: { x: centre.x + 260, y: 190, z: centre.z + 330 }, to: { x: centre.x, y: 0, z: centre.z } },
      ],
    };
  });

  await shot('street-main', poses.lane);
  await shot('street-walk', poses.sidewalk);
  await shot('junction', poses.junction);
  await shot('shopfront', poses.shopfront);
  await shot('aerial', poses.aerial);
  expect(errors).toEqual([]);
});
