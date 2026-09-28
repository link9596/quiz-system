// ============================================================================
// 订阅引擎
// ----------------------------------------------------------------------------
// 开通方式：**只使用爱发电开放平台 API 主动查询订单**（不使用 webhook）。
//   1. 用户下单时后端生成 custom_order_id，写进爱发电下单链接；
//   2. 用户付款后，前端轮询 / 打开 App 时后端调用 query-order 核对订单；
//   3. 定时任务每 15 分钟全量核对一次，保证“付款后自动开通”不依赖用户在线。
//
// 数据模型：subscriptions 一行 = 一个科目的一条权益（k1 / k2），
// 同一笔订单的多行通过 group_id 关联，便于“科目一+科目二”整单激活与展示。
// 叠加规则：同一科目再次购买时，从该科目当前到期时间继续往后叠加。
// ============================================================================

import {
    getPlans,
    planByKey,
    planByAfdianId,
    subjectsLabel,
    planKeyFromSubjects,
    planNameFromSubjects,
    normalizeMonths,
    addMonths,
    newCustomId,
    sanitizeCustomId
} from './plans.js';
import {
    isAfdianConfigured,
    fetchRecentOrders,
    findOrderByNo,
    getAfdianConfig,
    buildOrderUrl
} from './afdian-api.js';

export const ORDER_STATUS_PAID = 2;

/** 一张待支付订单在多久之内允许被反复核对 */
const PENDING_TTL = 14 * 86400;
/** 同一用户两次主动查询之间的最小间隔（秒），避免刷接口 */
const CHECK_INTERVAL = 20;
/** 定时任务核对最近多少页订单 */
const SWEEP_PAGES = 2;
const PAGE_SIZE = 50;

function nowSec() {
    return Math.floor(Date.now() / 1000);
}

function toSec(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
}

/** 兜底匹配默认关闭，只有显式配置 AFDIAN_FALLBACK_MATCH=1 才启用 */
function fallbackEnabled(env) {
    return String((env && env.AFDIAN_FALLBACK_MATCH) || '') === '1';
}

async function logEvent(env, userId, kind, detail) {
    try {
        await env.DB.prepare(
            'INSERT INTO sub_events (user_id, kind, detail, created_at) VALUES (?1, ?2, ?3, ?4)'
        ).bind(userId || null, kind, detail ? String(detail).slice(0, 500) : null, nowSec()).run();
    } catch (e) {
        console.error('sub_events log failed:', e && e.message);
    }
}

// ---------------------------------------------------------------------------
// 订单 -> 待处理订单 匹配
// ---------------------------------------------------------------------------

function orderCustomId(order) {
    return sanitizeCustomId(order && (order.custom_order_id || order.customOrderId));
}

function orderNoOf(order) {
    return String((order && (order.out_trade_no || order.outTradeNo)) || '').trim();
}

function orderPaidTime(order) {
    const candidates = [order && order.pay_time, order && order.create_time, order && order.ts];
    for (const c of candidates) {
        const s = toSec(c);
        if (s) return s;
    }
    return 0;
}

/** 可以被爱发电订单关联的待处理订单状态：pending = 列表里还在，canceled = 用户已从列表删除 */
const LINKABLE_STATUSES = ['pending', 'canceled'];

/** 用户删掉的订单仍会核对一段时间，避免「删除后才付款」被漏掉 */
const CANCELED_TTL = 3 * 86400;

function isPaid(order) {
    return Number(order && order.status) === ORDER_STATUS_PAID;
}

/**
 * 按关联码查待处理订单。
 * statuses 默认只认 pending；核对订单时会额外带上 canceled，
 * 这样即使用户在付款前把订单从列表里删掉了，事后付款仍能自动开通。
 */
async function loadPendingByCustomId(env, customId, statuses = ['pending']) {
    if (!customId) return null;
    const list = statuses.length ? statuses : ['pending'];
    const placeholders = list.map((_, i) => '?' + (i + 2)).join(', ');
    return env.DB.prepare(
        `SELECT * FROM pending_orders WHERE custom_id = ?1 AND status IN (${placeholders})`
    ).bind(customId, ...list).first();
}

/**
 * 为一笔已支付的爱发电订单找到对应的待处理订单。
 *   1) 优先用 custom_order_id 精确匹配（下单链接里带上的关联码）；
 *   2) 兜底：remark 匹配；
 *   3) 兜底（需显式开启）：同一 plan_id 且时间窗内、尚未被占用的待处理订单。
 */
async function resolvePendingOrder(env, order) {
    const customId = orderCustomId(order);
    let row = await loadPendingByCustomId(env, customId, LINKABLE_STATUSES);
    if (row) return { pending: row, via: 'custom_order_id' };

    const remark = sanitizeCustomId(order && order.remark);
    if (remark && remark !== customId) {
        row = await loadPendingByCustomId(env, remark, LINKABLE_STATUSES);
        if (row) return { pending: row, via: 'remark' };
    }

    if (!fallbackEnabled(env)) return { pending: null, via: null };

    const plan = planByAfdianId(env, order && order.plan_id);
    if (!plan) return { pending: null, via: null };

    const paidAt = orderPaidTime(order) || nowSec();
    row = await env.DB.prepare(
        `SELECT * FROM pending_orders
          WHERE status = 'pending' AND plan_key = ? AND created_at <= ? AND created_at >= ?
          ORDER BY created_at ASC LIMIT 1`
    ).bind(plan.key, paidAt + 600, paidAt - PENDING_TTL).first();

    return row ? { pending: row, via: 'plan_fallback' } : { pending: null, via: null };
}

// ---------------------------------------------------------------------------
// 激活 / 过期
// ---------------------------------------------------------------------------

/**
 * 激活某一笔购买（group）下所有待激活的权益行。
 * 每一行按其所含科目单独计算：从「当前时间 / 该科目已有到期时间」的较晚者起算。
 */
export async function activateGroup(env, userId, groupId, now = nowSec()) {
    const rows = (await env.DB.prepare(
        "SELECT * FROM subscriptions WHERE user_id = ? AND group_id = ? AND status = 'pending' ORDER BY subject"
    ).bind(userId, groupId).all()).results || [];

    const activated = [];
    for (const row of rows) {
        const current = await env.DB.prepare(
            `SELECT MAX(expire_at) AS m FROM subscriptions
              WHERE user_id = ? AND subject = ? AND status = 'active' AND expire_at > ?`
        ).bind(userId, row.subject, now).first();

        // 起算点 = max(当前时间, 该科目已有到期时间)，保证不吞掉用户已付费的时长
        const start = Math.max(now, Number(current && current.m) || 0);
        const expire = addMonths(start, row.months || 1);

        const res = await env.DB.prepare(
            `UPDATE subscriptions
                SET status = 'active', start_at = ?1, expire_at = ?2, activated_at = ?3, updated_at = ?3
              WHERE id = ?4 AND status = 'pending'`
        ).bind(start, expire, now, row.id).run();

        if (res && res.meta && res.meta.changes === 0) continue;
        activated.push({ id: row.id, subject: row.subject, startAt: start, expireAt: expire });
    }

    if (activated.length) {
        await logEvent(env, userId, 'activate', JSON.stringify({ groupId, activated }));
    }
    return activated;
}

/** 把已过期的权益行标记为 expired */

/** 把已过期的权益行标记为 expired */
export async function expireRecords(env, userId, now = nowSec()) {
    const where = userId ? 'AND user_id = ?2' : '';
    const stmt = env.DB.prepare(
        `UPDATE subscriptions SET status = 'expired', updated_at = ?1
          WHERE status = 'active' AND expire_at <= ?1 ${where}`
    );
    const res = userId ? await stmt.bind(now, userId).run() : await stmt.bind(now).run();
    return (res && res.meta && res.meta.changes) || 0;
}

// ---------------------------------------------------------------------------
// 权益授予
// ---------------------------------------------------------------------------

/**
 * 将一笔已支付的爱发电订单落库，并（视激活方式）立即开通。
 * 幂等：同一 out_trade_no 只会授予一次。
 *
 * @param {object} order  爱发电 query-order 返回的订单对象
 * @param {string} source 授予来源，用于审计
 * @param {{pendingCustomId?: string}} [options] 指定关联到哪一张待支付订单
 */
export async function applyPaidOrder(env, order, source = 'afdian_api', options = {}) {
    const now = nowSec();
    const orderNo = orderNoOf(order);
    if (!orderNo) return { ok: false, code: 'bad_order' };
    if (!isPaid(order)) return { ok: false, code: 'not_paid' };

    const dup = await env.DB.prepare(
        'SELECT id, user_id FROM subscriptions WHERE afdian_order = ? LIMIT 1'
    ).bind(orderNo).first();
    if (dup) return { ok: true, code: 'already', groupId: dup.id, userId: dup.user_id };

    let pending = null;
    let via = null;
    if (options.pendingCustomId) {
        pending = await loadPendingByCustomId(env, options.pendingCustomId, LINKABLE_STATUSES);
        via = 'assigned';
    }
    if (!pending) {
        const resolved = await resolvePendingOrder(env, order);
        pending = resolved.pending;
        via = resolved.via;
    }

    if (!pending) {
        await logEvent(env, null, 'unlinked_order', JSON.stringify({
            orderNo,
            customId: orderCustomId(order),
            planId: order && order.plan_id
        }));
        return { ok: false, code: 'unlinked' };
    }

    // 方案以订单里的 plan_id 为准；识别不了时退回用户下单时选择的套餐
    const plan = planByAfdianId(env, order && order.plan_id) || planByKey(env, pending.plan_key);
    if (!plan) return { ok: false, code: 'unknown_plan' };

    const months = normalizeMonths(order && order.month, plan.months);
    const groupId = pending.custom_id;
    const amount = order && order.total_amount != null ? String(order.total_amount) : null;
    // delayed = 付款后先存为「未激活」，由用户自行选择时机激活
    const mode = pending.activate_mode === 'delayed' ? 'delayed' : 'immediate';
    const immediate = mode === 'immediate';

    const statements = [];
    for (const subject of plan.subjects) {
        statements.push(env.DB.prepare(
            `INSERT OR IGNORE INTO subscriptions
               (id, user_id, group_id, subject, plan_key, plan_name, months, status,
                start_at, expire_at, activate_mode, activated_at,
                afdian_order, afdian_plan_id, amount, source, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending',
                0, 0, ?8, NULL, ?9, ?10, ?11, ?12, ?13, ?13)`
        ).bind(
            crypto.randomUUID(), pending.user_id, groupId, subject, plan.key, plan.name, months,
            mode, orderNo, String((order && order.plan_id) || plan.planId),
            amount, source, now
        ));
    }

    try {
        await env.DB.batch(statements);
    } catch (e) {
        // 唯一索引冲突 => 已经被并发的另一次请求处理过了
        if (String(e).includes('UNIQUE')) return { ok: true, code: 'already', groupId };
        throw e;
    }

    await env.DB.prepare(
        `UPDATE pending_orders
            SET status = 'done', afdian_order = ?1, amount = ?2, last_error = NULL, updated_at = ?3
          WHERE custom_id = ?4`
    ).bind(orderNo, amount, now, groupId).run();

    let activated = 0;
    if (immediate) {
        activated = (await activateGroup(env, pending.user_id, groupId, now)).length;
    }

    await logEvent(env, pending.user_id, immediate ? 'grant' : 'grant_pending', JSON.stringify({
        groupId, orderNo, plan: plan.key, months, via, source, mode
    }));

    return {
        ok: true,
        code: immediate ? 'activated' : 'stored',
        groupId,
        activated,
        userId: pending.user_id,
        planKey: plan.key
    };
}

// ---------------------------------------------------------------------------
// 主动查询（核心）
// ---------------------------------------------------------------------------

async function markCheckFailure(env, pendingList, error) {
    const now = nowSec();
    const message = String((error && error.message) || '未知错误').slice(0, 300);
    const code = (error && error.code) || 'api_error';
    const stmts = pendingList.map(p => env.DB.prepare(
        `UPDATE pending_orders
            SET check_count = check_count + 1, last_check_at = ?1, last_error = ?2, updated_at = ?1
          WHERE custom_id = ?3`
    ).bind(now, code + ':' + message, p.custom_id));
    if (stmts.length) {
        try { await env.DB.batch(stmts); } catch (e) { console.error('markCheckFailure:', e && e.message); }
    }
    return { ok: false, code, message };
}

async function markCheckOk(env, pendingList) {
    const now = nowSec();
    const stmts = pendingList.map(p => env.DB.prepare(
        'UPDATE pending_orders SET check_count = check_count + 1, last_check_at = ?1, updated_at = ?1 WHERE custom_id = ?2'
    ).bind(now, p.custom_id));
    if (stmts.length) {
        try { await env.DB.batch(stmts); } catch (e) { console.error('markCheckOk:', e && e.message); }
    }
}

async function pendingListOf(env, userId) {
    const res = await env.DB.prepare(
        `SELECT * FROM pending_orders
          WHERE user_id = ?
            AND ( (status = 'pending'  AND created_at > ?2)
               OR (status = 'canceled' AND created_at > ?3) )
          ORDER BY created_at ASC LIMIT 20`
    ).bind(userId, nowSec() - PENDING_TTL, nowSec() - CANCELED_TTL).all();
    return res.results || [];
}

/**
 * 核对某个用户的待支付订单（调用爱发电 API）。
 * @param {{force?: boolean}} options force=true 时忽略节流（用户主动点“我已支付”）
 */
export async function syncUserOrders(env, userId, options = {}) {
    const force = !!options.force;
    const now = nowSec();

    const list = await pendingListOf(env, userId);
    if (!list.length) return { ok: true, code: 'nothing_pending', linked: 0 };

    if (!isAfdianConfigured(env)) {
        return { ok: false, code: 'not_configured', message: '服务端尚未配置爱发电接口，请联系客服人工开通', linked: 0 };
    }

    if (!force) {
        const last = Math.max(...list.map(r => Number(r.last_check_at) || 0));
        if (last && now - last < CHECK_INTERVAL) {
            return { ok: true, code: 'throttled', linked: 0 };
        }
    }

    let orders;
    try {
        orders = await fetchRecentOrders(env, SWEEP_PAGES, PAGE_SIZE);
    } catch (e) {
        const fail = await markCheckFailure(env, list, e);
        await logEvent(env, userId, 'check_failed', fail.code + ':' + fail.message);
        return { ok: false, code: fail.code, message: fail.message, linked: 0 };
    }

    const paid = orders.filter(isPaid);
    const byCustom = new Map();
    const byOrderNo = new Map();
    for (const o of paid) {
        const cid = orderCustomId(o);
        if (cid && !byCustom.has(cid)) byCustom.set(cid, o);
        const no = orderNoOf(o);
        if (no) byOrderNo.set(no, o);
    }

    let linked = 0;
    const done = new Set();
    const usedOrders = new Set();
    const remained = [];

    // 第一轮：关联码精确匹配
    for (const p of list) {
        let order = byCustom.get(p.custom_id);
        if (!order && p.afdian_order) order = byOrderNo.get(p.afdian_order);
        if (!order || !isPaid(order)) { remained.push(p); continue; }
        const res = await applyPaidOrder(env, order, 'afdian_api');
        if (res.ok) { linked++; done.add(p.custom_id); usedOrders.add(orderNoOf(order)); }
        else remained.push(p);
    }

    // 第二轮（可选）：无关联码的已支付订单，按套餐兜底认领
    if (fallbackEnabled(env) && remained.length) {
        for (const p of remained) {
            // 用户已从列表删除的订单只能靠精确关联码认领，不参与按套餐兜底，
            // 否则可能把别人的订单误开给这个账号
            if (p.status !== 'pending') continue;
            const cand = paid.find(o => {
                const no = orderNoOf(o);
                if (!no || usedOrders.has(no)) return false;
                if (orderCustomId(o)) return false;
                const pl = planByAfdianId(env, o.plan_id);
                return !!pl && pl.key === p.plan_key;
            });
            if (!cand) continue;
            const res = await applyPaidOrder(env, cand, 'afdian_api_fallback', { pendingCustomId: p.custom_id });
            if (res.ok && res.code !== 'already') {
                linked++;
                done.add(p.custom_id);
                usedOrders.add(orderNoOf(cand));
            }
        }
    }

    await markCheckOk(env, list.filter(p => !done.has(p.custom_id)));
    return { ok: true, code: linked ? 'synced' : 'not_found', linked };
}

/**
 * 定时任务：全量核对最近订单，处理未完成开通 + 标记过期。
 */
export async function sweepAllOrders(env) {
    const now = nowSec();
    const result = { activated: 0, expired: 0, linked: 0, code: 'ok' };

    result.expired = await expireRecords(env, null, now);

    const pending = (await env.DB.prepare(
        `SELECT custom_id, user_id FROM pending_orders
          WHERE (status = 'pending'  AND created_at > ?1)
             OR (status = 'canceled' AND created_at > ?2)
          ORDER BY created_at ASC LIMIT 200`
    ).bind(now - PENDING_TTL, now - CANCELED_TTL).all()).results || [];

    if (!pending.length) return result;
    if (!isAfdianConfigured(env)) { result.code = 'not_configured'; return result; }

    let orders;
    try {
        orders = await fetchRecentOrders(env, SWEEP_PAGES, PAGE_SIZE);
    } catch (e) {
        result.code = 'api_error';
        await markCheckFailure(env, pending, e);
        await logEvent(env, pending[0].user_id, 'sweep_failed', String(e && e.message));
        return result;
    }

    for (const order of orders.filter(isPaid)) {
        const res = await applyPaidOrder(env, order, 'afdian_cron');
        if (res.ok && res.code !== 'already') {
            result.linked++;
            if (res.activated) result.activated += res.activated;
        }
    }

    return result;
}

/**
 * 用户手动绑定订单号（已付款但未自动开通时的兜底手段）。
 */
export async function bindOrderByNo(env, userId, orderNo) {
    const no = String(orderNo || '').trim();
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(no)) return { ok: false, code: 'bad_input', message: '订单号格式不正确' };
    if (!isAfdianConfigured(env)) return { ok: false, code: 'not_configured', message: '服务端尚未配置爱发电接口' };

    const owned = await env.DB.prepare(
        'SELECT id FROM subscriptions WHERE afdian_order = ? LIMIT 1'
    ).bind(no).first();
    if (owned) return { ok: false, code: 'already_used', message: '该订单已被使用过' };

    let order;
    try {
        order = await findOrderByNo(env, no);
    } catch (e) {
        return { ok: false, code: (e && e.code) || 'api_error', message: (e && e.message) || '查询失败' };
    }
    if (!order) return { ok: false, code: 'not_found', message: '未在爱发电查到该订单号' };
    if (!isPaid(order)) return { ok: false, code: 'not_paid', message: '该订单尚未支付成功' };

    // 订单若自带关联码且已属于他人，拒绝绑定
    const cid = orderCustomId(order);
    if (cid) {
        const owner = await env.DB.prepare(
            'SELECT user_id FROM pending_orders WHERE custom_id = ?'
        ).bind(cid).first();
        if (owner && owner.user_id !== userId) {
            return { ok: false, code: 'belongs_to_other', message: '该订单已关联其它账号，请联系客服' };
        }
    }

    // 绑定目标：本人名下、同套餐、最早的待支付订单
    const plan = planByAfdianId(env, order.plan_id);
    let target = null;
    if (plan) {
        target = await env.DB.prepare(
            `SELECT custom_id FROM pending_orders
              WHERE user_id = ? AND status = 'pending' AND plan_key = ?
              ORDER BY created_at ASC LIMIT 1`
        ).bind(userId, plan.key).first();
    }

    const res = await applyPaidOrder(env, order, 'manual_bind', target ? { pendingCustomId: target.custom_id } : {});
    if (res.ok) return res;
    if (res.code === 'unlinked') {
        return { ok: false, code: 'unlinked', message: '请先在「续约」里生成该套餐的订单，再绑定订单号' };
    }
    return { ok: false, code: res.code, message: '绑定失败，请联系客服' };
}

// ---------------------------------------------------------------------------
// 删除未支付订单
// ---------------------------------------------------------------------------

/**
 * 「删除」一笔还没付款的待支付订单。
 *
 * 采用软删除（status = 'canceled'）而不是物理删除：
 *   · 列表与状态接口只展示 status = 'pending'，用户看到的效果就是删掉了；
 *   · 若用户其实已经付过款，事后核对订单时仍能凭 custom_order_id 关联并自动开通
 *     （见 LINKABLE_STATUSES），不会出现「付了钱却没开通」。
 */
export async function cancelPendingOrder(env, userId, customId) {
    const id = sanitizeCustomId(customId);
    if (!id) return { ok: false, code: 'bad_input', message: '缺少订单标识' };

    const row = await env.DB.prepare(
        "SELECT custom_id, plan_key, afdian_order FROM pending_orders " +
        "WHERE custom_id = ? AND user_id = ? AND status = 'pending'"
    ).bind(id, userId).first();

    if (!row) return { ok: false, code: 'not_found', message: '订单不存在或已被处理' };

    const now = nowSec();
    await env.DB.prepare(
        "UPDATE pending_orders SET status = 'canceled', updated_at = ?1 " +
        "WHERE custom_id = ?2 AND user_id = ?3 AND status = 'pending'"
    ).bind(now, id, userId).run();

    await logEvent(env, userId, 'cancel_order', JSON.stringify({ customId: id, plan: row.plan_key }));

    return { ok: true, code: 'canceled', customId: id };
}

// ---------------------------------------------------------------------------
// 下单
// ---------------------------------------------------------------------------

/**
 * 创建待支付订单。
 * @param {{activateMode?: 'immediate'|'delayed'}} options
 *        immediate = 付款后立即生效；delayed = 付款后保持「未激活」，由用户手动激活
 */
export async function createPendingOrder(env, userId, planKey, options = {}) {
    const plan = planByKey(env, planKey);
    if (!plan) return { ok: false, code: 'unknown_plan' };

    const mode = options.activateMode === 'delayed' ? 'delayed' : 'immediate';
    const customId = newCustomId();
    const now = nowSec();

    await env.DB.prepare(
        `INSERT INTO pending_orders
           (custom_id, user_id, plan_key, plan_id, months, activate_mode,
            status, check_count, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', 0, ?7, ?7)`
    ).bind(customId, userId, plan.key, plan.planId, plan.months, mode, now).run();

    await logEvent(env, userId, 'create_order', JSON.stringify({ customId, plan: plan.key, mode }));

    return { ok: true, customId, plan, activateMode: mode };
}

// ---------------------------------------------------------------------------
// 状态查询
// ---------------------------------------------------------------------------

function emptyState(env, userId) {
    return {
        status: 'inactive',
        planKey: null,
        planName: null,
        subjects: { k1: null, k2: null },
        expireAt: null,
        startAt: null,
        daysLeft: 0,
        memberNo: userId,
        pending: [],
        unpaid: [],
        activeGroups: [],
        history: [],
        lastError: null,
        support: String((env && env.SUPPORT_CONTACT) || '').trim() || null,
        serverTime: Date.now()
    };
}

function groupRows(rows) {
    const map = new Map();
    for (const r of rows) {
        if (!map.has(r.group_id)) map.set(r.group_id, []);
        map.get(r.group_id).push(r);
    }
    return map;
}

function pendingView(env, p) {
    const plan = planByKey(env, p.plan_key);
    let url = null;
    if (plan) {
        try {
            url = buildOrderUrl(env, plan, p.custom_id, { month: plan.months, productType: plan.productType });
        } catch {
            url = null;
        }
    }
    return {
        customId: p.custom_id,
        planKey: p.plan_key,
        planName: plan ? plan.name : p.plan_key,
        subjectLabel: plan ? subjectsLabel(plan.subjects) : '',
        months: p.months,
        activateMode: p.activate_mode,
        createdAt: p.created_at * 1000,
        checkCount: Number(p.check_count) || 0,
        lastError: p.last_error || null,
        url
    };
}

async function loadUnpaidOrders(env, userId, now) {
    const res = await env.DB.prepare(
        `SELECT custom_id, plan_key, months, activate_mode, created_at, check_count, last_error
           FROM pending_orders
          WHERE user_id = ? AND status = 'pending' AND created_at > ?
          ORDER BY created_at DESC LIMIT 10`
    ).bind(userId, now - PENDING_TTL).all();
    return res.results || [];
}

async function loadLastError(env, userId) {
    const fail = await env.DB.prepare(
        `SELECT last_error, last_check_at, custom_id FROM pending_orders
          WHERE user_id = ? AND status = 'pending' AND last_error IS NOT NULL
          ORDER BY last_check_at DESC LIMIT 1`
    ).bind(userId).first();
    if (!fail || !fail.last_error) return null;
    const raw = String(fail.last_error);
    const idx = raw.indexOf(':');
    return {
        code: idx >= 0 ? raw.slice(0, idx) : raw,
        message: idx >= 0 ? raw.slice(idx + 1) : '',
        at: (Number(fail.last_check_at) || 0) * 1000,
        customId: fail.custom_id
    };
}

/**
 * 计算用户当前的订阅状态（并顺带标记已过期权益）。
 */
export async function getSubscriptionState(env, userId, now = nowSec()) {
    await expireRecords(env, userId, now);

    const state = emptyState(env, userId);
    state.lastError = await loadLastError(env, userId);

    const unpaidRows = await loadUnpaidOrders(env, userId, now);
    state.unpaid = unpaidRows.map(p => pendingView(env, p));

    const rows = (await env.DB.prepare(
        `SELECT id, group_id, subject, plan_key, plan_name, months, status, start_at, expire_at,
                activate_mode, activated_at, afdian_order, amount, source, created_at
           FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`
    ).bind(userId).all()).results || [];

    if (!rows.length) {
        if (state.unpaid.length) state.status = 'unpaid';
        return state;
    }

    const activeRows = rows.filter(r => r.status === 'active' && r.expire_at > now);
    const pendingRows = rows.filter(r => r.status === 'pending');
    const historyRows = rows.filter(r => r.status === 'expired');

    const subjects = {};
    let expireAt = 0;
    let startAt = 0;
    for (const r of activeRows) {
        const ms = r.expire_at * 1000;
        if (!subjects[r.subject] || ms > subjects[r.subject]) subjects[r.subject] = ms;
        if (ms > expireAt) expireAt = ms;
        const s = r.start_at * 1000;
        if (s && (!startAt || s < startAt)) startAt = s;
    }

    const activeSubjects = Object.keys(subjects);
    state.subjects = { k1: subjects.k1 || null, k2: subjects.k2 || null };
    state.expireAt = expireAt || null;
    state.startAt = startAt || null;
    state.daysLeft = expireAt ? Math.max(0, Math.ceil((expireAt - Date.now()) / 86400000)) : 0;

    if (activeRows.length) {
        state.status = 'active';
        const key = planKeyFromSubjects(activeSubjects);
        state.planKey = key;
        state.planName = planNameFromSubjects(env, activeSubjects);
        state.activeGroups = Array.from(groupRows(activeRows).entries()).map(([groupId, list]) => ({
            groupId,
            planKey: list[0].plan_key,
            planName: list[0].plan_name,
            subjectLabel: subjectsLabel(list.map(r => r.subject)),
            months: list[0].months,
            expireAt: Math.max.apply(null, list.map(r => r.expire_at * 1000)),
            subjects: list.map(r => ({ subject: r.subject, expireAt: r.expire_at * 1000 }))
        })).sort((a, b) => b.expireAt - a.expireAt);
    } else if (pendingRows.length) {
        state.status = 'pending';
    } else if (state.unpaid.length) {
        state.status = 'unpaid';
    } else {
        state.status = 'expired';
        const keys = Array.from(new Set(historyRows.map(r => r.subject)));
        state.planKey = planKeyFromSubjects(keys);
        state.planName = planNameFromSubjects(env, keys);
    }

    state.pending = Array.from(groupRows(pendingRows).entries()).map(([groupId, list]) => ({
        groupId,
        planKey: list[0].plan_key,
        planName: list[0].plan_name,
        subjectLabel: subjectsLabel(list.map(r => r.subject)),
        months: list[0].months,
        activateMode: list[0].activate_mode,
        paidAt: list[0].created_at * 1000,
        orderNo: list[0].afdian_order,
        amount: list[0].amount,
        source: list[0].source,
        subjects: list.map(r => r.subject)
    })).sort((a, b) => (b.paidAt || 0) - (a.paidAt || 0));

    state.history = Array.from(groupRows(historyRows).entries()).slice(0, 6).map(([groupId, list]) => ({
        groupId,
        planName: list[0].plan_name,
        subjectLabel: subjectsLabel(list.map(r => r.subject)),
        months: list[0].months,
        startAt: list[0].start_at * 1000,
        expireAt: Math.max.apply(null, list.map(r => r.expire_at * 1000)),
        orderNo: list[0].afdian_order,
        amount: list[0].amount
    }));

    return state;
}

/**
 * 精简版订阅摘要，供 /api/auth/me 等接口复用。
 */
export async function getSubscriptionSummary(env, userId, now = nowSec()) {
    const state = await getSubscriptionState(env, userId, now);
    return {
        status: state.status,
        plan: state.planKey,
        planName: state.planName,
        expireAt: state.expireAt,
        startAt: state.startAt,
        daysLeft: state.daysLeft,
        subjects: state.subjects,
        memberNo: state.memberNo,
        pendingCount: state.pending.length,
        unpaidCount: state.unpaid.length
    };
}

/** 对外暴露的套餐目录（不含任何密钥） */
export function publicPlanCatalog(env) {
    const plans = getPlans(env);
    return ['k1', 'k2', 'k1k2'].map(key => ({
        key,
        name: plans[key].name,
        subjects: plans[key].subjects,
        subjectLabel: plans[key].short,
        months: plans[key].months
    }));
}

export { getAfdianConfig };
