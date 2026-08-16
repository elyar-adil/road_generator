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
    expect(document.version).toBe(1);
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
    expect(sampleIntersectionSize(() => 0)).toBe(34);
    expect(sampleIntersectionSize(() => 1)).toBe(52);
    const project = sanitizeProject({ intersectionSize: 60, armLength: 25 });
    expect(project.intersectionSize).toBe(60);
    expect(project.armLength).toBeGreaterThanOrEqual(38);
  });
});
