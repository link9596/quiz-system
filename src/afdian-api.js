// ============================================================================
// 爱发电开放平台 API 客户端
// ----------------------------------------------------------------------------
// 文档要点（https://afdian.com/dashboard/dev 获取 user_id / token）：
//   POST {API_BASE}/query-order
//   body: { user_id, params, ts, sign }
//   params 为 JSON 字符串，例如 {"page":1,"per_page":50}
//   sign = md5(token + "params" + params + "ts" + ts + "user_id" + user_id)
// 返回：{ ec: 200, em: 'order', data: { list, total_count, total_page } }
//
// 域名兼容：爱发电先后使用过 afdian.net / ifdian.net / afdian.com，
// 这里按顺序尝试，任何一个可用即可（可用 AFDIAN_API_BASE 变量强制指定）。
// ============================================================================

import { md5 } from './md5.js';

const DEFAULT_API_BASES = [
    'https://afdian.com/api/open',
    'https://afdian.net/api/open',
    'https://ifdian.net/api/open'
];

const DEFAULT_ORDER_HOSTS = [
    'https://ifdian.net',
    'https://afdian.com'
];

function trimSlash(s) {
    return String(s || '').trim().replace(/\/+$/, '');
}

export function getAfdianConfig(env) {
    const customBase = trimSlash(env && env.AFDIAN_API_BASE);
    const customHost = trimSlash(env && env.AFDIAN_ORDER_HOST);
    return {
        userId: String((env && env.AFDIAN_USER_ID) || '').trim(),
        token: String((env && env.AFDIAN_TOKEN) || '').trim(),
        apiBases: customBase ? [customBase] : DEFAULT_API_BASES.slice(),
        orderHost: customHost || DEFAULT_ORDER_HOSTS[0]
    };
}

export function isAfdianConfigured(env) {
    const cfg = getAfdianConfig(env);
    return !!(cfg.userId && cfg.token);
}

/** 构造带签名的请求体 */
export function buildSignedBody(cfg, params, ts) {
    const paramsStr = JSON.stringify(params || {});
    const stamp = ts || Math.floor(Date.now() / 1000);
    const sign = md5(cfg.token + 'params' + paramsStr + 'ts' + stamp + 'user_id' + cfg.userId);
    return { user_id: cfg.userId, params: paramsStr, ts: stamp, sign };
}

function afdianError(message, code) {
    const err = new Error(message);
    err.code = code || 'api_error';
    return err;
}

/**
 * 调用爱发电开放接口。
 * @throws {Error} e.code === 'not_configured' | 'api_error'
 */
export async function afdianRequest(env, path, params, options = {}) {
    const cfg = getAfdianConfig(env);
    if (!cfg.userId || !cfg.token) {
        throw afdianError('爱发电 API 未配置（缺少 AFDIAN_USER_ID / AFDIAN_TOKEN）', 'not_configured');
    }

    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 8000;
    let lastError = null;

    for (const base of cfg.apiBases) {
        const url = base + '/' + String(path).replace(/^\/+/, '');
        try {
            const body = buildSignedBody(cfg, params);
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            let res;
            try {
                res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                    signal: controller.signal
                });
            } finally {
                clearTimeout(timer);
            }

            if (!res.ok) {
                lastError = afdianError('爱发电接口 HTTP ' + res.status, 'api_error');
                continue;
            }

            const text = await res.text();
            let data;
            try {
                data = JSON.parse(text);
            } catch {
                lastError = afdianError('爱发电接口返回了非 JSON 内容', 'api_error');
                continue;
            }

            if (!data || typeof data.ec !== 'number') {
                lastError = afdianError('爱发电接口返回格式异常', 'api_error');
                continue;
            }

            if (data.ec !== 200) {
                // 业务错误：不再尝试其它域名，直接抛给调用方（例如签名错误）
                const err = afdianError(String(data.em || '爱发电接口返回错误'), 'api_error');
                err.ec = data.ec;
                throw err;
            }

            return data;
        } catch (e) {
            if (e && e.code === 'api_error' && e.ec !== undefined) throw e;
            lastError = afdianError((e && e.message) || '爱发电接口请求失败', 'api_error');
        }
    }

    throw lastError || afdianError('爱发电接口请求失败', 'api_error');
}

export function pingAfdian(env) {
    return afdianRequest(env, 'ping', { empty: true });
}

/** 拉取一页订单 */
export async function queryOrderPage(env, page = 1, perPage = 50) {
    const data = await afdianRequest(env, 'query-order', { page, per_page: perPage });
    const list = (data && data.data && Array.isArray(data.data.list)) ? data.data.list : [];
    const totalPage = data && data.data && Number(data.data.total_page) ? Number(data.data.total_page) : 1;
    return { list, totalPage, totalCount: (data && data.data && Number(data.data.total_count)) || list.length };
}

/**
 * 拉取最近若干页订单并汇总（新订单在前，因此前几页足够覆盖最近的购买）。
 */
export async function fetchRecentOrders(env, maxPages = 2, perPage = 50) {
    const out = [];
    const seen = new Set();
    let totalPage = 1;
    for (let page = 1; page <= maxPages; page++) {
        const { list, totalPage: tp } = await queryOrderPage(env, page, perPage);
        totalPage = tp;
        for (const item of list) {
            const no = String((item && item.out_trade_no) || '');
            if (!no || seen.has(no)) continue;
            seen.add(no);
            out.push(item);
        }
        if (list.length === 0 || page >= totalPage) break;
    }
    return out;
}

/**
 * 按爱发电订单号查找订单（用于用户手动绑定）。
 * 找不到返回 null；接口异常抛出。
 */
export async function findOrderByNo(env, orderNo, maxPages = 5) {
    const target = String(orderNo || '').trim();
    if (!target) return null;
    for (let page = 1; page <= maxPages; page++) {
        const { list, totalPage } = await queryOrderPage(env, page, 50);
        const hit = list.find(o => String((o && o.out_trade_no) || '').trim() === target);
        if (hit) return hit;
        if (list.length === 0 || page >= totalPage) break;
    }
    return null;
}

/**
 * 构造爱发电下单链接。
 * custom_order_id 由爱发电原样保存并会在「订单查询 / webhook」中回传，
 * 是订单与本站账号关联的可靠依据。
 */
export function buildOrderUrl(env, plan, customId, options = {}) {
    const cfg = getAfdianConfig(env);
    const host = options.host ? trimSlash(options.host) : cfg.orderHost;
    const month = Number(options.month) > 0 ? Number(options.month) : (plan && plan.months) || 1;
    const productType = Number.isFinite(Number(options.productType))
        ? Number(options.productType)
        : ((plan && plan.productType) || 0);

    const params = new URLSearchParams();
    params.set('plan_id', String((plan && plan.planId) || ''));
    params.set('product_type', String(productType));
    params.set('custom_order_id', customId);
    if (month > 0) params.set('month', String(month));
    params.set('remark', customId);
    params.set('affiliate_code', '');

    return host + '/order/create?' + params.toString();
}
