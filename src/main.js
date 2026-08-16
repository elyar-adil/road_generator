import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import {
  createDefaultProject,
  createProjectDocument,
  createSeededRandom,
  getProjectStats,
  parseProjectDocument,
  sampleIntersectionSize,
  sanitizeProject,
  slugifyProjectName,
  validateProject,
} from './state.js';
import {
  downloadBlob,
  loadLocalProject,
  ProjectHistory,
  saveLocalProject,
} from './project-store.js';
import {
  buildDashedSegments,
  buildLeftTurnPath,
  offsetPolyline,
  pointAndTangentAtDistance,
  polylineLength,
  trimPolyline,
  trimBeforeLaneEnvelope,
} from './waiting-area.js';
import { classifyArmMovement,classifyMovement,laneMovementSets } from './road-movements.js';
import { computeRightTurnLayout } from './right-turn.js';

/* ======================================================================
   程序化路口生成器
   Pipeline: 拓扑 (arms + angles + lane counts + 可达性)
             -> 几何 (corner points, fillets, polygons)
             -> 3D mesh (road, curb, sidewalk, median, markings, arrows,
                          traffic lights, guardrails, buildings)
   ====================================================================== */

// ---------------------------------------------------------------- STATE
let state = sanitizeProject(loadLocalProject() ?? createDefaultProject());
const history = new ProjectHistory(state);

const COLORS = {
  asphalt: 0x2c2f36, asphaltEdge:0x24272d,
  curb:0xb9b2a3, sidewalk:0xa7a196, median:0x6f8a5c,
  ground:0x4c6b3d, groundEdge:0x3f5931,
  white:0xf4f4f2, yellow:0xf2c230,
  poleGray:0x3a3f46, lightHousing:0x22262b,
  buildingBase:[0x6b6f76,0x7a6a5c,0x5c6a78,0x716357,0x60686f],
};

// ---------------------------------------------------------------- THREE SETUP
const container = document.getElementById('canvas-container');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fb8d8);
scene.fog = new THREE.Fog(0x8fb8d8, 90, 240);

const persp = new THREE.PerspectiveCamera(50, window.innerWidth/window.innerHeight, 0.1, 1000);
let orthoHalfHeight = 60;
const ortho = new THREE.OrthographicCamera(-60, 60, 60, -60, 0.1, 500);
ortho.position.set(0, 160, 0.001);
ortho.up.set(0,0,-1);
ortho.lookAt(0,0,0);
let activeCam = persp;
let topDownMode = false;

function updateOrthoProjection(){
  const aspect = window.innerWidth/window.innerHeight;
  const halfWidth = orthoHalfHeight*aspect;
  ortho.left=-halfWidth; ortho.right=halfWidth;
  ortho.top=orthoHalfHeight; ortho.bottom=-orthoHalfHeight;
  ortho.updateProjectionMatrix();
}
updateOrthoProjection();

const renderer = new THREE.WebGLRenderer({antialias:true, preserveDrawingBuffer:true});
renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
container.appendChild(renderer.domElement);

// lights
const hemi = new THREE.HemisphereLight(0xdff0ff, 0x33422a, 0.65);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff3da, 1.15);
sun.position.set(60, 90, 40);
sun.castShadow = true;
sun.shadow.mapSize.set(2048,2048);
sun.shadow.camera.left=-90; sun.shadow.camera.right=90;
sun.shadow.camera.top=90; sun.shadow.camera.bottom=-90;
sun.shadow.camera.far=300;
sun.shadow.bias=-0.0004;
scene.add(sun);
const fillLight = new THREE.DirectionalLight(0xbcd6ff, 0.25);
fillLight.position.set(-50,40,-60);
scene.add(fillLight);

// ground
{
  const g = new THREE.Mesh(new THREE.CircleGeometry(220,64), new THREE.MeshStandardMaterial({color:COLORS.ground, roughness:1}));
  g.rotation.x = -Math.PI/2;
  g.receiveShadow = true;
  scene.add(g);
}

const worldGroup = new THREE.Group();
scene.add(worldGroup);

const gridHelper = new THREE.GridHelper(200,40,0x8aa69b,0x61736d);
gridHelper.position.y = 0.022;
gridHelper.material.transparent = true;
gridHelper.material.opacity = 0.22;
gridHelper.visible = state.showGrid;
scene.add(gridHelper);

// ---------------------------------------------------------------- CUSTOM ORBIT CONTROLS
const camState = { theta: Math.PI*0.28, phi: 1.02, radius: 78, target: new THREE.Vector3(0,0,2), panX:0, panZ:0 };
function updatePerspCamera(){
  const p = camState;
  const x = p.target.x + p.radius*Math.sin(p.phi)*Math.sin(p.theta);
  const y = p.radius*Math.cos(p.phi);
  const z = p.target.z + p.radius*Math.sin(p.phi)*Math.cos(p.theta);
  persp.position.set(x,y,z);
  persp.lookAt(p.target);
}
updatePerspCamera();

let dragMode = null, lastX=0,lastY=0, activePointerId=null;
renderer.domElement.addEventListener('pointerdown', e=>{
  if(activePointerId!==null) return;
  activePointerId=e.pointerId;
  dragMode = e.button===2 || topDownMode ? 'pan' : 'rotate';
  lastX=e.clientX; lastY=e.clientY; e.preventDefault();
  renderer.domElement.setPointerCapture(e.pointerId);
});
function endDrag(e){
  if(e.pointerId!==activePointerId) return;
  dragMode=null; activePointerId=null;
}
renderer.domElement.addEventListener('pointerup', endDrag);
renderer.domElement.addEventListener('pointercancel', endDrag);
renderer.domElement.addEventListener('pointermove', e=>{
  if(!dragMode || e.pointerId!==activePointerId) return;
  const dx = e.clientX-lastX, dy = e.clientY-lastY;
  lastX=e.clientX; lastY=e.clientY;
  if(topDownMode){
    const scale = (ortho.right-ortho.left)/window.innerWidth;
    camState.target.x -= dx*scale;
    camState.target.z -= dy*scale;
    ortho.position.set(camState.target.x,160,camState.target.z+0.001);
    ortho.lookAt(camState.target.x,0,camState.target.z);
    return;
  }
  if(dragMode==='rotate'){
    camState.theta -= dx*0.006;
    camState.phi = Math.min(1.5, Math.max(0.15, camState.phi - dy*0.006));
  } else if(dragMode==='pan'){
    const sp = camState.radius*0.0016;
    const right = new THREE.Vector3(Math.cos(camState.theta),0,-Math.sin(camState.theta));
    const fwd = new THREE.Vector3(Math.sin(camState.theta),0,Math.cos(camState.theta));
    camState.target.addScaledVector(right, -dx*sp);
    camState.target.addScaledVector(fwd, dy*sp);
  }
  updatePerspCamera();
});
renderer.domElement.addEventListener('contextmenu', e=>e.preventDefault());
renderer.domElement.addEventListener('wheel', e=>{
  e.preventDefault();
  if(topDownMode){
    const factor = Math.pow(1.001, e.deltaY);
    orthoHalfHeight = Math.min(180,Math.max(12,orthoHalfHeight*factor));
    updateOrthoProjection();
  } else {
    camState.radius = Math.min(220, Math.max(14, camState.radius*Math.pow(1.0012,e.deltaY)));
    updatePerspCamera();
  }
},{passive:false});

window.addEventListener('resize', ()=>{
  persp.aspect = window.innerWidth/window.innerHeight;
  persp.updateProjectionMatrix();
  updateOrthoProjection();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------- GEOMETRY HELPERS
function v2(x,z){ return {x,y:z}; } // using .y to store "world Z" for 2D math convenience
function add(a,b){return v2(a.x+b.x,a.y+b.y);}
function scl(a,s){return v2(a.x*s,a.y*s);}
function sub(a,b){return v2(a.x-b.x,a.y-b.y);}
function len(a){return Math.hypot(a.x,a.y);}
function lerp2(a,b,t){return v2(a.x+(b.x-a.x)*t, a.y+(b.y-a.y)*t);}

function buildPathStrip(path, width, offset){
  if(!path || path.length<2) return null;
  const outer=[], inner=[];
  const centerOffset = offset===undefined ? 0 : offset;
  for(let i=0;i<path.length;i++){
    const p=path[i];
    const prev=path[Math.max(0,i-1)], next=path[Math.min(path.length-1,i+1)];
    const tangent=sub(next,prev), tangentLen=len(tangent)||1;
    const normal=v2(tangent.y/tangentLen,-tangent.x/tangentLen);
    outer.push(add(p,scl(normal,centerOffset+width/2)));
    inner.push(add(p,scl(normal,centerOffset-width/2)));
  }
  return buildFlatPoly(outer.concat(inner.reverse()), [], 0.075, COLORS.sidewalk, {rough:1});
}

function boxAlong(p0,p1,opt,mats){
  // box whose local X axis spans p0->p1 (extended a bit), offset laterally
  const dx=p1.x-p0.x, dz=p1.y-p0.y;
  const segLen = Math.hypot(dx,dz);
  if(segLen<1e-5) return null;
  const ang = Math.atan2(dz,dx);
  const nx = -Math.sin(ang), nz = Math.cos(ang); // left normal
  const lateral = opt.lateral||0;
  const extend = opt.extend!==undefined?opt.extend:0.15;
  const midx = (p0.x+p1.x)/2 + nx*lateral;
  const midz = (p0.y+p1.y)/2 + nz*lateral;
  const w = opt.width, h = opt.height, yBottom = opt.yBottom||0;
  const geo = new THREE.BoxGeometry(segLen+extend, h, w);
  const mesh = new THREE.Mesh(geo, mats||matStd(opt.color||COLORS.curb, opt.rough));
  mesh.position.set(midx, yBottom+h/2, midz);
  mesh.rotation.y = -ang;
  if(opt.castShadow) mesh.castShadow=true;
  if(opt.receiveShadow!==false) mesh.receiveShadow=true;
  return mesh;
}

const matCache = {};
function matStd(color, roughness){
  const key = color+'_'+(roughness===undefined?0.9:roughness);
  if(!matCache[key]) matCache[key] = new THREE.MeshStandardMaterial({color, roughness:roughness===undefined?0.9:roughness, metalness:0.02, side:THREE.DoubleSide});
  return matCache[key];
}

function buildFlatPoly(pts2D, holes, y, color, opts={}){
  // pts2D: array of {x,y(=world z)}; triangulate via THREE.ShapeUtils
  const shapePts = pts2D.map(p=> new THREE.Vector2(p.x, p.y));
  const holeArr = (holes||[]).map(h=> h.map(p=> new THREE.Vector2(p.x,p.y)));
  let faces;
  try{ faces = THREE.ShapeUtils.triangulateShape(shapePts, holeArr); }catch(e){ return null; }
  const allPts = shapePts.concat(...holeArr);
  const positions = [];
  allPts.forEach(p=> positions.push(p.x, y, p.y));
  const indices = [];
  faces.forEach(f=> indices.push(f[0],f[1],f[2]));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions,3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mat = matStd(color, opts.rough);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

function buildQuad(p0,p1,p2,p3,y,color,rough){
  return buildFlatPoly([p0,p1,p2,p3], [], y, color, {rough});
}

function buildMedianIsland(g,noseInnerU){
  const radius=g.medW/2;
  const noseU=noseInnerU+radius;
  const farU=state.armLength;
  if(radius<0.1 || farU-noseU<0.5) return null;
  const pts=[g.wp(farU,radius),g.wp(noseU,radius)];
  const segments=Math.max(8,state.filletSeg*2);
  for(let i=0;i<=segments;i++){
    const angle=Math.PI/2+Math.PI*i/segments;
    pts.push(g.wp(noseU+Math.cos(angle)*radius,Math.sin(angle)*radius));
  }
  pts.push(g.wp(farU,-radius));
  const group=new THREE.Group();
  const top=buildFlatPoly(pts,[],0.145,COLORS.median,{rough:1});
  if(top) group.add(top);
  for(let i=0;i<pts.length-1;i++){
    const curb=boxAlong(pts[i],pts[i+1],{
      lateral:0,width:0.18,height:0.14,yBottom:0.01,
      color:COLORS.curb,rough:0.85,extend:0.03,castShadow:true
    });
    if(curb) group.add(curb);
  }
  return group;
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

function rightTurnPathData(fromG,toG){
  if(!fromG || !toG || fromG.arm.laneIn<1 || toG.arm.laneOut<1) return null;
  const laneW=fromG.laneW;
  const sourceOuterS=fromG.outOuterS;
  const sourceBranchCenterS=sourceOuterS-laneW*0.5;
  const targetOuterS=toG.inOuterS;
  const {cornerU,splitU}=computeRightTurnLayout({
    fromRadius:fromG.R,
    targetRadius:toG.R,
    armLength:state.armLength,
    laneWidth:laneW,
  });
  // The fork nose starts on the existing outer road edge.  The branch then
  // widens outward by one lane instead of stealing width from the through
  // carriageway.
  const sourceFar=fromG.wp(splitU,sourceOuterS);
  const sourceNear=fromG.wp(cornerU,sourceBranchCenterS);
  const targetNear=toG.wp(cornerU,targetOuterS+laneW*0.5);
  const chord=len(sub(sourceNear,targetNear));
  if(chord<2) return null;
  const handle=Math.min(12,Math.max(3.5,chord*0.34));
  const sourceToNear=len(sub(sourceFar,sourceNear));
  const sourceHandle=Math.min(10,Math.max(3,sourceToNear*0.42));
  const path=[sourceFar];
  appendCubic2(path,
    sourceFar, add(sourceFar,scl(fromG.fwd,-sourceHandle)),
    add(sourceNear,scl(fromG.fwd,sourceHandle)), sourceNear, 8);
  const islandStart=path.length-1;
  appendCubic2(path,
    sourceNear, add(sourceNear,scl(fromG.fwd,-handle)),
    add(targetNear,scl(toG.fwd,-handle)), targetNear, 14);
  const islandEnd=path.length-1;
  return {
    path,
    sourceAnchor: sourceFar,
    targetAnchor: targetNear,
    islandStart,
    islandEnd,
  };
}

function variableOffsetPath(path,halfWidth,taperPoints=4){
  const left=[],right=[];
  for(let i=0;i<path.length;i++){
    const previous=path[Math.max(0,i-1)], next=path[Math.min(path.length-1,i+1)];
    const tangent=sub(next,previous), tangentLen=len(tangent)||1;
    const normal=v2(-tangent.y/tangentLen,tangent.x/tangentLen);
    const scaleFactor=Math.min(1,i/Math.max(1,taperPoints));
    left.push(add(path[i],scl(normal,halfWidth*scaleFactor)));
    right.push(add(path[i],scl(normal,-halfWidth*scaleFactor)));
  }
  return {left,right};
}

function addRightTurnCrossingAndYield(path,laneW){
  const total=polylineLength(path);
  if(total<8) return;
  const crossingDistance=total*0.78;
  const crossingPose=pointAndTangentAtDistance(path,crossingDistance);
  if(crossingPose && state.showCrosswalk){
    const normal=v2(-crossingPose.tangent.y,crossingPose.tangent.x);
    for(let i=-1;i<=2;i++){
      const center=add(crossingPose.point,scl(crossingPose.tangent,i*0.62));
      const bar=boxAlong(
        add(center,scl(normal,-laneW*0.5)),
        add(center,scl(normal,laneW*0.5)),
        {lateral:0,width:0.42,height:0.008,yBottom:0.092,color:COLORS.white,rough:0.6,extend:0},
      );
      if(bar) worldGroup.add(bar);
    }
  }
  const yieldPose=pointAndTangentAtDistance(path,total*0.9);
  if(yieldPose){
    const normal=v2(-yieldPose.tangent.y,yieldPose.tangent.x);
    const line=boxAlong(
      add(yieldPose.point,scl(normal,-laneW*0.5)),
      add(yieldPose.point,scl(normal,laneW*0.5)),
      {lateral:0,width:0.32,height:0.01,yBottom:0.094,color:COLORS.white,rough:0.6,extend:0},
    );
    if(line) worldGroup.add(line);
  }
}

function addRightTurnFacility(fromG,toG){
  const data=rightTurnPathData(fromG,toG);
  if(!data) return;
  const {path,sourceAnchor,targetAnchor,islandStart,islandEnd}=data;
  const offsets=variableOffsetPath(path,fromG.laneW/2);
  const surface=buildFlatPoly(offsets.left.concat(offsets.right.slice().reverse()),[],0.082,COLORS.asphalt,{rough:0.95});
  if(surface) worldGroup.add(surface);

  const inner=offsets.right.slice(islandStart,islandEnd+1);
  const islandPoints=[sourceAnchor,...inner,targetAnchor];
  const planted=fromG.arm.rightTurnIsland==='planted';
  const islandColor=planted ? COLORS.median : COLORS.asphalt;
  const island=buildFlatPoly(islandPoints,[],planted?0.145:0.086,islandColor,{rough:1});
  if(island) worldGroup.add(island);
  for(let i=0;i<islandPoints.length;i++){
    const next=(i+1)%islandPoints.length;
    const edge=planted
      ? boxAlong(islandPoints[i],islandPoints[next],{
          lateral:0,width:0.18,height:0.14,yBottom:0.02,
          color:COLORS.curb,rough:0.85,extend:0.03,castShadow:true,
        })
      : boxAlong(islandPoints[i],islandPoints[next],{
          lateral:0,width:0.15,height:0.008,yBottom:0.094,
          color:COLORS.white,rough:0.6,extend:0,
        });
    if(edge) worldGroup.add(edge);
  }
  if(!planted && inner.length>1){
    for(let i=1;i<6;i++){
      const t=i/6;
      const a=lerp2(sourceAnchor,targetAnchor,t);
      const b=lerp2(inner[0],inner.at(-1),Math.min(0.95,t*0.94+0.03));
      const stripe=boxAlong(a,b,{lateral:0,width:0.13,height:0.008,yBottom:0.096,color:COLORS.white,rough:0.6,extend:0});
      if(stripe) worldGroup.add(stripe);
    }
  }
  if(state.showArrows) worldGroup.add(buildArrowMeshOnPath(path.slice(3),['right']));
  addRightTurnCrossingAndYield(path,fromG.laneW);
}

function addGuardrail(g,uStart,uEnd,lateral,yBottom=0.02,height=0.78){
  if(uEnd-uStart<2) return;
  const railMat=matStd(0xc9cdd2,0.35);
  const span=uEnd-uStart;
  const postCount=Math.max(2,Math.floor(span/3.8));
  for(let k=0;k<=postCount;k++){
    const u=uStart+span*k/postCount;
    const p=g.wp(u,lateral);
    const post=new THREE.Mesh(new THREE.CylinderGeometry(0.035,0.035,height,6),railMat);
    post.position.set(p.x,yBottom+height/2,p.y);
    post.castShadow=true;
    worldGroup.add(post);
  }
  const rail=boxAlong(g.wp(uStart,lateral),g.wp(uEnd,lateral),{
    lateral:0,width:0.07,height:0.08,yBottom:yBottom+height*.62,
    color:0xd7dade,rough:0.35,extend:0
  });
  if(rail) worldGroup.add(rail);
}

function lineIntersect(p1,p2,p3,p4){
  const d1x=p2.x-p1.x, d1y=p2.y-p1.y, d2x=p4.x-p3.x, d2y=p4.y-p3.y;
  const denom = d1x*d2y - d1y*d2x;
  if(Math.abs(denom) < 1e-6) return null;
  const t = ((p3.x-p1.x)*d2y - (p3.y-p1.y)*d2x)/denom;
  return v2(p1.x+d1x*t, p1.y+d1y*t);
}

// ---------------------------------------------------------------- TOPOLOGY + GEOMETRY BUILD
function computeArmGeom(arm){
  const a = arm.angle*Math.PI/180;
  const fwd = v2(Math.cos(a), Math.sin(a));
  const left = v2(-Math.sin(a), Math.cos(a)); // rotate fwd +90
  const hasTwoWay=arm.laneIn>0&&arm.laneOut>0;
  const medW=hasTwoWay&&arm.centerMode==='planted' ? arm.medianWidth : 0;
  const laneW = state.laneWidth;
  // Inbound traffic occupies the right (-left) side; outbound traffic occupies
  // the left (+left) side. These bounds must use the matching lane counts.
  const inOuterS = medW/2 + arm.laneOut*laneW;
  const outOuterS = -(medW/2 + arm.laneIn*laneW);
  const totalHalf = Math.max(inOuterS, -outOuterS, (inOuterS-outOuterS)/2);
  const laneBasedRadius = 3.6 + (inOuterS - outOuterS)/2;
  const R = Math.max(laneBasedRadius,state.intersectionSize/2);
  function wp(u,s){ return add(scl(fwd,u), scl(left,s)); }
  return {arm, fwd, left, laneW, medW, inOuterS, outOuterS, totalHalf, R, wp,
    nearLeft: wp(R, inOuterS), nearRight: wp(R, outOuterS),
    farLeft: wp(state.armLength, inOuterS), farRight: wp(state.armLength, outOuterS),
    nearMedL: wp(R, medW/2), nearMedR: wp(R,-medW/2),
    farMedL: wp(state.armLength, medW/2), farMedR: wp(state.armLength,-medW/2),
  };
}

function updateArmRadii(geoms){
  const sorted = geoms.slice().sort((a,b)=>a.arm.angle-b.arm.angle);
  const n=sorted.length;
  sorted.forEach((g,i)=>{
    const prev=sorted[(i+n-1)%n].arm.angle;
    const next=sorted[(i+1)%n].arm.angle;
    const gapPrev=((g.arm.angle-prev+360)%360)||360;
    const gapNext=((next-g.arm.angle+360)%360)||360;
    const minGap=Math.min(gapPrev,gapNext)*Math.PI/180;
    const clearance=g.totalHalf/Math.max(Math.tan(minGap/2),0.2)+1.5;
    g.R=Math.min(state.armLength-5, Math.max(g.R, clearance));
    g.nearLeft=g.wp(g.R,g.inOuterS); g.nearRight=g.wp(g.R,g.outOuterS);
    g.nearMedL=g.wp(g.R,g.medW/2); g.nearMedR=g.wp(g.R,-g.medW/2);
  });
}

function updateCornerTrims(geoms){
  const n=geoms.length;
  geoms.forEach(g=>{ g.leftR=g.R; g.rightR=g.R; });
  for(let i=0;i<n;i++){
    const j=(i+1)%n, gi=geoms[i], gj=geoms[j];
    const a0=gi.wp(0,gi.inOuterS), b0=gj.wp(0,gj.outOuterS);
    const corner=lineIntersect(a0,add(a0,gi.fwd),b0,add(b0,gj.fwd));
    if(!corner) continue;
    const u0=corner.x*gi.fwd.x+corner.y*gi.fwd.y;
    const u1=corner.x*gj.fwd.x+corner.y*gj.fwd.y;
    if(u0<0 || u1<0) continue;
    const trim=Math.max(3.2,state.laneWidth*1.35);
    gi.leftR=Math.min(state.armLength-5,Math.max(gi.R,u0+trim));
    gj.rightR=Math.min(state.armLength-5,Math.max(gj.R,u1+trim));
  }
  geoms.forEach(g=>{
    g.nearLeft=g.wp(g.leftR,g.inOuterS);
    g.nearRight=g.wp(g.rightR,g.outOuterS);
    g.R=Math.max(g.leftR,g.rightR);
    g.nearMedL=g.wp(g.R,g.medW/2);
    g.nearMedR=g.wp(g.R,-g.medW/2);
  });
}

function fillet(p0, edge0dir, p1, edge1dir, segN){
  const chordVec = sub(p1,p0);
  const chord = len(chordVec);
  if(chord<1e-4) return [];
  const d0 = len(edge0dir)>1e-4 ? scl(edge0dir,1/len(edge0dir)) : scl(chordVec,1/chord);
  const d1 = len(edge1dir)>1e-4 ? scl(edge1dir,1/len(edge1dir)) : scl(chordVec,1/chord);
  const bend = Math.abs(d0.x*d1.y-d0.y*d1.x);
  const handle = Math.min(chord*0.42, Math.max(chord*0.16, chord*(0.22+0.12*bend)));
  const c0 = add(p0,scl(d0,handle));
  const c1 = sub(p1,scl(d1,handle));
  const pts=[];
  for(let i=1;i<segN;i++){
    const t=i/segN;
    const mt=1-t;
    pts.push(v2(
      mt*mt*mt*p0.x + 3*mt*mt*t*c0.x + 3*mt*t*t*c1.x + t*t*t*p1.x,
      mt*mt*mt*p0.y + 3*mt*mt*t*c0.y + 3*mt*t*t*c1.y + t*t*t*p1.y
    ));
  }
  return pts;
}

function constrainFilletPoint(p, gi, gj){
  const margin=0.22;
  let q=p;
  const relI=q, ui=relI.x*gi.fwd.x+relI.y*gi.fwd.y, si=relI.x*gi.left.x+relI.y*gi.left.y;
  if(ui>0 && ui<state.armLength && si<gi.inOuterS+margin) q=add(q,scl(gi.left,gi.inOuterS+margin-si));
  const relJ=q, uj=relJ.x*gj.fwd.x+relJ.y*gj.fwd.y, sj=relJ.x*gj.left.x+relJ.y*gj.left.y;
  if(uj>0 && uj<state.armLength && sj>gj.outOuterS-margin) q=add(q,scl(gj.left,gj.outOuterS-margin-sj));
  return q;
}

function pointBlockedByRoad(p, geoms){
  for(const g of geoms){
    const rel = sub(p, v2(0,0));
    const u = rel.x*g.fwd.x + rel.y*g.fwd.y;
    const s = rel.x*g.left.x + rel.y*g.left.y;
    if(u > -6 && u < state.armLength+14 && Math.abs(s) < Math.max(g.inOuterS,-g.outOuterS)+7+state.sidewalkWidth) return true;
  }
  return false;
}

// Lane arrow shapes (inline, self-contained). Local frame: [lateral, forward],
// forward 0 = tail, forward = length = tip/front (toward intersection).
const RoadArrowShapes = (function(){
  // Exact arrow outlines from the design spec (units: cm; x = lateral,
  // y = forward; y=0 is the tail, max y is the front tip toward the
  // intersection). Outlines are centred on x=0 for lane placement.
  // Straight: shaft 150x1800, head base 450, head height 1200, total 3000.
  const STRAIGHT = [
    [-75,0],[75,0],[75,1800],[225,1800],[0,3000],[-225,1800],[-75,1800]
  ];
  // Left turn: shaft 150 wide; positive local lateral points to the visible
  // left side of an inbound lane on the X/Z ground plane.
  const LEFT = [
    [225,0],[375,0],[375,1950],[-175,2550],[-175,3050],
    [-375,2250],[-175,1350],[-175,1800],[225,1350]
  ].map(([x,y])=>[-x,y]);
  // Combined straight + left in a single outline (left head hangs below the
  // straight shaft, straight head on top).
  const STRAIGHT_LEFT = [
    [150,0],[300,0],[300,1800],[450,1800],[225,3000],[0,1800],[150,1800],
    [150,800],[-250,1250],[-250,1750],[-450,950],[-250,200],[-250,650],[150,200]
  ].map(([x,y])=>[-x,y]);
  const RIGHT = LEFT.map(([x,y])=>[-x,y]);
  const STRAIGHT_RIGHT = STRAIGHT_LEFT.map(([x,y])=>[-x,y]);
  // Combined straight + left + right in a single outline (both turn heads
  // hang below the straight shaft, right head on the right side).
  const STRAIGHT_LEFT_RIGHT = [
    [-75,0],[75,0],[75,200],[475,650],[475,200],[675,950],[475,1750],
    [475,1260],[75,650],[75,1800],[225,1800],[0,3000],[-225,1800],[-75,1800],
    [-75,800],[-475,1250],[-475,1750],[-675,950],[-475,200],[-475,650],[-75,200]
  ];
  const LEN = 3050; // max forward (cm), used by buildArrowMesh as scale base

  function getPolygons(types){
    const arr = [...new Set(types && types.length ? types : ['straight'])];
    const key = arr.slice().sort().join('+');
    if(key==='left+straight') return [STRAIGHT_LEFT];
    if(key==='right+straight') return [STRAIGHT_RIGHT];
    if(key==='left+right+straight') return [STRAIGHT_LEFT_RIGHT];
    const shape = key==='left' ? LEFT : (key==='right' ? RIGHT : STRAIGHT);
    if(arr.length===1) return [shape];
    // Other combos (e.g. left+right on a single-lane arm): side by side
    const HW = {left:375, right:375, straight:225};
    const spacing = arr.length===2 ? HW[arr[0]]+HW[arr[1]]+50 : 600;
    const out = [];
    arr.forEach((t,i)=>{
      const o = (i-(arr.length-1)/2)*spacing;
      const s = t==='left' ? LEFT : (t==='right' ? RIGHT : STRAIGHT);
      out.push(s.map(p=>[p[0]+o, p[1]]));
    });
    return out;
  }
  return { length: LEN, getPolygons };
})();

function buildArrowMesh(g, uTail, uTip, sBase, types){
  const group = new THREE.Group();
  const scale=Math.min(1,(uTail-uTip)/RoadArrowShapes.length);
  RoadArrowShapes.getPolygons(types).forEach(points=>{
    const worldPoints=points.map(([lateral,forward])=>g.wp(
      uTail-forward*scale,
      sBase+lateral*scale
    ));
    const mesh=buildFlatPoly(worldPoints,[],0.092,COLORS.white,{rough:0.75});
    if(mesh) group.add(mesh);
  });
  return group;
}

// Waiting-area markings follow the convention in GB 5768.3 for signalized
// intersections: the area is kept within the inbound lane envelope and is
// outlined with a 15 cm white broken line. The existing solid stop line is
// upstream of the crossing; a solid stop line closes the inner end.
const WAITING_LINE_WIDTH = 0.15;
const WAITING_STOP_LINE_WIDTH = 0.5;
const WAITING_DASH = 1.0;
const WAITING_GAP = 1.0;
const WAITING_SURFACE = 0x343941;

function addDashedPath(path){
  buildDashedSegments(path,WAITING_DASH,WAITING_GAP).forEach(([p0,p1])=>{
    const segment = boxAlong(p0,p1,{
      lateral:0, width:WAITING_LINE_WIDTH, height:0.008, yBottom:0.09,
      color:COLORS.white, rough:0.6, extend:0,
    });
    if(segment) worldGroup.add(segment);
  });
}

function buildArrowMeshOnPath(path,types){
  const group=new THREE.Group();
  const total=polylineLength(path);
  const arrowLength=Math.min(3,total*0.48);
  if(arrowLength<1.5) return group;
  const tailDistance=Math.min(0.7,total*0.12);
  const pose=pointAndTangentAtDistance(path,tailDistance);
  if(!pose) return group;
  const normal=v2(pose.tangent.y,-pose.tangent.x);
  const scale=arrowLength/RoadArrowShapes.length;
  RoadArrowShapes.getPolygons(types).forEach(points=>{
    const worldPoints=points.map(([lateral,forward])=>add(
      pose.point,
      add(scl(normal,lateral*scale),scl(pose.tangent,forward*scale)),
    ));
    const mesh=buildFlatPoly(worldPoints,[],0.092,COLORS.white,{rough:0.75});
    if(mesh) group.add(mesh);
  });
  return group;
}

function addWaitingStopLine(p0,p1){
  const line=boxAlong(p0,p1,{
    lateral:0,width:WAITING_STOP_LINE_WIDTH,height:0.01,yBottom:0.09,
    color:COLORS.white,rough:0.6,extend:0,
  });
  if(line) worldGroup.add(line);
}

function addPathWaitingArea(path,width,movement,{drawSideLines=true}={}){
  if(path.length<3 || polylineLength(path)<2.2 || width<1.5) return;
  const {left,right}=offsetPolyline(path,width/2);
  const surface=buildFlatPoly(left.concat(right.slice().reverse()),[],0.013,WAITING_SURFACE,{rough:1});
  if(surface) worldGroup.add(surface);
  if(drawSideLines){
    addDashedPath(left);
    addDashedPath(right);
  }
  addWaitingStopLine(left.at(-1),right.at(-1));
  if(movement) worldGroup.add(buildArrowMeshOnPath(path,[movement]));
  return {left,right};
}

function averagePathGap(pathA,pathB){
  const count=Math.min(pathA.length,pathB.length);
  let total=0;
  for(let i=0;i<count;i++) total+=len(sub(pathA[i],pathB[i]));
  return count ? total/count : Infinity;
}

function averagePaths(pathA,pathB){
  const count=Math.min(pathA.length,pathB.length);
  return Array.from({length:count},(_,index)=>lerp2(pathA[index],pathB[index],0.5));
}

function findMovementTarget(fromG,geoms,type){
  const expectedTurn=type==='left'?90:0;
  return geoms
    .filter(g=>g!==fromG&&g.arm.laneOut>0)
    .map(g=>({g,movement:classifyMovement(fromG,g)}))
    .filter(candidate=>candidate.movement.type===type)
    .sort((a,b)=>Math.abs(a.movement.turn-expectedTurn)-Math.abs(b.movement.turn-expectedTurn))[0]?.g||null;
}

function leftTurnLaneCapacity(arm,target){
  if(!target || arm.laneIn<3) return 0;
  return Math.min(2,arm.leftTurnLanes,arm.laneIn-2,target.arm.laneOut);
}

function rightTurnLaneCapacity(arm,target){
  return arm?.rightTurnLane && target?.arm?.laneOut>0 && arm.laneIn>0 ? 1 : 0;
}

function opposingLeftLaneCapacity(opposingG,target){
  const arm=opposingG?.arm;
  if(!arm) return 0;
  if(!target || arm.laneIn<2 || target.arm.laneOut<1) return 0;
  // A configured double-left approach reserves both median-side lanes.  On
  // an ordinary two/three-lane approach, keep the innermost left-turn side
  // clear as well; the adjacent straight carriageway remains the boundary.
  return arm.waitingArea==='left'
    ? Math.min(2,arm.leftTurnLanes,Math.max(0,arm.laneIn-2),target.arm.laneOut)
    : Math.min(1,arm.laneIn-1);
}

function trimBeforeOpposingStraight(path,opposingG,halfWidth,opposingLeftLanes=0){
  if(!opposingG) return path;
  // Inbound lanes are indexed from the median outward.  When the opposing
  // approach has one or two dedicated left-turn lanes, those lanes occupy the
  // median side and may be crossed by our waiting pocket.  Only the remaining
  // straight-through carriageway is a hard boundary.
  const straightOuterEdge=-(opposingG.medW/2+opposingLeftLanes*opposingG.laneW);
  return trimBeforeLaneEnvelope(path,{
    forward:opposingG.fwd,
    left:opposingG.left,
    minLongitudinal:-opposingG.R-1,
    maxLongitudinal:opposingG.R+1,
    minLateral:opposingG.outOuterS,
    maxLateral:straightOuterEdge,
    halfWidth,
  });
}

function addStraightWaitingArea(g,zoneOuter,firstLane,lastLane){
  if(firstLane>lastLane) return;
  const zoneDepth=Math.min(8,Math.max(4,state.laneWidth*2.2));
  const zoneInner=Math.max(0.5,zoneOuter-zoneDepth);
  const sInner=-(g.medW/2+firstLane*g.laneW);
  const sOuter=-(g.medW/2+(lastLane+1)*g.laneW);
  const path=[g.wp(zoneOuter,(sInner+sOuter)/2),g.wp(zoneInner,(sInner+sOuter)/2)];
  // Add a midpoint so the common path renderer can also handle this straight
  // variant without a special surface or dash implementation.
  path.splice(1,0,lerp2(path[0],path[1],0.5));
  addPathWaitingArea(path,Math.abs(sInner-sOuter),null);
  for(let lane=firstLane+1;lane<=lastLane;lane++){
    const divider=-(g.medW/2+lane*g.laneW);
    addDashedPath([
      g.wp(zoneOuter,divider),
      g.wp((zoneOuter+zoneInner)/2,divider),
      g.wp(zoneInner,divider),
    ]);
  }
  for(let lane=firstLane;lane<=lastLane;lane++){
    const center=-(g.medW/2+(lane+0.5)*g.laneW);
    const lanePath=[g.wp(zoneOuter,center),g.wp((zoneOuter+zoneInner)/2,center),g.wp(zoneInner,center)];
    worldGroup.add(buildArrowMeshOnPath(lanePath,['straight']));
  }
}

function addLeftWaitingAreas(fromG,targetG,opposingG,zoneOuter,laneCount,opposingLeftLanes=0){
  const random=createSeededRandom((state.scenerySeed+Math.round(fromG.arm.angle)*2654435761+laneCount*1013904223)>>>0);
  // A real left-turn waiting pocket normally reaches well into the junction.
  // Scale it with the junction core, then bias the seeded variation toward the
  // longer end so the marking does not look like a short lane stub.
  const minLength=Math.min(12,Math.max(8,state.intersectionSize*0.22));
  const maxLength=Math.min(28,Math.max(minLength+5,state.intersectionSize*0.46));
  const desiredLength=minLength+(maxLength-minLength)*(0.72+random()*0.16);
  // Keep the first half visibly bowed instead of using an over-large handle
  // that leaves a long straight lead and a late, sharp bend.
  const baseHandle=1.20+random()*0.16;
  const paths=[];
  for(let laneOffset=0;laneOffset<laneCount;laneOffset++){
    const sourceLane=laneOffset;
    const sourceS=-(fromG.medW/2+(sourceLane+0.5)*fromG.laneW);
    const targetS=targetG.medW/2+(laneOffset+0.5)*targetG.laneW;
    let bestPath=[];
    let bestLength=0;
    for(let attempt=0;attempt<5;attempt++){
      const candidate=buildLeftTurnPath({
        start:fromG.wp(zoneOuter,sourceS),
        startDirection:scl(fromG.fwd,-1),
        target:targetG.wp(targetG.R+0.55,targetS),
        targetDirection:targetG.fwd,
        samples:Math.max(18,state.filletSeg*4),
        handleScale:baseHandle+attempt*0.10+laneOffset*0.02,
        maxProgress:0.54+attempt*0.004,
      });
      const safe=trimBeforeOpposingStraight(candidate,opposingG,fromG.laneW/2,opposingLeftLanes);
      const length=polylineLength(safe);
      if(length>bestLength) { bestLength=length; bestPath=safe; }
      if(length>=desiredLength) { bestPath=trimPolyline(safe,desiredLength); break; }
    }
    // The opposing through carriageway remains the hard limit. In a compact
    // junction, retain the longest safe pocket once it is still useful rather
    // than extending it into a through lane or hiding it entirely.
    const minimumUsefulLength=Math.max(7,minLength*0.82);
    paths.push(bestLength>=minimumUsefulLength ? trimPolyline(bestPath,maxLength) : []);
  }
  if(paths.length===1){
    addPathWaitingArea(paths[0],fromG.laneW,'left');
    return;
  }

  const strips=paths.map(path=>addPathWaitingArea(path,fromG.laneW,'left',{drawSideLines:false}));
  if(strips.some(strip=>!strip)) return;
  const first=averagePathGap(strips[0].left,strips[1].right);
  const second=averagePathGap(strips[0].right,strips[1].left);
  if(first<=second){
    addDashedPath(strips[0].right);
    addDashedPath(averagePaths(strips[0].left,strips[1].right));
    addDashedPath(strips[1].left);
  }else{
    addDashedPath(strips[0].left);
    addDashedPath(averagePaths(strips[0].right,strips[1].left));
    addDashedPath(strips[1].right);
  }
}

// traffic light head with 3 lamps (returns {group, lamps:[red,yellow,green materials]})
function buildTrafficLight(){
  const group = new THREE.Group();
  const poleMat = matStd(COLORS.poleGray,0.5);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09,0.11,4.3,10), poleMat);
  pole.position.y=2.15; pole.castShadow=true;
  group.add(pole);
  const housing = new THREE.Mesh(new THREE.BoxGeometry(0.55,1.5,0.4), matStd(COLORS.lightHousing,0.4));
  housing.position.set(0,3.9,0.18); housing.castShadow=true;
  group.add(housing);
  const lampGeo = new THREE.CircleGeometry(0.16,16);
  const cols = [0xff3b30,0xffcc33,0x33d17a];
  const dimCols = [0x4a1414,0x4a3c14,0x144a29];
  const lamps=[];
  for(let i=0;i<3;i++){
    const mat = new THREE.MeshStandardMaterial({color:dimCols[i], emissive:dimCols[i], emissiveIntensity:0.3, roughness:0.5});
    const m = new THREE.Mesh(lampGeo, mat);
    m.position.set(0, 4.45-i*0.5, 0.39);
    group.add(m);
    lamps.push({mesh:m, on:cols[i], off:dimCols[i]});
  }
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.16,0.2,0.25,10), poleMat);
  base.position.y=0.12;
  group.add(base);
  return {group, lamps};
}

// ---------------------------------------------------------------- MAIN GENERATE
const trafficLights = [];
function clearWorld(){
  worldGroup.traverse(obj=>{
    if(obj.geometry) obj.geometry.dispose();
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    materials.filter(Boolean).forEach(material=>{
      if(!Object.values(matCache).includes(material)) material.dispose();
    });
  });
  worldGroup.clear();
}
function regenerate(){
  clearWorld();
  trafficLights.length = 0;
  const sceneRandom = createSeededRandom(state.scenerySeed);

  const arms = state.arms.slice().sort((a,b)=>a.angle-b.angle);
  const geoms = arms.map(computeArmGeom);
  updateArmRadii(geoms);
  updateCornerTrims(geoms);
  const n = geoms.length;
  if(n<2) return;

  // available movement types per arm (based on which other arms are reachable as straight/left/right)
  const availPerArm = geoms.map((g,i)=>{
    const set = new Set();
    for(let j=0;j<n;j++){ if(j===i) continue; if(geoms[j].arm.laneOut<=0) continue;
      const m = classifyMovement(g, geoms[j]);
      if(m.type!=='uturn') set.add(m.type);
    }
    return set;
  });
  const leftTargets=geoms.map(g=>findMovementTarget(g,geoms,'left'));
  const straightTargets=geoms.map(g=>findMovementTarget(g,geoms,'straight'));
  const rightTargets=geoms.map(g=>findMovementTarget(g,geoms,'right'));

  // ---- arm road quads + median + markings + arrows + crosswalk + stop line
  geoms.forEach((g,i)=>{
    const arm = g.arm;
    if(arm.laneIn<=0 && arm.laneOut<=0) return;
    const rightTarget=rightTargets[i];
    const dedicatedRightLane=rightTurnLaneCapacity(arm,rightTarget)>0;
    const crosswalkStart=g.R+0.7;
    const crosswalkEnd=Math.min(g.R+4.2,state.armLength-1.8);
    const hasCrosswalkSpace=crosswalkEnd-crosswalkStart>1.2;
    const stopU=hasCrosswalkSpace ? crosswalkEnd+0.45 : g.R+0.45;
    // Waiting-area markings begin after the pedestrian crossing, on the
    // intersection side. They must not originate at the upstream stop line
    // or run across the zebra crossing.
    const waitingAreaStartU=hasCrosswalkSpace ? crosswalkStart-0.2 : stopU-0.22;
    const stopLineWidth=0.5;
    // Longitudinal lane markings must end before the stop line instead of
    // continuing through it and across the pedestrian crossing.
    const laneLineStart=stopU+stopLineWidth/2+0.05;
    const facilityStart=stopU+0.5;
    // pavement
    const pav = buildQuad(g.nearLeft, g.farLeft, g.farRight, g.nearRight, 0.01, COLORS.asphalt, 0.95);
    if(pav) worldGroup.add(pav);

    // Per-arm center separation. Only planted medians reserve physical width.
    if(arm.centerMode==='planted' && g.medW>0.15){
      const island=buildMedianIsland(g,facilityStart);
      if(island) worldGroup.add(island);
    } else if(arm.laneIn>0 && arm.laneOut>0 && (arm.centerMode==='doubleYellow' || arm.centerMode==='doubleYellowRail')){
      const lineStart=facilityStart;
      const lineEnd=state.armLength;
      const dl1=boxAlong(g.wp(lineStart,0.1),g.wp(lineEnd,0.1),{lateral:0,width:0.1,height:0.01,yBottom:0.015,color:COLORS.yellow,rough:0.6,extend:0});
      const dl2=boxAlong(g.wp(lineStart,-0.1),g.wp(lineEnd,-0.1),{lateral:0,width:0.1,height:0.01,yBottom:0.015,color:COLORS.yellow,rough:0.6,extend:0});
      if(dl1) worldGroup.add(dl1);
      if(dl2) worldGroup.add(dl2);
      if(arm.centerMode==='doubleYellowRail') addGuardrail(g,facilityStart+0.7,state.armLength-0.7,0);
    }

    // lane divider lines (dashed) + outer solid edge, for inbound block
    function drawLaneLines(count, sign){ // sign=-1 inbound, +1 outbound
      for(let k=1;k<count;k++){
        const s = sign*(g.medW/2 + k*g.laneW);
        // dashed
        const dashLen=2.6, gapLen=2.2;
        let u=laneLineStart;
        while(u<state.armLength-1){
          const u2=Math.min(u+dashLen,state.armLength-1);
          const seg = boxAlong(g.wp(u,s), g.wp(u2,s), {lateral:0,width:0.12,height:0.008,yBottom:0.015,color:COLORS.white,rough:0.6,extend:0});
          if(seg) worldGroup.add(seg);
          u += dashLen+gapLen;
        }
      }
      if(count>0){
        const sOuter = sign*(g.medW/2 + count*g.laneW-0.1);
        const edge = boxAlong(g.wp(laneLineStart,sOuter), g.wp(state.armLength,sOuter), {lateral:0,width:0.12,height:0.008,yBottom:0.015,color:COLORS.white,rough:0.6,extend:0});
        if(edge) worldGroup.add(edge);
      }
    }
    drawLaneLines(arm.laneIn, -1);
    drawLaneLines(arm.laneOut, 1);

    // Names are from the viewpoint of standing at the outer end facing the intersection.
    const sideRailStart=stopU+1.2;
    const sideRailEnd=state.armLength-0.7;
    if(arm.leftGuardrail) addGuardrail(g,sideRailStart,sideRailEnd,g.outOuterS-0.22,0.12,0.82);
    if(arm.rightGuardrail) addGuardrail(g,sideRailStart,sideRailEnd,g.inOuterS+0.22,0.12,0.82);

    // stop line (inbound only)
    if(arm.laneIn>0){
      const s0=-(g.medW/2), s1=-(g.medW/2+arm.laneIn*g.laneW);
      const sl = boxAlong(g.wp(stopU,s0), g.wp(stopU,s1), {lateral:0,width:stopLineWidth,height:0.01,yBottom:0.09,color:COLORS.white,rough:0.6,extend:0});
      if(sl) worldGroup.add(sl);
    }

    // crosswalk
    if(state.showCrosswalk && hasCrosswalkSpace && (arm.laneIn>0||arm.laneOut>0)){
      const sMin=g.outOuterS, sMax=g.inOuterS;
      const uNear=crosswalkStart, uFar=crosswalkEnd;
      const stripeW=0.5, gap=0.45;
      let s=sMin+stripeW/2+0.3;
      while(s < sMax-0.3){
        const bar = boxAlong(g.wp(uNear,s), g.wp(uFar,s), {lateral:0,width:stripeW,height:0.006,yBottom:0.014,color:COLORS.white,rough:0.6,extend:0});
        if(bar) worldGroup.add(bar);
        s += stripeW+gap;
      }
    }

    const leftTarget=leftTargets[i];
    const dedicatedLeftLanes=arm.waitingArea==='left' ? leftTurnLaneCapacity(arm,leftTarget) : 0;
    const movementSets=arm.laneIn>0
      ? laneMovementSets(arm.laneIn,availPerArm[i],dedicatedLeftLanes,dedicatedRightLane)
      : [];

    // Waiting areas are explicit per approach. Right-turn movements never
    // receive one; left-turn areas follow the target lane and stop at the
    // intersection centre, while the rarer straight variant remains linear.
    if(state.showWaitingAreas&&state.showLights&&arm.laneIn>0){
      if(arm.waitingArea==='left'&&dedicatedLeftLanes>0){
        const opposingIndex=straightTargets[i] ? geoms.indexOf(straightTargets[i]) : -1;
        const opposingLeftLanes=opposingIndex>=0
          ? opposingLeftLaneCapacity(geoms[opposingIndex],leftTargets[opposingIndex])
          : 0;
        addLeftWaitingAreas(g,leftTarget,straightTargets[i],waitingAreaStartU,dedicatedLeftLanes,opposingLeftLanes);
      }else if(arm.waitingArea==='straight'){
        const straightOnly=movementSets
          .map((set,lane)=>({set,lane}))
          .filter(({set})=>set.size===1&&set.has('straight'))
          .map(({lane})=>lane);
        if(straightOnly.length){
          addStraightWaitingArea(g,waitingAreaStartU,straightOnly[0],straightOnly.at(-1));
        }
      }
    }

    // arrows
    if(state.showArrows && arm.laneIn>0){
      const sets = movementSets;
      const uTip=stopU+1.3;
      const uTail=Math.min(uTip+3.4,state.armLength-0.8);
      if(uTail-uTip>1.5){
        for(let k=0;k<arm.laneIn;k++){
          const s = -(g.medW/2 + (k+0.5)*g.laneW);
          const grp = buildArrowMesh(g, uTail, uTip, s, [...sets[k]]);
          worldGroup.add(grp);
        }
      }
    }
  });

  // ---- central polygon + curb strips (with fillets)
  // Walking CCW (arms sorted by ascending angle): the gap between arm i and the
  // next arm j is bounded by arm i's "left" curb edge (nearLeft, its CCW-facing
  // side) and arm j's "right" curb edge (nearRight, its CW-facing side) - these
  // are the two curb points that are actually geometrically adjacent.
  const filletPts = [];
  for(let i=0;i<n;i++){
    const j=(i+1)%n;
    const gi=geoms[i], gj=geoms[j];
    const pts = fillet(gi.nearLeft, scl(gi.fwd,-1), gj.nearRight, gj.fwd, state.filletSeg)
      .map(p=>constrainFilletPoint(p,gi,gj));
    filletPts.push(pts);
  }
  const centerPoly = [];
  for(let i=0;i<n;i++){
    // cross the road's own stop-line "cross-section" (nearRight -> nearLeft),
    // then the connecting fillet curve out to the next road's nearRight.
    centerPoly.push(geoms[i].nearRight, geoms[i].nearLeft, ...filletPts[i]);
  }
  const centerMesh = buildFlatPoly(centerPoly, [], 0.012, COLORS.asphalt, {rough:0.95});
  if(centerMesh) worldGroup.add(centerMesh);

  // curb + sidewalk strips per gap: from arm i's far-left corner, in along its
  // left edge to the curb, around the connecting fillet, then back out along
  // arm j's right edge to its far-right corner. This path only ever runs along
  // the outer edges of the roads + the corner curve - never through the
  // intersection interior - so sidewalks can never appear in the middle.
  for(let i=0;i<n;i++){
    const j=(i+1)%n;
    const gi=geoms[i], gj=geoms[j];
    const path = [gi.farLeft, gi.nearLeft, ...filletPts[i], gj.nearRight, gj.farRight];
    if(state.showSidewalk){
      const sw = buildPathStrip(path, state.sidewalkWidth, 0.32+state.sidewalkWidth/2);
      if(sw) worldGroup.add(sw);
    }
    for(let k=0;k<path.length-1;k++){
      const curb = boxAlong(path[k],path[k+1],{lateral:0,width:0.32,height:0.15,yBottom:0.0,color:COLORS.curb,rough:0.85,extend:0.05,castShadow:true});
      if(curb) worldGroup.add(curb);
    }
  }

  // ---- physically separated right-turn lanes and their triangular islands
  geoms.forEach((g,i)=>{
    if(rightTurnLaneCapacity(g.arm,rightTargets[i])>0) addRightTurnFacility(g,rightTargets[i]);
  });

  // ---- traffic lights (one per arm, near-right corner, pushed outward)
  if(state.showLights){
    geoms.forEach((g)=>{
      if(g.arm.laneIn<=0) return;
      const pos = g.wp(g.R+0.6, g.outOuterS-1.1);
      const {group, lamps} = buildTrafficLight();
      group.position.set(pos.x,0,pos.y);
      // Face drivers approaching from the outer end of the arm.
      group.rotation.y = Math.atan2(g.fwd.x, g.fwd.y);
      worldGroup.add(group);
      trafficLights.push({lamps});
    });
  }

  // ---- simple street lamps at outer fillet apex points
  for(let i=0;i<n;i++){
    const pts = filletPts[i];
    if(!pts.length) continue;
    const apex = pts[Math.floor(pts.length/2)];
    const dirOut = len(apex)>0.01 ? scl(apex,1/len(apex)) : v2(1,0);
    const lp = add(apex, scl(dirOut, 1.6+state.sidewalkWidth*0.6));
    const poleMat = matStd(0x2c3036,0.5);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05,0.07,3.6,8), poleMat);
    pole.position.set(lp.x,1.8,lp.y); pole.castShadow=true;
    worldGroup.add(pole);
    const armMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.04,0.04,0.9,6), poleMat);
    armMesh.rotation.z=Math.PI/2.6;
    armMesh.position.set(lp.x+0.35*dirOut.x, 3.5, lp.y+0.35*dirOut.y);
    worldGroup.add(armMesh);
    const lampMat = new THREE.MeshStandardMaterial({color:0xfff1c2, emissive:0xffdd88, emissiveIntensity:0.9, roughness:0.4});
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.14,10,8), lampMat);
    lamp.position.set(lp.x+0.75*dirOut.x, 3.35, lp.y+0.75*dirOut.y);
    worldGroup.add(lamp);
  }

  // ---- buildings scattered outside road envelope
  if(state.showBuildings){
    let placed=0, tries=0;
    while(placed<12 && tries<400){
      tries++;
      const ang = sceneRandom()*Math.PI*2;
      const rad = state.armLength+10 + sceneRandom()*45;
      const p = v2(Math.cos(ang)*rad, Math.sin(ang)*rad);
      if(pointBlockedByRoad(p, geoms)) continue;
      const w = 5+sceneRandom()*9, d=5+sceneRandom()*9, h=4+sceneRandom()*22;
      const color = COLORS.buildingBase[Math.floor(sceneRandom()*COLORS.buildingBase.length)];
      const b = new THREE.Mesh(new THREE.BoxGeometry(w,h,d), matStd(color,0.8));
      b.position.set(p.x, h/2, p.y);
      b.rotation.y = sceneRandom()*Math.PI*2;
      b.castShadow=true; b.receiveShadow=true;
      worldGroup.add(b);
      // roof accent
      const roof = new THREE.Mesh(new THREE.BoxGeometry(w*1.02,0.3,d*1.02), matStd(0x2a2d33,0.9));
      roof.position.set(p.x,h+0.15,p.y); roof.rotation.y=b.rotation.y;
      worldGroup.add(roof);
      placed++;
    }
    // scattered trees
    let tPlaced=0, tTries=0;
    while(tPlaced<16 && tTries<300){
      tTries++;
      const ang = sceneRandom()*Math.PI*2;
      const rad = state.armLength*0.55 + sceneRandom()*(state.armLength*0.6);
      const p = v2(Math.cos(ang)*rad, Math.sin(ang)*rad);
      if(pointBlockedByRoad(p, geoms)) continue;
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.13,0.17,1.6,6), matStd(0x5a4330,0.9));
      trunk.position.set(p.x,0.8,p.y); trunk.castShadow=true;
      worldGroup.add(trunk);
      const foliage = new THREE.Mesh(new THREE.ConeGeometry(1.3,2.6,8), matStd(0x2f6b3a,0.9));
      foliage.position.set(p.x,2.6,p.y); foliage.castShadow=true;
      worldGroup.add(foliage);
      tPlaced++;
    }
  }

  gridHelper.visible = state.showGrid;
  updateProjectInsights();
}

// ---------------------------------------------------------------- ANIMATION LOOP (traffic light phase)
const GREEN=4.2, YELLOW=1.0;
let trafficTime = 0;
let lastFrame = performance.now();
function animate(now=performance.now()){
  requestAnimationFrame(animate);
  const delta = Math.min(0.1,(now-lastFrame)/1000);
  lastFrame = now;
  if(!state.trafficPaused) trafficTime += delta*state.trafficSpeed;
  const t = trafficTime;
  const n = trafficLights.length;
  if(n>0){
    const cycle = n*(GREEN+YELLOW);
    const tt = t % cycle;
    const activeIdx = Math.floor(tt/(GREEN+YELLOW));
    const within = tt - activeIdx*(GREEN+YELLOW);
    trafficLights.forEach((tl,idx)=>{
      let mode = 'red';
      if(idx===activeIdx) mode = within<GREEN ? 'green':'yellow';
      const on = mode==='red'?0:(mode==='yellow'?1:2);
      tl.lamps.forEach((lampObj,i)=>{
        const isOn = i===on;
        lampObj.mesh.material.color.setHex(isOn?lampObj.on:lampObj.off);
        lampObj.mesh.material.emissive.setHex(isOn?lampObj.on:lampObj.off);
        lampObj.mesh.material.emissiveIntensity = isOn?1.6:0.25;
      });
    });
  }
  renderer.render(scene, activeCam);
}
animate();

// ---------------------------------------------------------------- UI WIRING
let regenerateFrame=0;
let saveTimer=0;
let toastTimer=0;

function scheduleRegenerate(){
  cancelAnimationFrame(regenerateFrame);
  regenerateFrame=requestAnimationFrame(()=>{ regenerateFrame=0; regenerate(); });
}

function showToast(message){
  const toast=document.getElementById('toast');
  toast.textContent=message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>toast.classList.remove('show'),2600);
}

function updateHistoryButtons(){
  document.getElementById('undoBtn').disabled=!history.canUndo;
  document.getElementById('redoBtn').disabled=!history.canRedo;
}

function updateProjectInsights(){
  const stats=getProjectStats(state);
  const validation=validateProject(state);
  document.getElementById('statArms').textContent=stats.arms;
  document.getElementById('statLanes').textContent=stats.lanes;
  document.getElementById('statArea').textContent=stats.roadArea.toLocaleString('zh-CN')+'㎡';
  document.getElementById('armCountBadge').textContent=stats.arms;

  const status=document.getElementById('validationStatus');
  const message=validation.errors[0] || validation.warnings[0] || '拓扑检查通过';
  status.lastChild.textContent=message;
  status.classList.toggle('warning',!validation.valid || validation.warnings.length>0);
  status.classList.toggle('ok',validation.valid && validation.warnings.length===0);
  document.title=(state.projectName || '未命名路口')+' · 路口工坊';
  updateHistoryButtons();
}

function scheduleSave(){
  const saveState=document.getElementById('saveState');
  saveState.classList.add('saving');
  saveState.lastElementChild.textContent='正在保存…';
  clearTimeout(saveTimer);
  saveTimer=setTimeout(()=>{
    const saved=saveLocalProject(state);
    saveState.classList.remove('saving');
    saveState.lastElementChild.textContent=saved?'已自动保存':'浏览器存储不可用';
  },320);
}

function recordChange(key=''){
  if(history.record(state,key)){
    scheduleSave();
    updateProjectInsights();
  }
}

function formatSliderValue(value,digits){
  return Number(value).toFixed(digits).replace(/\.00$/,'').replace(/(\.\d)0$/,'$1');
}

const sliderConfigs=[
  ['laneWidth','laneWidth',2,true],
  ['intersectionSize','intersectionSize',0,true],
  ['armLength','armLength',0,true],
  ['sidewalkWidth','sidewalkWidth',2,true],
  ['filletSeg','filletSeg',0,true],
];

function syncSlider(id,key,digits,shouldRegenerate){
  const el=document.getElementById(id);
  const tag=document.getElementById(id+'V');
  const update=()=>{
    state[key]=Number(el.value);
    if(key==='intersectionSize'){
      const requiredArmLength=Math.ceil(state.intersectionSize/2+8);
      if(state.armLength<requiredArmLength){
        state.armLength=requiredArmLength;
        const armLengthInput=document.getElementById('armLength');
        const armLengthValue=document.getElementById('armLengthV');
        armLengthInput.value=state.armLength;
        armLengthValue.textContent=formatSliderValue(state.armLength,0);
      }
    }
    tag.textContent=formatSliderValue(el.value,digits);
    if(shouldRegenerate) scheduleRegenerate();
  };
  el.addEventListener('input',update);
  el.value=state[key];
  tag.textContent=formatSliderValue(el.value,digits);
}

sliderConfigs.forEach(config=>syncSlider(...config));

const layerIds=['showArrows','showCrosswalk','showWaitingAreas','showLights','showSidewalk','showBuildings'];
layerIds.forEach(id=>{
  const el=document.getElementById(id);
  el.checked=Boolean(state[id]);
  el.addEventListener('change',()=>{
    state[id]=el.checked;
    regenerate();
  });
});

const gridToggle=document.getElementById('showGrid');
gridToggle.checked=state.showGrid;
gridToggle.addEventListener('change',()=>{
  state.showGrid=gridToggle.checked;
  gridHelper.visible=state.showGrid;
  updateProjectInsights();
});

const projectNameInput=document.getElementById('projectName');
projectNameInput.value=state.projectName;
projectNameInput.addEventListener('input',()=>{
  state.projectName=projectNameInput.value.slice(0,40) || '未命名路口';
  updateProjectInsights();
});

const seedInput=document.getElementById('scenerySeed');
seedInput.value=state.scenerySeed;
seedInput.addEventListener('change',()=>{
  state.scenerySeed=Math.min(99999999,Math.max(1,Math.round(Number(seedInput.value)||1)));
  seedInput.value=state.scenerySeed;
  regenerate();
});

document.getElementById('seedBtn').addEventListener('click',()=>{
  state.scenerySeed=1+Math.floor(Math.random()*99999998);
  seedInput.value=state.scenerySeed;
  regenerate();
});

const trafficSpeed=document.getElementById('trafficSpeed');
const trafficSpeedValue=document.getElementById('trafficSpeedV');
trafficSpeed.value=state.trafficSpeed;
trafficSpeedValue.textContent=formatSliderValue(state.trafficSpeed,2);
trafficSpeed.addEventListener('input',()=>{
  state.trafficSpeed=Number(trafficSpeed.value);
  trafficSpeedValue.textContent=formatSliderValue(state.trafficSpeed,2);
});

function syncTrafficButton(){
  const button=document.getElementById('trafficPauseBtn');
  button.textContent=state.trafficPaused?'继续信号灯':'暂停信号灯';
  button.classList.toggle('active',state.trafficPaused);
}

document.getElementById('trafficPauseBtn').addEventListener('click',()=>{
  state.trafficPaused=!state.trafficPaused;
  syncTrafficButton();
});

function angleDistance(a,b){ return Math.abs(((a-b+540)%360)-180); }
function normaliseArmValue(field,value){
  if(field==='angle') return ((Math.round(value)%360)+360)%360;
  if(field==='medianWidth') return Math.min(4,Math.max(0,Math.round(value*10)/10));
  if(field==='leftTurnLanes') return Math.min(2,Math.max(1,Math.round(value)));
  return Math.min(6,Math.max(0,Math.round(value)));
}

const CENTER_MODES=new Set(['planted','doubleYellowRail','doubleYellow']);
const WAITING_AREA_TYPES=new Set(['none','left','straight']);
const RIGHT_ISLAND_TYPES=new Set(['planted','hatched']);
function randomCenterMode(){
  const value=Math.random();
  if(value<0.35) return 'planted';
  if(value<0.75) return 'doubleYellow';
  return 'doubleYellowRail';
}

function makeArm(angle,laneIn=2,laneOut=2){
  return {
    angle,laneIn,laneOut,
    centerMode:randomCenterMode(),
    medianWidth:Math.round((0.8+Math.random()*1.4)*10)/10,
    waitingArea:'none',
    leftTurnLanes:1,
    rightTurnLane:true,
    rightTurnIsland:Math.random()<0.5?'planted':'hatched',
    leftGuardrail:Math.random()<0.25,
    rightGuardrail:Math.random()<0.25,
  };
}

function normaliseArm(arm){
  if(!CENTER_MODES.has(arm.centerMode)) arm.centerMode='doubleYellow';
  if(!WAITING_AREA_TYPES.has(arm.waitingArea)) arm.waitingArea='none';
  if(!RIGHT_ISLAND_TYPES.has(arm.rightTurnIsland)) arm.rightTurnIsland='planted';
  arm.rightTurnLane=Boolean(arm.rightTurnLane);
  arm.medianWidth=normaliseArmValue('medianWidth',Number.isFinite(+arm.medianWidth)?+arm.medianWidth:1);
  arm.leftTurnLanes=normaliseArmValue('leftTurnLanes',Number.isFinite(+arm.leftTurnLanes)?+arm.leftTurnLanes:1);
  arm.leftGuardrail=Boolean(arm.leftGuardrail);
  arm.rightGuardrail=Boolean(arm.rightGuardrail);
  return arm;
}

function renderArmsList(){
  const wrap=document.getElementById('armsList');
  wrap.innerHTML='';
  state.arms.forEach((arm,idx)=>{
    normaliseArm(arm);
    const requiredLeftLanes=arm.leftTurnLanes+2;
    const waitingNote=arm.waitingArea==='left'&&arm.laneIn<requiredLeftLanes
      ? `当前配置至少需要 ${requiredLeftLanes} 条进入车道`
      : (arm.waitingArea==='straight'&&arm.laneIn<3 ? '至少需要一条独立直行车道' : '待转区仅在启用交通信号时显示');
    const hasRightTarget=state.arms.some((target,targetIndex)=>
      targetIndex!==idx && target.laneOut>0 && classifyArmMovement(arm,target).type==='right');
    const rightTurnNote=arm.rightTurnLane&&!hasRightTarget
      ? '没有可连接的右侧出口，右转专用道不会生成'
      : '最外侧进入车道将在停止线前分叉出右转专用道';
    const row=document.createElement('div');
    row.className='arm-row';
    row.innerHTML=
      '<div class="top"><span class="tag">分支 '+(idx+1)+'</span><button type="button" class="rm">删除</button></div>'+
      '<div class="grid">'+
        '<div><label>角度 °</label><input type="number" min="0" max="359" step="1" value="'+arm.angle+'" data-f="angle"></div>'+
        '<div><label>进入车道</label><input type="number" min="0" max="6" step="1" value="'+arm.laneIn+'" data-f="laneIn"></div>'+
        '<div><label>驶出车道</label><input type="number" min="0" max="6" step="1" value="'+arm.laneOut+'" data-f="laneOut"></div>'+
      '</div>'+
      '<div class="facility">'+
        '<div><label>中央分隔</label><select data-f="centerMode"'+(arm.laneIn>0&&arm.laneOut>0?'':' disabled')+'>'+
          '<option value="planted"'+(arm.centerMode==='planted'?' selected':'')+'>绿化隔离带</option>'+
          '<option value="doubleYellowRail"'+(arm.centerMode==='doubleYellowRail'?' selected':'')+'>双黄线 + 中央护栏</option>'+
          '<option value="doubleYellow"'+(arm.centerMode==='doubleYellow'?' selected':'')+'>仅双黄线</option>'+
        '</select></div>'+
        '<div class="median-width"'+(arm.centerMode==='planted'?'':' hidden')+'><label>绿化带宽 m</label><input type="number" min="0" max="4" step="0.1" value="'+arm.medianWidth+'" data-f="medianWidth"></div>'+
      '</div>'+
      '<div class="facility waiting-facility">'+
        '<div><label>待转区类型</label><select data-f="waitingArea">'+
          '<option value="none"'+(arm.waitingArea==='none'?' selected':'')+'>无</option>'+
          '<option value="left"'+(arm.waitingArea==='left'?' selected':'')+(arm.laneIn<3?' disabled':'')+'>左转待转区</option>'+
          '<option value="straight"'+(arm.waitingArea==='straight'?' selected':'')+(arm.laneIn<3?' disabled':'')+'>直行待行区</option>'+
        '</select></div>'+
        '<div class="left-turn-lanes"'+(arm.waitingArea==='left'?'':' hidden')+'><label>左转专用道</label><select data-f="leftTurnLanes">'+
          '<option value="1"'+(arm.leftTurnLanes===1?' selected':'')+'>1 条</option>'+
          '<option value="2"'+(arm.leftTurnLanes===2?' selected':'')+(arm.laneIn<4?' disabled':'')+'>2 条</option>'+
        '</select></div>'+
      '</div>'+
      '<div class="facility right-turn-facility">'+
        '<div><label><input type="checkbox" data-f="rightTurnLane"'+(arm.rightTurnLane?' checked':'')+(arm.laneIn<1?' disabled':'')+'>右转专用道</label></div>'+
        '<div class="right-turn-island"'+(arm.rightTurnLane?'':' hidden')+'><label>三角区域</label><select data-f="rightTurnIsland">'+
          '<option value="planted"'+(arm.rightTurnIsland==='planted'?' selected':'')+'>绿化带</option>'+
          '<option value="hatched"'+(arm.rightTurnIsland==='hatched'?' selected':'')+'>导流线区</option>'+
        '</select></div>'+
      '</div>'+
      '<p class="waiting-note">'+waitingNote+'</p>'+
      '<p class="right-turn-note">'+rightTurnNote+'</p>'+
      '<div class="rail-options">'+
        '<label><input type="checkbox" data-f="leftGuardrail"'+(arm.leftGuardrail?' checked':'')+'>面向路口左侧护栏</label>'+
        '<label><input type="checkbox" data-f="rightGuardrail"'+(arm.rightGuardrail?' checked':'')+'>面向路口右侧护栏</label>'+
      '</div>';

    row.querySelector('.rm').addEventListener('click',()=>{
      if(state.arms.length<=2){
        showToast('至少需要保留 2 个道路分支');
        return;
      }
      state.arms.splice(idx,1);
      renderArmsList();
      regenerate();
    });

    row.querySelectorAll('input[type=number]').forEach(input=>{
      input.addEventListener('change',()=>{
        const field=input.dataset.f;
        const parsed=Number(input.value);
        if(!Number.isFinite(parsed)){
          input.value=arm[field];
          return;
        }
        const next=normaliseArmValue(field,parsed);
        if(field==='angle' && state.arms.some(other=>other!==arm && angleDistance(other.angle,next)<10)){
          showToast('道路分支之间至少需要相隔 10°');
          input.value=arm.angle;
          return;
        }
        if((field==='laneIn' || field==='laneOut') && next===0){
          const counterpart=field==='laneIn'?'laneOut':'laneIn';
          if(arm[counterpart]===0){
            showToast('每个道路分支至少需要一条车道');
            input.value=arm[field];
            return;
          }
        }
        arm[field]=next;
        input.value=next;
        if(field==='laneIn' || field==='laneOut'){
          renderArmsList();
        }
        regenerate();
      });
    });

    row.querySelector('[data-f=centerMode]').addEventListener('change',event=>{
      if(arm.laneIn<=0 || arm.laneOut<=0) return;
      arm.centerMode=event.target.value;
      row.querySelector('.median-width').hidden=arm.centerMode!=='planted';
      regenerate();
    });

    row.querySelector('[data-f=waitingArea]').addEventListener('change',event=>{
      arm.waitingArea=WAITING_AREA_TYPES.has(event.target.value)?event.target.value:'none';
      renderArmsList();
      regenerate();
    });

    row.querySelector('[data-f=leftTurnLanes]').addEventListener('change',event=>{
      arm.leftTurnLanes=normaliseArmValue('leftTurnLanes',Number(event.target.value));
      renderArmsList();
      regenerate();
    });

    row.querySelector('[data-f=rightTurnLane]').addEventListener('change',event=>{
      arm.rightTurnLane=event.target.checked;
      renderArmsList();
      regenerate();
    });

    row.querySelector('[data-f=rightTurnIsland]').addEventListener('change',event=>{
      arm.rightTurnIsland=RIGHT_ISLAND_TYPES.has(event.target.value)?event.target.value:'planted';
      regenerate();
    });

    row.querySelectorAll('.rail-options input').forEach(input=>{
      input.addEventListener('change',()=>{
        arm[input.dataset.f]=input.checked;
        regenerate();
      });
    });
    wrap.appendChild(row);
  });
  document.getElementById('armCountBadge').textContent=state.arms.length;
}

document.getElementById('addArm').addEventListener('click',()=>{
  if(state.arms.length>=8){
    showToast('最多支持 8 个道路分支');
    return;
  }
  const usedAngles=state.arms.map(arm=>arm.angle);
  let angle=null;
  for(let candidate=0;candidate<360;candidate+=15){
    if(usedAngles.every(used=>angleDistance(used,candidate)>=20)){
      angle=candidate;
      break;
    }
  }
  if(angle===null){
    showToast('没有足够空间，请先调整现有分支角度');
    return;
  }
  state.arms.push(makeArm(angle));
  renderArmsList();
  regenerate();
});

document.getElementById('genBtn').addEventListener('click',()=>{
  regenerate();
  showToast('场景已重新生成');
});

document.getElementById('randBtn').addEventListener('click',()=>{
  const count=3+Math.floor(Math.random()*4);
  const offset=Math.random()*360;
  const spacing=360/count;
  const angles=Array.from({length:count},(_,index)=>
    Math.round((offset+index*spacing+(Math.random()-.5)*spacing*.35+360)%360));
  state.arms=angles.map(angle=>makeArm(
    angle,
    1+Math.floor(Math.random()*3),
    1+Math.floor(Math.random()*3),
  ));
  state.scenerySeed=1+Math.floor(Math.random()*99999998);
  state.intersectionSize=sampleIntersectionSize(Math.random);
  seedInput.value=state.scenerySeed;
  document.getElementById('intersectionSize').value=state.intersectionSize;
  document.getElementById('intersectionSizeV').textContent=state.intersectionSize;
  renderArmsList();
  regenerate();
});

const presets={
  cross4:[{angle:0,laneIn:2,laneOut:2},{angle:90,laneIn:2,laneOut:2},{angle:180,laneIn:2,laneOut:2},{angle:270,laneIn:2,laneOut:2}],
  t3:[{angle:0,laneIn:2,laneOut:2},{angle:180,laneIn:2,laneOut:2},{angle:270,laneIn:2,laneOut:2}],
  y3:[{angle:0,laneIn:2,laneOut:1},{angle:120,laneIn:1,laneOut:2},{angle:240,laneIn:2,laneOut:2}],
  offset4:[{angle:0,laneIn:2,laneOut:2},{angle:78,laneIn:1,laneOut:1},{angle:180,laneIn:2,laneOut:2},{angle:262,laneIn:2,laneOut:1}],
  five:[{angle:0,laneIn:2,laneOut:2},{angle:70,laneIn:1,laneOut:1},{angle:150,laneIn:2,laneOut:2},{angle:220,laneIn:1,laneOut:2},{angle:290,laneIn:2,laneOut:1}],
};

document.querySelectorAll('[data-preset]').forEach(button=>{
  button.addEventListener('click',()=>{
    state.arms=presets[button.dataset.preset].map(arm=>makeArm(arm.angle,arm.laneIn,arm.laneOut));
    state.intersectionSize=sampleIntersectionSize(Math.random);
    document.getElementById('intersectionSize').value=state.intersectionSize;
    document.getElementById('intersectionSizeV').textContent=state.intersectionSize;
    renderArmsList();
    regenerate();
  });
});

function syncAllControls(){
  projectNameInput.value=state.projectName;
  sliderConfigs.forEach(([id,key,digits])=>{
    const element=document.getElementById(id);
    element.value=state[key];
    document.getElementById(id+'V').textContent=formatSliderValue(state[key],digits);
  });
  layerIds.forEach(id=>{ document.getElementById(id).checked=Boolean(state[id]); });
  gridToggle.checked=state.showGrid;
  gridHelper.visible=state.showGrid;
  seedInput.value=state.scenerySeed;
  trafficSpeed.value=state.trafficSpeed;
  trafficSpeedValue.textContent=formatSliderValue(state.trafficSpeed,2);
  syncTrafficButton();
}

function applyProject(next,{record=true,message=''}={}){
  state=sanitizeProject(next);
  syncAllControls();
  renderArmsList();
  regenerate();
  if(record) recordChange();
  else scheduleSave();
  if(message) showToast(message);
}

function performUndo(){
  const previous=history.undo();
  if(previous) applyProject(previous,{record:false,message:'已撤销'});
  updateHistoryButtons();
}

function performRedo(){
  const next=history.redo();
  if(next) applyProject(next,{record:false,message:'已重做'});
  updateHistoryButtons();
}

document.getElementById('undoBtn').addEventListener('click',performUndo);
document.getElementById('redoBtn').addEventListener('click',performRedo);

document.addEventListener('input',event=>{
  const target=event.target;
  if(target===projectNameInput || target.closest?.('#panel')){
    queueMicrotask(()=>recordChange(target.id || target.dataset.f || 'input'));
  }
});

document.addEventListener('change',event=>{
  const target=event.target;
  if(target.closest?.('#panel')){
    queueMicrotask(()=>recordChange(target.id || target.dataset.f || 'change'));
  }
});

document.addEventListener('click',event=>{
  const mutator=event.target.closest?.('#addArm, #randBtn, #seedBtn, #trafficPauseBtn, [data-preset], .arm-row .rm');
  if(mutator) queueMicrotask(()=>recordChange(mutator.id || mutator.dataset.preset || 'topology'));
});

function setCameraMode(mode){
  topDownMode=mode==='top';
  activeCam=topDownMode?ortho:persp;
  document.getElementById('cam3d').classList.toggle('active',!topDownMode);
  document.getElementById('camtop').classList.toggle('active',topDownMode);
  if(topDownMode){
    ortho.position.set(camState.target.x,160,camState.target.z+0.001);
    ortho.lookAt(camState.target.x,0,camState.target.z);
  }
}

document.getElementById('cam3d').addEventListener('click',()=>setCameraMode('3d'));
document.getElementById('camtop').addEventListener('click',()=>setCameraMode('top'));
if(new URLSearchParams(window.location.search).get('view')==='top') setCameraMode('top');
document.getElementById('resetCameraBtn').addEventListener('click',()=>{
  camState.theta=Math.PI*0.28;
  camState.phi=1.02;
  camState.radius=78;
  camState.target.set(0,0,2);
  orthoHalfHeight=60;
  updatePerspCamera();
  updateOrthoProjection();
  if(topDownMode) setCameraMode('top');
  showToast('视角已重置');
});

document.getElementById('exportJsonBtn').addEventListener('click',()=>{
  const documentData=createProjectDocument(state);
  const blob=new Blob([JSON.stringify(documentData,null,2)],{type:'application/json;charset=utf-8'});
  downloadBlob(blob,slugifyProjectName(state.projectName)+'.intersection.json');
  saveLocalProject(state);
  showToast('项目文件已保存');
});

const fileInput=document.getElementById('fileInput');
document.getElementById('importBtn').addEventListener('click',()=>fileInput.click());
fileInput.addEventListener('change',async()=>{
  const file=fileInput.files?.[0];
  fileInput.value='';
  if(!file) return;
  if(file.size>2*1024*1024){
    showToast('项目文件不能超过 2 MB');
    return;
  }
  try{
    const imported=parseProjectDocument(await file.text());
    applyProject(imported,{record:true,message:'项目导入成功'});
  }catch(error){
    showToast(error instanceof Error?error.message:'项目导入失败');
  }
});

document.getElementById('shotBtn').addEventListener('click',()=>{
  renderer.render(scene,activeCam);
  renderer.domElement.toBlob(blob=>{
    if(!blob){
      showToast('图片导出失败');
      return;
    }
    downloadBlob(blob,slugifyProjectName(state.projectName)+'.png');
    showToast('当前视图已导出为 PNG');
  },'image/png');
});

document.getElementById('exportGlbBtn').addEventListener('click',()=>{
  const button=document.getElementById('exportGlbBtn');
  const label=button.textContent;
  button.disabled=true;
  button.textContent='导出中…';
  const exporter=new GLTFExporter();
  exporter.parse(
    worldGroup,
    result=>{
      const blob=new Blob([result],{type:'model/gltf-binary'});
      downloadBlob(blob,slugifyProjectName(state.projectName)+'.glb');
      button.disabled=false;
      button.textContent=label;
      showToast('三维场景已导出为 GLB');
    },
    error=>{
      console.error(error);
      button.disabled=false;
      button.textContent=label;
      showToast('GLB 导出失败');
    },
    {binary:true,onlyVisible:true},
  );
});

const helpDialog=document.getElementById('helpDialog');
document.getElementById('helpBtn').addEventListener('click',()=>helpDialog.showModal());

const confirmDialog=document.getElementById('confirmDialog');
document.getElementById('resetProjectBtn').addEventListener('click',()=>confirmDialog.showModal());
document.getElementById('confirmResetBtn').addEventListener('click',()=>{
  applyProject(createDefaultProject(),{record:true,message:'已恢复默认项目'});
});

const panel=document.getElementById('panel');
const panelToggle=document.getElementById('panelToggle');
function setPanelOpen(open){
  panel.classList.toggle('open',open);
  panelToggle.setAttribute('aria-expanded',String(open));
}
panelToggle.addEventListener('click',()=>setPanelOpen(!panel.classList.contains('open')));
document.getElementById('panelClose').addEventListener('click',()=>setPanelOpen(false));

window.addEventListener('keydown',event=>{
  const command=event.ctrlKey || event.metaKey;
  if(command && event.key.toLowerCase()==='s'){
    event.preventDefault();
    document.getElementById('exportJsonBtn').click();
  }else if(command && event.key.toLowerCase()==='z' && !event.shiftKey){
    event.preventDefault();
    performUndo();
  }else if(command && (event.key.toLowerCase()==='y' || (event.key.toLowerCase()==='z' && event.shiftKey))){
    event.preventDefault();
    performRedo();
  }else if(event.key==='Escape'){
    setPanelOpen(false);
  }
});

window.addEventListener('beforeunload',()=>saveLocalProject(state));
window.addEventListener('error',event=>{
  console.error(event.error || event.message);
  showToast('运行时出现异常，请尝试重新生成场景');
});

// ---------------------------------------------------------------- INIT
syncAllControls();
syncTrafficButton();
renderArmsList();
regenerate();
updateHistoryButtons();
saveLocalProject(state);
