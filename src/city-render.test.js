import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { renderCity, SEMANTIC_COLORS } from './city-render.js';
import { buildCity } from './city.js';
import { createDefaultProject } from './state.js';

describe('city mesh compiler',()=>{
  // 四个投影各完整渲染一次城市;写实街道层让单次 scene 渲染就有
  // 上百万顶点,给足超时避免冷启动 JIT 误报。
  it('produces finite indexed geometry in every projection without changing HD data',()=>{
    const cfg={...createDefaultProject(),junctionType:'city',cityBlockSize:180,scenerySeed:42,showBuildings:false};
    const city=buildCity(cfg),before=JSON.stringify(city.lanes);
    expect(city.validation.valid).toBe(true);
    expect(city.roads.length).toBeGreaterThan(50);
    for(const cityView of ['sd','hd','scene','semantic']){
      const group=new THREE.Group();renderCity(city,group,{...cfg,cityView});
      expect(group.children.length).toBeGreaterThan(0);
      expect(group.children.length).toBeLessThan(50);
      for(const mesh of group.children){
        const position=mesh.geometry.attributes.position,index=mesh.geometry.index;
        expect([...position.array].every(Number.isFinite)).toBe(true);
        expect([...index.array].every(i=>i>=0&&i<position.count)).toBe(true);
        if(cityView==='semantic')expect(mesh.material.color.getHex()).toBe(SEMANTIC_COLORS[mesh.userData.semanticClass]);
        mesh.geometry.dispose();
      }
    }
    expect(JSON.stringify(city.lanes)).toBe(before);
  },20000);
});
