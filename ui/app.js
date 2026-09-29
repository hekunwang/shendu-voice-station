"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const state = { authenticated: false, csrf: "", user: null, voices: [], portraits: {}, voiceId: "", showCatalog: false, jobs: [], settings: {max_text_length:300, accepting_jobs:true}, catalogAt:0, filter: "all", submitting: false, requestKey: "", requestFingerprint: "", busyJobs: new Set(), epoch: 0, polling: false, pollTimer: null, toastTimer: null, deleteId: null };
  const nodes = new Map();
  let nextBefore = null, historyPages = 1, queryRevision = 0, refreshPending = false, historySearchTimer = null;
  const activeStatuses = new Set(["queued", "running"]);
  const statusLabels = { queued: "等待生成", running: "正在生成", completed: "已完成", cancelled: "已取消", canceled: "已取消", failed: "生成失败" };

  class ApiError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  }

  function messageFromError(value, fallback) {
    if (typeof value === "string" && value.trim()) return value;
    if (value && typeof value === "object") return value.message || value.detail || fallback;
    return fallback;
  }

  async function api(path, options = {}) {
    const requestEpoch = state.epoch;
    const method = options.method || "GET";
    const headers = { Accept: "application/json" };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (method !== "GET" && state.csrf) headers["X-CSRF-Token"] = state.csrf;
    let response;
    try { response = await fetch(path, { method, headers, credentials: "same-origin", cache: "no-store", body: options.body === undefined ? undefined : JSON.stringify(options.body) }); }
    catch (_) { throw new ApiError("暂时连接不上声馆，请检查网络后重试。", 0); }
    let data;
    try { data = await response.json(); }
    catch (_) { throw new ApiError("声馆暂时没有正常回应，请稍后重试。", response.status); }
    if (!response.ok) {
      if (response.status === 401 && state.authenticated && requestEpoch === state.epoch) showLoggedOut("登录已过期，请重新登录。", true);
      const fallback = response.status === 429 ? "请求过于频繁，请稍等再试。" : response.status === 403 ? "这次操作未通过验证，请刷新页面后重试。" : "这次操作没有完成，请稍后重试。";
      throw new ApiError(messageFromError(data.error || data.message, fallback), response.status);
    }
    return data;
  }

  function setError(id, message = "") { $(id).textContent = message; $(id).hidden = !message; }
  function setText(element, value) { if (element.textContent !== value) element.textContent = value; }
  function toast(message) {
    clearTimeout(state.toastTimer);
    $("toast").textContent = message; $("toast").hidden = false;
    state.toastTimer = setTimeout(() => { $("toast").hidden = true; }, 4200);
  }
  function uuid() {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  function isAuthenticated(data) { return data.authenticated === true || Boolean(data.user); }
  function mediaUrl(value, fallback) {
    if (typeof value !== "string") return fallback;
    try { const url = new URL(value, location.origin); return url.origin === location.origin && url.pathname.startsWith("/api/") ? `${url.pathname}${url.search}` : fallback; }
    catch (_) { return fallback; }
  }

  function makeAvatar(voiceId, name, extraClass = "") {
    const avatar = document.createElement("span"); avatar.className = `voice-avatar ${extraClass}`.trim();
    avatar.setAttribute("aria-hidden", "true"); avatar.dataset.voiceId = String(voiceId);
    const fallback = document.createElement("span"); fallback.className = "avatar-fallback";
    fallback.textContent = Array.from(String(name))[0] || "声"; avatar.append(fallback);
    const source = state.portraits[String(voiceId)];
    if (typeof source === "string" && /^\/portraits\/[a-f0-9]{16,64}\.webp$/.test(source)) {
      const image = document.createElement("img"); image.alt = ""; image.width = 96; image.height = 96;
      image.loading = extraClass ? "eager" : "lazy"; image.decoding = "async";
      image.addEventListener("load", () => avatar.classList.add("has-portrait"));
      image.addEventListener("error", () => { image.remove(); avatar.classList.remove("has-portrait"); }, { once: true });
      image.src = source; avatar.append(image);
    }
    return avatar;
  }

  function makeAudioPlayer(audio, initialLabel) {
    const parent = audio.parentNode; const next = audio.nextSibling;
    const element = document.createElement("div"); element.className = "audio-player";
    const toggle = document.createElement("button"); toggle.type = "button"; toggle.className = "audio-toggle";
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.classList.add("audio-icon"); icon.setAttribute("viewBox", "0 0 24 24"); icon.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("fill", "currentColor"); icon.append(path); toggle.append(icon);
    const track = document.createElement("div"); track.className = "audio-track";
    const seek = document.createElement("input"); seek.className = "audio-seek"; seek.type = "range"; seek.min = "0"; seek.max = "1000"; seek.step = "1"; seek.value = "0"; seek.disabled = true;
    track.append(seek);
    const clock = document.createElement("span"); clock.className = "audio-clock";
    audio.controls = false; audio.hidden = true;
    element.append(audio, toggle, track, clock);
    if (parent) parent.insertBefore(element, next);
    let label = initialLabel; let durationHint = 0; let loading = false; let failed = false;
    const formatTime = (seconds) => {
      const whole = Math.max(0, Math.floor(Number(seconds) || 0));
      return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
    };
    function sync() {
      const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
      const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
      const playing = !audio.paused && !audio.ended;
      toggle.disabled = !audio.hasAttribute("src");
      toggle.setAttribute("aria-label", `${playing ? "暂停" : "播放"}${label}`);
      toggle.title = `${playing ? "暂停" : "播放"}${label}`;
      toggle.setAttribute("aria-pressed", String(playing));
      path.setAttribute("d", playing ? "M7 5h4v14H7zm6 0h4v14h-4z" : "M8 5v14l11-7z");
      seek.disabled = !duration;
      seek.value = duration ? String(Math.round(Math.min(1, current / duration) * 1000)) : "0";
      seek.setAttribute("aria-label", `${label}播放进度`);
      seek.setAttribute("aria-valuetext", `${formatTime(current)}，共 ${formatTime(duration || durationHint)}`);
      clock.textContent = failed ? "加载失败" : loading ? "加载中…" : `${formatTime(current)} / ${formatTime(duration || durationHint)}`;
      element.classList.toggle("playing", playing);
      element.classList.toggle("loading", loading);
      element.classList.toggle("error", failed);
      element.setAttribute("aria-busy", String(loading));
    }
    toggle.addEventListener("click", async () => {
      if (!audio.paused) { audio.pause(); return; }
      failed = false; loading = true; sync();
      if (audio.error) audio.load();
      try { await audio.play(); }
      catch (error) {
        if (error.name === "AbortError") return;
        loading = false; failed = true; sync();
        toast("音频暂时无法播放，请稍后重试。");
      }
    });
    seek.addEventListener("input", () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        audio.currentTime = Number(seek.value) / 1000 * audio.duration; sync();
      }
    });
    audio.addEventListener("play", () => {
      for (const other of document.querySelectorAll("audio")) if (other !== audio && !other.paused) other.pause();
      failed = false; sync();
    });
    audio.addEventListener("waiting", () => { loading = true; sync(); });
    audio.addEventListener("playing", () => { loading = false; failed = false; sync(); });
    audio.addEventListener("pause", () => { loading = false; sync(); });
    audio.addEventListener("ended", () => { loading = false; sync(); });
    audio.addEventListener("emptied", () => { loading = false; failed = false; sync(); });
    audio.addEventListener("error", () => { loading = false; failed = audio.hasAttribute("src"); sync(); });
    for (const event of ["loadedmetadata", "durationchange", "timeupdate", "seeked"]) audio.addEventListener(event, sync);
    sync();
    return {
      element,
      setLabel(value) { label = value; sync(); },
      setDurationHint(value) { durationHint = Number(value) > 0 ? Number(value) : 0; sync(); }
    };
  }
  const referencePlayer = makeAudioPlayer($("reference-player"), "原声样本");

  function showLoggedOut(message = "", clearDraft = false) {
    clearTimeout(state.pollTimer);
    state.authenticated = false; state.user = null; state.csrf = ""; state.epoch += 1;
    $("admin-link").hidden = true;
    state.voices = []; state.voiceId = ""; state.showCatalog = false; state.jobs = []; state.busyJobs.clear();
    nextBefore = null; historyPages = 1; queryRevision++; state.storageBlocked = false;
    clearTimeout(historySearchTimer); $("history-voice").value = "";
    $("login-view").hidden = false; $("station-view").hidden = true;
    $("account-actions").hidden = true; $("private-label").hidden = false;
    $("reference-player").pause(); $("reference-player").removeAttribute("src"); $("reference-player").load();
    for (const card of nodes.values()) card.element.querySelector("audio").pause();
    nodes.clear(); $("jobs-list").replaceChildren(); $("voice-list").replaceChildren();
    if (clearDraft) { $("speech-text").value = ""; $("voice-search").value = ""; state.requestKey = ""; state.requestFingerprint = ""; }
    setError("login-error", message); $("password").value = "";
    if ($("delete-dialog").open) $("delete-dialog").close();
  }

  async function showAuthenticated(data) {
    if (!isAuthenticated(data) || !data.user || !data.csrf_token) throw new ApiError("登录状态未完整返回，请重新登录。", 0);
    state.authenticated = true; state.user = data.user; state.csrf = data.csrf_token; state.epoch += 1;
    $("admin-link").hidden = data.user.role !== "admin";
    $("login-view").hidden = true; $("station-view").hidden = false;
    $("account-actions").hidden = false; $("private-label").hidden = true;
    $("account-name").textContent = data.user.display_name || data.user.username;
    setError("login-error"); setError("generation-error"); updateForm();
    const epoch = state.epoch;
    try {
      const [catalog, portraits] = await Promise.all([api("/api/voices"), api("/portraits.json").catch(() => ({ portraits: {} }))]);
      if (!state.authenticated || epoch !== state.epoch) return;
      state.voices = Array.isArray(catalog.voices) ? catalog.voices : [];
      state.settings = catalog.settings || {max_text_length:300, accepting_jobs:true}; state.catalogAt = Date.now();
      state.portraits = portraits.portraits && typeof portraits.portraits === "object" ? portraits.portraits : {};
      const defaultVoice = state.voices.find((voice) => voice.id === "female" && voice.available) || state.voices.find((voice) => voice.available);
      state.voiceId = defaultVoice ? String(defaultVoice.id) : "";
      renderVoices(); renderSelectedVoice(); updateWorker(catalog.worker);
      await refreshJobs();
    } catch (error) {
      if (state.authenticated) { setError("generation-error", error.message); setConnectionFailure(); }
    }
  }

  function updateWorker(worker = {}, queue) {
    const ready = worker.ready === true;
    $("service-dot").className = `state-dot ${ready ? "ready" : "offline"}`;
    setText($("service-title"), ready ? "声馆在线" : "等待生成设备");
    setText($("service-detail"), ready ? "按提交顺序处理请求" : "仍可提交，设备恢复后继续生成");
    $("service-notice").hidden = ready;
    $("service-notice").textContent = "生成设备暂未就绪。你可以先提交请求，队列会保留原来的顺序，设备恢复后继续处理。";
    if (queue) {
      const running = Number(queue.active_count) || 0; const queued = Number(queue.queued_count) || 0;
      $("queue-summary-title").textContent = running || queued ? `全站队列：${running} 条生成中 · ${queued} 条等待中` : "队列空闲，可以提交新的台词";
    }
  }

  function setConnectionFailure() {
    $("service-dot").className = "state-dot error";
    $("service-title").textContent = "连接暂时中断";
    $("service-detail").textContent = "正在重试，已有请求不会重复提交";
    $("service-notice").hidden = false;
    $("service-notice").textContent = "暂时无法更新队列，下面显示的是上次获取的状态。连接恢复后会自动更新。";
  }

  function renderVoices() {
    const search = $("voice-search").value.trim().toLocaleLowerCase();
    const priority = (voice) => voice.id === "female" ? 2 : voice.id === "xiwangmu" ? 1 : 0;
    const matching = state.voices.filter((voice) => String(voice.name).toLocaleLowerCase().includes(search) && (search || state.showCatalog || voice.available)).sort((a, b) => Number(Boolean(b.available)) - Number(Boolean(a.available)) || priority(b) - priority(a));
    const availableCount = state.voices.filter((voice) => voice.available).length;
    $("voice-count").textContent = `${availableCount} 个可用声线`;
    if ($("library-total")) $("library-total").textContent = String(state.voices.length);
    if ($("available-total")) $("available-total").textContent = String(availableCount);
    if ($("catalog-toggle")) {
      $("catalog-toggle").textContent = state.showCatalog ? "收起待开放角色" : `查看全部 ${state.voices.length} 个角色`;
      $("catalog-toggle").setAttribute("aria-expanded", String(state.showCatalog));
      $("catalog-toggle").hidden = Boolean(search) || availableCount === state.voices.length;
    }
    $("empty-voices").hidden = matching.length !== 0;
    const fragment = document.createDocumentFragment();
    for (const voice of matching) {
      const button = document.createElement("button"); button.type = "button";
      button.className = `voice-option${voice.available ? "" : " unavailable"}`;
      button.setAttribute("aria-pressed", String(String(voice.id) === state.voiceId));
      button.setAttribute("aria-label", `${voice.name}，${voice.available ? "可用" : "待开放"}`);
      const female = String(voice.name).includes("女主"); const queen = String(voice.name).includes("西王母");
      button.dataset.tone = female ? "jade" : queen ? "gold" : "slate";
      const avatar = makeAvatar(voice.id, voice.name);
      const copy = document.createElement("span"); copy.className = "voice-copy";
      const name = document.createElement("span"); name.className = "voice-name"; name.textContent = voice.name;
      const status = document.createElement("span"); status.className = "voice-status"; status.textContent = voice.available ? "原声已就绪" : "样本整理中";
      copy.append(name, status);
      const tick = document.createElement("span"); tick.className = "voice-tick"; tick.textContent = "✓"; tick.setAttribute("aria-hidden", "true");
      button.append(avatar, copy, tick);
      button.addEventListener("click", () => {
        if (!voice.available) { toast("这个角色的原声样本还在整理，请先选择已开放的声线。"); return; }
        state.voiceId = String(voice.id);
        for (const item of $("voice-list").children) item.setAttribute("aria-pressed", String(item === button));
        renderSelectedVoice(); updateForm(); setError("generation-error");
      });
      fragment.append(button);
    }
    $("voice-list").replaceChildren(fragment);
  }

  function renderSelectedVoice() {
    const voice = state.voices.find((v) => String(v.id) === state.voiceId);
    $("selected-voice").hidden = !voice;
    if (!voice) { updateForm(); return; }
    $("selected-voice-name").textContent = voice.name;
    $("selected-voice-avatar").replaceChildren(makeAvatar(voice.id, voice.name, "reference-avatar"));
    if ($("selected-mini-name")) $("selected-mini-name").textContent = voice.name;
    $("selected-voice-description").textContent = "取自游戏完整对白，先听听熟悉的声音。";
    const seconds = Number(voice.reference_seconds);
    $("reference-seconds").textContent = seconds > 0 ? `${seconds.toFixed(1)} 秒` : "";
    const url = mediaUrl(voice.reference_url, `/api/voices/${encodeURIComponent(voice.id)}/reference`);
    if ($("reference-player").getAttribute("src") !== url) { $("reference-player").pause(); $("reference-player").src = url; }
    referencePlayer.setLabel(`${voice.name}原声样本`); referencePlayer.setDurationHint(seconds);
    updateForm();
  }

  function updateForm() {
    const count = Array.from($("speech-text").value).length;
    const text = $("speech-text").value.trim();
    const voice = state.voices.find((v) => String(v.id) === state.voiceId);
    const limit = state.settings.max_text_length || 300;
    $("character-count").textContent = `${count} / ${limit}`;
    $("character-count").classList.toggle("over-limit", count > limit);
    const pending = state.jobs.filter(j => activeStatuses.has(j.status)).length;
    const full = pending >= (state.settings.max_pending_jobs || 3);
    $("generate-button").disabled = state.submitting || !state.authenticated || !voice || !voice.available || !text || count > limit || !state.settings.accepting_jobs || full || state.storageBlocked;
    $("generate-button-label").textContent = state.submitting ? "正在提交…" : !state.settings.accepting_jobs ? "暂停接收任务" : "生成语音";
    $("text-help").textContent = state.storageBlocked ? "存储空间不足，暂时停止接收新请求。" : !state.settings.accepting_jobs ? "管理员已暂停接收新任务，已有任务继续处理。" : `待处理 ${pending} / ${state.settings.max_pending_jobs || 3} 条${full ? "，请等待完成或取消一条请求。" : "，按提交顺序生成。"}`;
  }

  function makeJobCard(job) {
    const element = document.createElement("article"); element.className = "job-card";
    const top = document.createElement("div"); top.className = "job-top";
    const name = document.createElement("strong"); name.className = "job-name";
    const status = document.createElement("span"); status.className = "job-status";
    const identity = document.createElement("div"); identity.className = "job-identity";
    const avatar = makeAvatar(job.voice_id, job.voice_name || "角色", "job-avatar");
    identity.append(avatar, name); top.append(identity, status);
    const text = document.createElement("p"); text.className = "job-text";
    const detail = document.createElement("p"); detail.className = "job-detail"; detail.setAttribute("aria-live", "polite");
    const error = document.createElement("p"); error.className = "job-error";
    const audio = document.createElement("audio"); audio.className = "job-audio"; audio.controls = true; audio.preload = "none";
    const player = makeAudioPlayer(audio, "角色生成语音"); player.element.hidden = true;
    const bottom = document.createElement("div"); bottom.className = "job-bottom";
    const time = document.createElement("time"); time.className = "job-time";
    const actions = document.createElement("div"); actions.className = "job-actions";
    const download = document.createElement("a"); download.className = "job-action download"; download.textContent = "下载音频"; download.setAttribute("download", "");
    const cancel = document.createElement("button"); cancel.className = "job-action cancel"; cancel.type = "button"; cancel.textContent = "取消排队";
    cancel.addEventListener("click", () => cancelJob(String(job.id)));
    const remove = document.createElement("button"); remove.className = "job-action delete"; remove.type = "button"; remove.textContent = "删除";
    remove.addEventListener("click", () => confirmDelete(String(job.id)));
    const restore = document.createElement("button"); restore.className = "job-action"; restore.type = "button"; restore.textContent = "恢复记录";
    restore.addEventListener("click", () => restoreJob(String(job.id)));
    actions.append(download, cancel, remove, restore); bottom.append(time, actions);
    element.append(top, text, detail, error, player.element, bottom);
    return { element, name, status, text, detail, error, audio, player, time, download, cancel, remove, restore };
  }

  function updateJobCard(card, job) {
    const status = String(job.status); const busy = state.busyJobs.has(String(job.id));
    card.element.className = `job-card ${status}`;
    card.name.textContent = job.voice_name || state.voices.find((v) => String(v.id) === String(job.voice_id))?.name || "角色语音";
    card.status.textContent = job.cancel_requested && status === "running" ? "正在取消" : statusLabels[status] || "等待更新";
    card.text.textContent = job.text || "";
    let detail = "";
    if (status === "queued") {
      const position = Number(job.queue_position); const ahead = job.ahead_count == null ? position - 1 : Number(job.ahead_count);
      detail = position > 0 ? `当前排在第 ${position} 位` : "已加入队列，正在更新位置";
      if (position > 0 && Number.isFinite(ahead) && ahead >= 0) detail += ahead > 0 ? ` · 前面还有 ${ahead} 条请求` : " · 接下来轮到你";
    } else if (status === "running") {
      const phase = {loading:"正在加载模型", generating:"正在生成", uploading:"正在上传音频"}[job.phase] || "正在生成";
      detail = job.cancel_requested ? "已申请取消，正在停止生成。" : `${phase}${job.total_segments ? ` · 已完成 ${job.completed_segments || 0} / ${job.total_segments} 句` : ""}${job.elapsed_seconds ? ` · 已用时 ${Math.floor(job.elapsed_seconds / 60)} 分 ${Math.floor(job.elapsed_seconds % 60)} 秒` : ""}`;
    }
    if (job.deleted_at) detail = `已移入回收站 · ${job.restore_until ? new Date(job.restore_until * 1000).toLocaleDateString("zh-CN") + "前可恢复" : "保留 7 天"}`;
    setText(card.detail, detail); card.detail.hidden = !detail;
    const error = status === "failed" ? messageFromError(job.error, "这次生成没有完成，可以重新提交这段台词。") : "";
    card.error.textContent = error; card.error.hidden = !error;
    const completed = status === "completed" && !job.deleted_at;
    card.player.element.hidden = !completed; card.download.hidden = !completed;
    if (completed) {
      const url = mediaUrl(job.audio_url, `/api/jobs/${encodeURIComponent(job.id)}/audio`);
      if (card.audio.getAttribute("src") !== url) card.audio.src = url;
      card.audio.setAttribute("aria-label", `${card.name.textContent}生成语音`);
      card.player.setLabel(`${card.name.textContent}生成语音`); card.player.setDurationHint(job.duration_seconds);
      card.download.href = `${url}${url.includes("?") ? "&" : "?"}download=1`;
    }
    const created = new Date(typeof job.created_at === "number" ? job.created_at * 1000 : job.created_at);
    card.time.textContent = Number.isNaN(created.getTime()) ? "" : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(created);
    if (!Number.isNaN(created.getTime())) card.time.dateTime = created.toISOString();
    card.cancel.hidden = !activeStatuses.has(status);
    card.cancel.textContent = status === "running" ? "取消生成" : "取消排队";
    card.cancel.disabled = busy || Boolean(job.cancel_requested);
    card.remove.disabled = busy;
    card.remove.hidden = !!job.deleted_at; card.restore.hidden = !job.deleted_at; card.restore.disabled = busy;
    if (job.deleted_at) card.cancel.hidden = true;
  }

  function renderJobs() {
    const allIds = new Set(state.jobs.map((job) => String(job.id)));
    for (const [id, card] of nodes) if (!allIds.has(id)) { card.audio.pause(); card.element.remove(); nodes.delete(id); }
    let visible = 0;
    let previousElement = null;
    for (const job of state.jobs) {
      const id = String(job.id); let card = nodes.get(id);
      if (!card) { card = makeJobCard(job); nodes.set(id, card); }
      updateJobCard(card, job);
      const matches = activeStatuses.has(String(job.status)) || (state.filter === "deleted" ? !!job.deleted_at : !job.deleted_at && (state.filter === "all" || state.filter === job.status));
      card.element.hidden = !matches;
      if (!matches && !card.audio.paused) card.audio.pause();
      // Keep existing audio elements attached across polls, so playback and focus survive.
      if (previousElement === null) {
        if ($("jobs-list").firstElementChild !== card.element) $("jobs-list").prepend(card.element);
      } else if (previousElement.nextElementSibling !== card.element) previousElement.after(card.element);
      previousElement = card.element;
      if (matches) visible += 1;
    }
    $("request-count").textContent = `${state.jobs.length} 条`;
    $("empty-jobs").hidden = visible !== 0;
    $("empty-jobs-title").textContent = state.filter === "all" ? "第一段声音，从这里开始" : state.filter === "active" ? "目前没有等待中的请求" : state.filter === "deleted" ? "回收站为空" : "没有符合筛选条件的记录";
    $("empty-jobs-description").textContent = state.filter === "all" ? "选一个角色，写下你想听的台词。\n提交后，可以在这里查看排队位置。" : state.filter === "active" ? "提交新的台词后，可以在这里查看进度。" : state.filter === "deleted" ? "删除的作品会在这里保留 7 天。" : "可以切换状态或角色，查看其他记录。";
    if ($("history-voice").value.trim() && state.filter !== "active") {
      $("empty-jobs-title").textContent = "没有匹配的历史记录";
      $("empty-jobs-description").textContent = "试试角色名字的一部分，或清空搜索查看全部记录。";
    }
  }

  async function refreshJobs() {
    if (!state.authenticated) return;
    if (state.polling) { refreshPending = true; return; }
    state.polling = true; const epoch = state.epoch;
    try {
      const revision = queryRevision;
      let data = await api(jobQuery());
      let history = data.history_jobs || []; let cursor = data.next_before;
      for (let page = 1; page < historyPages && cursor; page++) { const older = await api(jobQuery(cursor)); history.push(...(older.history_jobs || [])); cursor = older.next_before; }
      if (!state.authenticated || epoch !== state.epoch) return;
      if (revision !== queryRevision) return;
      state.jobs = data.active_jobs ? [...data.active_jobs, ...history] : data.jobs || []; nextBefore = cursor;
      $("more-history").hidden = !nextBefore || state.filter === "active";
      state.storageBlocked = data.storage?.accepting_jobs === false;
      state.settings = data.settings || state.settings; updateForm();
      renderJobs(); updateWorker(data.worker, data.queue);
      if (Date.now() - state.catalogAt > 30000) {
        const catalog = await api("/api/voices");
        if (!state.authenticated || epoch !== state.epoch) return;
        state.voices = catalog.voices || []; state.catalogAt = Date.now();
        if (!state.voices.some(v => String(v.id) === state.voiceId)) state.voiceId = String(state.voices.find(v => v.available)?.id || "");
        renderVoices(); renderSelectedVoice();
      }
    } catch (error) { if (state.authenticated && epoch === state.epoch) setConnectionFailure(); }
    finally { state.polling = false; if (refreshPending && state.authenticated) { refreshPending = false; clearTimeout(state.pollTimer); state.pollTimer = setTimeout(refreshJobs, 0); } else schedulePoll(); }
  }
  function jobQuery(before) { const q = new URLSearchParams(); if (before) q.set("before", before); const voiceQuery = $("history-voice").value.trim(); if (voiceQuery) q.set("voice_query", voiceQuery); if (state.filter === "deleted") q.set("deleted", "1"); else if (!["all","active"].includes(state.filter)) q.set("status", state.filter); return `/api/jobs?${q}`; }
  async function restoreJob(id) { if (state.busyJobs.has(id)) return; state.busyJobs.add(id); renderJobs(); try { await api(`/api/jobs/${id}/restore`, {method:"POST",body:{}}); await refreshJobs(); toast("记录已恢复，已取消的任务不会重新排队。"); } catch(e) { toast(e.message); } finally { state.busyJobs.delete(id); renderJobs(); } }

  function schedulePoll() {
    clearTimeout(state.pollTimer);
    if (!state.authenticated) return;
    const active = state.jobs.some((job) => activeStatuses.has(String(job.status)));
    state.pollTimer = setTimeout(() => {
      if (document.hidden) schedulePoll(); else refreshJobs();
    }, active ? 3000 : 15000);
  }

  async function cancelJob(id) {
    if (state.busyJobs.has(id)) return;
    state.busyJobs.add(id); renderJobs();
    try { await api(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: {} }); await refreshJobs(); toast("取消申请已提交，队列会自动更新。"); }
    catch (error) { toast(error.message); }
    finally { state.busyJobs.delete(id); renderJobs(); }
  }

  function confirmDelete(id) {
    const job = state.jobs.find((item) => String(item.id) === id);
    if (!job || state.busyJobs.has(id)) return;
    state.deleteId = id;
    $("delete-dialog").returnValue = "";
    $("delete-dialog-description").textContent = activeStatuses.has(String(job.status)) ? "这条请求会从你的记录中移除。等待中的请求会立即取消；正在生成的请求会在当前句结束后停止。" : "这条请求和生成结果会从你的记录中移除。请先下载你想保留的音频。";
    $("delete-dialog-description").textContent += " 删除后可在回收站恢复记录，音频保留 7 天，之后可永久回收。";
    $("delete-dialog").showModal();
  }

  async function deleteJob(id) {
    if (state.busyJobs.has(id)) return;
    state.busyJobs.add(id); renderJobs();
    try {
      await api(`/api/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
      state.jobs = state.jobs.filter((job) => String(job.id) !== id); renderJobs();
      await refreshJobs(); toast("请求已删除。");
    } catch (error) { toast(error.message); }
    finally { state.busyJobs.delete(id); renderJobs(); }
  }

  let registrationMode = false;
  $("auth-toggle").addEventListener("click", () => {
    registrationMode = !registrationMode; setError("login-error");
    $("auth-heading").textContent = registrationMode ? "创建你的声馆账号" : "欢迎回到声馆";
    $("auth-description").textContent = registrationMode ? "设置用户名和密码，即可开始创作。" : "用你的账户，开启今天的创作。";
    $("auth-toggle").textContent = registrationMode ? "已有账号？返回登录" : "还没有账号？立即注册";
    $("login-button").textContent = registrationMode ? "注册并进入声馆" : "进入声馆 ↗";
    $("password").autocomplete = registrationMode ? "new-password" : "current-password";
    $("password").minLength = registrationMode ? 8 : 1; $("password").maxLength = 128;
    $("username").maxLength = registrationMode ? 40 : 80;
    $("register-help").hidden = !registrationMode;
  });
  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault(); if ($("login-button").disabled) return;
    $("login-button").disabled = true; $("auth-toggle").disabled = true; setError("login-error");
    try {
      if (!state.csrf) { const anonymous = await api("/api/me"); state.csrf = anonymous.csrf_token || ""; }
      if (!state.csrf) throw new ApiError("声馆尚未返回登录验证信息，请刷新页面后重试。", 0);
      await api(registrationMode ? "/api/register" : "/api/login", { method: "POST", body: { username: $("username").value.trim(), password: $("password").value } });
      $("password").value = ""; const me = await api("/api/me"); await showAuthenticated(me);
    } catch (error) { setError("login-error", error.message); }
    finally { $("login-button").disabled = false; $("auth-toggle").disabled = false; }
  });
  $("logout-button").addEventListener("click", async () => {
    $("logout-button").disabled = true;
    try { await api("/api/logout", { method: "POST", body: {} }); showLoggedOut("", true); const anonymous = await api("/api/me"); state.csrf = anonymous.csrf_token || ""; }
    catch (error) { toast(error.message); }
    finally { $("logout-button").disabled = false; }
  });
  $("voice-search").addEventListener("input", renderVoices);
  if ($("catalog-toggle")) $("catalog-toggle").addEventListener("click", () => { state.showCatalog = !state.showCatalog; renderVoices(); });
  $("speech-text").addEventListener("input", () => { updateForm(); setError("generation-error"); });
  $("generation-form").addEventListener("submit", async (event) => {
    event.preventDefault(); if ($("generate-button").disabled || state.submitting) return;
    const draft = $("speech-text").value; const text = draft.trim(); const voiceId = state.voiceId;
    const fingerprint = JSON.stringify([voiceId, text]);
    if (state.requestFingerprint !== fingerprint || !state.requestKey) { state.requestFingerprint = fingerprint; state.requestKey = uuid(); }
    const epoch = state.epoch; state.submitting = true; updateForm(); setError("generation-error");
    try {
      await api("/api/jobs", { method: "POST", body: { voice_id: voiceId, text, request_key: state.requestKey } });
      if (!state.authenticated || epoch !== state.epoch) return;
      if ($("speech-text").value === draft) $("speech-text").value = ""; state.requestKey = ""; state.requestFingerprint = "";
      if (state.filter !== "all") setFilter("all");
      await refreshJobs(); toast("已加入队列，可以在“我的请求”查看排位。");
    } catch (error) { if (state.authenticated && epoch === state.epoch) setError("generation-error", error.message); }
    finally { state.submitting = false; updateForm(); }
  });
  function setFilter(filter) {
    state.filter = filter;
    historyPages = 1; queryRevision++;
    for (const button of document.querySelectorAll("[data-filter]")) {
      const active = button.dataset.filter === filter; button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active));
    }
    renderJobs();
    refreshJobs();
  }
  $("history-voice").addEventListener("input", () => { historyPages = 1; queryRevision++; clearTimeout(historySearchTimer); historySearchTimer = setTimeout(refreshJobs, 300); });
  $("more-history").addEventListener("click", async event => { event.currentTarget.disabled = true; historyPages++; queryRevision++; try { await refreshJobs(); } finally { $("more-history").disabled = false; } });
  for (const button of document.querySelectorAll("[data-filter]")) button.addEventListener("click", () => setFilter(button.dataset.filter));
  $("delete-dialog").addEventListener("close", () => {
    const id = state.deleteId; state.deleteId = null;
    if ($("delete-dialog").returnValue === "confirm" && id) deleteJob(id);
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshJobs(); });
  $("login-button").disabled = true;
  api("/api/me").then((me) => { if (isAuthenticated(me)) return showAuthenticated(me); showLoggedOut(); state.csrf = me.csrf_token || ""; }).catch((error) => showLoggedOut(error.message)).finally(() => { $("login-button").disabled = false; });
})();
