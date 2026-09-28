-- ========== 用户与认证 ==========
CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    nickname      TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_users_email ON users(email);

CREATE TABLE sessions (
    token_hash    TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    expires_at    INTEGER NOT NULL,
    created_at    INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user   ON sessions(user_id);
CREATE INDEX idx_sessions_expire ON sessions(expires_at);

CREATE TABLE login_attempts (
    identifier    TEXT PRIMARY KEY,
    fail_count    INTEGER NOT NULL DEFAULT 0,
    locked_until  INTEGER,
    updated_at    INTEGER NOT NULL
);

-- ========== 题目状态 / 收藏 / 连对 ==========
CREATE TABLE q_state (
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
CREATE INDEX idx_q_state_sync ON q_state(uid, ver);

-- ========== 题库元信息（上次练习位置） ==========
CREATE TABLE b_meta (
    uid     TEXT NOT NULL,
    bid     TEXT NOT NULL,
    cur_idx INTEGER NOT NULL DEFAULT 0,
    ver     INTEGER NOT NULL,
    PRIMARY KEY (uid, bid)
) WITHOUT ROWID;
CREATE INDEX idx_b_meta_sync ON b_meta(uid, ver);

-- ========== 模考记录 ==========
CREATE TABLE mock_log (
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
CREATE INDEX idx_mock_log_uid_id ON mock_log(uid, id);
CREATE INDEX idx_mock_log_sync   ON mock_log(uid, ver);

-- ========== 用户同步游标 ==========
CREATE TABLE user_sync (
    uid          TEXT PRIMARY KEY,
    ver          INTEGER NOT NULL DEFAULT 0,
    last_sync_at INTEGER NOT NULL
);

-- ========== 订阅 ==========
CREATE TABLE subscriptions (
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
CREATE INDEX idx_sub_user   ON subscriptions(user_id);
CREATE INDEX idx_sub_expire ON subscriptions(expire_at);

-- ========== 待处理订单（爱发电跳转前写入） ==========
CREATE TABLE pending_orders (
    custom_id  TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    plan       TEXT NOT NULL,
    created_at INTEGER NOT NULL
);