# 60s 每日新闻

 <a href="https://github.com/zhou75i"><img alt="Author" src="https://img.shields.io/badge/author-zhou75i-blueviolet"/></a>

自动化每日新闻聚合服务，通过CDN 提供 JSON 数据和图片访问。

**🔗 项目主页**: https://zhou75i.github.io/60sday

## 快速开始

### API 端点

将 `[date]` 替换为 `YYYY-MM-DD` 格式的日期，例如 `2025-10-24`

**JSON 数据:**
```
https://raw.githubusercontent.com/zhou75i/60sday/refs/heads/main/static/60s/[date].json
https://cdn.jsdelivr.net/gh/zhou75i/60sday@main/static/60s/[date].json
https://cdn.jsdmirror.com/gh/zhou75i/60sday@main/static/60s/[date].json
```

**PNG 图片:**
```
https://raw.githubusercontent.com/zhou75i/60sday/refs/heads/main/static/images/[date].png
https://cdn.jsdelivr.net/gh/zhou75i/60sday@main/static/images/[date].png
https://cdn.jsdmirror.com/gh/zhou75i/60sday@main/static/images/[date].png
```

### 示例请求

```bash
# 获取 2025-12-31 的新闻数据
curl https://raw.githubusercontent.com/zhou75i/60sday/refs/heads/main/static/60s/2025-12-31.json

# 获取对应的图片
curl https://cdn.jsdmirror.com/gh/zhou75i/60sday@main/static/images/2025-12-31.png
```

## 数据格式

```json
{

  "date": "2025-12-31",
  "news": [
    "新闻条目 1",
    "新闻条目 2",
    "..."
  ],
  "tip": "微语",
  "image": "https://...",
  "link": "https://...",
  "created": "2025/12/31 01:44",
  "created_at": 1767116656000,
  "updated": "2025/12/31 01:44",
  "updated_at": 1767116656000,
  "day_of_week": "星期三",
  "lunar_date": "乙巳年十一月十二",
  "api_updated": "2025/12/31 01:57:57",
  "api_updated_at": 1767117477351,
  "source": "https://..."
}
```

**字段说明:**

| 字段 | 类型 | 说明 |
|------|------|------|
| `date` | string | 日期 (YYYY-MM-DD) |
| `news` | string[] | 新闻列表 (~15条) |
| `tip` | string | 每日金句 |
| `image` | string | 生成的新闻卡片图片 URL |
| `link` | string | 原文链接 |
| `created` | string | 创建时间 (可读格式) |
| `created_at` | number | 创建时间戳 (毫秒) |
| `updated` | string | 更新时间 (可读格式) |
| `updated_at` | number | 更新时间戳 (毫秒) |
| `day_of_week` | string | 星期 |
| `lunar_date` | string | 农历日期 |
| `api_updated` | string | 本仓库更新时间 (可读格式) |
| `api_updated_at` | number | 本仓库更新时间戳 (毫秒) |
| `source` | string | 数据来源 |

## 更新时间

数据每日自动更新，时间窗口: **01:20 - 02:00 (UTC+8)**

**🔗 Github部署**: 

### 一： [Fork 本仓库](https://github.com/zhou75i/60sday/fork)


### 二：添加变量：GH_TOKEN、REPO_NAME、REPO_OWNER

添加 Secrets 到 GitHub 仓库

打开你的 GitHub 仓库，点击 Settings（设置）。

在左侧菜单栏找到 Secrets and variables → Actions。

点击 New repository secret，依次添加以下 3 个 Secrets：

Name: GH_TOKEN → Value: 生成的 Personal Access Token。

Name: REPO_OWNER → Value: 你的 GitHub 用户名（比如 zhou75i）。

Name: REPO_NAME → Value: 你的仓库名（比如 60sday）。


## 项目数据来源

[vikiboss/60s-static-host](https://github.com/vikiboss/60s-static-host)

---


**⚠️ 免责声明**: 数据来源于公开网络，不保证准确性。本项目与任何新闻机构无关联。
