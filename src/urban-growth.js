// 方格城市路网生成:典型中国城市的骨架是分级的直线街道网,而不是有机生长
// 的蜿蜒路。生成器先规划整条道路(主干路 ~5.5 个街区一条、次干路 ~2.4 个、
// 支路 1 个街区一条,密度高处再加密半级),再按"所有交叉点切分为平面图"
// 的方式落地成 SD 节点/道路。环城路用 16 边形(与方格成 22.5° 的倍数,
// 保证交叉角始终大于 22.5°,不触发小夹角告警),两条 45° 对角线穿过旧城,
// 河流只保留少量桥梁,道路在河岸截断。老城中心支路最密、外围只剩大街区,
// 这正好是中国城市从老城到新区的街区尺度梯度。
import { hashSeed, randomFromSeed, segmentIntersection } from './map-utils.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const RING_SIDES = 16;

export function growUrbanMap(cfg) {
  const random = randomFromSeed(hashSeed(cfg.scenerySeed, 'grid-city-v3'));
  const half = cfg.citySize / 2, scale = half / 900;
  // 永远高于 validateSDMap 的 12m 硬阈值。合并会把端点挪向簇心,阈值越大
  // 方向畸变越大;但太小又会留下十几米的歪斜碎段,实测 16m 是平衡点。
  const MIN_EDGE = Math.max(16, 13 * scale);
  const organic = cfg.cityOrganic ?? 0.8;
  const phase = random() * Math.PI * 2;
  const rotation = -0.34 + random() * 0.66;
  const riverWidth = (46 + random() * 20) * scale;
  const riverX = z => half * (0.12 * Math.sin(z / half * 2.6 + phase) + 0.05 * Math.sin(z / half * 6.5 + phase * 0.5));
  const centres = [
    { x: riverX(-half * 0.25) - half * 0.4, z: -half * 0.25, radius: half * 0.4, weight: 1.05, angle: 0.12 + random() * 0.25, style: 'historic' },
    { x: riverX(half * 0.22) + half * 0.38, z: half * 0.22, radius: half * 0.45, weight: 0.95, angle: -0.3 + random() * 0.3, style: 'urban' },
    { x: -half * 0.56, z: half * 0.52, radius: half * 0.32, weight: 0.6, angle: -0.3, style: 'suburban' },
  ];
  const parks = [{ x: -half * 0.72, z: -half * 0.68, rx: half * 0.13, rz: half * 0.13, kind: 'hill' },
    { x: half * 0.64, z: -half * 0.42, rx: half * 0.15, rz: half * 0.12, kind: 'park' }];
  const inPark = p => parks.some(k => ((p.x - k.x) / k.rx) ** 2 + ((p.z - k.z) / k.rz) ** 2 < 1);
  const density = p => Math.min(1, centres.reduce((t, c) => t + c.weight * Math.exp(-((p.x - c.x) ** 2 + (p.z - c.z) ** 2) / (c.radius ** 2)), 0));
  const oldTown = centres[0];

  // ---- 环城路:16 边形,作为建成区边界,方格道路止于其上 ----
  const ringR = half * 0.8;
  const polyRadius = a => {
    const step = Math.PI * 2 / RING_SIDES;
    const folded = ((a % step) + step) % step - step / 2;
    return ringR * Math.cos(step / 2) / Math.cos(folded);
  };
  const insideCity = p => Math.hypot(p.x, p.z) <= polyRadius(Math.atan2(p.z, p.x)) - 2;

  // ---- 规划直线道路,记录每条的切点参数 ----
  const lines = [];
  const addLine = (a, b, cls, extra = {}) => lines.push({ a, b, cls, cuts: [0, 1], ...extra });
  // 一条支路是否保留:按沿线采样中"人口密度高于阈值"的比例决定。
  const keepLine = (a, b, threshold, minFraction) => {
    let good = 0, total = 0;
    for (let i = 0; i <= 8; i++) {
      const p = { x: a.x + (b.x - a.x) * i / 8, z: a.z + (b.z - a.z) * i / 8 };
      if (!insideCity(p) || inPark(p)) continue;
      total++;
      if (density(p) > threshold) good++;
    }
    return total > 0 && good / total >= minFraction;
  };
  const span = cfg.citySize * 1.7;
  // 同级或低级道路不能与已保留的更高等级道路挨得太近:近距平行路在真实
  // 城市里不存在,还会让下游派生出两条重叠走廊。
  const reserved = { ns: [], ew: [] };
  // 间距必须大于节点邻域合并半径:否则两条平行路的节点会被并到一起,
  // 路口就会出现两条几乎同向的道路。
  const reserve = (vertical, offset, gap) => {
    const list = reserved[vertical ? 'ns' : 'ew'];
    const clearance = Math.max(gap * 0.3, MIN_EDGE * 1.5);
    if (list.some(o => Math.abs(o - offset) < clearance)) return false;
    list.push(offset);
    return true;
  };
  function fillFamily(vertical, gap, phaseOffset, cls, threshold, minFraction) {
    const count = Math.ceil(span / gap);
    const jitter = gap * 0.1 * (0.35 + organic);
    for (let i = -count; i <= count; i++) {
      const offset = (i + phaseOffset) * gap + (random() - 0.5) * jitter;
      const a = vertical ? { x: offset, z: -span / 2 } : { x: -span / 2, z: offset };
      const b = vertical ? { x: offset, z: span / 2 } : { x: span / 2, z: offset };
      if (threshold > 0 && !keepLine(a, b, threshold, minFraction)) continue;
      if (!reserve(vertical, offset, gap)) continue;
      addLine(a, b, cls, { family: vertical ? 'ns' : 'ew' });
    }
  }
  const local = Math.max(80, Math.min(190, cfg.cityBlockSize));
  const collectorGap = local * 2.4, arterialGap = local * 5.5;
  fillFamily(false, arterialGap, 0, 'arterial', 0, 0);
  fillFamily(true, arterialGap, 0, 'arterial', 0, 0);
  fillFamily(false, collectorGap, 0, 'collector', 0.2 + 0.08 * organic, 0.3);
  fillFamily(true, collectorGap, 0, 'collector', 0.2 + 0.08 * organic, 0.3);
  fillFamily(false, local, 0, 'local', 0.4, 0.28);
  fillFamily(true, local, 0, 'local', 0.4, 0.28);
  // 老城加密:密度最高的街区再插一层半间距支路。
  fillFamily(false, local / 2, 0.5, 'local', 0.82, 0.45);
  fillFamily(true, local / 2, 0.5, 'local', 0.82, 0.45);
  // 穿过旧城的两条 45° 对角街。
  for (const sign of [-1, 1]) {
    const dx = Math.cos(sign * Math.PI / 4), dz = Math.sin(sign * Math.PI / 4);
    addLine({ x: oldTown.x - dx * span / 2, z: oldTown.z - dz * span / 2 },
      { x: oldTown.x + dx * span / 2, z: oldTown.z + dz * span / 2 }, 'arterial', { family: 'diagonal' });
  }
  // 环城路:16 边形,作为建成区边界,方格道路止于其上。
  for (let i = 0; i < RING_SIDES; i++) {
    const a0 = i / RING_SIDES * Math.PI * 2, a1 = (i + 1) / RING_SIDES * Math.PI * 2;
    addLine({ x: Math.cos(a0) * polyRadius(a0), z: Math.sin(a0) * polyRadius(a0) },
      { x: Math.cos(a1) * polyRadius(a1), z: Math.sin(a1) * polyRadius(a1) }, 'arterial', { family: 'ring' });
  }

  // ---- 河流:道路在两岸截断,只有干路架桥 ----
  // 河道两侧留出滨河绿带:桥面因此有足够的长度摊开纵坡(引道坡度过陡会
  // 触发 6% 上限告警),方格路在绿带边缘截断。
  const waterBand = riverWidth / 2 + 100 * scale;
  const waterIntervals = (a, b) => {
    const steps = Math.max(8, Math.ceil(dist(a, b) / (5 * scale)));
    const spans = [];
    let cur = null;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      if (Math.abs(x - riverX(z)) - waterBand < 0) { if (!cur) cur = [t, t]; else cur[1] = t; }
      else if (cur) { spans.push(cur); cur = null; }
    }
    if (cur) spans.push(cur);
    return spans;
  };
  for (const L of lines) {
    L.waterSpans = waterIntervals(L.a, L.b);
    for (const [t0, t1] of L.waterSpans) L.cuts.push(t0, t1);
  }
  // 河宽范围内没有别的道路,桥线不在这里切分:否则桥会被切成短段,每段
  // 都要在几米内爬完全部桥高,纵坡直接爆表。
  const inWaterSpan = (L, t) => (L.waterSpans ?? []).some(([a, b]) => t > a + 1e-6 && t < b - 1e-6);
  // 桥位:跨河的东西向干路里,挑三座位于建成区内的桥;干路不足时用次干路
  // 补位,保证河道两侧的方格网有足够连接。
  const bridgeCandidates = cls => lines.filter(L => {
    if (L.family !== 'ew' || L.cls !== cls) return false;
    const spans = L.waterSpans ?? [];
    return spans.some(([t0, t1]) => {
      const t = (t0 + t1) / 2;
      return insideCity({ x: L.a.x + (L.b.x - L.a.x) * t, z: L.a.z + (L.b.z - L.a.z) * t });
    });
  }).sort((p, q) => (p.a.z + p.b.z) - (q.a.z + q.b.z));
  const bridgeLines = [...bridgeCandidates('arterial')];
  for (const extra of bridgeCandidates('collector')) {
    if (bridgeLines.length >= 3) break;
    if (bridgeLines.every(L => Math.abs(L.a.z - extra.a.z) > cfg.cityBlockSize * 2)) bridgeLines.push(extra);
  }
  const chosen = bridgeLines.length <= 3 ? bridgeLines
    : [bridgeLines[0], bridgeLines[Math.floor(bridgeLines.length / 2)], bridgeLines[bridgeLines.length - 1]];
  for (const L of chosen) {
    L.bridge = true;
    // 绿带可能被同一条线进出多次(河曲贴着带边),只把跨主河道的那一段
    // 当桥;其它入带段直接截断,否则它们要在几十米内爬完全部桥高。
    L.bridgeSpan = L.waterSpans.reduce((best, span) => (span[1] - span[0] > best[1] - best[0] ? span : best), L.waterSpans[0]);
  }

  // ---- 平面图:所有交点把道路切成边 ----
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const A = lines[i], B = lines[j];
    const hit = segmentIntersection(A.a, A.b, B.a, B.b);
    if (!hit) continue;
    if (hit.t > 0.002 && hit.t < 0.998 && !inWaterSpan(A, hit.t)) A.cuts.push(hit.t);
    if (hit.u > 0.002 && hit.u < 0.998 && !inWaterSpan(B, hit.u)) B.cuts.push(hit.u);
  }
  const nodes = [], edges = [];
  let nodeIndex = 0, edgeIndex = 0, pairs = new Set();
  // 按 MIN_EDGE 半径做邻域合并:环城路顶点与方格路口的交点只差几米时,
  // 两条路必须落在同一个节点上,否则会留下碎边、并在下游拆点时被切开。
  const cell = MIN_EDGE, buckets = new Map(), weights = new Map();
  const nodeAt = (x, z) => {
    const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++)
      for (const n of buckets.get(`${cx + dx},${cz + dz}`) ?? [])
        if (Math.hypot(n.x - x, n.z - z) < MIN_EDGE) {
          // 并到簇心而不是其中一个切点:否则被并的街道整条被拉向另一侧,
          // 在路口拧出 20° 以下的小夹角。
          const count = weights.get(n.id) ?? 1;
          n.x = (n.x * count + x) / (count + 1);
          n.z = (n.z * count + z) / (count + 1);
          weights.set(n.id, count + 1);
          return n;
        }
    const n = { id: `n${++nodeIndex}`, x, z, y: 0 };
    weights.set(n.id, 1);
    const key = `${cx},${cz}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(n);
    nodes.push(n);
    return n;
  };
  // 河宽范围已经用 waterSpans 精确切分,这里只按中点判定:靠近绿带边缘的
  // 普通路段若被误判成桥,会在几十米内爬完全部桥高,纵坡直接爆表。
  const pieceInWater = (p0, p1) => {
    const mx = (p0.x + p1.x) / 2, mz = (p0.z + p1.z) / 2;
    return Math.abs(mx - riverX(mz)) < waterBand;
  };
  const LANES = { arterial: 3, collector: 2, local: 1 };
  const edgeKey = (from, to, layer) => `${[from, to].sort().join('>')}/${layer}`;
  const pushEdge = (from, to, cls, layer, extra = {}) => {
    if (from === to || pairs.has(edgeKey(from.id, to.id, layer))) return;
    pairs.add(edgeKey(from.id, to.id, layer));
    const lanes = LANES[cls];
    edges.push({ id: `r${++edgeIndex}`, from: from.id, to: to.id, class: cls, layer,
      lanesForward: lanes, lanesBackward: lanes, ...extra });
  };
  for (const L of lines) {
    const len = dist(L.a, L.b);
    const cuts = L.cuts.filter(t => t >= -1e-6 && t <= 1 + 1e-6).sort((a, b) => a - b);
    const merged = [];
    for (const t of cuts) if (!merged.length || (t - merged.at(-1)) * len >= MIN_EDGE) merged.push(t);
    for (let i = 0; i + 1 < merged.length; i++) {
      const t0 = merged[i], t1 = merged[i + 1];
      if ((t1 - t0) * len < MIN_EDGE) continue;
      const p0 = { x: L.a.x + (L.b.x - L.a.x) * t0, z: L.a.z + (L.b.z - L.a.z) * t0 };
      const p1 = { x: L.a.x + (L.b.x - L.a.x) * t1, z: L.a.z + (L.b.z - L.a.z) * t1 };
      const mid = { x: (p0.x + p1.x) / 2, z: (p0.z + p1.z) / 2 };
      if (!insideCity(mid) || inPark(mid)) continue;
      // 用参数区间判定而不是几何采样:切点就是按 span 边界生成的,两者一致。
      const tm = (t0 + t1) / 2;
      const span = (L.waterSpans ?? []).find(([a, b]) => tm > a && tm < b);
      if (span && !L.bridge) continue;
      if (span && L.bridge && span !== L.bridgeSpan) continue;
      const inWater = !!span;
      const n0 = nodeAt(p0.x, p0.z), n1 = nodeAt(p1.x, p1.z);
      pushEdge(n0, n1, L.cls, inWater ? 1 : 0,
        inWater ? { crossing: 'water', bridgeHeight: 2.6 * scale } : {});
    }
  }
  // 修复循环:邻域合并会把端点挪动几米,可能让两条边重新交叉。显式拆开
  // 交叉、收缩短边,迭代到平面图稳定;否则碎边会留给下游拆点,产生"道路
  // 过短 (12m)"错误。
  for (let pass = 0; pass < 8; pass++) {
    const byId = new Map(nodes.map(n => [n.id, n]));
    const cuts = new Map();
    let found = 0;
    for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
      const A = edges[i], B = edges[j];
      if (A.from === B.from || A.from === B.to || A.to === B.from || A.to === B.to) continue;
      const hit = segmentIntersection(byId.get(A.from), byId.get(A.to), byId.get(B.from), byId.get(B.to));
      if (!hit) continue;
      found++;
      if (hit.t > 1e-6 && hit.t < 1 - 1e-6) (cuts.get(A.id) ?? cuts.set(A.id, []).get(A.id)).push(hit);
      if (hit.u > 1e-6 && hit.u < 1 - 1e-6) (cuts.get(B.id) ?? cuts.set(B.id, []).get(B.id)).push(hit);
    }
    const snapshot = edges.map(e => ({ ...e }));
    let mergedAny = false;
    if (found) {
      edges.length = 0; pairs = new Set();
      for (const e of snapshot) {
        const list = cuts.get(e.id);
        const a = byId.get(e.from), b = byId.get(e.to);
        const extra = e.crossing ? { crossing: e.crossing, bridgeHeight: e.bridgeHeight } : {};
        if (!list) { pushEdge(a, b, e.class, e.layer, extra); continue; }
        list.sort((p, q) => p.t - q.t);
        let prev = a;
        for (const c of list) {
          const n = nodeAt(c.x, c.z);
          if (n !== prev) pushEdge(prev, n, e.class, e.layer, extra);
          prev = n;
        }
        if (prev !== b) pushEdge(prev, b, e.class, e.layer, extra);
      }
    }
    // 收缩:仍然过短的边把两端并成一个节点。
    const parent = new Map(nodes.map(n => [n.id, n.id]));
    const find = id => {
      let root = id;
      while (parent.get(root) !== root) root = parent.get(root);
      while (parent.get(id) !== root) { const next = parent.get(id); parent.set(id, root); id = next; }
      return root;
    };
    const pos = new Map(nodes.map(n => [n.id, n]));
    for (const e of edges) {
      const ra = find(e.from), rb = find(e.to);
      if (ra === rb) continue;
      const na = pos.get(ra), nb = pos.get(rb);
      if (dist(na, nb) >= MIN_EDGE) continue;
      // 收缩到两节点的加权中心,并保留权重继续参与后续平均:直接吸附到
      // 某一端会让经过这里的整条街扭向一侧,路口出现 20° 以下的小夹角。
      const ca = weights.get(ra) ?? 1, cb = weights.get(rb) ?? 1;
      na.x = (na.x * ca + nb.x * cb) / (ca + cb);
      na.z = (na.z * ca + nb.z * cb) / (ca + cb);
      weights.set(ra, ca + cb);
      parent.set(rb, ra);
      mergedAny = true;
    }
    if (mergedAny) {
      const keptEdges = [], seen = new Set();
      for (const e of edges) {
        const from = find(e.from), to = find(e.to);
        if (from === to) continue;
        const key = edgeKey(from, to, e.layer);
        if (seen.has(key)) continue;
        seen.add(key);
        keptEdges.push({ ...e, from, to });
      }
      edges.length = 0; edges.push(...keptEdges);
      pairs = new Set(edges.map(e => edgeKey(e.from, e.to, e.layer)));
      const roots = nodes.filter(n => find(n.id) === n.id);
      nodes.length = 0; nodes.push(...roots);
      // 邻域索引必须同步重建,否则 nodeAt 可能返回已被并掉的节点。
      buckets.clear();
      for (const n of roots) {
        const key = `${Math.floor(n.x / cell)},${Math.floor(n.z / cell)}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(n);
      }
    }
    if (!found && !mergedAny) break;
  }
  const used = new Set(edges.flatMap(e => [e.from, e.to]));
  let kept = nodes.filter(n => used.has(n.id));
  // 被公园或河岸切断后可能留下孤立的短走廊:只保留最大的连通分量。
  const adjacency = new Map(kept.map(n => [n.id, []]));
  for (const e of edges) { adjacency.get(e.from).push(e.to); adjacency.get(e.to).push(e.from); }
  const seen = new Set();
  let best = null;
  for (const n of kept) {
    if (seen.has(n.id)) continue;
    const queue = [n.id]; seen.add(n.id);
    for (let i = 0; i < queue.length; i++) for (const next of adjacency.get(queue[i])) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    if (!best || queue.length > best.length) best = queue;
  }
  if (best && best.length < kept.length) {
    const main = new Set(best);
    const survivors = edges.filter(e => main.has(e.from) && main.has(e.to));
    edges.length = 0; edges.push(...survivors);
    kept = kept.filter(n => main.has(n.id));
  }

  const rotate = p => ({ x: p.x * Math.cos(rotation) - p.z * Math.sin(rotation), z: p.x * Math.sin(rotation) + p.z * Math.cos(rotation) });
  kept.forEach(n => Object.assign(n, rotate(n)));
  const river = Array.from({ length: 81 }, (_, i) => { const z = -half * 1.5 + i / 80 * half * 3; return rotate({ x: riverX(z), z }); });
  return { version: 1, seed: cfg.scenerySeed, nodes: kept, edges,
    geography: { river: { points: river, width: riverWidth }, centres: centres.map(c => ({ ...c, ...rotate(c), angle: c.angle + rotation })),
      parks: parks.map(p => ({ ...p, ...rotate(p), angle: rotation })), generator: 'grid-city-v3' } };
}
