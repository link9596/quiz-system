# 云端同步说明

> 做题记录、收藏、错题连对次数、题库进度、模考记录怎么上云、怎么下发。
>
> 全库共 7 张表：`users`（账号 + 登录风控 + 同步游标 + 未完成考试）、
> `sessions`、`q_state`、`b_meta`、`mock_log`、`subscriptions`、`pending_orders`。

## 数据落在哪张表

同步相关的数据只涉及 4 张表（全库共 7 张）：

| 数据 | 存放位置 | 为什么 |
| --- | --- | --- |
| 同步游标 | `users.sync_ver` | 一行/用户，只按 id 访问 |
| 题库进度 | `b_meta` 表 | 一行 = 用户 × 题库，**基数随题库数量增长**，必须独立成表 |
| 未完成考试 | `users.exam_data` / `exam_ver` | 一行/用户 |
| 每题作答/收藏/连错 | `q_state` 表 | 多行/用户，**每行带 ver 做增量同步**，合不进 users |
| 模考记录 | `mock_log` 表 | 同上 |

`b_meta` 的 `(uid, bid)` 是主键，写入是 PK upsert，可以用 `idx_b_meta_bid` 按题库做批量操作
（例如题库改版后统一重置所有人的进度），也不会让 `users` 行随着题库变多而变胖。

## 一次同步请求做两件事

`POST /api/sync` 同时完成**推送**和**下拉**：

```jsonc
// 请求
{
  "changes": [ { "type": "q_state", "payload": {...}, "ts": 1700000000000 } ],
  "since": 42              // 上次同步到的版本号，首次为 0
}

// 响应
{
  "ok": true,
  "serverVer": 57,         // 本次推送后用户的最新版本号
  "q": [ { "bid", "qid", "st", "ans", "fav", "streak" } ],   // 答题 / 收藏 / 连错
  "m": [ { "id", "score", "passed", "correct", "wrong", "unanswered", "total", "dur", "ts" } ], // 模考记录
  "k": [ { "bid", "cur_idx" } ]                              // 题库进度
}
```

> ⚠️ **字段契约**：`m` 是模考记录（`mock_log` 表），`k` 是题库进度（`b_meta` 表）。
> 后端早期版本把这两个字段接反了（`m` 发的是进度、`k` 发的是模考），
> 因为当时前端完全不读响应体所以一直没暴露；实现下拉后会导致**两边都合并不进去**。
> 改动时请务必保持这个契约，`tests/sync.test.mjs` 有断言守着。

## 版本号（增量同步）

- 每次同步都会把 `users.sync_ver` 自增，作为本次分配到的版本号；
- 写入的每一行都带上当前版本号；
- 下拉时 `WHERE ver > since`，只取增量；
- 前端把 `serverVer` 存进 `localStorage`（`quiz_sync_ver_v1:<userId>`，**按账号隔离**），下次带去当 `since`。

因此第二次同步不会重复下发，换设备第一次同步（`since = 0`）才会拿到全量。

## 变更类型

| type | payload | 说明 |
| --- | --- | --- |
| `q_state` | `{bankId, qIdx, status:'correct'\|'wrong'\|null, userAnswer, wrongStreak}` | 答题结果 |
| `q_delete` | `{bankId, qIdx}` | 删除某题的作答记录 |
| `fav` | `{bankId, qIdx, action:'add'\|'remove'}` | 收藏 |
| `bank_current` | `{bankId, currentIndex}` | 刷题进度 |
| `bank_reset` | `{bankId}` | 重置某个题库 |
| `reset_all` | `{}` | 清空全部记录 |
| `mock_add` | `{ts, score, passed, correct, wrong, unanswered, total, duration, answers}` | 完成一次模考 |
| `exam_state` | 未完成考试快照（见下） | 模考进度跨设备续考；`{cleared:true}` 表示交卷/清除 |

## 前端 outbox

本地变更先写进 `localStorage.quiz_sync_outbox`，再由以下时机上传：

- 任意变更后 **5 秒防抖**；
- 页面切到后台（`visibilitychange`）——用 `keepalive` 发，手机上切走也不丢；
- 关页面前（`beforeunload`）——同样用 `keepalive` 尽力发出去；
- 网络恢复（`online`）、点顶栏的同步按钮、**登录成功后**。

每条 outbox 记录带一个 `owner`（账号 id，未登录时为 `null`）：

- `owner` 与当前账号不一致 → **整批丢弃**，绝不把 A 的数据推到 B 名下；
- `owner` 为 `null`（登录前攒的）→ 由当前账号认领后上传。

## 模考进度跨设备续考

模考中途换设备 / 刷新页面不丢进度：

- **本地**：每次作答、标记、每 30 秒、切换后台、关闭页面时都会写 `quiz_unfinished_exam`；
- **云端**：每答 **2 题**、或距上次推送超过 30 秒、或退出/交卷时推一次；
  交卷时推 `{cleared:true}`，服务端删除快照；
- **换设备**：同步拉回 `e` 字段后，把快照写进本地，用户点「开始模考」就会弹出「恢复考试」。

### 为什么云端快照不带题目正文

一个 80 题的模考快照连题目正文要上百 KB，而 **D1 单条 SQL 语句有 100 KB 上限**，
直接塞进去有写入失败的风险。所以上传时只保留题目引用：

```jsonc
// 上传（约 1 KB）
{ "ts": 1700000000000, "keyVer": 2, "refs": [["k2-feiji", 12], ["k2-xingneng", 3], ...],
  "examAnswers": { "k2-feiji#12": "A" }, "examTimeLeft": 5000, ... }

// 拉回后按 refs 从静态题库 JSON 重新取回题目正文（fromCloudExamSnapshot）
```

> 还原时必须给题目补上 `_bankId`，否则 `examKey` 会退化成「只用 _idx」，
> 模考又会串题（见下面那条）。

## 模考答题键（`examKey`）

`state.examAnswers / examMarked / examOptionOrder / sessionAnswers` 一律用
**`题库id + '#' + 题库内下标`** 作键，不能用 `q._idx` 单独作键 ——
`_idx` 是题库内下标，每个题库都从 0 开始，智能模考会混 3 个题库的题，
只按 `_idx` 存会导致：

- 答了 A 题库第 5 题，B 题库第 5 题也显示成已作答（"混入已选过选项的题"）；
- 答题卡统计少算（80 题只有 78 个不同的键 → 显示 78/80）。

快照带 `keyVer`，格式变更时旧快照会被自动丢弃，不会错乱。

## 模考记录详情的懒加载

## 模考记录详情的懒加载

`m` 只返回概览（不含答题详情）。点开某次模考时，如果本地没有 `answers`，
前端会用 `serverId` 去 `GET /api/mock/detail?id=` 拉一次详情并回填本地缓存。

## 性能注意

`applyRemoteChanges` 先按题库分组再写 localStorage —— `setBankStore` 会序列化整个题库的 JSON，
逐行写的话首次全量同步（最多 2000 条）就是 2000 次读写。

## 测试

```bash
npm run test:sync
```

覆盖：鉴权、推送落库、`since` 增量语义、幂等覆盖、题库重置、模考详情、脏数据容错、账号隔离。
