const v2=(x,y)=>({x,y});
const add=(a,b)=>v2(a.x+b.x,a.y+b.y);
const scl=(a,s)=>v2(a.x*s,a.y*s);
const sub=(a,b)=>v2(a.x-b.x,a.y-b.y);
const len=a=>Math.hypot(a.x,a.y);
const lerp2=(a,b,t)=>v2(a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t);
const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));

export function computeRightTurnLayout({fromRadius,targetRadius,armLength,laneWidth}){
  const safeLength=Math.max(12,Number(armLength)||12);
  const safeLaneWidth=clamp(Number(laneWidth)||3.25,2.6,4.2);
  const fromR=Math.max(0,Number(fromRadius)||0);
  const targetR=Math.max(0,Number(targetRadius)||0);
  const cornerU=Math.min(safeLength-5,Math.max(fromR,targetR)+3.2);
  const crosswalkStart=fromR+0.7;
  const crosswalkEnd=Math.min(fromR+4.2,safeLength-1.8);
  const hasCrosswalkSpace=crosswalkEnd-crosswalkStart>1.2;
  const stopU=hasCrosswalkSpace ? crosswalkEnd+0.45 : fromR+0.45;
  const nearSplitU=Math.min(safeLength-2,stopU+Math.max(12.5,safeLaneWidth*3.8));
  const slipSplitU=Math.min(safeLength-1.1,nearSplitU+Math.max(5.5,safeLaneWidth*1.7));
  const targetMergeU=Math.min(safeLength-1.1,cornerU+Math.max(18,safeLaneWidth*5.5));
  const turnU=Math.max(cornerU,Math.min(
    safeLength-2.5,
    cornerU+Math.max(7.5,safeLaneWidth*2.4),
    nearSplitU-Math.max(5,safeLaneWidth*1.5),
    targetMergeU-Math.max(6,safeLaneWidth*1.8),
  ));
  return {cornerU,turnU,stopU,nearSplitU,slipSplitU,splitU:nearSplitU,targetMergeU};
}

function cubicPoint2(p0,p1,p2,p3,t){
  const mt=1-t;
  return v2(
    mt*mt*mt*p0.x+3*mt*mt*t*p1.x+3*mt*t*t*p2.x+t*t*t*p3.x,
    mt*mt*mt*p0.y+3*mt*mt*t*p1.y+3*mt*t*t*p2.y+t*t*t*p3.y,
  );
}

function appendCubic2(path,p0,p1,p2,p3,segments=8){
  for(let i=1;i<=segments;i++) path.push(cubicPoint2(p0,p1,p2,p3,i/segments));
}

// Corner fillet identical to the intersection curb fillet, so the island edge
// follows the main pavement boundary.
function fillet(p0,edge0dir,p1,edge1dir,segN){
  const chordVec=sub(p1,p0);
  const chord=len(chordVec);
  if(chord<1e-4) return [];
  const d0=len(edge0dir)>1e-4 ? scl(edge0dir,1/len(edge0dir)) : scl(chordVec,1/chord);
  const d1=len(edge1dir)>1e-4 ? scl(edge1dir,1/len(edge1dir)) : scl(chordVec,1/chord);
  const bend=Math.abs(d0.x*d1.y-d0.y*d1.x);
  const handle=Math.min(chord*0.42,Math.max(chord*0.16,chord*(0.22+0.12*bend)));
  const c0=add(p0,scl(d0,handle));
  const c1=sub(p1,scl(d1,handle));
  const pts=[];
  for(let i=1;i<segN;i++){
    const t=i/segN;
    const mt=1-t;
    pts.push(v2(
      mt*mt*mt*p0.x+3*mt*mt*t*c0.x+3*mt*t*t*c1.x+t*t*t*p1.x,
      mt*mt*mt*p0.y+3*mt*mt*t*c0.y+3*mt*t*t*c1.y+t*t*t*p1.y,
    ));
  }
  return pts;
}

function toLocal(g,p){
  const d=sub(p,g.wp(0,0));
  return {u:d.x*g.fwd.x+d.y*g.fwd.y, s:d.x*g.left.x+d.y*g.left.y};
}

function variableOffsetPath(path,halfWidth,scaleAt){
  const left=[],right=[];
  for(let i=0;i<path.length;i++){
    const previous=path[Math.max(0,i-1)], next=path[Math.min(path.length-1,i+1)];
    const tangent=sub(next,previous), tangentLen=len(tangent)||1;
    const normal=v2(-tangent.y/tangentLen,tangent.x/tangentLen);
    const scaleFactor=Math.min(1,scaleAt(i));
    left.push(add(path[i],scl(normal,halfWidth*scaleFactor)));
    right.push(add(path[i],scl(normal,-halfWidth*scaleFactor)));
  }
  return {left,right};
}

function offsetLanePaths(path,laneCount,laneWidth,scaleAt){
  const bundleWidth=laneCount*laneWidth;
  return Array.from({length:laneCount},(_,laneIndex)=>path.map((point,index)=>{
    const previous=path[Math.max(0,index-1)], next=path[Math.min(path.length-1,index+1)];
    const tangent=sub(next,previous), tangentLength=len(tangent)||1;
    const normal=v2(-tangent.y/tangentLength,tangent.x/tangentLength);
    const offset=bundleWidth/2-(laneIndex+0.5)*laneWidth;
    const taper=Math.min(1,scaleAt(index));
    return add(point,scl(normal,offset*taper));
  }));
}

function rightTurnLaneCenter(g,laneIndex,direction){
  return direction==='source'
    ? g.outOuterS+(laneIndex+0.5)*g.laneW
    : g.inOuterS-(laneIndex+0.5)*g.laneW;
}

function buildDirectRightTurnPath(fromG,toG,laneIndex){
  const start=fromG.wp(fromG.R+0.15,rightTurnLaneCenter(fromG,laneIndex,'source'));
  const end=toG.wp(toG.R+0.15,rightTurnLaneCenter(toG,laneIndex,'target'));
  const chord=len(sub(end,start));
  if(chord<1.5) return null;
  const handle=Math.min(12,Math.max(3.2,chord*0.34));
  const path=[start];
  appendCubic2(path,
    start,add(start,scl(fromG.fwd,-handle)),
    add(end,scl(toG.fwd,-handle)),end,14,
  );
  return path;
}

// Find the last crossing of a polyline with the arm edge line s=targetS.
// Returns {index, point} where the segment (index-1 -> index) crosses.
function lastEdgeCrossing(points,g,targetS,minIndex){
  for(let i=points.length-1;i>minIndex;i--){
    const a=points[i-1], b=points[i];
    const sa=toLocal(g,a).s, sb=toLocal(g,b).s;
    if((sa-targetS)*(sb-targetS)<0){
      const t=(targetS-sa)/(sb-sa);
      return {index:i, point:lerp2(a,b,clamp(t,0,1))};
    }
  }
  return null;
}

function edgeLine(g,uFrom,uTo,s,step){
  const count=Math.max(2,Math.round(Math.abs(uTo-uFrom)/step));
  const pts=[];
  for(let k=0;k<=count;k++) pts.push(g.wp(uFrom+(uTo-uFrom)*k/count,s));
  return pts;
}

export function buildRightTurnFacility(fromG,toG,type,laneCount,{armLength,filletSeg}){
  if(!fromG || !toG || laneCount<1) return null;
  if(type==='direct'){
    const lanePaths=Array.from({length:laneCount},(_,laneIndex)=>
      buildDirectRightTurnPath(fromG,toG,laneIndex),
    ).filter(Boolean);
    return lanePaths.length===laneCount ? {type,lanePaths} : null;
  }

  const laneW=fromG.laneW;
  const bundleWidth=laneW*laneCount;
  const {cornerU,nearSplitU,slipSplitU,targetMergeU}=computeRightTurnLayout({
    fromRadius:fromG.R,
    targetRadius:toG.R,
    armLength,
    laneWidth:laneW,
  });
  const splitU=type==='slip' ? slipSplitU : nearSplitU;
  const sourceAnchor=fromG.wp(splitU,fromG.outOuterS);
  const sourceNear=fromG.wp(cornerU,fromG.outOuterS-bundleWidth/2);
  const targetAnchor=toG.wp(targetMergeU,toG.inOuterS-bundleWidth/2);
  const chord=len(sub(sourceNear,targetAnchor));
  if(chord<2) return null;
  const turnHandle=Math.min(12,Math.max(3.5,chord*0.34));
  const sourceHandle=Math.min(10,Math.max(3,len(sub(sourceAnchor,sourceNear))*0.42));
  const path=[sourceAnchor];
  appendCubic2(path,
    sourceAnchor,add(sourceAnchor,scl(fromG.fwd,-sourceHandle)),
    add(sourceNear,scl(fromG.fwd,sourceHandle)),sourceNear,8,
  );
  const islandStart=path.length-1;
  appendCubic2(path,
    sourceNear,add(sourceNear,scl(fromG.fwd,-turnHandle)),
    add(targetAnchor,scl(toG.fwd,-turnHandle)),targetAnchor,14,
  );
  const islandEnd=path.length-1;

  // The branch starts as a point at the fork nose on the carriageway edge and
  // reaches full width at the corner. Tying the width taper to the progress of
  // the source segment keeps the branch's inner edge exactly on the road edge
  // line, so the branch never overlaps the through carriageway.
  const sourceSegments=8;
  const scaleAt=(i)=>Math.min(1,i/sourceSegments);
  const offsets=variableOffsetPath(path,bundleWidth/2,scaleAt);
  const lanePaths=offsetLanePaths(path,laneCount,laneW,scaleAt);

  // Branch inner edge: the road edge line from the fork nose to the corner,
  // then the inward offset of the corner curve down to the merge point.
  const innerBoundary=[];
  for(let i=0;i<=islandStart;i++){
    innerBoundary.push(fromG.wp(splitU+(cornerU-splitU)*i/islandStart,fromG.outOuterS));
  }
  for(let i=islandStart+1;i<path.length;i++) innerBoundary.push(offsets.right[i]);

  // The island is the wedge between the branch's inner edge and the main road
  // boundary (target edge line, corner fillet, source edge line). It closes at
  // the merge nose where the branch re-enters the carriageway.
  let islandBoundary=null;
  let islandEdge=null;
  let islandRoadSide=null;
  let mergeLine=null;
  const crossing=lastEdgeCrossing(innerBoundary,toG,toG.inOuterS,islandStart);
  if(crossing){
    const nose=crossing.point;
    const filletStart=toG.nearLeft;
    const filletEnd=fromG.nearRight;
    const filletStartU=toLocal(toG,filletStart).u;
    const filletEndU=toLocal(fromG,filletEnd).u;
    const noseU=toLocal(toG,nose).u;
    const roadSideFromNose=[
      nose,
      ...edgeLine(toG,noseU,filletStartU,toG.inOuterS,2.5),
      ...fillet(filletStart,scl(toG.fwd,-1),filletEnd,fromG.fwd,filletSeg),
      ...edgeLine(fromG,filletEndU,cornerU,fromG.outOuterS,2.5),
    ];
    islandEdge=[...innerBoundary.slice(islandStart,crossing.index),nose];
    islandRoadSide=[...roadSideFromNose].reverse();
    islandBoundary=[...islandEdge,...roadSideFromNose];
    mergeLine=[nose,...innerBoundary.slice(crossing.index)];
  }
  return {
    type,path,offsets,lanePaths,
    sourceAnchor,targetAnchor,islandStart,islandEnd,
    outerBoundary:offsets.left,
    innerBoundary,
    islandBoundary,islandEdge,islandRoadSide,mergeLine,
    splitU,targetMergeU,bundleWidth,
  };
}
