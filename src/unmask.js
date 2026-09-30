// Декодер ссылок VK Audio (audio_api_unavailable.mp3?extra=...).
// Порт алгоритма из клиента VK. Выполняется в контексте страницы (нужен vk.id).
(function (root) {
  const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN0PQRSTUVWXYZO123456789+/=";

  // Кастомный base64
  function b64(str) {
    if (!str || str.length % 4 === 1) return false;
    let acc = 0, idx = 0, out = "", ch, pos;
    for (let i = 0; (ch = str.charAt(i++)); ) {
      pos = ALPHABET.indexOf(ch);
      if (pos === -1) continue;
      acc = idx % 4 ? 64 * acc + pos : pos;
      if (idx++ % 4) out += String.fromCharCode(255 & (acc >> ((-2 * idx) & 6)));
    }
    return out;
  }

  function permutation(len, seed) {
    if (typeof seed === "bigint") {
      const res = new Array(len);
      if (len === 0) return res;
      const n = BigInt(len);
      if (seed < 0n) seed = -seed;
      for (let i = len - 1; i >= 0; i--) {
        seed = ((n * BigInt(i + 1)) ^ (seed + BigInt(i))) % n;
        res[i] = Number(seed);
      }
      return res;
    }
    const res = [];
    if (len) {
      let i = len;
      seed = Math.abs(seed);
      while (i--) {
        seed = (len * (i + 1) ^ (seed + i)) % len;
        res[i] = seed;
      }
    }
    return res;
  }

  const OPS = {
    v: (s) => s.split("").reverse().join(""),
    r(s, k) {
      const chars = s.split("");
      const abc = ALPHABET + ALPHABET;
      let i = chars.length, p;
      while (i--) {
        p = abc.indexOf(chars[i]);
        if (p !== -1) chars[i] = abc.substr(p - k, 1);
      }
      return chars.join("");
    },
    s(s, seed) {
      const len = s.length;
      if (!len) return s;
      const perm = permutation(len, seed);
      const arr = s.split("");
      for (let i = 1; i < len; i++) arr[i] = arr.splice(perm[len - 1 - i], 1, arr[i])[0];
      return arr.join("");
    },
    i(s, k) {
      const a = BigInt(parseInt(k, 10) || 0);
      const b = BigInt((root.vk && root.vk.id) || 0);
      return OPS.s(s, b ^ a);
    },
    x(s, k) {
      const c = k.charCodeAt(0);
      return s.split("").map((ch) => String.fromCharCode(ch.charCodeAt(0) ^ c)).join("");
    },
  };

  function unmask(url) {
    if (!url || url.indexOf("audio_api_unavailable") === -1) return url;
    const parts = url.split("?extra=")[1].split("#");
    const ops = parts[1] === "" ? "" : b64(parts[1]);
    let cur = b64(parts[0]);
    if (typeof ops !== "string" || !cur) return url;
    const list = ops ? ops.split("\t") : [];
    let n = list.length;
    while (n--) {
      const args = list[n].split("\v");
      const name = args.splice(0, 1, cur)[0];
      if (!OPS[name]) return url;
      cur = OPS[name].apply(null, args);
    }
    return cur && cur.substr(0, 4) === "http" ? cur : url;
  }

  root.__vkdlUnmask = unmask;
})(typeof window !== "undefined" ? window : globalThis);
