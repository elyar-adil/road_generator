import { classifyArmMovement } from './road-movements.js';

export const PROJECT_FORMAT = 'intersection-studio';
export const PROJECT_VERSION = 3;

export const CENTER_MODES = new Set(['planted', 'doubleYellowRail', 'doubleYellow']);
export const WAITING_AREA_TYPES = new Set(['none', 'left', 'straight']);
export const RIGHT_ISLAND_TYPES = new Set(['planted', 'hatched']);
export const RIGHT_TURN_TYPES = new Set(['none', 'direct', 'split', 'slip']);
export const RIGHT_TURN_MODES = new Set(['dedicated', 'branch']);

const DEFAULT_ARMS = [
  { angle: 0, laneIn: 2, laneOut: 2, centerMode: 'planted', medianWidth: 1.2, waitingArea: 'none', leftTurnLanes: 1, rightTurnLanes: 1, rightTurnLane: true, rightTurnIsland: 'planted', rightTurnMode: 'branch', leftGuardrail: false, rightGuardrail: false },
  { angle: 90, laneIn: 2, laneOut: 2, centerMode: 'doubleYellow', medianWidth: 1, waitingArea: 'none', leftTurnLanes: 1, rightTurnLanes: 1, rightTurnLane: true, rightTurnIsland: 'planted', rightTurnMode: 'branch', leftGuardrail: false, rightGuardrail: true },
  { angle: 180, laneIn: 3, laneOut: 2, centerMode: 'doubleYellowRail', medianWidth: 1, waitingArea: 'none', leftTurnLanes: 1, rightTurnLanes: 1, rightTurnLane: true, rightTurnIsland: 'hatched', rightTurnMode: 'branch', leftGuardrail: false, rightGuardrail: false },
  { angle: 270, laneIn: 2, laneOut: 2, centerMode: 'doubleYellow', medianWidth: 1, waitingArea: 'none', leftTurnLanes: 1, rightTurnLanes: 1, rightTurnLane: true, rightTurnIsland: 'hatched', rightTurnMode: 'branch', leftGuardrail: true, rightGuardrail: false },
];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clone = (value) => JSON.parse(JSON.stringify(value));
const boolean = (value, fallback) => typeof value === 'boolean' ? value : fallback;

// CJJ 37 / CJJ 152 place urban intersection lanes mostly in the 3.0–3.5 m
// range. For the compact urban layouts modelled here, a 30–42 m core retains
// pedestrian clearances while keeping channelized right turns proportionate.
export function sampleIntersectionSize(random = Math.random) {
  const min = 30, mode = 34, max = 42;
  const unit = clamp(finite(random(), 0.5), 0, 1);
  const split = (mode - min) / (max - min);
  const value = unit < split
    ? min + Math.sqrt(unit * (max - min) * (mode - min))
    : max - Math.sqrt((1 - unit) * (max - min) * (max - mode));
  return Math.round(value);
}

export function normalizeAngle(value) {
  return ((Math.round(finite(value, 0)) % 360) + 360) % 360;
}

// Per-field numeric normalizer used by the editor for live input. Single source
// of truth for the allowed ranges shared between state sanitization and the UI.
export function normaliseArmValue(field, value) {
  if (field === 'angle') return normalizeAngle(value);
  if (field === 'medianWidth') return Math.min(4, Math.max(0, Math.round(finite(value, 1) * 10) / 10));
  if (field === 'leftTurnLanes') return Math.min(2, Math.max(1, Math.round(finite(value, 1))));
  if (field === 'rightTurnLanes') return Math.min(2, Math.max(1, Math.round(finite(value, 1))));
  return Math.min(6, Math.max(0, Math.round(finite(value, 0))));
}

export function angleDistance(a, b) {
  return Math.abs(((normalizeAngle(a) - normalizeAngle(b) + 540) % 360) - 180);
}

export function sanitizeArm(arm = {}) {
  const centerMode = CENTER_MODES.has(arm.centerMode) ? arm.centerMode : 'doubleYellow';
  const waitingArea = WAITING_AREA_TYPES.has(arm.waitingArea) ? arm.waitingArea : 'none';
  const explicitRightTurnLane = typeof arm.rightTurnLane === 'boolean';
  const legacyRightTurnEnabled = explicitRightTurnLane
    ? arm.rightTurnLane
    : finite(arm.rightTurnLanes, 1) > 0;
  const rightTurnType = RIGHT_TURN_TYPES.has(arm.rightTurnType)
    ? arm.rightTurnType
    : (legacyRightTurnEnabled ? 'split' : 'none');
  const rightTurnLanes = rightTurnType === 'none'
    ? 0
    : clamp(Math.round(finite(arm.rightTurnLanes, 1)), 1, 2);
  const rightTurnIsland = RIGHT_ISLAND_TYPES.has(arm.rightTurnIsland) ? arm.rightTurnIsland : 'hatched';
  const rightTurnMode = RIGHT_TURN_MODES.has(arm.rightTurnMode) ? arm.rightTurnMode : 'branch';
  return {
    angle: normalizeAngle(arm.angle),
    laneIn: clamp(Math.round(finite(arm.laneIn, 2)), 0, 6),
    laneOut: clamp(Math.round(finite(arm.laneOut, 2)), 0, 6),
    centerMode,
    medianWidth: Math.round(clamp(finite(arm.medianWidth, 1), 0, 4) * 10) / 10,
    waitingArea,
    leftTurnLanes: clamp(Math.round(finite(arm.leftTurnLanes, 1)), 1, 2),
    rightTurnLanes,
    rightTurnLane: rightTurnType !== 'none',
    rightTurnType,
    rightTurnIsland,
    rightTurnMode,
    leftGuardrail: Boolean(arm.leftGuardrail),
    rightGuardrail: Boolean(arm.rightGuardrail),
  };
}

export function createDefaultProject() {
  const scenerySeed = 1 + Math.floor(Math.random() * 99999998);
  const rightTurnRandom = createSeededRandom(scenerySeed);
  const rightTurnTypes = ['direct', 'split', 'slip'];
  for (let index = rightTurnTypes.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rightTurnRandom() * (index + 1));
    [rightTurnTypes[index], rightTurnTypes[swapIndex]] = [rightTurnTypes[swapIndex], rightTurnTypes[index]];
  }
  return {
    projectName: '城市十字路口',
    arms: clone(DEFAULT_ARMS).map((arm) => ({
      ...arm,
      rightTurnType: rightTurnTypes[arm.angle / 90 % rightTurnTypes.length],
    })),
    laneWidth: 3.25,
    intersectionSize: sampleIntersectionSize(createSeededRandom(scenerySeed)),
    armLength: 46,
    sidewalkWidth: 2.4,
    filletSeg: 7,
    showArrows: true,
    showCrosswalk: true,
    showWaitingAreas: true,
    showLights: true,
    showSidewalk: true,
    showBuildings: true,
    showTopology: false,
    showSegmentDemo: false,
    showGrid: false,
    scenerySeed,
    trafficSpeed: 1,
    trafficPaused: false,
  };
}

function unwrapProject(value) {
  if (value?.format === PROJECT_FORMAT && value.project) {
    return {
      ...value.project.config,
      projectName: value.project.name ?? value.project.config?.projectName,
    };
  }
  if (value?.config) {
    return { ...value.config, projectName: value.name ?? value.config.projectName };
  }
  return value ?? {};
}

export function sanitizeProject(value) {
  const source = unwrapProject(value);
  const defaults = createDefaultProject();
  const scenerySeed = finite(source.scenerySeed, defaults.scenerySeed);
  const rawArms = Array.isArray(source.arms) ? source.arms : defaults.arms;
  const arms = rawArms.slice(0, 8).map(sanitizeArm);
  const sampledFallback = sampleIntersectionSize(createSeededRandom(scenerySeed));
  const intersectionSize = Math.round(clamp(finite(source.intersectionSize, sampledFallback), 28, 60));
  const requestedArmLength = Math.round(clamp(finite(source.armLength, defaults.armLength), 25, 80));

  return {
    projectName: String(source.projectName ?? defaults.projectName).trim().slice(0, 40) || '未命名路口',
    arms: arms.length >= 2 ? arms : defaults.arms,
    laneWidth: Math.round(clamp(finite(source.laneWidth, defaults.laneWidth), 2.6, 4.2) * 20) / 20,
    intersectionSize,
    armLength: Math.max(requestedArmLength, Math.ceil(intersectionSize/2+8)),
    sidewalkWidth: Math.round(clamp(finite(source.sidewalkWidth, defaults.sidewalkWidth), 0.8, 5) * 10) / 10,
    filletSeg: Math.round(clamp(finite(source.filletSeg, defaults.filletSeg), 1, 12)),
    showArrows: boolean(source.showArrows, defaults.showArrows),
    showCrosswalk: boolean(source.showCrosswalk, defaults.showCrosswalk),
    showWaitingAreas: boolean(source.showWaitingAreas, defaults.showWaitingAreas),
    showLights: boolean(source.showLights, defaults.showLights),
    showSidewalk: boolean(source.showSidewalk, defaults.showSidewalk),
    showBuildings: boolean(source.showBuildings, defaults.showBuildings),
    showTopology: boolean(source.showTopology, defaults.showTopology),
    showSegmentDemo: boolean(source.showSegmentDemo, defaults.showSegmentDemo),
    showGrid: boolean(source.showGrid, defaults.showGrid),
    scenerySeed: Math.round(clamp(scenerySeed, 1, 99999999)),
    trafficSpeed: Math.round(clamp(finite(source.trafficSpeed, defaults.trafficSpeed), 0.25, 3) * 4) / 4,
    trafficPaused: Boolean(source.trafficPaused),
  };
}

export function validateProject(value) {
  const project = sanitizeProject(value);
  const errors = [];
  const warnings = [];

  if (project.arms.length < 2 || project.arms.length > 8) {
    errors.push('道路分支数量必须在 2–8 之间');
  }

  project.arms.forEach((arm, index) => {
    if (arm.laneIn + arm.laneOut === 0) {
      errors.push(`分支 ${index + 1} 至少需要一条车道`);
    }
    if (arm.waitingArea !== 'none' && !project.showLights) {
      warnings.push(`分支 ${index + 1} 的待转区需要交通信号控制`);
    }
    if (arm.waitingArea === 'left') {
      const requiredLanes = arm.leftTurnLanes + 2;
      if (arm.laneIn < requiredLanes) {
        warnings.push(`分支 ${index + 1} 设置 ${arm.leftTurnLanes} 条左转专用道至少需要 ${requiredLanes} 条进入车道`);
      }
      const leftTargets = project.arms.map((target, targetIndex) => {
        if (targetIndex === index || target.laneOut <= 0) return false;
        const movement=classifyArmMovement(arm,target);
        return movement.type==='left'?{target,turn:movement.turn}:null;
      }).filter(Boolean).sort((a,b)=>Math.abs(a.turn-90)-Math.abs(b.turn-90));
      if (!leftTargets.length) warnings.push(`分支 ${index + 1} 没有可连接的左侧出口`);
      else if (leftTargets[0].target.laneOut < arm.leftTurnLanes) {
        warnings.push(`分支 ${index + 1} 的左侧出口车道不足以连接 ${arm.leftTurnLanes} 条左转专用道`);
      }
    }
    if (arm.waitingArea === 'straight' && arm.laneIn < 3) {
      warnings.push(`分支 ${index + 1} 没有独立的直行车道可设置直行待行区`);
    }
    if (arm.waitingArea === 'straight') {
      const hasStraightTarget = project.arms.some((target, targetIndex) => {
        if (targetIndex === index || target.laneOut <= 0) return false;
        return classifyArmMovement(arm,target).type==='straight';
      });
      if (!hasStraightTarget) warnings.push(`分支 ${index + 1} 没有可连接的直行出口`);
    }
    if (arm.rightTurnType !== 'none') {
      const rightTargets = project.arms.map((target, targetIndex) => {
        if (targetIndex === index || target.laneOut <= 0) return false;
        const movement=classifyArmMovement(arm,target);
        return movement.type==='right'?{target,turn:movement.turn}:null;
      }).filter(Boolean).sort((a,b)=>Math.abs(a.turn+90)-Math.abs(b.turn+90));
      if (arm.laneIn < 1) {
        warnings.push(`分支 ${index + 1} 没有进入车道，无法设置右转专用道`);
      } else if (!rightTargets.length) {
        warnings.push(`分支 ${index + 1} 没有可连接的右侧出口，右转专用道将不生成`);
      } else if (arm.rightTurnLanes > arm.laneIn) {
        warnings.push(`分支 ${index + 1} 的进入车道不足以设置 ${arm.rightTurnLanes} 条右转专用道`);
      } else if (rightTargets[0].target.laneOut < arm.rightTurnLanes) {
        warnings.push(`分支 ${index + 1} 的右侧出口车道不足以连接 ${arm.rightTurnLanes} 条右转专用道`);
      }
    }
    for (let next = index + 1; next < project.arms.length; next += 1) {
      const gap = angleDistance(arm.angle, project.arms[next].angle);
      if (gap < 10) errors.push(`分支 ${index + 1} 与分支 ${next + 1} 的夹角小于 10°`);
      else if (gap < 20) warnings.push(`分支 ${index + 1} 与分支 ${next + 1} 距离较近`);
    }
  });

  if (!project.showLights && project.arms.length > 4) {
    warnings.push('复杂多岔路口建议启用交通信号');
  }

  const widestRoad = Math.max(...project.arms.map((arm) => {
    const median = arm.laneIn > 0 && arm.laneOut > 0 && arm.centerMode === 'planted' ? arm.medianWidth : 0;
    return (arm.laneIn + arm.laneOut) * project.laneWidth + median;
  }));
  const recommendedMinimum = Math.ceil(widestRoad + 8);
  if (project.intersectionSize < recommendedMinimum) {
    warnings.push(`当前车道规模建议路口核心尺寸不小于 ${recommendedMinimum} m`);
  }

  return { valid: errors.length === 0, errors, warnings, project };
}

export function createProjectDocument(value, now = new Date()) {
  const project = sanitizeProject(value);
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    exportedAt: now.toISOString(),
    project: {
      name: project.projectName,
      config: project,
    },
  };
}

export function parseProjectDocument(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('文件不是有效的 JSON');
  }

  if (value?.format && value.format !== PROJECT_FORMAT) {
    throw new Error('这不是路口工坊项目文件');
  }
  if (Number(value?.version ?? 1) > PROJECT_VERSION) {
    throw new Error('项目文件版本高于当前应用版本');
  }

  const result = validateProject(value);
  if (!result.valid) throw new Error(result.errors[0]);
  return result.project;
}

export function getProjectStats(value) {
  const project = sanitizeProject(value);
  const lanes = project.arms.reduce((total, arm) => total + arm.laneIn + arm.laneOut, 0);
  const armsArea = project.arms.reduce((total, arm) => {
    const median = arm.laneIn > 0 && arm.laneOut > 0 && arm.centerMode === 'planted' ? arm.medianWidth : 0.35;
    return total + ((arm.laneIn + arm.laneOut) * project.laneWidth + median) * project.armLength;
  }, 0);
  const coreRadius = Math.max(...project.arms.map((arm) => (arm.laneIn + arm.laneOut) * project.laneWidth * 0.55));
  const roadArea = Math.round(armsArea + Math.PI * coreRadius * coreRadius);

  return {
    arms: project.arms.length,
    lanes,
    roadArea,
  };
}

export function createSeededRandom(seed) {
  let value = Math.trunc(finite(seed, 1)) >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

export function slugifyProjectName(name) {
  const cleaned = String(name || 'intersection')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
  return cleaned || 'intersection';
}
