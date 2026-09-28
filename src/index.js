import { jsonResponse, withSecurityHeaders, handleCors } from './utils.js';
import { handleAuth } from './auth.js';
import { handleSync } from './sync.js';
import { handleMockDetail } from './mock.js';
import { handleCreateOrder, handleAfdianWebhook } from './afdian.js';

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
            } else if (path === '/api/subscription/create') {
                response = await handleCreateOrder(request, env);
            } else if (path === '/api/afdian/webhook') {
                response = await handleAfdianWebhook(request, env);
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
                env.DB.prepare('DELETE FROM pending_orders WHERE created_at < ?').bind(now - 86400 * 2),
                env.DB.prepare(
                    "UPDATE subscriptions SET status = 'expired', updated_at = ? WHERE status = 'active' AND expire_at < ?"
                ).bind(now, now)
            ]);
        } catch (e) {
            console.error('Cron error:', e);
        }
    }
};