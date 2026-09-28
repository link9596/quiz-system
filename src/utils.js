export function jsonResponse(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders }
    });
}

export function withSecurityHeaders(response, request, env) {
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('X-Frame-Options', 'DENY');
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');

    const origin = request.headers.get('Origin');
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (origin && allowed.includes(origin)) {
        headers.set('Access-Control-Allow-Origin', origin);
        headers.set('Access-Control-Allow-Credentials', 'true');
        headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        headers.set('Access-Control-Allow-Headers', 'Content-Type');
        headers.set('Vary', 'Origin');
    }

    return new Response(response.body, { status: response.status, headers });
}

export function handleCors(request, env) {
    const origin = request.headers.get('Origin');
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const headers = new Headers();
    if (origin && allowed.includes(origin)) {
        headers.set('Access-Control-Allow-Origin', origin);
        headers.set('Access-Control-Allow-Credentials', 'true');
        headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        headers.set('Access-Control-Allow-Headers', 'Content-Type');
        headers.set('Access-Control-Max-Age', '86400');
    }
    return new Response(null, { status: 204, headers });
}

export function parseCookies(request) {
    const raw = request.headers.get('Cookie') || '';
    const out = {};
    for (const part of raw.split(';')) {
        const idx = part.indexOf('=');
        if (idx > 0) {
            const k = part.slice(0, idx).trim();
            const v = part.slice(idx + 1).trim();
            try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
        }
    }
    return out;
}

export function generateId() { return crypto.randomUUID(); }

export async function sha256Hex(input) {
    const data = new TextEncoder().encode(input);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function checkRateLimit(limiter, key) {
    if (!limiter || typeof limiter.limit !== 'function') return true;
    try {
        const { success } = await limiter.limit({ key });
        return !!success;
    } catch { return true; }
}