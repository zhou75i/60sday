import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const dateArg = args.find(x => x.startsWith('--date='));
const targetDate = dateArg?.slice(7) || new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) throw new Error(`日期格式错误: ${targetDate}`);

const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);
const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS || 2000);
const TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 20000);
const headers = { 'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36', Accept:'application/json,text/plain,*/*', 'Accept-Language':'zh-CN,zh;q=0.9,en;q=0.8', 'Cache-Control':'no-cache' };
const log = m => console.log(`[${new Date().toLocaleString('zh-CN',{hour12:false})}] ${m}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = max => Math.floor(Math.random() * max);

async function get(url) {
  let last;
  for (let i=1;i<=MAX_RETRIES;i++) {
    try {
      const r = await axios.get(url,{headers,timeout:TIMEOUT_MS,validateStatus:()=>true});
      if (r.status >= 200 && r.status < 300) return r.data;
      last = new Error(`HTTP ${r.status}`);
      const retryable = r.status===403 || r.status===408 || r.status===425 || r.status===429 || r.status>=500;
      if (!retryable || i===MAX_RETRIES) throw last;
      const retryAfter = Number(r.headers['retry-after'] || 0) * 1000;
      const wait = retryAfter || Math.min(60000, RETRY_BASE_MS * 2 ** (i-1)) + jitter(1500);
      log(`${url} 返回 ${r.status}，${wait}ms 后重试 (${i}/${MAX_RETRIES})`); await sleep(wait);
    } catch (e) { last=e; if (i===MAX_RETRIES) throw e; const wait=Math.min(60000,RETRY_BASE_MS*2**(i-1))+jitter(1500); log(`请求异常: ${e.message}，${wait}ms 后重试`); await sleep(wait); }
  }
  throw last;
}

function normalize(raw, date) {
  const candidates=[raw,raw?.data,raw?.result,raw?.data?.data];
  for (const x of candidates) {
    if (!x) continue;
    if (Array.isArray(x)) return {date,news:x.map(String),tip:''};
    if (Array.isArray(x.news)) return {...x,date:x.date||date,news:x.news.map(v=>typeof v==='string'?v:(v.title||v.content||JSON.stringify(v))),tip:x.tip||x.weiyu||''};
    if (Array.isArray(x.data)) return {date,news:x.data.map(String),tip:x.tip||x.weiyu||''};
  }
  return null;
}

async function getNewsData(date) {
  const d=encodeURIComponent(date);
  const sources=[
    ['本仓库 jsDelivr',`https://cdn.jsdelivr.net/gh/${process.env.REPO_OWNER||'zhou75i'}/${process.env.REPO_NAME||'60sday'}@main/static/60s/${d}.json`],
    ['本仓库 jsDelivr 镜像',`https://cdn.jsdmirror.com/gh/${process.env.REPO_OWNER||'zhou75i'}/${process.env.REPO_NAME||'60sday'}@main/static/60s/${d}.json`],
    ['本仓库 Raw',`https://raw.githubusercontent.com/${process.env.REPO_OWNER||'zhou75i'}/${process.env.REPO_NAME||'60sday'}/main/static/60s/${d}.json`],
    ['qqsuu API',`https://api.qqsuu.cn/api/dm-60s?date=${d}`],
    ['vvhan API','https://api.vvhan.com/api/60s?type=json'],
    ['jun.la API','https://api.jun.la/60s.php?format=json']
  ];
  for (const [name,url] of sources) { try { log(`尝试数据源: ${name}`); const data=normalize(await get(url),date); if(data?.news?.length){log(`成功: ${name}，${data.news.length} 条`); return data;} } catch(e){log(`失败: ${name} - ${e.message}`);} }
  throw new Error(`所有数据源均失败: ${date}`);
}

async function run(){
  log(`获取 ${targetDate} 数据`);
  const data=await getNewsData(targetDate);
  const out=path.resolve('static/60s'); fs.mkdirSync(out,{recursive:true}); fs.mkdirSync(path.resolve('static/images'),{recursive:true});
  fs.writeFileSync(path.join(out,`${targetDate}.json`),JSON.stringify(data,null,2));
  const template=fs.readFileSync(path.resolve('src/template.html'),'utf8').replace(/\{\{\s*date\s*\}\}/g,targetDate);
  const browser=await puppeteer.launch({headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--font-render-hinting=none']});
  try { const page=await browser.newPage(); await page.setViewport({width:1080,height:800,deviceScaleFactor:1}); await page.setContent(template,{waitUntil:'networkidle0'}); await page.evaluate(({data,owner,name})=>{window.DATA=data;window.REPO_OWNER=owner;window.REPO_NAME=name},{data,owner:process.env.REPO_OWNER||'zhou75i',name:process.env.REPO_NAME||'60sday'}); await page.evaluate(()=>generate()); const b64=await page.evaluate(()=>{if(window.IMAGE_ERROR)throw Error(window.IMAGE_ERROR);return window.IMAGE_BASE64}); if(!b64)throw Error('图片为空'); fs.writeFileSync(path.join('static/images',`${targetDate}.png`),Buffer.from(b64.split(',')[1],'base64')); log('图片生成成功'); } finally {await browser.close();}
}
run().catch(e=>{console.error(e);process.exit(1)});
