import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MarkBatch, boxAlong } from './render.js';

const groupMeshes = (group) => {
  const meshes = [];
  group.traverse((obj) => {
    if (obj.isMesh && obj.geometry.getIndex()) meshes.push(obj);
  });
  return meshes;
};

describe('mark batching', () => {
  it('bakes boxes at the same world transform as boxAlong', () => {
    const p0 = { x: -4, y: 2 }, p1 = { x: 9, y: 7 };
    const opt = { lateral: 0.6, width: 0.32, height: 0.15, yBottom: 0.02, extend: 0.05 };

    const single = boxAlong(p0, p1, opt);
    single.updateMatrixWorld(true);
    const expected = new THREE.Box3().setFromObject(single);

    const batch = new MarkBatch();
    batch.box(p0, p1, opt);
    const group = new THREE.Group();
    batch.flush(group);
    expect(group.children).toHaveLength(1);
    group.children[0].updateMatrixWorld(true);
    const actual = new THREE.Box3().setFromObject(group.children[0]);

    expect(actual.min.x).toBeCloseTo(expected.min.x, 5);
    expect(actual.min.y).toBeCloseTo(expected.min.y, 5);
    expect(actual.min.z).toBeCloseTo(expected.min.z, 5);
    expect(actual.max.x).toBeCloseTo(expected.max.x, 5);
    expect(actual.max.y).toBeCloseTo(expected.max.y, 5);
    expect(actual.max.z).toBeCloseTo(expected.max.z, 5);
  });

  it('groups entries by material and cast flag into merged meshes', () => {
    const batch = new MarkBatch();
    batch.box({ x: 0, y: 0 }, { x: 2, y: 0 }, { width: 0.15, height: 0.01, extend: 0, color: 0xffffff, rough: 0.6 });
    batch.box({ x: 3, y: 0 }, { x: 5, y: 0 }, { width: 0.15, height: 0.01, extend: 0, color: 0xffffff, rough: 0.6 });
    batch.box({ x: 0, y: 1 }, { x: 2, y: 1 }, { width: 0.32, height: 0.15, extend: 0, color: 0xb9b2a3, rough: 0.85, castShadow: true });
    batch.poly([{ x: 0, y: 5 }, { x: 4, y: 5 }, { x: 4, y: 8 }, { x: 0, y: 8 }], 0.01, 0x2c2f36, 0.95);

    const group = new THREE.Group();
    batch.flush(group);
    expect(group.children).toHaveLength(3);

    const cast = group.children.filter((m) => m.castShadow);
    expect(cast).toHaveLength(1);
    expect(cast[0].material.color.getHex()).toBe(0xb9b2a3);
  });

  it('keeps every flushed index inside its geometry bounds', () => {
    const batch = new MarkBatch();
    batch.box({ x: 0, y: 0 }, { x: 12, y: 3 }, { width: 0.5, height: 0.01, extend: 0 });
    batch.box({ x: 1, y: 1 }, { x: 13, y: 4 }, { width: 0.2, height: 0.008, extend: 0 });
    batch.poly([{ x: -2, y: -2 }, { x: 20, y: -1 }, { x: 18, y: 14 }, { x: -1, y: 12 }], 0.05);

    const group = new THREE.Group();
    batch.flush(group);
    const meshes = groupMeshes(group);
    expect(meshes.length).toBeGreaterThanOrEqual(2);
    for (const mesh of meshes) {
      const geo = mesh.geometry;
      const posCount = geo.attributes.position.count;
      expect(posCount).toBeGreaterThan(0);
      const index = geo.getIndex();
      for (let i = 0; i < index.count; i += 1) {
        expect(index.getX(i)).toBeLessThan(posCount);
        expect(index.getX(i)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('skips degenerate segments and tiny polygons without throwing', () => {
    const batch = new MarkBatch();
    batch.box({ x: 1, y: 1 }, { x: 1, y: 1 }, { width: 0.1, height: 0.01 });
    batch.poly([{ x: 0, y: 0 }, { x: 1, y: 0 }], 0.01);
    const group = new THREE.Group();
    batch.flush(group);
    expect(group.children).toHaveLength(0);
  });
});
