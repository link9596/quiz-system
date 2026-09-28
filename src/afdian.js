// ============================================================================
// 订阅相关 HTTP 接口
// ----------------------------------------------------------------------------
//   GET  /api/subscription/plans      套餐目录
//   POST /api/subscription/create     生成待支付订单 + 爱发电下单链接
//   GET  /api/subscription/state      当前订阅状态（含节流后的自动核对）
//   POST /api/subscription/check      立即向爱发电核对订单（用户点“我已支付”）
//   POST /api/subscription/activate   激活一笔“延迟激活”的权益
//   POST /api/subscription/bind       用爱发电订单号手动绑定（兜底）
//
// 开通链路只走爱发电开放平台 API 主动查询，不依赖 webhook。
// ============================================================================

import { jsonResponse, checkRateLimit } from './utils.js';
import { requireAuth } from './auth.js';
import { buildOrderUrl, isAfdianConfigured } from './afdian-api.js';
import {
    createPendingOrder,
    getSubscriptionState,
    syncUserOrders,
    activateGroup,
    bindOrderByNo,
    publicPlanCatalog
} from './subscription.js';

function methodNotAllowed() {
    return jsonResponse({ error: 'Method Not Allowed' }, 405);
}

async function readJson(request) {
    try {
        const body = await request.json();
        return body && typeof body === 'object' ? body : {};
    } catch {
        return {};
    }
}

async function guard(request, env, scope) {
    const session = await requireAuth(request, env);
    if (!session) return { error: jsonResponse({ error: '未登录' }, 401) };
    if (!(await checkRateLimit(env.SUB_RATE_LIMITER, scope + ':' + session.userId))) {
        return { error: jsonResponse({ error: '操作过于频繁，请稍后再试' }, 429) };
    }
    return { session };
}

const supportPayload = (env) => ({
    support: String(env.SUPPORT_CONTACT || '').trim() || null
});

// ---------------------------------------------------------------------------
// 套餐目录
// ---------------------------------------------------------------------------
export async function handleSubscriptionPlans(request, env) {
    if (request.method !== 'GET') return methodNotAllowed();
    const session = await requireAuth(request, env);
    if (!session) return jsonResponse({ error: '未登录' }, 401);

    return jsonResponse({
        ok: true,
        plans: publicPlanCatalog(env),
        configured: isAfdianConfigured(env),
        memberNo: session.userId,
        ...supportPayload(env)
    });
}

// ---------------------------------------------------------------------------
// 创建订单
// ---------------------------------------------------------------------------
export async function handleCreateOrder(request, env) {
    if (request.method !== 'POST') return methodNotAllowed();

    const g = await guard(request, env, 'sub-create');
    if (g.error) return g.error;

    if (!isAfdianConfigured(env)) {
        return jsonResponse({
            error: '支付通道尚未配置，请联系客服人工开通',
            code: 'not_configured',
            memberNo: g.session.userId,
            ...supportPayload(env)
        }, 503);
    }

    const body = await readJson(request);
    const planKey = String(body.plan || '').toLowerCase();
    const activateMode = body.activateMode === 'delayed' ? 'delayed' : 'immediate';

    const created = await createPendingOrder(env, g.session.userId, planKey, { activateMode });
    if (!created.ok) return jsonResponse({ error: '套餐不存在', code: created.code }, 400);

    const url = buildOrderUrl(env, created.plan, created.customId, {
        month: created.plan.months,
        productType: created.plan.productType
    });

    return jsonResponse({
        ok: true,
        customId: created.customId,
        url,
        plan: {
            key: created.plan.key,
            name: created.plan.name,
            subjectLabel: created.plan.short,
            months: created.plan.months
        },
        activateMode: created.activateMode
    });
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------
export async function handleSubscriptionState(request, env) {
    if (request.method !== 'GET') return methodNotAllowed();
    const session = await requireAuth(request, env);
    if (!session) return jsonResponse({ error: '未登录' }, 401);

    // 有未完成订单时顺带核对一次（内部有 20s 节流，不会打爆接口）
    let sync = null;
    try {
        sync = await syncUserOrders(env, session.userId, { force: false });
    } catch (e) {
        console.error('syncUserOrders:', e && e.message);
    }

    const state = await getSubscriptionState(env, session.userId);
    return jsonResponse({ ok: true, state, sync, ...supportPayload(env) });
}

// ---------------------------------------------------------------------------
// 立即核对订单
// ---------------------------------------------------------------------------
export async function handleSubscriptionCheck(request, env) {
    if (request.method !== 'POST') return methodNotAllowed();

    const g = await guard(request, env, 'sub-check');
    if (g.error) return g.error;

    const sync = await syncUserOrders(env, g.session.userId, { force: true });
    const state = await getSubscriptionState(env, g.session.userId);

    const payload = {
        ok: !!sync.ok,
        code: sync.code,
        message: sync.message || null,
        linked: sync.linked || 0,
        memberNo: g.session.userId,
        state,
        ...supportPayload(env)
    };

    if (!sync.ok) {
        payload.message = payload.message || errorText(sync.code);
    }
    return jsonResponse(payload);
}

function errorText(code) {
    switch (code) {
        case 'not_configured': return '服务端尚未配置爱发电接口，请把会员编号发给客服人工开通';
        case 'api_error': return '暂时无法连接爱发电查询订单，请稍后重试或联系客服';
        default: return '订单核对失败，请稍后重试或联系客服';
    }
}

// ---------------------------------------------------------------------------
// 激活待生效权益 / 手动绑定
// ---------------------------------------------------------------------------
export async function handleSubscriptionActivate(request, env) {
    if (request.method !== 'POST') return methodNotAllowed();

    const g = await guard(request, env, 'sub-activate');
    if (g.error) return g.error;

    const body = await readJson(request);
    const groupId = String(body.groupId || '').trim();
    if (!groupId) return jsonResponse({ error: '缺少订单标识', code: 'bad_input' }, 400);

    const owned = await env.DB.prepare(
        "SELECT id FROM subscriptions WHERE user_id = ? AND group_id = ? AND status = 'pending' LIMIT 1"
    ).bind(g.session.userId, groupId).first();
    if (!owned) return jsonResponse({ error: '未找到待激活的权益', code: 'not_found' }, 404);

    const activated = await activateGroup(env, g.session.userId, groupId);
    const state = await getSubscriptionState(env, g.session.userId);
    return jsonResponse({ ok: true, activated: activated.length, state });
}


// ---------------------------------------------------------------------------
// 手动绑定订单号（兜底）
// ---------------------------------------------------------------------------
export async function handleSubscriptionBind(request, env) {
    if (request.method !== 'POST') return methodNotAllowed();

    const g = await guard(request, env, 'sub-bind');
    if (g.error) return g.error;

    const body = await readJson(request);
    const res = await bindOrderByNo(env, g.session.userId, body.orderNo);

    const state = await getSubscriptionState(env, g.session.userId);
    return jsonResponse({
        ok: !!res.ok,
        code: res.code,
        message: res.message || null,
        memberNo: g.session.userId,
        state,
        ...supportPayload(env)
    });
}
