
const { chromium } = require('playwright');
const path = require('path');
const BASE = 'http://localhost:3000';
const TOKEN = 'ODOa63cuHq_p2cRk7j9MuQXCLtSPUw-61WCvYF73DI8';
const OUT = 'D:/Code/AI/opencode-api/design-mockups/chat/v3';
(async()=>{
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport:{width:1440,height:900}, deviceScaleFactor:1});
  await ctx.addCookies([{name:'ocg_session', value:TOKEN, url:BASE}]);
  const page = await ctx.newPage();
  page.setDefaultNavigationTimeout(60000);
  const payload = {
    sessions: [{id:'s1', title:'新对话', model:'gpt-5.6-luna'}],
    currentId:'s1',
    messages:[],
    model:'gpt-5.6-luna',
    reasoning:'auto',
    interfaceType:'chat',
    route:'auto'
  };
  await page.goto(BASE+'/chat', {waitUntil:'networkidle'});
  await page.waitForTimeout(1500);
  await page.waitForSelector('text=Fusion Router', {timeout:10000}).catch(()=>{});
  await page.evaluate((data)=>{
    localStorage.setItem('opencode-dashboard-chat-v2', JSON.stringify(data));
  }, payload);
  await page.reload({waitUntil:'networkidle'});
  await page.waitForTimeout(2000);
  await page.waitForSelector('textarea', {timeout:5000}).catch(()=>{});
  await page.waitForTimeout(1500); // wait for HMR and fonts
  const out = path.join(OUT, 'impl4-main.png');
  await page.screenshot({path: out, fullPage:false});
  console.log('Saved', out);
  await browser.close();
})();
