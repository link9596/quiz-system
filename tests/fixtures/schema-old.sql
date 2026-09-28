-- ============================================================================
-- 迁移测试夹具：订阅功能上线【之前】的数据库结构（旧版 schema.sql 快照）
-- 仅用于 tests/migrate.test.mjs 验证 migrate.sql 的迁移正确性，不要用于新部署。
-- ============================================================================

-- ========== 用户与认证 ==========
CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    nickname      TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash    TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    expires_at    INTEGER NOT NULL,
    created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user   ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS login_attempts (
    identifier    TEXT PRIMARY KEY,
    fail_count    INTEGER NOT NULL DEFAULT 0,
    locked_until  INTEGER,
    updated_at    INTEGER NOT NULL
);

-- ========== 题目状态 / 收藏 / 连对 ==========
CREATE TABLE IF NOT EXISTS q_state (
    uid     TEXT NOT NULL,
    bid     TEXT NOT NULL,
    qid     INTEGER NOT NULL,
    st      INTEGER NOT NULL DEFAULT 0,
    ans     TEXT,
    fav     INTEGER NOT NULL DEFAULT 0,
    streak  INTEGER NOT NULL DEFAULT 0,
    ver     INTEGER NOT NULL,
    PRIMARY KEY (uid, bid, qid)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_q_state_sync ON q_state(uid, ver);

-- ========== 题库元信息 ==========
CREATE TABLE IF NOT EXISTS b_meta (
    uid     TEXT NOT NULL,
    bid     TEXT NOT NULL,
    cur_idx INTEGER NOT NULL DEFAULT 0,
    ver     INTEGER NOT NULL,
    PRIMARY KEY (uid, bid)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_b_meta_sync ON b_meta(uid, ver);

-- ========== 模考记录 ==========
CREATE TABLE IF NOT EXISTS mock_log (
    uid        TEXT NOT NULL,
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    score      REAL NOT NULL,
    passed     INTEGER NOT NULL,
    correct    INTEGER NOT NULL,
    wrong      INTEGER NOT NULL DEFAULT 0,
    unanswered INTEGER NOT NULL DEFAULT 0,
    total      INTEGER NOT NULL,
    dur        INTEGER NOT NULL,
    ts         INTEGER NOT NULL,
    detail     TEXT,
    ver        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mock_log_uid_id ON mock_log(uid, id);
CREATE INDEX IF NOT EXISTS idx_mock_log_sync   ON mock_log(uid, ver);

-- ========== 用户同步游标 ==========
CREATE TABLE IF NOT EXISTS user_sync (
    uid          TEXT PRIMARY KEY,
    ver          INTEGER NOT NULL DEFAULT 0,
    last_sync_at INTEGER NOT NULL
);

-- ========== 订阅（旧模型：单表 + plan 文本，无科目概念）==========
CREATE TABLE IF NOT EXISTS subscriptions (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    plan         TEXT NOT NULL DEFAULT 'pro_month',
    status       TEXT NOT NULL DEFAULT 'inactive',
    start_at     INTEGER NOT NULL,
    expire_at    INTEGER NOT NULL,
    afdian_order TEXT UNIQUE,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sub_user   ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_sub_expire ON subscriptions(expire_at);

-- ========== 待处理订单（旧模型：无关联码状态机）==========
CREATE TABLE IF NOT EXISTS pending_orders (
    custom_id  TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    plan       TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
