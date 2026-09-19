// 写实天空背景:一个跟随相机的天空穹顶 shader —— 物理感的天顶/地平线渐变、
// 带光晕的太阳圆盘、以及缓慢漂移的 FBM 积云。同一份穹顶也被烘焙成 PMREM
// 环境贴图,于是玻璃幕墙、水面和沥青反射的是真实天空而非室内环境。
// 输出按材质管线拼上 tonemapping/colorspace chunk:直接渲染到画布时参与
// ACES 色调映射,进 EffectComposer 渲染目标时保持线性(由 OutputPass 处理)。
import * as THREE from 'three';

// 全场景唯一的太阳方向:configureSceneExtent 平移太阳但永不旋转它,
// 保证天空 shader、IBL 烘焙和阴影方向永远一致。
export const SUN_DIR = new THREE.Vector3(-0.38, 0.74, -0.46).normalize();
// 雾色必须贴近穹顶地平线经 ACES 之后的颜色,远处的建筑才像融进大气里。
export const SKY_FOG = 0xc4d4e4;

const VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */`
varying vec3 vDir;
uniform vec3 uSunDir;
uniform float uTime;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 6; i++) { v += a * vnoise(p); p = p * 2.07 + vec2(19.7, 7.3); a *= 0.5; }
  return v;
}

void main() {
  vec3 d = normalize(vDir);
  float y = d.y;
  vec3 zenith = vec3(0.070, 0.225, 0.565);
  vec3 horizon = vec3(0.46, 0.60, 0.76);
  vec3 col = mix(horizon, zenith, pow(clamp(y, 0.0, 1.0), 0.52));

  float s = max(dot(d, uSunDir), 0.0);
  col += vec3(1.0, 0.86, 0.62) * pow(s, 6.0) * 0.14;              // 大范围晕
  col += vec3(1.0, 0.94, 0.82) * pow(s, 220.0) * 2.6;             // 太阳圆盘

  if (y > 0.012) {
    // 云在天穹上以立体投影展开,两层 FBM:第一层做域扭曲,第二层成云。
    // 投影坐标在天顶只有 ±1,必须放大若干倍才能铺开数个噪声周期。
    vec2 uv = d.xz / (y + 0.14) * 4.5;
    vec2 drift = vec2(uTime * 0.0022, uTime * 0.0009);
    float warp = fbm(uv * 0.18 + drift);
    float c = fbm(uv * 0.34 + (warp - 0.5) * 2.4 + drift * 1.7);
    float cover = smoothstep(0.50, 0.76, c + 0.14 * pow(1.0 - y, 2.0));
    float fade = smoothstep(0.012, 0.10, y);
    float lit = smoothstep(0.42, 0.92, c);
    vec3 cloud = mix(vec3(0.56, 0.60, 0.68), vec3(0.98, 0.99, 1.03), lit);
    cloud += vec3(0.30, 0.24, 0.14) * pow(s, 3.0);                // 向阳面泛暖
    col = mix(col, cloud, cover * fade * 0.94);
  }

  // 地平线下方融进雾色,和 scene.fog 衔接。
  col = mix(col, horizon * vec3(1.04, 1.02, 0.99), smoothstep(0.045, -0.10, y));

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createSky() {
  const material = new THREE.ShaderMaterial({
    uniforms: { uSunDir: { value: SUN_DIR.clone() }, uTime: { value: 0 } },
    vertexShader: VERT, fragmentShader: FRAG,
    side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(9000, 48, 28), material);
  dome.name = 'sky';
  dome.frustumCulled = false;
  dome.renderOrder = -100;
  return {
    dome,
    update(time) { material.uniforms.uTime.value = time; },
    follow(camera) { dome.position.copy(camera.position); },
  };
}

// 把穹顶(含云)烘成 PMREM 辐照度:替换默认的 RoomEnvironment,让所有
// PBR 材质的高光/漫反射环境光带上天空的蓝-白色温与太阳方位。
export function bakeSkyEnvironment(renderer, skyMaterial) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const clone = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 20), skyMaterial);
  clone.frustumCulled = false;
  envScene.add(clone);
  const texture = pmrem.fromScene(envScene, 0.05).texture;
  clone.geometry.dispose();
  pmrem.dispose();
  return texture;
}
