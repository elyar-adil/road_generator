import { describe, expect, it } from 'vitest';
import { SIGNAL_TIMING, buildSignalPlan, phaseStateAt } from './phases.js';

const ALL = ['left', 'straight', 'right'];
const crossApproaches = [0, 90, 180, 270].map((angle, index) => ({
  index, angle, laneIn: 2, movements: ALL,
}));
const tJunction = [
  { index: 0, angle: 0, laneIn: 2, movements: ALL },
  { index: 1, angle: 180, laneIn: 2, movements: ALL },
  { index: 2, angle: 270, laneIn: 2, movements: ['left', 'right'] },
];

describe('signal plan builder', () => {
  it('pairs opposing arms of a crossroads into two phases', () => {
    const plan = buildSignalPlan({ approaches: crossApproaches });
    expect(plan.phases).toHaveLength(2);
    const indicesPerPhase = plan.phases.map((p) => new Set(p.movements.map((m) => m.index)));
    expect(indicesPerPhase[0].size).toBe(2);
    expect(indicesPerPhase[1].size).toBe(2);
    // Every approach appears exactly once across the cycle.
    const flat = plan.phases.flatMap((p) => p.movements.map((m) => m.index));
    expect(new Set(flat).size).toBe(4);
    // Opposite arms share a phase.
    for (const set of indicesPerPhase) {
      const angles = [...set].map((i) => crossApproaches[i].angle);
      expect(Math.abs(angles[0] - angles[1])).toBe(180);
    }
  });

  it('falls back to single-arm phases when nothing opposes', () => {
    const plan = buildSignalPlan({ approaches: tJunction });
    const flat = plan.phases.flatMap((p) => p.movements.map((m) => m.index));
    expect(new Set(flat)).toEqual(new Set([0, 1, 2]));
    // The collinear pair shares a phase.
    const first = plan.phases[0].movements.map((m) => m.index);
    expect(first).toContain(0);
    expect(first).toContain(1);
    expect(plan.cycleTime).toBeCloseTo(plan.phases.length * (SIGNAL_TIMING.green + SIGNAL_TIMING.yellow + SIGNAL_TIMING.allRed), 9);
  });

  it('ignores approaches without inbound lanes or movements', () => {
    const plan = buildSignalPlan({
      approaches: [
        ...crossApproaches,
        { index: 9, angle: 45, laneIn: 0, movements: ALL },
        { index: 10, angle: 135, laneIn: 2, movements: [] },
      ],
    });
    const flat = plan.phases.flatMap((p) => p.movements.map((m) => m.index));
    expect(flat).not.toContain(9);
    expect(flat).not.toContain(10);
  });

  it('returns an empty plan for empty input', () => {
    const plan = buildSignalPlan({ approaches: [] });
    expect(plan.phases).toHaveLength(0);
    expect(plan.cycleTime).toBe(0);
  });
});

describe('phase state timeline', () => {
  const plan = buildSignalPlan({ approaches: crossApproaches });
  const seg = SIGNAL_TIMING;

  it('shows green on the active ring and red elsewhere', () => {
    const states = phaseStateAt(plan, 1.0);
    // Keys are approach indices (crossApproaches[2] is the 180° arm).
    expect(states.get('0|through')).toBe('green');
    expect(states.get('0|left')).toBe('green');
    expect(states.get('2|left')).toBe('green');
    expect(states.has('1|through')).toBe(false); // red
  });

  it('maps straight/right to the through channel only', () => {
    const states = phaseStateAt(plan, 0.5);
    expect(states.has('0|through')).toBe(true);
    // 'left' channel exists because the left movement is in the same ring.
    expect(states.get('0|left')).toBe('green');
  });

  it('switches to yellow at the end of the phase', () => {
    const states = phaseStateAt(plan, seg.green + 0.6);
    expect(states.get('0|through')).toBe('yellow');
    expect(states.get('2|through')).toBe('yellow');
  });

  it('clears everyone during all-red', () => {
    const states = phaseStateAt(plan, seg.green + seg.yellow + 0.3);
    expect(states.size).toBe(0);
  });

  it('hands over to the second ring after the first phase', () => {
    const t = seg.green + seg.yellow + seg.allRed + 0.5;
    const states = phaseStateAt(plan, t);
    expect(states.get('1|through')).toBe('green');
    expect(states.has('0|through')).toBe(false);
  });

  it('wraps around the cycle', () => {
    const duringFirstGreen = phaseStateAt(plan, 1.0);
    const wrapped = phaseStateAt(plan, plan.cycleTime + 1.0);
    expect(wrapped.get('0|through')).toBe(duringFirstGreen.get('0|through'));
  });
});
