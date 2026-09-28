// ============================================================================
// 测试用 D1 垫片：把 Node 内置的 node:sqlite 包装成 Cloudflare D1 的最小接口。
// 需要 Node >= 22.5（node:sqlite 为内置实验模块），本项目开发环境为 Node 24。
// ============================================================================
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

class Stmt {
    constructor(db, sql) { this.db = db; this.sql = sql; this.params = []; }
    bind(...args) { const s = new Stmt(this.db, this.sql); s.params = args; return s; }
    _p() { return this.db.prepare(this.sql); }
    async first() { const r = this._p().get(...this.params); return r === undefined ? null : r; }
    async all() { return { results: this._p().all(...this.params) }; }
    async run() {
        const r = this._p().run(...this.params);
        return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    }
}

export class D1Shim {
    constructor(sqlite) { this.s = sqlite; }
    prepare(sql) { return new Stmt(this.s, sql); }
    async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; }
}

/** 建一个空库（执行 schema.sql）并返回一套可用的 env */
export function makeEnv(vars = {}) {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(readFileSync(join(ROOT, 'schema.sql'), 'utf8'));
    return {
        DB: new D1Shim(sqlite),
        PASSWORD_PEPPER: 'test-pepper',
        ALLOWED_ORIGINS: '',
        AFDIAN_USER_ID: 'creator-1',
        AFDIAN_TOKEN: 'tok-abc',
        PLAN_K1: 'plan-k1',
        PLAN_K2: 'plan-k2',
        PLAN_K1K2: 'plan-k1k2',
        SUPPORT_CONTACT: '客服邮箱：help@example.com｜QQ：123456789',
        _sqlite: sqlite,
        ...vars
    };
}

/** 简单的断言收集器 */
export function createChecker() {
    const state = { pass: 0, fail: 0, failures: [] };
    return {
        state,
        check(name, cond, extra) {
            if (cond) { state.pass++; console.log('  ok   ' + name); }
            else {
                state.fail++;
                state.failures.push(name);
                console.log('  FAIL ' + name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400));
            }
        },
        summary() {
            console.log('\n============================');
            console.log('通过 ' + state.pass + ' 项，失败 ' + state.fail + ' 项');
            if (state.fail) console.log('失败项：' + state.failures.join(' / '));
            return state.fail;
        }
    };
}

/** 爱发电开放接口打桩：$fetch 可切换 ok / down 两种状态 */
export function stubAfdian() {
    const ctl = { orders: [], mode: 'ok', calls: 0, lastParams: null };
    globalThis.fetch = async (url, init) => {
        ctl.calls++;
        if (init && init.body) {
            try { ctl.lastParams = JSON.parse(init.body); } catch { ctl.lastParams = null; }
        }
        if (ctl.mode === 'down') throw new Error('network unreachable');
        const list = ctl.orders;
        return new Response(JSON.stringify({
            ec: 200, em: 'order',
            data: { list, total_count: list.length, total_page: 1 }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    return ctl;
}

export const DAY_MS = 86400000;
export const nowSec = () => Math.floor(Date.now() / 1000);
export const daysFromNow = ms => Math.round((ms - Date.now()) / DAY_MS);
export const isoDate = ms => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : null);
