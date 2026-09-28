# 云端同步说明

> 做题记录、收藏、错题连对次数、题库进度、模考记录怎么上云、怎么下发。

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

> ⚠️ **字段契约**：`m` 是模考记录（mock_log），`k` 是题库进度（b_meta）。
> 后端早期版本把这两个字段接反了（`m` 发的是进度、`k` 发的是模考），
> 因为当时前端完全不读响应体所以一直没暴露；实现下拉后会导致**两边都合并不进去**。
> 改动时请务必保持这个契约，`tests/sync.test.mjs` 有断言守着。

## 版本号（增量同步）

- 每次同步都会给用户分配一个新的 `user_sync.ver`；
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

## 前端 outbox

本地变更先写进 `localStorage.quiz_sync_outbox`，再由以下时机上传：

- 任意变更后 **5 秒防抖**；
- 页面切到后台（`visibilitychange`）——用 `keepalive` 发，手机上切走也不丢；
- 关页面前（`beforeunload`）——同样用 `keepalive` 尽力发出去；
- 网络恢复（`online`）、点顶栏的同步按钮、**登录成功后**。

每条 outbox 记录带一个 `owner`（账号 id，未登录时为 `null`）：

- `owner` 与当前账号不一致 → **整批丢弃**，绝不把 A 的数据推到 B 名下；
- `owner` 为 `null`（登录前攒的）→ 由当前账号认领后上传。

退出登录时**不清空** outbox：同一账号再登录会继续上传，换账号则会被上面那条规则拦掉。

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
