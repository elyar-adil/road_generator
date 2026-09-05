import { cubicPoints, linePoints, makeRoad, roadPoint, smoothstep, stationPath, maxGrade, bridgeSupports } from './corridor.js';
import { segmentIntersection } from './sd-map.js';
import { laneMovementSets } from './road-movements.js';

export function crossSection(edge, laneWidth) {
  const median = edge.lanesForward && edge.lanesBackward ? (edge.class === 'highway' ? 2 : 0.5) : 0;
  const shoulder = edge.class === 'highway' ? 1.5 : 0.45;
  const left = -edge.lanesBackward * laneWidth - median / 2 - shoulder;
  const right = edge.lanesForward * laneWidth + median / 2 + shoulder;
  return { median, shoulder, left, right, width: right - left, centreOffset: (right + left) / 2 };
}

export function deriveHDMap(sd, cfg) {
  const nodes = new Map(sd.nodes.map(n => [n.id, n]));
  const incidence = new Map(sd.nodes.map(n => [n.id, []]));
  const sections = new Map(sd.edges.map(e => [e.id, crossSection(e, cfg.laneWidth)]));
  sd.edges.forEach(e => { incidence.get(e.from).push(e); incidence.get(e.to).push(e); });
  const radii = new Map(sd.nodes.map(n => {
    const list = incidence.get(n.id);
    let radius = list.length > 1 ? Math.max(...list.map(e => sections.get(e.id).width)) * 0.8 + 4 : 0;
    const lengths = list.map(e => { const other = nodes.get(e.from === n.id ? e.to : e.from); return Math.hypot(n.x - other.x, n.z - other.z); });
    radius = Math.min(radius, Math.min(...lengths) * 0.3);
    return [n.id, radius];
  }));
  const roads = [], lanes = [], connectors = [], junctions = [], facilities = [], warnings = [];
  for (const edge of sd.edges) {
    const a = nodes.get(edge.from), b = nodes.get(edge.to), section = sections.get(edge.id);
    const length = Math.hypot(b.x - a.x, b.z - a.z), tx = (b.x - a.x) / length, tz = (b.z - a.z) / length;
    const trimStart = radii.get(a.id), trimEnd = radii.get(b.id);
    const structureHeight = edge.bridgeHeight ?? cfg.bridgeHeight;
    let riseEnd = length * 0.4, fallStart = length * 0.6;
    if (edge.layer) {
      const crossings = sd.edges.filter(other => other.id !== edge.id && other.layer !== edge.layer)
        .map(other => {
          const hit = segmentIntersection(a, b, nodes.get(other.from), nodes.get(other.to));
          return hit && hit.t > 0.01 && hit.t < 0.99 ? { station: hit.t * length, width: sections.get(other.id).width } : null;
        }).filter(Boolean);
      if (crossings.length) {
        riseEnd = Math.min(...crossings.map(c => c.station - c.width / 2 - 10));
        fallStart = Math.max(...crossings.map(c => c.station + c.width / 2 + 10));
      }
    }
    const baseAt = t => 0.32 + a.y + (b.y - a.y) * t;
    const profile = s => {
      if (!edge.layer) return baseAt(s / length);
      const rise = smoothstep((s - trimStart - 10) / Math.max(1, riseEnd - trimStart - 10));
      const fall = smoothstep((length - trimEnd - 10 - s) / Math.max(1, length - trimEnd - 10 - fallStart));
      return baseAt(s / length) + edge.layer * structureHeight * Math.min(rise, fall);
    };
    const points = linePoints({ x: a.x - tz * section.centreOffset, z: a.z + tx * section.centreOffset },
      { x: b.x - tz * section.centreOffset, z: b.z + tx * section.centreOffset }, (_, __, t) => profile(t * length));
    const road = makeRoad(edge.id, points, { kind: edge.class, ...section, laneWidth: cfg.laneWidth,
      lanes: edge.lanesForward + edge.lanesBackward, lanesForward: edge.lanesForward, lanesBackward: edge.lanesBackward,
      from: a.id, to: b.id, layer: edge.layer, structure: edge.layer > 0, depth: edge.layer > 0 ? 1.25 : 0.25,
      trimStart, trimEnd,
      crossingStart: incidence.get(a.id).length > 2, crossingEnd: incidence.get(b.id).length > 2,
      markingStart: trimStart + (incidence.get(a.id).length > 2 ? 7 : 0.5),
      markingEnd: trimEnd + (incidence.get(b.id).length > 2 ? 7 : 0.5),
    });
    roads.push(road);
    const grade = maxGrade(road.path);
    if (grade > 0.065) warnings.push(`道路 ${edge.id} 最大纵坡 ${(grade * 100).toFixed(1)}%，请延长引道或降低层高`);
    if (edge.layer) facilities.push({ id: `structure-${edge.id}`, type: edge.layer > 0 ? 'bridge' : 'tunnel',
      edgeId: edge.id, riseEnd, fallStart, height: structureHeight, maxGrade: grade, crossing: edge.crossing || 'road' });
    for (const direction of [1, -1]) {
      const count = direction === 1 ? edge.lanesForward : edge.lanesBackward;
      for (let i = 0; i < count; i++) {
        const offset = direction * (section.median / 2 + (i + 0.5) * cfg.laneWidth) - section.centreOffset;
        const stations = [trimStart, ...road.path.filter(p => p.s > trimStart && p.s < length - trimEnd).map(p => p.s), length - trimEnd];
        let path = stations.map(s => roadPoint(road, s, offset));
        if (direction === -1) path = path.reverse();
        lanes.push({ id: `${edge.id}/${direction === 1 ? 'f' : 'b'}/${i}`, edgeId: edge.id, index: i, direction,
          width: cfg.laneWidth, from: direction === 1 ? edge.from : edge.to, to: direction === 1 ? edge.to : edge.from,
          path: stationPath(path), successors: [], predecessors: [] });
      }
    }
  }
  const roadById = new Map(roads.map(r => [r.id, r]));
  const tangent = (path, end) => {
    const a = end ? path.at(-2) : path[0], b = end ? path.at(-1) : path[1];
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
  };
  for (const node of sd.nodes) {
    const incident = incidence.get(node.id);
    if (incident.length < 2) continue;
    const incoming = lanes.filter(l => l.to === node.id), outgoing = lanes.filter(l => l.from === node.id);
    for (const lane of incoming) {
      const dir = tangent(lane.path, true);
      const targets = outgoing.filter(l => l.edgeId !== lane.edgeId).map(target => {
        const out = tangent(target.path, false);
        const turn = Math.atan2(dir.x * out.z - dir.z * out.x, dir.x * out.x + dir.z * out.z);
        return { target, out, type: Math.abs(turn) < Math.PI / 4 ? 'straight' : turn > 0 ? 'right' : 'left', turn };
      }).filter(t => Math.abs(t.turn) < Math.PI * 0.88);
      const available = new Set(targets.map(t => t.type));
      const count = incoming.filter(l => l.edgeId === lane.edgeId).length;
      const allowed = laneMovementSets(count, available)[lane.index];
      for (const edgeId of new Set(targets.map(t => t.target.edgeId))) {
        const choices = targets.filter(t => t.target.edgeId === edgeId).sort((a, b) => a.target.index - b.target.index);
        const type = choices[0].type;
        if (!allowed.has(type)) continue;
        const targetIndex = type === 'right' ? Math.max(0, choices.length - (count - lane.index)) : Math.min(lane.index, choices.length - 1);
        const { target, out } = choices[targetIndex];
        const a = lane.path.at(-1), b = target.path[0];
        const handle = Math.hypot(b.x - a.x, b.z - a.z) * (type === 'straight' ? 0.33 : 0.55);
        const path = cubicPoints(a, { x: a.x + dir.x * handle, z: a.z + dir.z * handle },
          { x: b.x - out.x * handle, z: b.z - out.z * handle }, b, 20)
          .map((p, i) => ({ ...p, y: a.y + (b.y - a.y) * smoothstep(i / 20) }));
        const id = `${lane.id}>${target.id}`;
        const ramp = (roadById.get(lane.edgeId).kind === 'highway') !== (roadById.get(target.edgeId).kind === 'highway');
        connectors.push({ id, nodeId: node.id, fromLane: lane.id, toLane: target.id, movement: type,
          facility: ramp ? 'ramp-terminal' : 'junction', path: stationPath(path), width: cfg.laneWidth });
        lane.successors.push(target.id); target.predecessors.push(lane.id);
      }
    }
    const ports = incident.map(edge => {
      const road = roadById.get(edge.id), atStart = road.from === node.id;
      const station = atStart ? road.trimStart : road.path.at(-1).s - road.trimEnd;
      const p = roadPoint(road, station), raw = atStart ? road.path[1] : road.path.at(-2), anchor = atStart ? road.path[0] : road.path.at(-1);
      const norm = Math.hypot(raw.x - anchor.x, raw.z - anchor.z) || 1;
      const dir = { x: (raw.x - anchor.x) / norm, z: (raw.z - anchor.z) / norm };
      const left = roadPoint(road, station, (atStart ? -1 : 1) * road.width / 2);
      const right = roadPoint(road, station, (atStart ? 1 : -1) * road.width / 2);
      return { left, right, dir, angle: Math.atan2(p.z - node.z, p.x - node.x) };
    }).sort((a, b) => a.angle - b.angle);
    const ring = [];
    ports.forEach((port, i) => {
      ring.push(port.left, port.right);
      const next = ports[(i + 1) % ports.length];
      const h = Math.hypot(port.right.x - next.left.x, port.right.z - next.left.z) * 0.45;
      ring.push(...cubicPoints(port.right, { x: port.right.x - port.dir.x * h, z: port.right.z - port.dir.z * h },
        { x: next.left.x - next.dir.x * h, z: next.left.z - next.dir.z * h }, next.left, 8).slice(1, -1)
        .map(p => ({ ...p, y: 0.32 + node.y })));
    });
    junctions.push({ id: node.id, ring, radius: radii.get(node.id), y: node.y + 0.32 });
    if (incident.length > 2) facilities.push({ id: `junction-${node.id}`, type: 'junction', nodeId: node.id, approaches: incident.length });
  }
  return { roads, lanes, connectors, junctions, facilities, warnings: [...new Set(warnings)],
    supports: bridgeSupports(roads, 28), maxGrade: Math.max(0, ...roads.map(r => maxGrade(r.path))) };
}
