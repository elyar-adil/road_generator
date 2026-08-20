// Right-turn lane/facility path generation (pure geometry, no THREE).
//
// This module owns the *data* for right-turn connectors: where a dedicated
// right-turn branch splits off the source carriageway and merges back into the
// target carriageway, plus the lane centreline paths. The renderer in main.js
// turns this data into meshes. Keeping generation here lets the same diverge/
// merge logic be reused (right-turn lanes today, interchange ramps later).

import {
  add, scl, sub, len, lerp2, clamp,
  appendCubic2, lineIntersect, offsetLanePaths, taperedOffsetPath,
} from './geometry.js';

export function computeRightTurnLayout({ fromRadius, targetRadius, armLength, laneWidth }) {
  const safeLength = Math.max(12, Number(armLength) || 12);
  const safeLaneWidth = clamp(Number(laneWidth) || 3.25, 2.6, 4.2);
  const fromR = Math.max(0, Number(fromRadius) || 0);
  const targetR = Math.max(0, Number(targetRadius) || 0);
  const cornerU = Math.min(safeLength - 5, Math.max(fromR, targetR) + 3.2);
  const crosswalkStart = fromR + 0.7;
  const crosswalkEnd = Math.min(fromR + 4.2, safeLength - 1.8);
  const hasCrosswalkSpace = crosswalkEnd - crosswalkStart > 1.2;
  const stopU = hasCrosswalkSpace ? crosswalkEnd + 0.45 : fromR + 0.45;
  const nearSplitU = Math.min(safeLength - 2, stopU + Math.max(12.5, safeLaneWidth * 3.8));
  const slipSplitU = Math.min(safeLength - 1.1, nearSplitU + Math.max(5.5, safeLaneWidth * 1.7));
  const targetMergeU = Math.min(safeLength - 1.1, cornerU + Math.max(18, safeLaneWidth * 5.5));
  const turnU = Math.max(cornerU, Math.min(
    safeLength - 2.5,
    cornerU + Math.max(7.5, safeLaneWidth * 2.4),
    nearSplitU - Math.max(5, safeLaneWidth * 1.5),
    targetMergeU - Math.max(6, safeLaneWidth * 1.8),
  ));
  return { cornerU, turnU, stopU, nearSplitU, slipSplitU, splitU: nearSplitU, targetMergeU };
}

function rightTurnLaneCenter(g, laneIndex, direction) {
  return direction === 'source'
    ? g.outOuterS + (laneIndex + 0.5) * g.laneW
    : g.inOuterS - (laneIndex + 0.5) * g.laneW;
}

function buildDirectRightTurnPath(fromG, toG, laneIndex) {
  const start = fromG.wp(fromG.R + 0.15, rightTurnLaneCenter(fromG, laneIndex, 'source'));
  const end = toG.wp(toG.R + 0.15, rightTurnLaneCenter(toG, laneIndex, 'target'));
  const chord = len(sub(end, start));
  if (chord < 1.5) return null;
  const handle = Math.min(12, Math.max(3.2, chord * 0.34));
  const path = [start];
  appendCubic2(
    path,
    start, add(start, scl(fromG.fwd, -handle)),
    add(end, scl(toG.fwd, -handle)), end, 14,
  );
  return path;
}

// Data for a dedicated right-turn connector from arm `fromG` to arm `toG`.
// `type` is one of 'direct' | 'split' | 'slip'.
export function buildRightTurnPathData(fromG, toG, type, laneCount, { armLength }) {
  if (!fromG || !toG || laneCount < 1) return null;
  if (type === 'direct') {
    const lanePaths = Array.from({ length: laneCount }, (_, laneIndex) =>
      buildDirectRightTurnPath(fromG, toG, laneIndex)).filter(Boolean);
    return lanePaths.length === laneCount ? { type, lanePaths } : null;
  }

  const laneW = fromG.laneW;
  const bundleWidth = laneW * laneCount;
  const { turnU, nearSplitU, slipSplitU, targetMergeU } = computeRightTurnLayout({
    fromRadius: fromG.R,
    targetRadius: toG.R,
    armLength,
    laneWidth: laneW,
  });
  const splitU = type === 'slip' ? slipSplitU : nearSplitU;
  const sourceAnchor = fromG.wp(splitU, fromG.outOuterS);
  const sourceNear = fromG.wp(turnU, fromG.outOuterS - bundleWidth / 2);
  const targetNear = toG.wp(turnU, toG.inOuterS - bundleWidth / 2);
  const targetAnchor = toG.wp(targetMergeU, toG.inOuterS - bundleWidth / 2);
  const turnChord = len(sub(sourceNear, targetNear));
  if (turnChord < 2) return null;
  const turnHandle = Math.min(18, Math.max(4.5, turnChord * 0.39));
  const sourceHandle = Math.min(10, Math.max(3, len(sub(sourceAnchor, sourceNear)) * 0.42));
  const path = [sourceAnchor];
  appendCubic2(
    path,
    sourceAnchor, add(sourceAnchor, scl(fromG.fwd, -sourceHandle)),
    add(sourceNear, scl(fromG.fwd, sourceHandle)), sourceNear, 8,
  );
  const sourceTaperEnd = path.length - 1;
  appendCubic2(
    path,
    sourceNear, add(sourceNear, scl(fromG.fwd, -turnHandle)),
    add(targetNear, scl(toG.fwd, -turnHandle)), targetNear, 14,
  );
  const turnEnd = path.length - 1;
  for (let index = 1; index <= 6; index += 1) path.push(lerp2(targetNear, targetAnchor, index / 6));
  const offsets = taperedOffsetPath(path, bundleWidth / 2, (i) => Math.min(1, i / sourceTaperEnd));
  const guideInner = offsets.right.slice(sourceTaperEnd, turnEnd + 1);
  const guideApex = lineIntersect(
    guideInner[0], add(guideInner[0], scl(fromG.fwd, -1)),
    guideInner[guideInner.length - 1], add(guideInner[guideInner.length - 1], scl(toG.fwd, -1)),
  ) ?? lerp2(guideInner[0], guideInner[guideInner.length - 1], 0.5);
  return {
    type, path, offsets, lanePaths: offsetLanePaths(path, laneCount, laneW),
    sourceAnchor, targetAnchor, sourceTaperEnd, turnEnd,
    outerBoundary: offsets.left, innerBoundary: offsets.right,
    guideInner, guideApex,
    splitU, turnU, targetMergeU, bundleWidth, sourceTaperEnd,
  };
}