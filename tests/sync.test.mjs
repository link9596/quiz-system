// ============================================================================
// 云同步接口测试（推送 + 下拉 + since 游标）
//   node tests/sync.test.mjs
// ============================================================================
import { makeEnv, createChecker } from './d1-shim.mjs';

globalThis.fetch = async () => new Response('{}', { status: 200 });
const env = makeEnv();
const worker = (await import('../src/index.js')).default;
const BASE = 'https://quiz.example.com';
const { check, summary } = createChecker();

let cookie = '';
async function call(path, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    if (cookie) headers['Cookie'] = cookie;
    const res = await worker.fetch(new Request(BASE + path, { method: options.method || 'GET', headers, body: options.body }), env, {});
    const sc = res.headers.get('Set-Cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
}
const post = (p, b) => call(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });
const count = (sql) => env._sqlite.prepare(sql).get().c;

console.log('\n[A] 鉴权');
check('未登录不能同步', (await worker.fetch(new Request(BASE + '/api/sync', { method: 'POST' }), env, {})).status === 401);
check('GET 不允许', (await call('/api/sync')).status === 405);

const reg = await post('/api/auth/register', { email: 'sync@test.com', password: 'Abc12345', nickname: '同步测试' });
const uid = reg.data.id;
check('注册成功', !!uid);

console.log('\n[B] 推送本地变更');
const changes = [
    { type: 'q_state', payload: { bankId: 'k2-feiji', qIdx: 3, status: 'correct', userAnswer: 'A' }, ts: Date.now() },
    { type: 'q_state', payload: { bankId: 'k2-feiji', qIdx: 5, status: 'wrong', userAnswer: 'C', wrongStreak: 2 }, ts: Date.now() },
    { type: 'fav', payload: { bankId: 'k2-feiji', qIdx: 7, action: 'add' }, ts: Date.now() },
    { type: 'bank_current', payload: { bankId: 'k2-feiji', currentIndex: 12 }, ts: Date.now() },
    { type: 'mock_add', payload: { ts: 1700000000000, score: 88, passed: true, correct: 44, wrong: 5, unanswered: 1, total: 50, duration: 1800,
        answers: [{ bankId: 'k2-feiji', qIdx: 3, userAnswer: 'A', isRight: true, unanswered: false }] }, ts: Date.now() }
];
const push = await post('/api/sync', { changes });
check('推送成功', push.status === 200 && push.data.ok === true, push.data);
check('返回 serverVer', typeof push.data.serverVer === 'number' && push.data.serverVer > 0, push.data.serverVer);

check('q_state 落库 3 行', count('SELECT COUNT(*) c FROM q_state') === 3, count('SELECT COUNT(*) c FROM q_state'));
check('答题状态已保存', count("SELECT COUNT(*) c FROM q_state WHERE st = 1") === 1);
check('错题状态已保存', count("SELECT COUNT(*) c FROM q_state WHERE st = 2") === 1);
check('收藏已保存', count('SELECT COUNT(*) c FROM q_state WHERE fav = 1') === 1);
check('连错次数已保存', count('SELECT COUNT(*) c FROM q_state WHERE streak = 2') === 1);
check('模考记录已保存', count('SELECT COUNT(*) c FROM mock_log') === 1);
check('进度已保存', count('SELECT COUNT(*) c FROM b_meta') === 1);

const mock = env._sqlite.prepare('SELECT * FROM mock_log').get();
check('模考字段完整', mock.score === 88 && mock.passed === 1 && mock.correct === 44 && mock.wrong === 5 && mock.total === 50 && mock.dur === 1800, mock);
check('模考时间戳原样保存', mock.ts === 1700000000000, mock.ts);
check('模考答题详情已保存', String(mock.detail || '').includes('k2-feiji'), mock.detail);

console.log('\n[C] 下拉（前端靠这个把云端数据合并回本地）');
check('首次 since=0 返回全部 q', (push.data.q || []).length === 3, push.data.q && push.data.q.length);
check('返回模考记录', (push.data.m || []).length === 1, push.data.m && push.data.m.length);
check('返回题库进度', (push.data.k || []).length === 1, push.data.k && push.data.k.length);
const qRow = (push.data.q || [])[0];
check('q 行含 bid/qid/st/ans/fav/streak', ['bid', 'qid', 'st', 'ans', 'fav', 'streak'].every(k => k in qRow), qRow);
check('m 行含 id（用于懒加载详情）', 'id' in (push.data.m || [{}])[0], (push.data.m || [{}])[0]);

const pulled = await post('/api/sync', { changes: [], since: push.data.serverVer });
check('since 追上后不再重复下发 q', (pulled.data.q || []).length === 0, pulled.data.q);
check('since 追上后不再重复下发 m', (pulled.data.m || []).length === 0, pulled.data.m);
check('serverVer 单调递增', pulled.data.serverVer >= push.data.serverVer, { before: push.data.serverVer, after: pulled.data.serverVer });

console.log('\n[D] 增量：新变更只在 since 之后出现');
const push2 = await post('/api/sync', { changes: [
    { type: 'q_state', payload: { bankId: 'k2-feiji', qIdx: 9, status: 'correct', userAnswer: 'D' }, ts: Date.now() }
], since: push.data.serverVer });
check('新版本号递增', push2.data.serverVer > push.data.serverVer, { before: push.data.serverVer, after: push2.data.serverVer });
check('只返回新增的那一条', (push2.data.q || []).length === 1, push2.data.q);

console.log('\n[E] 幂等与覆盖');
await post('/api/sync', { changes: [{ type: 'q_state', payload: { bankId: 'k2-feiji', qIdx: 3, status: 'wrong', userAnswer: 'B' }, ts: Date.now() }] });
const q3 = env._sqlite.prepare("SELECT st, ans FROM q_state WHERE bid='k2-feiji' AND qid=3").get();
check('同一题再次作答覆盖而不是新增', q3.st === 2 && q3.ans === 'B', q3);
check('总行数仍为 4', count('SELECT COUNT(*) c FROM q_state') === 4, count('SELECT COUNT(*) c FROM q_state'));

await post('/api/sync', { changes: [{ type: 'bank_reset', payload: { bankId: 'k2-feiji' }, ts: Date.now() }] });
check('重置题库清空该库记录', count("SELECT COUNT(*) c FROM q_state WHERE bid='k2-feiji'") === 0);
check('重置题库清空进度', count('SELECT COUNT(*) c FROM b_meta') === 0);
check('模考记录不受题库重置影响', count('SELECT COUNT(*) c FROM mock_log') === 1);

console.log('\n[F] 模考详情接口（同步下来的记录靠它补答题详情）');
const mid = env._sqlite.prepare('SELECT id FROM mock_log LIMIT 1').get().id;
const detail = await call('/api/mock/detail?id=' + mid);
check('能取到详情', detail.status === 200 && Array.isArray(detail.data.detail), detail.data);
check('详情是紧凑数组格式', Array.isArray(detail.data.detail[0]) && detail.data.detail[0].length === 5, detail.data.detail[0]);
check('不存在返回 404', (await call('/api/mock/detail?id=99999')).status === 404);

console.log('\n[G] 脏数据不炸');
const dirty = await post('/api/sync', { changes: [null, 1, 'x', {}, { type: 'unknown', payload: {} },
    { type: 'q_state', payload: {} }, { type: 'mock_add', payload: { score: 'not-a-number' } }] });
check('无效变更被忽略且不报错', dirty.status === 200 && dirty.data.ok === true, dirty.data);

console.log('\n[H] 账号隔离');
const reg2 = await post('/api/auth/register', { email: 'sync2@test.com', password: 'Abc12345' });
check('第二个账号注册成功', !!reg2.data.id);
const other = await post('/api/sync', { changes: [], since: 0 });
check('B 账号看不到 A 的数据', (other.data.q || []).length === 0 && (other.data.m || []).length === 0, other.data);

process.exit(summary() ? 1 : 0);
