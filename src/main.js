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
import { buildCity, createSceneDocument } from './city.js';
import { renderCity } from './city-render.js';
import { generateSDMap, splitAtGradeCrossings, validateSDMap } from './sd-map.js';
import { renderRoadScene, ROAD_THEME, matStd, boxAlong, flatPoly, pathRibbon, glowMat } from './render.js';
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
let state = sanitizeProject(loadLocalProject() ?? { ...createDefaultProject(), junctionType: 'city', projectName: '程序化城市' });
if(state.junctionType==='city' && !state.sdMap) state.sdMap=generateSDMap(state);
const history = new ProjectHistory(state);
let currentCity=null, editingMap=false, mapSelection=null, mapDrag=null, connectFrom=null;
let previousSceneType=null;

// ---------------------------------------------------------------- THREE SETUP
const container = document.getElementById('canvas-container');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fb8d8);
scene.fog = new THREE.Fog(0x8fb8d8, 90, 240);

const persp = new THREE.PerspectiveCamera(50, window.innerWidth/window.innerHeight, 0.1, 20000);
let orthoHalfHeight = 60;
const ortho = new THREE.OrthographicCamera(-60, 60, 60, -60, 0.1, 10000);
ortho.position.set(0, 6000, 0.001);
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

const renderer = new THREE.WebGLRenderer({antialias:true, preserveDrawingBuffer:true, logarithmicDepthBuffer:true});
renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// The scene is static between regenerations (only lamp colours animate), so
// shadow maps are refreshed manually instead of every frame.
renderer.shadowMap.autoUpdate = false;
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
const ground = new THREE.Mesh(new THREE.CircleGeometry(220,96), new THREE.MeshStandardMaterial({color:ROAD_THEME.ground, roughness:1}));
ground.rotation.x = -Math.PI/2;
ground.receiveShadow = true;
scene.add(ground);

const worldGroup = new THREE.Group();
scene.add(worldGroup);
const selectionGroup = new THREE.Group();
scene.add(selectionGroup);

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
  if(handleMapPointerDown(e)) return;
  if(activePointerId!==null) return;
  activePointerId=e.pointerId;
  dragMode = e.button===2 || topDownMode ? 'pan' : 'rotate';
  lastX=e.clientX; lastY=e.clientY; e.preventDefault();
  renderer.domElement.setPointerCapture(e.pointerId);
});
function endDrag(e){
  if(finishMapDrag(e)) return;
  if(e.pointerId!==activePointerId) return;
  dragMode=null; activePointerId=null;
}
renderer.domElement.addEventListener('pointerup', endDrag);
renderer.domElement.addEventListener('pointercancel', endDrag);
renderer.domElement.addEventListener('pointermove', e=>{
  if(handleMapPointerMove(e)) return;
  if(!dragMode || e.pointerId!==activePointerId) return;
  const dx = e.clientX-lastX, dy = e.clientY-lastY;
  lastX=e.clientX; lastY=e.clientY;
  if(topDownMode){
    const scale = (ortho.right-ortho.left)/window.innerWidth;
    camState.target.x -= dx*scale;
    camState.target.z -= dy*scale;
    ortho.position.set(camState.target.x,6000,camState.target.z+0.001);
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
    orthoHalfHeight = Math.min(state.junctionType==='city'?4000:180,Math.max(12,orthoHalfHeight*factor));
    updateOrthoProjection();
  } else {
    camState.radius = Math.min(state.junctionType==='city'?9000:220, Math.max(14, camState.radius*Math.pow(1.0012,e.deltaY)));
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
// boxAlong / flatPoly / matStd are shared with the render layer (render.js is
// the single source for materials and mesh primitives).

// ---------------------------------------------------------------- TOPOLOGY OVERLAY + SEGMENT DEMO
const MOVEMENT_COLORS = { straight:0x4aa3ff, left:0x37d17a, right:0xff6b4a };
const LANE_CENTERLINE_COLOR = 0xc3cad6;

// Groups only ever contain geometries to free: every material comes from the
// shared caches (matStd/glowMat) and is reused across regenerations, so
// disposing it here would force shader recompiles on the next frame.
function disposeGroup(group){
  group.traverse(obj=>{
    if(obj.geometry) obj.geometry.dispose();
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
  // Continuous thin strips built as explicit triangle strips: no joints, no
  // ear-cutting artifacts.
  const addRibbon=(path,width,y,color)=>{
    const mesh = pathRibbon(path, width, y, color, { rough: 0.5 });
    if(mesh) topologyGroup.add(mesh);
  };
  const runsOf=(entity)=> (entity.runs && entity.runs.length ? entity.runs : [entity.path]);
  topology.laneCenterlines.forEach(cl=>{
    if(cl.skip) return;
    runsOf(cl).forEach(run=>addRibbon(run,0.14,0.125,LANE_CENTERLINE_COLOR));
  });
  topology.connections.forEach(conn=>{
    const color = MOVEMENT_COLORS[conn.movement] || 0xffffff;
    runsOf(conn).forEach(run=>addRibbon(run,0.18,0.135,color));
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
  disposeGroup(worldGroup);
  worldGroup.clear();
}

function addStrip(group, centreline, halfWidth, y, color, rough){
  const { ring } = buildSegmentSurface(centreline, halfWidth);
  const mesh = flatPoly(ring, y, color, { rough });
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
  addStrip(segmentGroup, centreline, halfWidth, 0.01, ROAD_THEME.asphalt, 0.95);

  // 3 -> 2 diverge: the outermost +left lane feathers off x=30..44.
  const diverge = buildLaneTaper({ origin, laneWidth:laneW, splitLanes:1, taperStart:30, taperEnd:44, side:1 });
  // The offset lane continues at constant width beside the corridor x=44..104.
  const offS = sideLateral(inOuterS, laneW);
  const offsetCentre = Array.from({ length: 61 }, (_, i) => ({ x: 44 + i, y: offS }));
  addStrip(segmentGroup, diverge.centreline, laneW / 2, 0.01, ROAD_THEME.asphalt, 0.95);
  addStrip(segmentGroup, offsetCentre, laneW / 2, 0.01, ROAD_THEME.asphalt, 0.95);

  // 2 -> 3 merge: the offset lane tapers back in to regain the 3rd lane x=104..118.
  const mergeOrigin = { point:{x:104,y:0}, fwd:{x:1,y:0}, left:{x:0,y:1} };
  const merge = buildLaneTaper({ origin:mergeOrigin, laneWidth:laneW, splitLanes:1, taperStart:0, taperEnd:14, side:1 });
  addStrip(segmentGroup, merge.centreline, laneW / 2, 0.01, ROAD_THEME.asphalt, 0.95);

  // Lane dividers on the main corridor (constant lane boundaries).
  [1, 2].forEach((k) => {
    const divider = offsetPolyline(centreline, k * laneW).left;
    addPathLine(segmentGroup, divider, 0.14, 0.02, ROAD_THEME.white);
  });
  // Outer edges of the 3-lane corridor.
  addPathLine(segmentGroup, offsetPolyline(centreline, inOuterS).left, 0.14, 0.02, ROAD_THEME.white);
  addPathLine(segmentGroup, offsetPolyline(centreline, outOuterS).right, 0.14, 0.02, ROAD_THEME.white);
  // Offset lane boundary (its +left edge).
  addPathLine(segmentGroup, offsetPolyline(offsetCentre, laneW / 2).left, 0.14, 0.02, ROAD_THEME.white);

  // Sidewalk edges along both sides of the full 3-lane corridor.
  const sw = buildSidewalkBounds(centreline, halfWidth, state.sidewalkWidth, 0.25);
  addStrip(segmentGroup, sw.left.outer, state.sidewalkWidth, -0.01, ROAD_THEME.sidewalk, 1);
  addStrip(segmentGroup, sw.right.outer, state.sidewalkWidth, -0.01, ROAD_THEME.sidewalk, 1);

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
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.14,10,8), glowMat(0xfff1c2, 0xffdd88, 0.9));
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
  syncCityControls();
  if(state.junctionType==='city'){
    if(!state.sdMap) state.sdMap=generateSDMap(state);
    currentCity=buildCity(state);
    renderCity(currentCity,worldGroup,{...state,sdNodesVisible:editingMap});
    for(const group of [topologyGroup,segmentGroup]){ disposeGroup(group); group.clear(); group.visible=false; }
    const extent=currentCity.extent;
    configureSceneExtent(extent,state.cityView==='sd'||state.cityView==='hd'||state.cityView==='semantic');
    if(previousSceneType!=='city'){
      fitSceneCamera();
      if(state.cityView==='sd'||state.cityView==='hd') setCameraMode('top');
    }
    previousSceneType='city';
    renderMapSelection();
    updateProjectInsights();
    renderer.shadowMap.needsUpdate=true;
    return;
  }
  currentCity=null;
  disposeGroup(selectionGroup); selectionGroup.clear();
  configureSceneExtent(100,false);
  if(previousSceneType==='city') fitSceneCamera();
  previousSceneType=state.junctionType;
  const sceneRandom = createSeededRandom(state.scenerySeed);

  // Layer 1: road model (geometry + connectivity + right-turn facilities).
  const model = buildRoadModel(state);
  const n = model.geoms.length;
  if(n<2){ renderTopologyOverlay(model.geoms, []); buildSegmentDemo(); updateProjectInsights(); renderer.shadowMap.needsUpdate=true; return; }

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
  if(state.junctionType==='roundabout'){
    // No lane-level cross topology exists for roundabouts yet.
    disposeGroup(topologyGroup);
    topologyGroup.clear();
    topologyGroup.visible=false;
  } else {
    renderTopologyOverlay(model.geoms, model.rightFacilities);
  }
  buildSegmentDemo();
  updateProjectInsights();
  renderer.shadowMap.needsUpdate=true;
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
  const city=state.junctionType==='city'?currentCity:null;
  const stats=city?{arms:city.sd.edges.length,lanes:city.lanes.length,roadArea:city.roadArea||0}:getProjectStats(state);
  const validation=city?{...city.validation,warnings:city.warnings}:validateProject(state);
  document.getElementById('statArms').textContent=stats.arms;
  document.getElementById('statLanes').textContent=stats.lanes;
  document.getElementById('statArea').textContent=city?(stats.roadArea/1000000).toFixed(2)+' km²':stats.roadArea.toLocaleString('zh-CN')+'㎡';
  document.getElementById('armCountBadge').textContent=stats.arms;
  document.getElementById('statArmsLabel').textContent=city?'SD 道路':'道路分支';
  if(city){
    document.getElementById('cityDiagnostics').textContent=`${city.sd.nodes.length} 个节点 · ${city.connectors.length} 条转向连接 · ${city.blocks.length} 个街区 · ${city.buildings.length} 栋建筑。`+
      ` ${city.facilities.filter(f=>f.type==='bridge').length} 座桥梁 · ${city.facilities.filter(f=>f.type==='tunnel').length} 条隧道。`+
      (city.warnings.length?' '+city.warnings.slice(0,3).join('；'):'');
  }

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
  ['citySize','citySize',0,false],
  ['cityBlockSize','cityBlockSize',0,false],
  ['cityOrganic','cityOrganic',2,false],
  ['cityDensity','cityDensity',2,true],
  ['bridgeHeight','bridgeHeight',1,true],
  ['highwayLanes','highwayLanes',0,false],
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

const junctionTypeSelect=document.getElementById('junctionType');
junctionTypeSelect.value=state.junctionType;
junctionTypeSelect.addEventListener('change',()=>{
  state.junctionType=junctionTypeSelect.value;
  editingMap=false; mapSelection=null; connectFrom=null;
  regenerate();
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
  if(state.junctionType==='city'){
    state.scenerySeed=1+Math.floor(Math.random()*99999998);
    state.sdMap=generateSDMap(state);
    syncAllControls(); regenerate(); fitSceneCamera(); return;
  }
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
    state.junctionType='cross';
    junctionTypeSelect.value='cross';
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
  junctionTypeSelect.value=state.junctionType;
  gridToggle.checked=state.showGrid;
  gridHelper.visible=state.showGrid;
  seedInput.value=state.scenerySeed;
  trafficSpeed.value=state.trafficSpeed;
  trafficSpeedValue.textContent=formatSliderValue(state.trafficSpeed,2);
  syncTrafficButton();
}

function applyProject(next,{record=true,message=''}={}){
  state=sanitizeProject(next);
  editingMap=false; mapSelection=null; connectFrom=null;
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
    ortho.position.set(camState.target.x,6000,camState.target.z+0.001);
    ortho.lookAt(camState.target.x,0,camState.target.z);
  }
}

document.getElementById('cam3d').addEventListener('click',()=>setCameraMode('3d'));
document.getElementById('camtop').addEventListener('click',()=>setCameraMode('top'));
if(new URLSearchParams(window.location.search).get('view')==='top') setCameraMode('top');
document.getElementById('resetCameraBtn').addEventListener('click',()=>{
  fitSceneCamera();
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

// ---------------------------------------------------------------- CITY AUTHORING
function configureSceneExtent(extent, schematic){
  const city=state.junctionType==='city';
  ground.scale.setScalar(city?extent*1.55/220:1);
  ground.material.color.setHex(schematic?0x17282c:ROAD_THEME.ground);
  scene.background.setHex(schematic?0x17282c:0x8fb8d8);
  scene.fog=schematic?null:new THREE.Fog(0x8fb8d8,city?extent*3:90,city?extent*7:240);
  const size=city?extent*1.1:90;
  sun.position.set(size*0.7,size*1.4,size*0.5);
  Object.assign(sun.shadow.camera,{left:-size,right:size,top:size,bottom:-size,far:size*5});
  sun.shadow.camera.updateProjectionMatrix();
  gridHelper.scale.setScalar(city?extent/100:1);
  gridHelper.visible=state.showGrid;
}

function fitSceneCamera(){
  const city=state.junctionType==='city',extent=currentCity?.extent||state.citySize/2;
  camState.theta=Math.PI*0.28; camState.phi=1.02;
  camState.radius=city?extent*3.0:78;
  camState.target.set(city?-extent*0.16:0,0,city?0:2);
  orthoHalfHeight=city?extent*1.12:60;
  updatePerspCamera(); updateOrthoProjection();
  if(topDownMode) setCameraMode('top');
}

function syncCityControls(){
  const city=state.junctionType==='city';
  document.querySelector('#panel h1').textContent=city?'城市生成':'路口参数';
  document.querySelector('.presets').hidden=city;
  document.getElementById('cityPresetBtn').hidden=city;
  document.getElementById('cityControls').hidden=!city;
  document.getElementById('localArmsSection').hidden=city;
  document.querySelectorAll('.local-only').forEach(e=>{e.hidden=city;});
  document.querySelectorAll('[data-city-view]').forEach(e=>e.classList.toggle('active',e.dataset.cityView===state.cityView));
  document.getElementById('mapEditor').hidden=!city||!editingMap;
  document.getElementById('editMapBtn').classList.toggle('active',editingMap);
  document.getElementById('editMapBtn').textContent=editingMap?'结束编辑':'编辑 SD 路网';
  for(const id of ['showWaitingAreas','showLights','showSegmentDemo','trafficSpeed','trafficPauseBtn']) document.getElementById(id).disabled=city;
  document.getElementById('pipelineDescription').textContent={
    sd:'SD 是编辑源：灰蓝色支路、青色次干路、金色主干路。沿河岸与城区方向场生长，同层相交连接，桥梁独立跨越。',
    hd:'HD 从 SD 派生：显示有向车道与转向连接。蓝色直行、绿色左转、橙色右转。',
    scene:'道路、路口、桥梁和建筑从拓扑生成。编辑 SD 后，所有下游层重新派生。',
    semantic:'语义类别：紫色道路、蓝色建筑、绿色植被、灰色桥梁。场景数据另含对象 ID 和生成种子。',
  }[state.cityView];
  document.getElementById('hint').innerHTML=editingMap?'<b>拖动节点</b> 编辑 · <b>双击</b> 添加 · <b>Shift 点选两节点</b> 连路':
    '<b>拖拽</b> 旋转 / 俯视平移 · <b>滚轮</b> 缩放 · <b>右键</b> 平移';
}

document.getElementById('cityPresetBtn').addEventListener('click',()=>{
  state.junctionType='city'; state.projectName='程序化城市';
  if(!state.sdMap) state.sdMap=generateSDMap(state);
  state.cityView='sd'; syncAllControls(); regenerate(); fitSceneCamera(); setCameraMode('top'); recordChange();
});
document.querySelectorAll('[data-city-view]').forEach(button=>button.addEventListener('click',()=>{
  state.cityView=button.dataset.cityView; editingMap=false; connectFrom=null;
  regenerate();
  if(state.cityView==='hd'){
    const selected=currentCity.sd.nodes.find(n=>n.id===mapSelection?.id);
    const node=selected||currentCity.sd.nodes.filter(n=>currentCity.sd.edges.filter(e=>e.from===n.id||e.to===n.id).length>=3)
      .sort((a,b)=>Math.hypot(a.x,a.z)-Math.hypot(b.x,b.z))[0];
    if(node){camState.target.set(node.x-45,0,node.z);orthoHalfHeight=145;updateOrthoProjection();}
  }else fitSceneCamera();
  setCameraMode(state.cityView==='scene'?'3d':'top'); recordChange();
}));
document.getElementById('generateCityBtn').addEventListener('click',()=>{
  state.sdMap=generateSDMap(state); mapSelection=null; connectFrom=null;
  regenerate(); fitSceneCamera(); recordChange(); showToast('已生成新的 SD 路网，可撤销恢复');
});
document.getElementById('editMapBtn').addEventListener('click',()=>{
  editingMap=!editingMap; state.cityView='sd'; connectFrom=null;
  regenerate(); setCameraMode('top'); recordChange();
});
document.getElementById('exportSceneBtn').addEventListener('click',()=>{
  if(!currentCity?.validation.valid){showToast('请先修复 SD 路网错误');return;}
  const data=createSceneDocument(currentCity);
  downloadBlob(new Blob([JSON.stringify(data)],{type:'application/json;charset=utf-8'}),slugifyProjectName(state.projectName)+'.scene.json');
  showToast('已导出 SD、HD、设施、地块与语义数据');
});

const mapRaycaster=new THREE.Raycaster(),mapPlane=new THREE.Plane(new THREE.Vector3(0,1,0),0);
function mapWorldPoint(event){
  const rect=renderer.domElement.getBoundingClientRect();
  mapRaycaster.setFromCamera(new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1),activeCam);
  const point=new THREE.Vector3();
  return mapRaycaster.ray.intersectPlane(mapPlane,point)?point:null;
}
function hitMap(point){
  const tolerance=orthoHalfHeight*2/window.innerHeight*11;
  let node=null,best=tolerance;
  for(const candidate of state.sdMap.nodes){
    const d=Math.hypot(candidate.x-point.x,candidate.z-point.z);
    if(d<best){node=candidate;best=d;}
  }
  if(node)return {kind:'node',id:node.id};
  const nodes=new Map(state.sdMap.nodes.map(n=>[n.id,n]));
  let edge=null;best=tolerance;
  for(const candidate of state.sdMap.edges){
    const a=nodes.get(candidate.from),b=nodes.get(candidate.to);
    if(!a||!b)continue;
    const dx=b.x-a.x,dz=b.z-a.z,t=Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.z-a.z)*dz)/(dx*dx+dz*dz)));
    const d=Math.hypot(point.x-a.x-t*dx,point.z-a.z-t*dz);
    if(d<best){edge=candidate;best=d;}
  }
  return edge?{kind:'edge',id:edge.id}:null;
}

function commitMapEdit(previous){
  const normalized=splitAtGradeCrossings(state.sdMap),validation=validateSDMap(normalized);
  if(!validation.valid){state.sdMap=previous;showToast(validation.errors[0]);}
  else state.sdMap=normalized;
  regenerate(); recordChange();
}
function handleMapPointerDown(event){
  if(!editingMap||!topDownMode||event.button!==0||state.junctionType!=='city')return false;
  const p=mapWorldPoint(event); if(!p)return false;
  const hit=hitMap(p);
  if(!hit){mapSelection=null;renderMapSelection();return false;}
  event.preventDefault(); mapSelection=hit;
  if(event.shiftKey&&hit.kind==='node'){
    if(connectFrom&&connectFrom!==hit.id){
      const previous=structuredClone(state.sdMap);
      const duplicate=state.sdMap.edges.some(e=>(e.from===connectFrom&&e.to===hit.id)||(e.to===connectFrom&&e.from===hit.id));
      if(!duplicate){state.sdMap.edges.push({id:nextMapId('road'),from:connectFrom,to:hit.id,class:'local',lanesForward:1,lanesBackward:1,layer:0});commitMapEdit(previous);}
      else showToast('这两个节点之间已有道路');
      connectFrom=null;
    }else{connectFrom=hit.id;showToast('按住 Shift 再点一个节点以连接道路');}
    renderMapSelection();return true;
  }
  connectFrom=null;
  if(hit.kind==='node'){
    mapDrag={pointer:event.pointerId,nodeId:hit.id,previous:structuredClone(state.sdMap)};
    renderer.domElement.setPointerCapture(event.pointerId);
  }
  renderMapSelection();return true;
}
function handleMapPointerMove(event){
  if(!mapDrag||mapDrag.pointer!==event.pointerId)return false;
  const p=mapWorldPoint(event),node=state.sdMap.nodes.find(n=>n.id===mapDrag.nodeId);
  if(p&&node){node.x=Math.round(p.x);node.z=Math.round(p.z);renderMapSelection();}
  return true;
}
function finishMapDrag(event){
  if(!mapDrag||mapDrag.pointer!==event.pointerId)return false;
  const previous=mapDrag.previous;mapDrag=null;
  if(event.type==='pointercancel')state.sdMap=previous;
  commitMapEdit(previous);return true;
}
function nextMapId(prefix){
  const ids=new Set([...state.sdMap.nodes,...state.sdMap.edges].map(e=>e.id));
  let index=1;while(ids.has(`${prefix}-${index}`))index++;
  return `${prefix}-${index}`;
}
renderer.domElement.addEventListener('dblclick',event=>{
  if(!editingMap||!topDownMode)return;
  const p=mapWorldPoint(event);if(!p||hitMap(p))return;
  const previous=structuredClone(state.sdMap),id=nextMapId('node');
  state.sdMap.nodes.push({id,x:Math.round(p.x),z:Math.round(p.z),y:0});
  mapSelection={kind:'node',id};commitMapEdit(previous);
});

function renderMapSelection(){
  disposeGroup(selectionGroup);selectionGroup.clear();
  const properties=document.getElementById('edgeProperties');properties.hidden=true;
  const label=document.getElementById('mapSelection');
  label.textContent='尚未选择节点或道路';
  if(!editingMap||!mapSelection||!state.sdMap)return;
  const nodes=new Map(state.sdMap.nodes.map(n=>[n.id,n]));
  const addLine=(a,b)=>{
    const mesh=pathRibbon([{x:a.x,y:a.z},{x:b.x,y:b.z}],2.2,1.1,0x83f1c4);
    if(mesh)selectionGroup.add(mesh);
  };
  if(mapSelection.kind==='node'){
    const node=nodes.get(mapSelection.id);if(!node)return;
    label.textContent=`节点 ${node.id} · (${node.x.toFixed(0)}, ${node.z.toFixed(0)}) m`;
    const mesh=new THREE.Mesh(new THREE.CylinderGeometry(5,5,0.2,16),matStd(0x83f1c4));mesh.position.set(node.x,1.2,node.z);selectionGroup.add(mesh);
    for(const edge of state.sdMap.edges.filter(e=>e.from===node.id||e.to===node.id))addLine(nodes.get(edge.from),nodes.get(edge.to));
  }else{
    const edge=state.sdMap.edges.find(e=>e.id===mapSelection.id);if(!edge)return;
    label.textContent=`道路 ${edge.id} · ${edge.from} → ${edge.to}`;
    properties.hidden=false;
    document.getElementById('edgeClass').value=edge.class;
    document.getElementById('edgeForward').value=edge.lanesForward;
    document.getElementById('edgeBackward').value=edge.lanesBackward;
    document.getElementById('edgeLayer').value=edge.layer;
    addLine(nodes.get(edge.from),nodes.get(edge.to));
  }
}
for(const [id,field]of [['edgeClass','class'],['edgeForward','lanesForward'],['edgeBackward','lanesBackward'],['edgeLayer','layer']]){
  document.getElementById(id).addEventListener('change',event=>{
    const edge=state.sdMap?.edges.find(e=>e.id===mapSelection?.id);if(!edge)return;
    const previous=structuredClone(state.sdMap);
    edge[field]=field==='class'?event.target.value:field==='layer'?Number(event.target.value):Math.max(0,Math.min(4,Math.round(Number(event.target.value)||0)));
    commitMapEdit(previous);
  });
}
document.getElementById('deleteMapSelection').addEventListener('click',()=>{
  if(!mapSelection||!state.sdMap)return;
  const previous=structuredClone(state.sdMap),{kind,id}=mapSelection;
  if(kind==='node'){state.sdMap.nodes=state.sdMap.nodes.filter(n=>n.id!==id);state.sdMap.edges=state.sdMap.edges.filter(e=>e.from!==id&&e.to!==id);}
  else state.sdMap.edges=state.sdMap.edges.filter(e=>e.id!==id);
  mapSelection=null;connectFrom=null;commitMapEdit(previous);
});

// ---------------------------------------------------------------- INIT
const startupMode=new URLSearchParams(window.location.search).get('mode');
if(startupMode==='city'){ state.junctionType='city'; state.cityView='sd'; }
syncAllControls();
syncTrafficButton();
renderArmsList();
regenerate();
updateHistoryButtons();
saveLocalProject(state);
