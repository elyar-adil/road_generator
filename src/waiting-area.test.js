import { describe, expect, it } from 'vitest';
import {
  buildDashedSegments,
  buildLeftTurnPath,
  offsetPolyline,
  polylineLength,
  trimPolyline,
  trimBeforeLaneEnvelope,
} from './waiting-area.js';

describe('waiting-area geometry',()=>{
  it('builds a target-directed curve that stops at the intersection centre',()=>{
    const path=buildLeftTurnPath({
      start:{x:14,y:-5},
      startDirection:{x:-1,y:0},
      target:{x:5,y:-14},
      targetDirection:{x:0,y:-1},
    });

    expect(path.length).toBeGreaterThan(8);
    expect(path[0]).toEqual({x:14,y:-5});
    const radii=path.map(point=>Math.hypot(point.x,point.y));
    expect(radii.at(-1)).toBe(Math.min(...radii));
    expect(path.at(-1).x).toBeGreaterThanOrEqual(0);
    expect(path.at(-1).y).toBeLessThanOrEqual(0);
  });

  it('creates two finite parallel boundaries around a curved centreline',()=>{
    const path=buildLeftTurnPath({
      start:{x:14,y:-5},startDirection:{x:-1,y:0},
      target:{x:5,y:-14},targetDirection:{x:0,y:-1},
    });
    const boundaries=offsetPolyline(path,1.6);

    expect(boundaries.left).toHaveLength(path.length);
    expect(boundaries.right).toHaveLength(path.length);
    boundaries.left.concat(boundaries.right).forEach(point=>{
      expect(Number.isFinite(point.x)&&Number.isFinite(point.y)).toBe(true);
    });
  });

  it('keeps paired double-left paths nested instead of crossing',()=>{
    const inner=buildLeftTurnPath({
      start:{x:14,y:-8},startDirection:{x:-1,y:0},
      target:{x:5,y:-14},targetDirection:{x:0,y:-1},
    });
    const outer=buildLeftTurnPath({
      start:{x:14,y:-11},startDirection:{x:-1,y:0},
      target:{x:8,y:-14},targetDirection:{x:0,y:-1},
    });

    expect(outer).toHaveLength(inner.length);
    inner.forEach((point,index)=>{
      expect(outer[index].x).toBeGreaterThanOrEqual(point.x-1e-6);
      expect(outer[index].y).toBeLessThanOrEqual(point.y+1e-6);
    });
  });

  it('splits a curved boundary into one-metre dashes',()=>{
    const path=[{x:0,y:0},{x:3,y:0},{x:3,y:3}];
    const dashes=buildDashedSegments(path,1,1);
    expect(polylineLength(path)).toBe(6);
    expect(dashes).toHaveLength(3);
    expect(dashes[0]).toEqual([{x:0,y:0},{x:1,y:0}]);
  });

  it('honours a phase offset so dashes inherit a foreign cadence',()=>{
    const path=[{x:0,y:0},{x:6,y:0}];
    // Cadence dash=2 gap=2 -> period 4.  With no offset, leading edges at 0,4.
    expect(buildDashedSegments(path,2,2)).toEqual([
      [{x:0,y:0},{x:2,y:0}],
      [{x:4,y:0},{x:6,y:0}],
    ]);
    // Shift the origin back by 1: leading edges at -1,3 -> only [3,5] fully
    // inside, plus the partial [-1,1] clipped to [0,1].
    expect(buildDashedSegments(path,2,2,-1)).toEqual([
      [{x:0,y:0},{x:1,y:0}],
      [{x:3,y:0},{x:5,y:0}],
    ]);
  });

  it('trims a path to an exact maximum length',()=>{
    const trimmed=trimPolyline([{x:0,y:0},{x:3,y:0},{x:3,y:4}],5);
    expect(polylineLength(trimmed)).toBeCloseTo(5,6);
    expect(trimmed.at(-1)).toEqual({x:3,y:2});
  });

  it('stops before entering an opposing through-lane envelope',()=>{
    const path=[{x:5,y:2},{x:4,y:1},{x:3,y:0},{x:2,y:-1}];
    const safe=trimBeforeLaneEnvelope(path,{
      forward:{x:1,y:0},left:{x:0,y:1},
      minLongitudinal:-10,maxLongitudinal:10,
      minLateral:-4,maxLateral:0,
      halfWidth:1,
    });
    expect(safe).toEqual([{x:5,y:2},{x:4,y:1}]);
  });
});
