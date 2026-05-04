const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://c.biancheng.net';
const INDEX_URL = `${BASE_URL}/c/`;
const OUTPUT_FILE = path.join(__dirname, 'documents', 'c-biancheng-c-tutorial.txt');
const DELAY_MS = 500;

function fetchPage(url) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, { timeout: 15000 }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchPage(res.headers.location).then(resolve).catch(reject);
            }
            let data = '';
            res.setEncoding('utf-8');
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

function extractLinks(html) {
    const linkRegex = /href=["']([^"']*\/view\/[^"']*)/gi;
    const links = [];
    let match;
    while ((match = linkRegex.exec(html)) !== null) {
        let href = match[1];
        if (href.startsWith('/')) {
            href = BASE_URL + href;
        }
        if (href.includes('/view/') && !links.includes(href)) {
            links.push(href);
        }
    }
    return links;
}

function extractArticleContent(html) {
    let content = '';

    const mainContentMatch = html.match(/<div[^>]*id=["']arc-body["'][^>]*>([\s\S]*?)<\/div>\s*<div/i)
        || html.match(/<div[^>]*id=["']arc-body["'][^>]*>([\s\S]*?)<\/div>/i);

    if (mainContentMatch) {
        content = mainContentMatch[1];
    }

    if (!content) {
        const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
        content = bodyMatch ? bodyMatch[1] : html;
    }

    content = content
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<aside[\s\S]*?<\/aside>/gi, '')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, '\n\n## $1\n\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<\/li>/gi, '\n')
        .replace(/<li[^>]*>/gi, '- ')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&hellip;/g, '…')
        .replace(/&mdash;/g, '—')
        .replace(/&ldquo;/g, '"')
        .replace(/&rdquo;/g, '"')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    const noisePatterns = [
        /^[- ]*首页\s*$/gm,
        /^[- ]*C语言教程\s*$/gm,
        /^[- ]*C\+\+教程\s*$/gm,
        /^[- ]*Python教程\s*$/gm,
        /^[- ]*Java教程\s*$/gm,
        /^[- ]*Linux入门\s*$/gm,
        /^[- ]*更多>>\s*$/gm,
        /^目录\s*$/gm,
        /^阅读：\d+.*$/gm,
        /^\s*首页\s*>\s*.*$/gm,
        /^新手在线学习编程.*$/gm,
        /^关于网站.*$/gm,
        /^联系我们.*$/gm,
        /^新版网站地图.*$/gm,
        /^旧版网站地图.*$/gm,
        /^C语言函数手册\s*$/gm,
        /^Copyright.*$/gm,
        /^ICP备案.*$/gm,
        /^公安联网备案.*$/gm,
        /^\^$/gm,
        /^上一页.*$/gm,
        /^下一页.*$/gm,
        /^上一篇.*$/gm,
        /^下一篇.*$/gm,
    ];

    for (const pattern of noisePatterns) {
        content = content.replace(pattern, '');
    }

    content = content
        .replace(/^C语言入门教程\s*\n\s*\d+\s*\n.*?(?=\n\s*\d+\s*\n|\n##)/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return content;
}

function extractTitle(html) {
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) {
        return titleMatch[1]
            .replace(/ - C语言中文网.*$/i, '')
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, '&')
            .trim();
    }
    return '';
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    console.log('=== C语言中文网教程爬虫 ===');
    console.log(`索引页: ${INDEX_URL}`);

    let indexHtml;
    try {
        indexHtml = await fetchPage(INDEX_URL);
        console.log(`索引页获取成功，长度: ${indexHtml.length}`);
    } catch (e) {
        console.error(`索引页获取失败: ${e.message}`);
        return;
    }

    const articleLinks = extractLinks(indexHtml);
    console.log(`从索引页提取到 ${articleLinks.length} 个文章链接`);

    if (articleLinks.length === 0) {
        console.log('未找到文章链接，尝试直接抓取章节页面...');

        const chapterUrls = [];
        for (let i = 10; i <= 200; i += 10) {
            chapterUrls.push(`${BASE_URL}/c/${i}/`);
        }

        for (const chapterUrl of chapterUrls) {
            try {
                const chapterHtml = await fetchPage(chapterUrl);
                const chapterLinks = extractLinks(chapterHtml);
                chapterLinks.forEach(link => {
                    if (!articleLinks.includes(link)) {
                        articleLinks.push(link);
                    }
                });
                console.log(`  章节 ${chapterUrl}: +${chapterLinks.length} 链接`);
            } catch (e) {
                console.log(`  章节 ${chapterUrl}: 跳过 (${e.message})`);
            }
            await sleep(200);
        }

        console.log(`从章节页面共提取到 ${articleLinks.length} 个文章链接`);
    }

    if (articleLinks.length === 0) {
        console.log('仍未找到文章链接，退出');
        return;
    }

    const allContent = [];
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < articleLinks.length; i++) {
        const url = articleLinks[i];
        console.log(`[${i + 1}/${articleLinks.length}] ${url}`);

        try {
            const html = await fetchPage(url);
            const title = extractTitle(html);
            const content = extractArticleContent(html);

            if (content.length > 50) {
                allContent.push(`\n${'='.repeat(60)}\n${title}\n${'='.repeat(60)}\n\n${content}\n`);
                successCount++;
            } else {
                console.log(`  内容过短 (${content.length} chars)，跳过`);
                failCount++;
            }
        } catch (e) {
            console.log(`  获取失败: ${e.message}`);
            failCount++;
        }

        await sleep(DELAY_MS);
    }

    const finalContent = `C语言入门教程 - 来自C语言中文网 (c.biancheng.net)\n抓取时间: ${new Date().toISOString()}\n文章数: ${successCount}\n${'='.repeat(60)}\n\n${allContent.join('\n')}`;

    const outputDir = path.dirname(OUTPUT_FILE);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(OUTPUT_FILE, finalContent, 'utf-8');
    console.log(`\n=== 完成 ===`);
    console.log(`成功: ${successCount}, 失败: ${failCount}`);
    console.log(`输出文件: ${OUTPUT_FILE}`);
    console.log(`文件大小: ${(fs.statSync(OUTPUT_FILE).size / 1024).toFixed(1)} KB`);
}

main().catch(console.error);
