import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { renderCity, driveArrows, Batch, collectKind } from './city-render.js';
import { buildCity } from './city.js';
import { createDefaultProject } from './state.js';
import { stationPath } from './corridor.js';

// Lane heading +x: hd-map labels a connection toward +z 'right' (cross > 0),
// so a 'right' arrow must lie entirely on the +z side of the lane centreline
// and a 'left' arrow entirely on the -z side.
const approachLane = { path: stationPath(Array.from({ length: 11 }, (_, i) => ({ x: i * 10, y: 0.32, z: 0 }))) };

function arrowPoints(types, lane = approachLane) {
  const batch = new Batch(false);
  driveArrows(batch, lane, types);
  const geos = collectKind(batch, 'marking');
  expect(geos.length).toBeGreaterThan(0);
  return geos.flatMap(g => {
    const a = g.attributes.position.array;
    return Array.from({ length: a.length / 3 }, (_, i) => ({ x: a[i * 3], y: a[i * 3 + 1], z: a[i * 3 + 2] }));
  });
}

describe('city drive arrows',()=>{
  // Turn shapes cross the lane centreline, so correctness means the arrow
  // HEAD (points near the tip) bends toward the side hd-map labels: heading
  // +x, a connection toward +z has cross > 0 and is a 'right' turn.
  const head = pts => pts.filter(p => p.x > 85.4);
  // The crosswalk band sits at [end-4.3, end-1.7]; arrows belong further
  // upstream, mid guide-lane zone — never on the crossing.
  const crosswalkBand = pts => pts.filter(p => p.x > 95.7);

  it('bends the right-turn arrow head toward the hd-map right side (+z)',()=>{
    const pts=arrowPoints(['right']);
    expect(Math.max(...pts.map(p=>p.z))).toBeGreaterThan(0.15);
    expect(head(pts).every(p=>p.z>0.05)).toBe(true);
  });

  it('bends the left-turn arrow head toward the hd-map left side (-z)',()=>{
    const pts=arrowPoints(['left']);
    expect(Math.min(...pts.map(p=>p.z))).toBeLessThan(-0.15);
    expect(head(pts).every(p=>p.z<-0.05)).toBe(true);
  });

  it('keeps the straight arrow symmetric about the lane centreline',()=>{
    const pts=arrowPoints(['straight']);
    const zs=pts.map(p=>p.z);
    expect(Math.min(...zs)).toBeLessThan(-0.15);
    expect(Math.max(...zs)).toBeGreaterThan(0.15);
  });

  it('ends the arrow upstream of the crosswalk band, mid guide-lane zone',()=>{
    const pts=arrowPoints(['straight']);
    const tip=Math.max(...pts.map(p=>p.x)), tail=Math.min(...pts.map(p=>p.x));
    expect(tip).toBeGreaterThan(86);
    expect(tip).toBeLessThan(88.5);
    expect(tail).toBeGreaterThan(80);
    expect(crosswalkBand(pts)).toHaveLength(0);
  });

  it('skips lanes too short to carry a readable arrow',()=>{
    const batch=new Batch(false);
    driveArrows(batch,{path:stationPath([{x:0,y:0.32,z:0},{x:5,y:0.32,z:0}])},['straight']);
    expect(collectKind(batch,'marking')).toHaveLength(0);
  });

  it('adds arrow markings to real city approaches in the scene view',()=>{
    const cfg={...createDefaultProject(),junctionType:'city',cityBlockSize:180,scenerySeed:42,showBuildings:false,showCrosswalk:false,showSidewalk:false};
    const city=buildCity(cfg);
    const markingVertices=showArrows=>{
      const group=new THREE.Group();
      renderCity(city,group,{...cfg,cityView:'scene',showArrows});
      const n=group.children.filter(m=>m.name==='marking').reduce((s,m)=>s+m.geometry.attributes.position.count,0);
      group.traverse(o=>o.geometry?.dispose?.());
      return n;
    };
    expect(markingVertices(true)).toBeGreaterThan(markingVertices(false));
  });
});
