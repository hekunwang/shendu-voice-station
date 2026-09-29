"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const state = { user: null, csrf: "", overview: null, portraits: {}, jobs: [], next: null, passwordUser: null, busy: false, toast: null };
  const labels = { queued: "排队中", running: "生成中", completed: "已完成", failed: "失败", cancelled: "已取消", canceled: "已取消" };
  let mutationTail = Promise.resolve(), settingsRevision = 0, savedRevision = 0, sessionRevision = 0, jobsRevision = 0, overviewRevision = 0;
  function el(tag, text, cls) { const node = document.createElement(tag); if (text !== undefined) node.textContent = String(text); if (cls) node.className = cls; return node; }
  function error(id, message = "") { $(id).textContent = message; $(id).hidden = !message; }
  function toast(message) { clearTimeout(state.toast); $("toast").textContent = message; $("toast").hidden = false; state.toast = setTimeout(() => { $("toast").hidden = true; }, 4500); }
  function date(value) { if (!value) return "—"; const parsed = new Date(typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : value); return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString("zh-CN", { hour12: false }); }
  async function api(path, method = "GET", body) {
    const headers = { Accept: "application/json" }; if (body !== undefined) headers["Content-Type"] = "application/json";
    if (method !== "GET" && state.csrf) headers["X-CSRF-Token"] = state.csrf;
    let response; try { response = await fetch(path, { method, headers, credentials: "same-origin", cache: "no-store", body: body === undefined ? undefined : JSON.stringify(body) }); } catch (_) { throw new Error("暂时无法连接，请检查网络后重试。"); }
    let data; try { data = await response.json(); } catch (_) { throw new Error("服务返回异常，请稍后重试。"); }
    if (!response.ok) { if (response.status === 401) gate(null); throw new Error(typeof data.error === "string" ? data.error : data.error?.message || "操作没有完成，请稍后重试。"); }
    return data;
  }
  function gate(user) { sessionRevision++; state.user = user; $("loading").hidden = true; $("login").hidden = !!user; $("denied").hidden = !user || user.role === "admin"; $("app").hidden = !user || user.role !== "admin"; if (!user) { state.overview = null; state.jobs = []; settingsRevision = savedRevision = 0; $("settings-dirty").hidden = true; $("password-dialog").close(); } }
  async function session() { const data = await api("/api/me"); state.csrf = data.csrf_token || ""; gate(data.authenticated || data.user ? data.user : null); if (state.user?.role === "admin") { $("account").textContent = state.user.display_name || state.user.username; await reload(); } }
  function button(label, action, cls = "secondary", disabled = false) { const b = el("button", label, cls); b.type = "button"; b.disabled = disabled; b.addEventListener("click", action); return b; }
  async function mutate(path, method, body, message) {
    const previous = mutationTail, sessionAtSubmit = sessionRevision; let release;
    mutationTail = new Promise(resolve => { release = resolve; });
    await previous; state.busy = true; document.body.setAttribute("aria-busy", "true"); error("global-error");
    try { if (sessionAtSubmit !== sessionRevision || state.user?.role !== "admin") throw new Error("登录状态已变化，请重新操作。"); await api(path, method, body); toast(message); await reload(); return true; }
    catch (e) { error("global-error", e.message); toast(e.message); return false; }
    finally { state.busy = false; document.body.removeAttribute("aria-busy"); release(); }
  }
  async function reload() { const revision = ++overviewRevision, sessionAtRequest = sessionRevision; const data = await api("/api/admin/overview"); if (revision !== overviewRevision || sessionAtRequest !== sessionRevision) return; state.overview = data; renderOverview(); await loadJobs(false); }
  function renderOverview() {
    const d = state.overview; const stats = $("summary"); stats.replaceChildren();
    for (const [key, title] of [["queued", "等待生成"], ["running", "正在生成"], ["completed", "累计完成"], ["failed", "失败任务"]]) { const card = el("div", undefined, "stat"); card.append(el("strong", d.counts?.[key] ?? 0), el("span", title)); stats.append(card); }
    const worker = el("div", undefined, "stat worker"); worker.append(el("strong", d.worker?.ready ? "服务在线" : "服务待就绪"), el("small", d.worker?.message || "暂无状态信息")); stats.append(worker);
    if (settingsRevision === savedRevision) { $("max-length").value = d.settings.max_text_length; $("accepting").checked = !!d.settings.accepting_jobs; $("max-pending").value = d.settings.max_pending_jobs || 3; }
    renderStorage();
    renderUsers(); renderVoices(); renderAudit();
  }
  function renderStorage() {
    const s = state.overview.storage; if (!s) return;
    const mib = n => (Number(n || 0) / 1048576).toFixed(1);
    $("storage-meter").value = s.used_bytes; $("storage-meter").max = s.quota_bytes;
    $("storage-detail").textContent = `${mib(s.used_bytes)} / ${mib(s.quota_bytes)} MiB · 原声 ${mib(s.reference_bytes)} · 作品 ${mib(s.generated_bytes)} · 可回收 ${mib(s.reclaimable_bytes)} MiB`;
    $("storage-warning").textContent = s.ratio >= .95 ? "空间紧张，暂停接收新任务。请回收过期音频。" : s.ratio >= .85 ? "空间即将用满，请安排回收。" : s.ratio >= .7 ? "已使用超过 70%，请留意剩余容量。" : "容量充足。删除的作品保留 7 天，之后可回收音频空间。";
  }
  function renderUsers() {
    const users = state.overview?.users || []; const query = $("user-search").value.trim().toLowerCase();
    $("user-count").textContent = `${users.filter(u => !u.deleted_at && u.active).length} 位启用`; const list = $("user-list"); list.replaceChildren();
    for (const user of users.filter(u => `${u.username} ${u.display_name}`.toLowerCase().includes(query))) {
      const row = el("div", undefined, "user-row"); const identity = el("div", undefined, "identity"); identity.append(el("strong", user.display_name || user.username), el("small", `${user.username} · ${user.role === "admin" ? "管理员" : "普通用户"} · ${user.deleted_at ? "已删除" : user.active ? "已启用" : "已停用"} · ${user.job_count || 0} 个请求`));
      const actions = el("div", undefined, "row-actions"); const own = String(user.id) === String(state.user.id); const protectedAccount = user.role === "admin" || own;
      if (user.deleted_at) actions.append(button("恢复账号", () => mutate(`/api/admin/users/${encodeURIComponent(user.id)}/restore`, "POST", {}, "账号已恢复，请手动启用后再登录"), "secondary", protectedAccount));
      else {
        actions.append(button(user.active ? "停用" : "启用", () => { if (!user.active || confirm(`停用「${user.username}」？将撤销登录并取消其在途任务。`)) mutate(`/api/admin/users/${encodeURIComponent(user.id)}`, "PATCH", { active: !user.active }, user.active ? "账号已停用" : "账号已启用"); }, "secondary", protectedAccount));
        actions.append(button("重置密码", () => { state.passwordUser = user; $("password-target").textContent = `账号：${user.username}`; $("new-password").value = ""; error("password-error"); $("password-dialog").showModal(); }, "secondary", protectedAccount));
        actions.append(button("删除", () => { if (confirm(`删除「${user.username}」？将撤销登录并取消其在途任务，之后仍可恢复账号。`)) mutate(`/api/admin/users/${encodeURIComponent(user.id)}`, "DELETE", undefined, "账号已删除，可在列表恢复"); }, "danger", protectedAccount));
      }
      if (own) actions.append(el("span", "当前账号", "badge")); row.append(identity, actions); list.append(row);
    }
    if (!list.children.length) list.append(el("p", "没有匹配的用户", "empty"));
  }
  function avatar(voice) { const box = el("span", Array.from(voice.name || "声")[0], "portrait"); box.setAttribute("aria-hidden", "true"); const source = state.portraits[String(voice.id)]; if (typeof source === "string" && /^\/portraits\/[a-f0-9]{16,64}\.webp$/.test(source)) { const image = el("img"); image.alt = ""; image.loading = "lazy"; image.width = 96; image.height = 96; image.addEventListener("error", () => image.remove(), { once: true }); image.src = source; box.append(image); } return box; }
  function renderVoices() {
    const voices = state.overview?.voices || []; const query = $("voice-search").value.trim().toLowerCase(); const filter = $("voice-filter").value;
    $("voice-count").textContent = `${voices.filter(v => v.available && !v.hidden).length} 展示 / ${voices.filter(v => v.hidden).length} 隐藏`; const list = $("voice-list"); list.replaceChildren();
    for (const voice of voices.filter(v => v.name.toLowerCase().includes(query) && (filter === "all" || (filter === "hidden" ? v.hidden : !v.hidden)))) {
      const row = el("div", undefined, "voice-row"); const identity = el("div", undefined, "identity"); identity.append(el("strong", voice.name), el("small", voice.available ? `${Number(voice.reference_seconds || 0).toFixed(1)} 秒参考音频` : "样本待准备"));
      const label = el("label", undefined, "toggle-label"); const input = el("input"); input.type = "checkbox"; input.checked = !voice.hidden; input.setAttribute("aria-label", `展示${voice.name}`); input.addEventListener("change", async () => { input.disabled = true; const success = await mutate(`/api/admin/voices/${encodeURIComponent(voice.id)}`, "PATCH", { hidden: !input.checked }, input.checked ? `${voice.name}已展示` : `${voice.name}已隐藏`); if (!success) input.checked = !voice.hidden; input.disabled = false; }); label.append(input, el("span", voice.hidden ? "隐藏" : "展示")); row.append(avatar(voice), identity, label); list.append(row);
    }
    if (!list.children.length) list.append(el("p", "没有匹配的声线", "empty"));
  }
  async function loadJobs(append) { const revision = ++jobsRevision, sessionAtRequest = sessionRevision; const data = await api(`/api/admin/jobs${append && state.next ? `?before=${encodeURIComponent(state.next)}` : ""}`); if (revision !== jobsRevision || sessionAtRequest !== sessionRevision) return; state.jobs = append ? [...new Map([...state.jobs, ...data.jobs].map(job => [job.id, job])).values()] : data.jobs; state.next = data.next_before; renderJobs(); }
  function renderJobs() { const list = $("job-list"); list.replaceChildren(); for (const job of state.jobs) { const row = el("div", undefined, "job-row"); const identity = el("div", undefined, "identity"); const inProgress = ["queued", "running"].includes(job.status); identity.append(el("strong", `#${job.id} · ${job.voice_name || "声线"}`), el("small", `${job.username} · ${date(job.created_at)}`)); row.append(identity, el("span", job.cancel_requested && inProgress ? "取消处理中" : labels[job.status] || job.status, "badge")); if (inProgress) row.append(button("取消任务", () => { if (confirm(`取消任务 #${job.id}？`)) mutate(`/api/admin/jobs/${encodeURIComponent(job.id)}/cancel`, "POST", {}, "已提交取消请求"); }, "danger", !!job.cancel_requested)); list.append(row); } if (!list.children.length) list.append(el("p", "还没有生成任务", "empty")); $("more-jobs").hidden = !state.next; }
  function renderAudit() {
    const actionNames = { "user.create": "添加用户", "user.restore": "恢复用户", "user.delete": "删除用户", "user.password_reset": "重置密码", "user.enable": "启用用户", "user.disable": "停用用户", "voice.hide": "隐藏声线", "voice.show": "展示声线", "settings.update": "修改生成设置", "job.cancel": "取消任务", "admin.bootstrap": "初始化管理员" };
    const list = $("audit-list"); list.replaceChildren();
    for (const event of state.overview.audit || []) {
      const row = el("div", undefined, "audit-row"); const copy = el("div", undefined, "identity"); copy.append(el("strong", `${event.actor_name || "系统"} · ${actionNames[event.action] || event.action}`));
      let detail = event.detail; if (typeof detail === "string") { try { detail = JSON.parse(detail); } catch (_) { detail = null; } }
      const parts = []; if (detail && typeof detail === "object") { for (const [key, title] of [["name", "名称"], ["username", "账号"]]) if (typeof detail[key] === "string") parts.push(`${title}：${detail[key]}`); if (Number.isInteger(detail.max_text_length)) parts.push(`文本上限：${detail.max_text_length} 字`); if (typeof detail.accepting_jobs === "boolean") parts.push(detail.accepting_jobs ? "允许提交新请求" : "暂停接收新请求"); }
      if (event.target && !parts.length) parts.push(`对象：${String(event.target)}`); if (parts.length) copy.append(el("small", parts.join(" · "))); row.append(copy, el("time", date(event.created_at))); list.append(row);
    }
    if (!list.children.length) list.append(el("p", "暂无管理操作记录", "empty"));
  }
  $("login-form").addEventListener("submit", async event => { event.preventDefault(); const submit = event.submitter; submit.disabled = true; error("login-error"); try { const fresh = await api("/api/me"); state.csrf = fresh.csrf_token || ""; await api("/api/login", "POST", { username: $("login-name").value.trim(), password: $("login-password").value }); $("login-password").value = ""; await session(); } catch (e) { error("login-error", e.message); } finally { submit.disabled = false; } });
  async function logout() { try { await api("/api/logout", "POST", {}); state.csrf = ""; gate(null); await session(); } catch (e) { error("global-error", e.message); toast(e.message); } }
  $("logout").addEventListener("click", logout); $("switch-account").addEventListener("click", logout);
  $("create-user").addEventListener("submit", async event => { event.preventDefault(); const form = event.currentTarget; const data = Object.fromEntries(new FormData(form)); event.submitter.disabled = true; try { if (await mutate("/api/admin/users", "POST", data, "用户已添加")) form.reset(); } finally { event.submitter.disabled = false; } });
  $("settings-form").addEventListener("input", () => { settingsRevision++; $("settings-dirty").hidden = false; });
  $("settings-form").addEventListener("submit", async event => { event.preventDefault(); event.submitter.disabled = true; const revision = settingsRevision; try { if (await mutate("/api/admin/settings", "PUT", { max_text_length: Number($("max-length").value), max_pending_jobs: Number($("max-pending").value), accepting_jobs: $("accepting").checked }, "生成设置已保存")) { savedRevision = revision; $("settings-dirty").hidden = settingsRevision === savedRevision; } } finally { event.submitter.disabled = false; } });
  $("cleanup-preview").addEventListener("click", async event => {
    const target = event.currentTarget; target.disabled = true;
    try { const data = await api("/api/admin/storage/cleanup-preview"); const candidates = (data.candidates || []).slice(0,20); const list = $("cleanup-list"); list.replaceChildren();
      for (const c of candidates) list.append(el("p", `${c.key || c.object_key} · ${(c.size / 1048576).toFixed(2)} MiB · ${c.reason}`));
      if (!candidates.length) list.append(el("p", "暂无符合条件的过期音频。"));
      if (candidates.length) list.append(button(`回收以上 ${candidates.length} 项`, async () => { if (!confirm("确认永久回收以上音频？恢复期内和使用中的音频不会被回收。")) return; if (await mutate("/api/admin/storage/cleanup", "POST", {version_ids:candidates.map(c => c.version_id)}, "符合条件的音频已回收")) list.replaceChildren(); }, "danger"));
    } catch(e) { error("global-error",e.message); } finally { target.disabled = false; }
  });
  $("password-form").addEventListener("submit", async event => { event.preventDefault(); if (!state.passwordUser) return; const submit = event.submitter; submit.disabled = true; error("password-error"); try { if (await mutate(`/api/admin/users/${encodeURIComponent(state.passwordUser.id)}`, "PATCH", { password: $("new-password").value }, "密码已重置")) { $("new-password").value = ""; $("password-dialog").close(); } else error("password-error", "密码未重置，请检查页面提示后重试。"); } finally { submit.disabled = false; } });
  $("close-password").addEventListener("click", () => { $("new-password").value = ""; $("password-dialog").close(); });
  $("password-dialog").addEventListener("close", () => { $("new-password").value = ""; state.passwordUser = null; });
  $("user-search").addEventListener("input", renderUsers); $("voice-search").addEventListener("input", renderVoices); $("voice-filter").addEventListener("change", renderVoices);
  for (const [id, action] of [["refresh", reload], ["reload-jobs", () => loadJobs(false)], ["more-jobs", () => loadJobs(true)]]) $(id).addEventListener("click", async event => { const target = event.currentTarget; target.disabled = true; error("global-error"); try { await action(); } catch (e) { error("global-error", e.message); } finally { target.disabled = false; } });
  (async () => { try { const portraits = await api("/portraits.json").catch(() => ({ portraits: {} })); state.portraits = portraits.portraits || {}; await session(); } catch (e) { $("loading").hidden = true; if (state.user?.role === "admin") error("global-error", e.message); else { gate(state.user); error("login-error", e.message); } } })();
})();
