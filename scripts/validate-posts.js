#!/usr/bin/env node
/**
 * 内容数据校验脚本
 * 校验 posts.json 与 posts/ 目录保持同步，以及 projects.json 的结构完整性。
 * 用法：node scripts/validate-posts.js（CI 中同样执行此命令）
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const errors = [];
const warns = [];

function loadJSON(file) {
    try {
        return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    } catch (e) {
        errors.push(`${file} JSON 解析失败: ${e.message}`);
        return null;
    }
}

const posts = loadJSON('posts.json');
const projects = loadJSON('projects.json');

// --- posts.json 与 posts/ 目录双向核对 ---
const postsDir = path.join(root, 'posts');
const mdFiles = fs.existsSync(postsDir)
    ? fs.readdirSync(postsDir).filter(f => f.endsWith('.md'))
    : [];

if (posts) {
    posts.forEach((p, i) => {
        if (!p.id) {
            errors.push(`posts.json[${i}] 缺少 id 字段`);
        } else if (!mdFiles.includes(p.id + '.md')) {
            errors.push(`posts.json 登记的文章 "${p.id}" 缺少对应文件 posts/${p.id}.md`);
        }
        if (!p.title) warns.push(`posts.json[${i}] 缺少 title 字段`);
        if (!p.date) warns.push(`posts.json[${i}] 缺少 date 字段`);
    });
    mdFiles.forEach(f => {
        const id = f.replace(/\.md$/, '');
        if (!posts.some(p => p.id === id)) {
            errors.push(`posts/${f} 存在但未在 posts.json 中登记`);
        }
    });
}

// --- projects.json 结构完整性 ---
if (projects) {
    projects.forEach((pr, i) => {
        if (!pr.id || !pr.title_zh || !pr.icon) {
            errors.push(`projects.json[${i}] 缺少 id / title_zh / icon 字段`);
        }
        (pr.subItems || []).forEach((s, j) => {
            if (!s.title_zh) errors.push(`projects.json[${i}].subItems[${j}] 缺少 title_zh 字段`);
        });
    });
}

warns.forEach(w => console.log('警告:', w));
if (errors.length) {
    errors.forEach(e => console.error('错误:', e));
    console.error(`校验失败，共 ${errors.length} 个错误。`);
    process.exit(1);
}
console.log('校验通过：posts.json / posts/ 同步一致，projects.json 结构完整。');
