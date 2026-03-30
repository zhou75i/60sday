import puppeteer from 'puppeteer';
import { Octokit } from '@octokit/rest';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import deepEqual from 'fast-deep-equal';

dotenv.config();

// 1. 先单独提取仓库配置（避免CONFIG内部自引用）
const REPO_CONFIG = {
    owner: process.env.REPO_OWNER,
    name: process.env.REPO_NAME,
    branch: process.env.BRANCH || 'main',
    imgPath: 'static/images/',
    jsonPath: 'static/60s/'
};

// 2. 初始化GitHub客户端
const octokit = new Octokit({ auth: process.env.GH_TOKEN });

// 3. 核心配置（使用独立的REPO_CONFIG，避免内部自引用）
const CONFIG = {
    repo: REPO_CONFIG,
    api: {
        url: 'https://60s.viki.moe/v2/60s',
        timeout: 10000
    },
    json: {
        source: 'https://60s-static.viki.moe/',
        imageRepoPrefix: `https://cdn.jsdmirror.com/gh/${REPO_CONFIG.owner}/${REPO_CONFIG.name}@main/static/images/`
    }
};

// 校验环境变量
if (!process.env.GH_TOKEN) {
    console.error('❌ 缺少环境变量：GH_TOKEN（GitHub访问令牌）');
    process.exit(1);
}
if (!REPO_CONFIG.owner || !REPO_CONFIG.name) {
    console.error('❌ 缺少环境变量：REPO_OWNER 或 REPO_NAME（GitHub仓库配置）');
    process.exit(1);
}

// ====================== 修复：精准北京时间 ======================
function getTodayDate() {
    return new Date().toLocaleDateString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).replace(/\//g, '-');
}
function getBeijingTimeStamp() {
    return new Date().toLocaleString('zh-CN', { 
        timeZone: 'Asia/Shanghai',
        hour12: false 
    });
}

// ====================== 核心修复：彻底禁用API缓存 ======================
async function fetchAndCheckApiData() {
    const today = getTodayDate();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.api.timeout);

    try {
        console.log(`[${getBeijingTimeStamp()}] 请求API获取当日(${today})数据...`);
        
        const response = await fetch(CONFIG.api.url, {
            method: 'GET',
            signal: controller.signal,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://60s.viki.moe/',
                // ✅ 强制禁用所有缓存（根治返回旧数据问题）
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            }
        });

        clearTimeout(timeoutId);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const apiRes = await response.json();
        const apiData = apiRes.data || {};

        // 校验日期
        if (apiData.date !== today) {
            console.log(`[${getBeijingTimeStamp()}] ❌ API未更新，返回日期：${apiData.date || '无'}`);
            process.exit(1);
        }

        // 校验字段
        const requiredFields = ['date', 'news', 'tip', 'updated_at'];
        const missingFields = requiredFields.filter(field => !apiData[field]);
        if (missingFields.length > 0) {
            throw new Error(`缺失字段：${missingFields.join(', ')}`);
        }

        console.log(`[${getBeijingTimeStamp()}] ✅ 获取当日数据成功`);
        return apiData;

    } catch (err) {
        clearTimeout(timeoutId);
        const msg = err.name === 'AbortError' ? '请求超时' : err.message;
        console.error(`[${getBeijingTimeStamp()}] 请求失败：${msg}`);
        process.exit(1);
    }
}

// ====================== 原有功能（无修改） ======================
function processJsonData(rawData) {
    const processed = { ...rawData };
    delete processed.cover; 
    processed.source = CONFIG.json.source; 
    if (processed.date) {
        processed.image = `${CONFIG.json.imageRepoPrefix}${processed.date}.png`;
    }
    return processed;
}

async function getExistingJsonFile(date) {
    const jsonFilePath = `${CONFIG.repo.jsonPath}${date}.json`;
    try {
        const res = await octokit.rest.repos.getContent({
            owner: CONFIG.repo.owner,
            repo: CONFIG.repo.name,
            path: jsonFilePath,
            ref: CONFIG.repo.branch
        });
        const content = Buffer.from(res.data.content, 'base64').toString('utf8');
        return JSON.parse(content);
    } catch (err) {
        if (err.status === 404) return null;
        throw new Error(`获取已有JSON失败：${err.message}`);
    }
}

async function uploadToGitHub(filePath, content, isJson = false) {
    try {
        const existingFile = await octokit.rest.repos.getContent({
            owner: CONFIG.repo.owner,
            repo: CONFIG.repo.name,
            path: filePath,
            ref: CONFIG.repo.branch
        }).catch(() => null);

        let contentBase64 = Buffer.isBuffer(content) 
            ? content.toString('base64') 
            : Buffer.from(content, 'utf8').toString('base64');

        await octokit.rest.repos.createOrUpdateFileContents({
            owner: CONFIG.repo.owner,
            repo: CONFIG.repo.name,
            path: filePath,
            message: `Auto update 60s ${isJson ? 'JSON' : 'image'}: ${path.basename(filePath)}`,
            content: contentBase64,
            branch: CONFIG.repo.branch,
            sha: existingFile?.data?.sha
        });
        console.log(`✅ 成功${existingFile ? '覆盖' : '创建'}：${filePath}`);
    } catch (err) {
        throw new Error(`上传失败[${filePath}]：${err.message}`);
    }
}

async function generateImage(data) {
    let browser;
    try {
        browser = await puppeteer.launch({
            args: [
                '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
                '--disable-gpu','--allow-file-access-from-files','--disable-web-security',
                '--ignore-certificate-errors','--ignore-ssl-errors'
            ],
            headless: 'new',
            defaultViewport: { width: 1080, height: 6000, deviceScaleFactor: 2 },
            timeout: 60000
        });

        const page = await browser.newPage();
        page.on('console', msg => console.log(`[页面日志] ${msg.text()}`));
        page.on('pageerror', err => console.error(`[页面错误] ${err.message}`));

        const templatePath = path.resolve(process.cwd(), 'src/template.html');
        await page.goto(`file://${templatePath}`, { waitUntil: 'domcontentloaded' });

        await page.evaluate((injectData, repoOwner, repoName) => {
            window.DATA = injectData;
            window.REPO_OWNER = repoOwner;
            window.REPO_NAME = repoName;
        }, data, CONFIG.repo.owner, CONFIG.repo.name);

        await new Promise(resolve => setTimeout(resolve, 2000));
        await page.evaluate(async () => await generate());

        const imageBase64 = await page.waitForFunction(() => window.IMAGE_BASE64, {
            timeout: 180000, polling: 1000
        });
        return imageBase64.jsonValue();
    } catch (err) {
        throw new Error(`图片生成失败：${err.message}`);
    } finally {
        if (browser) await browser.close();
    }
}

// ====================== 主函数 ======================
async function main() {
    const today = getTodayDate();
    try {
        const apiData = await fetchAndCheckApiData();
        const processedJson = processJsonData(apiData);
        const existingJson = await getExistingJsonFile(today);

        if (!existingJson || !deepEqual(processedJson, existingJson)) {
            const jsonContent = JSON.stringify(processedJson, null, 2);
            await uploadToGitHub(`${CONFIG.repo.jsonPath}${today}.json`, jsonContent, true);
        } else {
            console.log(`✅ 当日JSON无变化，跳过`);
        }

        const imageBase64 = await generateImage(apiData);
        const imageBuffer = Buffer.from(imageBase64.split(',')[1], 'base64');
        await uploadToGitHub(`${CONFIG.repo.imgPath}${today}.png`, imageBuffer);

        console.log(`[${getBeijingTimeStamp()}] 🎉 今日任务全部完成`);
        process.exit(0);
    } catch (err) {
        console.error(`[${getBeijingTimeStamp()}] ❌ 任务失败：${err.message}`);
        process.exit(1);
    }
}

main();
