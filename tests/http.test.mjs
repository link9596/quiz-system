// ============================================================================
// HTTP 层集成测试：直接调用 Worker 的 fetch / scheduled handler
//   node tests/http.test.mjs
// ============================================================================
import { makeEnv, createChecker, stubAfdian } from './d1-shim.mjs';

const afdian = stubAfdian();
const env = makeEnv();
const worker = (await import('../src/index.js')).default;
const BASE = 'https://quiz.example.com';

const { check, summary } = createChecker();

let cookie = '';
async function call(path, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    if (cookie) headers['Cookie'] = cookie;
    const req = new Request(BASE + path, { method: options.method || 'GET', headers, body: options.body });
    const res = await worker.fetch(req, env, {});
    const sc = res.headers.get('Set-Cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
}
const post = (p, body) => call(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const raw = (path, init) => worker.fetch(new Request(BASE + path, init), env, {});

console.log('\n[A] 基础与安全头');
{
    const r = await call('/api/health');
    check('健康检查 200', r.status === 200 && r.data.ok === true, r.data);
    check('带安全响应头', r.headers.get('X-Content-Type-Options') === 'nosniff');
    check('未知路由 404', (await call('/api/nope')).status === 404);
    const opt = await raw('/api/health', { method: 'OPTIONS', headers: { Origin: 'https://x.com' } });
    check('OPTIONS 预检 204', opt.status === 204);
}

console.log('\n[B] 注册 / 鉴权');
let userId = '';
{
    const reg = await post('/api/auth/register', { email: 'Test@Example.com', password: 'Abc12345', nickname: '小飞' });
    check('注册成功', reg.status === 200 && !!reg.data.id, reg.data);
    userId = reg.data.id;
    check('响应含订阅摘要', !!reg.data.subscription, reg.data.subscription);
    check('订阅摘要含会员编号', reg.data.subscription.memberNo === userId);
    check('邮箱大小写归一化后重复注册被拒', (await post('/api/auth/register', { email: 'test@example.com', password: 'Abc12345' })).status === 409);
    check('弱密码被拒', (await post('/api/auth/register', { email: 'x@y.com', password: 'weak' })).status === 400);
    const me = await call('/api/auth/me');
    check('/me 返回订阅状态', me.status === 200 && !!me.data.subscription, me.data);

    check('未登录访问订阅状态 401', (await raw('/api/subscription/state')).status === 401);
    check('未登录核对订单 401', (await raw('/api/subscription/check', { method: 'POST' })).status === 401);
    check('未登录下单 401', (await raw('/api/subscription/create', { method: 'POST' })).status === 401);
    check('未登录绑定订单 401', (await raw('/api/subscription/bind', { method: 'POST' })).status === 401);
}

console.log('\n[C] 套餐目录');
{
    const r = await call('/api/subscription/plans');
    check('返回 3 个套餐', r.status === 200 && r.data.plans.length === 3, r.data.plans && r.data.plans.map(p => p.key));
    check('不向前端泄露 plan_id', !JSON.stringify(r.data.plans).includes('plan-k'), r.data.plans[0]);
    check('返回会员编号', r.data.memberNo === userId);
    check('返回客服信息', String(r.data.support).includes('QQ'), r.data.support);
}

console.log('\n[D] 下单 -> 支付 -> 自动开通');
{
    const c = await post('/api/subscription/create', { plan: 'k1', activateMode: 'immediate' });
    check('创建订单成功', c.status === 200 && c.data.ok, c.data);
    check('返回爱发电下单链接', /^https:\/\/ifdian\.net\/order\/create\?/.test(c.data.url), c.data.url);
    check('链接带套餐 plan_id', c.data.url.includes('plan_id=plan-k1'), c.data.url);
    check('链接带关联码', c.data.url.includes('custom_order_id=' + c.data.customId), c.data.url);
    check('非法套餐被拒', (await post('/api/subscription/create', { plan: 'nope' })).status === 400);

    let st = await call('/api/subscription/state');
    check('未付款 status=unpaid', st.data.state.status === 'unpaid', st.data.state.status);
    check('未付款订单带继续支付链接', !!st.data.state.unpaid[0].url);

    afdian.orders = [{
        out_trade_no: '20250101HTTP0001', custom_order_id: c.data.customId,
        plan_id: 'plan-k1', month: 1, total_amount: '9.90', status: 2, remark: c.data.customId
    }];
    const ck = await post('/api/subscription/check', {});
    check('核对返回 synced', ck.data.ok && ck.data.code === 'synced', ck.data);
    check('核对后 status=active', ck.data.state.status === 'active', ck.data.state.status);
    check('返回到期时间', !!ck.data.state.expireAt);
    check('subjects.k1 已开通', !!ck.data.state.subjects.k1);
    check('/me 同步反映 active', (await call('/api/auth/me')).data.subscription.status === 'active');
}

console.log('\n[E] 延迟激活接口');
{
    const c = await post('/api/subscription/create', { plan: 'k2', activateMode: 'delayed' });
    check('创建延迟激活订单', c.status === 200 && c.data.activateMode === 'delayed', c.data);
    afdian.orders.push({ out_trade_no: '20250101HTTP0002', custom_order_id: c.data.customId, plan_id: 'plan-k2', month: 1, status: 2 });
    const ck = await post('/api/subscription/check', {});
    check('已有生效权益时顶层仍为 active', ck.data.state.status === 'active', ck.data.state.status);
    check('新购权益进入 pending', ck.data.state.pending.length === 1, ck.data.state.pending.length);

    const gid = ck.data.state.pending[0].groupId;
    const act = await post('/api/subscription/activate', { groupId: gid });
    check('激活成功', act.status === 200 && act.data.activated === 1, act.data);
    check('激活后两科均开通', !!act.data.state.subjects.k1 && !!act.data.state.subjects.k2, act.data.state.subjects);
    check('重复激活返回 404', (await post('/api/subscription/activate', { groupId: gid })).status === 404);
    check('已移除预约激活接口（404）', (await post('/api/subscription/schedule', {})).status === 404);
    check('缺少参数返回 400', (await post('/api/subscription/activate', {})).status === 400);
}

console.log('\n[F] 开通失败提示与手动绑定');
{
    await post('/api/subscription/create', { plan: 'k1', activateMode: 'immediate' });

    const bind = await post('/api/subscription/bind', { orderNo: '20250101HTTP0099' });
    check('未知订单号绑定失败', bind.data.ok === false && bind.data.code === 'not_found', bind.data);
    check('失败响应带会员编号（弹窗展示）', bind.data.memberNo === userId, bind.data.memberNo);

    afdian.mode = 'down';
    const ck = await post('/api/subscription/check', {});
    check('接口故障返回 api_error', ck.data.ok === false && ck.data.code === 'api_error', ck.data);
    check('故障响应带客服信息', !!ck.data.support);
    afdian.mode = 'ok';

    const st = await call('/api/subscription/state');
    check('状态里带 lastError', !!st.data.state.lastError, st.data.state.lastError);
    check('lastError 含可读原因', String(st.data.state.lastError.message).length > 0);
    check('非法订单号被拒', (await post('/api/subscription/bind', { orderNo: '!!' })).data.code === 'bad_input');
}

console.log('\n[G] 定时任务（单触发器兼顾每日清理）');
{
    // 单个 cron 名额：*/15 每 15 分钟跑一次，只有 UTC 03:00~03:14 那次做每日清理
    const ctl = await post('/api/subscription/create', { plan: 'k1k2', activateMode: 'immediate' });
    afdian.orders = [{
        out_trade_no: '20250101CRON0001', custom_order_id: ctl.data.customId,
        plan_id: 'plan-k1k2', month: 1, status: 2
    }];

    const atNoon = Date.UTC(2025, 0, 15, 12, 0, 0);
    await worker.scheduled({ scheduledTime: atNoon, cron: '*/15 * * * *' }, env, {});
    const afterNoon = await call('/api/subscription/state');
    check('非清理时段也照常核对订单并开通', afterNoon.data.state.status === 'active', afterNoon.data.state.status);

    // 造一条过期 session，验证只有 03:0x 那次才清理
    env._sqlite.prepare("INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES ('deadbeef','x',1,1)").run();
    const sessionsBefore = env._sqlite.prepare('SELECT COUNT(*) c FROM sessions').get().c;

    await worker.scheduled({ scheduledTime: atNoon, cron: '*/15 * * * *' }, env, {});
    check('非清理时段不删过期 session',
        env._sqlite.prepare('SELECT COUNT(*) c FROM sessions').get().c === sessionsBefore, sessionsBefore);

    const at3am = Date.UTC(2025, 0, 15, 3, 5, 0);
    await worker.scheduled({ scheduledTime: at3am, cron: '*/15 * * * *' }, env, {});
    check('UTC 03:0x 那次执行每日清理（删除过期 session）',
        env._sqlite.prepare("SELECT COUNT(*) c FROM sessions WHERE token_hash='deadbeef'").get().c === 0);

    check('缺少 scheduledTime 时不抛异常', await worker.scheduled({}, env, {}).then(() => true, () => false));
}

console.log('\n[H] 退出登录');
{
    check('退出成功', (await post('/api/auth/logout', {})).status === 200);
    cookie = '';
    check('退出后 /me 401', (await call('/api/auth/me')).status === 401);
}

process.exit(summary() ? 1 : 0);
