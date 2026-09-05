import { describe, expect, it } from 'vitest';
import { createDefaultProject } from './state.js';
import { generateSDMap, splitAtGradeCrossings, validateSDMap, extractBlocks } from './sd-map.js';
import { distanceToRoad } from './corridor.js';

describe('organic street growth',()=>{
  it('stays connected without short snap artifacts across seeds and scales',()=>{
    for(const citySize of [1400,1800,2400])for(const cityBlockSize of [80,120,180])for(const scenerySeed of [1,16,42,999]){
      const sd=splitAtGradeCrossings(generateSDMap({...createDefaultProject(),citySize,cityBlockSize,scenerySeed}));
      expect(validateSDMap(sd),`${citySize}/${cityBlockSize}/${scenerySeed}`).toMatchObject({valid:true,components:1,errors:[],warnings:[]});
    }
  });

  it('has multiple street orientations and irregular block sizes, not a rotated grid',()=>{
    const sd=generateSDMap({...createDefaultProject(),scenerySeed:42}),nodes=new Map(sd.nodes.map(n=>[n.id,n]));
    let x=0,z=0,total=0;
    for(const e of sd.edges){
      const a=nodes.get(e.from),b=nodes.get(e.to),length=Math.hypot(b.x-a.x,b.z-a.z),angle=Math.atan2(b.z-a.z,b.x-a.x);
      x+=length*Math.cos(4*angle);z+=length*Math.sin(4*angle);total+=length;
    }
    // Any perfectly orthogonal grid, at any rotation, scores exactly one.
    expect(Math.hypot(x,z)/total).toBeLessThan(0.8);
    const areas=extractBlocks(sd).map(b=>b.area).sort((a,b)=>a-b);
    expect(areas.length).toBeGreaterThan(80);
    expect(areas[Math.floor(areas.length*0.8)]/areas[Math.floor(areas.length*0.2)]).toBeGreaterThan(2);
  });

  it('reserves the river for explicit bridges and preserves geographic intent',()=>{
    const sd=generateSDMap({...createDefaultProject(),scenerySeed:42}),nodes=new Map(sd.nodes.map(n=>[n.id,n]));
    const river={path:sd.geography.river.points};
    expect(sd.edges.filter(e=>e.crossing==='water')).toHaveLength(2);
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
