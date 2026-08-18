const EPSILON = 1e-6;

const add = (a,b)=>({x:a.x+b.x,y:a.y+b.y});
const sub = (a,b)=>({x:a.x-b.x,y:a.y-b.y});
const scale = (v,s)=>({x:v.x*s,y:v.y*s});
const distance = (a,b)=>Math.hypot(a.x-b.x,a.y-b.y);

function normalize(v){
  const length=Math.hypot(v.x,v.y);
  return length>EPSILON ? scale(v,1/length) : {x:0,y:0};
}

function cubicPoint(p0,p1,p2,p3,t){
  const mt=1-t;
  return {
    x:mt*mt*mt*p0.x+3*mt*mt*t*p1.x+3*mt*t*t*p2.x+t*t*t*p3.x,
    y:mt*mt*mt*p0.y+3*mt*mt*t*p1.y+3*mt*t*t*p2.y+t*t*t*p3.y,
  };
}

export function polylineLength(path){
  let total=0;
  for(let i=1;i<path.length;i++) total+=distance(path[i-1],path[i]);
  return total;
}

export function pointAndTangentAtDistance(path, wantedDistance){
  if(!path?.length) return null;
  if(path.length===1) return {point:path[0],tangent:{x:1,y:0}};
  let remaining=Math.max(0,wantedDistance);
  for(let i=1;i<path.length;i++){
    const a=path[i-1], b=path[i], segmentLength=distance(a,b);
    if(segmentLength<EPSILON) continue;
    if(remaining<=segmentLength || i===path.length-1){
      const t=Math.min(1,remaining/segmentLength);
      return {
        point:{x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t},
        tangent:normalize(sub(b,a)),
      };
    }
    remaining-=segmentLength;
  }
  return {point:path[path.length-1],tangent:normalize(sub(path.at(-1),path.at(-2)))};
}

// Dashes are laid out along the path as if the pattern originated at an
// abstract origin and continues with a fixed cadence.  `phaseOffset` shifts
// that origin backwards along the path so the first dash leading edge is at
// `phaseOffset` from the path start; this lets a connector inherit the phase
// of another marking (e.g. the main carriageway's lane divider) at the joint,
// so dashes line up seamlessly across the two.
export function buildDashedSegments(path,dashLength=1,gapLength=1,phaseOffset=0){
  const total=polylineLength(path);
  if(total<=EPSILON) return [];
  const period=dashLength+gapLength;
  // Leading edges of the dash pattern live at phaseOffset + m*period for
  // integer m.  Find the first m whose dash can overlap [0, total].
  const mStart=Math.floor((-dashLength-phaseOffset)/period)+1;
  const segments=[];
  for(let m=mStart; ; m++){
    const start=phaseOffset+m*period;
    if(start>=total-EPSILON) break;
    const end=start+dashLength;
    if(end<=0) continue;
    const a=pointAndTangentAtDistance(path,Math.max(0,start))?.point;
    const b=pointAndTangentAtDistance(path,Math.min(end,total))?.point;
    if(a&&b&&distance(a,b)>EPSILON) segments.push([a,b]);
  }
  return segments;
}

export function trimPolyline(path,maxLength){
  if(!path?.length||maxLength<=0) return [];
  const trimmed=[path[0]];
  let travelled=0;
  for(let i=1;i<path.length;i++){
    const segmentLength=distance(path[i-1],path[i]);
    if(segmentLength<EPSILON) continue;
    if(travelled+segmentLength>=maxLength){
      const t=Math.max(0,Math.min(1,(maxLength-travelled)/segmentLength));
      trimmed.push({
        x:path[i-1].x+(path[i].x-path[i-1].x)*t,
        y:path[i-1].y+(path[i].y-path[i-1].y)*t,
      });
      return trimmed;
    }
    trimmed.push(path[i]);
    travelled+=segmentLength;
  }
  return trimmed;
}

export function trimBeforeLaneEnvelope(path,{
  forward,
  left,
  minLongitudinal,
  maxLongitudinal,
  minLateral,
  maxLateral,
  halfWidth,
  clearance=0.18,
}){
  if(!path?.length) return [];
  const safe=[path[0]];
  const lower=minLateral+clearance;
  const upper=maxLateral-clearance;
  for(let i=1;i<path.length;i++){
    const point=path[i];
    const longitudinal=point.x*forward.x+point.y*forward.y;
    const lateral=point.x*left.x+point.y*left.y;
    const insideLongitudinal=longitudinal>minLongitudinal&&longitudinal<maxLongitudinal;
    const overlapsLane=insideLongitudinal
      && lateral-halfWidth<upper
      && lateral+halfWidth>lower;
    if(overlapsLane) break;
    safe.push(point);
  }
  return safe;
}

export function offsetPolyline(path,halfWidth){
  const left=[], right=[];
  for(let i=0;i<path.length;i++){
    const previous=path[Math.max(0,i-1)], next=path[Math.min(path.length-1,i+1)];
    const tangent=normalize(sub(next,previous));
    const normal={x:-tangent.y,y:tangent.x};
    left.push(add(path[i],scale(normal,halfWidth)));
    right.push(add(path[i],scale(normal,-halfWidth)));
  }
  return {left,right};
}

// Build the first half of a complete lane-to-lane turn.  The target point and
// tangent define the real receiving lane, but the waiting-area marking stops
// at the closest point to the intersection origin so it never runs beyond the
// intersection centre.
export function buildLeftTurnPath({
  start,
  startDirection,
  target,
  targetDirection,
  origin={x:0,y:0},
  samples=24,
  handleScale=1,
  maxProgress=0.5,
}){
  const d0=normalize(startDirection), d1=normalize(targetDirection);
  const chord=distance(start,target);
  if(chord<1 || Math.hypot(d0.x,d0.y)<EPSILON || Math.hypot(d1.x,d1.y)<EPSILON) return [];
  const handle=Math.min(chord*0.68,Math.max(3,chord*0.38*handleScale));
  const control1=add(start,scale(d0,handle));
  const control2=add(target,scale(d1,-handle));
  const count=Math.max(8,Math.round(samples));
  const points=[];
  const progress=Math.min(0.55,Math.max(0.38,maxProgress));
  for(let i=0;i<=count;i++) points.push(cubicPoint(start,control1,control2,target,(i/count)*progress));

  let closestIndex=points.length-1;
  let closestDistance=distance(points[closestIndex],origin);
  for(let i=1;i<points.length;i++){
    const radius=distance(points[i],origin);
    if(radius<closestDistance-EPSILON){
      closestDistance=radius;
      closestIndex=i;
    }
  }
  return closestIndex>=2 ? points.slice(0,closestIndex+1) : [];
}
