import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import puppeteer from 'puppeteer';
import { Solar } from 'lunar-javascript';

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

function getCalendarInfo(date) {
  const [y,m,d] = date.split('-').map(Number);
  const solar = Solar.fromYmd(y,m,d);
  const lunar = solar.getLunar();
  const week = ['日','一','二','三','四','五','六'][solar.getWeek()];
  return { day_of_week: `星期${week}`, lunar_date: `${lunar.getYearInGanZhi()}年${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}` };
}

function normalize(raw, date, sourceUrl = '') {
  const candidates=[raw,raw?.data,raw?.result,raw?.data?.data];
  for (const x of candidates) {
    if (!x) continue;
    if (Array.isArray(x)) return buildOutput({date,news:x.map(String),tip:''}, date, sourceUrl);
    if (Array.isArray(x.news)) return buildOutput({...x,date:x.date||date,news:x.news.map(v=>typeof v==='string'?v:(v.title||v.content||JSON.stringify(v))),tip:x.tip||x.weiyu||''}, date, sourceUrl);
    if (Array.isArray(x.data)) return buildOutput({date,news:x.data.map(v=>typeof v==='string'?v:(v.title||v.content||v.description||JSON.stringify(v))),tip:x.tip||x.weiyu||''}, date, sourceUrl);
    if (Array.isArray(x.content)) return buildOutput({date,news:x.content.map(String),tip:x.tip||x.weiyu||''}, date, sourceUrl);
    if (Array.isArray(x.newslist)) return buildOutput({date,news:x.newslist.map(v=>typeof v==='string'?v:(v.title||v.content||v.description||JSON.stringify(v))),tip:x.tip||x.weiyu||''}, date, sourceUrl);
    if (Array.isArray(x.list)) return buildOutput({date,news:x.list.map(v=>typeof v==='string'?v:(v.title||v.content||v.description||JSON.stringify(v))),tip:x.tip||x.weiyu||''}, date, sourceUrl);
  }
  return null;
}

function buildOutput(base, date, sourceUrl) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const created = `${now.getFullYear()}/${pad(now.getMonth()+1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const calendar = getCalendarInfo(date);
  return {
    date,
    news: Array.isArray(base.news) ? base.news.slice(0, 30) : [],
    tip: base.tip || '别等万事俱备再出发，边前行边修正，行动是打破迷茫最好的武器',
    image: base.image || '',
    link: base.link || '',
    created: base.created || created,
    created_at: Number(base.created_at) || now.getTime(),
    updated: base.updated || created,
    updated_at: Number(base.updated_at) || now.getTime(),
    day_of_week: calendar.day_of_week,
    lunar_date: calendar.lunar_date,
    api_updated: base.api_updated || created,
    api_updated_at: Number(base.api_updated_at) || now.getTime(),
    source: base.source || sourceUrl || ''
  };
}

async function getNewsData(date) {
  const d=encodeURIComponent(date);
  const owner=process.env.REPO_OWNER||'zhou75i';
  const repo=process.env.REPO_NAME||'60sday';
  const sources=[
    ['60s.viki.moe API','https://60s.viki.moe/v2/60s'],
    ['60s-static 官方静态源',`https://60s-static.viki.moe/60s/${d}.json`],
    ['60s-static jsDelivr',`https://cdn.jsdelivr.net/gh/vikiboss/60s-static-host@main/static/60s/${d}.json`],
    ['本仓库 jsDelivr',`https://cdn.jsdelivr.net/gh/${owner}/${repo}@main/static/60s/${d}.json`],
    ['本仓库 Raw',`https://raw.githubusercontent.com/${owner}/${repo}/main/static/60s/${d}.json`],
    ['qqsuu API',`https://api.qqsuu.cn/api/dm-60s?date=${d}`]
  ];
  for (const [name,url] of sources) { try { log(`尝试数据源: ${name}`); const data=normalize(await get(url),date,url); if(data?.news?.length){log(`成功: ${name}，${data.news.length} 条`); return data;} } catch(e){log(`失败: ${name} - ${e.message}`);} }
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
