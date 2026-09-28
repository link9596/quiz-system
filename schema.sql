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

-- ========== 订阅权益 ==========
-- 一行 = 一个科目的一条权益（k1 / k2）；同一笔爱发电订单的多行用 group_id 关联。
-- status: pending(已付款待激活) | active(生效中) | expired(已过期) | revoked(已撤销)
CREATE TABLE IF NOT EXISTS subscriptions (
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
    activate_at    INTEGER,
    activated_at   INTEGER,
    afdian_order   TEXT,
    afdian_plan_id TEXT,
    amount         TEXT,
    source         TEXT,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
);
-- 幂等：同一笔爱发电订单的同一个科目只授予一次
CREATE UNIQUE INDEX IF NOT EXISTS idx_sub_order_subject ON subscriptions(afdian_order, subject);
CREATE INDEX IF NOT EXISTS idx_sub_user     ON subscriptions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_sub_subject  ON subscriptions(user_id, subject);
CREATE INDEX IF NOT EXISTS idx_sub_expire   ON subscriptions(expire_at);
CREATE INDEX IF NOT EXISTS idx_sub_pending  ON subscriptions(status, activate_at);
CREATE INDEX IF NOT EXISTS idx_sub_group    ON subscriptions(group_id);

-- ========== 待支付 / 待核对订单 ==========
-- custom_id 会作为爱发电下单链接的 custom_order_id 与 remark，
-- 是「爱发电订单 -> 本站账号」关联的唯一依据。
CREATE TABLE IF NOT EXISTS pending_orders (
    custom_id     TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    plan_key      TEXT NOT NULL,
    plan_id       TEXT,
    months        INTEGER NOT NULL DEFAULT 1,
    activate_mode TEXT NOT NULL DEFAULT 'immediate',
    activate_at   INTEGER,
    status        TEXT NOT NULL DEFAULT 'pending',
    afdian_order  TEXT,
    amount        TEXT,
    check_count   INTEGER NOT NULL DEFAULT 0,
    last_check_at INTEGER,
    last_error    TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_user ON pending_orders(user_id, status);
CREATE INDEX IF NOT EXISTS idx_pending_plan ON pending_orders(plan_key, status, created_at);

-- ========== 订阅事件日志 ==========
CREATE TABLE IF NOT EXISTS sub_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT,
    kind       TEXT NOT NULL,
    detail     TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sub_events_user ON sub_events(user_id, created_at);