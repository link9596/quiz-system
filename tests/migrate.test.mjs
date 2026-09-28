// 迁移脚本验证：旧库 -> 新订阅结构
//   node tests/migrate.test.mjs
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

let fail = 0;
const check = (name, cond, extra) => {
    if (cond) console.log('  ok   ' + name);
    else { fail++; console.log('  FAIL ' + name, extra === undefined ? '' : JSON.stringify(extra)); }
};

const oldSchema = execFileSync('git', ['show', 'HEAD:schema.sql'], { encoding: 'utf8' });
const db = new DatabaseSync(':memory:');
db.exec(oldSchema);

// 造几条历史数据
db.prepare("INSERT INTO users (id,email,password_hash,created_at,updated_at) VALUES ('u1','a@b.com','x',1,1)").run();
db.prepare(`INSERT INTO subscriptions (id,user_id,plan,status,start_at,expire_at,afdian_order,created_at,updated_at)
            VALUES ('s1','u1','pro_month','active',100,200,'OLDORDER1',1,1)`).run();
db.prepare(`INSERT INTO subscriptions (id,user_id,plan,status,start_at,expire_at,afdian_order,created_at,updated_at)
            VALUES ('s2','u1','pro_year','expired',100,150,'OLDORDER2',1,1)`).run();
db.prepare(`INSERT INTO subscriptions (id,user_id,plan,status,start_at,expire_at,afdian_order,created_at,updated_at)
            VALUES ('s3','u1','pro_month','inactive',0,0,NULL,1,1)`).run();
db.prepare("INSERT INTO pending_orders (custom_id,user_id,plan,created_at) VALUES ('OLD1','u1','pro_month',1)").run();

db.exec(readFileSync('migrate.sql', 'utf8'));

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
check('新表 subscriptions 存在', tables.includes('subscriptions'));
check('新表 pending_orders 存在', tables.includes('pending_orders'));
check('新表 sub_events 存在', tables.includes('sub_events'));
check('临时表已清理', !tables.includes('subscriptions_old') && !tables.includes('pending_orders_old'), tables);

const cols = db.prepare('PRAGMA table_info(subscriptions)').all().map(r => r.name);
for (const c of ['group_id', 'subject', 'plan_key', 'months', 'activate_mode', 'activate_at', 'activated_at', 'afdian_plan_id', 'source']) {
    check('subscriptions 新列 ' + c, cols.includes(c));
}

const rows = db.prepare('SELECT * FROM subscriptions ORDER BY id').all();
check('历史订阅迁移为 3 笔 x 2 科目 = 6 行', rows.length === 6, rows.length);
const s1 = rows.filter(r => r.group_id === 'OLDORDER1');
check('旧 active 订阅两科均为 active', s1.length === 2 && s1.every(r => r.status === 'active'), s1.map(r => r.status));
check('旧 expired 订阅两科均为 expired',
    rows.filter(r => r.group_id === 'OLDORDER2').every(r => r.status === 'expired'));
check('旧 inactive 订阅标记为 revoked（不会误提示激活）',
    rows.filter(r => r.group_id === 's3').every(r => r.status === 'revoked'),
    rows.filter(r => r.group_id === 's3').map(r => r.status));
check('保留原到期时间', s1.every(r => r.expire_at === 200), s1.map(r => r.expire_at));
check('来源标记为 migrate', s1.every(r => r.source === 'migrate'));

const uidx = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_sub_order_subject'").get();
check('唯一索引 (afdian_order, subject) 已建立', !!uidx, uidx);

// 幂等：同订单同科目再插一次应被忽略
db.prepare(`INSERT OR IGNORE INTO subscriptions
  (id,user_id,group_id,subject,plan_key,months,status,start_at,expire_at,activate_mode,created_at,updated_at)
  VALUES ('dup','u1','OLDORDER1','k1','k1k2',1,'pending',0,0,'immediate',1,1)`).run();
check('唯一索引阻止重复授予', db.prepare("SELECT COUNT(*) c FROM subscriptions WHERE afdian_order='OLDORDER1' AND subject='k1'").get().c === 1);

const pendCols = db.prepare('PRAGMA table_info(pending_orders)').all().map(r => r.name);
for (const c of ['plan_key', 'plan_id', 'activate_mode', 'activate_at', 'status', 'check_count', 'last_error']) {
    check('pending_orders 新列 ' + c, pendCols.includes(c));
}

// 全新库用 schema.sql 也应得到同样的结构
const fresh = new DatabaseSync(':memory:');
fresh.exec(readFileSync('schema.sql', 'utf8'));
const fcols = fresh.prepare('PRAGMA table_info(subscriptions)').all().map(r => r.name);
check('schema.sql 与 migrate.sql 结构一致', JSON.stringify(fcols) === JSON.stringify(cols), { fcols, cols });

console.log(fail ? 'FAILURES: ' + fail : 'ALL PASS');
process.exit(fail ? 1 : 0);
