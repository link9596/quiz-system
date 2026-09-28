-- ============================================================================
-- 订阅模块迁移脚本（已有数据库 → 新订阅结构）
-- ----------------------------------------------------------------------------
-- 适用：已经执行过旧版 schema.sql 的数据库。
-- 全新数据库请直接执行 schema.sql，不需要本脚本。
--
-- 执行：npm run db:migrate          （远程）
--       npm run db:migrate:local    （本地）
--
-- 注意：本脚本只需执行一次。重复执行会在第一步报
--       "table subscriptions_old already exists"，不会破坏任何数据。
-- ============================================================================

PRAGMA foreign_keys = off;

-- ---- 1. 旧表改名为 _old（旧索引会跟着表走，先删掉以免重名）----
DROP INDEX IF EXISTS idx_sub_user;
DROP INDEX IF EXISTS idx_sub_expire;

ALTER TABLE subscriptions  RENAME TO subscriptions_old;
ALTER TABLE pending_orders RENAME TO pending_orders_old;

-- ---- 2. 新结构 ----
CREATE TABLE subscriptions (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL,
    group_id       TEXT NOT NULL,
    subject        TEXT NOT NULL,
    plan_key       TEXT NOT NULL,
    plan_name      TEXT,
    months         INTEGER NOT NULL DEFAULT 1,
    status         TEXT NOT NULL DEFAULT 'pending',
    start_at       INTEGER NOT NULL DEFAULT 0,
    expire_at      INTEGER NOT NULL DEFAULT 0,
    activate_mode  TEXT NOT NULL DEFAULT 'immediate',
    activated_at   INTEGER,
    afdian_order   TEXT,
    afdian_plan_id TEXT,
    amount         TEXT,
    source         TEXT,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_sub_order_subject ON subscriptions(afdian_order, subject);
CREATE INDEX idx_sub_user    ON subscriptions(user_id, status);
CREATE INDEX idx_sub_subject ON subscriptions(user_id, subject);
CREATE INDEX idx_sub_expire  ON subscriptions(expire_at);
CREATE INDEX idx_sub_status  ON subscriptions(status);
CREATE INDEX idx_sub_group   ON subscriptions(group_id);

CREATE TABLE pending_orders (
    custom_id     TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    plan_key      TEXT NOT NULL,
    plan_id       TEXT,
    months        INTEGER NOT NULL DEFAULT 1,
    activate_mode TEXT NOT NULL DEFAULT 'immediate',
    status        TEXT NOT NULL DEFAULT 'pending',
    afdian_order  TEXT,
    amount        TEXT,
    check_count   INTEGER NOT NULL DEFAULT 0,
    last_check_at INTEGER,
    last_error    TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_pending_user ON pending_orders(user_id, status);
CREATE INDEX idx_pending_plan ON pending_orders(plan_key, status, created_at);

CREATE TABLE IF NOT EXISTS sub_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT,
    kind       TEXT NOT NULL,
    detail     TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sub_events_user ON sub_events(user_id, created_at);

-- ---- 3. 迁移历史订阅数据 ----
-- 旧模型没有科目概念（plan = pro_month / pro_year），按「全科」迁移成两行。
INSERT INTO subscriptions
    (id, user_id, group_id, subject, plan_key, plan_name, months, status,
     start_at, expire_at, activate_mode, activated_at,
     afdian_order, afdian_plan_id, amount, source, created_at, updated_at)
SELECT
    id || '-k1', user_id, COALESCE(afdian_order, id), 'k1', 'k1k2', '历史订阅（迁移）', 1,
    CASE status WHEN 'active' THEN 'active' WHEN 'expired' THEN 'expired' ELSE 'revoked' END,
    start_at, expire_at, 'immediate', NULL,
    afdian_order, NULL, NULL, 'migrate', created_at, updated_at
FROM subscriptions_old;

INSERT INTO subscriptions
    (id, user_id, group_id, subject, plan_key, plan_name, months, status,
     start_at, expire_at, activate_mode, activated_at,
     afdian_order, afdian_plan_id, amount, source, created_at, updated_at)
SELECT
    id || '-k2', user_id, COALESCE(afdian_order, id), 'k2', 'k1k2', '历史订阅（迁移）', 1,
    CASE status WHEN 'active' THEN 'active' WHEN 'expired' THEN 'expired' ELSE 'revoked' END,
    start_at, expire_at, 'immediate', NULL,
    afdian_order, NULL, NULL, 'migrate', created_at, updated_at
FROM subscriptions_old;

-- 旧的待支付订单是 2 天自动清理的临时数据，且用的是已废弃的 plan 标识，
-- 关联码无法复用，直接丢弃。
-- （如需保留，请在执行前自行导出 pending_orders_old 备份表。）

-- ---- 4. 收尾 ----
DROP TABLE subscriptions_old;
DROP TABLE pending_orders_old;

PRAGMA foreign_keys = on;
