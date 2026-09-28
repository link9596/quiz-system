// 精简版 MD5（UTF-8 输入，十六进制小写输出）
export function md5(str) {
    const rl = (v, s) => (v << s) | (v >>> (32 - s));
    const au = (x, y) => {
        const x8 = x & 0x80000000, y8 = y & 0x80000000;
        const x4 = x & 0x40000000, y4 = y & 0x40000000;
        const r = (x & 0x3FFFFFFF) + (y & 0x3FFFFFFF);
        if (x4 & y4) return r ^ 0x80000000 ^ x8 ^ y8;
        if (x4 | y4) return (r & 0x40000000) ? r ^ 0xC0000000 ^ x8 ^ y8 : r ^ 0x40000000 ^ x8 ^ y8;
        return r ^ x8 ^ y8;
    };
    const F = (x, y, z) => (x & y) | (~x & z);
    const G = (x, y, z) => (x & z) | (y & ~z);
    const H = (x, y, z) => x ^ y ^ z;
    const I = (x, y, z) => y ^ (x | ~z);
    const step = (fn, a, b, c, d, x, s, ac) => au(rl(au(au(fn(b, c, d), x), ac), s), b);

    const utf8 = unescape(encodeURIComponent(str));
    const len = utf8.length;
    const words = new Array(((len + 8 - ((len + 8) % 64)) / 64 + 1) * 16 - 1).fill(0);
    let pos = 0, byteCount = 0;
    while (byteCount < len) {
        pos = (byteCount - (byteCount % 4)) / 4;
        words[pos] |= utf8.charCodeAt(byteCount) << ((byteCount % 4) * 8);
        byteCount++;
    }
    pos = (byteCount - (byteCount % 4)) / 4;
    words[pos] |= 0x80 << ((byteCount % 4) * 8);
    words[words.length - 2] = len << 3;
    words[words.length - 1] = len >>> 29;

    let a = 0x67452301, b = 0xEFCDAB89, c = 0x98BADCFE, d = 0x10325476;
    for (let k = 0; k < words.length; k += 16) {
        const AA = a, BB = b, CC = c, DD = d;
        a = step(F, a, b, c, d, words[k+0],  7, 0xD76AA478); d = step(F, d, a, b, c, words[k+1], 12, 0xE8C7B756);
        c = step(F, c, d, a, b, words[k+2], 17, 0x242070DB); b = step(F, b, c, d, a, words[k+3], 22, 0xC1BDCEEE);
        a = step(F, a, b, c, d, words[k+4],  7, 0xF57C0FAF); d = step(F, d, a, b, c, words[k+5], 12, 0x4787C62A);
        c = step(F, c, d, a, b, words[k+6], 17, 0xA8304613); b = step(F, b, c, d, a, words[k+7], 22, 0xFD469501);
        a = step(F, a, b, c, d, words[k+8],  7, 0x698098D8); d = step(F, d, a, b, c, words[k+9], 12, 0x8B44F7AF);
        c = step(F, c, d, a, b, words[k+10],17, 0xFFFF5BB1); b = step(F, b, c, d, a, words[k+11],22, 0x895CD7BE);
        a = step(F, a, b, c, d, words[k+12], 7, 0x6B901122); d = step(F, d, a, b, c, words[k+13],12, 0xFD987193);
        c = step(F, c, d, a, b, words[k+14],17, 0xA679438E); b = step(F, b, c, d, a, words[k+15],22, 0x49B40821);
        a = step(G, a, b, c, d, words[k+1],  5, 0xF61E2562); d = step(G, d, a, b, c, words[k+6],  9, 0xC040B340);
        c = step(G, c, d, a, b, words[k+11],14, 0x265E5A51); b = step(G, b, c, d, a, words[k+0], 20, 0xE9B6C7AA);
        a = step(G, a, b, c, d, words[k+5],  5, 0xD62F105D); d = step(G, d, a, b, c, words[k+10], 9, 0x02441453);
        c = step(G, c, d, a, b, words[k+15],14, 0xD8A1E681); b = step(G, b, c, d, a, words[k+4], 20, 0xE7D3FBC8);
        a = step(G, a, b, c, d, words[k+9],  5, 0x21E1CDE6); d = step(G, d, a, b, c, words[k+14], 9, 0xC33707D6);
        c = step(G, c, d, a, b, words[k+3], 14, 0xF4D50D87); b = step(G, b, c, d, a, words[k+8], 20, 0x455A14ED);
        a = step(G, a, b, c, d, words[k+13], 5, 0xA9E3E905); d = step(G, d, a, b, c, words[k+2],  9, 0xFCEFA3F8);
        c = step(G, c, d, a, b, words[k+7], 14, 0x676F02D9); b = step(G, b, c, d, a, words[k+12],20, 0x8D2A4C8A);
        a = step(H, a, b, c, d, words[k+5],  4, 0xFFFA3942); d = step(H, d, a, b, c, words[k+8], 11, 0x8771F681);
        c = step(H, c, d, a, b, words[k+11],16, 0x6D9D6122); b = step(H, b, c, d, a, words[k+14],23, 0xFDE5380C);
        a = step(H, a, b, c, d, words[k+1],  4, 0xA4BEEA44); d = step(H, d, a, b, c, words[k+4], 11, 0x4BDECFA9);
        c = step(H, c, d, a, b, words[k+7], 16, 0xF6BB4B60); b = step(H, b, c, d, a, words[k+10],23, 0xBEBFBC70);
        a = step(H, a, b, c, d, words[k+13], 4, 0x289B7EC6); d = step(H, d, a, b, c, words[k+0], 11, 0xEAA127FA);
        c = step(H, c, d, a, b, words[k+3], 16, 0xD4EF3085); b = step(H, b, c, d, a, words[k+6], 23, 0x04881D05);
        a = step(H, a, b, c, d, words[k+9],  4, 0xD9D4D039); d = step(H, d, a, b, c, words[k+12],11, 0xE6DB99E5);
        c = step(H, c, d, a, b, words[k+15],16, 0x1FA27CF8); b = step(H, b, c, d, a, words[k+2], 23, 0xC4AC5665);
        a = step(I, a, b, c, d, words[k+0],  6, 0xF4292244); d = step(I, d, a, b, c, words[k+7], 10, 0x432AFF97);
        c = step(I, c, d, a, b, words[k+14],15, 0xAB9423A7); b = step(I, b, c, d, a, words[k+5], 21, 0xFC93A039);
        a = step(I, a, b, c, d, words[k+12], 6, 0x655B59C3); d = step(I, d, a, b, c, words[k+3], 10, 0x8F0CCC92);
        c = step(I, c, d, a, b, words[k+10],15, 0xFFEFF47D); b = step(I, b, c, d, a, words[k+1], 21, 0x85845DD1);
        a = step(I, a, b, c, d, words[k+8],  6, 0x6FA87E4F); d = step(I, d, a, b, c, words[k+15],10, 0xFE2CE6E0);
        c = step(I, c, d, a, b, words[k+6], 15, 0xA3014314); b = step(I, b, c, d, a, words[k+13],21, 0x4E0811A1);
        a = step(I, a, b, c, d, words[k+4],  6, 0xF7537E82); d = step(I, d, a, b, c, words[k+11],10, 0xBD3AF235);
        c = step(I, c, d, a, b, words[k+2], 15, 0x2AD7D2BB); b = step(I, b, c, d, a, words[k+9], 21, 0xEB86D391);
        a = au(a, AA); b = au(b, BB); c = au(c, CC); d = au(d, DD);
    }
    const hex = v => {
        let s = '';
        for (let i = 0; i < 4; i++) s += ('0' + ((v >>> (i * 8)) & 255).toString(16)).slice(-2);
        return s;
    };
    return (hex(a) + hex(b) + hex(c) + hex(d)).toLowerCase();
}