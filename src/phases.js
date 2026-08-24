// Signal phase planning (pure data, no THREE, no global state).
//
// A phase grants right-of-way to a set of (approach, movement) pairs. The
// planner groups approaches into rings of roughly opposing arms, so the
// classic two-phase crossroads falls out naturally while any 2-8 arm topology
// still gets a valid sequential plan (odd counts simply produce single-arm
// phases).
//
// Channel mapping used by lamp heads:
//   movement 'left'            -> channel 'left'
//   'straight' / 'right'       -> channel 'through'

const OPPOSITE_THRESHOLD_DEG = 120;

export const SIGNAL_TIMING = { green: 6.5, yellow: 1.2, allRed: 0.6 };
const MOVEMENTS = ['left', 'straight', 'right'];

function angularDistance(a, b) {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180);
}

// approaches: [{ index, angle, laneIn, movements: string[] }] — approaches with
// laneIn > 0 only. Returns { phases, cycleTime } where each phase is
// { movements: [{ index, type }], green, yellow, allRed }.
export function buildSignalPlan({ approaches }) {
  const armed = (approaches || [])
    .filter((a) => a.laneIn > 0 && a.movements.length)
    .slice()
    .sort((a, b) => a.angle - b.angle);

  const phases = [];
  const assigned = new Set();
  for (const seed of armed) {
    if (assigned.has(seed.index)) continue;
    const ring = armed.filter((a) => !assigned.has(a.index)
      && (a === seed || angularDistance(a.angle, seed.angle) > OPPOSITE_THRESHOLD_DEG));
    ring.forEach((a) => assigned.add(a.index));
    const movements = [];
    ring.forEach((a) => {
      MOVEMENTS.forEach((type) => {
        if (a.movements.includes(type)) movements.push({ index: a.index, type });
      });
    });
    if (movements.length) {
      phases.push({ movements, ...SIGNAL_TIMING });
    }
  }

  const cycleTime = phases.reduce((sum, p) => sum + p.green + p.yellow + p.allRed, 0);
  return { phases, cycleTime };
}

const CHANNEL_OF = { left: 'left', straight: 'through', right: 'through' };

// Resolve the lamp state for every (approach, channel) at time t (seconds,
// unscaled). Returns Map `${index}|${channel}` -> 'green' | 'yellow'; missing
// keys mean red.
export function phaseStateAt(plan, t) {
  const states = new Map();
  if (!plan || !plan.phases.length || !(plan.cycleTime > 0)) return states;
  let remaining = ((t % plan.cycleTime) + plan.cycleTime) % plan.cycleTime;
  for (const phase of plan.phases) {
    const segments = [
      ['green', phase.green],
      ['yellow', phase.yellow],
      ['allRed', phase.allRed],
    ];
    for (const [name, duration] of segments) {
      if (remaining < duration) {
        if (name !== 'allRed') {
          phase.movements.forEach(({ index, type }) => {
            states.set(`${index}|${CHANNEL_OF[type]}`, name);
          });
        }
        return states;
      }
      remaining -= duration;
    }
  }
  return states;
}
