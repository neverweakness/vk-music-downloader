// VK Music Downloader — добавляет кнопку скачивания к каждому треку.
// Работает в контексте страницы (world: MAIN), чтобы использовать vk.id и cookies сессии.
(function () {
  if (window.__vkdlLoaded) return;
  window.__vkdlLoaded = true;

  const unmask = window.__vkdlUnmask;
  const hls = window.__vkdlHls;

  const ICON_DOWNLOAD =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/></svg>';
  const ICON_CHECK =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const ICON_ERROR =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 6v8"/><path d="M12 18v.01"/></svg>';

  // ---------- VK API ----------
  async function alAudio(act, params) {
    const body = new URLSearchParams(Object.assign({ act, al: "1" }, params));
    const res = await fetch("/al_audio.php?act=" + act, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
      },
      body,
    });
    if (!res.ok) throw new Error("VK вернул HTTP " + res.status);
    const text = await res.text();
    const json = JSON.parse(text.slice(text.indexOf("{")));
    const list = json && json.payload && json.payload[1] && json.payload[1][0];
    if (!Array.isArray(list) || !list.length) throw new Error("VK не вернул данные о треке");
    return list[0];
  }

  // tuple: [id, ownerId, url, title, performer, duration, ..., 13: hashes, 14: covers]
  async function fetchTrack(fullId) {
    let tuple = await alAudio("reload_audios", { audio_ids: fullId });
    let url = tuple[2] && unmask(tuple[2]);
    if (!url) {
      // Запасной путь: запрос ссылки по хэшам
      const h = String(tuple[13] || "").split("/");
      if (h[2] && h[5]) {
        const ids = tuple[1] + "_" + tuple[0] + "_" + h[2] + "_" + h[5];
        tuple = await alAudio("reload_audio", { ids });
        url = tuple[2] && unmask(tuple[2]);
      }
    }
    if (!url) throw new Error("Трек недоступен для скачивания (нет ссылки)");
    if (url.indexOf("audio_api_unavailable") !== -1) throw new Error("Не удалось расшифровать ссылку");
    return { tuple, url };
  }

  // ---------- Утилиты ----------
  const decodeEl = document.createElement("textarea");
  function decodeHtml(s) {
    decodeEl.innerHTML = String(s || "");
    return decodeEl.value.replace(/\s+/g, " ").trim();
  }

  function safeName(s) {
    return s
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(/[. ]+$/g, "")
      .slice(0, 150);
  }

  function saveBlob(blob, filename) {
    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 30000);
  }

  // ---------- Кнопка ----------
  function setState(btn, state, text) {
    btn.dataset.state = state;
    if (state === "idle") { btn.innerHTML = ICON_DOWNLOAD; btn.title = "Скачать трек"; }
    else if (state === "done") { btn.innerHTML = ICON_CHECK; btn.title = "Скачано"; }
    else if (state === "error") { btn.innerHTML = ICON_ERROR; btn.title = "Ошибка: " + text + " (нажмите, чтобы повторить)"; }
    else if (state === "loading") { btn.title = "Скачивание…"; }
  }

  function setProgress(btn, p) {
    const pct = Math.round(p * 100);
    btn.innerHTML =
      '<span class="vkdl-ring" style="--p:' + pct + '"></span><span class="vkdl-pct">' + pct + "</span>";
  }

  function createButton(getInfo) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "vkdl-btn";
    setState(btn, "idle");

    btn.__vkdlClick = async () => {
      if (btn.dataset.state === "loading") return;
      const info = getInfo();
      if (!info || !info.fullId) { setState(btn, "error", "не удалось определить трек"); return; }
      setState(btn, "loading");
      setProgress(btn, 0);
      try {
        const { tuple, url } = await fetchTrack(info.fullId);
        const title = info.title || decodeHtml(tuple[3]);
        const artist = info.artist || decodeHtml(tuple[4]);
        const covers = String(tuple[14] || "").split(/,(?=https?:)/);
        const meta = { title, artist, coverUrl: covers[0] || "" };
        const { blob, ext } = await hls.downloadTrack(url, meta, (p) => setProgress(btn, p));
        const base = safeName(artist && title ? artist + " - " + title : title || artist || info.fullId);
        saveBlob(blob, base + "." + ext);
        setState(btn, "done");
        setTimeout(() => { if (btn.dataset.state === "done") setState(btn, "idle"); }, 3000);
      } catch (err) {
        console.error("[VK Music Downloader]", err);
        setState(btn, "error", (err && err.message) || String(err));
      }
    };
    return btn;
  }

  // VK вешает обработчики на корень строки (в т.ч. в capture-фазе) — воспроизведение
  // запускалось бы вместе с загрузкой. Перехватываем события кнопки раньше всех.
  ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend", "dblclick", "contextmenu", "click"].forEach(
    (type) => {
      window.addEventListener(
        type,
        (e) => {
          const btn = e.target && e.target.closest && e.target.closest(".vkdl-btn");
          if (!btn) return;
          e.stopImmediatePropagation();
          if (type === "click") {
            e.preventDefault();
            if (btn.__vkdlClick) btn.__vkdlClick();
          }
        },
        true
      );
    }
  );

  // ---------- Интеграция в интерфейс VK ----------
  // Новый интерфейс: [data-testid="MusicTrackRow"]
  function processModernRow(row) {
    if (row.dataset.vkdl) return;
    const titleLink = row.querySelector('[data-testid="MusicTrackRow_Title"]');
    if (!titleLink) return;
    const m = /\/audio(-?\d+_\d+)(?:_([0-9a-f]+))?/i.exec(titleLink.getAttribute("href") || "");
    if (!m) return;
    row.dataset.vkdl = "1";

    const getInfo = () => {
      const t = row.querySelector('[data-testid="MusicTrackRow_Title"]');
      const a = row.querySelector('[data-testid="MusicTrackRow_Authors"]');
      return {
        fullId: m[1] + (m[2] ? "_" + m[2] : ""),
        title: t ? decodeHtml(t.textContent) : "",
        artist: a ? decodeHtml(a.textContent) : "",
      };
    };
    const btn = createButton(getInfo);
    btn.classList.add("vkdl-modern");
    const host = titleLink.closest("span") || titleLink;
    host.parentElement.insertBefore(btn, host.nextSibling);
    // React может перерисовать строку и убрать кнопку — вернём её при следующем скане
    btn.__vkdlRow = row;
  }

  // Классический интерфейс: .audio_row
  function processLegacyRow(row) {
    if (row.dataset.vkdl) return;
    const fullId = row.getAttribute("data-full-id");
    const actions = row.querySelector(".audio_row__actions");
    if (!fullId || !actions) return;
    row.dataset.vkdl = "1";
    const getInfo = () => {
      const t = row.querySelector(".audio_row__title_inner");
      const a = row.querySelector(".audio_row__performers");
      return {
        fullId: fullId.split("_").slice(0, 2).join("_"),
        title: t ? decodeHtml(t.textContent) : "",
        artist: a ? decodeHtml(a.textContent) : "",
      };
    };
    const btn = createButton(getInfo);
    btn.classList.add("vkdl-legacy");
    actions.insertBefore(btn, actions.firstChild);
  }

  function scan(root) {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll('[data-testid="MusicTrackRow"]').forEach(processModernRow);
    scope.querySelectorAll(".audio_row[data-full-id]").forEach(processLegacyRow);
    // Строки, у которых React удалил нашу кнопку, помечаем заново
    scope.querySelectorAll('[data-testid="MusicTrackRow"][data-vkdl]').forEach((row) => {
      if (!row.querySelector(".vkdl-btn")) { delete row.dataset.vkdl; processModernRow(row); }
    });
  }

  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; scan(document); });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scan(document);
})();
