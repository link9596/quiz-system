-- 清空所有数据（不删表结构也没关系，schema.sql 用的是 IF NOT EXISTS）
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS q_state;
DROP TABLE IF EXISTS b_meta;
DROP TABLE IF EXISTS mock_log;
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS pending_orders;
DROP TABLE IF EXISTS users;
