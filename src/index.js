import { jsonResponse, withSecurityHeaders, handleCors } from './utils.js';
import { handleAuth } from './auth.js';
import { handleSync } from './sync.js';
import { handleMockDetail } from './mock.js';
import {
    handleCreateOrder,
    handleSubscriptionPlans,
    handleSubscriptionState,
    handleSubscriptionCheck,
    handleSubscriptionActivate,
    handleSubscriptionSchedule,
    handleSubscriptionBind
} from './afdian.js';
import { sweepAllOrders, activateDue, expireRecords } from './subscription.js';

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;

        if (request.method === 'OPTIONS') {
            return handleCors(request, env);
        }

        try {
            let response;

            if (path.startsWith('/api/auth/')) {
                response = await handleAuth(request, env, path);
            } else if (path === '/api/sync') {
                response = await handleSync(request, env);
            } else if (path === '/api/mock/detail') {
                response = await handleMockDetail(request, env);
            } else if (path === '/api/subscription/plans') {
                response = await handleSubscriptionPlans(request, env);
            } else if (path === '/api/subscription/create') {
                response = await handleCreateOrder(request, env);
            } else if (path === '/api/subscription/state') {
                response = await handleSubscriptionState(request, env);
            } else if (path === '/api/subscription/check') {
                response = await handleSubscriptionCheck(request, env);
            } else if (path === '/api/subscription/activate') {
                response = await handleSubscriptionActivate(request, env);
            } else if (path === '/api/subscription/schedule') {
                response = await handleSubscriptionSchedule(request, env);
            } else if (path === '/api/subscription/bind') {
                response = await handleSubscriptionBind(request, env);
            } else if (path === '/api/health') {
                response = jsonResponse({ ok: true, ts: Date.now() });
            } else {
                response = new Response('Not Found', { status: 404 });
            }

            return withSecurityHeaders(response, request, env);
        } catch (e) {
            console.error('Unhandled:', e && e.stack || e);
            return withSecurityHeaders(
                jsonResponse({ error: '服务器错误' }, 500),
                request,
                env
            );
        }
    },

    async scheduled(event, env, ctx) {
        const now = Math.floor(Date.now() / 1000);
        try {
            await env.DB.batch([
                env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
                env.DB.prepare('DELETE FROM login_attempts WHERE locked_until IS NOT NULL AND locked_until < ?').bind(now),
                env.DB.prepare("DELETE FROM pending_orders WHERE created_at < ? AND status = 'done'").bind(now - 86400 * 30),
                env.DB.prepare("DELETE FROM pending_orders WHERE created_at < ? AND status <> 'done'").bind(now - 86400 * 60),
                env.DB.prepare('DELETE FROM sub_events WHERE created_at < ?').bind(now - 86400 * 90)
            ]);
        } catch (e) {
            console.error('Cron error:', e);
        }

        // 订阅：到点激活 + 过期标记 + 爱发电订单核对（付款后自动开通）
        try {
            await expireRecords(env, null, now);
            await activateDue(env, null, now);
            const sweep = await sweepAllOrders(env);
            if (sweep.linked) console.log('Subscription sweep:', JSON.stringify(sweep));
        } catch (e) {
            console.error('Subscription cron error:', e && e.stack || e);
        }
    }
};