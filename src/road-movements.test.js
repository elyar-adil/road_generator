import { describe,expect,it } from 'vitest';
import { classifyArmMovement,laneMovementSets } from './road-movements.js';

describe('road movement orientation',()=>{
  it('classifies the visually left target as left on the X/Z planning plane',()=>{
    expect(classifyArmMovement({angle:0},{angle:90}).type).toBe('left');
    expect(classifyArmMovement({angle:0},{angle:180}).type).toBe('straight');
    expect(classifyArmMovement({angle:0},{angle:270}).type).toBe('right');
  });

  it('places dedicated left lanes on the centre side and right turns outside',()=>{
    const lanes=laneMovementSets(4,new Set(['left','straight','right']),2);
    expect([...lanes[0]]).toEqual(['left']);
    expect([...lanes[1]]).toEqual(['left']);
    expect([...lanes[2]]).toEqual(['straight']);
    expect(lanes[3].has('right')).toBe(true);
    expect(lanes[3].has('left')).toBe(false);
  });

  it('keeps the original outer lane straight when a right-turn branch splits off',()=>{
    const lanes=laneMovementSets(3,new Set(['left','straight','right']),1,true);
    expect([...lanes[0]]).toEqual(['left']);
    expect([...lanes[1]]).toEqual(['straight']);
    expect([...lanes[2]]).toEqual(['straight']);
  });

  it('falls back to the normal movement set when no right target exists',()=>{
    const lanes=laneMovementSets(2,new Set(['straight']),0,true);
    expect(lanes[0].has('straight')).toBe(true);
    expect(lanes[1].has('straight')).toBe(true);
  });
});
