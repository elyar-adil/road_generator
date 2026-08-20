import { describe, expect, it } from 'vitest';
import {
  armMovementTargets,
  computeLaneTopology,
  inboundToOutboundLane,
  laneIndicesByMovement,
} from './lane-topology.js';
import { createSeededRandom } from './state.js';

function fakeGeom(angleDeg, laneIn, laneOut, wait = 'none', right = { type: 'none' }, leftTurnLanes = 1, rightTurnMode = 'branch') {
  const a = angleDeg * Math.PI / 180;
  const fwd = { x: Math.cos(a), y: Math.sin(a) };
  const left = { x: -Math.sin(a), y: Math.cos(a) };
  const laneW = 3.25;
  const medW = 0;
  const R = 18;
  const inOuterS = medW / 2 + laneOut * laneW;
  const outOuterS = -(medW / 2 + laneIn * laneW);
  return {
    arm: { angle: angleDeg, laneIn, laneOut, waitingArea: wait, leftTurnLanes, rightTurnLane: right.type !== 'none', rightTurnType: right.type, rightTurnLanes: 1, rightTurnMode },
    fwd, left, laneW, medW, R, inOuterS, outOuterS,
    wp: (u, s) => ({ x: fwd.x * u + left.x * s, y: fwd.y * u + left.y * s }),
  };
}

// A standard 4-way crossroads (arms at 0/90/180/270). No dedicated right-turn
// lane so every movement (left/straight/right) appears.
function crossGeoms() {
  return [
    fakeGeom(0, 2, 2),
    fakeGeom(90, 2, 2),
    fakeGeom(180, 2, 2),
    fakeGeom(270, 2, 2),
  ];
}

describe('lane topology graph', () => {
  it('classifies movements in the planning plane', () => {
    const targets = armMovementTargets(crossGeoms());
    // Arm 0 (heading +x) sees 90 (left), 180 (straight), 270 (right).
    expect(targets[0].left.arm.angle).toBe(90);
    expect(targets[0].straight.arm.angle).toBe(180);
    expect(targets[0].right.arm.angle).toBe(270);
  });

  it('maps inbound to outbound lanes preserving order', () => {
    // Straight: inbound 0 -> outbound 0, inbound 1 -> outbound 1
    expect(inboundToOutboundLane(0, 2, 2, 'straight')).toBe(0);
    expect(inboundToOutboundLane(1, 2, 2, 'straight')).toBe(1);
    // Right: outer lane folds to the outermost target lane
    expect(inboundToOutboundLane(1, 2, 2, 'right')).toBe(1);
    expect(inboundToOutboundLane(0, 2, 2, 'right')).toBe(0);
  });

  it('produces straight, left and right connections across a crossroads', () => {
    const { connections } = computeLaneTopology(crossGeoms());
    const movements = new Set(connections.map((c) => c.movement));
    expect(movements.has('straight')).toBe(true);
    expect(movements.has('left')).toBe(true);
    expect(movements.has('right')).toBe(true);
    // Each arm's inbound lanes produce connections, so there are many edges.
    expect(connections.length).toBeGreaterThan(6);
    connections.forEach((c) => {
      expect(c.path.length).toBeGreaterThan(5);
      expect(Number.isFinite(c.path[0].x)).toBe(true);
      expect(Number.isFinite(c.path.at(-1).y)).toBe(true);
    });
  });

  it('groups inbound lane indices by movement', () => {
    const byMovement = laneIndicesByMovement([new Set(['left']), new Set(['straight'])]);
    expect(byMovement.get('left')).toEqual([0]);
    expect(byMovement.get('straight')).toEqual([1]);
  });

  it('makes left-turn waiting areas dedicate the median-side lanes', () => {
    const geoms = [
      fakeGeom(0, 4, 2, 'left', { type: 'none' }, 2),
      fakeGeom(90, 2, 2),
      fakeGeom(180, 2, 2),
      fakeGeom(270, 2, 2),
    ];
    const { connections } = computeLaneTopology(geoms);
    const leftConn = connections.filter((c) => c.movement === 'left' && c.fromArm === 0);
    // The two median-side inbound lanes of arm 0 turn left.
    expect(leftConn.some((c) => c.fromIndex === 0)).toBe(true);
    expect(leftConn.some((c) => c.fromIndex === 1)).toBe(true);
    const straightConn = connections.filter((c) => c.movement === 'straight' && c.fromArm === 0);
    // The outer two lanes go straight.
    expect(straightConn.map((c) => c.fromIndex).sort()).toEqual([2, 3]);
  });

  it('is deterministic for a fixed topology', () => {
    const a = computeLaneTopology(crossGeoms());
    const b = computeLaneTopology(crossGeoms());
    expect(a.connections.length).toBe(b.connections.length);
    const random = createSeededRandom(1);
    expect(random()).toBeGreaterThanOrEqual(0);
  });

  it('scheme 1: a dedicated right-turn lane gets a contiguous centreline through the branch', () => {
    const geoms = [
      fakeGeom(0, 3, 2, 'none', { type: 'split' }, 1, 'dedicated'),
      fakeGeom(90, 2, 2),
      fakeGeom(180, 2, 2),
      fakeGeom(270, 2, 2),
    ];
    // Arm 0: 3 inbound. The outermost inbound lane (index 2) is the dedicated
    // split right-turn branch; its centreline must run from the arm root,
    // through the curved branch, to the merge - connected at both ends, never
    // floating mid-air.
    const branch = Array.from({ length: 12 }, (_, k) => ({ x: 32 - k * 2, y: -6 - k * 0.6 }));
    const facilities = [
      { type: 'split', laneCount: 1, data: { lanePaths: [branch], targetMergeU: 30 } },
      null, null, null,
    ];
    const { connections, laneCenterlines } = computeLaneTopology(geoms, { facilities });

    // Scheme 1: the dedicated lane is a right-turn lane, so it has one right
    // connection at the core AND its centreline runs through the branch.
    const rightConn = connections.filter((c) => c.movement === 'right' && c.fromArm === 0);
    expect(rightConn).toHaveLength(1);
    expect(rightConn[0].fromIndex).toBe(2);

    // The dedicated lane's centreline starts at the arm root (armLength=46 on
    // the +x arm) and is contiguous through the branch.
    const inLanes = laneCenterlines.filter((cl) => cl.side === 'in' && cl.armIndex === 0);
    const dedicated = inLanes.find((cl) => cl.index === 2);
    expect(dedicated).toBeDefined();
    expect(dedicated.skip).toBe(false);
    expect(dedicated.path[0].x).toBeCloseTo(46, 6); // connected to arm root
    expect(dedicated.path).toContain(branch[0]);    // runs through the branch
    // Through lanes keep a full straight centreline from the junction.
    const through = inLanes.find((cl) => cl.index === 0);
    expect(through.path[0].x).toBeCloseTo(18.5, 6); // nearU = R(18)+0.5
    // No separate branch centreline in scheme 1: the branch IS the outer lane.
    expect(laneCenterlines.some((cl) => cl.side === 'branch' && cl.armIndex === 0)).toBe(false);
  });

  it('scheme 2: the outer lane keeps its straight centreline and the branch gets its own', () => {
    const geoms = [
      fakeGeom(0, 3, 2, 'none', { type: 'split' }, 1, 'branch'),
      fakeGeom(90, 2, 2),
      fakeGeom(180, 2, 2),
      fakeGeom(270, 2, 2),
    ];
    const branch = Array.from({ length: 12 }, (_, k) => ({ x: 32 - k * 2, y: -6 - k * 0.6 }));
    const facilities = [
      { type: 'split', laneCount: 1, data: { lanePaths: [branch], targetMergeU: 30 } },
      null, null, null,
    ];
    const { laneCenterlines } = computeLaneTopology(geoms, { facilities });

    // The outer lane is a through lane, so its centreline is straight along the
    // full arm - it never veers into the branch (no "narrowing" before the
    // guide triangle) and keeps running beyond the split point.
    const inLanes = laneCenterlines.filter((cl) => cl.side === 'in' && cl.armIndex === 0);
    const outer = inLanes.find((cl) => cl.index === 2);
    expect(outer).toBeDefined();
    expect(outer.path[0].x).toBeCloseTo(18.5, 6); // starts at nearU, not grafted
    expect(outer.path.at(-1).x).toBeCloseTo(46, 6); // reaches the arm root
    const outerS = -(0 / 2 + 2.5 * 3.25); // medW=0, lane index 2 -> s = -8.125
    outer.path.forEach((p) => expect(p.y).toBeCloseTo(outerS, 6));

    // The branch is its own lane: a centreline from the split point through
    // the curve to the merge, so the topology shows both straight and branch.
    const branchCl = laneCenterlines.filter((cl) => cl.side === 'branch' && cl.armIndex === 0);
    expect(branchCl).toHaveLength(1);
    expect(branchCl[0].path[0]).toEqual(branch[0]);       // starts at the split
    expect(branchCl[0].path.at(-1)).toEqual(branch.at(-1)); // reaches the merge
  });

  it('scheme 1 (dedicated) adds a right connection for the outermost lane', () => {
    const geoms = [
      fakeGeom(0, 3, 2, 'none', { type: 'split' }, 1, 'dedicated'),
      fakeGeom(90, 2, 2),
      fakeGeom(180, 2, 2),
      fakeGeom(270, 2, 2),
    ];
    const branch = Array.from({ length: 12 }, (_, k) => ({ x: 32 - k * 2, y: -6 - k * 0.6 }));
    const facilities = [
      { type: 'split', laneCount: 1, data: { lanePaths: [branch], targetMergeU: 30 } },
      null, null, null,
    ];
    const { connections } = computeLaneTopology(geoms, { facilities });
    // Scheme 1: the outermost inbound lane is a right-turn lane, so it gets a
    // right movement connection; scheme 2 (test above) gives it none.
    const rightConn = connections.filter((c) => c.movement === 'right' && c.fromArm === 0);
    expect(rightConn.some((c) => c.fromIndex === 2)).toBe(true);
  });

  it('scheme 2 (branch) keeps the outermost lane straight, so no right connection', () => {
    const geoms = [
      fakeGeom(0, 3, 2, 'none', { type: 'split' }, 1, 'branch'),
      fakeGeom(90, 2, 2),
      fakeGeom(180, 2, 2),
      fakeGeom(270, 2, 2),
    ];
    const branch = Array.from({ length: 12 }, (_, k) => ({ x: 32 - k * 2, y: -6 - k * 0.6 }));
    const facilities = [
      { type: 'split', laneCount: 1, data: { lanePaths: [branch], targetMergeU: 30 } },
      null, null, null,
    ];
    const { connections } = computeLaneTopology(geoms, { facilities });
    const rightConn = connections.filter((c) => c.movement === 'right' && c.fromArm === 0);
    expect(rightConn).toHaveLength(0);
    // The outer lane is a straight lane, so it keeps a straight connection.
    const straightConn = connections.filter((c) => c.movement === 'straight' && c.fromArm === 0);
    expect(straightConn.some((c) => c.fromIndex === 2)).toBe(true);
  });
});