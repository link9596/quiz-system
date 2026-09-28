import { jsonResponse } from './utils.js';
import { md5 } from './md5.js';
import { requireAuth } from './auth.js';

// POST /api/subscription/create —— 生成待处理订单并返回爱发电下单链接
export async function handleCreateOrder(request, env) {
    if (request.method !== 'POST') return jsonResponse({ error: 'Method Not Allowed' }, 405);

    const session = await requireAuth(request, env);
    if (!session) return jsonResponse({ error: '未登录' }, 401);

    let body;
    try { body = await request.json(); } catch { body = {}; }
    const plan = body.plan === 'pro_year' ? 'pro_year' : 'pro_month';

    const customId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
        `INSERT INTO pending_orders (custom_id, user_id, plan, created_at)
         VALUES (?1, ?2, ?3, ?4)`
    ).bind(customId, session.userId, plan, now).run();

    const planId = plan === 'pro_year' ? env.AFDIAN_PLAN_YEAR : env.AFDIAN_PLAN_MONTH;
    const url = `https://afdian.net/order/create?plan_id=${encodeURIComponent(planId)}&remark=${encodeURIComponent(customId)}`;

    return jsonResponse({ customId, url });
}

// POST /api/afdian/webhook —— 爱发电回调
export async function handleAfdianWebhook(request, env) {
    if (request.method !== 'POST') return jsonResponse({ error: 'Method Not Allowed' }, 405);

    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: '格式错误' }, 400); }

    const { ec, em, data } = body || {};
    if (ec !== 200 || !data) return jsonResponse({ error: '无效的 webhook' }, 400);
    if (data.type !== 'order') return jsonResponse({ ec: 200, em: 'ignored' });

    const order = data.order;
    if (!order || !order.out_trade_no) return jsonResponse({ error: '订单信息缺失' }, 400);

    const orderNo = order.out_trade_no;

    // 幂等
    const existing = await env.DB.prepare(
        'SELECT id FROM subscriptions WHERE afdian_order = ?'
    ).bind(orderNo).first();
    if (existing) return jsonResponse({ ec: 200, em: 'ok' });

    // 通过 remark 关联用户
    const remark = String(order.remark || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
    if (!remark) return jsonResponse({ ec: 200, em: 'no remark' });

    const pending = await env.DB.prepare(
        'SELECT user_id, plan FROM pending_orders WHERE custom_id = ?'
    ).bind(remark).first();
    if (!pending) return jsonResponse({ ec: 200, em: 'order not linked' });

    // 只接受已支付状态
    if (order.status !== 2) return jsonResponse({ ec: 200, em: 'not paid' });

    const now = Math.floor(Date.now() / 1000);
    const plan = pending.plan;
    const duration = plan === 'pro_year' ? 365 * 86400 : 30 * 86400;

    // 续期：从现有活跃订阅的到期时间继续
    const existingSub = await env.DB.prepare(
        `SELECT expire_at FROM subscriptions
         WHERE user_id = ? AND status = 'active' AND expire_at > ?
         ORDER BY expire_at DESC LIMIT 1`
    ).bind(pending.user_id, now).first();

    const startAt = existingSub ? existingSub.expire_at : now;
    const expireAt = startAt + duration;

    await env.DB.prepare(
        `INSERT INTO subscriptions
           (id, user_id, plan, status, start_at, expire_at, afdian_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'active', ?4, ?5, ?6, ?7, ?7)`
    ).bind(crypto.randomUUID(), pending.user_id, plan, startAt, expireAt, orderNo, now).run();

    await env.DB.prepare('DELETE FROM pending_orders WHERE custom_id = ?').bind(remark).run();

    return jsonResponse({ ec: 200, em: 'ok' });
}

// 可选：主动查询爱发电订单（更严格的安全校验）
export async function queryAfdianOrder(env, orderNo) {
    const ts = Math.floor(Date.now() / 1000);
    const paramsObj = { out_trade_no: orderNo };
    const params = JSON.stringify(paramsObj);
    const userId = env.AFDIAN_USER_ID;
    const token = env.AFDIAN_TOKEN;
    // sign = md5(token + "params" + params + "ts" + ts + "user_id" + user_id)
    const sign = md5(`${token}params${params}ts${ts}user_id${userId}`);

    const res = await fetch('https://afdian.net/api/open/query-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, params, ts, sign })
    });
    return res.json();
}