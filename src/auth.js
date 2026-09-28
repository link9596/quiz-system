import { jsonResponse, parseCookies, generateId, sha256Hex, checkRateLimit } from './utils.js';
import { hashPassword, verifyPassword, generateSessionToken } from './crypto.js';
import { getSubscriptionSummary } from './subscription.js';

const SESSION_DURATION = 7 * 86400;

export async function handleAuth(request, env, path) {
    if (path === '/api/auth/register' && request.method === 'POST') return handleRegister(request, env);
    if (path === '/api/auth/login'    && request.method === 'POST') return handleLogin(request, env);
    if (path === '/api/auth/logout'   && request.method === 'POST') return handleLogout(request, env);
    if (path === '/api/auth/me'       && request.method === 'GET')  return handleMe(request, env);
    return jsonResponse({ error: 'Not Found' }, 404);
}

async function handleRegister(request, env) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!(await checkRateLimit(env.REGISTER_RATE_LIMITER, ip))) {
        return jsonResponse({ error: '请求过于频繁，请稍后再试' }, 429);
    }

    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: '请求体格式错误' }, 400); }

    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const nickname = String(body.nickname || '').trim().slice(0, 30);

    if (!isValidEmail(email)) return jsonResponse({ error: '邮箱格式不正确' }, 400);
    const pwErr = validatePassword(password);
    if (pwErr) return jsonResponse({ error: pwErr }, 400);

    const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    if (existing) return jsonResponse({ error: '该邮箱已被注册' }, 409);

    const passwordHash = await hashPassword(password, env.PASSWORD_PEPPER);
    const userId = generateId();
    const now = Math.floor(Date.now() / 1000);

    try {
        await env.DB.prepare(
            `INSERT INTO users (id, email, password_hash, nickname, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)`
        ).bind(userId, email, passwordHash, nickname || null, now).run();
    } catch (e) {
        if (String(e).includes('UNIQUE')) return jsonResponse({ error: '该邮箱已被注册' }, 409);
        throw e;
    }

    const session = await createSession(env, userId, now);

    const sub = await getSubscriptionSummary(env, userId, now);

    return jsonResponse(
        { id: userId, email, nickname: nickname || null, subscription: sub },
        200,
        { 'Set-Cookie': buildSessionCookie(session.token, session.expiresAt, env) }
    );
}

async function handleLogin(request, env) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!(await checkRateLimit(env.LOGIN_RATE_LIMITER, ip))) {
        return jsonResponse({ error: '请求过于频繁，请稍后再试' }, 429);
    }

    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: '请求体格式错误' }, 400); }

    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const now = Math.floor(Date.now() / 1000);

    if (!email || !password) return jsonResponse({ error: '请填写邮箱和密码' }, 400);

    // 账号 + 登录风控一次查出来（原 login_attempts 已并进 users）
    const user = await env.DB.prepare(
        'SELECT id, email, password_hash, nickname, fail_count, locked_until FROM users WHERE email = ?'
    ).bind(email).first();

    if (!user) {
        // 不存在的邮箱：同样跑一次哈希，避免通过响应耗时探测账号是否存在
        await hashPassword(password, env.PASSWORD_PEPPER);
        return jsonResponse({ error: '邮箱或密码错误' }, 401);
    }

    if (user.locked_until && user.locked_until > now) {
        return jsonResponse({ error: '账户已锁定，请稍后再试' }, 423);
    }

    const ok = await verifyPassword(password, user.password_hash, env.PASSWORD_PEPPER);
    if (!ok) {
        const newCount = (user.fail_count || 0) + 1;
        const lockUntil = newCount >= 10 ? now + 900 : null;
        await env.DB.prepare(
            'UPDATE users SET fail_count = ?1, locked_until = ?2, updated_at = ?3 WHERE id = ?4'
        ).bind(newCount, lockUntil, now, user.id).run();
        return jsonResponse({ error: '邮箱或密码错误' }, 401);
    }

    // 登录成功：只有之前失败过才需要写一次（避免每次登录都产生一次写）
    if (user.fail_count || user.locked_until) {
        await env.DB.prepare(
            'UPDATE users SET fail_count = 0, locked_until = NULL, updated_at = ?1 WHERE id = ?2'
        ).bind(now, user.id).run();
    }

    const sub = await getSubscriptionSummary(env, user.id, now);
    const session = await createSession(env, user.id, now);

    return jsonResponse(
        { id: user.id, email: user.email, nickname: user.nickname, subscription: sub },
        200,
        { 'Set-Cookie': buildSessionCookie(session.token, session.expiresAt, env) }
    );
}

async function handleLogout(request, env) {
    const cookies = parseCookies(request);
    const token = cookies['__Host-session'];
    if (token) {
        const tokenHash = await sha256Hex(token);
        await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    }
    return jsonResponse({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie(env) });
}

async function handleMe(request, env) {
    const session = await requireAuth(request, env);
    if (!session) return jsonResponse({ error: '未登录' }, 401);
    const sub = await getSubscriptionSummary(env, session.userId, Math.floor(Date.now() / 1000));
    return jsonResponse({
        id: session.userId, email: session.email, nickname: session.nickname, subscription: sub
    });
}

async function createSession(env, userId, now) {
    const token = await generateSessionToken();
    const tokenHash = await sha256Hex(token);
    const expiresAt = now + SESSION_DURATION;
    await env.DB.prepare(
        `INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
         VALUES (?1, ?2, ?3, ?4)`
    ).bind(tokenHash, userId, expiresAt, now).run();
    return { token, expiresAt };
}

/**
 * 判断用户是否拥有某个科目的有效权益（供题库鉴权复用）。
 * 订阅状态的完整计算见 src/subscription.js 的 getSubscriptionState。
 */
export async function hasSubjectAccess(env, userId, subject, now = Math.floor(Date.now() / 1000)) {
    const row = await env.DB.prepare(
        `SELECT MAX(expire_at) AS expire_at FROM subscriptions
          WHERE user_id = ? AND subject = ? AND status = 'active' AND expire_at > ?`
    ).bind(userId, subject, now).first();
    return !!(row && row.expire_at);
}

function isCrossOrigin(env) {
    return (env.ALLOWED_ORIGINS || '').split(',').filter(s => s.trim()).length > 0;
}

function buildSessionCookie(token, expiresAt, env) {
    const maxAge = Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
    const ss = isCrossOrigin(env) ? 'None' : 'Strict';
    return `__Host-session=${token}; HttpOnly; Secure; SameSite=${ss}; Path=/; Max-Age=${maxAge}`;
}
function clearSessionCookie(env) {
    const ss = isCrossOrigin(env) ? 'None' : 'Strict';
    return `__Host-session=; HttpOnly; Secure; SameSite=${ss}; Path=/; Max-Age=0`;
}

export async function requireAuth(request, env) {
    const cookies = parseCookies(request);
    const token = cookies['__Host-session'];
    if (!token) return null;
    const tokenHash = await sha256Hex(token);
    const now = Math.floor(Date.now() / 1000);
    const row = await env.DB.prepare(
        `SELECT s.user_id, u.email, u.nickname
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`
    ).bind(tokenHash, now).first();
    if (!row) return null;
    return { userId: row.user_id, email: row.email, nickname: row.nickname };
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}
function validatePassword(pw) {
    if (pw.length < 8) return '密码至少 8 位';
    if (pw.length > 128) return '密码过长';
    if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/[0-9]/.test(pw)) return '密码需包含大小写字母和数字';
    return null;
}