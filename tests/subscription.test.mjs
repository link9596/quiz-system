// ============================================================================
// 订阅引擎集成测试（直接跑真实逻辑 + 真实 SQL）
//   node tests/subscription.test.mjs
// ============================================================================
import { makeEnv, createChecker, stubAfdian, DAY_MS, nowSec, daysFromNow, isoDate } from './d1-shim.mjs';

const afdian = stubAfdian();

const {
    createPendingOrder, applyPaidOrder, syncUserOrders, getSubscriptionState,
    activateGroup, bindOrderByNo, sweepAllOrders, publicPlanCatalog
} = await import('../src/subscription.js');
const { buildOrderUrl, buildSignedBody, getAfdianConfig } = await import('../src/afdian-api.js');
const { md5 } = await import('../src/md5.js');

const { check, summary } = createChecker();

console.log('\n[1] 签名与下单链接');
{
    const env = makeEnv();
    const cfg = getAfdianConfig(env);
    const body = buildSignedBody(cfg, { page: 1, per_page: 50 }, 1700000000);
    const expected = md5('tok-abcparams{"page":1,"per_page":50}ts1700000000user_idcreator-1');
    check('sign 与爱发电文档公式一致', body.sign === expected, { got: body.sign, want: expected });
    check('sign 为 32 位小写十六进制', /^[0-9a-f]{32}$/.test(body.sign), body.sign);

    const url = buildOrderUrl(env, { planId: 'plan-k1', months: 1, productType: 0 }, 'TK-TESTORDER1');
    check('下单链接使用 ifdian.net', url.startsWith('https://ifdian.net/order/create?'), url);
    check('下单链接带 plan_id', url.includes('plan_id=plan-k1'), url);
    check('下单链接带 custom_order_id（订单归属依据）', url.includes('custom_order_id=TK-TESTORDER1'), url);
    check('套餐目录共 3 项', publicPlanCatalog(env).length === 3);
}

console.log('\n[2] 立即激活：付款后由 API 查询自动开通');
{
    const env = makeEnv();
    const uid = 'user-1';
    const created = await createPendingOrder(env, uid, 'k1', { activateMode: 'immediate' });
    check('创建待支付订单', created.ok && /^TK-[A-Z0-9]{12}$/.test(created.customId), created.customId);

    const before = await getSubscriptionState(env, uid);
    check('未付款 status=unpaid', before.status === 'unpaid', before.status);
    check('未付款 unpaid 1 条', before.unpaid.length === 1, before.unpaid.length);

    afdian.orders = [];
    let sync = await syncUserOrders(env, uid, { force: true });
    check('未付款时查不到订单', sync.code === 'not_found', sync);

    afdian.orders = [{
        out_trade_no: '20250101ORDER0001', custom_order_id: created.customId,
        plan_id: 'plan-k1', month: 1, total_amount: '9.90', status: 2, remark: created.customId
    }];
    sync = await syncUserOrders(env, uid, { force: true });
    check('付款后核对成功', sync.code === 'synced', sync);

    const after = await getSubscriptionState(env, uid);
    check('状态 active', after.status === 'active', after.status);
    check('planKey=k1', after.planKey === 'k1', after.planKey);
    check('仅开通科目一', !!after.subjects.k1 && !after.subjects.k2, after.subjects);
    check('到期时间约 1 个月后', Math.abs(daysFromNow(after.expireAt) - 30) <= 2, daysFromNow(after.expireAt));
    check('会员编号 = 账号 id', after.memberNo === uid);
    check('未付款订单已清空', after.unpaid.length === 0);
    check('只产生 1 条权益', (await env.DB.prepare('SELECT COUNT(*) c FROM subscriptions').first()).c === 1);

    const again = await applyPaidOrder(env, afdian.orders[0], 'test');
    check('重复授予幂等（already）', again.ok && again.code === 'already', again);
}

console.log('\n[3] 叠加续费：从当前到期时间继续');
{
    const env = makeEnv();
    const uid = 'user-2';
    const o1 = await createPendingOrder(env, uid, 'k1', {});
    afdian.orders = [{ out_trade_no: 'ORD-A', custom_order_id: o1.customId, plan_id: 'plan-k1', month: 1, status: 2, total_amount: '9.90' }];
    await syncUserOrders(env, uid, { force: true });
    const s1 = await getSubscriptionState(env, uid);

    const o2 = await createPendingOrder(env, uid, 'k1', {});
    afdian.orders.push({ out_trade_no: 'ORD-B', custom_order_id: o2.customId, plan_id: 'plan-k1', month: 3, status: 2, total_amount: '25.00' });
    const sync = await syncUserOrders(env, uid, { force: true });
    check('第二笔核对成功', sync.code === 'synced', sync);

    const s2 = await getSubscriptionState(env, uid);
    const added = Math.round((s2.expireAt - s1.expireAt) / DAY_MS);
    check('在旧到期日上叠加 3 个月', added >= 88 && added <= 92, { added, from: isoDate(s1.expireAt), to: isoDate(s2.expireAt) });
    check('权益行数 = 2', (await env.DB.prepare('SELECT COUNT(*) c FROM subscriptions').first()).c === 2);
    check('activeGroups 分为 2 组', s2.activeGroups.length === 2, s2.activeGroups.length);
}

console.log('\n[4] 延迟激活：预约时间 / 手动激活');
{
    const env = makeEnv();
    const uid = 'user-3';
    const o1 = await createPendingOrder(env, uid, 'k1', {});
    afdian.orders = [{ out_trade_no: 'ORD-C', custom_order_id: o1.customId, plan_id: 'plan-k1', month: 1, status: 2 }];
    await syncUserOrders(env, uid, { force: true });
    const base = await getSubscriptionState(env, uid);

    const scheduleAt = base.expireAt;
    const o2 = await createPendingOrder(env, uid, 'k1', { activateMode: 'delayed', activateAt: scheduleAt });
    afdian.orders.push({ out_trade_no: 'ORD-D', custom_order_id: o2.customId, plan_id: 'plan-k1', month: 1, status: 2 });
    await syncUserOrders(env, uid, { force: true });

    const s = await getSubscriptionState(env, uid);
    check('延迟购买进入 pending（卡片显示已有未激活）', s.pending.length === 1, s.pending);
    check('pending 带套餐名', s.pending[0].planName.includes('科目一'), s.pending[0].planName);
    check('预约时间原样回传', s.pending[0].activateAt === scheduleAt, { got: s.pending[0].activateAt, want: scheduleAt });
    check('原有权益仍为 active', s.status === 'active', s.status);
    check('主卡片到期时间未变', s.expireAt === base.expireAt, { got: isoDate(s.expireAt), want: isoDate(base.expireAt) });

    const act = await activateGroup(env, uid, s.pending[0].groupId);
    check('手动立即激活成功', act.length === 1, act);
    const s2 = await getSubscriptionState(env, uid);
    check('激活后 pending 清空', s2.pending.length === 0);
    check('到期时间已顺延', s2.expireAt > base.expireAt, { from: isoDate(base.expireAt), to: isoDate(s2.expireAt) });

    const stolen = await activateGroup(env, 'attacker', s.pending.length ? s.pending[0].groupId : 'x');
    check('无法激活他人权益', stolen.length === 0, stolen);
}

console.log('\n[5] 定时任务：预约到点自动生效 + 过期标记');
{
    const env = makeEnv();
    const uid = 'user-4';
    const o1 = await createPendingOrder(env, uid, 'k1', { activateMode: 'delayed', activateAt: (nowSec() + 3600) * 1000 });
    afdian.orders = [{ out_trade_no: 'ORD-E', custom_order_id: o1.customId, plan_id: 'plan-k1', month: 1, status: 2 }];
    await syncUserOrders(env, uid, { force: true });
    let s = await getSubscriptionState(env, uid);
    check('预约未到时保持 pending', s.status === 'pending', s.status);
    check('预约未到时不会提前激活', s.pending.length === 1);

    env._sqlite.prepare('UPDATE subscriptions SET activate_at = ? WHERE user_id = ?').run(nowSec() - 5, uid);
    const sweep = await sweepAllOrders(env);
    check('定时任务激活了预约记录', sweep.activated >= 1, sweep);
    s = await getSubscriptionState(env, uid);
    check('预约到点后自动生效', s.status === 'active', s.status);

    env._sqlite.prepare('UPDATE subscriptions SET expire_at = ? WHERE user_id = ?').run(nowSec() - 10, uid);
    const sweep2 = await sweepAllOrders(env);
    check('定时任务标记过期', sweep2.expired >= 1, sweep2);
    s = await getSubscriptionState(env, uid);
    check('过期后 status=expired', s.status === 'expired', s.status);
}

console.log('\n[6] 组合套餐 科目一 + 科目二');
{
    const env = makeEnv();
    const uid = 'user-5';
    const o = await createPendingOrder(env, uid, 'k1k2', {});
    afdian.orders = [{ out_trade_no: 'ORD-F', custom_order_id: o.customId, plan_id: 'plan-k1k2', month: 6, status: 2, total_amount: '49.00' }];
    await syncUserOrders(env, uid, { force: true });
    const s = await getSubscriptionState(env, uid);
    check('两个科目都开通', !!s.subjects.k1 && !!s.subjects.k2, s.subjects);
    check('planKey=k1k2', s.planKey === 'k1k2', s.planKey);
    check('套餐名同时包含两个科目', s.planName.includes('科目一') && s.planName.includes('科目二'), s.planName);
    check('两科到期时间一致', s.subjects.k1 === s.subjects.k2);
    check('6 个月 ≈ 182 天', Math.abs(daysFromNow(s.expireAt) - 182) <= 4, daysFromNow(s.expireAt));

    const o2 = await createPendingOrder(env, uid, 'k2', {});
    afdian.orders.push({ out_trade_no: 'ORD-G', custom_order_id: o2.customId, plan_id: 'plan-k2', month: 1, status: 2 });
    await syncUserOrders(env, uid, { force: true });
    const s2 = await getSubscriptionState(env, uid);
    check('科目一到期时间不受影响', s2.subjects.k1 === s.subjects.k1);
    check('科目二到期 +1 个月', Math.round((s2.subjects.k2 - s.subjects.k2) / DAY_MS) >= 29, Math.round((s2.subjects.k2 - s.subjects.k2) / DAY_MS));
    check('主到期时间取较晚者', s2.expireAt === s2.subjects.k2);
}

console.log('\n[7] 异常分支：接口故障 / 未配置 / 手动绑定');
{
    const env = makeEnv();
    const uid = 'user-6';
    await createPendingOrder(env, uid, 'k1', {});

    afdian.mode = 'down';
    const sync = await syncUserOrders(env, uid, { force: true });
    check('网络故障返回 api_error', sync.ok === false && sync.code === 'api_error', sync);
    const s = await getSubscriptionState(env, uid);
    check('状态里带 lastError（驱动客服弹窗）', !!s.lastError && s.lastError.code === 'api_error', s.lastError);
    check('状态里带客服联系方式', s.support === '客服邮箱：help@example.com｜QQ：123456789', s.support);
    afdian.mode = 'ok';

    const env2 = makeEnv({ AFDIAN_USER_ID: '', AFDIAN_TOKEN: '' });
    await createPendingOrder(env2, 'user-7', 'k1', {});
    const sync2 = await syncUserOrders(env2, 'user-7', { force: true });
    check('未配置密钥返回 not_configured', sync2.code === 'not_configured', sync2);

    const env3 = makeEnv();
    const uid3 = 'user-8';
    await createPendingOrder(env3, uid3, 'k2', {});
    afdian.orders = [{ out_trade_no: 'ORDERMANUAL01', custom_order_id: '', plan_id: 'plan-k2', month: 1, status: 2 }];
    const bind = await bindOrderByNo(env3, uid3, 'ORDERMANUAL01');
    check('手动绑定订单号成功', bind.ok, bind);
    const s3 = await getSubscriptionState(env3, uid3);
    check('手动绑定后科目二已开通', !!s3.subjects.k2, s3.subjects);

    const bad = await bindOrderByNo(env3, uid3, 'nosuchorder1');
    check('不存在的订单号被拒', !bad.ok && bad.code === 'not_found', bad);
    const bad2 = await bindOrderByNo(env3, uid3, '!!');
    check('非法订单号被拒', !bad2.ok && bad2.code === 'bad_input', bad2);
}

console.log('\n[8] 安全：订单不可跨账号绑定');
{
    const env = makeEnv();
    const a = await createPendingOrder(env, 'user-A', 'k1', {});
    afdian.orders = [{ out_trade_no: 'ORD-A1', custom_order_id: a.customId, plan_id: 'plan-k1', month: 1, status: 2 }];
    await createPendingOrder(env, 'user-B', 'k1', {});
    const r = await bindOrderByNo(env, 'user-B', 'ORD-A1');
    check('他人已关联订单不可抢绑', !r.ok && r.code === 'belongs_to_other', r);

    const sync = await syncUserOrders(env, 'user-A', { force: true });
    check('原主仍能正常开通', sync.code === 'synced', sync);

    const r2 = await bindOrderByNo(env, 'user-B', 'ORD-A1');
    check('已开通订单不可重复绑定', !r2.ok, r2);
}

console.log('\n[9] 过期后重新购买');
{
    const env = makeEnv();
    const uid = 'user-9';
    const o = await createPendingOrder(env, uid, 'k1', {});
    afdian.orders = [{ out_trade_no: 'ORD-X', custom_order_id: o.customId, plan_id: 'plan-k1', month: 1, status: 2 }];
    await syncUserOrders(env, uid, { force: true });
    env._sqlite.prepare('UPDATE subscriptions SET expire_at = ? WHERE user_id = ?').run(nowSec() - 10, uid);
    const s = await getSubscriptionState(env, uid);
    check('过期后 status=expired', s.status === 'expired', s.status);
    check('历史记录保留 1 条', s.history.length === 1, s.history.length);

    const o2 = await createPendingOrder(env, uid, 'k1', {});
    afdian.orders.push({ out_trade_no: 'ORD-Y', custom_order_id: o2.customId, plan_id: 'plan-k1', month: 1, status: 2 });
    await syncUserOrders(env, uid, { force: true });
    const s2 = await getSubscriptionState(env, uid);
    check('重新购买立刻生效', s2.status === 'active', s2.status);
    check('从当前时间起算（不叠加已过期部分）', Math.abs(daysFromNow(s2.expireAt) - 30) <= 2, daysFromNow(s2.expireAt));
}

console.log('\n[10] 兜底匹配与节流');
{
    const env = makeEnv({ AFDIAN_FALLBACK_MATCH: '1' });
    const uid = 'user-10';
    await createPendingOrder(env, uid, 'k1', {});
    afdian.orders = [{ out_trade_no: 'ORD-NP', custom_order_id: '', plan_id: 'plan-k1', month: 1, status: 1 }];
    let sync = await syncUserOrders(env, uid, { force: true });
    check('未支付订单不授予', sync.code === 'not_found', sync);
    let s = await getSubscriptionState(env, uid);
    check('仍为 unpaid', s.status === 'unpaid', s.status);

    afdian.orders[0].status = 2;
    sync = await syncUserOrders(env, uid, { force: true });
    check('开启兜底时可按套餐匹配', sync.code === 'synced', sync);

    const env2 = makeEnv();
    await createPendingOrder(env2, 'u11', 'k1', {});
    afdian.orders = [{ out_trade_no: 'ORD-NF', custom_order_id: '', plan_id: 'plan-k1', month: 1, status: 2 }];
    const s2c = await syncUserOrders(env2, 'u11', { force: true });
    check('默认关闭兜底（避免误匹配）', s2c.code === 'not_found', s2c);

    const env3 = makeEnv();
    await createPendingOrder(env3, 'u12', 'k1', {});
    afdian.orders = [];
    await syncUserOrders(env3, 'u12', { force: true });
    const thr = await syncUserOrders(env3, 'u12', { force: false });
    check('20 秒内重复查询被节流', thr.code === 'throttled', thr);
    const none = await syncUserOrders(env3, 'nobody', { force: true });
    check('无待支付订单返回 nothing_pending', none.code === 'nothing_pending', none);
}

process.exit(summary() ? 1 : 0);
