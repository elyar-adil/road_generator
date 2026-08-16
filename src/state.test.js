import { describe, expect, it } from 'vitest';
import {
  angleDistance,
  createDefaultProject,
  createProjectDocument,
  createSeededRandom,
  getProjectStats,
  parseProjectDocument,
  sanitizeProject,
  validateProject,
} from './state.js';

describe('project state', () => {
  it('creates a valid default project', () => {
    const result = validateProject(createDefaultProject());
    expect(result.valid).toBe(true);
    expect(result.project.arms).toHaveLength(4);
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
});
