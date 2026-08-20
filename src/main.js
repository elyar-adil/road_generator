import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import {
  createDefaultProject,
  createProjectDocument,
  createSeededRandom,
  getProjectStats,
  normaliseArmValue,
  parseProjectDocument,
  RIGHT_ISLAND_TYPES,
  RIGHT_TURN_MODES,
  RIGHT_TURN_TYPES,
  sampleIntersectionSize,
  sanitizeArm,
  sanitizeProject,
  slugifyProjectName,
  validateProject,
  WAITING_AREA_TYPES,
} from './state.js';
import {
  downloadBlob,
  loadLocalProject,
  ProjectHistory,
  saveLocalProject,
} from './project-store.js';
import {
  offsetPolyline,
} from './waiting-area.js';
import { normalize } from './geometry.js';
import { classifyArmMovement } from './road-movements.js';
import { computeLaneTopology } from './lane-topology.js';
import { buildRoadModel } from './road-model.js';
import { deriveRoadScene } from './lane-derive.js';
import { renderRoadScene, ROAD_THEME } from './render.js';
import {
  buildLaneTaper, buildSegmentSurface, buildSidewalkBounds,
  laneBundleBounds, placeStreetLights,
} from './segment.js';

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

// Lane-topology overlay: toggleable colored centreline graph visible in both
// the 3D perspective and top-down orthographic views.
const topologyGroup = new THREE.Group();
topologyGroup.visible = false;
scene.add(topologyGroup);
topologyGroup.renderOrder = 999;

// Diverge/merge corridor demo, composed from the reusable segment primitives.
const segmentGroup = new THREE.Group();
segmentGroup.visible = false;
scene.add(segmentGroup);

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

// ---------------------------------------------------------------- TOPOLOGY OVERLAY + SEGMENT DEMO
const MOVEMENT_COLORS = { straight:0x4aa3ff, left:0x37d17a, right:0xff6b4a };
const LANE_CENTERLINE_COLOR = 0xc3cad6;

function disposeGroup(group){
  group.traverse(obj=>{
    if(obj.geometry) obj.geometry.dispose();
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    materials.filter(Boolean).forEach(material=>{
      if(!Object.values(matCache).includes(material)) material.dispose();
    });
  });
}

function renderTopologyOverlay(geoms, facilities){
  disposeGroup(topologyGroup);
  topologyGroup.clear();
  topologyGroup.visible = state.showTopology;
  if(!state.showTopology || geoms.length<2) return;
  const topology = computeLaneTopology(geoms, {
    armLength: state.armLength,
    facilities: facilities || [],
  });
  topology.laneCenterlines.forEach(cl=>{
    if(cl.skip) return;
    for(let i=0;i<cl.path.length-1;i++){
      const seg = boxAlong(cl.path[i],cl.path[i+1],{
        lateral:0,width:0.12,height:0.05,yBottom:0.12,
        color:LANE_CENTERLINE_COLOR,rough:0.5,extend:0,
      });
      if(seg) topologyGroup.add(seg);
    }
  });
  topology.connections.forEach(conn=>{
    const color = MOVEMENT_COLORS[conn.movement] || 0xffffff;
    for(let i=0;i<conn.path.length-1;i++){
      const seg = boxAlong(conn.path[i],conn.path[i+1],{
        lateral:0,width:0.16,height:0.06,yBottom:0.13,
        color,rough:0.5,extend:0,
      });
      if(seg) topologyGroup.add(seg);
    }
  });
  topology.lanes.forEach(lane=>{
    const dotRadius = lane.side==='in' ? 0.16 : 0.12;
    const dotColor = lane.side==='in' ? 0xffd166 : 0x9b5de5;
    const dot = new THREE.Mesh(new THREE.SphereGeometry(dotRadius,10,10), matStd(dotColor,0.4));
    dot.position.set(lane.point.x, 0.16, lane.point.y);
    topologyGroup.add(dot);
  });
}

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

function addStrip(group, centreline, halfWidth, y, color, rough){
  const { ring } = buildSegmentSurface(centreline, halfWidth);
  const mesh = buildFlatPoly(ring, [], y, color, { rough });
  if(mesh) group.add(mesh);
  return mesh;
}

function addPathLine(group, path, width, yBottom, color){
  for(let i=0;i<path.length-1;i++){
    const seg = boxAlong(path[i],path[i+1],{
      lateral:0,width,height:0.01,yBottom,color,rough:0.6,extend:0,
    });
    if(seg) group.add(seg);
  }
}

// Diverge/merge corridor demo: a straight 3-lane carriageway that slims to 2
// lanes as one lane peels off into a paralleled side lane (3->2 diverge),
// keeping a constant-width offset lane, then widens back to 3 (2->3 merge).
// Sidewalks and street lights are laid along the same segment primitives,
// demonstrating how a single reusable abstraction dresses any road - and later
// an interchange ramp.
function buildSegmentDemo(){
  disposeGroup(segmentGroup);
  segmentGroup.clear();
  segmentGroup.visible = state.showSegmentDemo;
  if(!state.showSegmentDemo) return;

  const laneW = state.laneWidth;
  const { inOuterS, outOuterS } = laneBundleBounds(3, 3, laneW, 1.2);
  const halfWidth = (inOuterS - outOuterS) / 2;
  const origin = { point:{x:0,y:0}, fwd:{x:1,y:0}, left:{x:0,y:1} };
  // Full corridor centreline: 3 lanes from x=0..30, 2 lanes 30..104, 3 lanes 104...
  const centreline = Array.from({ length: 151 }, (_, i) => ({ x: i, y: 0 }));

  // Main carriageway surface for the full corridor length.
  addStrip(segmentGroup, centreline, halfWidth, 0.01, COLORS.asphalt, 0.95);

  // 3 -> 2 diverge: the outermost +left lane feathers off x=30..44.
  const diverge = buildLaneTaper({ origin, laneWidth:laneW, splitLanes:1, taperStart:30, taperEnd:44, side:1 });
  // The offset lane continues at constant width beside the corridor x=44..104.
  const offS = sideLateral(inOuterS, laneW);
  const offsetCentre = Array.from({ length: 61 }, (_, i) => ({ x: 44 + i, y: offS }));
  addStrip(segmentGroup, diverge.centreline, laneW / 2, 0.01, COLORS.asphalt, 0.95);
  addStrip(segmentGroup, offsetCentre, laneW / 2, 0.01, COLORS.asphalt, 0.95);

  // 2 -> 3 merge: the offset lane tapers back in to regain the 3rd lane x=104..118.
  const mergeOrigin = { point:{x:104,y:0}, fwd:{x:1,y:0}, left:{x:0,y:1} };
  const merge = buildLaneTaper({ origin:mergeOrigin, laneWidth:laneW, splitLanes:1, taperStart:0, taperEnd:14, side:1 });
  addStrip(segmentGroup, merge.centreline, laneW / 2, 0.01, COLORS.asphalt, 0.95);

  // Lane dividers on the main corridor (constant lane boundaries).
  [1, 2].forEach((k) => {
    const divider = offsetPolyline(centreline, k * laneW).left;
    addPathLine(segmentGroup, divider, 0.14, 0.02, COLORS.white);
  });
  // Outer edges of the 3-lane corridor.
  addPathLine(segmentGroup, offsetPolyline(centreline, inOuterS).left, 0.14, 0.02, COLORS.white);
  addPathLine(segmentGroup, offsetPolyline(centreline, outOuterS).right, 0.14, 0.02, COLORS.white);
  // Offset lane boundary (its +left edge).
  addPathLine(segmentGroup, offsetPolyline(offsetCentre, laneW / 2).left, 0.14, 0.02, COLORS.white);

  // Sidewalk edges along both sides of the full 3-lane corridor.
  const sw = buildSidewalkBounds(centreline, halfWidth, state.sidewalkWidth, 0.25);
  addStrip(segmentGroup, sw.left.outer, state.sidewalkWidth, -0.01, COLORS.sidewalk, 1);
  addStrip(segmentGroup, sw.right.outer, state.sidewalkWidth, -0.01, COLORS.sidewalk, 1);

  // Street lights along the corridor centreline.
  placeStreetLights(centreline, { spacing:22, start:12, end:170, lateral: halfWidth + 0.5 }).forEach(({ point, tangent })=>{
    const dirOut = normalize(tangent);
    const poleMat = matStd(0x2c3036,0.5);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05,0.07,3.6,8), poleMat);
    pole.position.set(point.x,1.8,point.y); pole.castShadow=true;
    segmentGroup.add(pole);
    const armMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.04,0.04,0.9,6), poleMat);
    armMesh.rotation.z = Math.PI/2.6;
    armMesh.position.set(point.x+0.35*dirOut.x, 3.5, point.y+0.35*dirOut.y);
    segmentGroup.add(armMesh);
    const lampMat = new THREE.MeshStandardMaterial({color:0xfff1c2, emissive:0xffdd88, emissiveIntensity:0.9, roughness:0.4});
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.14,10,8), lampMat);
    lamp.position.set(point.x+0.75*dirOut.x, 3.35, point.y+0.75*dirOut.y);
    segmentGroup.add(lamp);
  });
}

function sideLateral(inOuterS, laneW){
  // The pealed (outermost) lane centre sits just outside the reduced carriageway.
  return inOuterS - laneW + laneW / 2;
}
function regenerate(){
  clearWorld();
  trafficLights.length = 0;
  const sceneRandom = createSeededRandom(state.scenerySeed);

  // Layer 1: road model (geometry + connectivity + right-turn facilities).
  const model = buildRoadModel(state);
  const n = model.geoms.length;
  if(n<2){ renderTopologyOverlay(model.geoms, []); buildSegmentDemo(); updateProjectInsights(); return; }

  // Layer 2: lane graph (single source of truth for lanes/centreline/arrows).
  const topology = computeLaneTopology(model.geoms, {
    armLength: state.armLength,
    facilities: model.rightFacilities,
  });

  // Derivation: every visual detail as pure data.
  const derived = deriveRoadScene(model, state, sceneRandom, topology);

  // Render: map the derived scene to meshes.
  const { lampSets } = renderRoadScene(derived, worldGroup, ROAD_THEME);
  lampSets.forEach((lamps) => trafficLights.push({ lamps }));

  gridHelper.visible = state.showGrid;
  renderTopologyOverlay(model.geoms, model.rightFacilities);
  buildSegmentDemo();
  updateProjectInsights();
}

// ---------------------------------------------------------------- ANIMATION LOOP (traffic light phase)
const GREEN=4.2, YELLOW=1.0;
let trafficTime = 0;
const trafficLights = [];
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

const layerIds=['showArrows','showCrosswalk','showWaitingAreas','showLights','showSidewalk','showBuildings','showTopology','showSegmentDemo'];
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
    rightTurnLanes:1,
    rightTurnType:['direct','split','slip'][Math.floor(Math.random()*3)],
    rightTurnIsland:Math.random()<0.5?'planted':'hatched',
    leftGuardrail:Math.random()<0.25,
    rightGuardrail:Math.random()<0.25,
  };
}

function normaliseArm(arm){
  // Delegate to the single validation source of truth; copy the sanitized
  // fields back in place so the editor's live closures keep working.
  Object.assign(arm, sanitizeArm(arm));
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
      ? '没有可连接的右侧出口，右转设施不会生成'
      : arm.rightTurnType==='direct'
        ? '最右侧 '+arm.rightTurnLanes+' 条既有进口车道直接连接至右侧出口最外侧车道'
        : arm.rightTurnType==='split'
          ? '主线保持直行，在路口近端分出 '+arm.rightTurnLanes+' 条右转车道'
          : arm.rightTurnType==='slip'
            ? '上游分出 '+arm.rightTurnLanes+' 条右转辅路，绕岛后接右侧出口'
            : '启用后可选择直接连接、近端分流或右转辅路';
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
        '<div class="right-turn-options"'+(arm.rightTurnLane?'':' hidden')+'><label>右转形式</label><select data-f="rightTurnType">'+
          '<option value="direct"'+(arm.rightTurnType==='direct'?' selected':'')+'>既有车道直接连接</option>'+
          '<option value="split"'+(arm.rightTurnType==='split'?' selected':'')+'>近端分流右转车道</option>'+
          '<option value="slip"'+(arm.rightTurnType==='slip'?' selected':'')+'>远端分流右转辅路</option>'+
        '</select></div>'+
        '<div class="right-turn-options"'+(arm.rightTurnLane?'':' hidden')+'><label>右转车道</label><select data-f="rightTurnLanes">'+
          '<option value="1"'+(arm.rightTurnLanes===1?' selected':'')+'>1 条</option>'+
          '<option value="2"'+(arm.rightTurnLanes===2?' selected':'')+(arm.laneIn<2?' disabled':'')+'>2 条</option>'+
        '</select></div>'+
        '<div class="right-turn-options"'+(arm.rightTurnLane&&arm.rightTurnType!=='direct'?'':' hidden')+'><label>车道方案</label><select data-f="rightTurnMode">'+
          '<option value="branch"'+(arm.rightTurnMode!=='dedicated'?' selected':'')+'>方案2：主线直行 + 独立右转分支</option>'+
          '<option value="dedicated"'+(arm.rightTurnMode==='dedicated'?' selected':'')+'>方案1：最外侧车道为右转专用道</option>'+
        '</select></div>'+
        '<div class="right-turn-island"'+(arm.rightTurnLane&&arm.rightTurnType!=='direct'?'':' hidden')+'><label>三角区域</label><select data-f="rightTurnIsland">'+
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
      arm.rightTurnType=event.target.checked
        ? (arm.rightTurnType==='none'?'direct':arm.rightTurnType)
        : 'none';
      renderArmsList();
      regenerate();
    });

    row.querySelector('[data-f=rightTurnType]').addEventListener('change',event=>{
      arm.rightTurnType=RIGHT_TURN_TYPES.has(event.target.value)?event.target.value:'direct';
      arm.rightTurnLane=arm.rightTurnType!=='none';
      renderArmsList();
      regenerate();
    });

    row.querySelector('[data-f=rightTurnLanes]').addEventListener('change',event=>{
      arm.rightTurnLanes=normaliseArmValue('rightTurnLanes',Number(event.target.value));
      renderArmsList();
      regenerate();
    });

    row.querySelector('[data-f=rightTurnIsland]').addEventListener('change',event=>{
      arm.rightTurnIsland=RIGHT_ISLAND_TYPES.has(event.target.value)?event.target.value:'planted';
      regenerate();
    });

    row.querySelector('[data-f=rightTurnMode]').addEventListener('change',event=>{
      arm.rightTurnMode=RIGHT_TURN_MODES.has(event.target.value)?event.target.value:'branch';
      renderArmsList();
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
