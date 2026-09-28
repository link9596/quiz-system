// 密码胡椒（PASSWORD_PEPPER）行为回归测试
//   node tests/pepper.test.mjs
import { hashPassword, verifyPassword } from '../src/crypto.js';

let fail = 0;
const check = (name, cond, extra) => {
    if (cond) console.log('  ok   ' + name);
    else { fail++; console.log('  FAIL ' + name, extra === undefined ? '' : extra); }
};

// 未配置胡椒时不应抛异常（旧实现会因为 HMAC 空密钥直接 500）
let h1 = null;
try { h1 = await hashPassword('Abc12345', undefined); } catch (e) { /* ignore */ }
check('未配置胡椒时仍可注册（不再抛 DataError）', !!h1, h1 === null ? 'hashPassword threw' : '');
check('未配置胡椒时登录可校验', h1 ? await verifyPassword('Abc12345', h1, undefined) : false);
check('未配置与空字符串等价（部署方式切换安全）', h1 ? await verifyPassword('Abc12345', h1, '') : false);
check('错误密码被拒绝', h1 ? !(await verifyPassword('Abc12345x', h1, undefined)) : false);

const h2 = await hashPassword('Abc12345', 'real-pepper');
check('配置真实胡椒时正常工作', await verifyPassword('Abc12345', h2, 'real-pepper'));
check('胡椒不同则校验失败', !(await verifyPassword('Abc12345', h2, 'other-pepper')));
check('哈希格式为标准 pbkdf2 结构', /^\$pbkdf2-sha256\$100000\$/.test(h2), String(h2).slice(0, 40));
check('同一密码两次哈希不同（含随机盐）', (await hashPassword('Abc12345', 'real-pepper')) !== h2);

console.log(fail ? 'FAILURES: ' + fail : 'ALL PASS');
process.exit(fail ? 1 : 0);
