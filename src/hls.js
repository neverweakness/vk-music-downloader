// Загрузка HLS-треков VK: плейлист -> сегменты -> AES-128 -> MPEG-TS -> mp3 (+ID3).
(function (root) {
  const CONCURRENCY = 6;
  const RETRIES = 3;

  async function fetchBuffer(url) {
    let lastErr;
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      try {
        const res = await fetch(url, { credentials: "omit" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        return await res.arrayBuffer();
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  function hexToBytes(hex) {
    hex = hex.replace(/^0x/i, "").padStart(32, "0");
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  function seqToIv(seq) {
    const iv = new Uint8Array(16);
    new DataView(iv.buffer).setUint32(12, seq >>> 0);
    return iv;
  }

  // Разбор m3u8. Для master-плейлиста берётся вариант с максимальным bandwidth.
  async function loadPlaylist(url, depth = 0) {
    const text = new TextDecoder().decode(await fetchBuffer(url));
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines[0] !== "#EXTM3U") throw new Error("Некорректный плейлист");

    if (lines.some((l) => l.startsWith("#EXT-X-STREAM-INF")) && depth < 3) {
      let best = null, bestBw = -1;
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
        const bw = parseInt((/BANDWIDTH=(\d+)/.exec(lines[i]) || [])[1] || "0", 10);
        const next = lines[i + 1];
        if (next && next[0] !== "#" && bw > bestBw) { bestBw = bw; best = next; }
      }
      if (best) return loadPlaylist(new URL(best, url).href, depth + 1);
    }

    let seq = 0, key = null;
    const segments = [];
    for (const line of lines) {
      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
        seq = parseInt(line.split(":")[1], 10) || 0;
      } else if (line.startsWith("#EXT-X-KEY:")) {
        if (/METHOD=AES-128/.test(line)) {
          const uri = /URI="([^"]+)"/.exec(line);
          const iv = /IV=(0x[0-9a-fA-F]+)/.exec(line);
          if (!uri) throw new Error("Ключ без URI");
          key = { uri: new URL(uri[1], url).href, iv: iv ? hexToBytes(iv[1]) : null };
        } else if (/METHOD=NONE/.test(line)) {
          key = null;
        } else {
          throw new Error("Неподдерживаемое шифрование: " + line);
        }
      } else if (line[0] !== "#") {
        segments.push({ url: new URL(line, url).href, key, seq: seq++ });
      }
    }
    if (!segments.length) throw new Error("В плейлисте нет сегментов");
    return segments;
  }

  async function runPool(items, worker, limit) {
    let next = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        await worker(items[i], i);
      }
    });
    await Promise.all(runners);
  }

  // Скачивает и расшифровывает все сегменты, возвращает Uint8Array[] по порядку.
  async function downloadSegments(segments, onProgress) {
    const keys = new Map();
    const getKey = (uri) => {
      if (!keys.has(uri)) {
        keys.set(uri, fetchBuffer(uri).then((raw) => {
          if (raw.byteLength !== 16) throw new Error("Некорректный ключ шифрования");
          return crypto.subtle.importKey("raw", raw, "AES-CBC", false, ["decrypt"]);
        }));
      }
      return keys.get(uri);
    };

    const out = new Array(segments.length);
    let done = 0;
    await runPool(segments, async (seg, i) => {
      let data = await fetchBuffer(seg.url);
      if (seg.key) {
        const key = await getKey(seg.key.uri);
        const iv = seg.key.iv || seqToIv(seg.seq);
        data = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, data);
      }
      out[i] = new Uint8Array(data);
      onProgress && onProgress(++done / segments.length);
    }, CONCURRENCY);
    return out;
  }

  // ---- MPEG-TS -> elementary audio stream ----
  const AUDIO_TYPES = { 0x03: "mp3", 0x04: "mp3", 0x0f: "aac", 0x11: "aac" };

  function* packets(chunks) {
    for (const d of chunks) {
      let i = 0;
      while (i + 188 <= d.length) {
        if (d[i] !== 0x47) { // потеря синхронизации
          const n = d.indexOf(0x47, i + 1);
          if (n < 0) break;
          i = n;
          continue;
        }
        yield [d, i];
        i += 188;
      }
    }
  }

  function payloadStart(d, i) {
    const afc = (d[i + 3] >> 4) & 3;
    if (!(afc & 1)) return -1;
    let o = i + 4;
    if (afc & 2) o += 1 + d[o];
    return o >= i + 188 ? -1 : o;
  }

  function demuxTS(chunks) {
    let pmtPid = -1, audioPid = -1, kind = null;
    for (const [d, i] of packets(chunks)) {
      const pid = ((d[i + 1] & 0x1f) << 8) | d[i + 2];
      const pusi = d[i + 1] & 0x40;
      if (!pusi) continue;
      let o = payloadStart(d, i);
      if (o < 0) continue;
      if (pid === 0 && pmtPid < 0) {
        o += 1 + d[o];
        const end = o + 3 + (((d[o + 1] & 0xf) << 8) | d[o + 2]) - 4;
        for (let p = o + 8; p + 4 <= end && p + 4 <= i + 188; p += 4) {
          if (((d[p] << 8) | d[p + 1]) !== 0) { pmtPid = ((d[p + 2] & 0x1f) << 8) | d[p + 3]; break; }
        }
      } else if (pid === pmtPid && audioPid < 0) {
        o += 1 + d[o];
        const end = o + 3 + (((d[o + 1] & 0xf) << 8) | d[o + 2]) - 4;
        let p = o + 12 + (((d[o + 10] & 0xf) << 8) | d[o + 11]);
        while (p + 5 <= end && p + 5 <= i + 188) {
          if (AUDIO_TYPES[d[p]]) { audioPid = ((d[p + 1] & 0x1f) << 8) | d[p + 2]; kind = AUDIO_TYPES[d[p]]; break; }
          p += 5 + (((d[p + 3] & 0xf) << 8) | d[p + 4]);
        }
      }
      if (audioPid >= 0) break;
    }
    if (audioPid < 0) throw new Error("В потоке не найдено аудио");

    const parts = [];
    let total = 0;
    for (const [d, i] of packets(chunks)) {
      if ((((d[i + 1] & 0x1f) << 8) | d[i + 2]) !== audioPid) continue;
      let o = payloadStart(d, i);
      if (o < 0) continue;
      if (d[i + 1] & 0x40) { // начало PES: пропускаем заголовок
        if (d[o] === 0 && d[o + 1] === 0 && d[o + 2] === 1) o += 9 + d[o + 8];
      }
      if (o >= i + 188) continue;
      const part = d.subarray(o, i + 188);
      parts.push(part);
      total += part.length;
    }
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) { out.set(p, pos); pos += p.length; }
    return { data: out, ext: kind };
  }

  // ---- ID3v2.3 ----
  const enc = new TextEncoder();

  function u32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }

  function frame(id, body) {
    return [...enc.encode(id), ...u32(body.length), 0, 0, ...body];
  }

  function utf16(str) {
    const out = [0xff, 0xfe];
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      out.push(c & 255, c >> 8);
    }
    out.push(0, 0);
    return out;
  }

  function buildID3({ title, artist, cover }) {
    let frames = [];
    if (title) frames = frames.concat(frame("TIT2", [1, ...utf16(title)]));
    if (artist) frames = frames.concat(frame("TPE1", [1, ...utf16(artist)]));
    let coverBytes = null;
    if (cover && cover.length > 4) {
      const mime = cover[0] === 0x89 ? "image/png" : "image/jpeg";
      const head = [0, ...enc.encode(mime), 0, 3, 0];
      const body = new Uint8Array(head.length + cover.length);
      body.set(head, 0);
      body.set(cover, head.length);
      coverBytes = frame("APIC", body);
    }
    if (!frames.length && !coverBytes) return new Uint8Array(0);
    const fb = Uint8Array.from(frames);
    const size = fb.length + (coverBytes ? coverBytes.length : 0);
    const synchsafe = [(size >> 21) & 127, (size >> 14) & 127, (size >> 7) & 127, size & 127];
    const out = new Uint8Array(10 + size);
    out.set([0x49, 0x44, 0x33, 3, 0, 0, ...synchsafe], 0);
    out.set(fb, 10);
    if (coverBytes) out.set(coverBytes, 10 + fb.length);
    return out;
  }

  // В потоке VK есть собственный ID3-тег (Lavf) — убираем, чтобы не дублировать наш.
  function stripLeadingID3(d) {
    while (d.length > 10 && d[0] === 0x49 && d[1] === 0x44 && d[2] === 0x33) {
      const size = ((d[6] & 127) << 21) | ((d[7] & 127) << 14) | ((d[8] & 127) << 7) | (d[9] & 127);
      d = d.subarray(10 + size + (d[5] & 0x10 ? 10 : 0));
    }
    return d;
  }

  async function fetchCover(url) {
    try {
      const buf = await fetchBuffer(url);
      return new Uint8Array(buf);
    } catch (e) {
      return null;
    }
  }

  // Основная функция: url m3u8 (или прямой mp3) -> { blob, ext }
  async function downloadTrack(url, meta, onProgress) {
    const progress = onProgress || (() => {});
    if (!/\.m3u8(\?|$)/i.test(url)) {
      const buf = await fetchBuffer(url);
      progress(1);
      return { blob: new Blob([buf], { type: "audio/mpeg" }), ext: "mp3" };
    }
    const segments = await loadPlaylist(url);
    const chunks = await downloadSegments(segments, (p) => progress(p * 0.95));
    const demuxed = demuxTS(chunks);
    const data = stripLeadingID3(demuxed.data);
    const ext = demuxed.ext;
    const cover = meta && meta.coverUrl ? await fetchCover(meta.coverUrl) : null;
    const tag = buildID3({ title: meta && meta.title, artist: meta && meta.artist, cover });
    progress(1);
    return {
      blob: new Blob([tag, data], { type: ext === "mp3" ? "audio/mpeg" : "audio/aac" }),
      ext,
    };
  }

  root.__vkdlHls = { downloadTrack };
})(typeof window !== "undefined" ? window : globalThis);
