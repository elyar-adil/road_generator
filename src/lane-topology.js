// Lane-level topology graph.
//
// The intersection is described as an explicit network of lane endpoints and the
// lane-to-lane connections across the junction. This graph is a single source of
// truth that drives (a) the topology centerline viewer, (b) diverge/merge
// reasoning, and — later — interchange/overpass composition. It deliberately
// depends only on pure geometry, not on THREE or any global state, so it stays
// testable and reusable.

import { classifyMovement, armLaneMovementSets } from './road-movements.js';
import { add, scl, sub, len, appendCubic2, pointInRing, sweptTurn, resampleByDistance } from './geometry.js';

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
// Turning lanes prefer a vehicle swept-turn arc (constant turn radius that grows
// with the lane's lateral offset, so parallel turning lanes stay distinct);
// straight-through moves fall back to a gentle cubic lead.
export function connectLanePath(fromG, fromS, toG, toS, { station = 0.5 } = {}) {
  const fromP = fromG.wp(fromG.R + station, fromS);
  const toP = toG.wp(toG.R + station, toS);
  const fromDir = scl(fromG.fwd, -1);
  const toDir = toG.fwd;
  const crossed = classifyMovement(fromG, toG);
  if (crossed.type === 'left' || crossed.type === 'right') {
    // Design turn radius grows with the lane's distance from the median so outer
    // lanes sweep wider arcs without merging into their neighbours.
    const outerR = Math.max(0, Math.abs(fromS)) || 0;
    const radius = Math.min(22, Math.max(5, 5.5 + outerR * 0.55));
    const swept = sweptTurn(fromP, fromDir, toP, toDir, radius, 48);
    if (swept && swept.length >= 8) return swept;
  }
  const dist = len(sub(toP, fromP)) || 1;
  // A handle near half the chord makes the cubic one continuous, gently
  // curving S from entry to exit - not "straight, bend, straight".
  const handle = Math.max(4, Math.min(dist * 0.5, 24));
  const c1 = add(fromP, scl(fromDir, handle));
  const c2 = add(toP, scl(toDir, -handle));
  const path = [fromP];
  const segments = 48;
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
//                    side is 'in' | 'out' | 'branch' (scheme-2 branch lanes
//                    that split off the outer through lane)
//   connections:     array of { fromId, toId, fromArm, toArm, fromIndex, toIndex,
//                               movement, turn, path }
export function computeLaneTopology(geoms, { armLength = 46, facilities = [] } = {}) {
  const targets = armMovementTargets(geoms);
  const connections = [];
  const laneIds = new Map(); // armIndex|side|index -> lane id

  // Single source of truth for every lane's assigned movement: centreline
  // assignment (below) and connection edges must agree with the arrows.
  const movementSetsByArm = geoms.map((fromG, i) => {
    const has = new Set();
    ['left', 'straight', 'right'].forEach((m) => { if (targets[i][m]) has.add(m); });
    return armLaneMovementSets(fromG.arm, has, targets[i].left, targets[i].right);
  });

  geoms.forEach((fromG, i) => {
    const arm = fromG.arm;
    const { laneIn, laneOut } = arm;
    if (laneIn <= 0) return;
    const movementSets = movementSetsByArm[i];
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

    // Channelized right-turn branch lanes (split/slip) are handled in the
    // centreline pass below, driven by each lane's movement assignment.
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

  // Movement-aware lane centreline polylines. Every travel lane gets a
  // centreline that matches what that lane actually is, driven by the same
  // lane->movement assignment the arrows use (never by lane position alone):
  //   - a dedicated right-turn lane (scheme 1) is one contiguous polyline from
  //     the arm root, through the curved branch, to the merge;
  //   - every other inbound lane (straight/left, including the outer through
  //     lane in scheme 2) keeps a straight centreline along the full arm;
  //   - a scheme-2 branch is its own lane with its own centreline, from the
  //     split point through the curve to the merge;
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

  // Clip polylines against the collected guide triangles. Returns an array of
  // disjoint runs; concatenating runs would draw phantom chords across islands,
  // so consumers must render each run separately (`runs`). The flat legacy
  // `path` is kept for callers/tests that only inspect endpoints.
  const guideTriangles = [];
  (facilities || []).forEach((facility) => {
    const poly = facility?.data?.guidePoly;
    if (!poly || poly.length < 3) return;
    guideTriangles.push(poly);
  });
  const clipToRuns = (path) => {
    if (!path || !guideTriangles.length) return path ? [path] : [];
    const runs = [];
    let run = [];
    for (const p of path) {
      const ok = p && Number.isFinite(p.x) && Number.isFinite(p.y)
        && !guideTriangles.some((tri) => pointInRing(p, tri));
      if (ok) run.push(p);
      else if (run.length) { runs.push(run); run = []; }
    }
    if (run.length) runs.push(run);
    return runs.filter((r) => r.length >= 2);
  };

  geoms.forEach((g, i) => {
    const arm = g.arm;
    const facility = facilities && facilities[i];
    const branchFacility = facility && facility.type !== 'direct' && facility.data && facility.data.lanePaths
      ? facility
      : null;
    const laneSets = movementSetsByArm[i];
    // Inbound lanes: a centreline is grafted onto the branch only for lanes the
    // movement assignment marks as dedicated right-turn lanes (scheme 1).
    for (let index = 0; index < arm.laneIn; index += 1) {
      const s = -(g.medW / 2 + (index + 0.5) * g.laneW);
      let path = armPath(g, s);
      if (branchFacility && laneSets[index] && laneSets[index].has('right')) {
        const k = index - (arm.laneIn - branchFacility.laneCount);
        const branchPath = branchFacility.data.lanePaths[k];
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
    // Scheme-2 branch lanes: separate travel lanes that split off the outer
    // through lane (their movement is not 'right', so no inbound lane was
    // grafted). Their centreline is the branch path itself, from the split
    // point through the curve to the merge.
    const outerIsRight = laneSets[arm.laneIn - 1] && laneSets[arm.laneIn - 1].has('right');
    if (branchFacility && !outerIsRight) {
      branchFacility.data.lanePaths.forEach((branchPath, k) => {
        if (!branchPath || branchPath.length < 2) return;
        laneCenterlines.push({
          armIndex: i, side: 'branch', index: k, skip: false,
          id: `${i}|branch|${k}`,
          path: branchPath,
        });
      });
    }
    // Outbound lanes. A merge-receiving lane keeps its full straight centreline
    // from the arm root so the through road stays visually continuous up to (and
    // through) where the branch hands off; points that fall into any guide
    // triangle are clipped afterwards, so no truncation is needed here.
    for (let index = 0; index < arm.laneOut; index += 1) {
      const s = g.medW / 2 + (index + 0.5) * g.laneW;
      laneCenterlines.push({
        armIndex: i, side: 'out', index, skip: false,
        id: laneIds.get(`${i}|out|${index}`) || `${i}|out|${index}`,
        path: armPath(g, s, nearU(g)),
      });
    }
  });

  // Drop any centreline/connection points that fall inside a guide triangle.
  // Paths are first resampled at a uniform arc-length step so ribbon meshes
  // and offset geometry stay smooth regardless of the generator's sampling;
  // endpoints are preserved exactly. `runs` is the canonical clipped geometry;
  // `path` stays the flattened form for endpoint-inspecting consumers (never
  // render it directly).
  const prepare = (path) => (path && path.length > 1 ? resampleByDistance(path, 0.75) : path);
  laneCenterlines.forEach((cl) => {
    cl.path = prepare(cl.path);
    cl.runs = clipToRuns(cl.path);
    cl.path = cl.runs.flat();
  });
  connections.forEach((conn) => {
    conn.path = prepare(conn.path);
    conn.runs = clipToRuns(conn.path);
    conn.path = conn.runs.flat();
  });

  return { arms: geoms, lanes, laneCenterlines, connections, laneByKey };
}