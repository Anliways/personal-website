/**
 * /api/content — 管理后台的内容读写代理（需登录会话）
 * GET  /api/content?path=projects.json        → { content: <文本> }
 * POST /api/content { files, message }        → 原子化多文件提交，{ sha }
 * GitHub 令牌仅存在于服务端环境变量，前端全程不接触。
 */
'use strict';
const { requireEnv, readRepoFile, commitFiles, currentSession } = require('./_shared.js');

const SAFE_PATH = /^[\w][\w.\-/]*$/;
const DENY_PREFIX = ['admin-data/', 'api/', '.git', '.github/workflows'];

function pathBlocked(p) {
  if (p.includes('..')) return true;
  return DENY_PREFIX.some(pre => p === pre.replace(/\/$/, '') || p.startsWith(pre));
}

module.exports = async function handler(req, res) {
  try {
    const env = requireEnv(res); if (!env) return;
    const session = currentSession(req, env.secret);
    if (!session) return res.status(401).json({ error: '未登录或会话已过期' });

    /* 读 */
    if (req.method === 'GET') {
      const path = String(req.query.path || '');
      if (!SAFE_PATH.test(path) || pathBlocked(path)) return res.status(400).json({ error: '非法路径' });
      const f = await readRepoFile(path, env.token);
      if (f.text === null) return res.status(404).json({ error: '文件不存在：' + path });
      return res.status(200).json({ content: f.text, sha: f.sha });
    }

    /* 写（原子化多文件提交） */
    if (req.method === 'POST') {
      const body = await readBody(req);
      const files = Array.isArray(body.files) ? body.files : null;
      const message = String(body.message || '').slice(0, 200);
      if (!files || !files.length || !message) return res.status(400).json({ error: '缺少 files 或 message' });
      for (const f of files) {
        if (!f || typeof f.path !== 'string' || !SAFE_PATH.test(f.path) || pathBlocked(f.path)) {
          return res.status(400).json({ error: '非法路径：' + (f && f.path) });
        }
        if (f.content !== null && typeof f.content !== 'string') {
          return res.status(400).json({ error: '文件内容必须是字符串（删除请传 null）：' + f.path });
        }
        if (f.encoding !== undefined && f.encoding !== 'utf-8' && f.encoding !== 'base64') {
          return res.status(400).json({ error: 'encoding 仅支持 utf-8 或 base64：' + f.path });
        }
      }
      const sha = await commitFiles(
        files.map(f => ({ path: f.path, content: f.content, encoding: f.encoding })),
        message, env.token);
      return res.status(200).json({ ok: true, sha });
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || '服务器内部错误' });
  }
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 5e6) { reject(Object.assign(new Error('请求体过大'), { status: 413 })); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
