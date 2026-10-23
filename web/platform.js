const policyNumberFields = [
  ["max_instances", "每人最多活动实例数", "台；0 表示不限制"],
  ["max_cpu", "每人最多预占 CPU", "核；0 表示不限制"],
  ["max_memory_mb", "每人最多预占内存", "MB；0 表示不限制"],
  ["max_disk_gb", "每人最多预占磁盘", "GB；0 表示不限制"],
  ["max_future_lease_hours", "最远到期时间上限", "距当前的小时数；0 表示不限制"],
  ["max_continuous_lease_hours", "连续使用时长上限", "从首次创建计算的小时数；0 表示不限制"],
  ["auto_renew_hours", "自动续期单次时长", "小时；最大 168 小时，不能绕过长租期审批"],
  ["auto_renew_max_count", "自动续期次数上限", "每实例次数；启用时必须至少为 1"],
  ["audit_retention_days", "操作审计保留天数", "0 永久保留；超过保留期仍需先归档、校验后清理"],
  ["notification_retention_days", "通知记录保留天数", "0 永久保留"],
  ["approval_retention_days", "已结束审批保留天数", "0 永久保留；待处理审批不清理"],
];
const archiveCategories = {audit: "操作审计", notifications: "通知记录", approvals: "已结束审批"};
const schedulingStrategies = {
  MOST_AVAILABLE: {name: "剩余资源优先", description: "优先剩余可分配内存最多的宿主；余量相同则优先更久未接单的宿主。"},
  ROUND_ROBIN: {name: "轮询分配", description: "按宿主纳管顺序循环分配，自动跳过离线、额度不足或镜像 / 网络未就绪的宿主。轮询进度重启后保留。"},
  BALANCED: {name: "资源均衡", description: "优先选择分配后 CPU / 内存 / 磁盘最高预算占用率更低的宿主；同分优先更久未接单的宿主。"},
};

function schedulingDecisionHTML(decision) {
  if (!decision?.strategy) return '<div class="scheduling-decision source-sub">历史实例没有调度快照，保持原宿主不变。</div>';
  return `<section class="panel scheduling-decision"><h3>调度记录</h3><p><b>${esc(schedulingStrategies[decision.strategy]?.name || decision.strategy)}</b> · ${esc(decision.host_name)} · ${esc(fmtDate(decision.selected_at))}</p><p class="source-sub">${esc(decision.reason)}</p></section>`;
}

function schedulingPreviewHTML(result) {
  const hosts = result.hosts || [];
  const selected = hosts.find((host) => host.host_id === result.selected_host_id);
  const percent = (value) => `${(numeric(value) * 100).toFixed(1)}%`;
  return `<div class="notice" role="status"><b>${selected ? `预计分配：${esc(selected.host_name)}` : "暂无满足条件的宿主"}</b><br>${esc(result.reason)}<br>${esc(result.notice)}</div><div class="table-scroll scheduler-preview-table"><table><thead><tr><th>宿主机</th><th>预览结果</th><th>分配后 CPU / 内存 / 磁盘预算占比</th><th>说明</th></tr></thead><tbody>${hosts.map((host) => `<tr><td>${esc(host.host_name)}</td><td>${host.host_id === result.selected_host_id ? '<span class="pill ok">预计选中</span>' : host.eligible ? "符合条件" : '<span class="pill warn">跳过</span>'}</td><td>${percent(host.projected_cpu_ratio)} / ${percent(host.projected_memory_ratio)} / ${percent(host.projected_disk_ratio)}</td><td>${esc(host.eligible ? "符合公共资源、镜像和网络检查" : (host.reasons || []).join("；"))}</td></tr>`).join("") || '<tr><td colspan="4">暂无已纳管宿主机</td></tr>'}</tbody></table></div>`;
}

async function openSchedulingPreview() {
  if (state.currentUser?.role !== "ADMIN") throw new Error("仅管理员可预览宿主调度");
  const selectedStrategy = $("#platform-policy-form [name=scheduling_strategy]")?.value || "MOST_AVAILABLE";
  const [flavors, images, networks] = await Promise.all([api("/flavors"), api("/images"), api("/networks")]);
  const options = (items) => items.filter((item) => item.enabled !== false).map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join("");
  if (![flavors, images, networks].every((result) => result.items?.some((item) => item.enabled !== false))) throw new Error("请先配置启用的规格、就绪镜像和网络，再预览调度");
  showFormModal({
    title: "调度预览", description: "只读模拟：不保存策略、不预占资源、不创建虚拟机。最终分配以实际提交时为准。",
    submitText: "重新预览", keepOpen: true,
    content: `<div class="modal-grid"><div class="field full"><label>预览策略</label><select name="strategy">${Object.entries(schedulingStrategies).map(([key, value]) => `<option value="${key}" ${key === selectedStrategy ? "selected" : ""}>${value.name}</option>`).join("")}</select></div><div class="field"><label>资源规格</label><select name="flavor_id" required>${options(flavors.items)}</select></div><div class="field"><label>系统镜像</label><select name="image_id" required>${options(images.items)}</select></div><div class="field full"><label>网络</label><select name="network_id" required>${options(networks.items)}</select></div></div><div data-scheduling-preview-result aria-live="polite"></div>`,
    onSubmit: async (data, form) => {
      const body = Object.fromEntries(["strategy", "flavor_id", "image_id", "network_id"].map((key) => [key, data.get(key)]));
      const result = await api("/scheduler/preview", {method: "POST", body: JSON.stringify(body)});
      if (form.isConnected && $("#modal-form") === form) form.querySelector("[data-scheduling-preview-result]").innerHTML = schedulingPreviewHTML(result);
    },
  });
}

function imageReadinessHTML(image) {
  const entries = image.host_readiness || [];
  const labels = {READY: "就绪", PENDING: "待同步", SYNCING: "同步中", FAILED: "失败", MISSING: "缺失", STALE: "待重新校验", INVALID: "校验失败"};
  if (!entries.length) return '<span class="source-sub">尚无宿主机校验记录</span>';
  return `<details class="image-readiness"><summary>各宿主机状态（${entries.length}）</summary><ul>${entries.map((entry) => `<li><b>${esc(entry.host_name || entry.host_id)}</b> · ${esc(labels[entry.status] || entry.status)}${entry.error ? `<span class="source-sub validation-error">${esc(entry.error)}</span>` : ""}<span class="source-sub">校验 ${fmtDate(entry.verified_at)} · 版本 ${esc(entry.generation ?? image.generation ?? "-")}</span></li>`).join("")}</ul></details>`;
}

async function openImageSyncModal(image) {
  const response = await api("/hosts");
  const hosts = response.items.filter((host) => host.agent_mode === "kvm" && host.status !== "OFFLINE");
  if (!hosts.length) return toast("没有可同步镜像的在线 KVM 写入宿主机，请先检查 Agent。", "warning");
  showFormModal({
    title: `同步镜像 ${image.name}`,
    description: "明确选择目标宿主机，Agent 校验 SHA-256 后才报告就绪。同步结果按宿主机展示，不会用某台成功掩盖其他宿主失败。",
    content: `<fieldset class="sync-host-options"><legend>目标宿主机（至少选择一台）</legend>${hosts.map((host) => `<label><input type="checkbox" name="host_id" value="${esc(host.id)}"> ${esc(host.name)} · ${esc(statusLabels[host.status] || host.status)}</label>`).join("")}</fieldset>`,
    submitText: "提交同步任务",
    onSubmit: async (data) => {
      const ids = data.getAll("host_id");
      if (!ids.length) throw new Error("请至少选择一台目标宿主机");
      await api(`/images/${pathID(image.id)}/sync`, {method: "POST", body: JSON.stringify({host_ids: ids})});
      toast("镜像同步任务已提交，可在各宿主机状态查看进度和错误。");
      closeModal(true);
      await refreshPageData(true);
    },
  });
}

function localDateTime(value) {
  const date = new Date(value || Date.now());
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function administratorOptions(administrators, selected, includeEmpty = false) {
  return (includeEmpty ? '<option value="">不设置代理 / 取消代理</option>' : "") + administrators.filter((user) => user.username !== state.currentUser?.username).map((user) => `<option value="${esc(user.username)}" ${user.username === selected ? "selected" : ""}>${esc(user.display_name || user.username)}（${esc(user.username)}）</option>`).join("");
}
async function openDelegationModal() {
  const result = await api("/approval-delegation");
  const delegation = result.delegation || {};
  showFormModal({
    title: "设置我的审批代理",
    description: "在指定期间由另一位可用管理员处理分配给我的审批。最长 90 天；链式或重叠代理由服务器拒绝。",
    content: `<div class="modal-grid"><div class="field full"><label>代理管理员</label><select name="delegate_username">${administratorOptions(result.administrators || [], delegation.delegate_username, true)}</select></div>${field("starts_at", "开始时间", localDateTime(delegation.starts_at), {type: "datetime-local", required: false})}${field("ends_at", "结束时间", localDateTime(delegation.ends_at || Date.now() + 86400000), {type: "datetime-local", required: false})}</div>`,
    submitText: "保存代理",
    onSubmit: async (data) => {
      const delegate = data.get("delegate_username");
      const body = {delegate_username: delegate};
      if (delegate) {
        const start = new Date(data.get("starts_at")), end = new Date(data.get("ends_at"));
        if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) throw new Error("请填写有效且结束晚于开始的代理时间");
        body.starts_at = start.toISOString(); body.ends_at = end.toISOString();
      }
      await api("/approval-delegation", {method: "PUT", body: JSON.stringify(body)});
      toast(delegate ? "审批代理已保存" : "审批代理已取消");
      closeModal(true);
      await refreshPageData(true);
    },
  });
}
async function openTransferModal(button) {
  const result = await api("/approval-delegation");
  const options = administratorOptions(result.administrators || []);
  if (!options) return toast("没有其他可用管理员，暂时无法转交。", "warning");
  showFormModal({
    title: `转交 ${button.dataset.approvalNo || "审批单"}`,
    description: "只允许转交仍在有效期内的待处理审批，原申请和转交原因继续留痕。",
    content: `<div class="field"><label>接收管理员</label><select name="reviewer_username" required>${options}</select></div><div class="field"><label>转交原因</label><textarea name="reason" required maxlength="300"></textarea></div>`,
    submitText: "确认转交",
    onSubmit: async (data) => {
      await api(`/approvals/${pathID(button.dataset.transferApproval)}/transfer`, {method: "POST", body: JSON.stringify({reviewer_username: data.get("reviewer_username"), reason: data.get("reason").trim()})});
      toast("审批已转交"); closeModal(true); await refreshPageData(true);
    },
  });
}
async function openAutoRenewModal(instanceID) {
  const config = await api(`/instances/${pathID(instanceID)}/auto-renew`);
  const maxHours = Math.max(1, Math.min(168, numeric(config.platform_max_hours, 168)));
  const maxCount = Math.max(1, numeric(config.platform_max_count, 1));
  const form = showFormModal({
    title: "自动续期设置",
    description: "到期前按设置续期，受平台次数、最远到期和连续使用上限约束；失败会显示原因，不会无限占用资源。",
    content: `<div class="notice">平台自动续期${config.platform_enabled ? "已启用" : "未启用，不能开启"}；单次最多 ${maxHours} 小时，最多 ${maxCount} 次。已执行 ${numeric(config.renewed_count)} 次。</div>${config.last_error ? `<div class="form-error show">${esc(config.last_error)}</div>` : ""}<label class="credential-confirm"><input type="checkbox" name="enabled" ${config.enabled ? "checked" : ""}> 为此实例启用自动续期</label><div class="modal-grid">${field("hours", "每次续期（小时）", Math.max(1, Math.min(maxHours, numeric(config.hours, maxHours))), {type: "number", min: 1, max: maxHours})}${field("max_renewals", "最多续期次数", Math.max(1, Math.min(maxCount, numeric(config.max_renewals, maxCount))), {type: "number", min: 1, max: maxCount})}</div>`,
    submitText: "保存自动续期",
    onSubmit: async (data, currentForm) => {
      if (currentForm.elements.enabled.checked && !config.platform_enabled) throw new Error("管理员尚未开放自动续期，当前只能关闭设置");
      await api(`/instances/${pathID(instanceID)}/auto-renew`, {method: "PUT", body: JSON.stringify({enabled: currentForm.elements.enabled.checked, hours: Number(data.get("hours")), max_renewals: Number(data.get("max_renewals"))})});
      toast("自动续期配置已保存");
    },
  });
  form.elements.enabled.onchange = () => { if (form.elements.enabled.checked && !config.platform_enabled) { form.elements.enabled.checked = false; toast("平台尚未开放自动续期，请联系管理员。", "warning"); } };
}

function historySection(result) {
  const rows = result.items.map((item) => `<tr><td>${esc(archiveCategories[item.category] || item.category)}<span class="source-sub">${esc(item.id)}</span></td><td>${numeric(item.row_count)} 条 · ${(numeric(item.size_bytes) / 1024).toFixed(1)} KiB</td><td>${fmtDate(item.created_at)}<span class="source-sub">${esc(item.created_by)}</span></td><td>${item.purged_at ? "源记录已清理" : item.downloaded_at ? "已下载，待校验清理" : "待下载"}<span class="source-sub">SHA-256：${esc(item.checksum)}</span></td><td><div class="row-actions"><button class="btn mini" data-download-archive='${esc(JSON.stringify(item))}'>下载归档</button><button class="btn mini danger" data-purge-archive='${esc(JSON.stringify(item))}' ${!item.downloaded_at || item.purged_at ? "disabled" : ""}>校验并清理源记录</button><button class="btn mini danger" data-delete-archive='${esc(JSON.stringify(item))}' ${!item.downloaded_at || !item.purged_at ? "disabled" : ""}>删除已备份归档</button></div></td></tr>`).join("");
  const content = rows
    ? `<div class="table-scroll policy-history-table"><table><thead><tr><th>类别 / 编号</th><th>数量 / 大小</th><th>创建时间 / 操作人</th><th>状态 / 校验和</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<div class="policy-history-empty" role="status">
        <div class="policy-history-empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h16v12H4zM3 4h18v4H3zM9 12h6"/></svg></div>
        <div class="policy-history-empty-copy"><h4>尚未生成历史归档</h4><p>需要清理历史记录时，先保存上方保留策略，再点击“生成归档”。生成只打包数据，不会立即删除源记录。</p></div>
        <ol class="policy-history-steps" aria-label="归档清理顺序"><li>生成归档</li><li>下载并校验</li><li>另存独立备份</li><li>确认后清理</li></ol>
      </div>`;
  return `<div class="policy-history-header">
      <div class="policy-history-heading"><span class="policy-card-kicker">归档与备份</span><h3>历史归档与清理</h3><p class="source-sub">每批最多 5000 条；仅处理超过策略保留期的已结束记录。0 天表示永久保留。</p></div>
      <div class="row-actions policy-history-actions"><button class="btn" type="button" data-refresh-archives>刷新归档</button><button class="btn primary" type="button" data-create-archive>生成归档</button></div>
    </div>${content}`;
}
async function policyPage() {
  const [policy, archives, scheduler] = await Promise.all([api("/platform-policy"), api("/history/archives"), api("/scheduler")]);
  const fieldRows = (keys) => keys.map((key) => { const [,label,hint] = policyNumberFields.find((item) => item[0] === key); return field(key, label, numeric(policy[key]), {type: "number", min: 0, max: key === "auto_renew_hours" ? 168 : 1000000, hint}); }).join("");
  return lead("平台策略", "公平使用限额、自动续期上限与历史保留；额度 0 不限制，历史 0 永久保留") + `<form class="policy-settings-form" id="platform-policy-form">
      <div class="policy-settings-grid">
        <section class="policy-settings-card policy-scheduling-card" aria-labelledby="policy-scheduling-title">
          <div class="policy-card-header"><span class="policy-card-kicker">宿主分配</span><h3 id="policy-scheduling-title">虚拟机调度</h3><p class="source-sub">只影响之后的新调度，不迁移已有实例，续期、恢复和重试保持原宿主。</p></div>
          <div class="field"><label for="scheduling-strategy">调度策略</label><select id="scheduling-strategy" name="scheduling_strategy">${Object.entries(schedulingStrategies).map(([key, value]) => `<option value="${key}" ${key === (policy.scheduling_strategy || "MOST_AVAILABLE") ? "selected" : ""}>${value.name}</option>`).join("")}</select><p class="source-sub" data-scheduling-description>${esc(schedulingStrategies[policy.scheduling_strategy]?.description || schedulingStrategies.MOST_AVAILABLE.description)}</p></div>
          <div class="scheduler-status"><span>最近分配宿主：<b>${esc(scheduler.last_host_name || "尚未分配")}</b></span><span>最近分配时间：${esc(fmtDate(scheduler.last_scheduled_at))}</span><span>累计调度：${numeric(scheduler.sequence)} 次</span></div>
          <div class="row-actions"><button class="btn" type="button" data-scheduling-preview>调度预览</button></div>
          <p class="policy-card-note">所有策略都检查平台额度、实时安全余量、镜像与网络就绪。保留期资源仍计入预占。预览可试选策略，不会保存或推进轮询。</p>
        </section>
        <section class="policy-settings-card policy-resource-card" aria-labelledby="policy-resource-title">
          <div class="policy-card-header"><span class="policy-card-kicker">资源预算</span><h3 id="policy-resource-title">每人资源与租期上限</h3><p class="source-sub">按用户控制实例数量、预占资源和最长使用时间。</p></div>
          <div class="form-grid policy-resource-fields">${fieldRows(["max_instances", "max_cpu", "max_memory_mb", "max_disk_gb", "max_future_lease_hours", "max_continuous_lease_hours"])}</div>
          <p class="policy-card-note">额度 0 表示不限制。资源配额由服务器事务校验，不依赖浏览器。</p>
        </section>
        <section class="policy-settings-card policy-renew-card" aria-labelledby="policy-renew-title">
          <div class="policy-card-header"><span class="policy-card-kicker">续期规则</span><h3 id="policy-renew-title">自动续期</h3><p class="source-sub">允许用户在平台上限内配置有限次数的自动续期。</p></div>
          <label class="credential-confirm"><input type="checkbox" name="auto_renew_enabled" ${policy.auto_renew_enabled ? "checked" : ""}> 允许用户为实例设置有限次数的自动续期</label>
          <div class="form-grid policy-renew-fields">${fieldRows(["auto_renew_hours", "auto_renew_max_count"])}</div>
          <p class="policy-card-note">超过 7 天的单次创建、续期和恢复仍须审批，自动续期不会绕过审批规则。</p>
        </section>
        <section class="policy-settings-card policy-retention-card" aria-labelledby="policy-retention-title">
          <div class="policy-card-header"><span class="policy-card-kicker">数据留存</span><h3 id="policy-retention-title">历史保留</h3><p class="source-sub">分别设置审计、通知和已结束审批的保留时间。</p></div>
          <div class="form-grid policy-retention-fields">${fieldRows(["audit_retention_days", "notification_retention_days", "approval_retention_days"])}</div>
          <p class="policy-card-note">0 天表示永久保留，待处理审批不清理。删除前仍须下载、校验归档并确认独立备份。</p>
        </section>
      </div>
      <div class="policy-settings-footer"><p class="source-sub">四个分组统一保存，不会迁移实例或直接删除历史记录。</p><div class="form-actions policy-settings-actions"><button class="btn primary" type="submit">保存平台策略</button></div></div>
    </form><section class="resource-table-wrap history-management" data-history-section>${historySection(archives)}</section>`;
}
async function refreshArchiveSection() {
  const result = await api("/history/archives");
  const target = $("[data-history-section]");
  if (target && state.page === "policy") { target.innerHTML = historySection(result); bindPlatformFeatures(); protectAsyncButtons(); }
}
async function downloadArchive(item) {
  const epoch = sessionEpoch, sequence = renderSequence;
  const controller = new AbortController();
  pendingRequests.add(controller);
  const check = () => { if (epoch !== sessionEpoch || sequence !== renderSequence || controller.signal.aborted) throw cancelledContext(); };
  try {
    const response = await fetch('/api/v1/history/archives/' + pathID(item.id) + '/download', {credentials: "same-origin", signal: controller.signal});
    check();
    if (!response.ok) { const result = await response.json(); check(); throw new ApiError(localizeError(result.error), response.status); }
    const blob = await response.blob(); check();
    if (globalThis.crypto?.subtle) {
      const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()); check();
      const checksum = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      if (checksum !== item.checksum) throw new Error("归档下载校验失败，不能继续清理，请联系管理员");
    }
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = 'vmp-' + item.category + '-archive-' + item.id + '.ndjson.gz';
    link.click(); URL.revokeObjectURL(link.href);
    toast(globalThis.crypto?.subtle ? "归档已下载，SHA-256 校验通过，请另存备份。" : "归档已下载。HTTP 环境请用 sha256sum 校验后再清理。", "info");
    await refreshArchiveSection();
  } catch (error) {
    if (controller.signal.aborted || epoch !== sessionEpoch || sequence !== renderSequence) throw cancelledContext();
    throw error;
  } finally { pendingRequests.delete(controller); }
}
function archiveConfirmation(item, removeArchive = false) {
  const phrase = removeArchive ? "已备份归档" : "已下载并校验归档";
  showFormModal({
    title: removeArchive ? "删除已备份归档数据" : "校验归档并清理源记录",
    description: removeArchive ? "仅当源记录已经清理且归档有独立备份才允许删除。删除归档文件不可撤销。" : "此操作不可撤销，只清理本归档中且内容未发生变化的源记录。请先确认归档已下载并校验；归档本身仍保留。",
    content: `<div class="notice">${numeric(item.row_count)} 条 ${esc(archiveCategories[item.category])}<br>归档 SHA-256：<code>${esc(item.checksum)}</code></div>${field("checksum", "粘贴下载文件的 SHA-256 校验和", "", {hint: "必须与上方完整校验和一致，不自动替你确认备份"})}${field("confirm", `输入“${phrase}”确认`, "")}`,
    submitText: removeArchive ? "永久删除归档" : "清理已归档源记录",
    onSubmit: async (data) => {
      if (data.get("checksum").trim() !== item.checksum || data.get("confirm").trim() !== phrase) throw new Error("校验和或确认文字不一致，未执行清理");
      await api(`/history/archives/${pathID(item.id)}${removeArchive ? "" : "/purge"}`, {method: removeArchive ? "DELETE" : "POST", body: JSON.stringify({checksum: data.get("checksum").trim(), confirm: phrase})});
      toast(removeArchive ? "归档已删除，请保留独立备份。" : "源记录已清理，归档继续保留。"); closeModal(true); await refreshArchiveSection();
    },
  });
  $("#modal-form [type=submit]").classList.add("danger");
}
function bindPlatformFeatures() {
  const policyForm = $("#platform-policy-form");
  if (policyForm) policyForm.onsubmit = async (event) => {
    event.preventDefault();
    const submit = policyForm.querySelector('[type="submit"]');
    if (submit.disabled) return;
    await runButton(submit, async () => {
      const data = new FormData(policyForm);
      const body = Object.fromEntries(policyNumberFields.map(([key]) => [key, Number(data.get(key))]));
      body.auto_renew_enabled = policyForm.elements.auto_renew_enabled.checked;
      body.scheduling_strategy = data.get("scheduling_strategy") || "MOST_AVAILABLE";
      if (!Object.hasOwn(schedulingStrategies, body.scheduling_strategy)) throw new Error("请选择有效的调度策略");
      if (Object.values(body).some((value) => typeof value === "number" && (!Number.isInteger(value) || value < 0))) throw new Error("策略额度必须填写非负整数");
      if (body.auto_renew_enabled && (body.auto_renew_hours < 1 || body.auto_renew_max_count < 1)) throw new Error("启用自动续期时，单次小时数与次数上限必须至少为 1");
      await api("/platform-policy", {method: "PUT", body: JSON.stringify(body)});
      toast("平台策略已保存");
    });
  };
  const strategy = $("#platform-policy-form [name=scheduling_strategy]");
  if (strategy) strategy.onchange = () => { const description = $("[data-scheduling-description]"); if (description) description.textContent = schedulingStrategies[strategy.value]?.description || "请选择有效的调度策略"; };
  const preview = $("[data-scheduling-preview]"); if (preview) preview.onclick = openSchedulingPreview;
  const delegate = $("[data-approval-delegation]");
  if (delegate) delegate.onclick = openDelegationModal;
  document.querySelectorAll("[data-transfer-approval]").forEach((button) => { button.onclick = async () => openTransferModal(button); });
  document.querySelectorAll("[data-auto-renew]").forEach((button) => { button.onclick = async () => openAutoRenewModal(button.dataset.autoRenew); });
  document.querySelectorAll("[data-image-sync]").forEach((button) => { button.onclick = async () => openImageSyncModal(JSON.parse(button.dataset.imageSync)); });
  const refresh = $("[data-refresh-archives]"); if (refresh) refresh.onclick = refreshArchiveSection;
  const create = $("[data-create-archive]");
  if (create) create.onclick = () => showFormModal({title: "生成历史归档", description: "按已保存保留策略生成最多 5000 条压缩 NDJSON；不会立即删除源记录。", content: `<div class="field"><label>归档类别</label><select name="category">${Object.entries(archiveCategories).map(([key, label]) => `<option value="${key}">${label}</option>`).join("")}</select></div>`, submitText: "生成归档", onSubmit: async (data) => {await api("/history/archives", {method: "POST", body: JSON.stringify({category: data.get("category")})}); toast("归档已生成，请先下载、校验和备份。"); closeModal(true); await refreshArchiveSection();}});
  document.querySelectorAll("[data-download-archive]").forEach((button) => { button.onclick = async () => downloadArchive(JSON.parse(button.dataset.downloadArchive)); });
  document.querySelectorAll("[data-purge-archive]").forEach((button) => { button.onclick = () => archiveConfirmation(JSON.parse(button.dataset.purgeArchive)); });
  document.querySelectorAll("[data-delete-archive]").forEach((button) => { button.onclick = () => archiveConfirmation(JSON.parse(button.dataset.deleteArchive), true); });
}
