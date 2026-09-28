# 订阅会员系统（爱发电 · 开放 API 查询开通）

> 本文档对应「我的」页会员卡 + 三个题库套餐 + 自动开通 + 延迟激活 + 叠加续费的完整实现。

## 1. 设计要点

| 项 | 方案 |
| --- | --- |
| 开通方式 | **爱发电开放平台 API 主动查询订单**（`POST /api/open/query-order`），**不使用 webhook** |
| 订单归属 | 下单链接里带 `custom_order_id`（同时写入 `remark`），订单查询结果原样回传该字段 |
| 权益模型 | `subscriptions` 一行 = 一个科目的一条权益（`k1` / `k2`），同笔订单多行用 `group_id` 关联 |
| 到期时间 | 以爱发电返回的 `month`（购买月数）为准，按自然月叠加 |
| 叠加规则 | 同一科目再次购买时，从**该科目当前到期时间**继续往后加，不会浪费剩余时长 |
| 延迟激活 | 付款后权益先落库为 `pending`（未激活），卡片显示「已有未激活」，由用户自行选择时机激活 |
| 幂等 | `subscriptions(afdian_order, subject)` 唯一索引，同一订单只授予一次 |
| 自动开通 | 三条触发路径：前端轮询 / 用户打开 App 时的节流核对 / 定时任务每 15 分钟全量核对 |

### 为什么不用 webhook

- webhook 需要暴露公网回调地址、校验签名，且一旦回调丢失就无法补单；
- 主动查询是**权威数据源**，天然可重试、可补单，也不存在伪造回调骗开会员的风险。

## 2. 一次性配置

### 2.1 写入密钥（不要写进 wrangler.toml）

```bash
# 爱发电开发者后台 https://afdian.com/dashboard/dev 获取
npx wrangler secret put AFDIAN_USER_ID
npx wrangler secret put AFDIAN_TOKEN

# 若之前把 PASSWORD_PEPPER 写在 [vars] 里，请改成本方式
npx wrangler secret put PASSWORD_PEPPER
```

> ⚠️ 已从 `wrangler.toml` 的 `[vars]` 中移除 `AFDIAN_USER_ID / AFDIAN_TOKEN / PASSWORD_PEPPER`，
> 避免明文变量覆盖同名 secret。

### 2.2 更新数据库

```bash
# 新库
npm run db:init

# 已有旧库（订阅功能尚未上线时用这条，只需跑一次）
npm run db:migrate
```

### 2.3 按需调整 `wrangler.toml`

```toml
[vars]
AFDIAN_ORDER_HOST = "https://ifdian.net"   # 用户点「去爱发电支付」跳转的站点
AFDIAN_FALLBACK_MATCH = "0"                # 兜底匹配，默认关闭（详见 §6）

PLAN_K1   = "3b49790abaf411f1a7af52540025c377"   # 科目一必做题库
PLAN_K2   = "3c128840baf411f1a55652540025c377"   # 科目二必做题库
PLAN_K1K2 = "3cb96e6cbaf411f1819a52540025c377"   # 科目一 + 科目二必做题库

SUPPORT_CONTACT = "客服邮箱：xxx@example.com｜QQ：123456789"
```

```toml
[triggers]
# 免费版每个「账号」只有 5 个 cron 名额，所以这里只占用 1 个：
#   */15 * * * *  每 15 分钟核对订单 / 标记过期，
#                 并在每天 UTC 03:00 那一次顺带做数据清理。
crons = ["*/15 * * * *"]
```

> 如果你连这 1 个名额也不想占用，可以直接删掉 `[triggers]` 段：
> App 依旧可用（用户每次打开「我的」页都会触发一次节流核对），
> 只是未登录用户不会被自动补单，要等用户下次打开 App 触发核对。

### 2.4 部署

```bash
npm run deploy
npm run logs        # 观察 "Subscription sweep" 日志
```

## 3. 开通流程

```
用户点「续约 / 叠加套餐」
   │
   ├─ POST /api/subscription/create { plan, activateMode }
   │     └─ 生成 customId = TK-XXXXXXXXXXXX
   │        写 pending_orders，返回下单链接：
   │        https://ifdian.net/order/create?plan_id=<套餐>&product_type=0
   │               &custom_order_id=TK-XXXX...&month=1&remark=TK-XXXX...
   │
   ├─ 新标签打开该链接，用户在爱发电完成支付
   │
   └─ 自动开通（三条并行路径）
        ① 前端每 8 秒 POST /api/subscription/check（最多约 4 分钟）
        ② 用户打开「我的」页 → GET /api/subscription/state（20 秒节流）
        ③ Cloudflare 定时任务 */15 * * * * → sweepAllOrders
              │
              └─ query-order 命中 custom_order_id 且 status=2
                   └─ 写入 subscriptions（幂等）+ 按激活方式生效
```

## 4. 订阅规则

### 叠加

```
已有 科目一 到期 2026-06-01
再买 科目一 3 个月  →  到期 2026-09-01
再买 科目一+科目二 1 个月
    科目一：从 2026-09-01 起算 → 2026-10-01
    科目二：从当前（无权益）起算 → 今天 + 1 个月
```

即**按科目各自累计**，组合套餐会分别计算两个科目的到期时间，卡片会在两科到期日不同时给出明细。

### 激活方式

| 方式 | 行为 |
| --- | --- |
| 立即激活（默认） | 付款后立刻生效；若当前未到期则自动从到期日顺延 |
| 延迟激活 | 付款后保持「未激活」，用户在卡片下方点「激活」自行决定生效时机 |

激活时的起算点 = `max(当前时间, 该科目已有到期时间)`，保证**永远不会吞掉用户已付费的时长**。

### 删除未支付的订单

用户在「待支付订单」里可以点「删除订单」。实现上是**软删除**（`pending_orders.status = 'canceled'`）：

- 列表与 `/state` 只展示 `status = 'pending'`，用户看到的效果就是删掉了；
- 但被删掉的订单在 **3 天内**仍会参与订单核对——如果用户其实已经付过款，
  系统照样会凭 `custom_order_id` 精确关联并自动开通，不会出现「付了钱却没开通」；
- 被删掉的订单**不参与**按套餐的兜底匹配（避免把别人的订单误开给这个账号）。

### 过期

`expire_at <= now` 的权益由定时任务与状态查询标记为 `expired`；过期后重新购买从当前时间起算。

## 5. 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/subscription/plans` | 套餐目录（不返回 plan_id） |
| POST | `/api/subscription/create` | 生成待支付订单 + 下单链接 |
| GET | `/api/subscription/state` | 当前订阅状态（含节流核对） |
| POST | `/api/subscription/check` | 立即向爱发电核对订单 |
| POST | `/api/subscription/activate` | 激活一笔未激活权益 |
| POST | `/api/subscription/cancel` | 删除一笔未支付的待支付订单 |
| POST | `/api/subscription/bind` | 用爱发电订单号手动绑定（兜底） |

全部需要登录（`__Host-session` Cookie），并受 `SUB_RATE_LIMITER`（若绑定）限流。

`state` 对象关键字段：

```jsonc
{
  "status": "active | pending | unpaid | expired | inactive",
  "planKey": "k1k2", "planName": "科目一 + 科目二必做题库",
  "subjects": { "k1": 1767225600000, "k2": 1764547200000 },
  "expireAt": 1767225600000, "daysLeft": 45,
  "memberNo": "<用户 id>",
  "pending":  [ /* 已付款未激活 */ ],
  "unpaid":   [ /* 已下单未付款，含继续支付 url */ ],
  "activeGroups": [ /* 生效中的购买批次 */ ],
  "history":  [ /* 已结束 */ ],
  "lastError": { "code": "api_error", "message": "...", "at": 1764... },
  "support": "客服邮箱：..."
}
```

## 6. 失败与兜底

| 情况 | 表现 | 兜底 |
| --- | --- | --- |
| 爱发电接口超时/不可达 | `check` 返回 `ok:false, code:api_error`；状态里带 `lastError` | 「我的」页弹客服窗，展示**会员编号 + 客服联系方式 + 一键复制**；定时任务会持续重试 |
| 服务端未配置密钥 | `code:not_configured` | 同上，提示联系客服人工开通 |
| 订单没有关联码（用户直接在爱发电页面购买） | `code:unlinked` | 用户在客服窗贴入**爱发电订单号**手动绑定 |
| 用户改掉了备注 | `custom_order_id` 仍然有效，不受影响 | — |
| `custom_order_id` 未生效（极端情况） | 默认不会误匹配 | 把 `AFDIAN_FALLBACK_MATCH` 设为 `"1"` 启用「同套餐 + 时间接近」兜底匹配（**可能误匹配他人订单，请谨慎**），或让用户手动绑定 |

> 手动绑定会校验：订单必须已支付、不得已被他人账号占用、且当前账号存在同套餐的待支付订单。

## 7. 运维

```bash
# 查看待处理订单
npx wrangler d1 execute quiz-db --remote --command "SELECT custom_id,user_id,plan_key,status,check_count,last_error,datetime(created_at,'unixepoch') FROM pending_orders ORDER BY created_at DESC LIMIT 20"

# 查看权益
npx wrangler d1 execute quiz-db --remote --command "SELECT user_id,subject,status,datetime(expire_at,'unixepoch') FROM subscriptions ORDER BY created_at DESC LIMIT 20"

# 手工补单（把 custom_id 换成实际值；用户已付款但自动开通失败时使用）
npx wrangler d1 execute quiz-db --remote --command "SELECT afdian_order FROM pending_orders WHERE custom_id='TK-XXXXXXXXXXXX'"

# 事件审计
npx wrangler d1 execute quiz-db --remote --command "SELECT * FROM sub_events ORDER BY id DESC LIMIT 50"
```

人工开通某用户某科目 N 天（应急）：

```sql
INSERT INTO subscriptions
  (id,user_id,group_id,subject,plan_key,plan_name,months,status,start_at,expire_at,
   activate_mode,activated_at,source,created_at,updated_at)
VALUES
  (lower(hex(randomblob(16))), '<用户id>', 'manual-' || strftime('%s','now'), 'k1',
   'k1','人工开通', 1, 'active', strftime('%s','now'), strftime('%s','now') + 86400*30,
   'immediate', strftime('%s','now'), 'manual', strftime('%s','now'), strftime('%s','now'));
```

## 8. 前端
- **未登录进不去**：全屏启动层（`#authGate`）先校验会话，未登录时展示登录 / 注册表单，登录成功后才收起并淡入 App。
  动画参考 `参考文件.html`：logo 居中浮现 → 整组上移 → 表单字段自下而上依次升起。
- 「我的」页在用户信息下方渲染 **银行卡样式会员卡**：
  - 会员生效中 → **金卡**（金色渐变 + 拉丝金属质感 + 银色芯片 + 深色文字 + 绿色状态胶囊）；
  - 已购未激活 / 待支付 / 已过期 → 古铜 / 蓝 / 灰三档配色，一眼区分状态。
  - 3D 鼠标悬浮（`perspective` + `rotateX/rotateY` + 动态高光 + 扫光），展示**套餐状态 / 有效期至 / 会员编号（账号 id，可点击复制）/ 持卡人**。
- 卡下方分区展示：**待激活权益**（点「激活」按钮 + 二次确认）、**待支付订单**（继续支付 / 删除订单 / 我已支付立即检查）、**会员服务**（购买入口）、**历史记录**。
- 购买弹窗：选套餐 → 选激活方式（立即激活 / 延迟激活）→ 跳转爱发电 → 「等待支付结果」界面轮询，成功后自动切换到「开通成功」。
- 触屏设备与 `prefers-reduced-motion` 下自动关闭 3D 动效。

## 9. 自动化测试

```bash
npm test
```

需要 Node >= 22.5（用到内置的 `node:sqlite` 作为 D1 垫片，无需安装任何依赖）。

| 文件 | 覆盖内容 | 断言数 |
| --- | --- | --- |
| `tests/pepper.test.mjs` | 密码胡椒归一化、哈希格式、随机盐 | 8 |
| `tests/migrate.test.mjs` | 旧库 → 新结构迁移、唯一索引、schema 与 migrate 结构一致 | 29 |
| `tests/subscription.test.mjs` | 签名公式、下单链接、立即/延迟激活、叠加、组合套餐、过期、删除订单、定时任务、异常分支、越权防护 | 78 |
| `tests/http.test.mjs` | Worker 全部路由、鉴权、状态码、安全头、删除订单、单触发器定时任务（含每日清理门控） | 60 |

测试用 `node:sqlite` 跑真实 SQL，并把爱发电开放接口打桩，因此不需要任何外部依赖或真实密钥。

## 10. 手工验收清单

1. 用测试账号点「立即开通」→ 选科目一 → 支付 → 回到 App，卡片应在 30 秒内变为「生效中」。
2. 再买一次科目一，确认到期日**顺延**而不是覆盖。
3. 买「科目一+科目二」，确认两科各自到期时间正确。
4. 选「延迟激活 · 暂不指定」，付款后卡片显示「待激活」，点「激活」→ 立即生效。
5. 断开网络后点「我已支付，立即检查」，应弹出带**会员编号 + 客服联系方式**的客服窗。
6. 在客服窗粘贴爱发电订单号手动绑定。

## 11. 注意事项

- `PASSWORD_PEPPER` 一旦配置请勿再修改，否则所有历史密码哈希失效（用户需重置密码）。
  未配置时会退回内置默认胡椒，注册/登录仍可正常工作。
- 旧的 `src/md5.js` 实现有误（轮函数漏加了 `a` 项，且使用了 Workers 不提供的 `unescape`），
  会导致爱发电签名永远校验失败，本次已重写并通过标准测试向量 + Node crypto 交叉校验。
- `subscriptions` / `pending_orders` 表结构相对旧版有变化，旧库务必执行 `npm run db:migrate`。
