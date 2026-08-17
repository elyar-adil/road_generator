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

    expect(layout.nearSplitU-layout.stopU).toBeGreaterThanOrEqual(12.5);
    expect(layout.slipSplitU).toBeGreaterThan(layout.nearSplitU);
    expect(layout.slipSplitU).toBeLessThan(46);
    expect(layout.targetMergeU-layout.cornerU).toBeGreaterThanOrEqual(18);
    expect(layout.turnU-layout.cornerU).toBeGreaterThanOrEqual(7.5);
    expect(layout.turnU).toBeLessThan(layout.nearSplitU);
    expect(layout.turnU).toBeLessThan(layout.targetMergeU);
  });

  it('keeps a compact layout inside a short arm',()=>{
    const layout=computeRightTurnLayout({
      fromRadius:20,
      targetRadius:22,
      armLength:30,
      laneWidth:4.2,
    });

    expect(layout.nearSplitU).toBeLessThanOrEqual(28);
    expect(layout.slipSplitU).toBeLessThanOrEqual(28.9);
    expect(layout.targetMergeU).toBeLessThanOrEqual(29.2);
    expect(layout.turnU).toBeGreaterThanOrEqual(layout.cornerU);
  });
});
