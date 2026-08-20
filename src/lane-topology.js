// Lane-level topology graph.
//
// The intersection is described as an explicit network of lane endpoints and the
// lane-to-lane connections across the junction. This graph is a single source of
// truth that drives (a) the topology centerline viewer, (b) diverge/merge
// reasoning, and — later — interchange/overpass composition. It deliberately
// depends only on pure geometry, not on THREE or any global state, so it stays
// testable and reusable.

import { classifyMovement, armLaneMovementSets } from './road-movements.js';
import { add, scl, sub, len, appendCubic2, pointInRing } from './geometry.js';

// Which inbound lane index carries each movement type (median-side inside).
// `lanes` is the per-lane Set<movement> from laneMovementSets.
// Returns a Map movement -> [inbound lane indices] (inbound order = input order,
// so index 0 is the median/left side, last is the outer/right side).
export function laneIndicesByMovement(movementSets) {
  const byMovement = new Map();
  movementSets.forEach((set, index) => {
    set.forEach((movement) => {
      if (!byMovement.has(movement)) byMovement.set(movement, []);
      byMovement.get(movement).push(index);
    });
  });
  return byMovement;
}

// Map an inbound lane from one arm to a receiving outbound lane on the target
// arm for a given movement. Straight and left preserve order (left-most inbound
// to left-most outbound); right turns fold outer-to-outer so the outermost
// right lane meets the outermost receiving lane.
export function inboundToOutboundLane(fromIndex, laneIn, laneOut, movement) {
  if (laneOut <= 0) return -1;
  if (movement === 'right') {
    const a = laneIn - 1 - fromIndex;       // 0 = outermost approach lane
    const t = laneOut - 1 - a;              // 0 = outermost receiving lane
    return Math.max(0, Math.min(laneOut - 1, t));
  }
  return Math.min(fromIndex, laneOut - 1);
}

// Cubic connector between two lane centres (source approaching, target leaving).
// This generic turn curve is the same primitive used by right-turn generation
// and later interchange ramps, scaled by chord length.
export function connectLanePath(fromG, fromS, toG, toS, { station = 0.5 } = {}) {
  const fromP = fromG.wp(fromG.R + station, fromS);
  const toP = toG.wp(toG.R + station, toS);
  const fromDir = scl(fromG.fwd, -1);
  const toDir = toG.fwd;
  const dist = len(sub(toP, fromP)) || 1;
  const handle = Math.max(3, Math.min(dist * 0.35, 16));
  const c1 = add(fromP, scl(fromDir, handle));
  const c2 = add(toP, scl(toDir, -handle));
  const path = [fromP];
  const segments = 24;
  const fromHandle = scl(fromDir, handle);
  const toHandle = scl(toDir, -handle);
  const p1 = fromP, p2 = add(fromP, fromHandle);
  const p3 = add(toP, toHandle), p4 = toP;
  for (let i = 1; i <= segments; i += 1) appendCubic2(path, p1, p2, p3, p4, 0);
  // appendCubic2 with segments=0 adds nothing; recompute directly instead.
  path.length = 1;
  for (let i = 1; i <= segments; i += 1) {
    const t = i / segments;
    const mt = 1 - t;
    path.push({
      x: mt * mt * mt * p1.x + 3 * mt * mt * t * p2.x + 3 * mt * t * t * p3.x + t * t * t * p4.x,
      y: mt * mt * mt * p1.y + 3 * mt * mt * t * p2.y + 3 * mt * t * t * p3.y + t * t * t * p4.y,
    });
  }
  return path;
}

// Movement targets for every arm: the arm reached by each movement type.
export function armMovementTargets(geoms) {
  return geoms.map((g, i) => {
    const targets = { left: null, straight: null, right: null };
    for (let j = 0; j < geoms.length; j += 1) {
      if (j === i || geoms[j].arm.laneOut <= 0) continue;
      const movement = classifyMovement(g, geoms[j]);
      if (movement.type === 'left' && !targets.left) targets.left = geoms[j];
      else if (movement.type === 'straight' && !targets.straight) targets.straight = geoms[j];
      else if (movement.type === 'right' && !targets.right) targets.right = geoms[j];
    }
    return targets;
  });
}

// Compute the full lane graph for an intersection.
//
//   geoms:       array of arm geometry descriptors (from computeArmGeom), each
//                with { arm, fwd, left, laneW, medW, R, wp, inOuterS, outOuterS }.
//   opts:        { armLength, facilities } - armLength is the longitudinal extent
//                for lane centreline polylines; facilities is an array aligned
//                with geoms (or nulls) describing channelized right-turn
//                branches ({ type, laneCount, data }) so dedicated lane branches
//                get their own curved centreline instead of a line through the
//                guide triangle.
//
// Returns:
//   arms:            the input geoms (tagged with armIndex)
//   lanes:           distinct lane endpoints (id, armIndex, side, index, point)
//   laneCenterlines: per-lane centreline polylines running along the full arm;
//                    `skip` marks dedicated right-turn branches whose centreline
//                    is drawn as the curved branch itself
//   connections:     array of { fromId, toId, fromArm, toArm, fromIndex, toIndex,
//                               movement, turn, path }
export function computeLaneTopology(geoms, { armLength = 46, facilities = [] } = {}) {
  const targets = armMovementTargets(geoms);
  const connections = [];
  const laneIds = new Map(); // armIndex|side|index -> lane id

  geoms.forEach((fromG, i) => {
    const arm = fromG.arm;
    const { laneIn, laneOut } = arm;
    if (laneIn <= 0) return;
    const has = new Set();
    ['left', 'straight', 'right'].forEach((m) => { if (targets[i][m]) has.add(m); });
    const avail = new Set(has);
    const leftTarget = targets[i].left, rightTarget = targets[i].right;
    const movementSets = armLaneMovementSets(arm, avail, leftTarget, rightTarget);
    const byMovement = laneIndicesByMovement(movementSets);

    const inboundCentre = (index) => -(fromG.medW / 2 + (index + 0.5) * fromG.laneW);

    ['left', 'straight', 'right'].forEach((movement) => {
      const targetG = targets[i][movement];
      if (!targetG || !byMovement.has(movement)) return;
      const toIndex = geoms.indexOf(targetG);
      byMovement.get(movement).forEach((fromIndex) => {
        const fromId = `${i}|in|${fromIndex}`;
        laneIds.set(`${i}|in|${fromIndex}`, fromId);
        const toLane = inboundToOutboundLane(fromIndex, laneIn, targetG.arm.laneOut, movement);
        if (toLane < 0) return;
        const toId = `${toIndex}|out|${toLane}`;
        laneIds.set(`${toIndex}|out|${toLane}`, toId);
        const path = connectLanePath(
          fromG, inboundCentre(fromIndex), targetG, targetG.medW / 2 + (toLane + 0.5) * targetG.laneW,
        );
        const turn = classifyMovement(fromG, targetG).turn;
        connections.push({
          fromId, toId,
          fromArm: i, toArm: toIndex,
          fromIndex, toIndex: toLane,
          movement, turn, path,
        });
      });
    });

    // Dedicated right-turn branch lanes (split/slip) are handled in the
    // centreline pass below: their centreline is a single contiguous polyline
    // from the arm root through the curved branch to the merge, so it never
    // floats mid-air nor crosses the guide triangle.
  });

  // Collect all distinct lane endpoints with their lateral station and point.
  const lanes = [];
  const laneByKey = new Map();
  geoms.forEach((g, i) => {
    const arm = g.arm;
    const addSide = (side, count, centre) => {
      for (let index = 0; index < count; index += 1) {
        const key = `${i}|${side}|${index}`;
        const id = laneIds.get(key) || `${i}|${side}|${index}`;
        const s = centre(index);
        lanes.push({
          id, armIndex: i, side, index, s,
          point: g.wp(g.R + 0.5, s),
        });
        laneByKey.set(key, id);
      }
    };
    addSide('in', arm.laneIn, (index) => -(g.medW / 2 + (index + 0.5) * g.laneW));
    addSide('out', arm.laneOut, (index) => g.medW / 2 + (index + 0.5) * g.laneW);
  });

  // Guide-aware lane centreline polylines. Every travel lane that is a
// continuous, un-interrupted carriageway gets a straight centreline along the
// full arm. Lanes involved in a diverge/merge derive their centreline from the
// real branch geometry instead, so no centreline ever crosses a guide triangle:
//   - a dedicated right-turn branch lane is one contiguous polyline from the arm
//     root, through the curved branch, to the merge;
//   - the receiving outbound lane on the merge target is truncated to start
//     downstream of the merge nose (the merge triangle sits before it).
  const laneCenterlines = [];
  const nearU = (g) => g.R + 0.5;
  const longitudinalStep = (g) => Math.max(1, (armLength - nearU(g)) / (armLength <= 60 ? 16 : 28));
  const refreshEnd = (g, s, uEnd) => {
    const last = g.wp(uEnd, s);
    return last;
  };
  const armPath = (g, s, uStart = nearU(g)) => {
    const step = longitudinalStep(g);
    const path = [];
    for (let u = uStart; u <= armLength + 1e-6; u += step) path.push(g.wp(Math.min(u, armLength), s));
    path[path.length - 1] = refreshEnd(g, s, armLength);
    return path;
  };

  // Which outbound lanes on which arm are merge receivers, and the longitudinal
  // station (in the target frame) where the branch re-enters, so their centreline
  // starts downstream of the merge triangle.
  const mergeReceivers = new Map(); // `${targetIndex}|out|${outLane}` -> mergeU
  (facilities || []).forEach((facility, srcIdx) => {
    if (!facility || facility.type === 'direct' || !facility.data?.lanePaths) return;
    const targetG = facility.target;
    if (!targetG) return;
    const tIdx = geoms.indexOf(targetG);
    const laneOut = targetG.arm.laneOut;
    const mergeU = facility.data.targetMergeU != null ? facility.data.targetMergeU : nearU(targetG);
    for (let k = 0; k < facility.laneCount; k += 1) {
      const outLane = Math.max(0, laneOut - 1 - k);
      mergeReceivers.set(`${tIdx}|out|${outLane}`, mergeU);
    }
  });

  // Collect every guide triangle (导流区) so no topology polyline ever crosses
  // one: guide triangles are edge-conditioned islands derived around (and never
  // on) travel-lane centrelines.
  const guideTriangles = [];
  (facilities || []).forEach((facility) => {
    if (!facility?.data?.guideInner || !facility.data.guideApex) return;
    guideTriangles.push([...facility.data.guideInner, facility.data.guideApex]);
  });
  const clipPath = (path) => {
    if (!path || !guideTriangles.length) return path;
    const runs = [];
    let run = [];
    for (const p of path) {
      const ok = p && Number.isFinite(p.x) && Number.isFinite(p.y)
        && !guideTriangles.some((tri) => pointInRing(p, tri));
      if (ok) run.push(p);
      else if (run.length) { runs.push(run); run = []; }
    }
    if (run.length) runs.push(run);
    const out = runs.filter((r) => r.length >= 2).flat();
    return out.length ? out : []; // fully inside a triangle -> no centreline
  };

  geoms.forEach((g, i) => {
    const arm = g.arm;
    // Inbound lanes.
    for (let index = 0; index < arm.laneIn; index += 1) {
      const s = -(g.medW / 2 + (index + 0.5) * g.laneW);
      let path = armPath(g, s);
      const facility = facilities && facilities[i];
      if (facility && facility.type !== 'direct'
          && index >= arm.laneIn - facility.laneCount
          && facility.data && facility.data.lanePaths) {
        // Dedicated right-turn branch: contiguous from arm root through the curve.
        const k = index - (arm.laneIn - facility.laneCount);
        const branchPath = facility.data.lanePaths[k];
        if (branchPath && branchPath.length >= 2) {
          path = [g.wp(armLength, s), ...branchPath];
        }
      }
      laneCenterlines.push({
        armIndex: i, side: 'in', index, skip: false,
        id: laneIds.get(`${i}|in|${index}`) || `${i}|in|${index}`,
        path,
      });
    }
    // Outbound lanes.
    for (let index = 0; index < arm.laneOut; index += 1) {
      const s = g.medW / 2 + (index + 0.5) * g.laneW;
      const mergeU = mergeReceivers.get(`${i}|out|${index}`);
      const uStart = mergeU != null ? Math.max(nearU(g), mergeU) : nearU(g);
      laneCenterlines.push({
        armIndex: i, side: 'out', index, skip: false,
        id: laneIds.get(`${i}|out|${index}`) || `${i}|out|${index}`,
        path: armPath(g, s, uStart),
      });
    }
  });

  // Drop any centreline/connection points that fall inside a guide triangle.
  laneCenterlines.forEach((cl) => { cl.path = clipPath(cl.path) || []; });
  connections.forEach((conn) => { conn.path = clipPath(conn.path) || []; });

  return { arms: geoms, lanes, laneCenterlines, connections, laneByKey };
}