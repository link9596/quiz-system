-- ============================================================================
-- 数据库结构（7 张表）
-- ----------------------------------------------------------------------------
--   users            账号 + 登录风控 + 同步游标 + 未完成考试
--   sessions         登录会话（一个用户可多设备并存）
--   q_state          每题作答状态 / 收藏 / 连错（一行 = 用户 × 题库 × 题目）
--   b_meta           题库进度（一行 = 用户 × 题库，随题库数量增长）
--   mock_log         模考记录
--   subscriptions    已支付权益（一行 = 一个科目的权益）
--   pending_orders   待支付订单（一行 = 一笔发起过的下单）
--
-- 设计取舍：
--   · 基数恒为「1 行/用户」的数据并进 users：登录风控、同步游标、未完成考试。
--     不额外建表，登录/同步时顺带读写，省表也省往返。
--   · 基数为「1 行/(用户 × X)」的数据独立成表（q_state / b_meta）。
--     X 会随题库数量增长，用一个独立表才能按题库建索引、做批量操作与统计，
--     也不会让 users 行随着题库变多而不断变胖。
--   · 需要行级 ver 做增量同步的数据（q_state / b_meta / mock_log）必须独立成表。
-- ============================================================================

-- ========== 用户 ==========
CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    nickname      TEXT,

    -- 登录风控（原 login_attempts）
    fail_count    INTEGER NOT NULL DEFAULT 0,
    locked_until  INTEGER,

    -- 同步游标（原 user_sync）：每次 /api/sync 自增，与行级 ver 比较做增量拉取
    sync_ver      INTEGER NOT NULL DEFAULT 0,
    last_sync_at  INTEGER,

    -- 未完成考试快照，用于跨设备续考（基数恒为 1 行/用户）
    -- 未完成考试快照（原 exam_state），用于跨设备续考
    exam_data        TEXT,
    exam_ver         INTEGER,
    exam_updated_at  INTEGER,

    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ========== 登录会话 ==========
CREATE TABLE IF NOT EXISTS sessions (
    token_hash    TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    expires_at    INTEGER NOT NULL,
    created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user   ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expires_at);

-- ========== 题目状态 / 收藏 / 连对 ==========
-- st: 0 未做 / 1 正确 / 2 错误；fav: 是否收藏；streak: 错题连错次数
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

-- ========== 题库进度 ==========
-- 一行 = 一个用户在一个题库里的刷题位置。题库会持续新增，所以独立成表：
-- 可以按 bid 建索引做批量操作（例如题库改版后统一重置），也不会让 users 行越来越胖。
CREATE TABLE IF NOT EXISTS b_meta (
    uid     TEXT NOT NULL,
    bid     TEXT NOT NULL,
    cur_idx INTEGER NOT NULL DEFAULT 0,
    ver     INTEGER NOT NULL,
    PRIMARY KEY (uid, bid)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_b_meta_sync ON b_meta(uid, ver);
CREATE INDEX IF NOT EXISTS idx_b_meta_bid  ON b_meta(bid);

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
CREATE INDEX IF NOT EXISTS idx_sub_user    ON subscriptions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_sub_subject ON subscriptions(user_id, subject);
CREATE INDEX IF NOT EXISTS idx_sub_expire  ON subscriptions(expire_at);
CREATE INDEX IF NOT EXISTS idx_sub_status  ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_sub_group   ON subscriptions(group_id);

-- ========== 待支付订单 ==========
-- custom_id 会作为爱发电下单链接的 custom_order_id 与 remark，
-- 是「爱发电订单 -> 本站账号」关联的唯一依据。
-- status: pending(待支付) | canceled(用户已从列表删除) | done(已开通)
CREATE TABLE IF NOT EXISTS pending_orders (
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
CREATE INDEX IF NOT EXISTS idx_pending_user ON pending_orders(user_id, status);
CREATE INDEX IF NOT EXISTS idx_pending_plan ON pending_orders(plan_key, status, created_at);
