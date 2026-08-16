const clamp = (value,min,max)=>Math.min(max,Math.max(min,value));

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
  const splitU=Math.min(safeLength-2,stopU+Math.max(8,safeLaneWidth*2.8));
  const targetMergeU=Math.min(safeLength-0.8,cornerU+Math.max(9,safeLaneWidth*3.2));
  return {cornerU,stopU,splitU,targetMergeU};
}
