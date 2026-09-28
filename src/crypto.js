const PBKDF2_ITERATIONS = 100000;
const PBKDF2_KEY_LENGTH = 256;

// WebCrypto 不允许长度为 0 的 HMAC 密钥（会抛 DataError），
// 因此 PASSWORD_PEPPER 未配置时退回一个固定的非空胡椒，
// 保证「注册 / 登录」在没写 secret 的情况下也能正常工作。
// 一旦配置了真实 secret，请不要再改动，否则历史密码哈希会全部失效。
const DEFAULT_PEPPER = 'quiz-app::fallback-pepper::please-set-PASSWORD_PEPPER';

function normalizePepper(pepper) {
    const p = pepper == null ? '' : String(pepper);
    return p.length > 0 ? p : DEFAULT_PEPPER;
}

function bytesToBase64(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
}
function base64ToBytes(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

async function pepperedKey(password, pepper) {
    const pepperKey = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(normalizePepper(pepper)),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', pepperKey, new TextEncoder().encode(password));
    return new Uint8Array(sig);
}

export async function hashPassword(password, pepper) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const keyMaterial = await crypto.subtle.importKey(
        'raw', await pepperedKey(password, pepper),
        'PBKDF2', false, ['deriveBits']
    );
    const hash = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
        keyMaterial, PBKDF2_KEY_LENGTH
    );
    return `$pbkdf2-sha256$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(new Uint8Array(hash))}`;
}

export async function verifyPassword(password, stored, pepper) {
    const parts = stored.split('$');
    if (parts.length !== 5 || parts[1] !== 'pbkdf2-sha256') return false;
    const iterations = parseInt(parts[2]);
    const salt = base64ToBytes(parts[3]);
    const expected = base64ToBytes(parts[4]);

    const keyMaterial = await crypto.subtle.importKey(
        'raw', await pepperedKey(password, pepper),
        'PBKDF2', false, ['deriveBits']
    );
    const hash = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
        keyMaterial, PBKDF2_KEY_LENGTH
    );
    const actual = new Uint8Array(hash);
    if (actual.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
    return diff === 0;
}

export async function generateSessionToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}