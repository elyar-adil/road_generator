export function classifyMovement(fromG,toG){
  const approachDir={x:-fromG.fwd.x,y:-fromG.fwd.y};
  const exitDir=toG.fwd;
  const cross=approachDir.x*exitDir.y-approachDir.y*exitDir.x;
  const dot=approachDir.x*exitDir.x+approachDir.y*exitDir.y;
  // World X/Z is vertically flipped by the top-down planning camera, so the
  // mathematical cross-product sign is inverted for visible left/right.
  const turn=-Math.atan2(cross,dot)*180/Math.PI;
  if(turn>-45&&turn<45) return {type:'straight',turn};
  if(turn>=45&&turn<150) return {type:'left',turn};
  if(turn<=-45&&turn>-150) return {type:'right',turn};
  return {type:'uturn',turn};
}

export function classifyArmMovement(fromArm,toArm){
  const fromAngle=Number(fromArm.angle)*Math.PI/180;
  const toAngle=Number(toArm.angle)*Math.PI/180;
  return classifyMovement(
    {fwd:{x:Math.cos(fromAngle),y:Math.sin(fromAngle)}},
    {fwd:{x:Math.cos(toAngle),y:Math.sin(toAngle)}},
  );
}

export function laneMovementSets(laneCount,available,dedicatedLeftLanes=0,dedicatedRightLanes=0){
  const order=['straight','right','left'];
  const rightCount=typeof dedicatedRightLanes==='boolean'
    ? 0
    : Math.min(laneCount,Math.max(0,Math.round(dedicatedRightLanes)));
  const rightBranchSplitsOff=dedicatedRightLanes===true;
  const fallback=order.find(type=>available.has(type))
    || (available.has('right')?'right':'straight');
  if(laneCount<=0) return [];
  if(laneCount===1){
    if(rightCount>0 && available.has('right')) return [new Set(['right'])];
    return [new Set(available.size?[...available]:[fallback])];
  }

  const lanes=new Array(laneCount).fill(0).map(()=>new Set());
  if(available.has('right')){
    for(let lane=laneCount-rightCount;lane<laneCount;lane++){
      if(lane>=0) lanes[lane].add('right');
    }
    if(rightCount===0 && !rightBranchSplitsOff) lanes[laneCount-1].add('right');
  }
  const leftCount=available.has('left')
    ? Math.min(laneCount-rightCount,Math.max(1,dedicatedLeftLanes))
    : 0;
  for(let lane=0;lane<leftCount;lane++) lanes[lane].add('left');
  if(available.has('straight')){
    const straightStart=dedicatedLeftLanes>0?leftCount:0;
    for(let lane=straightStart;lane<laneCount-rightCount;lane++) lanes[lane].add('straight');
    if(rightCount===0){
      for(let lane=straightStart;lane<laneCount;lane++) lanes[lane].add('straight');
    }
  }
  return lanes.map(set=>{
    const filtered=new Set([...set].filter(type=>available.has(type)));
    return filtered.size?filtered:new Set([fallback]);
  });
}

// How many inbound lanes an approach can dedicate to left turns at the
// intersection, matching the geometry the arrows/rays render.
export function leftTurnCapacity(arm, target){
  if(!target || arm.laneIn<3) return 0;
  return Math.min(2, arm.leftTurnLanes, arm.laneIn-2, target.arm.laneOut);
}

// How many inbound lanes an approach can dedicate to a channelized right turn.
export function rightTurnCapacity(arm, target){
  if(!arm?.rightTurnLane || arm.rightTurnType==='none' || !target) return 0;
  const requested=Math.min(2, arm.rightTurnLanes);
  return arm.laneIn>=requested && target.arm.laneOut>=requested ? requested : 0;
}

// Single source of truth for lane->movement assignment. Both the rendered lane
// arrows and the topology graph must use this so they always agree.
//   arm:        the arm config (laneIn, waitingArea, leftTurnLanes, rightTurn*)
//   available:  Set of reachable movement types (straight/left/right)
//   leftTarget,rightTarget: the geoms reached by left/right movements (may be null)
export function armLaneMovementSets(arm, available, leftTarget, rightTarget){
  const dedicatedLeftLanes = arm.waitingArea==='left'
    ? leftTurnCapacity(arm, leftTarget)
    : 0;
  const rightCount = rightTurnCapacity(arm, rightTarget);
  const dedicatedRight = rightCount>0
    ? (arm.rightTurnType==='direct' ? rightCount : true)
    : 0;
  return laneMovementSets(arm.laneIn, available, dedicatedLeftLanes, dedicatedRight);
}
