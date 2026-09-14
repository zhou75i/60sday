import fs from 'fs';
import path from 'path';
import axios from 'axios';
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);

// ==================== 参数 ====================

let targetDate = '';

for (const arg of args) {
  if (arg.startsWith('--date=')) {
    targetDate = arg.substring('--date='.length);
  }
}

if (!targetDate) {
  const now = new Date();
  targetDate = now.toISOString().split('T')[0];
}

if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
  throw new Error(`日期格式错误：${targetDate}`);
}

// ==================== 环境变量 ====================

// 与 GitHub Actions 完全匹配
const MAX_RETRIES = Math.max(
  1,
  Number(process.env.MAX_RETRIES || 3)
);

const RETRY_BASE_MS = Math.max(
  1000,
  Number(process.env.RETRY_BASE_MS || 3000)
);

const REQUEST_TIMEOUT = Math.max(
  5000,
  Number(process.env.REQUEST_TIMEOUT || 15000)
);

const REPO_OWNER =
  process.env.REPO_OWNER || '';

const REPO_NAME =
  process.env.REPO_NAME || '';

// ==================== 请求配置 ====================

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',

  Accept:
    'application/json, text/plain, */*',

  'Accept-Language':
    'zh-CN,zh;q=0.9,en;q=0.8',

  'Cache-Control':
    'no-cache',

  Pragma:
    'no-cache'
};

// ==================== 日志 ====================

function log(message) {
  console.log(
    `[${new Date().toLocaleString('zh-CN', {
      hour12: false
    })}] ${message}`
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getErrorMessage(error) {
  if (error.response) {
    const status = error.response.status;

    let detail = '';

    if (typeof error.response.data === 'string') {
      detail = error.response.data.substring(0, 200);
    } else if (error.response.data) {
      detail = JSON.stringify(error.response.data).substring(0, 200);
    }

    return `HTTP ${status}${detail ? `：${detail}` : ''}`;
  }

  return error.message || '未知错误';
}

// ==================== 请求 JSON ====================

async function requestJson(url) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      log(`请求：${url}`);
      log(`第 ${attempt}/${MAX_RETRIES} 次`);

      const response = await axios.get(url, {
        timeout: REQUEST_TIMEOUT,

        headers: {
          ...DEFAULT_HEADERS
        },

        validateStatus: () => true
      });

      const status = response.status;

      if (status >= 200 && status < 300) {
        return response.data;
      }

      lastError = new Error(`HTTP ${status}`);

      // 这些状态码允许重试
      const retryable =
        status === 403 ||
        status === 408 ||
        status === 425 ||
        status === 429 ||
        status === 500 ||
        status === 502 ||
        status === 503 ||
        status === 504;

      if (!retryable) {
        throw lastError;
      }

      log(`请求失败：HTTP ${status}`);

      if (attempt < MAX_RETRIES) {
        const retryAfterHeader =
          response.headers?.['retry-after'];

        const retryAfterSeconds =
          Number(retryAfterHeader || 0);

        const exponentialDelay =
          RETRY_BASE_MS * Math.pow(2, attempt - 1);

        // Retry-After 优先，否则指数退避
        const waitTime =
          retryAfterSeconds > 0
            ? retryAfterSeconds * 1000
            : exponentialDelay;

        log(`等待 ${waitTime}ms 后重试...`);

        await sleep(waitTime);
      }
    } catch (error) {
      lastError = error;

      log(`请求异常：${getErrorMessage(error)}`);

      if (attempt < MAX_RETRIES) {
        const waitTime =
          RETRY_BASE_MS * Math.pow(2, attempt - 1);

        log(`等待 ${waitTime}ms 后重试...`);

        await sleep(waitTime);
      }
    }
  }

  throw lastError || new Error('请求失败');
}

// ==================== 数据标准化 ====================

function normalizeNewsData(raw, dateStr) {
  if (!raw) return null;

  let data = raw;

  // 兼容 { data: {...} }
  if (
    raw.data &&
    typeof raw.data === 'object' &&
    !Array.isArray(raw.data)
  ) {
    data = raw.data;
  }

  // 兼容 { news: [...] }
  if (Array.isArray(data.news)) {
    return {
      ...data,
      date: data.date || dateStr,
      news: data.news,
      tip: data.tip || data.weiyu || ''
    };
  }

  // 兼容 { data: [...] }
  if (Array.isArray(data.data)) {
    return {
      date: dateStr,
      news: data.data,
      tip: data.tip || data.weiyu || ''
    };
  }

  // 兼容直接数组
  if (Array.isArray(data)) {
    return {
      date: dateStr,
      news: data,
      tip: ''
    };
  }

  return null;
}

function validateNewsData(data) {
  if (!data) return false;

  if (!Array.isArray(data.news)) {
    return false;
  }

  if (data.news.length === 0) {
    return false;
  }

  return true;
}

// ==================== 日期校验 ====================

function isSameDate(data, targetDate) {
  if (!data || !data.date) {
    return true;
  }

  const date = String(data.date);

  return (
    date === targetDate ||
    date.startsWith(targetDate)
  );
}

// ==================== 获取新闻 ====================

async function getNewsData(dateStr) {
  const encodedDate = encodeURIComponent(dateStr);

  /*
   * 数据源说明：
   *
   * 1. 静态 JSON：优先，适合指定日期
   * 2. GitHub Raw：备用
   * 3. qqsuu：备用 API
   * 4. vvhan / jun.la：仅作为最后备用
   *
   * 注意：
   * 最后两个接口可能不支持指定日期，
   * 因此如果返回数据带日期且不是目标日期，会跳过。
   */

  const sources = [
    {
      name: '60s-static-host / jsDelivr',

      url:
        `https://cdn.jsdelivr.net/gh/vikiboss/60s-static-host@main/static/60s/${encodedDate}.json`,

      supportsDate: true
    },

    {
      name: '60s-static-host / GitHub Raw',

      url:
        `https://raw.githubusercontent.com/vikiboss/60s-static-host/main/static/60s/${encodedDate}.json`,

      supportsDate: true
    },

    {
      name: 'qqsuu.cn API',

      url:
        `https://api.qqsuu.cn/api/dm-60s?date=${encodedDate}`,

      supportsDate: true
    },

    {
      name: 'vvhan API',

      url:
        `https://api.vvhan.com/api/60s?type=json`,

      supportsDate: false
    },

    {
      name: 'jun.la API',

      url:
        `https://api.jun.la/60s.php?format=json`,

      supportsDate: false
    }
  ];

  for (const source of sources) {
    try {
      log(`尝试数据源：${source.name}`);

      const raw = await requestJson(source.url);

      const data = normalizeNewsData(raw, dateStr);

      if (!validateNewsData(data)) {
        log(`数据格式不符合要求：${source.name}`);
        continue;
      }

      // 对支持日期的数据源进行日期校验
      if (
        source.supportsDate &&
        !isSameDate(data, dateStr)
      ) {
        log(
          `返回日期不匹配，跳过：${data.date || '未知日期'}`
        );

        continue;
      }

      // 不支持日期的备用接口：
      // 只有在没有明确返回其他日期时才允许使用
      if (
        !source.supportsDate &&
        data.date &&
        !isSameDate(data, dateStr)
      ) {
        log(
          `备用接口返回其他日期，跳过：${data.date}`
        );

        continue;
      }

      log(`✅ 数据源成功：${source.name}`);
      log(`新闻数量：${data.news.length}`);

      return data;
    } catch (error) {
      log(
        `⚠️ 数据源失败：${source.name}：${getErrorMessage(error)}`
      );
    }
  }

  throw new Error(
    `所有数据源均无法获取新闻：${dateStr}`
  );
}

// ==================== 原子写入 ====================

function atomicWriteFile(filePath, content) {
  const tempPath = `${filePath}.tmp`;

  fs.writeFileSync(
    tempPath,
    content
  );

  fs.renameSync(
    tempPath,
    filePath
  );
}

// ==================== 主流程 ====================

async function run() {
  log(`请求API获取当日(${targetDate})数据...`);

  const data = await getNewsData(targetDate);

  const outputDir =
    path.resolve('static/60s');

  const imgOutputDir =
    path.resolve('static/images');

  fs.mkdirSync(
    outputDir,
    { recursive: true }
  );

  fs.mkdirSync(
    imgOutputDir,
    { recursive: true }
  );

  const jsonFilePath =
    path.join(outputDir, `${targetDate}.json`);

  const imagePath =
    path.join(imgOutputDir, `${targetDate}.png`);

  // ==================== 读取模板 ====================

  const templatePath =
    path.resolve('src/template.html');

  if (!fs.existsSync(templatePath)) {
    throw new Error(
      `模板文件不存在：${templatePath}`
    );
  }

  let htmlContent =
    fs.readFileSync(templatePath, 'utf-8');

  // 兼容常见日期占位符
  htmlContent =
    htmlContent.replace(
      /\{\{\s*date\s*\}\}/g,
      targetDate
    );

  // ==================== 启动浏览器 ====================

  const browser = await puppeteer.launch({
    headless: true,

    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--font-render-hinting=none'
    ]
  });

  try {
    const page = await browser.newPage();

    await page.setViewport({
      width: 1080,
      height: 800,
      deviceScaleFactor: 1
    });

    await page.setContent(
      htmlContent,
      {
        waitUntil: 'networkidle0'
      }
    );

    // 将数据传入模板
    await page.evaluate(
      ({ data, repoOwner, repoName }) => {
        window.DATA = data;
        window.REPO_OWNER = repoOwner;
        window.REPO_NAME = repoName;
      },
      {
        data,
        repoOwner: REPO_OWNER,
        repoName: REPO_NAME
      }
    );

    // 等待字体加载完成
    await page.evaluate(async () => {
      if (document.fonts) {
        await document.fonts.ready;
      }
    });

    // 执行模板中的 generate()
    await page.evaluate(async () => {
      if (typeof generate !== 'function') {
        throw new Error(
          'template.html 中不存在 generate() 函数'
        );
      }

      await generate();
    });

    // 从模板获取图片
    const imageBase64 = await page.evaluate(() => {
      if (window.IMAGE_ERROR) {
        throw new Error(window.IMAGE_ERROR);
      }

      return window.IMAGE_BASE64;
    });

    if (!imageBase64) {
      throw new Error(
        '模板没有返回 IMAGE_BASE64'
      );
    }

    const imageBuffer = Buffer.from(
      imageBase64.replace(
        /^data:image\/png;base64,/,
        ''
      ),
      'base64'
    );

    if (!imageBuffer.length) {
      throw new Error(
        '生成的图片数据为空'
      );
    }

    // ==================== 成功后才写入 ====================

    atomicWriteFile(
      jsonFilePath,
      JSON.stringify(data, null, 2)
    );

    atomicWriteFile(
      imagePath,
      imageBuffer
    );

    log(`✅ JSON 已保存：${jsonFilePath}`);
    log(`✅ 图片已保存：${imagePath}`);
  } finally {
    await browser.close();
  }
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
