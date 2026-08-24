// Right-turn lane/facility path generation (pure geometry, no THREE).
//
// This module owns the *data* for right-turn connectors: where a dedicated
// right-turn branch splits off the source carriageway and merges back into the
// target carriageway, plus the lane centreline paths. The renderer in main.js
// turns this data into meshes. Keeping generation here lets the same diverge/
// merge logic be reused (right-turn lanes today, interchange ramps later).

import {
  add, scl, sub, len, clamp,
  appendCubic2, offsetLanePaths, offsetPolyline, edgeLine, fillet,
} from './geometry.js';

export function computeRightTurnLayout({ fromRadius, targetRadius, armLength, laneWidth, stopU: externalStopU }) {
  const safeLength = Math.max(12, Number(armLength) || 12);
  const safeLaneWidth = clamp(Number(laneWidth) || 3.25, 2.6, 4.2);
  const fromR = Math.max(0, Number(fromRadius) || 0);
  const targetR = Math.max(0, Number(targetRadius) || 0);
  const cornerU = Math.min(safeLength - 5, Math.max(fromR, targetR) + 3.2);
  const crosswalkStart = fromR + 0.5;
  const crosswalkDepth = Math.min(3.6, Math.max(2.8, safeLaneWidth * 0.95 + 0.4));
  const crosswalkEnd = Math.min(crosswalkStart + crosswalkDepth, safeLength - 1.8);
  const hasCrosswalkSpace = crosswalkEnd - crosswalkStart > 1.2;
  const stopU = Number.isFinite(externalStopU) ? externalStopU
    : (hasCrosswalkSpace ? crosswalkEnd + 1.8 : fromR + 0.45);
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
// `type` is one of 'direct' | 'split' | 'slip'. `rightTurnMode` (lane scheme)
// decides whether the branch reuses the mainline's outer inbound lane
// ('dedicated' / 方案1) or diverges as an *additional* independent branch lane
// beyond the mainline's outer through lane ('branch' / 方案2). The latter keeps
// every mainline lane going straight and peels a separate right-turn lane off to
// one side, so the two schemes truly generate different layouts.
export function buildRightTurnPathData(fromG, toG, type, laneCount, { armLength, rightTurnMode }) {
  if (!fromG || !toG || laneCount < 1) return null;
  // Scheme 2 adds the branch's own lane outward beyond the mainline's outer
  // through lane (away from the median), so the wheel diverges as a distinct
  // visible lane while the outer through lane keeps running straight. Scheme 1
  // reuses the outer inbound lane (no extra offset).
  const separation = rightTurnMode === 'branch' ? laneCount * fromG.laneW : 0;
  if (type === 'direct') {
    // A direct connector reuses the mainline's outer lane, so the branch scheme
    // cannot express an independent diverge here; keep the lane-level semantics
    // (arrow/centreline) but no separate pavement.
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
  // The branch is a lane: its centreline connects to the pre-split dedicated
  // lane's centreline (bundle centre), not to the mainline's outer boundary.
  // Pavement is derived from that centreline by offsetting the lane width.
  // In scheme 2 the branch centreline sits one full lane past the mainline's
  // outer edge so it reads as an independent diverging lane.
  const sourceAnchor = fromG.wp(splitU, fromG.outOuterS + bundleWidth / 2 - separation);
  const targetAnchor = toG.wp(targetMergeU, toG.inOuterS - bundleWidth / 2);
  const turnChord = len(sub(targetAnchor, sourceAnchor));
  if (turnChord < 2) return null;
  // One continuously curved split connector: start tangent runs parallel to the
  // mainline (toward the core), end tangent runs parallel to the target arm
  // (departing). A single cubic Bézier holds both end tangents while turning
  // smoothly midway, replacing the old "straight run + arc" hard join.
  const handle = Math.min(24, Math.max(3.5, turnChord * 0.38));
  const startDir = { x: -fromG.fwd.x, y: -fromG.fwd.y };
  const c1 = add(sourceAnchor, scl(startDir, handle));
  const c2 = add(targetAnchor, scl(toG.fwd, -handle));
  const path = [sourceAnchor];
  appendCubic2(path, sourceAnchor, c1, c2, targetAnchor, 48);
  // The branch keeps a constant lane width along its whole centreline. The
  // channelized gore island (guide triangle) separates it from the through road
  // at the split, so the pavement never tapers to a needle nose.
  const sourceTaperEnd = Math.max(2, Math.round(path.length * 0.32));
  const offsets = offsetPolyline(path, bundleWidth / 2);
  // Guide island (导流区) = the closed region between the right-turn lane and the
  // intersection corner, bounded by four edges:
  //   - the lane's left line        = the branch's inner edge (offsets.right)
  //   - part of the inbound through edge on the source arm
  //   - part of the outbound through edge on the target arm
  //   - a smooth corner curve joining the two through edges around the corner
  // The two arm edges and the corner together form the "intersection" side, and
  // the loop closes at the split (gore) and where the branch re-joins the target.
  const sIn = fromG.outOuterS + bundleWidth - separation;   // branch/through boundary on the source arm
  const sOut = toG.inOuterS - bundleWidth;     // merge boundary on the target arm
  const guideBranch = offsets.right;                          // source split -> target merge
  const guideViaOut = edgeLine(toG, targetMergeU, toG.R, sOut, 3);    // merge -> target corner
  const guideCorner = fillet(toG.wp(toG.R, sOut), scl(toG.fwd, -1), fromG.wp(fromG.R, sIn), fromG.fwd, 14); // smooth corner
  const guideViaIn = edgeLine(fromG, fromG.R, splitU, sIn, 3);         // source corner -> split
  const guidePoly = [
    ...guideBranch,
    ...guideViaOut,
    toG.wp(toG.R, sOut),
    ...guideCorner,
    fromG.wp(fromG.R, sIn),
    ...guideViaIn,
  ];
  return {
    type, path, offsets, lanePaths: offsetLanePaths(path, laneCount, laneW),
    sourceAnchor, targetAnchor, sourceTaperEnd, turnEnd: offsets.right.length - 1,
    outerBoundary: offsets.left, innerBoundary: offsets.right,
    guidePoly,
    guideInner: offsets.right, guideApex: offsets.right[0],
    splitU, turnU, targetMergeU, bundleWidth, sourceTaperEnd,
    separation,
  };
}