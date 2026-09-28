import { jsonResponse } from './utils.js';
import { requireAuth } from './auth.js';

export async function handleMockDetail(request, env) {
    if (request.method !== 'GET') return jsonResponse({ error: 'Method Not Allowed' }, 405);

    const session = await requireAuth(request, env);
    if (!session) return jsonResponse({ error: '未登录' }, 401);

    const url = new URL(request.url);
    const id = parseInt(url.searchParams.get('id') || '0', 10);
    if (!id || id < 1) return jsonResponse({ error: '参数错误' }, 400);

    const row = await env.DB.prepare(
        `SELECT id, score, passed, correct, wrong, unanswered, total, dur, ts, detail
         FROM mock_log WHERE uid = ? AND id = ?`
    ).bind(session.userId, id).first();

    if (!row) return jsonResponse({ error: '未找到' }, 404);

    let detail = [];
    try { detail = row.detail ? JSON.parse(row.detail) : []; } catch { detail = []; }

    return jsonResponse({
        id: row.id,
        score: row.score,
        passed: !!row.passed,
        correct: row.correct,
        wrong: row.wrong,
        unanswered: row.unanswered,
        total: row.total,
        dur: row.dur,
        ts: row.ts,
        detail
    });
}