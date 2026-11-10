#!/usr/bin/env node
/**
 * RSS 订阅源生成脚本
 * 读取 posts.json 生成 rss.xml；内容无变化时不写文件（保证 CI 幂等，避免循环触发）。
 * 用法：node scripts/generate-rss.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const SITE_URL = 'https://www.anliways.com';
const FEED_TITLE = 'Anliways 的博客';
const FEED_DESC = 'Anliways 的个人博客：技术见解、行业观察与深度思考随笔。';

function escapeXml(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// 解析日期：支持 ISO（"2026-10-28"）与中文（"2026年7月10日"），无法解析时回退为当前时间
function parseDate(str) {
    const s = String(str || '').trim();
    const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (iso) {
        const d = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
        if (!isNaN(d.getTime())) return d;
    }
    const m = s.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    if (m) {
        const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
        if (!isNaN(d.getTime())) return d;
    }
    return new Date();
}

function toRfc822(date) {
    return date.toUTCString();
}

const postsPath = path.join(root, 'posts.json');
const posts = JSON.parse(fs.readFileSync(postsPath, 'utf8'));

const items = posts.map(p => {
    const link = p.fullUrl || `${SITE_URL}/#/blog/${encodeURIComponent(p.id)}`;
    const pubDate = toRfc822(parseDate(p.date));
    const desc = p.excerpt || p.summary || '';
    return `    <item>
      <title>${escapeXml(p.title || p.id)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="false">Anliways-post-${escapeXml(p.id)}</guid>
      <pubDate>${pubDate}</pubDate>
      ${desc ? `<description>${escapeXml(desc)}</description>` : ''}
    </item>`;
}).join('\n');

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(FEED_TITLE)}</title>
    <link>${SITE_URL}</link>
    <description>${escapeXml(FEED_DESC)}</description>
    <language>zh-CN</language>
    <lastBuildDate>${toRfc822(new Date())}</lastBuildDate>
    <atom:link href="${SITE_URL}/rss.xml" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>
`;

const outPath = path.join(root, 'rss.xml');
if (fs.existsSync(outPath) && fs.readFileSync(outPath, 'utf8') === xml) {
    console.log('rss.xml 无变化，跳过写入。');
} else {
    fs.writeFileSync(outPath, xml);
    console.log(`rss.xml 已生成，共 ${posts.length} 篇文章。`);
}
