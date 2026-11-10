/**
 * /api/auth — 管理后台注册 / 登录 / 会话 / 退出
 * action 通过查询参数或 JSON body 传入：init | register | login | me | logout
 * 安全设计：仅允许注册一位管理员；密码 scrypt 加盐哈希；账户数据加密存于仓库；
 *          会话为 HMAC 签名 HttpOnly Cookie；登录失败按 IP 限流。
 */
'use strict';
const {
  requireEnv, readUsers, writeUsers, hashPassword, verifyPassword,
  signSession, currentSession, setSessionCookie, clearSessionCookie,
  rateLimited, recordFail, resetAttempts
} = require('./_shared.js');

const USERNAME_RE = /^[a-zA-Z0-9_-]{1,20}$/;

module.exports = async function handler(req, res) {
  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const action = (req.query && req.query.action) || body.action || '';
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

    /* init：探测是否已有管理员（决定前端显示登录还是注册） */
    if (action === 'init') {
      const env = requireEnv(res); if (!env) return;
      const users = await readUsers(env.token, env.secret);
      return res.status(200).json({ registered: users.length > 0 });
    }

    /* register：仅首次，创建唯一管理员 */
    if (action === 'register') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
      const env = requireEnv(res); if (!env) return;
      const users = await readUsers(env.token, env.secret);
      if (users.length > 0) return res.status(403).json({ error: '管理员已存在，无法重复注册。如需重置，请删除仓库中 admin-data/users.json 后重试。' });
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const err = validate(username, password);
      if (err) return res.status(400).json({ error: err });
      users.push({ u: username, p: hashPassword(password), t: Date.now() });
      await writeUsers(users, env.token, env.secret);
      setSessionCookie(res, signSession({ u: username }, env.secret, 7), 7);
      return res.status(200).json({ ok: true, username });
    }

    /* login */
    if (action === 'login') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
      const env = requireEnv(res); if (!env) return;
      if (rateLimited(ip)) return res.status(429).json({ error: '尝试次数过多，请 15 分钟后再试' });
      const users = await readUsers(env.token, env.secret);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const user = users.find(x => x.u === username);
      if (!user || !verifyPassword(password, user.p)) {
        recordFail(ip);
        // 统一错误信息，不暴露「用户是否存在」
        return res.status(401).json({ error: '用户名或密码错误' });
      }
      resetAttempts(ip);
      const days = body.remember ? 30 : 7;
      setSessionCookie(res, signSession({ u: user.u }, env.secret, days), days);
      return res.status(200).json({ ok: true, username: user.u });
    }

    /* me：恢复登录状态 */
    if (action === 'me') {
      const env = requireEnv(res); if (!env) return;
      const s = currentSession(req, env.secret);
      if (!s) return res.status(401).json({ error: '未登录' });
      return res.status(200).json({ ok: true, username: s.u });
    }

    /* logout */
    if (action === 'logout') {
      clearSessionCookie(res);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: '未知操作' });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || '服务器内部错误' });
  }
}

function validate(username, password) {
  if (!USERNAME_RE.test(username)) return '用户名需为 1-20 位英文、数字、下划线或连字符';
  if (password.length < 1) return '密码至少 1 位';
  if (password.length > 128) return '密码过长';
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 1e6) { reject(Object.assign(new Error('请求体过大'), { status: 413 })); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
