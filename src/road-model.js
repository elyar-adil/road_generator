// Layer-1 road model.
//
// The model has two layers:
//   Layer 1 (this module): ROAD. Every road/arm is a directed corridor defined
//     by its own geometry (heading, lane bundle cross-section) plus the
//     network topology (which roads connect to which, and as what movement).
//   Layer 2 (lane-topology.js): LANE graph, the per-lane connections.
//
// This module owns layer 1 only: it turns the declarative project config into
// per-road geometry and connectivity, which lane/derivation layers consume. It
// is pure (no THREE, no global state) so it is reusable and testable - and the
// same "a road carries a bundle of lanes and connects to neighbours" model is
// what an interchange/overpass composes later.

import {
  v2, add, scl, sub, len, lerp2,
  fillet, lineIntersect,
} from './geometry.js';

// Cross-section geometry of a road given lane counts / widths / radius.
function armGeometry(arm, cfg) {
  const a = arm.angle * Math.PI / 180;
  const fwd = v2(Math.cos(a), Math.sin(a));
  const left = v2(-Math.sin(a), Math.cos(a));
  const hasTwoWay = arm.laneIn > 0 && arm.laneOut > 0;
  const medW = hasTwoWay && arm.centerMode === 'planted' ? arm.medianWidth : 0;
  const laneW = cfg.laneWidth;
  const inOuterS = medW / 2 + arm.laneOut * laneW;
  const outOuterS = -(medW / 2 + arm.laneIn * laneW);
  const totalHalf = Math.max(inOuterS, -outOuterS, (inOuterS - outOuterS) / 2);
  const laneBasedRadius = 3.6 + (inOuterS - outOuterS) / 2;
  const R = Math.max(laneBasedRadius, cfg.intersectionSize / 2);
  const wp = (u, s) => add(scl(fwd, u), scl(left, s));
  return {
    arm, fwd, left, laneW, medW, inOuterS, outOuterS, totalHalf, R, wp,
    nearLeft: wp(R, inOuterS), nearRight: wp(R, outOuterS),
    farLeft: wp(cfg.armLength, inOuterS), farRight: wp(cfg.armLength, outOuterS),
    nearMedL: wp(R, medW / 2), nearMedR: wp(R, -medW / 2),
    farMedL: wp(cfg.armLength, medW / 2), farMedR: wp(cfg.armLength, -medW / 2),
  };
}

// Radial clearance so adjacent roads do not overlap at the core.
function updateArmRadii(geoms, cfg) {
  const sorted = geoms.slice().sort((a, b) => a.arm.angle - b.arm.angle);
  const n = sorted.length;
  sorted.forEach((g, i) => {
    const prev = sorted[(i + n - 1) % n].arm.angle;
    const next = sorted[(i + 1) % n].arm.angle;
    const gapPrev = ((g.arm.angle - prev + 360) % 360) || 360;
    const gapNext = ((next - g.arm.angle + 360) % 360) || 360;
    const minGap = Math.min(gapPrev, gapNext) * Math.PI / 180;
    const clearance = g.totalHalf / Math.max(Math.tan(minGap / 2), 0.2) + 1.5;
    g.R = Math.min(cfg.armLength - 5, Math.max(g.R, clearance));
    g.nearLeft = g.wp(g.R, g.inOuterS);
    g.nearRight = g.wp(g.R, g.outOuterS);
    g.nearMedL = g.wp(g.R, g.medW / 2);
    g.nearMedR = g.wp(g.R, -g.medW / 2);
  });
}

// Push curb corners outward so the connecting fillet clears neighbouring roads.
function updateCornerTrims(geoms, cfg) {
  const n = geoms.length;
  geoms.forEach((g) => { g.leftR = g.R; g.rightR = g.R; });
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n, gi = geoms[i], gj = geoms[j];
    const a0 = gi.wp(0, gi.inOuterS), b0 = gj.wp(0, gj.outOuterS);
    const corner = lineIntersect(a0, add(a0, gi.fwd), b0, add(b0, gj.fwd));
    if (!corner) continue;
    const u0 = corner.x * gi.fwd.x + corner.y * gi.fwd.y;
    const u1 = corner.x * gj.fwd.x + corner.y * gj.fwd.y;
    if (u0 < 0 || u1 < 0) continue;
    const trim = Math.max(3.2, cfg.laneWidth * 1.35);
    gi.leftR = Math.min(cfg.armLength - 5, Math.max(gi.R, u0 + trim));
    gj.rightR = Math.min(cfg.armLength - 5, Math.max(gj.R, u1 + trim));
  }
  geoms.forEach((g) => {
    g.nearLeft = g.wp(g.leftR, g.inOuterS);
    g.nearRight = g.wp(g.rightR, g.outOuterS);
    g.R = Math.max(g.leftR, g.rightR);
    g.nearMedL = g.wp(g.R, g.medW / 2);
    g.nearMedR = g.wp(g.R, -g.medW / 2);
  });
}

function constrainFilletPoint(p, gi, gj, cfg) {
  const margin = 0.22;
  let q = p;
  const relI = q, ui = relI.x * gi.fwd.x + relI.y * gi.fwd.y, si = relI.x * gi.left.x + relI.y * gi.left.y;
  if (ui > 0 && ui < cfg.armLength && si < gi.inOuterS + margin) q = add(q, scl(gi.left, gi.inOuterS + margin - si));
  const relJ = q, uj = relJ.x * gj.fwd.x + relJ.y * gj.fwd.y, sj = relJ.x * gj.left.x + relJ.y * gj.left.y;
  if (uj > 0 && uj < cfg.armLength && sj > gj.outOuterS - margin) q = add(q, scl(gj.left, gj.outOuterS - margin - sj));
  return q;
}

// The fillet (corner) polylines between each adjacent pair of roads.
export function buildCornerFillets(geoms, cfg) {
  const n = geoms.length;
  const filletPts = [];
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    const pts = fillet(geoms[i].nearLeft, scl(geoms[i].fwd, -1), geoms[j].nearRight, geoms[j].fwd, cfg.filletSeg)
      .map((p) => constrainFilletPoint(p, geoms[i], geoms[j], cfg));
    filletPts.push(pts);
  }
  return filletPts;
}

function bestTarget(geoms, i, type, expectedTurn) {
  const fromG = geoms[i];
  return geoms
    .filter((g) => g !== fromG && g.arm.laneOut > 0)
    .map((g) => ({ g, movement: classifyMovement(fromG, g) }))
    .filter((c) => c.movement.type === type)
    .sort((a, b) => Math.abs(a.movement.turn - expectedTurn) - Math.abs(b.movement.turn - expectedTurn))[0]?.g || null;
}

import { classifyMovement } from './road-movements.js';

// How many inbound lanes an approach dedicates to a left turn at the core.
export function leftTurnLaneCapacity(arm, target) {
  if (!target || arm.laneIn < 3) return 0;
  return Math.min(2, arm.leftTurnLanes, arm.laneIn - 2, target.arm.laneOut);
}

// How many inbound lanes an approach dedicates to a channelized right turn.
export function rightTurnLaneCapacity(arm, target) {
  if (!arm?.rightTurnLane || arm.rightTurnType === 'none' || !target) return 0;
  const requested = Math.min(2, arm.rightTurnLanes);
  return arm.laneIn >= requested && target.arm.laneOut >= requested ? requested : 0;
}

import { buildRightTurnPathData } from './right-turn.js';

function createRightTurnFacility(fromG, toG, cfg) {
  const laneCount = rightTurnLaneCapacity(fromG.arm, toG);
  if (!laneCount) return null;
  const type = fromG.arm.rightTurnType;
  const data = buildRightTurnPathData(fromG, toG, type, laneCount, { armLength: cfg.armLength });
  return data ? { type, laneCount, data, target: toG } : null;
}

// Build the layer-1 road model from the project config.
//
// Returns:
//   geoms:           per-road geometry descriptors (index == sorted arm order)
//   availPerArm:     per-road Set of reachable movement types
//   leftTargets / straightTargets / rightTargets: per-road target geoms
//   rightFacilities: per-road channelized right-turn branch, or null
//   filletPts:       corner fillet polylines between adjacent roads
export function buildRoadModel(state) {
  const cfg = {
    laneWidth: state.laneWidth,
    intersectionSize: state.intersectionSize,
    armLength: state.armLength,
    filletSeg: state.filletSeg,
  };
  const arms = state.arms.slice().sort((a, b) => a.angle - b.angle);
  const geoms = arms.map((arm) => armGeometry(arm, cfg));
  updateArmRadii(geoms, cfg);
  updateCornerTrims(geoms, cfg);

  const n = geoms.length;
  const availPerArm = geoms.map((g, i) => {
    const set = new Set();
    for (let j = 0; j < n; j += 1) {
      if (j === i) continue;
      if (geoms[j].arm.laneOut <= 0) continue;
      const m = classifyMovement(g, geoms[j]);
      if (m.type !== 'uturn') set.add(m.type);
    }
    return set;
  });
  const leftTargets = geoms.map((g, i) => bestTarget(geoms, i, 'left', 90));
  const straightTargets = geoms.map((g, i) => bestTarget(geoms, i, 'straight', 0));
  const rightTargets = geoms.map((g, i) => bestTarget(geoms, i, 'right', -90));
  const rightFacilities = geoms.map((g, i) => createRightTurnFacility(g, rightTargets[i], cfg));
  const filletPts = buildCornerFillets(geoms, cfg);

  return { geoms, availPerArm, leftTargets, straightTargets, rightTargets, rightFacilities, filletPts, cfg };
}

// Whether a point lies over any road's carriageway envelope (used to keep
// scenery clear of the network).
export function pointBlockedByRoad(p, geoms, cfg) {
  for (const g of geoms) {
    const rel = sub(p, v2(0, 0));
    const u = rel.x * g.fwd.x + rel.y * g.fwd.y;
    const s = rel.x * g.left.x + rel.y * g.left.y;
    if (u > -6 && u < cfg.armLength + 14 && Math.abs(s) < Math.max(g.inOuterS, -g.outOuterS) + 7 + cfg.sidewalkWidth) return true;
  }
  return false;
}