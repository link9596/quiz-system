import { jsonResponse, checkRateLimit } from './utils.js';
import { requireAuth } from './auth.js';

const MAX_BATCH = 100;
const MAX_CHANGES = 500;

export async function handleSync(request, env) {
    if (request.method !== 'POST') return jsonResponse({ error: 'Method Not Allowed' }, 405);

    const session = await requireAuth(request, env);
    if (!session) return jsonResponse({ error: '未登录' }, 401);

    if (!(await checkRateLimit(env.SYNC_RATE_LIMITER, session.userId))) {
        return jsonResponse({ error: '同步过于频繁' }, 429);
    }

    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: '请求体格式错误' }, 400); }

    const changes = Array.isArray(body.changes) ? body.changes.slice(0, MAX_CHANGES) : [];
    const uid = session.userId;
    const now = Math.floor(Date.now() / 1000);

    // 分配版本号
    const newVer = await bumpVersion(env, uid, now);

    const stmts = [];

    for (const ch of changes) {
        if (!ch || typeof ch !== 'object') continue;
        const p = ch.payload || {};
        switch (ch.type) {
            case 'q_state': {
                if (!p.bankId || typeof p.qIdx !== 'number') break;
                const st = p.status === 'correct' ? 1 : p.status === 'wrong' ? 2 : 0;
                const ans = typeof p.userAnswer === 'string' ? p.userAnswer : null;
                const streak = Number.isFinite(p.wrongStreak) ? p.wrongStreak : 0;
                // 不覆盖 fav
                stmts.push(env.DB.prepare(
                    `INSERT INTO q_state (uid, bid, qid, st, ans, fav, streak, ver)
                     VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7)
                     ON CONFLICT(uid, bid, qid) DO UPDATE SET
                       st = excluded.st,
                       ans = excluded.ans,
                       streak = excluded.streak,
                       ver = excluded.ver`
                ).bind(uid, p.bankId, p.qIdx, st, ans, streak, newVer));
                break;
            }
            case 'q_delete': {
                if (!p.bankId || typeof p.qIdx !== 'number') break;
                stmts.push(env.DB.prepare(
                    'DELETE FROM q_state WHERE uid = ? AND bid = ? AND qid = ?'
                ).bind(uid, p.bankId, p.qIdx));
                break;
            }
            case 'fav': {
                if (!p.bankId || typeof p.qIdx !== 'number') break;
                if (p.action === 'add') {
                    stmts.push(env.DB.prepare(
                        `INSERT INTO q_state (uid, bid, qid, st, ans, fav, streak, ver)
                         VALUES (?1, ?2, ?3, 0, NULL, 1, 0, ?4)
                         ON CONFLICT(uid, bid, qid) DO UPDATE SET
                           fav = 1, ver = excluded.ver`
                    ).bind(uid, p.bankId, p.qIdx, newVer));
                } else {
                    stmts.push(env.DB.prepare(
                        `UPDATE q_state SET fav = 0, ver = ?
                         WHERE uid = ? AND bid = ? AND qid = ?`
                    ).bind(newVer, uid, p.bankId, p.qIdx));
                }
                break;
            }
            case 'bank_current': {
                if (!p.bankId) break;
                const cur = Number.isFinite(p.currentIndex) ? p.currentIndex : 0;
                stmts.push(env.DB.prepare(
                    `INSERT INTO b_meta (uid, bid, cur_idx, ver)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(uid, bid) DO UPDATE SET
                       cur_idx = excluded.cur_idx, ver = excluded.ver`
                ).bind(uid, p.bankId, cur, newVer));
                break;
            }
            case 'bank_reset': {
                if (!p.bankId) break;
                stmts.push(env.DB.prepare('DELETE FROM q_state WHERE uid = ? AND bid = ?').bind(uid, p.bankId));
                stmts.push(env.DB.prepare('DELETE FROM b_meta WHERE uid = ? AND bid = ?').bind(uid, p.bankId));
                break;
            }
            case 'reset_all': {
                stmts.push(env.DB.prepare('DELETE FROM q_state WHERE uid = ?').bind(uid));
                stmts.push(env.DB.prepare('DELETE FROM b_meta WHERE uid = ?').bind(uid));
                break;
            }
            case 'mock_add': {
                if (typeof p.score !== 'number') break;
                stmts.push(env.DB.prepare(
                    `INSERT INTO mock_log
                       (uid, score, passed, correct, wrong, unanswered, total, dur, ts, detail, ver)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
                ).bind(
                    uid,
                    p.score,
                    p.passed ? 1 : 0,
                    p.correct || 0,
                    p.wrong || 0,
                    p.unanswered || 0,
                    p.total || 0,
                    p.duration || 0,
                    p.ts || now * 1000,
                    buildCompactDetail(p.answers),
                    newVer
                ));
                break;
            }
        }
    }

    // 分批执行
    for (let i = 0; i < stmts.length; i += MAX_BATCH) {
        try {
            await env.DB.batch(stmts.slice(i, i + MAX_BATCH));
        } catch (e) {
            console.error('Batch error:', e);
            return jsonResponse({ error: '同步失败' }, 500);
        }
    }

    // 拉取自 since 之后的所有变更
    // 返回字段契约（前端 applyRemoteChanges 依赖它）：
    //   q = q_state 答题/收藏/连错，m = mock_log 模考记录，k = b_meta 题库进度
    const since = Number(body.since) || 0;
    const [qPull, metaPull, mockPull] = await Promise.all([
        env.DB.prepare(
            `SELECT bid, qid, st, ans, fav, streak FROM q_state
             WHERE uid = ? AND ver > ? LIMIT 2000`
        ).bind(uid, since).all(),
        env.DB.prepare(
            `SELECT bid, cur_idx FROM b_meta WHERE uid = ? AND ver > ? LIMIT 500`
        ).bind(uid, since).all(),
        env.DB.prepare(
            `SELECT id, score, passed, correct, wrong, unanswered, total, dur, ts FROM mock_log
             WHERE uid = ? AND ver > ? ORDER BY id LIMIT 500`
        ).bind(uid, since).all()
    ]);

    return jsonResponse({
        ok: true,
        serverVer: newVer,
        q: qPull.results || [],
        m: mockPull.results || [],
        k: metaPull.results || []
    });
}

async function bumpVersion(env, uid, now) {
    try {
        const row = await env.DB.prepare(
            `INSERT INTO user_sync (uid, ver, last_sync_at)
             VALUES (?1, 1, ?2)
             ON CONFLICT(uid) DO UPDATE SET
               ver = user_sync.ver + 1,
               last_sync_at = ?2
             RETURNING ver`
        ).bind(uid, now).first();
        if (row) return row.ver;
    } catch { /* fallback */ }
    await env.DB.prepare(
        `INSERT INTO user_sync (uid, ver, last_sync_at)
         VALUES (?1, 1, ?2)
         ON CONFLICT(uid) DO UPDATE SET
           ver = user_sync.ver + 1, last_sync_at = ?2`
    ).bind(uid, now).run();
    const row = await env.DB.prepare('SELECT ver FROM user_sync WHERE uid = ?').bind(uid).first();
    return row ? row.ver : 1;
}

function buildCompactDetail(answers) {
    if (!Array.isArray(answers)) return '[]';
    const compact = answers.map(a => [
        a.bankId,
        a.qIdx,
        a.userAnswer || null,
        a.isRight ? 1 : 0,
        a.unanswered ? 1 : 0
    ]);
    return JSON.stringify(compact);
}