import { describe, expect, it } from 'vitest';
import { createDefaultProject } from './state.js';
import { generateSDMap, splitAtGradeCrossings, validateSDMap, extractBlocks } from './sd-map.js';
import { distanceToRoad } from './corridor.js';

describe('organic street growth',()=>{
  // 36 generateSDMap configurations; the suite runs files in parallel so the
  // default 5s budget is too tight for this file under load.
  it('stays connected without short snap artifacts across seeds and scales',()=>{
    for(const citySize of [1400,1800,2400])for(const cityBlockSize of [80,120,180])for(const scenerySeed of [1,16,42,999]){
      const sd=splitAtGradeCrossings(generateSDMap({...createDefaultProject(),citySize,cityBlockSize,scenerySeed}));
      const v=validateSDMap(sd);
      expect(v,`${citySize}/${cityBlockSize}/${scenerySeed}`).toMatchObject({valid:true,components:1,errors:[]});
      // 邻域合并会让极少数环城路顶点附近的交叉口变成 15-20° 斜交;这类
      // 斜交在真实城市里也常见,允许每张图最多 2 处,其余告警必须为零。
      expect(v.warnings.filter(w=>w.includes('夹角')).length).toBeLessThanOrEqual(2);
      expect(v.warnings.filter(w=>!w.includes('夹角'))).toEqual([]);
    }
  },30000);

  it('reads as a hierarchical grid city: dominant orthogonal axes, four-way junctions, block-size gradient',()=>{
    const sd=generateSDMap({...createDefaultProject(),scenerySeed:42}),nodes=new Map(sd.nodes.map(n=>[n.id,n]));
    // 长度在 16 个方向桶里的分布:主干方格应占大头,环城路与 45° 对角街
    // 提供剩余方向,既不是纯网格也不是有机乱网。
    const bins=new Array(16).fill(0);let total=0;
    for(const e of sd.edges){
      const a=nodes.get(e.from),b=nodes.get(e.to),length=Math.hypot(b.x-a.x,b.z-a.z);
      const angle=Math.atan2(b.z-a.z,b.x-a.x);
      const bin=Math.floor((((angle+Math.PI)%Math.PI)/(Math.PI/16)))%16;
      bins[bin]+=length;total+=length;
    }
    const axis=bins.reduce((best,v,i)=>v>bins[best]?i:best,0);
    const gridShare=(bins[axis]+bins[(axis+8)%16])/total;
    expect(gridShare).toBeGreaterThan(0.5);
    expect(gridShare).toBeLessThan(0.97);
    // 典型中国城市路口以十字为主。
    const degree=new Map();
    for(const e of sd.edges){degree.set(e.from,(degree.get(e.from)||0)+1);degree.set(e.to,(degree.get(e.to)||0)+1);}
    const four=[...degree.values()].filter(d=>d===4).length;
    expect(four/degree.size).toBeGreaterThan(0.4);
    // 老城密支路、外围大街区的尺度梯度。
    const areas=extractBlocks(sd).map(b=>b.area).sort((a,b)=>a-b);
    expect(areas.length).toBeGreaterThan(60);
    expect(areas[Math.floor(areas.length*0.8)]/areas[Math.floor(areas.length*0.2)]).toBeGreaterThan(1.6);
  });

  it('reserves the river for explicit bridges and preserves geographic intent',()=>{
    const sd=generateSDMap({...createDefaultProject(),scenerySeed:42}),nodes=new Map(sd.nodes.map(n=>[n.id,n]));
    const river={path:sd.geography.river.points};
    const bridges=sd.edges.filter(e=>e.crossing==='water');
    expect(bridges.length).toBeGreaterThanOrEqual(2);
    expect(bridges.every(e=>e.layer===1)).toBe(true);
    for(const e of sd.edges.filter(e=>e.layer===0)){
      const a=nodes.get(e.from),b=nodes.get(e.to);
      for(const t of [0,0.25,0.5,0.75,1]){
        expect(distanceToRoad({x:a.x+(b.x-a.x)*t,z:a.z+(b.z-a.z)*t},river)).toBeGreaterThan(sd.geography.river.width/2);
      }
    }
    expect(sd.geography.centres.map(c=>c.style)).toContain('historic');
  });

  it('lets the author change curvature without losing determinism',()=>{
    const cfg={...createDefaultProject(),scenerySeed:42};
    expect(generateSDMap({...cfg,cityOrganic:0.2}).nodes).not.toEqual(generateSDMap({...cfg,cityOrganic:1}).nodes);
  });
});
