import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';

test('SD editing, HD derivation, scene generation and export', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if(message.type()==='error') errors.push(message.text()); });
  await page.addInitScript(()=>localStorage.setItem('intersection-studio.project.v2',JSON.stringify({junctionType:'city',cityView:'sd',projectName:'河湾城市',scenerySeed:42})));
  await page.goto('/?mode=city');
  await expect(page.locator('#statArms')).not.toHaveText('4');
  await expect(page.locator('#validationStatus')).toContainText('通过');
  const screenshot=async name=>{
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.screenshot({path:`artifacts/city-${name}.png`,animations:'disabled'});
  };
  await screenshot('sd');
  const mapImage=await page.locator('canvas').evaluate(canvas=>canvas.toDataURL('image/png'));
  await writeFile('artifacts/city-sd-map.png',Buffer.from(mapImage.split(',')[1],'base64'));
  await page.locator('[data-city-view=hd]').click();
  await expect(page.locator('[data-city-view=hd]')).toHaveClass(/active/);
  await screenshot('hd');
  await page.locator('[data-city-view=scene]').click();
  await expect(page.locator('[data-city-view=scene]')).toHaveClass(/active/);
  await screenshot('scene');
  const modelDownload=page.waitForEvent('download');
  await page.locator('#exportGlbBtn').click();
  const glb=await readFile(await (await modelDownload).path());
  expect(glb.toString('utf8',0,4)).toBe('glTF');
  await page.locator('[data-city-view=semantic]').click();
  await expect(page.locator('[data-city-view=semantic]')).toHaveClass(/active/);
  await screenshot('semantic');
  await page.locator('#editMapBtn').click();
  await expect(page.locator('#mapEditor')).toBeVisible();
  const canvas = page.locator('canvas');
  await canvas.dblclick({ position: { x: 1270, y: 730 } });
  await expect(page.locator('#mapSelection')).toContainText('节点');
  await page.locator('#deleteMapSelection').click();
  await page.locator('#undoBtn').click();
  await expect(page.locator('#validationStatus')).toContainText('独立连通分量');
  await page.locator('#redoBtn').click();
  await expect(page.locator('#validationStatus')).toContainText('通过');
  const download = page.waitForEvent('download');
  await page.locator('#exportSceneBtn').click();
  expect((await download).suggestedFilename()).toMatch(/\.scene\.json$/);
  const project = page.waitForEvent('download');
  await page.locator('#exportJsonBtn').click();
  expect((await project).suggestedFilename()).toMatch(/\.intersection\.json$/);
  await page.locator('#junctionType').selectOption('cross');
  await expect(page.locator('#localArmsSection')).toBeVisible();
  await expect(page.locator('#statArms')).toHaveText('4');
  expect(errors).toEqual([]);
});

test('dragging and road properties survive project export and reload',async({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/?mode=city');
  const fixture={junctionType:'city',cityView:'sd',projectName:'编辑验证',scenerySeed:42,
    sdMap:{version:1,seed:42,nodes:[{id:'a',x:-100,z:0,y:0},{id:'b',x:0,z:0,y:0},{id:'c',x:100,z:0,y:0}],
      edges:[{id:'ab',from:'a',to:'b',class:'local',layer:0,lanesForward:1,lanesBackward:1},
        {id:'bc',from:'b',to:'c',class:'local',layer:0,lanesForward:1,lanesBackward:1}]}};
  await page.locator('#fileInput').setInputFiles({name:'editable.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});
  await expect(page.locator('#statArms')).toHaveText('2');
  await page.locator('#resetCameraBtn').click();
  await page.locator('#editMapBtn').click();
  await page.mouse.move(791,500);await page.mouse.down();await page.mouse.move(821,450,{steps:5});await page.mouse.up();
  await expect(page.locator('#mapSelection')).toContainText('节点 b');
  await page.mouse.click(640,475);
  await expect(page.locator('#edgeProperties')).toBeVisible();
  await page.locator('#edgeClass').selectOption('arterial');
  await page.locator('#edgeForward').fill('2');await page.locator('#edgeForward').press('Tab');
  await expect(page.locator('#statLanes')).toHaveText('5');
  const download=page.waitForEvent('download');await page.locator('#exportJsonBtn').click();
  const doc=JSON.parse(await readFile(await (await download).path(),'utf8'));
  const moved=doc.project.config.sdMap.nodes.find(n=>n.id==='b');
  expect(moved.x).toBeGreaterThan(5);expect(moved.z).toBeLessThan(-10);
  expect(doc.project.config.sdMap.edges.find(e=>e.id==='ab')).toMatchObject({class:'arterial',lanesForward:2});
  await page.reload();await expect(page.locator('#statLanes')).toHaveText('5');
  expect(errors).toEqual([]);
});
