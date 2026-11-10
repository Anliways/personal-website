/**
 * 本地联调服务器：模拟 Vercel Functions 运行时 + GitHub API。
 * 仅用于本地验证 admin 改造，不进入仓库部署路径之外的生产流程。
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
process.env.GITHUB_TOKEN = 'local-test-token';
process.env.SESSION_SECRET = 'local-test-secret';

/* ---------- 模拟 GitHub API 的内存对象存储 ---------- */
const files = new Map();          // path -> content string
const blobs = new Map();          // sha -> content
['projects.json', 'posts.json', 'posts/test-article.md', 'site-config.json'].forEach(p => {
  files.set(p, fs.readFileSync(path.join(ROOT, p), 'utf8'));
});
let commitCount = 0;

async function mockFetch(url, opts = {}) {
  if (!url.startsWith('https://api.github.com')) return fetch._real(url, opts);
  const u = new URL(url);
  const p = u.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '');
  const ok = j => new Response(JSON.stringify(j), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const notFound = () => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });

  if (reqAuth(opts) !== 'Bearer local-test-token') return new Response('{}', { status: 401 });

  // contents
  if (p.startsWith('/contents/')) {
    const fp = decodeURIComponent(p.slice('/contents/'.length).split('?')[0]);
    if (files.has(fp)) {
      return ok({ sha: 'f_' + fp, content: Buffer.from(files.get(fp), 'utf8').toString('base64') });
    }
    return notFound();
  }
  // git data flow
  if (p === '/git/ref/heads/main') return ok({ object: { sha: 'base' + commitCount } });
  if (p.startsWith('/git/commits/base')) return ok({ tree: { sha: 'basetree' } });
  if (p === '/git/blobs' && opts.method === 'POST') {
    const body = JSON.parse(opts.body);
    const sha = 'b' + crypto.randomBytes(6).toString('hex');
    blobs.set(sha, { content: body.content, encoding: body.encoding || 'utf-8' });
    return ok({ sha });
  }
  if (p === '/git/trees' && opts.method === 'POST') {
    const body = JSON.parse(opts.body);
    for (const item of body.tree) {
      if (item.sha === null) { files.delete(item.path); continue; }
      const blob = blobs.get(item.sha);
      const content = blob ? blob.content : '';
      files.set(item.path, content);
      // 写穿到磁盘：前台静态服务从磁盘读文件，保证保存后前台能立即验证
      try {
        fs.writeFileSync(path.join(ROOT, item.path),
          blob && blob.encoding === 'base64' ? Buffer.from(content, 'base64') : content);
      } catch (_) {}
    }
    return ok({ sha: 'tree_' + (++commitCount) });
  }
  if (p === '/git/commits' && opts.method === 'POST') return ok({ sha: 'commit_' + commitCount });
  if (p === '/git/refs/heads/main' && opts.method === 'PATCH') return ok({ ok: true });
  return notFound();
}
function reqAuth(opts) { return ((opts.headers || {}).Authorization || ''); }
fetch._real = global.fetch;
global.fetch = mockFetch;

/* ---------- 适配 Vercel 函数签名的本地路由 ---------- */
const authHandler = require('./api/auth.js');
const contentHandler = require('./api/content.js');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  req.query = Object.fromEntries(u.searchParams);
  // 补齐 Vercel 运行时注入的响应助手
  res.status = code => { res.statusCode = code; return res; };
  res.json = obj => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); return res; };

  if (u.pathname === '/api/auth') return authHandler(req, res);
  if (u.pathname === '/api/content') return contentHandler(req, res);

  // 静态文件
  let fp = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname).replace(/^\//, '');
  if (u.pathname === '/admin/' || u.pathname === '/admin') fp = 'admin/index.html';
  const full = path.join(ROOT, fp);
  if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404); return res.end('Not Found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
  res.end(fs.readFileSync(full));
});

server.listen(8979, () => console.log('local dev server on http://localhost:8979'));
