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
  v2, add, scl,
  fillet, lineIntersect,
} from './geometry.js';
import { createStraightFrame } from './frame.js';
import { computeRoundaboutLayout } from './roundabout.js';

// Cross-section geometry of a road given lane counts / widths / radius.
//
// The road's (u,s) -> world mapping comes from a frame (frame.js): today every
// arm is a straight ray, but the frame seam lets future node types (curved
// approaches, ramps, roundabout carriageways) supply any centreline while the
// geom shape below - and every consumer of it - stays unchanged. g.fwd/g.left
// remain the core-end tangents used for movement classification and connector
// start directions.
function armGeometry(arm, cfg) {
  const frame = createStraightFrame(v2(0, 0), arm.angle);
  const { fwd, left, wp } = frame;
  const hasTwoWay = arm.laneIn > 0 && arm.laneOut > 0;
  const medW = hasTwoWay && arm.centerMode === 'planted' ? arm.medianWidth : 0;
  const laneW = cfg.laneWidth;
  const inOuterS = medW / 2 + arm.laneOut * laneW;
  const outOuterS = -(medW / 2 + arm.laneIn * laneW);
  const totalHalf = Math.max(inOuterS, -outOuterS, (inOuterS - outOuterS) / 2);
  const laneBasedRadius = 3.6 + (inOuterS - outOuterS) / 2;
  const R = Math.max(laneBasedRadius, cfg.intersectionSize / 2);
  return {
    arm, frame, fwd, left, laneW, medW, inOuterS, outOuterS, totalHalf, R, wp,
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
  const data = buildRightTurnPathData(fromG, toG, type, laneCount, {
    armLength: cfg.armLength,
    rightTurnMode: fromG.arm.rightTurnMode,
  });
  return data ? { type, laneCount, data, target: toG } : null;
}

// Build the layer-1 road model from the project config.
//
// Two node kinds share this entry point:
//   - 'cross' (default): radial arms + central polygon + corner fillets, with
//     per-arm channelized right-turn facilities.
//   - 'roundabout': arms truncate at the inscribed circle; the circulating
//     carriageway, central island and splitter islands replace the core
//     polygon. No signal-driven facilities are produced.
//
// Returns:
//   geoms:           per-road geometry descriptors (index == sorted arm order)
//   availPerArm:     per-road Set of reachable movement types ('cross' only)
//   leftTargets / straightTargets / rightTargets: per-road target geoms
//   rightFacilities: per-road channelized right-turn branch, or null
//   filletPts:       corner fillet polylines between adjacent roads
//   roundabout:      { inscribedR, circWidth, islandR } ('roundabout' only)
export function buildRoadModel(state) {
  const cfg = {
    laneWidth: state.laneWidth,
    intersectionSize: state.intersectionSize,
    armLength: state.armLength,
    filletSeg: state.filletSeg,
  };
  const arms = state.arms.slice().sort((a, b) => a.angle - b.angle);

  if (state.junctionType === 'roundabout') {
    const baseLayout = computeRoundaboutLayout({
      arms, laneWidth: cfg.laneWidth, intersectionSize: cfg.intersectionSize,
    });
    const geoms = arms.map((arm) => armGeometry(arm, cfg));
    // Adjacent-arm separation may demand more radial room than the nominal
    // inscribed circle. One UNIFORM core radius keeps every approach on the
    // exact same seam circle (a per-arm radius would leave gaps).
    updateArmRadii(geoms, cfg);
    const coreR = Math.max(baseLayout.inscribedR, ...geoms.map((g) => g.R), 12);
    const widestLanes = arms.reduce((max, arm) => Math.max(max, arm.laneIn, arm.laneOut), 1);
    const requiredForkReach = Math.max(coreR * 0.42, widestLanes * cfg.laneWidth * 0.7 + 2);
    cfg.armLength = Math.max(cfg.armLength, Math.ceil(coreR + requiredForkReach + 5));
    geoms.forEach((g) => {
      g.R = coreR;
      g.leftR = coreR;
      g.rightR = coreR;
      g.nearLeft = g.wp(g.R, g.inOuterS);
      g.nearRight = g.wp(g.R, g.outOuterS);
      g.nearMedL = g.wp(g.R, g.medW / 2);
      g.nearMedR = g.wp(g.R, -g.medW / 2);
      g.farLeft = g.wp(cfg.armLength, g.inOuterS);
      g.farRight = g.wp(cfg.armLength, g.outOuterS);
      g.farMedL = g.wp(cfg.armLength, g.medW / 2);
      g.farMedR = g.wp(cfg.armLength, -g.medW / 2);
    });
    const roundabout = {
      inscribedR: coreR,
      circWidth: baseLayout.circWidth,
      islandR: coreR - baseLayout.circWidth,
      circLanes: baseLayout.circLanes,
    };
    return {
      geoms,
      availPerArm: [], leftTargets: [], straightTargets: [],
      rightTargets: [], rightFacilities: geoms.map(() => null),
      filletPts: geoms.map(() => []),
      cfg, roundabout,
    };
  }

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
