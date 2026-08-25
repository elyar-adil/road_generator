// Layer-2 derivation layer.
//
// Given the layer-1 road model (road geometry + connectivity + right-turn
// facilities) and the layer-2 lane graph, this module derives every visual
// detail of the intersection as pure data: road surfaces, medians, lane
// markings, arrows, guide areas, sidewalks, guardrails, crossing/stop lines,
// waiting areas, street furniture and scenery. It never builds meshes and never
// touches THREE or global state, so the whole scene description can be unit
// tested and reused (an interchange/overpass just supplies a bigger road model).
//
// The render layer maps this data to meshes; this layer only decides WHERE
// things go and what they mean.

import {
  v2, add, sub, scl, len, lerp2,
  polylineLength, pointAndTangentAtDistance, offsetPolyline,
  buildDashedSegments, buildLeftTurnPath, trimPolyline,
  rayBoundaryIntersect, pointInRing, edgeLine,
} from './geometry.js';
import { trimBeforeLaneEnvelope } from './waiting-area.js';
import { armLaneMovementSets, leftTurnCapacity } from './road-movements.js';
import { buildCornerFillets } from './road-model.js';
import {
  annulusSectorQuads,
  circlePolygon,
  roundaboutApproach,
  roundaboutArmSlots,
  forkIslandPolygon,
} from './roundabout.js';

// ---------------------------------------------------------------------------
// Arrow outlines (design spec, units cm; local frame [lateral, forward]).
// y=0 is the tail; max y is the front tip. Same shapes as RoadArrowShapes.
// ---------------------------------------------------------------------------
export const ARROW_LENGTH = 3050;

const ARROW_STRAIGHT = [
  [-75, 0], [75, 0], [75, 1800], [225, 1800], [0, 3000], [-225, 1800], [-75, 1800],
];
const ARROW_LEFT_RAW = [
  [225, 0], [375, 0], [375, 1950], [-175, 2550], [-175, 3050],
  [-375, 2250], [-175, 1350], [-175, 1800], [225, 1350],
].map(([x, y]) => [-x, y]);
const ARROW_STRAIGHT_LEFT_RAW = [
  [150, 0], [300, 0], [300, 1800], [450, 1800], [225, 3000], [0, 1800], [150, 1800],
  [150, 800], [-250, 1250], [-250, 1750], [-450, 950], [-250, 200], [-250, 650], [150, 200],
].map(([x, y]) => [-x, y]);
const ARROW_RIGHT = ARROW_LEFT_RAW.map(([x, y]) => [-x, y]);
const ARROW_STRAIGHT_RIGHT = ARROW_STRAIGHT_LEFT_RAW.map(([x, y]) => [-x, y]);
const ARROW_STRAIGHT_LEFT_RIGHT = [
  [-75, 0], [75, 0], [75, 200], [475, 650], [475, 200], [675, 950], [475, 1750],
  [475, 1260], [75, 650], [75, 1800], [225, 1800], [0, 3000], [-225, 1800], [-75, 1800],
  [-75, 800], [-475, 1250], [-475, 1750], [-675, 950], [-475, 200], [-475, 650], [-75, 200],
];

function arrowPolygons(types) {
  const arr = [...new Set(types && types.length ? types : ['straight'])];
  const key = arr.slice().sort().join('+');
  if (key === 'left+straight') return [ARROW_STRAIGHT_LEFT_RAW];
  if (key === 'right+straight') return [ARROW_STRAIGHT_RIGHT];
  if (key === 'left+right+straight') return [ARROW_STRAIGHT_LEFT_RIGHT];
  const shape = key === 'left' ? ARROW_LEFT_RAW : (key === 'right' ? ARROW_RIGHT : ARROW_STRAIGHT);
  if (arr.length === 1) return [shape];
  const HW = { left: 375, right: 375, straight: 225 };
  const spacing = arr.length === 2 ? HW[arr[0]] + HW[arr[1]] + 50 : 600;
  const out = [];
  arr.forEach((t, i) => {
    const o = (i - (arr.length - 1) / 2) * spacing;
    const s = t === 'left' ? ARROW_LEFT_RAW : (t === 'right' ? ARROW_RIGHT : ARROW_STRAIGHT);
    out.push(s.map((p) => [p[0] + o, p[1]]));
  });
  return out;
}

// Arrow footprint on a straight arm between two longitudinal stations.
export function arrowOnArm(g, uTail, uTip, sBase, types) {
  const scale = Math.min(1, (uTail - uTip) / ARROW_LENGTH);
  return arrowPolygons(types).map((points) => points.map(([lateral, forward]) => g.wp(
    uTail - forward * scale,
    sBase + lateral * scale,
  )));
}

// Arrow footprint along an arbitrary path (branch lanes, waiting areas).
export function arrowOnPath(path, types) {
  const total = polylineLength(path);
  const arrowLength = Math.min(3, total * 0.48);
  if (arrowLength < 1.5) return [];
  const tailDistance = Math.min(0.7, total * 0.12);
  const pose = pointAndTangentAtDistance(path, tailDistance);
  if (!pose) return [];
  const normal = v2(pose.tangent.y, -pose.tangent.x);
  const scale = arrowLength / ARROW_LENGTH;
  return arrowPolygons(types).map((points) => points.map(([lateral, forward]) => add(
    pose.point,
    add(scl(normal, lateral * scale), scl(pose.tangent, forward * scale)),
  )));
}

// ---------------------------------------------------------------------------
// Longitudinal markings
// ---------------------------------------------------------------------------
// Phase anchor for the main carriageway's dashes: first dash leading edge just
// past the stop line. Keeping this in one place lets branch/merge markings
// re-derive the same phase on any arm.
export function laneLineStartFor(g, cfg) {
  const crosswalkStart = g.R + 0.7;
  const crosswalkEnd = Math.min(g.R + 4.2, cfg.armLength - 1.8);
  const hasCrosswalkSpace = crosswalkEnd - crosswalkStart > 1.2;
  const stopU = hasCrosswalkSpace ? crosswalkEnd + 0.45 : g.R + 0.45;
  return stopU + 0.5 / 2 + 0.05;
}

// Dashed divider parallel to an arm between two longitudinal stations at a fixed
// lateral offset. Iterating in u-space anchored on laneLineStartFor reproduces
// the main carriageway dash grid exactly.
export function armDashes(g, uFrom, uTo, s, cfg, { dashLen = 2.6, gapLen = 2.2 } = {}) {
  const u0 = Math.min(uFrom, uTo), u1 = Math.max(uFrom, uTo);
  if (u1 - u0 < 1e-4) return [];
  const period = dashLen + gapLen;
  const anchor = laneLineStartFor(g, cfg);
  const mStart = Math.floor((u0 - anchor - dashLen) / period) + 1;
  const segments = [];
  for (let m = mStart; ; m += 1) {
    const start = anchor + m * period;
    if (start > u1) break;
    const end = start + dashLen;
    if (end <= u0) continue;
    const a = Math.max(start, u0), b = Math.min(end, u1);
    if (b - a <= 1e-4) continue;
    segments.push([g.wp(a, s), g.wp(b, s)]);
  }
  return segments;
}

// Dashed segments along an arbitrary path (generic cadence).
export function pathDashes(path, { dashLen = 1.0, gapLen = 1.0, phase = 0 } = {}) {
  return buildDashedSegments(path, dashLen, gapLen, phase);
}

// ---------------------------------------------------------------------------
// Waiting areas
// ---------------------------------------------------------------------------
export function medianIslandTop(g, noseInnerU, cfg) {
  const radius = g.medW / 2;
  const noseU = noseInnerU + radius;
  const farU = cfg.armLength;
  if (radius < 0.1 || farU - noseU < 0.5) return null;
  const pts = [g.wp(farU, radius), g.wp(noseU, radius)];
  const segments = Math.max(8, cfg.filletSeg * 2);
  for (let i = 0; i <= segments; i += 1) {
    const angle = Math.PI / 2 + Math.PI * i / segments;
    pts.push(g.wp(noseU + Math.cos(angle) * radius, Math.sin(angle) * radius));
  }
  pts.push(g.wp(farU, -radius));
  return pts;
}

export function opposingLeftLaneCapacity(opposingG, target) {
  const arm = opposingG?.arm;
  if (!arm) return 0;
  if (!target || arm.laneIn < 2 || target.arm.laneOut < 1) return 0;
  return arm.waitingArea === 'left'
    ? Math.min(2, arm.leftTurnLanes, Math.max(0, arm.laneIn - 2), target.arm.laneOut)
    : Math.min(1, arm.laneIn - 1);
}

function trimBeforeOpposingStraight(path, opposingG, halfWidth, opposingLeftLanes) {
  if (!opposingG) return path;
  const straightOuterEdge = -(opposingG.medW / 2 + opposingLeftLanes * opposingG.laneW);
  return trimBeforeLaneEnvelope(path, {
    forward: opposingG.fwd,
    left: opposingG.left,
    minLongitudinal: -opposingG.R - 1,
    maxLongitudinal: opposingG.R + 1,
    minLateral: opposingG.outOuterS,
    maxLateral: straightOuterEdge,
    halfWidth,
  });
}

function averagePathGap(pathA, pathB) {
  const count = Math.min(pathA.length, pathB.length);
  let total = 0;
  for (let i = 0; i < count; i += 1) total += len(sub(pathA[i], pathB[i]));
  return count ? total / count : Infinity;
}

function averagePaths(pathA, pathB) {
  const count = Math.min(pathA.length, pathB.length);
  return Array.from({ length: count }, (_, index) => lerp2(pathA[index], pathB[index], 0.5));
}

// Left-turn waiting pockets. Returns strips [{left,right}] plus the derived
// dashed side-line segments and arrow footprints.
export function leftWaitingAreas(fromG, targetG, opposingG, zoneOuter, laneCount, cfg, random, opposingLeftLanes = 0) {
  const minLength = Math.min(12, Math.max(8, cfg.intersectionSize * 0.22));
  const maxLength = Math.min(28, Math.max(minLength + 5, cfg.intersectionSize * 0.46));
  const desiredLength = minLength + (maxLength - minLength) * (0.72 + random() * 0.16);
  const baseHandle = 1.20 + random() * 0.16;
  const paths = [];
  for (let laneOffset = 0; laneOffset < laneCount; laneOffset += 1) {
    const sourceS = -(fromG.medW / 2 + (laneOffset + 0.5) * fromG.laneW);
    const targetS = targetG.medW / 2 + (laneOffset + 0.5) * targetG.laneW;
    let bestPath = [];
    let bestLength = 0;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = buildLeftTurnPath({
        start: fromG.wp(zoneOuter, sourceS),
        startDirection: scl(fromG.fwd, -1),
        target: targetG.wp(targetG.R + 0.55, targetS),
        targetDirection: targetG.fwd,
        samples: Math.max(18, cfg.filletSeg * 4),
        handleScale: baseHandle + attempt * 0.10 + laneOffset * 0.02,
        maxProgress: 0.54 + attempt * 0.004,
      });
      const safe = trimBeforeOpposingStraight(candidate, opposingG, fromG.laneW / 2, opposingLeftLanes);
      const length = polylineLength(safe);
      if (length > bestLength) { bestLength = length; bestPath = safe; }
      if (length >= desiredLength) { bestPath = trimPolyline(safe, desiredLength); break; }
    }
    const minimumUsefulLength = Math.max(7, minLength * 0.82);
    paths.push(bestLength >= minimumUsefulLength ? trimPolyline(bestPath, maxLength) : []);
  }
  if (!paths.length || paths.every((p) => !p.length)) return null;

  const strips = paths.map((path) => {
    if (!path.length || polylineLength(path) < 2.2) return null;
    const { left, right } = offsetPolyline(path, fromG.laneW / 2);
    return { left, right, path };
  }).filter(Boolean);
  if (!strips.length) return null;

  const result = { strips, dashes: [], arrows: [] };
  const width = fromG.laneW;
  strips.forEach((strip) => {
    result.dashes.push(pathDashes(strip.left, { dashLen: 1.0, gapLen: 1.0 }));
    result.dashes.push(pathDashes(strip.right, { dashLen: 1.0, gapLen: 1.0 }));
    result.arrows.push(arrowOnPath(strip.path, ['left']));
  });
  if (strips.length > 1) {
    const first = averagePathGap(strips[0].left, strips[1].right);
    const second = averagePathGap(strips[0].right, strips[1].left);
    const mid = first <= second
      ? averagePaths(strips[0].left, strips[1].right)
      : averagePaths(strips[0].right, strips[1].left);
    result.dashes.push(pathDashes(mid, { dashLen: 1.0, gapLen: 1.0 }));
  }
  return result;
}

// Straight waiting pocket between two inbound lanes.
export function straightWaitingArea(g, zoneOuter, firstLane, lastLane, cfg) {
  if (firstLane > lastLane) return null;
  const zoneDepth = Math.min(8, Math.max(4, cfg.laneWidth * 2.2));
  const zoneInner = Math.max(0.5, zoneOuter - zoneDepth);
  const sInner = -(g.medW / 2 + firstLane * g.laneW);
  const sOuter = -(g.medW / 2 + (lastLane + 1) * g.laneW);
  const path = [g.wp(zoneOuter, (sInner + sOuter) / 2), g.wp(zoneInner, (sInner + sOuter) / 2)];
  path.splice(1, 0, lerp2(path[0], path[1], 0.5));
  const width = Math.abs(sInner - sOuter);
  if (width < 1.5 || polylineLength(path) < 2.2) return null;
  const { left, right } = offsetPolyline(path, width / 2);
  const dashes = [];
  for (let lane = firstLane + 1; lane <= lastLane; lane += 1) {
    const divider = -(g.medW / 2 + lane * g.laneW);
    dashes.push(pathDashes([
      g.wp(zoneOuter, divider),
      g.wp((zoneOuter + zoneInner) / 2, divider),
      g.wp(zoneInner, divider),
    ], { dashLen: 1.0, gapLen: 1.0 }));
  }
  const arrows = [];
  for (let lane = firstLane; lane <= lastLane; lane += 1) {
    const center = -(g.medW / 2 + (lane + 0.5) * g.laneW);
    arrows.push(arrowOnPath([g.wp(zoneOuter, center), g.wp((zoneOuter + zoneInner) / 2, center), g.wp(zoneInner, center)], ['straight']));
  }
  return { left, right, dashes, arrows };
}

// ---------------------------------------------------------------------------
// Guide area (导流区) + chevrons
// ---------------------------------------------------------------------------
function roundedGuideCorner(previous, corner, next, radius, segments = 4) {
  const toPrevious = sub(previous, corner), toNext = sub(next, corner);
  const previousLength = len(toPrevious), nextLength = len(toNext);
  if (previousLength < 1e-4 || nextLength < 1e-4) return [corner];
  const cut = Math.min(radius, previousLength * 0.28, nextLength * 0.28);
  const entryPoint = add(corner, scl(toPrevious, cut / previousLength));
  const exitPoint = add(corner, scl(toNext, cut / nextLength));
  const points = [entryPoint];
  for (let segmentIndex = 1; segmentIndex < segments; segmentIndex += 1) {
    const progress = segmentIndex / segments, inverse = 1 - progress;
    points.push(v2(
      inverse * inverse * entryPoint.x + 2 * inverse * progress * corner.x + progress * progress * exitPoint.x,
      inverse * inverse * entryPoint.y + 2 * inverse * progress * corner.y + progress * progress * exitPoint.y,
    ));
  }
  points.push(exitPoint);
  return points;
}

// Guide-area polygon from the facility's closed boundary (branch inner edge +
// through edges + corner curve), with the two sharp gore/merge corners rounded.
export function guideArea(facility) {
  const poly = facility.data.guidePoly;
  if (!poly || poly.length < 3) return null;
  const rounded = [];
  for (let i = 0; i < poly.length; i += 1) {
    const prev = poly[(i - 1 + poly.length) % poly.length];
    const curr = poly[i];
    const next = poly[(i + 1) % poly.length];
    rounded.push(...roundedGuideCorner(prev, curr, next, 1.2));
  }
  return rounded;
}

// Chevron legs inside a guide area. Each V tip points along the adjacent lane
// flow; legs land on the two boundary edges so the pattern follows the wedge.
// `guideInner` is the right-turn branch's inner edge and `guidePoints` the closed
// island ring; the chevrons span across the island to the opposite (through/corner)
// edge, pointing inward (toward the turn's inner side).
export function guideChevrons(guideInner, guideApex, guidePoints) {
  if (guideInner.length < 3 || !guidePoints || guidePoints.length < 3) return [];
  const lineWidth = 0.35;
  const total = polylineLength(guideInner);
  const legs = [];
  let distance = 0;
  while (distance < total - 0.3) {
    const pose = pointAndTangentAtDistance(guideInner, distance);
    if (!pose) break;
    const guidePoint = pose.point;
    const tangent = pose.tangent;
    const across = scl(v2(tangent.y, -tangent.x), 1);
    const outerPoint = rayBoundaryIntersect(guidePoint, across, guidePoints, true);
    const width = outerPoint ? len(sub(outerPoint, guidePoint)) : 0;
    let forward = Math.min(width * 0.5, Math.max(0.35, total - 0.3 - distance));
    if (width >= lineWidth * 2) {
      const midpoint = lerp2(guidePoint, outerPoint, 0.5);
      let tip = add(midpoint, scl(tangent, forward));
      const legsInside = (end) => {
        for (let i = 1; i < 12; i += 1) if (!pointInRing(lerp2(tip, end, i / 12), guidePoints)) return false;
        return true;
      };
      while (forward > 0.4 && (!pointInRing(tip, guidePoints) || !legsInside(guidePoint) || !legsInside(outerPoint))) {
        forward = Math.max(0.35, forward - 0.25);
        tip = add(midpoint, scl(tangent, forward));
      }
      legs.push([tip, guidePoint], [tip, outerPoint]);
    }
    distance += lineWidth + forward;
  }
  return legs;
}

// ---------------------------------------------------------------------------
// Right-turn facility derivation (branch surfaces, dividers, markings, arrows).
// ---------------------------------------------------------------------------
export function rightTurnFacilityData(facility, fromG, toG, cfg) {
  if (!facility?.data) return null;
  const { data, type, laneCount } = facility;
  if (type === 'direct') {
    const dividers = [];
    for (let lane = 1; lane < data.lanePaths.length; lane += 1) {
      dividers.push(averagePaths(data.lanePaths[lane - 1], data.lanePaths[lane]));
    }
    return {
      type, direct: true, dividers,
      guidePoly: null, guideChevronLegs: [],
      arrows: data.lanePaths.map((p) => arrowOnPath(p.slice(3), ['right'])),
    };
  }

  const { offsets, innerBoundary, sourceTaperEnd, turnEnd, splitU, turnU, targetMergeU, bundleWidth, separation = 0 } = data;
  const surface = offsets.left.concat(offsets.right.slice().reverse());
  const dividers = [];
  for (let lane = 1; lane < data.lanePaths.length; lane += 1) {
    dividers.push(averagePaths(data.lanePaths[lane - 1], data.lanePaths[lane]));
  }
  const innerBoundarySegments = [];
  for (let index = sourceTaperEnd; index < turnEnd && index < innerBoundary.length - 1; index += 1) {
    innerBoundarySegments.push([innerBoundary[index], innerBoundary[index + 1]]);
  }
  const guidePts = guideArea(facility);
  const guidePoly = guidePts;
  const guideChevronLegs = guidePts ? guideChevrons(data.guideInner, data.guideApex, guidePts) : [];

  return {
    type, direct: false, laneCount,
    surface, dividers,
    entryDashes: armDashes(fromG, turnU, splitU, fromG.outOuterS + bundleWidth - separation, cfg),
    mergeDashes: armDashes(toG, turnU, targetMergeU, toG.inOuterS - bundleWidth, cfg),
    innerBoundarySegments,
    guidePoly, guideChevronLegs,
    arrows: data.lanePaths.map((p) => arrowOnPath(p.slice(3), ['right'])),
  };
}

// Guardrail resolved to world space: posts at ~3.8 m spacing plus a rail span.
export function guardrailAlongArm(g, uStart, uEnd, lateral, yBottom = 0.02, height = 0.78) {
  const span = uEnd - uStart;
  const postCount = Math.max(2, Math.floor(span / 3.8));
  const posts = [];
  for (let k = 0; k <= postCount; k += 1) {
    const u = uStart + span * k / postCount;
    posts.push(g.wp(u, lateral));
  }
  return { posts, rail: { p0: g.wp(uStart, lateral), p1: g.wp(uEnd, lateral) }, yBottom, height };
}

// ---------------------------------------------------------------------------
// Full scene derivation.
//
//   model:     layer-1 road model (buildRoadModel)
//   state:     project config (laneWidth, armLength, sidewalkWidth, filletSeg,
//              showArrows, showCrosswalk, showWaitingAreas, showSidewalk,
//              showBuildings, showLights, scenerySeed, ...)
//   random:    seeded PRNG for scenery/waiting-area variation
//   topology:  layer-2 lane graph (computeLaneTopology), optional
//
// Returns a plain data object consumed by the render layer.
// ---------------------------------------------------------------------------
function createEmptyScene() {
  return {
    roadSurfaces: [],
    medianIslands: [],
    yellowLines: [],
    laneDashes: [],
    laneEdges: [],
    guardrails: [],
    stopLines: [],
    crosswalks: [],
    branchCrossings: [],
    branchYieldLines: [],
    arrows: [],
    waitingAreas: [],
    guideAreas: [],
    guideChevrons: [],
    sidewalks: [],
    curbs: [],
    branchSurfaces: [],
    branchDividers: [],
    trafficLights: [],
    streetLamps: [],
    buildings: [],
    trees: [],
    entryMarks: [],
  };
}

export function deriveRoadScene(model, state, random = Math.random, topology = null) {
  if (state.junctionType === 'roundabout') return deriveRoundaboutScene(model, state, random);
  const { geoms, rightFacilities, rightTargets, leftTargets, straightTargets } = model;
  const cfg = model.cfg;
  const n = geoms.length;
  const scene = createEmptyScene();

  // ---- per-arm road surfaces, medians, markings, arrows, crossing ----
  geoms.forEach((g, i) => {
    const arm = g.arm;
    if (arm.laneIn <= 0 && arm.laneOut <= 0) return;
    const rightFacility = rightFacilities[i];

    const crosswalkStart = g.R + 0.7;
    const crosswalkEnd = Math.min(g.R + 4.2, cfg.armLength - 1.8);
    const hasCrosswalkSpace = crosswalkEnd - crosswalkStart > 1.2;
    const stopU = hasCrosswalkSpace ? crosswalkEnd + 0.45 : g.R + 0.45;
    const waitingAreaStartU = hasCrosswalkSpace ? crosswalkStart - 0.2 : stopU - 0.22;
    const stopLineWidth = 0.5;
    const laneLineStart = laneLineStartFor(g, cfg);
    const facilityStart = stopU + 0.5;

    // pavement
    scene.roadSurfaces.push([g.nearLeft, g.farLeft, g.farRight, g.nearRight]);

    // center separation
    if (arm.centerMode === 'planted' && g.medW > 0.15) {
      const top = medianIslandTop(g, facilityStart, cfg);
      if (top) scene.medianIslands.push(top);
    } else if (arm.laneIn > 0 && arm.laneOut > 0
        && (arm.centerMode === 'doubleYellow' || arm.centerMode === 'doubleYellowRail')) {
      scene.yellowLines.push([g.wp(facilityStart, 0.1), g.wp(cfg.armLength, 0.1)]);
      scene.yellowLines.push([g.wp(facilityStart, -0.1), g.wp(cfg.armLength, -0.1)]);
      if (arm.centerMode === 'doubleYellowRail') {
        scene.guardrails.push(guardrailAlongArm(g, facilityStart + 0.7, cfg.armLength - 0.7, 0, 0.02, 0.78));
      }
    }

    // longitudinal lane lines
    const drawLaneLines = (count, sign) => {
      for (let k = 1; k < count; k += 1) {
        const s = sign * (g.medW / 2 + k * g.laneW);
        const segments = armDashes(g, laneLineStart, cfg.armLength - 1, s, cfg);
        segments.forEach((seg) => scene.laneDashes.push(seg));
      }
      if (count > 0) {
        const sOuter = sign * (g.medW / 2 + count * g.laneW - 0.1);
        scene.laneEdges.push([g.wp(laneLineStart, sOuter), g.wp(cfg.armLength, sOuter)]);
      }
    };
    drawLaneLines(arm.laneIn, -1);
    drawLaneLines(arm.laneOut, 1);

    // side guardrails
    const sideRailStart = stopU + 1.2;
    const sideRailEnd = cfg.armLength - 0.7;
    if (arm.leftGuardrail) {
      scene.guardrails.push(guardrailAlongArm(g, sideRailStart, sideRailEnd, g.inOuterS + 0.22, 0.12, 0.82));
    }
    if (arm.rightGuardrail) {
      const rightRailStart = rightFacility && rightFacility.type !== 'direct'
        ? Math.max(sideRailStart, rightFacility.data.splitU + 0.5)
        : sideRailStart;
      const rightRailLateral = rightFacility && rightFacility.type !== 'direct'
        ? g.outOuterS - rightFacility.data.bundleWidth - (rightFacility.data.separation || 0) - 0.22
        : g.outOuterS - 0.22;
      scene.guardrails.push(guardrailAlongArm(g, rightRailStart, sideRailEnd, rightRailLateral, 0.12, 0.82));
    }

    // stop line
    if (arm.laneIn > 0) {
      const s0 = -(g.medW / 2), s1 = -(g.medW / 2 + arm.laneIn * g.laneW);
      scene.stopLines.push([g.wp(stopU, s0), g.wp(stopU, s1)]);
    }

    // crosswalk
    if (state.showCrosswalk && hasCrosswalkSpace && (arm.laneIn > 0 || arm.laneOut > 0)) {
      const sMin = g.outOuterS, sMax = g.inOuterS;
      const bars = [];
      const stripeW = 0.5, gap = 0.45;
      let s = sMin + stripeW / 2 + 0.3;
      while (s < sMax - 0.3) {
        bars.push([g.wp(crosswalkStart, s), g.wp(crosswalkEnd, s)]);
        s += stripeW + gap;
      }
      scene.crosswalks.push({ bars });
    }

    // arrows from the lane->movement sets (single source of truth)
    if (state.showArrows && arm.laneIn > 0) {
      const movementSets = armLaneMovementSets(arm, model.availPerArm[i], leftTargets[i], rightTargets[i]);
      const uTip = stopU + 1.3;
      const uTail = Math.min(uTip + 3.4, cfg.armLength - 0.8);
      if (uTail - uTip > 1.5) {
        for (let k = 0; k < arm.laneIn; k += 1) {
          const s = -(g.medW / 2 + (k + 0.5) * g.laneW);
          const pts = arrowOnArm(g, uTail, uTip, s, [...movementSets[k]]);
          scene.arrows.push({ armIndex: i, laneIndex: k, pts });
        }
      }
    }

    // waiting areas
    if (state.showWaitingAreas && state.showLights && arm.laneIn > 0) {
      if (arm.waitingArea === 'left') {
        const dedicatedLeftLanes = leftTurnCapacity(arm, leftTargets[i]);
        if (dedicatedLeftLanes > 0) {
          const opposingIndex = straightTargets[i] ? geoms.indexOf(straightTargets[i]) : -1;
          const opposingG = opposingIndex >= 0 ? geoms[opposingIndex] : null;
          const opposingLeftLanes = opposingG
            ? opposingLeftLaneCapacity(opposingG, leftTargets[opposingIndex])
            : 0;
          const wa = leftWaitingAreas(g, leftTargets[i], opposingG, waitingAreaStartU, dedicatedLeftLanes, cfg, random, opposingLeftLanes);
          if (wa) {
            scene.waitingAreas.push({
              type: 'left', left: wa.strips[0].left, right: wa.strips[0].right,
              dashes: wa.dashes, arrows: wa.arrows,
            });
          }
        }
      } else if (arm.waitingArea === 'straight') {
        const movementSets = armLaneMovementSets(arm, model.availPerArm[i], leftTargets[i], rightTargets[i]);
        const straightOnly = movementSets
          .map((set, lane) => ({ set, lane }))
          .filter(({ set }) => set.size === 1 && set.has('straight'))
          .map(({ lane }) => lane);
        if (straightOnly.length) {
          const wa = straightWaitingArea(g, waitingAreaStartU, straightOnly[0], straightOnly.at(-1), cfg);
          if (wa) {
            scene.waitingAreas.push({
              type: 'straight', left: wa.left, right: wa.right,
              dashes: wa.dashes, arrows: wa.arrows,
            });
          }
        }
      }
    }
  });

  // ---- central polygon + corner fillets ----
  const filletPts = buildCornerFillets(geoms, cfg);
  const centerPoly = [];
  for (let i = 0; i < n; i += 1) {
    centerPoly.push(geoms[i].nearRight, geoms[i].nearLeft, ...filletPts[i]);
  }
  scene.roadSurfaces.push(centerPoly);

  // ---- curb + sidewalk strips per gap ----
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    const gi = geoms[i], gj = geoms[j];
    const rightFacility = rightFacilities[j];
    const d = rightFacility && rightFacility.type !== 'direct' ? rightFacility.data : null;
    const bypassesCorner = d && rightFacility.target === gi;
    // The sidewalk strip is derived from the road's outer curb line (pavement
    // boundary), never drawn as its own shape: whichever carriageway hugs this
    // corner - the fillet, or a channelized branch that curves around it - is the
    // single source the curb follows, so any change to the road shape (curve,
    // width, merge/split position) propagates to the sidewalk automatically.
    const path = bypassesCorner
      ? [
          ...edgeLine(gi, cfg.armLength, d.targetMergeU, gi.inOuterS, 3),
          ...d.outerBoundary.slice().reverse(),
          ...edgeLine(gj, d.splitU, cfg.armLength, gj.outOuterS - (d.separation || 0), 3),
        ]
      : [gi.farLeft, gi.nearLeft, ...filletPts[i], gj.nearRight, gj.farRight];
    if (state.showSidewalk) scene.sidewalks.push({ path, width: state.sidewalkWidth, offset: 0.32 + state.sidewalkWidth / 2 });
    for (let k = 0; k < path.length - 1; k += 1) scene.curbs.push([path[k], path[k + 1]]);
  }

  // ---- right-turn facilities ----
  geoms.forEach((g, i) => {
    const facility = rightFacilities[i];
    if (!facility) return;
    const fd = rightTurnFacilityData(facility, g, facility.target, cfg);
    if (!fd) return;
    if (fd.surface) scene.branchSurfaces.push({ pts: fd.surface });
    fd.dividers.forEach((div) => scene.branchDividers.push(div));
    scene.guideAreas.push({ pts: fd.guidePoly, planted: g.arm.rightTurnIsland === 'planted' });
    fd.guideChevronLegs.forEach((leg) => scene.guideChevrons.push(leg));
    fd.arrows.forEach((pts) => scene.arrows.push({ armIndex: i, laneIndex: -1, pts, onBranch: true }));

    // right-turn branch crossing + yield markings
    const total = polylineLength(facility.data.lanePaths[0]);
    if (total >= 8 && state.showCrosswalk) {
      const crossingPose = pointAndTangentAtDistance(facility.data.lanePaths[0], total * 0.78);
      if (crossingPose) {
        const normal = v2(-crossingPose.tangent.y, crossingPose.tangent.x);
        for (let k = -1; k <= 2; k += 1) {
          const center = add(crossingPose.point, scl(crossingPose.tangent, k * 0.62));
          scene.branchCrossings.push([
            add(center, scl(normal, -g.laneW * 0.5)),
            add(center, scl(normal, g.laneW * 0.5)),
          ]);
        }
      }
    }
    const yieldPose = total >= 8 ? pointAndTangentAtDistance(facility.data.lanePaths[0], total * 0.9) : null;
    if (yieldPose) {
      const normal = v2(-yieldPose.tangent.y, yieldPose.tangent.x);
      scene.branchYieldLines.push([
        add(yieldPose.point, scl(normal, -g.laneW * 0.5)),
        add(yieldPose.point, scl(normal, g.laneW * 0.5)),
      ]);
    }
  });

  // ---- traffic lights ----
  if (state.showLights) {
    geoms.forEach((g) => {
      if (g.arm.laneIn <= 0) return;
      const pos = g.wp(g.R + 0.6, g.outOuterS - 1.1);
      scene.trafficLights.push({ pos, heading: Math.atan2(g.fwd.x, g.fwd.y) });
    });
  }

  // ---- street lamps at outer fillet apex points ----
  for (let i = 0; i < n; i += 1) {
    const pts = filletPts[i];
    if (!pts.length) continue;
    const apex = pts[Math.floor(pts.length / 2)];
    const dirOut = len(apex) > 0.01 ? scl(apex, 1 / len(apex)) : v2(1, 0);
    const lp = add(apex, scl(dirOut, 1.6 + state.sidewalkWidth * 0.6));
    scene.streetLamps.push({ pos: lp, dir: dirOut });
  }

  // ---- buildings + trees scattered outside the road envelope ----
  if (state.showBuildings) scatterScenery(scene, geoms, cfg, state, random);

  return scene;
}

// Buildings + trees rejection-placed outside every road's carriageway envelope.
function scatterScenery(scene, geoms, cfg, state, random) {
  const blocked = (p) => {
    for (const g of geoms) {
      const u = p.x * g.fwd.x + p.y * g.fwd.y;
      const s = p.x * g.left.x + p.y * g.left.y;
      if (u > -6 && u < cfg.armLength + 14 && Math.abs(s) < Math.max(g.inOuterS, -g.outOuterS) + 7 + state.sidewalkWidth) return true;
    }
    return false;
  };
  const buildingColors = [0x6b6f76, 0x7a6a5c, 0x5c6a78, 0x716357, 0x60686f];
  let placed = 0, tries = 0;
  while (placed < 12 && tries < 400) {
    tries += 1;
    const ang = random() * Math.PI * 2;
    const rad = cfg.armLength + 10 + random() * 45;
    const p = v2(Math.cos(ang) * rad, Math.sin(ang) * rad);
    if (blocked(p)) continue;
    const w = 5 + random() * 9, d = 5 + random() * 9, h = 4 + random() * 22;
    scene.buildings.push({ pos: p, w, d, h, rot: random() * Math.PI * 2, color: buildingColors[Math.floor(random() * buildingColors.length)] });
    placed += 1;
  }
  let tPlaced = 0, tTries = 0;
  while (tPlaced < 16 && tTries < 300) {
    tTries += 1;
    const ang = random() * Math.PI * 2;
    const rad = cfg.armLength * 0.55 + random() * (cfg.armLength * 0.6);
    const p = v2(Math.cos(ang) * rad, Math.sin(ang) * rad);
    if (blocked(p)) continue;
    scene.trees.push({ pos: p });
    tPlaced += 1;
  }
}

// ---------------------------------------------------------------------------
// Roundabout node derivation.
//
// Every approach is a forked Y: the stem carries the full two-way section out
// to the fork, the exit branch peels off the ring tangentially and the entry
// branch merges on the tangent too. The splitter island is not a placed shape
// - it is exactly the wedge the Y leaves against the seam circle. Branch
// surfaces sit a hair above stems/annulus so their overlaps layer cleanly.
// ---------------------------------------------------------------------------

// CCW arc polyline on the origin circle between two absolute angles.
function arcPath(radius, angleFrom, angleTo) {
  const count = Math.max(6, Math.ceil(Math.abs(angleTo - angleFrom) / 0.12));
  const pts = [];
  for (let k = 0; k <= count; k += 1) {
    const a = angleFrom + (angleTo - angleFrom) * k / count;
    pts.push(v2(radius * Math.cos(a), radius * Math.sin(a)));
  }
  return pts;
}

// Wrap `angle` into (reference - PI, reference + PI]. atan2 returns values in
// (-PI, PI], so features near the branch cut (an arm pointing at 180 deg)
// otherwise unwrap the wrong way and draw arcs around the whole map.
function unwrapAround(angle, reference) {
  while (angle <= reference - Math.PI) angle += Math.PI * 2;
  while (angle > reference + Math.PI) angle -= Math.PI * 2;
  return angle;
}

function interpolateBoundary(first, second, ratio) {
  const count = Math.min(first.length, second.length);
  return Array.from({ length: count }, (_, index) => lerp2(first[index], second[index], ratio));
}

function addPolylineSegments(target, path) {
  for (let index = 0; index < path.length - 1; index += 1) target.push([path[index], path[index + 1]]);
}

export function deriveRoundaboutScene(model, state, random = Math.random) {
  const { geoms, roundabout } = model;
  if (!roundabout) throw new Error('roundabout scene requires a roundabout road model');
  const cfg = model.cfg;
  const n = geoms.length;
  const scene = createEmptyScene();
  const coreR = roundabout.inscribedR;
  const armSlots = roundaboutArmSlots(geoms.map((g) => g.arm.angle));
  const approaches = geoms.map((g, index) => roundaboutApproach({
    angleDeg: g.arm.angle,
    coreR,
    laneWidth: g.laneW,
    laneIn: g.arm.laneIn,
    laneOut: g.arm.laneOut,
    medW: g.medW,
    targetFootIn: armSlots[index].footIn,
    targetFootOut: armSlots[index].footOut,
    forkReach: Math.min(
      Math.max(coreR * 0.42, Math.max(g.arm.laneIn, g.arm.laneOut) * g.laneW * 0.7 + 2),
      Math.max(4, cfg.armLength - coreR - 3),
    ),
  }));

  approaches.forEach((ap, i) => {
    const g = geoms[i];
    const arm = g.arm;
    if (arm.laneIn <= 0 && arm.laneOut <= 0) return;
    const entryOuterS = g.medW / 2 + arm.laneIn * g.laneW;
    const exitOuterS = -(g.medW / 2 + arm.laneOut * g.laneW);

    // stem quad from the fork outward (full two-way section)
    scene.roadSurfaces.push([
      ap.frame.wp(ap.forkU, entryOuterS), g.wp(cfg.armLength, entryOuterS),
      g.wp(cfg.armLength, exitOuterS), ap.frame.wp(ap.forkU, exitOuterS),
    ]);
    // Explicit boundary strips keep every branch full-width through the Y.
    // They are rendered as paired strips instead of one dense polygon so the
    // triangulator cannot bridge across a curved concave mouth.
    if (arm.laneIn > 0) {
      scene.roadSurfaces.push({ pts: ap.entrySurface.ring, strips: ap.entrySurface.strips, y: 0.0105 });
      addPolylineSegments(scene.laneEdges, ap.entryOuter);
      for (let lane = 1; lane < arm.laneIn; lane += 1) {
        pathDashes(interpolateBoundary(ap.entryOuter, ap.entryInner, lane / arm.laneIn), {
          dashLen: 1.2, gapLen: 1.0,
        }).forEach((segment) => scene.laneDashes.push(segment));
      }
    }
    if (arm.laneOut > 0) {
      scene.roadSurfaces.push({ pts: ap.exitSurface.ring, strips: ap.exitSurface.strips, y: 0.0105 });
      addPolylineSegments(scene.laneEdges, ap.exitOuter);
      for (let lane = 1; lane < arm.laneOut; lane += 1) {
        pathDashes(interpolateBoundary(ap.exitOuter, ap.exitInner, lane / arm.laneOut), {
          dashLen: 1.2, gapLen: 1.0,
        }).forEach((segment) => scene.laneDashes.push(segment));
      }
    }

    // Compact splitter island between the Y branches; its rounded nose stays
    // outside the annulus so it cannot become a giant triangular overlay.
    if (arm.laneIn > 0 && arm.laneOut > 0) {
      scene.guideAreas.push({
        pts: forkIslandPolygon({
          entryInner: ap.entryInner,
          exitInner: ap.exitInner,
          coreR,
          theta: ap.theta,
          forkU: ap.forkU,
          medW: g.medW,
        }),
        planted: true,
      });
    }

    const facilityStart = ap.forkU + 0.5;
    const medianStartU = ap.forkU + 0.4;

    // center separation on the approach (identical rules to cross nodes)
    if (arm.centerMode === 'planted' && g.medW > 0.15) {
      const top = medianIslandTop(g, medianStartU, cfg);
      if (top) scene.medianIslands.push(top);
    } else if (arm.laneIn > 0 && arm.laneOut > 0
        && (arm.centerMode === 'doubleYellow' || arm.centerMode === 'doubleYellowRail')) {
      scene.yellowLines.push([g.wp(facilityStart, 0.1), g.wp(cfg.armLength, 0.1)]);
      scene.yellowLines.push([g.wp(facilityStart, -0.1), g.wp(cfg.armLength, -0.1)]);
      if (arm.centerMode === 'doubleYellowRail') {
        scene.guardrails.push(guardrailAlongArm(g, facilityStart + 0.7, cfg.armLength - 0.7, 0, 0.02, 0.78));
      }
    }

    // longitudinal lane lines + outer edge lines on the stem
    const drawLaneLines = (count, sign) => {
      for (let k = 1; k < count; k += 1) {
        const s = sign * (g.medW / 2 + k * g.laneW);
        armDashes(g, ap.forkU + 1.0, cfg.armLength - 1, s, cfg).forEach((seg) => scene.laneDashes.push(seg));
      }
      if (count > 0) {
        const sOuter = sign * (g.medW / 2 + count * g.laneW - 0.1);
        scene.laneEdges.push([g.wp(ap.forkU + 0.4, sOuter), g.wp(cfg.armLength, sOuter)]);
      }
    };
    drawLaneLines(arm.laneIn, 1);
    drawLaneLines(arm.laneOut, -1);

    // side guardrails on the stem
    const sideRailStart = ap.forkU + 1.0;
    const sideRailEnd = cfg.armLength - 0.7;
    if (arm.leftGuardrail) {
      scene.guardrails.push(guardrailAlongArm(g, sideRailStart, sideRailEnd, entryOuterS + 0.22, 0.12, 0.82));
    }
    if (arm.rightGuardrail) {
      scene.guardrails.push(guardrailAlongArm(g, sideRailStart, sideRailEnd, exitOuterS - 0.22, 0.12, 0.82));
    }

    // street lamp just past the island's blunt outer end
    if (arm.laneIn > 0 || arm.laneOut > 0) {
      const dirOut = ap.frame.fwd;
      scene.streetLamps.push({
        pos: scl(dirOut, ap.forkU + 1.8 + state.sidewalkWidth * 0.6),
        dir: dirOut,
      });
    }
  });

  // circulating carriageway + central island
  annulusSectorQuads({ x: 0, y: 0 }, roundabout.islandR, coreR, 64)
    .forEach((quad) => scene.roadSurfaces.push(quad));
  scene.medianIslands.push(circlePolygon({ x: 0, y: 0 }, roundabout.islandR, 64));

  // ---- entry semantics: yield line + give-way triangle + flow arrow ----
  geoms.forEach((g, i) => {
    const arm = g.arm;
    const ap = approaches[i];
    if (arm.laneIn <= 0) return;

    // Dashed give-way line crosses the full, constant-width entry bundle at
    // its allocated slot. With a tangent mouth the two edges differ radially,
    // not angularly, so an arc would collapse to a tiny mark.
    const entry = { armIndex: i, dashes: [], legs: [] };
    const yieldIndex = Math.max(2, Math.floor((ap.entryOuter.length - 1) * 0.82));
    entry.dashes = pathDashes([
      ap.entryOuter[yieldIndex], ap.entryInner[yieldIndex],
    ], { dashLen: 0.9, gapLen: 0.7 });

    // give-way triangle beside the entry branch, apex pointing at the island
    const total = polylineLength(ap.entryPath);
    const pose = pointAndTangentAtDistance(ap.entryPath, Math.max(1, total - ap.halfIn - 1.4));
    if (pose) {
      const t = pose.tangent;
      const leftN = { x: -t.y, y: t.x };
      const centre = add(pose.point, scl(leftN, ap.halfIn + 1.05));
      const apex = add(centre, scl(leftN, 0.85));
      const b1 = add(centre, scl(t, 0.42));
      const b2 = add(centre, scl(t, -0.42));
      entry.legs.push([b1, b2], [b1, apex], [b2, apex]);
    }
    scene.entryMarks.push(entry);

    // circulating flow arrow downstream of the entry mouth
    const midC = coreR - roundabout.circWidth * 0.32;
    const flowArc = arcPath(midC, unwrapAround(ap.footOut + 0.14, ap.theta), unwrapAround(ap.footOut + 0.62, ap.theta));
    const flowPts = arrowOnPath(flowArc, ['straight']);
    if (flowPts.length) scene.arrows.push({ armIndex: i, laneIndex: -1, pts: flowPts, onBranch: true });
  });

  // Angular gaps between consecutive branch mouths, shared by ring markings
  // and the sidewalk wrap.
  const GAP_MARGIN = 0.05;
  const gapSpans = [];
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    let from = approaches[i].exitOuterFoot;
    let to = approaches[j].entryOuterFoot;
    while (to <= from) to += Math.PI * 2;
    gapSpans.push({ from: from + GAP_MARGIN, to: to - GAP_MARGIN });
  }

  // Circulating lane dividers stay continuous around the ring. The branch
  // ribbons merge underneath them; keeping the circles visible makes every
  // radial target segment read as a real graft instead of one undifferentiated
  // asphalt disk.
  const circLanes = roundabout.circLanes
    || Math.max(1, Math.floor((coreR - roundabout.islandR - 0.4) / state.laneWidth));
  const ringWidth = coreR - roundabout.islandR;
  for (let k = 1; k < circLanes; k += 1) {
    const rDivider = roundabout.islandR + ringWidth * k / circLanes;
    pathDashes(arcPath(rDivider, 0, Math.PI * 2), { dashLen: 1.0, gapLen: 1.0 })
      .forEach((seg) => scene.laneDashes.push(seg));
  }

  // pedestrian crossings across each stem behind the fork
  if (state.showCrosswalk) {
    geoms.forEach((g, i) => {
      const arm = g.arm;
      if (arm.laneIn <= 0 && arm.laneOut <= 0) return;
      const startU = approaches[i].forkU + 1.2;
      const depth = Math.min(3.2, cfg.armLength - startU - 2);
      if (depth < 1.4 || startU <= coreR) return;
      const sMin = -(g.medW / 2 + arm.laneOut * g.laneW);
      const sMax = g.medW / 2 + arm.laneIn * g.laneW;
      const bars = [];
      const stripeW = 0.5, gap = 0.45;
      const islandHalf = 1.0 + 0.35;
      let s = sMin + stripeW / 2 + 0.3;
      while (s < sMax - 0.3) {
        if (Math.abs(s) >= islandHalf) {
          bars.push([g.wp(startU, s), g.wp(startU + depth, s)]);
        }
        s += stripeW + gap;
      }
      if (bars.length) scene.crosswalks.push({ bars });
    });
  }

  // Do not wrap isolated sidewalk arcs around the outside of the roundabout.
  // They form four detached concentric bands between approaches and read as an
  // unintended extra lane. Approach curbs remain on the straight stems.
  geoms.forEach((g, i) => {
    const arm = g.arm;
    const ap = approaches[i];
    if (arm.laneIn <= 0 && arm.laneOut <= 0) return;
    [[g.medW / 2 + arm.laneIn * g.laneW, arm.laneIn > 0],
      [-(g.medW / 2 + arm.laneOut * g.laneW), arm.laneOut > 0]].forEach(([s, has]) => {
      if (!has) return;
      scene.curbs.push([ap.frame.wp(ap.forkU + 0.2, s), g.wp(cfg.armLength, s)]);
    });
  });

  if (state.showBuildings) scatterScenery(scene, geoms, cfg, state, random);

  return scene;
}
