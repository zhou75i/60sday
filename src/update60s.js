import fs from 'fs';
import path from 'path';
import axios from 'axios';
import puppeteer from 'puppeteer';

// 解析参数获取日期
const args = process.argv.slice(2);
let targetDate = '';
for (const arg of args) {
  if (arg.startsWith('--date=')) {
    targetDate = arg.split('=')[1];
  }
}

if (!targetDate) {
  const now = new Date();
  targetDate = now.toISOString().split('T')[0];
}

console.log(`[\({new Date().toLocaleString('zh-CN', { hour12: false })}] 目标日期:\){targetDate}`);

// 常见浏览器请求头，避免触发目标站 403 拦截
const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Referer': 'https://www.zhihu.com/',
  'Cache-Control': 'no-cache'
};

// 获取 60s 数据的多源适配与降级机制
async function getNewsData(dateStr) {
  // 备选接口列表
  const sources = [
    {
      name: '第三方备用源1 (vvhan)',
      url: 'https://api.vvhan.com/api/60s?type=json',
      parser: (res) => {
        if (res.data && res.data.success && Array.isArray(res.data.data)) {
          return {
            date: dateStr,
            news: res.data.data,
            tip: res.data.tip || ''
          };
        }
        return null;
      }
    },
    {
      name: '第三方备用源2 (jun.la)',
      url: 'https://api.jun.la/60s.php?format=json',
      parser: (res) => {
        const d = res.data?.data || res.data;
        if (Array.isArray(d?.news || d)) {
          return {
            date: dateStr,
            news: d.news || d,
            tip: d.tip || ''
          };
        }
        return null;
      }
    }
  ];

  // 1. 先尝试请求你原本的主接口（携带伪装 Header）
  try {
    console.log(`[\({new Date().toLocaleString('zh-CN', { hour12: false })}] 请求API获取当日(\){dateStr})数据...`);
    const mainApiUrl = `https://api.qqsuu.cn/api/dm-60s?date=${dateStr}`; // 若有指定的私有/特定API可填在此处
    
    const response = await axios.get(mainApiUrl, {
      headers: DEFAULT_HEADERS,
      timeout: 10000
    });

    if (response.status === 200 && response.data) {
      // 若你的主要API直接返回数据，按原有格式返回
      const d = response.data.data || response.data;
      if (Array.isArray(d.news || d)) {
        return {
          date: dateStr,
          news: d.news || d,
          tip: d.tip || ''
        };
      }
    }
  } catch (err) {
    const statusMsg = err.response ? `HTTP ${err.response.status}` : err.message;
    console.warn(`[\({new Date().toLocaleString('zh-CN', { hour12: false })}] 主接口请求失败：\){statusMsg}，尝试备用数据源...`);
  }

  // 2. 主接口 403 或失败，自动降级轮询备用源
  for (const src of sources) {
    try {
      console.log(`正在尝试通过 [${src.name}] 获取数据...`);
      const resp = await axios.get(src.url, {
        headers: DEFAULT_HEADERS,
        timeout: 10000
      });
      const parsed = src.parser(resp);
      if (parsed && parsed.news && parsed.news.length > 0) {
        console.log(`✅ 成功从 [${src.name}] 获取到新闻数据`);
        return parsed;
      }
    } catch (e) {
      console.warn(`⚠️ [\({src.name}] 访问失败:\){e.message}`);
    }
  }

  throw new Error('所有数据源均无法获取当日新闻，可能当日尚未更新或网络受阻。');
}

async function run() {
  const data = await getNewsData(targetDate);

  // 存储 JSON 数据
  const outputDir = path.resolve('static/60s');
  const imgOutputDir = path.resolve('static/images');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(imgOutputDir, { recursive: true });

  const jsonFilePath = path.join(outputDir, `${targetDate}.json`);
  fs.writeFileSync(jsonFilePath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`✅ 数据已保存到: ${jsonFilePath}`);

  // 读取 HTML 模板
  const templatePath = path.resolve('src/template.html');
  let htmlContent = fs.readFileSync(templatePath, 'utf-8');

  // 替换模板中的占位符
  htmlContent = htmlContent.replace(/\{\{\s*date\s*\}\}/g, targetDate);
  
  const newsListHtml = data.news
    .map((item, idx) => `
