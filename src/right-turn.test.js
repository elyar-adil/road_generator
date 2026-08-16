import { describe,expect,it } from 'vitest';
import { computeRightTurnLayout } from './right-turn.js';

describe('right-turn branch layout',()=>{
  it('starts the branch upstream of the main stop line',()=>{
    const layout=computeRightTurnLayout({
      fromRadius:21,
      targetRadius:21,
      armLength:46,
      laneWidth:3.25,
    });

    expect(layout.splitU-layout.stopU).toBeGreaterThanOrEqual(8);
    expect(layout.splitU).toBeLessThan(46);
    expect(layout.targetMergeU).toBeGreaterThan(layout.cornerU);
  });

  it('keeps a compact layout inside a short arm',()=>{
    const layout=computeRightTurnLayout({
      fromRadius:20,
      targetRadius:22,
      armLength:30,
      laneWidth:4.2,
    });

    expect(layout.splitU).toBeLessThanOrEqual(28);
    expect(layout.targetMergeU).toBeLessThanOrEqual(29.2);
  });
});
