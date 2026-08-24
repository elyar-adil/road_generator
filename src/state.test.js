import { describe, expect, it } from 'vitest';
import {
  angleDistance,
  createDefaultProject,
  createProjectDocument,
  createSeededRandom,
  getProjectStats,
  parseProjectDocument,
  sampleIntersectionSize,
  sanitizeProject,
  validateProject,
} from './state.js';

describe('project state', () => {
  it('creates a valid default project', () => {
    const result = validateProject(createDefaultProject());
    expect(result.valid).toBe(true);
    expect(result.project.arms).toHaveLength(4);
    expect(result.project.arms.every((arm) => arm.waitingArea === 'none')).toBe(true);
    expect(result.project.arms.every((arm) => arm.rightTurnLane)).toBe(true);
    expect(result.project.arms.every((arm) => ['direct', 'split', 'slip'].includes(arm.rightTurnType))).toBe(true);
    expect(new Set(result.project.arms.map((arm) => arm.rightTurnType)).size).toBe(3);
    expect(result.project.arms.every((arm) => ['planted', 'hatched'].includes(arm.rightTurnIsland))).toBe(true);
  });

  it('sanitizes the junction type with cross as default', () => {
    expect(createDefaultProject().junctionType).toBe('cross');
    expect(sanitizeProject({ junctionType: 'roundabout' }).junctionType).toBe('roundabout');
    expect(sanitizeProject({ junctionType: 'cloverleaf' }).junctionType).toBe('cross');
    expect(sanitizeProject({}).junctionType).toBe('cross');
  });

  it('warns when roundabout mode carries signal-only facilities', () => {
    const base = {
      ...createDefaultProject(),
      arms: createDefaultProject().arms.map((arm) => ({ ...arm, waitingArea: 'left' })),
    };
    const cross = validateProject({ ...base, junctionType: 'cross' });
    const roundabout = validateProject({ ...base, junctionType: 'roundabout' });
    expect(roundabout.warnings.some((w) => w.includes('环岛'))).toBe(true);
    expect(cross.warnings.some((w) => w.includes('环岛'))).toBe(false);
  });

  it('normalizes imported numeric values and flags overlapping arms', () => {
    const project = sanitizeProject({
      arms: [
        { angle: -1, laneIn: 99, laneOut: 2 },
        { angle: 362, laneIn: 2, laneOut: 2 },
      ],
      laneWidth: 12,
    });

    expect(project.arms[0].angle).toBe(359);
    expect(project.arms[0].laneIn).toBe(6);
    expect(project.laneWidth).toBe(4.2);
    expect(validateProject(project).valid).toBe(false);
  });

  it('sanitizes per-approach waiting-area settings', () => {
    const project = sanitizeProject({
      arms: [
        { angle: 0, laneIn: 4, laneOut: 2, waitingArea: 'left', leftTurnLanes: 9 },
        { angle: 180, laneIn: 3, laneOut: 2, waitingArea: 'invalid', leftTurnLanes: 0 },
      ],
    });

    expect(project.arms[0].waitingArea).toBe('left');
    expect(project.arms[0].leftTurnLanes).toBe(2);
    expect(project.arms[1].waitingArea).toBe('none');
    expect(project.arms[1].leftTurnLanes).toBe(1);
  });

  it('sanitizes right-turn lane and triangular-island settings', () => {
    const project = sanitizeProject({
      scenerySeed: 4,
      arms: [
        { angle: 0, laneIn: 2, laneOut: 2, rightTurnLane: true, rightTurnIsland: 'hatched' },
        { angle: 180, laneIn: 2, laneOut: 2, rightTurnLane: false, rightTurnIsland: 'invalid' },
      ],
    });

    expect(project.arms[0].rightTurnLane).toBe(true);
    expect(project.arms[0].rightTurnType).toBe('split');
    expect(project.arms[0].rightTurnIsland).toBe('hatched');
    expect(project.arms[1].rightTurnLane).toBe(false);
    expect(project.arms[1].rightTurnType).toBe('none');
    expect(project.arms[1].rightTurnIsland).toBe('hatched');
  });

  it('preserves explicit right-turn facility types and lane counts', () => {
    const project = sanitizeProject({
      arms: [
        { angle: 0, laneIn: 3, laneOut: 2, rightTurnType: 'direct', rightTurnLanes: 2 },
        { angle: 180, laneIn: 2, laneOut: 2, rightTurnLane: true, rightTurnLanes: 1 },
      ],
    });

    expect(project.arms[0]).toMatchObject({ rightTurnType: 'direct', rightTurnLane: true, rightTurnLanes: 2 });
    expect(project.arms[1]).toMatchObject({ rightTurnType: 'split', rightTurnLane: true, rightTurnLanes: 1 });
  });

  it('warns when a right-turn lane has no reachable right-side exit', () => {
    const project = sanitizeProject({
      arms: [
        { angle: 0, laneIn: 2, laneOut: 2, rightTurnLane: true },
        { angle: 180, laneIn: 2, laneOut: 2, rightTurnLane: false },
      ],
    });
    const result = validateProject(project);

    expect(result.valid).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('没有可连接的右侧出口'))).toBe(true);
  });

  it('warns when a configured waiting area has insufficient lanes', () => {
    const project = createDefaultProject();
    project.arms[0].waitingArea = 'left';
    project.arms[0].leftTurnLanes = 2;
    project.arms[0].laneIn = 3;
    const result = validateProject(project);

    expect(result.valid).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('至少需要 4 条进入车道'))).toBe(true);
  });

  it('round-trips the versioned project document', () => {
    const source = createDefaultProject();
    source.projectName = '测试路口';
    const document = createProjectDocument(source, new Date('2026-08-16T00:00:00.000Z'));
    const restored = parseProjectDocument(JSON.stringify(document));

    expect(restored).toEqual(source);
    expect(document.version).toBe(3);
  });

  it('calculates stable metrics and deterministic random values', () => {
    const stats = getProjectStats(createDefaultProject());
    expect(stats.arms).toBe(4);
    expect(stats.lanes).toBe(17);
    expect(stats.roadArea).toBeGreaterThan(2000);

    const first = createSeededRandom(42);
    const second = createSeededRandom(42);
    expect([first(), first(), first()]).toEqual([second(), second(), second()]);
  });

  it('uses circular angle distance', () => {
    expect(angleDistance(355, 5)).toBe(10);
    expect(angleDistance(90, 270)).toBe(180);
  });

  it('samples realistic intersection sizes and preserves enough arm length', () => {
    expect(sampleIntersectionSize(() => 0)).toBe(30);
    expect(sampleIntersectionSize(() => 1)).toBe(42);
    const project = sanitizeProject({ intersectionSize: 60, armLength: 25 });
    expect(project.intersectionSize).toBe(60);
    expect(project.armLength).toBeGreaterThanOrEqual(38);
  });
});
