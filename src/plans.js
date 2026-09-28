// ============================================================================
// 套餐与科目定义
// ----------------------------------------------------------------------------
// 三个爱发电方案（plan_id）分别对应：
//   k1   科目一必做题库
//   k2   科目二必做题库
//   k1k2 科目一 + 科目二必做题库
// plan_id 可在 wrangler.toml 的 [vars] 中用 PLAN_K1 / PLAN_K2 / PLAN_K1K2 覆盖。
// ============================================================================

export const SUBJECT_LABELS = {
    k1: '科目一',
    k2: '科目二'
};

const DEFAULT_PLAN_IDS = {
    k1: '3b49790abaf411f1a7af52540025c377',
    k2: '3c128840baf411f1a55652540025c377',
    k1k2: '3cb96e6cbaf411f1819a52540025c377'
};

// 爱发电返回的 month 不可用时使用的兜底时长（月）
const DEFAULT_MONTHS = { k1: 1, k2: 1, k1k2: 1 };

// 展示用价格（元 / 月），可在 wrangler.toml 用 PLAN_PRICE_* 覆盖
const DEFAULT_PRICES = { k1: '28', k2: '28', k1k2: '52' };

function envStr(env, key, fallback = '') {
    const v = env && env[key];
    return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

/**
 * 取得当前环境下的套餐表。
 * @returns {{k1: object, k2: object, k1k2: object}}
 */
export function getPlans(env) {
    const build = (key, name, subjects) => {
        const rawId = envStr(env, 'PLAN_' + key.toUpperCase(), '') || DEFAULT_PLAN_IDS[key];
        const rawMonths = parseInt(envStr(env, 'PLAN_MONTHS_' + key.toUpperCase(), ''), 10);
        const months = Number.isFinite(rawMonths) && rawMonths > 0 ? rawMonths : DEFAULT_MONTHS[key];
        return {
            key,
            name,
            subjects,
            // 爱发电下单页需要的 plan_id
            planId: rawId,
            // 返回给前端的 id（与爱发电 plan_id 一致，便于排错；前端不直接使用）
            afdianPlanId: rawId,
            months,
            price: envStr(env, 'PLAN_PRICE_' + key.toUpperCase(), '') || DEFAULT_PRICES[key],
            productType: 0,
            short: key === 'k1k2' ? '科目一+科目二' : SUBJECT_LABELS[key]
        };
    };

    return {
        k1: build('k1', '科目一必做题库', ['k1']),
        k2: build('k2', '科目二必做题库', ['k2']),
        k1k2: build('k1k2', '科目一 + 科目二必做题库', ['k1', 'k2'])
    };
}

export function planByKey(env, key) {
    if (!key) return null;
    const plans = getPlans(env);
    return plans[String(key).toLowerCase()] || null;
}

export function planByAfdianId(env, planId) {
    const id = String(planId || '').trim();
    if (!id) return null;
    const plans = getPlans(env);
    for (const key of Object.keys(plans)) {
        if (plans[key].planId === id) return plans[key];
    }
    return null;
}

/** 某套餐包含的科目列表（永远返回非空数组） */
export function subjectsOfPlan(env, planKey) {
    const plan = planByKey(env, planKey);
    return plan ? plan.subjects.slice() : ['k1'];
}

/** 把一组科目拼成可读名称，如 "科目一 + 科目二" */
export function subjectsLabel(subjects) {
    const list = (subjects || []).filter(s => SUBJECT_LABELS[s]);
    if (!list.length) return '会员';
    const uniq = Array.from(new Set(list));
    return uniq.map(s => SUBJECT_LABELS[s]).join(' + ');
}

/** 根据已开通科目推导套餐 key：k1 / k2 / k1k2 / null */
export function planKeyFromSubjects(subjects) {
    const set = new Set(subjects || []);
    const k1 = set.has('k1');
    const k2 = set.has('k2');
    if (k1 && k2) return 'k1k2';
    if (k1) return 'k1';
    if (k2) return 'k2';
    return null;
}

/** 套餐展示名（优先使用推导出的套餐名） */
export function planNameFromSubjects(env, subjects) {
    const key = planKeyFromSubjects(subjects);
    if (key) {
        const plan = planByKey(env, key);
        if (plan) return plan.name;
    }
    return subjectsLabel(subjects) + ' 会员';
}

/** 订阅月数归一化：爱发电返回的 month 优先，否则用套餐默认值 */
export function normalizeMonths(rawMonth, fallbackMonths) {
    const m = parseInt(rawMonth, 10);
    if (Number.isFinite(m) && m > 0 && m <= 1200) return m;
    const f = parseInt(fallbackMonths, 10);
    if (Number.isFinite(f) && f > 0) return f;
    return 1;
}

/**
 * 在 unix 秒时间戳上叠加自然月（保留“日”，超出月末时收敛到月末）。
 * 与爱发电“购买 N 个月”的语义一致。
 */
export function addMonths(ts, months) {
    const m = Math.trunc(Number(months) || 0);
    if (m === 0) return Math.trunc(Number(ts) || 0);
    const base = new Date(Math.trunc(Number(ts) || 0) * 1000);
    if (Number.isNaN(base.getTime())) return Math.trunc(Number(ts) || 0);
    const day = base.getUTCDate();
    base.setUTCDate(1);
    base.setUTCMonth(base.getUTCMonth() + m);
    const year = base.getUTCFullYear();
    const month = base.getUTCMonth();
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    base.setUTCDate(Math.min(day, lastDay));
    return Math.floor(base.getTime() / 1000);
}

const CUSTOM_ID_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/**
 * 生成订单关联码（写入爱发电 custom_order_id / remark），人工可读、
 * 不包含易混淆字符，例如 TK-7F3K9M2QX4AB
 */
export function newCustomId(prefix = 'TK') {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        out += CUSTOM_ID_ALPHABET[bytes[i] % CUSTOM_ID_ALPHABET.length];
    }
    return prefix + '-' + out;
}

/** 允许出现在 custom_order_id / remark 中的字符（清洗外部输入） */
export function sanitizeCustomId(raw) {
    return String(raw || '').trim().replace(/[^A-Za-z0-9-]/g, '').slice(0, 64);
}
