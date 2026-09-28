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
                const bid = safeBankId(p.bankId);
                if (!bid) break;
                const cur = Number.isFinite(p.currentIndex) ? p.currentIndex : 0;
                stmts.push(env.DB.prepare(
                    `INSERT INTO b_meta (uid, bid, cur_idx, ver)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(uid, bid) DO UPDATE SET
                       cur_idx = excluded.cur_idx, ver = excluded.ver`
                ).bind(uid, bid, cur, newVer));
                break;
            }
            case 'bank_reset': {
                const bid = safeBankId(p.bankId);
                if (!bid) break;
                stmts.push(env.DB.prepare('DELETE FROM q_state WHERE uid = ? AND bid = ?').bind(uid, bid));
                stmts.push(env.DB.prepare('DELETE FROM b_meta WHERE uid = ? AND bid = ?').bind(uid, bid));
                break;
            }
            case 'reset_all': {
                stmts.push(env.DB.prepare('DELETE FROM q_state WHERE uid = ?').bind(uid));
                stmts.push(env.DB.prepare('DELETE FROM b_meta WHERE uid = ?').bind(uid));
                stmts.push(env.DB.prepare(
                    'UPDATE users SET exam_data = NULL, exam_ver = ?1, exam_updated_at = ?2, updated_at = ?2 WHERE id = ?3'
                ).bind(newVer, now, uid));
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
            case 'exam_state': {
                // 未完成考试的整份快照（跨设备续考）。cleared 表示已交卷/清除。
                // 原 exam_state 表已并进 users；清除时保留一个自增的 exam_ver，
                // 这样别的设备也能通过增量拉取知道「这份考试没了」。
                if (!p || p.cleared === true) {
                    stmts.push(env.DB.prepare(
                        'UPDATE users SET exam_data = NULL, exam_ver = ?1, exam_updated_at = ?2, updated_at = ?2 WHERE id = ?3'
                    ).bind(newVer, now, uid));
                    break;
                }
                stmts.push(env.DB.prepare(
                    'UPDATE users SET exam_data = ?1, exam_ver = ?2, exam_updated_at = ?3, updated_at = ?3 WHERE id = ?4'
                ).bind(JSON.stringify(p), newVer, now, uid));
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
    //   q = q_state 答题/收藏/连错，m = mock_log 模考记录，k = 题库进度，e = 未完成考试快照
    const since = Number(body.since) || 0;
    const [qPull, metaPull, mockPull, userRow] = await Promise.all([
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
        ).bind(uid, since).all(),
        // 未完成考试是「1 行/用户」，直接挂在 users 上，顺带在这里读出来
        env.DB.prepare(
            'SELECT exam_data, exam_ver, exam_updated_at FROM users WHERE id = ?'
        ).bind(uid).first()
    ]);

    // e: 未完成考试。data 为 null 时表示「已清除」，前端据此清掉本地快照。
    const eRows = [];
    if (userRow && userRow.exam_ver != null && Number(userRow.exam_ver) > since) {
        eRows.push({
            data: userRow.exam_data,
            ver: userRow.exam_ver,
            updated_at: userRow.exam_updated_at
        });
    }

    return jsonResponse({
        ok: true,
        serverVer: newVer,
        q: qPull.results || [],
        m: mockPull.results || [],
        k: metaPull.results || [],
        e: eRows
    });
}

/**
 * 分配本次同步的版本号。
 * 原 user_sync 表已并进 users：用户已登录必然存在，直接自增即可，
 * 不再需要 upsert，也不再需要「表不存在」的兜底分支。
 */
async function bumpVersion(env, uid, now) {
    try {
        const row = await env.DB.prepare(
            `UPDATE users SET sync_ver = sync_ver + 1, last_sync_at = ?1
              WHERE id = ?2 RETURNING sync_ver`
        ).bind(now, uid).first();
        if (row && typeof row.sync_ver === 'number') return row.sync_ver;
    } catch { /* 个别环境不支持 RETURNING，走下面的兜底 */ }
    await env.DB.prepare(
        'UPDATE users SET sync_ver = sync_ver + 1, last_sync_at = ?1 WHERE id = ?2'
    ).bind(now, uid).run();
    const row = await env.DB.prepare('SELECT sync_ver FROM users WHERE id = ?').bind(uid).first();
    return (row && row.sync_ver) || 1;
}

/** 题库 id 只允许这些字符，避免被拼进 JSON 路径时破坏语法 */
function safeBankId(bid) {
    return String(bid || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
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