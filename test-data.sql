-- ============================================================================
-- 订阅功能联调脚本（手动改库，不需要真的付款）
-- ----------------------------------------------------------------------------
-- 用法：
--   1. 把下面每一段里的  'you@example.com'  改成你自己的注册邮箱（只改这一处）
--   2. 远程库：npm run db:test
--      本地库：npm run db:test:local
--      或单段执行：
--      npx wrangler d1 execute quiz-db --remote --file=./test-data.sql
--
-- 注意：
--   · 这些命令会直接改线上 D1，测试数据都用 source='manual_sql' / TK-TEST 前缀标记，
--     跑第 9 段即可一键清干净；
--   · 时间戳都是 unix 秒，用 strftime('%s','now','+45 days') 现算，不用手填。
--
-- 这个脚本能测什么：
--   ✅ 卡片四种状态（金卡生效中 / 待激活 / 待支付 / 已过期）
--   ✅ 科目一、科目二、组合套餐的展示与到期时间
--   ✅ 叠加续费、延迟激活、异常提示
--   ✅ 「继续支付」「删除订单」「激活」按钮
--   ❌ 测不了「爱发电付款 → 后台自动开通」的真实链路（那一段必须真去付一次款，
--      因为服务端只会拿 query-order 的返回结果说话，见文末说明）
-- ============================================================================


-- ============================================================================
-- 0. 先看看现状（不改数据）
-- ============================================================================
-- 我的账号 id
SELECT id, email, nickname FROM users ORDER BY created_at DESC LIMIT 10;

-- 我的订阅权益
SELECT u.email, s.subject, s.status, s.plan_key,
       datetime(s.start_at ,'unixepoch','localtime') AS start_at,
       datetime(s.expire_at,'unixepoch','localtime') AS expire_at,
       s.afdian_order, s.source
FROM subscriptions s JOIN users u ON u.id = s.user_id
ORDER BY s.created_at DESC LIMIT 20;

-- 我的待支付 / 已删除订单
SELECT u.email, p.custom_id, p.plan_key, p.status, p.activate_mode,
       datetime(p.created_at,'unixepoch','localtime') AS created_at,
       p.last_error
FROM pending_orders p JOIN users u ON u.id = p.user_id
ORDER BY p.created_at DESC LIMIT 20;


-- ============================================================================
-- 1.【最常用】开通「科目一 + 科目二」，45 天后到期 → 卡片变金卡
-- ============================================================================
DELETE FROM subscriptions WHERE source = 'manual_sql' AND id LIKE 'test-%';

INSERT INTO subscriptions
  (id, user_id, group_id, subject, plan_key, plan_name, months, status,
   start_at, expire_at, activate_mode, activated_at,
   afdian_order, afdian_plan_id, amount, source, created_at, updated_at)
SELECT 'test-g1-k1', id, 'test-g1', 'k1', 'k1k2', '科目一 + 科目二必做题库', 2, 'active',
       CAST(strftime('%s','now') AS INTEGER),
       CAST(strftime('%s','now','+45 days') AS INTEGER),
       'immediate', CAST(strftime('%s','now') AS INTEGER),
       'TEST-ORDER-G1', 'test-plan-k1k2', '0.00', 'manual_sql',
       CAST(strftime('%s','now') AS INTEGER), CAST(strftime('%s','now') AS INTEGER)
FROM users WHERE email = 'you@example.com';

INSERT INTO subscriptions
  (id, user_id, group_id, subject, plan_key, plan_name, months, status,
   start_at, expire_at, activate_mode, activated_at,
   afdian_order, afdian_plan_id, amount, source, created_at, updated_at)
SELECT 'test-g1-k2', id, 'test-g1', 'k2', 'k1k2', '科目一 + 科目二必做题库', 2, 'active',
       CAST(strftime('%s','now') AS INTEGER),
       CAST(strftime('%s','now','+45 days') AS INTEGER),
       'immediate', CAST(strftime('%s','now') AS INTEGER),
       'TEST-ORDER-G1', 'test-plan-k1k2', '0.00', 'manual_sql',
       CAST(strftime('%s','now') AS INTEGER), CAST(strftime('%s','now') AS INTEGER)
FROM users WHERE email = 'you@example.com';

-- 验证：应该看到 2 行 (k1, k2)，都是 active
SELECT u.email, s.subject, s.status, datetime(s.expire_at,'unixepoch','localtime') AS expire_at
FROM subscriptions s JOIN users u ON u.id = s.user_id
WHERE s.source = 'manual_sql';


-- ============================================================================
-- 2. 只开通「科目一」，7 天后到期（卡片为金色，快到期）
-- ============================================================================
-- 先清掉第 1 段的结果
DELETE FROM subscriptions WHERE source = 'manual_sql' AND id LIKE 'test-%';

INSERT INTO subscriptions
  (id, user_id, group_id, subject, plan_key, plan_name, months, status,
   start_at, expire_at, activate_mode, activated_at,
   afdian_order, afdian_plan_id, amount, source, created_at, updated_at)
SELECT 'test-k1-a', id, 'test-g2', 'k1', 'k1', '科目一必做题库', 1, 'active',
       CAST(strftime('%s','now') AS INTEGER),
       CAST(strftime('%s','now','+7 days') AS INTEGER),
       'immediate', CAST(strftime('%s','now') AS INTEGER),
       'TEST-ORDER-G2', 'test-plan-k1', '0.00', 'manual_sql',
       CAST(strftime('%s','now') AS INTEGER), CAST(strftime('%s','now') AS INTEGER)
FROM users WHERE email = 'you@example.com';


-- ============================================================================
-- 3. 模拟「已购买但未激活」（卡片：待激活；下方出现「激活」按钮）
-- ============================================================================
-- 先来一条生效中的科目一，方便验证激活后的「顺延叠加」
DELETE FROM subscriptions WHERE source = 'manual_sql' AND id LIKE 'test-%';

INSERT INTO subscriptions
  (id, user_id, group_id, subject, plan_key, plan_name, months, status,
   start_at, expire_at, activate_mode, activated_at,
   afdian_order, afdian_plan_id, amount, source, created_at, updated_at)
SELECT 'test-k1-a', id, 'test-g3a', 'k1', 'k1', '科目一必做题库', 1, 'active',
       CAST(strftime('%s','now') AS INTEGER),
       CAST(strftime('%s','now','+20 days') AS INTEGER),
       'immediate', CAST(strftime('%s','now') AS INTEGER),
       'TEST-ORDER-G3A', 'test-plan-k1', '0.00', 'manual_sql',
       CAST(strftime('%s','now') AS INTEGER), CAST(strftime('%s','now') AS INTEGER)
FROM users WHERE email = 'you@example.com';

-- 再来一条已购买、未激活的科目一（3 个月）
INSERT INTO subscriptions
  (id, user_id, group_id, subject, plan_key, plan_name, months, status,
   start_at, expire_at, activate_mode, activated_at,
   afdian_order, afdian_plan_id, amount, source, created_at, updated_at)
SELECT 'test-k1-b', id, 'test-g3b', 'k1', 'k1', '科目一必做题库', 3, 'pending',
       0, 0, 'delayed', NULL,
       'TEST-ORDER-G3B', 'test-plan-k1', '0.00', 'manual_sql',
       CAST(strftime('%s','now') AS INTEGER), CAST(strftime('%s','now') AS INTEGER)
FROM users WHERE email = 'you@example.com';

-- 点「激活」后，这一行应该变成 active，且 expire_at ≈ 现在 + 20 天 + 3 个月
-- （引擎从「该科目已有到期时间」往后叠加，不会覆盖）


-- ============================================================================
-- 4. 模拟「待支付订单」（下方出现「继续支付 / 删除订单」按钮）
-- ============================================================================
-- 删掉旧的测试订单
DELETE FROM pending_orders WHERE custom_id LIKE 'TK-TEST%';

INSERT INTO pending_orders
  (custom_id, user_id, plan_key, plan_id, months, activate_mode,
   status, check_count, created_at, updated_at)
SELECT 'TK-TEST000001', id, 'k1', 'test-plan-k1', 1, 'immediate',
       'pending', 0,
       CAST(strftime('%s','now') AS INTEGER), CAST(strftime('%s','now') AS INTEGER)
FROM users WHERE email = 'you@example.com';

INSERT INTO pending_orders
  (custom_id, user_id, plan_key, plan_id, months, activate_mode,
   status, check_count, created_at, updated_at)
SELECT 'TK-TEST000002', id, 'k1k2', 'test-plan-k1k2', 1, 'delayed',
       'pending', 0,
       CAST(strftime('%s','now') AS INTEGER), CAST(strftime('%s','now') AS INTEGER)
FROM users WHERE email = 'you@example.com';

-- 验证
SELECT u.email, p.custom_id, p.plan_key, p.status, p.activate_mode
FROM pending_orders p JOIN users u ON u.id = p.user_id
WHERE p.custom_id LIKE 'TK-TEST%';

-- 【可选】给待支付订单塞一条失败原因，用来测「自动开通失败 → 弹客服窗」
UPDATE pending_orders
   SET last_error = 'api_error:network unreachable',
       last_check_at = CAST(strftime('%s','now') AS INTEGER)
 WHERE custom_id = 'TK-TEST000001';


-- ============================================================================
-- 5. 测「叠加续费」：在金卡基础上再加 1 个月，到期日应往后顺延
-- ============================================================================
-- 先跑第 1 段（开通 45 天），记下到期日，再执行下面这段：
INSERT INTO subscriptions
  (id, user_id, group_id, subject, plan_key, plan_name, months, status,
   start_at, expire_at, activate_mode, activated_at,
   afdian_order, afdian_plan_id, amount, source, created_at, updated_at)
SELECT 'test-add-k1', id, 'test-add-k1k2', 'k1', 'k1', '科目一必做题库', 1, 'active',
       CAST(strftime('%s','now') AS INTEGER),
       CAST(strftime('%s','now','+30 days') AS INTEGER),
       'immediate', CAST(strftime('%s','now') AS INTEGER),
       'TEST-ORDER-ADD1', 'test-plan-k1', '0.00', 'manual_sql',
       CAST(strftime('%s','now') AS INTEGER), CAST(strftime('%s','now') AS INTEGER)
FROM users WHERE email = 'you@example.com';

-- 因为已经有 45 天的权益，这行会在「从今天算起」和「从 45 天后算起」里取较晚者，
-- 所以卡片的到期时间应该基本不变（这正是「不会吞掉已付费时长」的效果）。
-- 想直观看顺延，请用第 2 段（7 天）+ 本段，到期日会从 7 天变成 ~37 天。


-- ============================================================================
-- 6. 测「已过期」状态（卡片变灰，显示「已过期」）
-- ============================================================================
DELETE FROM subscriptions WHERE source = 'manual_sql' AND id LIKE 'test-%';

INSERT INTO subscriptions
  (id, user_id, group_id, subject, plan_key, plan_name, months, status,
   start_at, expire_at, activate_mode, activated_at,
   afdian_order, afdian_plan_id, amount, source, created_at, updated_at)
SELECT 'test-exp-k1', id, 'test-exp', 'k1', 'k1', '科目一必做题库', 1, 'active',
       CAST(strftime('%s','now','-60 days') AS INTEGER),
       CAST(strftime('%s','now','-30 days') AS INTEGER),
       'immediate', CAST(strftime('%s','now','-60 days') AS INTEGER),
       'TEST-ORDER-EXP', 'test-plan-k1', '0.00', 'manual_sql',
       CAST(strftime('%s','now','-60 days') AS INTEGER), CAST(strftime('%s','now') AS INTEGER)
FROM users WHERE email = 'you@example.com';
-- 打开「我的」页时会自动被标记为 expired，并进入「历史记录」。


-- ============================================================================
-- 7. 把某条权益的到期时间直接改掉（最省事的调试手段）
-- ============================================================================
-- 改成 3 天后到期
-- UPDATE subscriptions SET expire_at = CAST(strftime('%s','now','+3 days') AS INTEGER)
--  WHERE source = 'manual_sql';

-- 改成已经过期
-- UPDATE subscriptions SET expire_at = CAST(strftime('%s','now','-1 day') AS INTEGER)
--  WHERE source = 'manual_sql';

-- 把已过期的重新激活
-- UPDATE subscriptions SET status = 'active',
--        expire_at = CAST(strftime('%s','now','+30 days') AS INTEGER)
--  WHERE source = 'manual_sql';


-- ============================================================================
-- 8. 模拟「付款成功」的落库结果（等价于引擎跑完 applyPaidOrder 之后的状态）
-- ----------------------------------------------------------------------------
-- 如果你已经在 UI 上点过「购买」拿到了一张待支付订单，可以执行下面这段：
-- 它把该订单标记为已支付，并按订单里的科目 / 月数写出对应的权益行，
-- 效果和真实付款后由 /api/subscription/check 自动开通完全一致。
-- ============================================================================
-- ① 先看有哪些待支付订单，挑一个 custom_id
SELECT p.custom_id, p.plan_key, p.months, p.activate_mode, u.email
FROM pending_orders p JOIN users u ON u.id = p.user_id
WHERE p.status = 'pending' ORDER BY p.created_at DESC LIMIT 10;

-- ② 把 'TK-XXXXXXXXXXXX' 换成上一步查到的 custom_id，然后执行：
--    —— 科目一（k1）
-- INSERT INTO subscriptions
--   (id, user_id, group_id, subject, plan_key, plan_name, months, status,
--    start_at, expire_at, activate_mode, activated_at,
--    afdian_order, afdian_plan_id, amount, source, created_at, updated_at)
-- SELECT 'test-pay-k1', p.user_id, p.custom_id, 'k1', 'k1', '科目一必做题库', p.months,
--        CASE WHEN p.activate_mode = 'delayed' THEN 'pending' ELSE 'active' END,
--        CASE WHEN p.activate_mode = 'delayed' THEN 0 ELSE CAST(strftime('%s','now') AS INTEGER) END,
--        CASE WHEN p.activate_mode = 'delayed' THEN 0
--             ELSE CAST(strftime('%s','now','+' || p.months || ' months') AS INTEGER) END,
--        p.activate_mode,
--        CASE WHEN p.activate_mode = 'delayed' THEN NULL ELSE CAST(strftime('%s','now') AS INTEGER) END,
--        'TEST-PAID-' || p.custom_id, 'test-plan-k1', '0.00', 'manual_sql',
--        CAST(strftime('%s','now') AS INTEGER), CAST(strftime('%s','now') AS INTEGER)
-- FROM pending_orders p WHERE p.custom_id = 'TK-XXXXXXXXXXXX';
--
--    —— 科目二（k2）同理，把上面的 'k1' 换成 'k2'、id 换成 'test-pay-k2'
--    —— 组合套餐（k1k2）就把上面整段复制两份，subject 分别写 k1 / k2
--
-- ③ 订单收尾（不写这一步，UI 会一直显示「待支付」）
-- UPDATE pending_orders SET status = 'done',
--        afdian_order = 'TEST-PAID-' || custom_id,
--        updated_at = CAST(strftime('%s','now') AS INTEGER)
--  WHERE custom_id = 'TK-XXXXXXXXXXXX';


-- ============================================================================
-- 9. 一键清空所有测试数据
-- ============================================================================
-- DELETE FROM subscriptions  WHERE source = 'manual_sql';
-- DELETE FROM pending_orders WHERE custom_id LIKE 'TK-TEST%';
-- DELETE FROM sub_events     WHERE kind IN ('create_order','cancel_order','activate','grant','grant_pending')
--                              AND created_at > CAST(strftime('%s','now','-1 day') AS INTEGER);


-- ============================================================================
-- 附：真实链路怎么测
-- ----------------------------------------------------------------------------
-- 「爱发电付款 → 服务端 query-order 核对 → 自动开通」这一段无法用 SQL 伪造，
-- 因为服务端只认爱发电接口返回的数据。想验证它，最省事的做法是：
--   ① 用你自己的爱发电账号，买一次你自己最便宜的那个方案（或在爱发电后台
--      「开发者」里做一个 0.01 元的测试方案，把 PLAN_K1 临时指过去）；
--   ② 付款后回到 App，「我的」页会自动核对，30 秒内卡片应该变成金卡；
--   ③ 想确认服务端真的在查，看日志：
--      npm run logs       # 搜 "Subscription sweep"
--   ④ 也可以点「我已支付，立即检查」强制立刻核对一次。
-- ============================================================================
