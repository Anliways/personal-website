/**
 * 共享工具库（下划线开头，不会被 Vercel 暴露为接口）。
 * 服务端专用：GitHub API 代理、账户存储（加密落盘仓库）、签名会话 Cookie。
 */
'use strict';
const crypto = require('node:crypto');

const REPO = 'Anliways/personal-website';
const BRANCH = 'main';
const USERS_PATH = 'admin-data/users.json';

/* ---------- 基础 ---------- */
function requireEnv(res) {
  const token = process.env.GITHUB_TOKEN;
  const secret = process.env.SESSION_SECRET;
  const missing = [];
  if (!token) missing.push('GITHUB_TOKEN');
  if (!secret) missing.push('SESSION_SECRET');
  if (missing.length) {
    res.status(503).json({ error: '服务端尚未配置环境变量：' + missing.join('、') + '。请在 Vercel 项目 Settings → Environment Variables 中添加后重新部署。' });
    return null;
  }
  return { token, secret };
}

async function gh(path, opts = {}, token) {
  const res = await fetch('https://api.github.com' + path, {
    ...opts,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'anliways-admin',
      ...(opts.headers || {})
    }
  });
  if (res.status === 401) throw Object.assign(new Error('GITHUB_TOKEN 无效或已过期'), { status: 502 });
  if (res.status === 403) throw Object.assign(new Error('GITHUB_TOKEN 权限不足或触发限流'), { status: 502 });
  if (res.status === 404) throw Object.assign(new Error('NOT_FOUND'), { status: 404, notFound: true });
  if (!res.ok) throw Object.assign(new Error('GitHub API ' + res.status), { status: 502 });
  return res.json();
}

/* 读取仓库文件，返回 { sha, text }；文件不存在返回 { sha: null, text: null } */
async function readRepoFile(path, token) {
  try {
    const j = await gh(`/repos/${REPO}/contents/${encodePath(path)}?ref=${BRANCH}`, {}, token);
    return { sha: j.sha, text: Buffer.from(j.content, 'base64').toString('utf8') };
  } catch (e) {
    if (e.notFound) return { sha: null, text: null };
    throw e;
  }
}

/* 原子化多文件提交：blob → tree → commit → 更新分支 */
async function commitFiles(files, message, token) {
  const ref = await gh(`/repos/${REPO}/git/ref/heads/${BRANCH}`, {}, token);
  const baseSha = ref.object.sha;
  const baseCommit = await gh(`/repos/${REPO}/git/commits/${baseSha}`, {}, token);
  const tree = [];
  for (const f of files) {
    if (f.content === null) { tree.push({ path: f.path, mode: '100644', type: 'blob', sha: null }); continue; }
    // encoding 可选 utf-8（默认，文本）或 base64（图片等二进制资源）
    const blob = await gh(`/repos/${REPO}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: f.content, encoding: f.encoding || 'utf-8' }) }, token);
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const newTree = await gh(`/repos/${REPO}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree }) }, token);
  const commit = await gh(`/repos/${REPO}/git/commits`, { method: 'POST', body: JSON.stringify({ message, tree: newTree.sha, parents: [baseSha] }) }, token);
  await gh(`/repos/${REPO}/git/refs/heads/${BRANCH}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) }, token);
  return commit.sha;
}

function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

/* ---------- 账户存储：AES-256-GCM 加密后写入仓库 ---------- */
function deriveKey(secret) {
  return crypto.createHash('sha256').update('anliways-admin:' + secret).digest();
}
function encryptJSON(obj, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }, null, 2) + '\n';
}
function decryptJSON(text, secret) {
  const box = JSON.parse(text);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret), Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  const out = Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]);
  return JSON.parse(out.toString('utf8'));
}
async function readUsers(token, secret) {
  const f = await readRepoFile(USERS_PATH, token);
  if (f.text === null) return [];
  try { return decryptJSON(f.text, secret); }
  catch { throw Object.assign(new Error('账户数据解密失败（SESSION_SECRET 是否被更换过？）'), { status: 500 }); }
}
async function writeUsers(users, token, secret) {
  return commitFiles([{ path: USERS_PATH, content: encryptJSON(users, secret) }], 'chore(admin): 更新管理员账户数据', token);
}

/* ---------- 密码哈希（scrypt + 随机盐） ---------- */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  const ref = Buffer.from(hash, 'hex');
  return test.length === ref.length && crypto.timingSafeEqual(test, ref);
}

/* ---------- 签名会话（HMAC-SHA256，无外部依赖） ---------- */
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function signSession(payload, secret, days) {
  const body = b64url(JSON.stringify({ ...payload, exp: Date.now() + days * 86400e3 }));
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifySession(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig); const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function setSessionCookie(res, value, days) {
  res.setHeader('Set-Cookie',
    `adb_session=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${days * 86400}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'adb_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
}
function currentSession(req, secret) {
  return verifySession(parseCookies(req).adb_session, secret);
}

/* ---------- 简易登录限流（按 IP，内存级，尽力而为） ---------- */
const attempts = new Map();
function rateLimited(ip) {
  const now = Date.now(); const win = 15 * 60e3;
  const arr = (attempts.get(ip) || []).filter(t => now - t < win);
  attempts.set(ip, arr);
  return arr.length >= 10;
}
function recordFail(ip) {
  const arr = attempts.get(ip) || [];
  arr.push(Date.now());
  attempts.set(ip, arr);
}
function resetAttempts(ip) { attempts.delete(ip); }

module.exports = {
  REPO, BRANCH, USERS_PATH,
  requireEnv, gh, readRepoFile, commitFiles, encodePath,
  readUsers, writeUsers, hashPassword, verifyPassword,
  signSession, verifySession, parseCookies, setSessionCookie, clearSessionCookie, currentSession,
  rateLimited, recordFail, resetAttempts
};
