// GB 5768.3 / GB 50647 路口设计规格常量 — 独立路口编辑器(lane-derive.js +
// render.js)与城市管线(hd-map.js + city-render.js)共享的唯一事实来源。
// 一套路口逻辑、两个消费方:渲染层画出的任何尺寸都必须来自这里,而不是局部字面量。
export const JUNCTION_SPEC = {
  laneWidth: { min: 3.25, max: 3.5 },   // 城市道路车道宽 3.25-3.5m
  yellowLineW: 0.15,                    // 黄线宽 15cm
  whiteLineW: 0.15,                     // 车道分界线(白) 15cm
  edgeLineW: 0.15,                      // 路缘线 15cm
  stopLineW: 0.35,                      // 停止线宽 30-40cm
  stopLineGap: 5.2,                     // 停止线中心 ~ 路口切边距离
  crosswalk: {
    barW: 0.45,                         // 横道条宽 45cm
    pitch: 1.05,                        // 条中心距(45cm + 60cm 净距)
    depth: 4,                           // 过街深度 4m(不小于 3m)
    gap: 2.6,                           // 切边到横道带距离
  },
  guideZone: 30,                        // 导向车道线(实线)段长 30m
  solidZoneGap: 5.6,                    // 实线起点与停止线之间保留间距
  arrow: { footprint: 5, tipGap: 13 },  // 导向箭头长 5m,尖端距切边 13m
  waitingBox: { depth: 11 },            // 左转待转区伸入路口长度
  sidewalkMin: 2.0,                     // 人行道最小宽度 2m
  taperLen: 58,                         // 进口道拓宽渐变段长度
  taperLaneW: 3.4,                      // 拓宽一条车道宽度
  median: { arterial: 1.6, highway: 2, local: 0.5 },  // 中央分隔带宽度
};
