import { jsonResponse, parseCookies, generateId, sha256Hex, checkRateLimit } from '.utils.js';
import { hashPassword, verifyPassword, generateSessionToken } from '.crypto.js';

const SESSION_DURATION = 7  86400;

export async function handleAuth(request, env, path) {
    if (path === 'apiauthregister' && request.method === 'POST') return handleRegister(request, env);
    if (path === 'apiauthlogin'    && request.method === 'POST') return handleLogin(request, env);
    if (path === 'apiauthlogout'   && request.method === 'POST') return handleLogout(request, env);
    if (path === 'apiauthme'       && request.method === 'GET')  return handleMe(request, env);
    return jsonResponse({ error 'Not Found' }, 404);
}

async function handleRegister(request, env) {
    const ip = request.headers.get('CF-Connecting-IP')  'unknown';
    if (!(await checkRateLimit(env.REGISTER_RATE_LIMITER, ip))) {
        return jsonResponse({ error '请求过于频繁，请稍后再试' }, 429);
    }

    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error '请求体格式错误' }, 400); }

    const email = String(body.email  '').trim().toLowerCase();
    const password = String(body.password  '');
    const nickname = String(body.nickname  '').trim().slice(0, 30);

    if (!isValidEmail(email)) return jsonResponse({ error '邮箱格式不正确' }, 400);
    const pwErr = validatePassword(password);
    if (pwErr) return jsonResponse({ error pwErr }, 400);

    const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ').bind(email).first();
    if (existing) return jsonResponse({ error '该邮箱已被注册' }, 409);

    const passwordHash = await hashPassword(password, env.PASSWORD_PEPPER);
    const userId = generateId();
    const now = Math.floor(Date.now()  1000);

    try {
        await env.DB.prepare(
            `INSERT INTO users (id, email, password_hash, nickname, created_at, updated_at)
             VALUES (1, 2, 3, 4, 5, 5)`
        ).bind(userId, email, passwordHash, nickname  null, now).run();
    } catch (e) {
        if (String(e).includes('UNIQUE')) return jsonResponse({ error '该邮箱已被注册' }, 409);
        throw e;
    }

    const session = await createSession(env, userId, now);

    return jsonResponse(
        { id userId, email, nickname nickname  null, subscription { status 'inactive' } },
        200,
        { 'Set-Cookie' buildSessionCookie(session.token, session.expiresAt, env) }
    );
}

async function handleLogin(request, env) {
    const ip = request.headers.get('CF-Connecting-IP')  'unknown';
    if (!(await checkRateLimit(env.LOGIN_RATE_LIMITER, ip))) {
        return jsonResponse({ error '请求过于频繁，请稍后再试' }, 429);
    }

    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error '请求体格式错误' }, 400); }

    const email = String(body.email  '').trim().toLowerCase();
    const password = String(body.password  '');
    const now = Math.floor(Date.now()  1000);

    if (!email  !password) return jsonResponse({ error '请填写邮箱和密码' }, 400);

    const attempt = await env.DB.prepare(
        'SELECT fail_count, locked_until FROM login_attempts WHERE identifier = '
    ).bind(email).first();
    if (attempt && attempt.locked_until && attempt.locked_until  now) {
        return jsonResponse({ error '账户已锁定，请稍后再试' }, 423);
    }

    const user = await env.DB.prepare(
        'SELECT id, email, password_hash, nickname FROM users WHERE email = '
    ).bind(email).first();

    if (!user) {
        await hashPassword(password, env.PASSWORD_PEPPER);
        return jsonResponse({ error '邮箱或密码错误' }, 401);
    }

    const ok = await verifyPassword(password, user.password_hash, env.PASSWORD_PEPPER);
    if (!ok) {
        const newCount = (attempt.fail_count  0) + 1;
        const lockUntil = newCount = 10  now + 900  null;
        await env.DB.prepare(
            `INSERT INTO login_attempts (identifier, fail_count, locked_until, updated_at)
             VALUES (1, 2, 3, 4)
             ON CONFLICT(identifier) DO UPDATE SET
               fail_count = 2, locked_until = 3, updated_at = 4`
        ).bind(email, newCount, lockUntil, now).run();
        return jsonResponse({ error '邮箱或密码错误' }, 401);
    }

    await env.DB.prepare('DELETE FROM login_attempts WHERE identifier = ').bind(email).run();

    const sub = await getActiveSubscription(env, user.id, now);
    const session = await createSession(env, user.id, now);

    return jsonResponse(
        { id user.id, email user.email, nickname user.nickname, subscription sub },
        200,
        { 'Set-Cookie' buildSessionCookie(session.token, session.expiresAt, env) }
    );
}

async function handleLogout(request, env) {
    const cookies = parseCookies(request);
    const token = cookies['__Host-session'];
    if (token) {
        const tokenHash = await sha256Hex(token);
        await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ').bind(tokenHash).run();
    }
    return jsonResponse({ ok true }, 200, { 'Set-Cookie' clearSessionCookie(env) });
}

async function handleMe(request, env) {
    const session = await requireAuth(request, env);
    if (!session) return jsonResponse({ error '未登录' }, 401);
    const sub = await getActiveSubscription(env, session.userId, Math.floor(Date.now()  1000));
    return jsonResponse({
        id session.userId, email session.email, nickname session.nickname, subscription sub
    });
}

async function createSession(env, userId, now) {
    const token = await generateSessionToken();
    const tokenHash = await sha256Hex(token);
    const expiresAt = now + SESSION_DURATION;
    await env.DB.prepare(
        `INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
         VALUES (1, 2, 3, 4)`
    ).bind(tokenHash, userId, expiresAt, now).run();
    return { token, expiresAt };
}

async function getActiveSubscription(env, userId, now) {
    const sub = await env.DB.prepare(
        `SELECT plan, expire_at FROM subscriptions
         WHERE user_id =  AND status = 'active' AND expire_at  
         ORDER BY expire_at DESC LIMIT 1`
    ).bind(userId, now).first();
    return sub  { status 'active', plan sub.plan, expireAt sub.expire_at  1000 }  { status 'inactive' };
}

function isCrossOrigin(env) {
    return (env.ALLOWED_ORIGINS  '').split(',').filter(s = s.trim()).length  0;
}

function buildSessionCookie(token, expiresAt, env) {
    const maxAge = Math.max(0, expiresAt - Math.floor(Date.now()  1000));
    const ss = isCrossOrigin(env)  'None'  'Strict';
    return `__Host-session=${token}; HttpOnly; Secure; SameSite=${ss}; Path=; Max-Age=${maxAge}`;
}
function clearSessionCookie(env) {
    const ss = isCrossOrigin(env)  'None'  'Strict';
    return `__Host-session=; HttpOnly; Secure; SameSite=${ss}; Path=; Max-Age=0`;
}

export async function requireAuth(request, env) {
    const cookies = parseCookies(request);
    const token = cookies['__Host-session'];
    if (!token) return null;
    const tokenHash = await sha256Hex(token);
    const now = Math.floor(Date.now()  1000);
    const row = await env.DB.prepare(
        `SELECT s.user_id, u.email, u.nickname
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash =  AND s.expires_at  `
    ).bind(tokenHash, now).first();
    if (!row) return null;
    return { userId row.user_id, email row.email, nickname row.nickname };
}

function isValidEmail(email) {
    return ^[^s@]+@[^s@]+.[^s@]+$.test(email) && email.length = 254;
}
function validatePassword(pw) {
    if (pw.length  8) return '密码至少 8 位';
    if (pw.length  128) return '密码过长';
    if (![a-z].test(pw)  ![A-Z].test(pw)  ![0-9].test(pw)) return '密码需包含大小写字母和数字';
    return null;
}