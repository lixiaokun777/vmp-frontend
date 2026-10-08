const $ = (s) => document.querySelector(s);
class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
const errorTranslations = [
  [
    /no schedulable host has enough capacity/i,
    "当前没有宿主机能够满足所选规格。请尝试选择较小的资源规格，或联系管理员检查宿主机状态和可分配额度。",
  ],
  [
    /selected network has no free IP address|no free ip/i,
    "所选网络没有可用 IP 地址。请联系管理员扩充地址范围，或处理已占用和隔离的地址。",
  ],
  [
    /no enabled network is available|network is not available/i,
    "当前没有可用网络。请联系管理员检查网络配置和 IP 地址池。",
  ],
  [/no enabled image is available|image is not available/i, "当前没有可用镜像，请联系管理员检查镜像状态。"],
  [/no enabled flavor is available|flavor is not available/i, "当前没有可用资源规格，请联系管理员检查规格状态。"],
  [/unauthorized|invalid credentials/i, "用户名或密码错误，请核对后重试。"],
  [/forbidden/i, "当前账号没有执行此操作的权限。"],
  [/expired instance must be renewed/i, "虚拟机已经到期，请先完成续期后再开机。"],
  [/instance still has an active task/i, "该虚拟机已有任务正在执行，请等待当前任务完成后重试。"],
  [/instance does not belong to the current user/i, "该虚拟机不属于当前账号，无法执行此操作。"],
  [/instance cannot .* from status/i, "虚拟机当前状态不允许执行该操作，请刷新页面后重试。"],
  [/lease_hours must be between 1 and 720/i, "使用时长必须在 1 至 720 小时之间。"],
  [/password length must be at least 12/i, "密码长度不能少于 12 个字符。"],
  [/gateway must be inside the network/i, "默认网关必须位于所填写的网络 CIDR 内。"],
  [/dns server must be an ipv4 address/i, "DNS 服务器必须填写有效的 IPv4 地址。"],
  [/ldap connection.*succeed/i, "LDAP 连接测试成功。"],
  [/request failed|internal server error/i, "平台暂时无法完成请求，请稍后重试；如持续失败，请联系管理员。"],
];
function localizeError(message) {
  const source = String(message || "请求失败").trim();
  const matched = errorTranslations.find(([pattern]) => pattern.test(source));
  if (matched) return matched[1];
  if (/failed to fetch|networkerror|load failed/i.test(source))
    return "无法连接平台服务，请检查网络连接后重试。";
  if (!/[\u3400-\u9fff]/.test(source))
    return "平台未能完成此操作，请稍后重试；如持续失败，请联系管理员查看操作审计和服务日志。";
  return source;
}
const api = async (path, opts = {}) => {
  const r = await fetch("/api/v1" + path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (r.status === 204) return null;
  const j = await r.json().catch(() => {
    throw new ApiError("平台服务返回异常，请稍后重试或联系管理员检查服务状态。", r.status);
  });
  if (!r.ok) throw new ApiError(localizeError(j.error), r.status);
  return j;
};
const state = {
  page: "dashboard",
  lastCredentials: null,
  detailInstanceID: null,
  selectedNetworkID: null,
  currentUser: null,
  listFilters: {
    users: { keyword: "", role: "", source: "", page: 1, pageSize: 10 },
    instances: { keyword: "", status: "", host: "", page: 1, pageSize: 20 },
    audit: { keyword: "", action: "", resourceType: "", outcome: "", scope: "HUMAN", dateFrom: "", dateTo: "", page: 1, pageSize: 20 },
  },
};
const labels = {
  dashboard: "资源总览",
  apply: "申请虚拟机",
  "my-instances": "我的虚拟机",
  requests: "我的申请",
  approvals: "待我审批",
  "all-instances": "全部实例",
  "instance-detail": "实例详情",
  hosts: "宿主机",
  images: "镜像",
  flavors: "资源规格",
  network: "网络 IP",
  users: "用户管理",
  ldap: "LDAP 配置",
  audit: "操作审计",
};
const statusLabels = {
  ACTIVE: "正常",
  RUNNING: "运行中",
  STOPPED: "已关机",
  RETAINED: "保留中",
  PROVISIONING: "创建中",
  STARTING: "开机中",
  STOPPING: "关机中",
  REBOOTING: "重启中",
  DELETING: "删除中",
  SUCCEEDED: "成功",
  APPROVED: "已通过",
  APPROVED_FAILED: "已通过但执行失败",
  REJECTED: "已拒绝",
  EXPIRED: "已超时关闭",
  WITHDRAWN: "已撤回",
  PROCESSING: "处理中",
  PENDING: "等待中",
  FAILED: "失败",
  ERROR: "异常",
  OFFLINE: "离线",
  FREE: "空闲",
  RESERVED: "预留",
  ALLOCATED: "已分配",
  QUARANTINED: "隔离",
};
function status(v) {
  const ok = ["ACTIVE", "RUNNING", "SUCCEEDED", "APPROVED"].includes(v),
    warn = [
      "PROVISIONING",
      "PENDING",
      "RESERVED",
      "STARTING",
      "STOPPING",
      "REBOOTING",
      "DELETING",
      "PROCESSING",
    ].includes(v),
    bad = ["FAILED", "ERROR", "OFFLINE", "REJECTED", "APPROVED_FAILED", "EXPIRED"].includes(v);
  return `<span class="pill ${ok ? "ok" : warn ? "warn" : bad ? "bad" : "blue"}">${statusLabels[v] || v || "-"}</span>`;
}
function fmtDate(v) {
  return v ? new Date(v).toLocaleString("zh-CN", { hour12: false }) : "-";
}
function leaseState(value) {
  if (!value) return { text: "-", level: "" };
  const milliseconds = new Date(value).getTime() - Date.now();
  if (milliseconds <= 0) return { text: "已到期", level: "expired" };
  const hours = milliseconds / 3600000;
  if (hours < 1)
    return {
      text: `还剩 ${Math.max(1, Math.ceil(milliseconds / 60000))} 分钟`,
      level: "critical",
    };
  if (hours < 6)
    return { text: `还剩 ${Math.ceil(hours)} 小时`, level: "critical" };
  if (hours < 24)
    return { text: `还剩 ${Math.ceil(hours)} 小时`, level: "warning" };
  return { text: `还剩 ${Math.ceil(hours / 24)} 天`, level: "" };
}
function paginate(items, filters) {
  const pages = Math.max(1, Math.ceil(items.length / filters.pageSize));
  filters.page = Math.min(Math.max(1, filters.page), pages);
  const start = (filters.page - 1) * filters.pageSize;
  return {
    items: items.slice(start, start + filters.pageSize),
    pages,
    total: items.length,
  };
}
function pagination(kind, result) {
  return `<div class="pagination"><span>共 ${result.total} 条，第 ${state.listFilters[kind].page} / ${result.pages} 页</span><div><button class="btn mini" data-list-page="${kind}" data-page="${state.listFilters[kind].page - 1}" ${state.listFilters[kind].page <= 1 ? "disabled" : ""}>上一页</button><button class="btn mini" data-list-page="${kind}" data-page="${state.listFilters[kind].page + 1}" ${state.listFilters[kind].page >= result.pages ? "disabled" : ""}>下一页</button></div></div>`;
}
function downloadCSV(filename, rows) {
  const csv = rows
    .map((row) =>
      row
        .map((value) => {
          let text = String(value ?? "");
          if (/^[=+\-@]/.test(text)) text = `'${text}`;
          return `"${text.replaceAll('"', '""')}"`;
        })
        .join(","),
    )
    .join("\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(
    new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }),
  );
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}
function gb(m) {
  return (Number(m || 0) / 1024).toFixed(1) + " GiB";
}
function lead(title, desc, action = "") {
  return `<div class="page-lead"><div><h2>${title}</h2><p>${desc}</p></div>${action}</div>`;
}
function esc(v) {
  return String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {}
  }
  const area = document.createElement("textarea");
  area.value = value;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

function closeModal() {
  $("#modal-root").innerHTML = "";
}

let alertPreviousFocus = null;
function closeAlert() {
  $("#alert-root").replaceChildren();
  alertPreviousFocus?.focus();
  alertPreviousFocus = null;
}

function showAlert({
  title = "操作未完成",
  message,
  type = "error",
  actionText = "我知道了",
}) {
  const root = $("#alert-root");
  if (!root.children.length) alertPreviousFocus = document.activeElement;
  const symbols = { error: "!", warning: "!", success: "✓", info: "i" };
  root.innerHTML = `<div class="alert-backdrop"><section class="alert-dialog ${esc(type)}" role="alertdialog" aria-modal="true" aria-labelledby="alert-title"><div class="alert-symbol" aria-hidden="true">${symbols[type] || "!"}</div><div class="alert-copy"><span class="alert-eyebrow">${type === "error" ? "操作失败" : type === "warning" ? "请注意" : "系统提示"}</span><h3 id="alert-title">${esc(title)}</h3><p>${esc(localizeError(message))}</p></div><button class="alert-close" type="button" aria-label="关闭提示">×</button><div class="alert-actions"><button class="btn primary" type="button" data-alert-confirm>${esc(actionText)}</button></div></section></div>`;
  root.querySelector(".alert-close").onclick = closeAlert;
  root.querySelector("[data-alert-confirm]").onclick = closeAlert;
  root.querySelector(".alert-backdrop").onclick = (event) => {
    if (event.target === event.currentTarget) closeAlert();
  };
  root.onkeydown = (event) => {
    if (event.key === "Escape") closeAlert();
    if (event.key === "Tab") {
      const buttons = [...root.querySelectorAll("button")];
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };
  setTimeout(() => root.querySelector("[data-alert-confirm]")?.focus(), 0);
}

function showFormModal({
  title,
  description = "",
  content,
  submitText = "保存",
  compact = false,
  onSubmit,
}) {
  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-backdrop"><form class="modal-card ${compact ? "compact" : ""}" id="modal-form"><div class="modal-head"><div><h3>${esc(title)}</h3><p>${esc(description)}</p></div><button class="modal-close" type="button" aria-label="关闭">×</button></div><div class="modal-body">${content}<div class="form-error" id="modal-error"></div></div><div class="modal-actions"><button class="btn" type="button" data-modal-cancel>取消</button><button class="btn primary" type="submit">${esc(submitText)}</button></div></form></div>`;
  const form = $("#modal-form");
  root.querySelector(".modal-close").onclick = closeModal;
  root.querySelector("[data-modal-cancel]").onclick = closeModal;
  root.querySelector(".modal-backdrop").onclick = (event) => {
    if (event.target === event.currentTarget) closeModal();
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    const error = $("#modal-error");
    const submit = form.querySelector('[type="submit"]');
    error.classList.remove("show");
    submit.disabled = true;
    submit.textContent = "提交中…";
    try {
      await onSubmit(new FormData(form), form);
      closeModal();
    } catch (reason) {
      error.textContent = localizeError(reason.message || "操作失败");
      error.classList.add("show");
      submit.disabled = false;
      submit.textContent = submitText;
    }
  };
  setTimeout(() => form.querySelector("input,select,textarea")?.focus(), 0);
  return form;
}

function field(name, label, value = "", options = {}) {
  const type = options.type || "text";
  const attrs = [
    `name="${esc(name)}"`,
    `type="${esc(type)}"`,
    `value="${esc(value)}"`,
    options.required === false ? "" : "required",
    options.min !== undefined ? `min="${options.min}"` : "",
    options.max !== undefined ? `max="${options.max}"` : "",
    options.step !== undefined ? `step="${options.step}"` : "",
    options.placeholder ? `placeholder="${esc(options.placeholder)}"` : "",
    options.autocomplete ? `autocomplete="${esc(options.autocomplete)}"` : "",
    options.readonly ? "readonly" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<div class="field ${options.full ? "full" : ""}"><label>${esc(label)}</label><input ${attrs}>${options.hint ? `<span class="input-hint">${esc(options.hint)}</span>` : ""}</div>`;
}

function showConfirmModal({
  title,
  description,
  confirmText,
  danger = false,
  onConfirm,
}) {
  showFormModal({
    title,
    description,
    compact: true,
    submitText: confirmText,
    content: `<div class="notice">请确认当前操作对象和影响范围，提交后平台将异步执行。</div>`,
    onSubmit: onConfirm,
  });
  if (danger) $("#modal-form [type=submit]").classList.add("danger");
}
function credentialResult(r) {
  const c = r.connection || {};
  return `${lead("申请已提交", "虚拟机正在异步交付，请立即保存下面的一次性凭据")}<div class="form-card credential-card"><div class="credential-warning">密码只在本次申请成功后显示，平台不保存明文密码。关闭页面后无法再次查看。</div><div class="credential-grid"><div><span>申请单</span><strong>${esc(r.request_no)}</strong></div><div><span>交付状态</span><strong>交付中</strong></div><div><span>IP 地址</span><code>${esc(c.ip_address)}</code></div><div><span>用户名</span><code>${esc(c.username)}</code></div><div class="full credential-secret"><span>一次性密码</span><code>${esc(c.password)}</code><button class="btn mini" data-copy-password>复制密码</button></div><div class="full"><span>SSH 命令</span><code>ssh ${esc(c.username)}@${esc(c.ip_address)}</code><button class="btn mini" data-copy-ssh>复制命令</button></div></div><label class="credential-confirm"><input type="checkbox" data-credentials-saved> <span>我已经复制并妥善保存登录密码</span></label><div class="form-actions"><button class="btn" data-copy-credentials>复制全部连接信息</button><button class="btn primary" data-go="my-instances" data-credentials-continue disabled>我已保存，查看虚拟机</button></div></div>`;
}

function approvalSubmittedResult(r) {
  return `${lead("申请已进入审批", "租期超过 7 天，管理员批准后平台才会分配资源并执行")}<div class="form-card credential-card"><div class="credential-warning">审批期间不会预占宿主机、IP 或磁盘资源。批准后可在“我的申请”和“我的虚拟机”查看执行结果。</div><div class="credential-grid"><div><span>审批单</span><strong>${esc(r.request_no)}</strong></div><div><span>申请类型</span><strong>${esc(approvalTypeLabel(r.request_type))}</strong></div><div><span>申请租期</span><strong>${leaseHoursLabel(r.requested_hours)}</strong></div><div><span>当前状态</span><strong>等待管理员审批</strong></div></div><div class="form-actions"><button class="btn" data-go="requests">查看我的申请</button><button class="btn primary" data-go="my-instances">返回我的虚拟机</button></div></div>`;
}

function leaseHoursLabel(hours) {
  const value = Number(hours || 0);
  return value > 0 && value % 24 === 0 ? `${value / 24} 天` : `${value} 小时`;
}

function approvalTypeLabel(type) {
  return ({ CREATE: "创建虚拟机", RENEW: "续期", RESTORE: "恢复保留期实例" })[type] || type || "-";
}

async function dashboard() {
  const [s, instances] = await Promise.all([
    api("/summary"),
    api("/instances?scope=mine"),
  ]);
  const ratio = s.allocatable_memory_mb
    ? Math.round((s.reserved_memory_mb / s.allocatable_memory_mb) * 100)
    : 0;
  return `${lead("资源总览", "临时计算资源、我的虚拟机与平台容量状态")}${s.pending_approvals ? `<button class="pending-approval-banner" data-go="approvals"><b>待审批 ${s.pending_approvals} 条</b><span>有长租期申请等待处理，点击立即审批 →</span></button>` : ""}<div class="cards"><div class="metric"><span class="label">在线宿主机</span><strong>${s.active_hosts}</strong><small>由 Agent 持续心跳</small></div><div class="metric"><span class="label">运行中实例</span><strong>${s.running_instances}</strong><small>${s.provisioning_instances} 台交付中</small></div><div class="metric"><span class="label">我的虚拟机</span><strong>${instances.items.length}</strong><small>当前账号 ${esc(state.currentUser?.username || "-")}</small></div><div class="metric"><span class="label">内存预占率</span><strong>${ratio}%</strong><small>${gb(s.reserved_memory_mb)} / ${gb(s.allocatable_memory_mb)}</small></div></div><div class="grid2"><div class="panel"><h3>集群容量</h3><div class="capacity-row"><div><span>临时资源池内存</span><b>${ratio}%</b></div><div class="capacity"><span style="width:${ratio}%"></span></div></div><p style="color:var(--muted)">申请时在同一个数据库事务内完成宿主机资源和 IP 地址预占，避免并发超卖。</p></div><div class="panel"><h3>快捷操作</h3><div class="quick"><button data-go="apply">＋<br>申请虚拟机</button><button data-go="my-instances">▣<br>我的虚拟机</button><button data-go="hosts">⌁<br>宿主状态</button><button data-go="network">⌘<br>网络 IP</button></div></div></div>${instances.items.length ? `<div class="panel" style="margin-top:18px"><h3>我的最近实例</h3>${instanceTable(instances.items.slice(0, 5), false)}</div>` : ""}`;
}

async function applyPage() {
  const [f, i, n] = await Promise.all([
    api("/flavors"),
    api("/images"),
    api("/networks"),
  ]);
  const flavors = f.items.filter((item) => item.enabled !== false);
  const images = i.items.filter((item) => item.enabled !== false);
  const networks = n.items.filter((item) => item.enabled);
  const firstFlavor = flavors[0];
  const firstImage = images[0];
  const firstNetwork = networks[0];
  return `${lead("申请虚拟机", "7 天以内自动交付；超过 7 天由管理员审批后调度")}<div class="apply-layout"><form class="form-card apply-card" id="apply-form"><div class="form-grid"><div class="field"><label>实例名称 <span class="required-mark">*</span></label><input name="instance_name" required maxlength="48" pattern="[a-zA-Z0-9-]+" data-instance-name placeholder="例如 dev-api-01"><small data-name-hint>仅支持字母、数字和连字符</small></div><div class="field"><label>使用时长 <span class="required-mark">*</span></label><select name="lease_hours"><option value="8">8 小时 · 自动交付</option><option value="24" selected>1 天 · 自动交付</option><option value="72">3 天 · 自动交付</option><option value="168">7 天 · 自动交付</option><option value="336">14 天 · 需要审批</option></select></div><div class="field full"><label>资源规格 <span class="required-mark">*</span></label><div class="flavor-selector">${flavors.map((x, index) => `<label class="flavor-option ${index === 0 ? "selected" : ""}"><input type="radio" name="flavor_id" value="${x.id}" data-name="${esc(x.name)}" data-cpu="${x.cpu}" data-memory="${x.memory_mb}" data-disk="${x.disk_gb}" ${index === 0 ? "checked" : ""}><b>${esc(x.name)}</b><span>${x.cpu} vCPU · ${gb(x.memory_mb)} · ${x.disk_gb} GiB 系统盘</span><small>${x.cpu >= 4 ? "适合构建 / 数据库" : x.cpu >= 2 ? "适合常规开发" : "适合轻量编译 / 测试"}</small></label>`).join("")}</div></div><div class="field"><label>系统镜像 <span class="required-mark">*</span></label><select name="image_id">${images.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}</select></div><div class="field"><label>网络 <span class="required-mark">*</span></label><select name="network_id">${networks
    .filter((x) => x.enabled)
    .map(
      (x) =>
        `<option value="${x.id}">${x.name} · ${x.cidr} · 可用 ${x.free}</option>`,
    )
    .join(
      "",
    )}</select></div><div class="field full"><label>用途说明 <span class="required-mark">*</span></label><textarea name="purpose" required placeholder="说明项目、使用场景以及需要临时服务器的原因"></textarea></div></div><div class="form-actions"><button type="button" class="btn" data-go="dashboard">取消</button><button class="btn primary" type="submit">提交申请 →</button></div></form><div class="apply-side"><div class="panel apply-summary"><h3>申请摘要</h3><span class="source-sub">随左侧选择实时更新</span><dl><div><dt>规格</dt><dd data-summary-flavor>${esc(firstFlavor?.name || "-")}</dd></div><div><dt>镜像</dt><dd data-summary-image>${esc(firstImage?.name || "-")}</dd></div><div><dt>网络</dt><dd data-summary-network>${esc(firstNetwork?.cidr || "-")}</dd></div><div><dt>租期</dt><dd data-summary-lease>1 天</dd></div><div><dt>预计到期</dt><dd data-summary-expiry>-</dd></div><div><dt>预计占用</dt><dd data-summary-resource>${firstFlavor ? `${gb(firstFlavor.memory_mb)} 内存 · ${firstFlavor.disk_gb} GB 磁盘` : "-"}</dd></div></dl></div><div class="panel apply-notice"><h3>交付说明</h3><ul><li>7 天以内自动调度，通常 1–3 分钟完成交付</li><li>超过 7 天等待管理员审批，审批期间不占用资源</li><li>登录密码仅展示一次，丢失可在实例详情重置</li><li>到期关机后进入 7 天保留期，可保留原 IP 恢复</li></ul></div></div></div>`;
}

function instanceActions(x, includeDetail = true) {
  const buttons = includeDetail ? [["detail", "详情"]] : [];
  if (!includeDetail && x.lifecycle_status === "RUNNING")
    buttons.push(["reset_password", "重置登录密码"]);
  if (!includeDetail && x.lifecycle_status === "RUNNING")
    buttons.push(["console_vnc", "VNC 控制台"], ["console_serial", "串口控制台"]);
  if (x.lifecycle_status === "RUNNING")
    buttons.push(["stop", "关机"], ["reboot", "重启"]);
  if (x.lifecycle_status === "STOPPED") buttons.push(["start", "开机"]);
  if (x.lifecycle_status === "ERROR") buttons.push(["retry", "重试创建"]);
  if (["RUNNING", "STOPPED"].includes(x.lifecycle_status))
    buttons.push(["renew", "续期"]);
  if (x.lifecycle_status === "RETAINED" && Number(x.restore_count || 0) < 1) buttons.push(["restore", "恢复"]);
  if (["RUNNING", "STOPPED"].includes(x.lifecycle_status))
    buttons.push(["release", "释放"]);
  if (["RUNNING", "STOPPED", "RETAINED", "ERROR"].includes(x.lifecycle_status))
    buttons.push(["force_delete", "立即删除"]);
  const pending = [
    "PROVISIONING",
    "STARTING",
    "STOPPING",
    "REBOOTING",
    "DELETING",
  ].includes(x.lifecycle_status)
    ? '<button class="btn mini" disabled>操作处理中…</button>'
    : "";
  return (
    buttons
      .map(
        ([action, label]) =>
          `<button class="btn mini ${action === "release" || action === "force_delete" ? "danger" : ""}" data-instance-action="${action}" data-instance-id="${x.id}" data-instance-name="${esc(x.name)}" data-restore-count="${Number(x.restore_count || 0)}">${label}</button>`,
      )
      .join("") + pending
  );
}
function instanceTable(items, showOwner = true, showActions = false) {
  const columns = (showOwner ? 7 : 6) + (showActions ? 1 : 0);
  return `<table><thead><tr><th>实例</th>${showOwner ? "<th>使用人</th>" : ""}<th>规格 / 镜像</th><th>宿主机</th><th>IP 地址</th><th>状态</th><th>到期时间</th>${showActions ? "<th>操作</th>" : ""}</tr></thead><tbody>${
    items.length
      ? items
          .map((x) => {
            const lease = leaseState(x.expires_at);
            return `<tr class="lease-${lease.level}"><td><b>${esc(x.name)}</b><br><small>${esc(x.username || "-")}</small></td>${showOwner ? `<td>${esc(x.owner || "-")}</td>` : ""}<td>${esc(x.flavor)}<br><small>${esc(x.image)}</small></td><td>${esc(x.host || "-")}</td><td><span>${esc(x.ip_address || "分配中")}</span>${x.ip_address && x.username ? `<button class="copy-inline" data-copy-value="ssh ${esc(x.username)}@${esc(x.ip_address)}" title="复制 SSH 命令">复制 SSH</button>` : ""}</td><td>${status(x.lifecycle_status)}</td><td>${fmtDate(x.expires_at)}<br><small class="lease-relative ${lease.level}">${lease.text}</small>${x.retention_until ? `<br><small>保留至 ${fmtDate(x.retention_until)}</small>` : ""}</td>${showActions ? `<td><div class="instance-actions">${instanceActions(x)}</div></td>` : ""}</tr>`;
          })
          .join("")
      : `<tr><td colspan="${columns}" class="empty">暂无实例，先提交一台试试</td></tr>`
  }</tbody></table>`;
}
async function myInstances() {
  const x = await api("/instances?scope=mine");
  const expiring = x.items.filter((item) => {
    const hours = (new Date(item.expires_at).getTime() - Date.now()) / 3600000;
    return hours > 0 && hours < 24;
  });
  const noticeKey = expiring.map((item) => item.id).sort().join(",");
  if (noticeKey && noticeKey !== state.expiryNoticeKey) {
    state.expiryNoticeKey = noticeKey;
    setTimeout(
      () =>
        toast(`${expiring.length} 台虚拟机将在 24 小时内到期，请及时续期。`, "warning", {
          title: "到期提醒",
          duration: 8000,
        }),
      0,
    );
  }
  return (
    lead(
      "我的虚拟机",
      "当前账号申请并由平台管理的临时虚拟机",
      '<button class="btn primary" data-go="apply">＋ 申请虚拟机</button>',
    ) +
    `${expiring.length ? `<div class="expiry-alert"><b>${expiring.length} 台虚拟机将在 24 小时内到期</b><span>请及时续期；到期关机后数据和原 IP 仍保留 7 天。</span></div>` : ""}<div class="resource-table-wrap" data-instance-table="mine">${instanceTable(x.items, false, true)}</div>`
  );
}

function approvalTable(items, administrator = false) {
  const columns = administrator ? 9 : 7;
  const rows = items.length
    ? items.map((item) => {
        const resultError = item.result?.error ? `<span class="source-sub validation-error">${esc(item.result.error)}</span>` : "";
        const review = item.reviewer ? `${esc(item.reviewer)}${item.review_comment ? `<span class="source-sub">${esc(item.review_comment)}</span>` : ""}` : "-";
        const resultInstanceID = item.result?.instance_id || item.result?.id || item.instance_id;
        const result = resultInstanceID
          ? `<button class="btn mini" data-approval-instance="${esc(resultInstanceID)}">查看实例</button>${item.request_type === "CREATE" ? '<span class="source-sub">批准后请在实例详情重置登录密码</span>' : ""}`
          : "-";
        const actions = administrator && item.status === "PENDING"
          ? `<div class="row-actions"><button class="btn mini primary" data-approval-decision="APPROVE" data-approval-id="${item.id}" data-approval-no="${esc(item.request_no)}" data-approval-hours="${item.requested_hours}">批准</button><button class="btn mini danger" data-approval-decision="REJECT" data-approval-id="${item.id}" data-approval-no="${esc(item.request_no)}">拒绝</button></div>`
          : "-";
        const userActions = item.status === "PENDING"
          ? `<button class="btn mini danger" data-withdraw-approval="${item.id}" data-approval-no="${esc(item.request_no)}">撤回</button>`
          : ["REJECTED", "EXPIRED", "FAILED", "WITHDRAWN"].includes(item.status)
            ? `<button class="btn mini" data-resubmit-short="${item.id}" data-approval-type="${item.request_type}" data-approval-no="${esc(item.request_no)}">改成短租期重提</button>${result}`
            : result;
        const remaining = item.status === "PENDING" ? `<span class="source-sub">审批截止 ${fmtDate(item.expires_at)}</span>` : "";
        return `<tr>${administrator ? `<td><input type="checkbox" data-approval-select value="${item.id}" ${item.status === "PENDING" ? "" : "disabled"}></td>` : ""}<td><b>${esc(item.request_no)}</b><span class="source-sub">${fmtDate(item.created_at)}</span>${remaining}</td><td>${approvalTypeLabel(item.request_type)}</td>${administrator ? `<td><b>${esc(item.applicant)}</b></td>` : ""}<td><b>${esc(item.instance_name || "-")}</b><span class="source-sub">${esc(item.reason || "-")}</span></td><td>${leaseHoursLabel(item.requested_hours)}</td><td>${status(item.status)}${resultError}</td><td>${review}</td><td>${administrator ? actions : userActions}</td></tr>`;
      }).join("")
    : `<tr><td colspan="${columns}" class="empty">暂无审批记录</td></tr>`;
  return `<div class="resource-table-wrap"><table><thead><tr>${administrator ? '<th><input type="checkbox" data-approval-select-all></th>' : ""}<th>审批单 / 时间</th><th>类型</th>${administrator ? "<th>申请人</th>" : ""}<th>实例 / 原因</th><th>申请时长</th><th>状态</th><th>审批意见</th><th>${administrator ? "操作" : "结果"}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

async function requestsPage() {
  const result = await api("/approvals?scope=mine");
  return `${lead("我的申请", "查看超过 7 天的创建、续期和恢复申请及审批结果", '<button class="btn primary" data-go="apply">＋ 申请虚拟机</button>')}<div class="approval-rule"><b>审批规则</b><span>7 天以内自动执行；超过 7 天须管理员批准，等待期间不占用资源。</span></div>${approvalTable(result.items, false)}`;
}

async function approvalsPage() {
  const result = await api("/approvals");
  const pending = result.items.filter((item) => item.status === "PENDING");
  const finished = result.items.filter((item) => item.status !== "PENDING");
  return `${lead("待我审批", "审批超过 7 天的虚拟机创建、续期和保留期恢复申请")}<div class="approval-rule"><b>${pending.length} 个待处理</b><span>申请 24 小时未处理会自动关闭；批准后才实际调度资源。</span></div>${pending.length ? '<div class="batch-actions"><span data-batch-count>已选择 0 项</span><button class="btn mini primary" data-batch-approval="APPROVE">批量批准</button><button class="btn mini danger" data-batch-approval="REJECT">批量拒绝</button></div>' : ""}${approvalTable(pending, true)}${finished.length ? `<div class="section-title"><h3>最近处理</h3></div>${approvalTable(finished.slice(0, 30), true)}` : ""}`;
}
function filterInstanceItems(items) {
  const filters = state.listFilters.instances;
  const keyword = filters.keyword.toLowerCase();
  return items.filter(
    (item) =>
      (!keyword ||
        [item.name, item.owner, item.ip_address].some((value) =>
          String(value || "")
            .toLowerCase()
            .includes(keyword),
        )) &&
      (!filters.status || item.lifecycle_status === filters.status) &&
      (!filters.host || item.host === filters.host),
  );
}
async function allInstances() {
  const x = await api("/instances");
  const filters = state.listFilters.instances;
  const hosts = [
    ...new Set(x.items.map((item) => item.host).filter(Boolean)),
  ].sort();
  const filtered = filterInstanceItems(x.items);
  const result = paginate(filtered, filters);
  return `${lead("全部实例", "平台创建的全部临时虚拟机", '<button class="btn" data-export="instances">导出 CSV</button>')}<div class="list-toolbar"><input data-list-filter="instances" name="keyword" value="${esc(filters.keyword)}" placeholder="搜索实例名、用户名或 IP"><select data-list-filter="instances" name="status"><option value="">全部状态</option>${Object.entries(
    statusLabels,
  )
    .filter(([key]) =>
      ["RUNNING", "STOPPED", "RETAINED", "PROVISIONING", "ERROR"].includes(key),
    )
    .map(
      ([key, label]) =>
        `<option value="${key}" ${filters.status === key ? "selected" : ""}>${label}</option>`,
    )
    .join(
      "",
    )}</select><select data-list-filter="instances" name="host"><option value="">全部宿主机</option>${hosts.map((host) => `<option value="${esc(host)}" ${filters.host === host ? "selected" : ""}>${esc(host)}</option>`).join("")}</select></div><div class="resource-table-wrap" data-instance-table="all">${instanceTable(result.items, true, true)}</div>${pagination("instances", result)}`;
}

function deliveryProgress(instance, tasks) {
  const createTask = tasks.find((task) => task.task_type === "CREATE_INSTANCE");
  const failed =
    createTask?.status === "FAILED" || instance.lifecycle_status === "ERROR";
  const completed =
    createTask?.status === "SUCCEEDED" ||
    instance.lifecycle_status === "RUNNING";
  const running = createTask?.status === "RUNNING";
  const steps = [
    ["申请已受理", "done"],
    ["等待宿主机 Agent", createTask ? "done" : "active"],
    [
      "创建磁盘、启动并配置网络",
      failed ? "failed" : completed ? "done" : running ? "active" : "",
    ],
    ["网络可连接", failed ? "" : completed ? "done" : ""],
  ];
  return `<div class="delivery-progress"><div class="delivery-progress-head"><div><h3>交付进度</h3><p>Agent 完成磁盘、启动和网络检查后，实例才会进入运行中。</p></div>${failed ? '<span class="pill bad">交付失败</span>' : completed ? '<span class="pill ok">交付完成</span>' : '<span class="pill warn">交付中</span>'}</div><div class="delivery-steps">${steps.map(([label, stepState], index) => `<div class="delivery-step ${stepState}"><i>${stepState === "done" ? "✓" : index + 1}</i><span>${label}</span></div>`).join("")}</div></div>`;
}

async function instanceDetailPage() {
  if (!state.detailInstanceID) return lead("实例详情", "未选择实例");
  const x = await api("/instances/" + state.detailInstanceID);
  const i = x.instance;
  const toolbar = `<div class="row-actions"><button class="btn" data-go="my-instances">返回列表</button>${instanceActions(i, false)}</div>`;
  const audit = x.audit_logs.length
    ? x.audit_logs
        .slice(0, 8)
        .map(
          (item) =>
            `<p><b>${esc(item.action)}</b><br><small>${esc(item.actor)} · ${fmtDate(item.created_at)}</small></p>`,
        )
        .join("")
    : '<p class="empty">暂无记录</p>';
  const tasks = x.tasks.length
    ? x.tasks
        .map(
          (task) =>
            `<tr><td>${esc(task.task_type)}</td><td>${status(task.status)}</td><td>${task.attempt}/${task.max_attempts}</td><td>${esc(task.error_message || "-")}</td><td>${fmtDate(task.created_at)}</td></tr>`,
        )
        .join("")
    : '<tr><td colspan="5" class="empty">暂无任务</td></tr>';
  return `${lead(i.name, "虚拟机配置、租期、任务和审计记录", toolbar)}${deliveryProgress(i, x.tasks)}<div class="cards"><div class="metric"><span class="label">状态</span><strong>${esc(i.lifecycle_status)}</strong><small>${esc(i.provider_status)}</small></div><div class="metric"><span class="label">资源</span><strong>${i.flavor.cpu}C / ${gb(i.flavor.memory_mb)}</strong><small>${i.flavor.disk_gb} GB 系统盘</small></div><div class="metric"><span class="label">IP 地址</span><strong>${esc(i.ip_address || "-")}</strong><small>${esc(i.username || "-")}</small></div><div class="metric"><span class="label">租期</span><strong>${fmtDate(i.expires_at)}</strong><small>${i.retention_until ? `保留至 ${fmtDate(i.retention_until)}` : "未进入保留期"}</small></div></div><div class="grid2"><div class="panel"><h3>实例信息</h3><dl class="detail-list"><div><dt>申请单</dt><dd>${esc(i.request_no)}</dd></div><div><dt>用途</dt><dd>${esc(i.purpose)}</dd></div><div><dt>宿主机</dt><dd>${esc(i.host || "-")}</dd></div><div><dt>镜像</dt><dd>${esc(i.image.name)}</dd></div><div><dt>镜像来源</dt><dd>${esc(i.image.source_type)} / ${esc(i.image.sync_status)}</dd></div><div><dt>镜像位置</dt><dd>${esc(i.image.source_location || "-")}</dd></div><div><dt>创建时间</dt><dd>${fmtDate(i.created_at)}</dd></div></dl></div><div class="panel"><h3>最近审计</h3>${audit}</div></div><div class="panel" style="margin-top:18px"><h3>任务历史</h3><div class="resource-table-wrap"><table><thead><tr><th>任务</th><th>状态</th><th>尝试</th><th>错误</th><th>时间</th></tr></thead><tbody>${tasks}</tbody></table></div></div>`;
}

const auditActionLabels = {
  "auth.login": "用户登录",
  "auth.logout": "退出登录",
  "auth.password.change": "修改自身密码",
  "application.create": "申请虚拟机",
  "instance.release": "释放实例",
  "instance.force_delete": "立即删除实例",
  "instance.reset_password": "重置实例密码",
  "instance.start": "开机",
  "instance.stop": "关机",
  "instance.reboot": "重启",
  "instance.renew": "续期",
  "instance.restore": "恢复保留期实例",
  "instance.console.open": "打开控制台",
  "instance.retry": "重试创建",
  "user.create": "创建用户",
  "user.update": "修改用户",
  "user.delete": "删除用户",
  "user.reset_password": "重置用户密码",
  "ldap.config": "修改 LDAP 配置",
  "ldap.test": "测试 LDAP 连接",
  "ldap.sync": "同步 LDAP 用户",
  "hosts.status": "调整宿主机状态",
  "hosts.quota": "调整宿主机配额",
  "hosts.delete": "删除宿主机",
  "flavors.create": "创建资源规格",
  "flavors.update": "修改资源规格",
  "flavors.delete": "删除资源规格",
  "images.create": "创建镜像",
  "images.update": "修改镜像",
  "images.delete": "删除镜像",
  "networks.create": "创建网络",
  "networks.update": "修改网络",
  "networks.delete": "删除网络",
  "networks.ip-ranges": "修改 IP 范围",
  "approval.submit": "提交审批",
  "approval.approve": "批准审批",
  "approval.reject": "拒绝审批",
};

const auditResourceLabels = { user: "用户", session: "会话", application: "申请单", approval: "审批单", instance: "实例", host: "宿主机", flavor: "资源规格", image: "镜像", network: "网络", configuration: "配置" };

function auditDateTime(value, endOfDay = false) {
  if (!value) return "";
  const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`);
  return date.toISOString();
}

async function auditPage() {
  const filters = state.listFilters.audit;
  const params = new URLSearchParams({
    page: String(filters.page),
    page_size: String(filters.pageSize),
  });
  if (filters.keyword) params.set("keyword", filters.keyword);
  if (filters.action) params.set("action", filters.action);
  if (filters.resourceType) params.set("resource_type", filters.resourceType);
  if (filters.outcome) params.set("outcome", filters.outcome);
  if (filters.scope) params.set("scope", filters.scope);
  if (filters.dateFrom) params.set("from", auditDateTime(filters.dateFrom));
  if (filters.dateTo) params.set("to", auditDateTime(filters.dateTo, true));
  const result = await api("/audit-logs?" + params.toString());
  const pages = Math.max(1, Math.ceil(result.total / result.page_size));
  const rows = result.items.length
    ? result.items.map((item) => `<tr><td><b>${esc(auditActionLabels[item.action] || item.action)}</b><span class="source-sub">${esc(item.action)}</span></td><td><b>${esc(item.actor)}</b><span class="source-sub">${esc(item.source_ip || "-")}</span></td><td>${esc(item.resource_type)}<span class="source-sub audit-resource">${esc(item.resource_id)}</span></td><td>${item.outcome === "SUCCESS" ? '<span class="pill ok">● 成功</span>' : '<span class="pill bad">● 失败</span>'}</td><td>${fmtDate(item.created_at)}</td><td><details class="audit-detail"><summary>查看</summary><pre>${esc(JSON.stringify(item.detail || {}, null, 2))}</pre>${item.user_agent ? `<small>${esc(item.user_agent)}</small>` : ""}</details></td></tr>`).join("")
    : '<tr><td colspan="6" class="empty">没有符合条件的操作记录</td></tr>';
  const availableActions = [...new Set([...Object.keys(auditActionLabels), ...(result.actions || [])])].sort((left, right) => (auditActionLabels[left] || left).localeCompare(auditActionLabels[right] || right, "zh-CN"));
  const actionOptions = availableActions.map((action) => `<option value="${esc(action)}" ${filters.action === action ? "selected" : ""}>${esc(auditActionLabels[action] || action)}</option>`).join("");
  const resourceOptions = (result.resource_types || []).map((type) => `<option value="${esc(type)}" ${filters.resourceType === type ? "selected" : ""}>${esc(auditResourceLabels[type] || type)}</option>`).join("");
  return `${lead("操作审计", "平台级操作流水，用于问题追溯与合规审查；系统事件默认隔离展示")}<div class="resource-table-wrap audit-table"><div class="list-toolbar table-toolbar audit-filters"><input data-list-filter="audit" name="keyword" value="${esc(filters.keyword)}" placeholder="⌕  搜索操作人 / 动作 / 资源 ID"><div class="table-filter-group"><select data-list-filter="audit" name="scope"><option value="HUMAN" ${filters.scope === "HUMAN" ? "selected" : ""}>人工操作</option><option value="SYSTEM" ${filters.scope === "SYSTEM" ? "selected" : ""}>系统事件</option><option value="ALL" ${filters.scope === "ALL" ? "selected" : ""}>全部来源</option></select><select data-list-filter="audit" name="action"><option value="">全部动作</option>${actionOptions}</select><select data-list-filter="audit" name="resourceType"><option value="">全部资源</option>${resourceOptions}</select><select data-list-filter="audit" name="outcome"><option value="">全部结果</option><option value="SUCCESS" ${filters.outcome === "SUCCESS" ? "selected" : ""}>成功</option><option value="FAILED" ${filters.outcome === "FAILED" ? "selected" : ""}>失败</option></select><label class="audit-date">开始 <input type="date" data-list-filter="audit" name="dateFrom" value="${esc(filters.dateFrom)}"></label><label class="audit-date">结束 <input type="date" data-list-filter="audit" name="dateTo" value="${esc(filters.dateTo)}"></label><span>共 <b>${result.total}</b> 条</span></div></div><table><thead><tr><th>操作</th><th>操作人 / 来源 IP</th><th>资源</th><th>结果</th><th>时间</th><th>详情</th></tr></thead><tbody>${rows}</tbody></table><div class="pagination"><span>第 ${result.page} / ${pages} 页</span><div><button class="btn mini" data-list-page="audit" data-page="${result.page - 1}" ${result.page <= 1 ? "disabled" : ""}>上一页</button><button class="btn mini" data-list-page="audit" data-page="${result.page + 1}" ${result.page >= pages ? "disabled" : ""}>下一页</button></div></div></div>`;
}

async function hosts() {
  const x = await api("/hosts");
  return `${lead("宿主机", "Agent 上报硬件安全上限，管理员同时配置 CPU、内存和磁盘调度额度")}<div class="host-grid wide">${
    x.items
      .map((h) => {
        const facts = h.facts?.host || {};
        const quotaRows = [
          [
            "CPU",
            h.reserved_cpu,
            h.allocatable_cpu,
            h.agent_allocatable_cpu,
            "C",
          ],
          [
            "内存",
            h.reserved_memory_mb,
            h.allocatable_memory_mb,
            h.agent_allocatable_memory_mb,
            "MB",
          ],
          [
            "磁盘",
            h.reserved_disk_gb,
            h.allocatable_disk_gb,
            h.agent_allocatable_disk_gb,
            "GB",
          ],
        ];
        return `<div class="host ${h.agent_mode === "kvm" ? "featured" : ""}"><div class="host-head"><div><h3>${esc(h.name)}</h3><div class="host-meta"><span class="pill blue">${esc(h.provider_type)}</span><span class="pill">${esc(h.agent_mode)}</span><span class="pill">${esc(facts.bridges?.join(", ") || "无 Bridge")}</span></div></div>${status(h.status)}</div>${quotaRows
          .map(([label, used, quota, limit, unit]) => {
            const percent = quota
              ? Math.min(100, Math.round((used / quota) * 100))
              : 0;
            return `<div class="quota-line"><span>${label}</span><div class="capacity"><span style="width:${percent}%"></span></div><b>${used} / ${quota} / ${limit} ${unit}</b></div>`;
          })
          .join(
            "",
          )}<dl><div><dt>最近心跳</dt><dd>${fmtDate(h.last_heartbeat_at)}</dd></div><div><dt>发现 / 外部虚拟机</dt><dd>${h.discovered_instances || 0} / ${h.external_instances || 0} 台</dd></div><div><dt>libvirt</dt><dd>${facts.libvirt_version || "-"}</dd></div><div><dt>QEMU</dt><dd>${facts.hypervisor_version || "-"}</dd></div></dl><div class="form-actions"><button class="btn" data-host-quota='${esc(JSON.stringify(h))}'>配置调度额度</button><button class="btn" data-host="${h.id}" data-status="${h.status === "CORDONED" ? "ACTIVE" : "CORDONED"}">${h.status === "CORDONED" ? "恢复调度" : "暂停调度"}</button><button class="btn danger" data-delete-host="${h.id}" data-name="${esc(h.name)}">删除纳管</button></div></div>`;
      })
      .join("") || '<div class="panel empty">暂无已注册 Agent</div>'
  }</div>`;
}

async function images() {
  const x = await api("/images?all=1");
  return `${lead("镜像管理", "统一管理宿主机本地镜像与 HTTP(S) / OSS 远程镜像", '<button class="btn primary" data-new-image>＋ 新增镜像</button>')}<div class="management-toolbar"><span class="summary">共 ${x.items.length} 个镜像，远程镜像在校验和同步完成前不可启用</span></div><div class="resource-table-wrap sticky-actions"><table><thead><tr><th>镜像</th><th>来源</th><th>完整路径 / 远程地址</th><th>系统</th><th>同步</th><th>状态</th><th>操作</th></tr></thead><tbody>${x.items.map((i) => `<tr><td><b>${esc(i.name)}</b><span class="source-sub">ID: ${esc(i.id)}</span></td><td><span class="type-badge ${i.source_type === "remote" ? "remote" : ""}">${i.source_type === "remote" ? "远程镜像" : "本地镜像"}</span></td><td class="source-cell"><span class="source-main">${esc(i.source_location || "未配置")}</span><span class="source-sub">${i.source_type === "remote" ? `本地缓存：${esc(i.file_name || "-")}` : `镜像文件：${esc(i.file_name || "-")}`}</span>${i.checksum ? `<span class="source-sub">SHA-256：${esc(i.checksum)}</span>` : ""}</td><td>${esc(i.os_family)} ${esc(i.version)}</td><td>${status(i.sync_status)}</td><td>${i.enabled ? status("ACTIVE") : '<span class="pill">DISABLED</span>'}</td><td><div class="row-actions"><button class="btn mini" data-edit-image='${esc(JSON.stringify(i))}'>编辑</button><button class="btn mini" data-toggle-image="${i.id}" data-enabled="${!i.enabled}">${i.enabled ? "停用" : "启用"}</button><button class="btn mini danger" data-delete-image="${i.id}" data-name="${esc(i.name)}">删除</button></div></td></tr>`).join("")}</tbody></table></div>`;
}
async function flavors() {
  const [x, instances, summary] = await Promise.all([
    api("/flavors?all=1"),
    api("/instances"),
    api("/summary"),
  ]);
  const usage = new Map();
  x.items.forEach((flavor) =>
    usage.set(flavor.name, { running: 0, retained: 0, reserved: 0 }),
  );
  instances.items.forEach((instance) => {
    const item = usage.get(instance.flavor);
    const flavor = x.items.find((candidate) => candidate.name === instance.flavor);
    if (!item || !flavor) return;
    if (instance.lifecycle_status === "RUNNING") item.running += 1;
    if (instance.lifecycle_status === "RETAINED") item.retained += 1;
    if (!["RELEASED", "DELETED"].includes(instance.lifecycle_status))
      item.reserved += Number(flavor.memory_mb || 0);
  });
  return `${lead("资源规格", "固定规格定义，用户申请时选择", '<button class="btn primary" data-new-flavor>＋ 新增规格</button>')}<div class="flavor-admin-grid">${x.items.map((f) => `<div class="flavor-admin-card"><div class="flavor-admin-head"><div><h3>${esc(f.name)}</h3><p>${f.cpu} vCPU · ${gb(f.memory_mb)} · ${f.disk_gb} GiB</p></div>${f.enabled ? status("ACTIVE") : '<span class="pill">已停用</span>'}</div><div class="flavor-admin-actions"><button class="btn mini" data-edit-flavor='${esc(JSON.stringify(f))}'>编辑</button><button class="btn mini" data-toggle-flavor="${f.id}" data-name="${esc(f.name)}" data-cpu="${f.cpu}" data-memory="${f.memory_mb}" data-disk="${f.disk_gb}" data-enabled="${!f.enabled}">${f.enabled ? "停用" : "启用"}</button><button class="btn mini danger" data-delete-flavor="${f.id}" data-name="${esc(f.name)}">删除</button></div></div>`).join("")}</div><div class="resource-table-wrap flavor-usage"><div class="table-caption">各规格当前占用</div><table><thead><tr><th>规格</th><th>运行中</th><th>保留中</th><th>内存预占</th><th>占比</th></tr></thead><tbody>${x.items.map((f) => { const item = usage.get(f.name); const ratio = summary.allocatable_memory_mb ? Math.min(100, Math.round((item.reserved / summary.allocatable_memory_mb) * 100)) : 0; return `<tr><td><b>${esc(f.name)}</b><span class="source-sub">${f.cpu} vCPU · ${gb(f.memory_mb)} · ${f.disk_gb} GiB</span></td><td>${item.running}</td><td>${item.retained}</td><td>${gb(item.reserved)}</td><td><div class="usage-ratio"><div class="capacity"><span style="width:${ratio}%"></span></div><small>${ratio}%</small></div></td></tr>`; }).join("")}</tbody></table></div>`;
}
async function network() {
  const [n, instances] = await Promise.all([
    api("/networks"),
    api("/instances"),
  ]);
  if (!state.selectedNetworkID && n.items.length)
    state.selectedNetworkID = n.items[0].id;
  const selected =
    n.items.find((item) => item.id === state.selectedNetworkID) || n.items[0];
  const ips = selected
    ? await api("/ip-addresses?network_id=" + selected.id)
    : { items: [] };
  const instanceByIP = new Map(
    instances.items.filter((item) => item.ip_address).map((item) => [item.ip_address, item]),
  );
  const occupied = ips.items.filter((ip) => ip.status !== "FREE");
  return `${lead("网络 IP", "维护网络、地址范围及当前 IP 分配状态", '<button class="btn primary" data-new-network>＋ 新增网络</button>')}<div class="host-grid network-grid">${n.items.map((x) => `<div class="host network-card ${selected?.id === x.id ? "selected" : ""}" data-select-network="${x.id}"><div class="host-head"><div><h3>${esc(x.name)}</h3><span class="source-sub">${esc(x.cidr)}</span></div>${x.enabled ? status("ACTIVE") : '<span class="pill">已停用</span>'}</div><dl><div><dt>IP 范围</dt><dd>${esc(x.ip_range_start || "-")} – ${esc(x.ip_range_end || "-")}</dd></div><div><dt>网关 / Bridge</dt><dd>${esc(x.gateway)} / ${esc(x.bridge)}</dd></div><div><dt>空闲</dt><dd>${x.free} 个</dd></div><div><dt>已分配 / 总数</dt><dd>${x.allocated} / ${x.total}</dd></div></dl><div class="capacity"><span style="width:${x.total ? Math.round(((x.allocated + x.reserved) / x.total) * 100) : 0}%"></span></div><div class="form-actions"><button class="btn primary" data-edit-network='${esc(JSON.stringify(x))}'>编辑网络与 IP 范围</button><button class="btn danger" data-delete-network="${x.id}" data-name="${esc(x.name)}">删除网络</button></div></div>`).join("") || '<div class="panel empty">尚未定义网络，请先由管理员创建</div>'}</div>${selected ? `<div class="panel ip-pool-panel"><div class="ip-pool-head"><div><h3>${esc(selected.name)} · 当前 IP 范围</h3><span class="source-sub">${esc(selected.ip_range_start || "-")} – ${esc(selected.ip_range_end || "-")}，共 ${ips.items.length} 个可管理地址</span></div><div class="ip-legend"><span>空闲 ${selected.free}</span><span class="used">已分配 ${selected.allocated}</span><span class="reserved">预留 ${selected.reserved}</span><span class="quarantine">隔离 ${selected.quarantined}</span></div></div><div class="ip-grid">${ips.items.map((ip) => `<span class="ip ${ip.status.toLowerCase()}" title="${esc(ip.instance_name || statusLabels[ip.status] || ip.status)}">${esc(ip.address)}<small>${esc(statusLabels[ip.status] || ip.status)}</small></span>`).join("")}</div></div><div class="resource-table-wrap allocated-table"><div class="table-caption">已占用 IP</div><table><thead><tr><th>IP 地址</th><th>实例</th><th>所有者</th><th>状态</th><th>分配时间</th></tr></thead><tbody>${occupied.length ? occupied.map((ip) => { const instance = instanceByIP.get(ip.address); const retained = instance?.lifecycle_status === "RETAINED"; return `<tr><td><b>${esc(ip.address)}</b></td><td>${esc(ip.instance_name || instance?.name || "-")}</td><td>${esc(instance?.owner || "-")}</td><td>${retained ? '<span class="pill warn">● 保留中</span>' : ip.status === "ALLOCATED" ? '<span class="pill ok">● 使用中</span>' : status(ip.status)}</td><td>${fmtDate(ip.updated_at)}</td></tr>`; }).join("") : '<tr><td colspan="5" class="empty">当前没有已分配、预留或隔离的 IP</td></tr>'}</tbody></table></div>` : ""}`;
}

async function usersPage() {
  const [users, ldap] = await Promise.all([api("/users"), api("/ldap/status")]);
  const filters = state.listFilters.users;
  const keyword = filters.keyword.toLowerCase();
  const filtered = users.items.filter(
    (user) =>
      (!keyword ||
        [user.username, user.display_name, user.email].some((value) =>
          String(value || "")
            .toLowerCase()
            .includes(keyword),
        )) &&
      (!filters.role || user.role === filters.role) &&
      (!filters.source || user.source === filters.source),
  );
  const result = paginate(filtered, filters);
  const ldapActions = `<button class="btn" data-go-ldap>≡ LDAP 配置</button>${ldap.enabled ? '<button class="btn" data-sync-ldap="users">○ 同步 LDAP</button>' : ""}`;
  return `${lead("用户管理", "本地账号由平台维护；LDAP 账号同步后使用目录密码登录", `<div class="row-actions">${ldapActions}<button class="btn" data-export="users">导出 CSV</button><button class="btn primary" data-new-user>＋ 创建本地用户</button></div>`)}<div class="resource-table-wrap user-table"><div class="list-toolbar table-toolbar"><input data-list-filter="users" name="keyword" value="${esc(filters.keyword)}" placeholder="⌕  搜索用户名 / 显示名 / 邮箱"><div class="table-filter-group"><select data-list-filter="users" name="source"><option value="">全部来源</option><option value="LOCAL" ${filters.source === "LOCAL" ? "selected" : ""}>平台创建</option><option value="LDAP" ${filters.source === "LDAP" ? "selected" : ""}>LDAP</option></select><select data-list-filter="users" name="role"><option value="">全部角色</option><option value="ADMIN" ${filters.role === "ADMIN" ? "selected" : ""}>管理员</option><option value="USER" ${filters.role === "USER" ? "selected" : ""}>普通用户</option></select><span>共 <b>${filtered.length}</b> 个用户</span></div></div><table><thead><tr><th>用户</th><th>来源</th><th>角色</th><th>状态</th><th>最近登录</th><th>操作</th></tr></thead><tbody>${result.items.length ? result.items.map((user) => `<tr><td><b>${esc(user.display_name || user.username)}</b><span class="source-sub">${esc(user.username)}${user.email ? ` · ${esc(user.email)}` : ""}</span></td><td>${user.source === "LDAP" ? "LDAP" : "平台创建"}</td><td>${user.role === "ADMIN" ? "管理员" : "普通用户"}</td><td>${!user.enabled ? '<span class="pill">● 已停用</span>' : user.must_change_password ? '<span class="pill warn">● 首次需改密</span>' : '<span class="pill ok">● 正常</span>'}</td><td>${fmtDate(user.last_login_at)}</td><td><div class="row-actions"><button class="btn mini" data-edit-user='${esc(JSON.stringify(user))}'>编辑</button>${user.source === "LOCAL" ? `<button class="btn mini" data-reset-user='${esc(JSON.stringify(user))}'>重置密码</button>` : ""}<button class="btn mini danger" data-delete-user="${user.id}" data-name="${esc(user.username)}">删除</button></div></td></tr>`).join("") : '<tr><td colspan="6" class="empty">没有符合条件的用户</td></tr>'}</tbody></table>${pagination("users", result)}</div>`;
}

function ldapFields(config) {
  return `<div class="ldap-section"><div class="ldap-section-head"><span>01</span><div><h3>连接信息</h3><p>配置目录服务地址和查询账号</p></div></div><div class="form-grid">${field("url", "LDAP 地址", config.url || "", { full: true, placeholder: "ldaps://ldap.example.com:636" })}${field("base_dn", "Base DN", config.base_dn || "", { full: true, placeholder: "dc=example,dc=com" })}${field("bind_dn", "服务账号 DN", config.bind_dn || "", { full: true, required: false, placeholder: "cn=vmp-reader,ou=service,dc=example,dc=com" })}${field("bind_password", "服务账号密码", "", { type: "password", full: true, required: false, autocomplete: "new-password", placeholder: config.has_bind_password ? "已加密保存，留空不修改" : "匿名查询可留空" })}<label class="ldap-check"><input name="start_tls" type="checkbox" ${config.start_tls ? "checked" : ""}><span><b>启用 StartTLS</b><small>仅用于 ldap:// 连接</small></span></label><label class="ldap-check"><input name="clear_bind_password" type="checkbox"><span><b>清除绑定密码</b><small>下次保存时清除已有密文</small></span></label></div></div><div class="ldap-section"><div class="ldap-section-head"><span>02</span><div><h3>用户查询规则</h3><p>定义登录查找和批量同步范围</p></div></div><div class="form-grid">${field("login_filter", "登录过滤器", config.login_filter || "(uid=%s)", { full: true, hint: "必须包含 %s 用户名占位符" })}${field("sync_filter", "同步过滤器", config.sync_filter || "(objectClass=person)", { full: true })}</div></div><div class="ldap-section"><div class="ldap-section-head"><span>03</span><div><h3>属性映射</h3><p>将 LDAP 属性映射到平台用户字段</p></div></div><div class="form-grid ldap-attributes">${field("username_attribute", "用户名属性", config.username_attribute || "uid")}${field("display_name_attribute", "显示名称属性", config.display_name_attribute || "cn")}${field("email_attribute", "邮箱属性", config.email_attribute || "mail")}</div></div>`;
}

async function ldapPage() {
  const [config, users] = await Promise.all([
    api("/ldap/status"),
    api("/users"),
  ]);
  const stateText = config.enabled
    ? "LDAP 登录与同步已启用"
    : config.configured
      ? "配置已保存，当前未启用"
      : "尚未配置 LDAP 目录";
  const syncedUsers = users.items.filter((user) => user.source === "LDAP").length;
  return `${lead("LDAP 配置", "连接企业目录服务，同步用户并支持目录密码登录", `<div class="row-actions"><span class="pill ${config.enabled ? "ok" : ""}">● ${config.enabled ? "已启用" : "未启用"}</span><button class="btn" data-test-ldap ${config.enabled ? "" : "disabled"}>○ 测试连接</button></div>`)}<form class="ldap-config-page" id="ldap-config-form"><div class="ldap-config-main">${ldapFields(config)}<div class="ldap-form-actions"><button class="btn" type="button" data-go="ldap">取消</button><button class="btn primary" type="submit">保存配置</button></div></div><div class="ldap-config-side"><div class="ldap-side-card"><h3>连接状态</h3><span class="source-sub">通过“测试连接”验证当前配置</span><dl><div><dt>功能状态</dt><dd><span class="pill ${config.enabled ? "ok" : ""}">● ${config.enabled ? "已启用" : "未启用"}</span></dd></div><div><dt>配置状态</dt><dd>${config.configured ? "已保存" : "未配置"}</dd></div><div><dt>同步用户数</dt><dd><b>${syncedUsers}</b></dd></div></dl>${config.enabled ? '<button class="btn ldap-side-action" type="button" data-sync-ldap>○ 立即同步 LDAP</button>' : '<button class="btn ldap-side-action" type="button" disabled>○ 立即同步 LDAP</button>'}</div><div class="ldap-side-card ldap-enable-card"><span class="side-label">功能开关</span><label class="ldap-toggle"><input name="enabled" type="checkbox" ${config.requested_enabled ? "checked" : ""}><span></span><b>启用 LDAP 登录</b></label><p>启用后，已同步用户可从 LDAP 入口登录。</p><div class="ldap-security"><b>密码安全</b><p>服务账号密码使用 AES-GCM 加密，页面不会回显明文。</p><span>${config.has_bind_password ? "● 已保存绑定密码" : "○ 未保存绑定密码"}</span></div></div><div class="ldap-side-card ldap-tips"><h3>配置提示</h3><ul><li>建议使用只读服务账号，权限最小化</li><li>密码加密存储，接口不会回显明文</li><li>同步为异步任务，大量用户需数分钟</li><li>目录用户使用 LDAP 密码登录平台</li></ul></div></div></form>`;
}

function openLocalUserModal() {
  showFormModal({
    title: "创建本地用户",
    description: "初始密码只在本次创建时填写，用户首次登录后必须修改。",
    content: `<div class="modal-grid">${field("username", "用户名", "", { placeholder: "例如 zhangsan" })}${field("display_name", "显示名称", "", { placeholder: "例如 张三" })}${field("email", "邮箱", "", { type: "email", required: false, placeholder: "zhangsan@example.com" })}<div class="field"><label>角色</label><select name="role"><option value="USER">普通用户</option><option value="ADMIN">管理员</option></select></div>${field("password", "初始密码", "", { type: "password", full: true, hint: "至少 10 位，包含大写字母、小写字母和数字" })}</div>`,
    submitText: "创建用户",
    onSubmit: async (data) => {
      await api("/users", {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(data)),
      });
      toast("本地用户已创建");
      await render("users");
    },
  });
}

function openEditUserModal(user) {
  showFormModal({
    title: `编辑用户 ${user.username}`,
    description: "停用账号会立即清除该用户的所有登录会话。",
    content: `<div class="modal-grid">${field("display_name", "显示名称", user.display_name || "")}${field("email", "邮箱", user.email || "", { type: "email", required: false })}<div class="field"><label>角色</label><select name="role"><option value="USER" ${user.role === "USER" ? "selected" : ""}>普通用户</option><option value="ADMIN" ${user.role === "ADMIN" ? "selected" : ""}>管理员</option></select></div><div class="field"><label><input name="enabled" type="checkbox" ${user.enabled ? "checked" : ""}> 允许登录</label></div></div>`,
    submitText: "保存用户",
    onSubmit: async (data, form) => {
      await api(`/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          display_name: data.get("display_name").trim(),
          email: data.get("email").trim(),
          role: data.get("role"),
          enabled: form.elements.enabled.checked,
        }),
      });
      toast("用户信息已更新");
      await render("users");
    },
  });
}

function openResetPasswordModal(user) {
  showFormModal({
    title: `重置 ${user.username} 的密码`,
    description: "重置后会清除该用户现有会话，并要求其首次登录修改密码。",
    compact: true,
    content: `<div class="modal-grid">${field("password", "新初始密码", "", { type: "password", full: true, hint: "至少 10 位，包含大写字母、小写字母和数字" })}</div>`,
    submitText: "确认重置",
    onSubmit: async (data) => {
      await api(`/users/${user.id}/password`, {
        method: "POST",
        body: JSON.stringify({ password: data.get("password") }),
      });
      toast("密码已重置");
      await render("users");
    },
  });
}

const pages = {
  dashboard,
  apply: applyPage,
  "my-instances": myInstances,
  requests: requestsPage,
  approvals: approvalsPage,
  "all-instances": allInstances,
  "instance-detail": instanceDetailPage,
  hosts,
  images,
  flavors,
  network,
  users: usersPage,
  ldap: ldapPage,
  audit: auditPage,
};
async function render(page = state.page) {
  if (!pages[page]) page = "dashboard";
  if (
    state.currentUser?.role !== "ADMIN" &&
    !["apply", "my-instances", "instance-detail", "requests"].includes(page)
  )
    page = "apply";
  state.page = page;
  const route =
    page === "instance-detail" && state.detailInstanceID
      ? `#/${page}/${state.detailInstanceID}`
      : `#/${page}`;
  if (window.location.hash !== route)
    window.history.replaceState(null, "", route);
  $("#page-title").textContent = labels[page];
  document
    .querySelectorAll("nav button")
    .forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  $("#content").innerHTML = '<div class="panel empty">正在加载…</div>';
  try {
    $("#content").innerHTML = await pages[page]();
    $("#api-state").textContent = "服务正常";
    $("#api-state").className = "pill ok";
    bind();
    if (state.currentUser?.role === "ADMIN" && ["dashboard", "approvals"].includes(page)) updateApprovalIndicator(false);
  } catch (e) {
    if (e.status === 401) {
      showLogin();
      return;
    }
    $("#content").innerHTML =
      `<div class="panel empty"><b>加载失败</b><br>${e.message}</div>`;
    $("#api-state").textContent = "服务异常";
    $("#api-state").className = "pill bad";
  }
}
function openFlavorModal(existing = null) {
  showFormModal({
    title: existing ? "编辑资源规格" : "新增资源规格",
    description: "一次配置 CPU、内存和系统盘，申请页会直接使用该套餐。",
    content: `<div class="modal-grid">${field("id", "规格 ID", existing?.id || "", { placeholder: "例如 c8m16", readonly: Boolean(existing), hint: "创建后不可修改" })}${field("name", "规格名称", existing?.name || "", { placeholder: "例如 高性能型 8C16G" })}${field("cpu", "vCPU（核）", existing?.cpu || 2, { type: "number", min: 1, max: 64 })}${field("memory_mb", "内存（MB）", existing?.memory_mb || 4096, { type: "number", min: 512, max: 262144, step: 256, hint: "必须是 256 MB 的整数倍" })}${field("disk_gb", "系统盘（GB）", existing?.disk_gb || 60, { type: "number", min: 10, max: 4096 })}<div class="field"><label>可用状态</label><label><input name="enabled" type="checkbox" ${existing?.enabled === false ? "" : "checked"}> 允许用户申请</label></div></div>`,
    submitText: existing ? "保存规格" : "创建规格",
    onSubmit: async (formData, form) => {
      const data = {
        id: formData.get("id").trim(),
        name: formData.get("name").trim(),
        cpu: Number(formData.get("cpu")),
        memory_mb: Number(formData.get("memory_mb")),
        disk_gb: Number(formData.get("disk_gb")),
        enabled: form.elements.enabled.checked,
      };
      await api(existing ? `/flavors/${existing.id}` : "/flavors", {
        method: existing ? "PATCH" : "POST",
        body: JSON.stringify(data),
      });
      toast(existing ? "规格已更新" : "规格已创建");
      await render("flavors");
    },
  });
}

function openImageModal(existing = null) {
  const sourceType = existing?.source_type || "local";
  const form = showFormModal({
    title: existing ? "编辑镜像" : "新增镜像",
    description:
      "本地镜像填写 Agent 可访问的镜像路径；远程镜像填写 HTTP(S) / OSS 地址和 SHA-256。",
    content: `<div class="modal-grid">${field("id", "镜像 ID", existing?.id || "", { placeholder: "例如 ubuntu-2404", readonly: Boolean(existing), hint: "创建后不可修改" })}${field("name", "镜像名称", existing?.name || "", { placeholder: "例如 Ubuntu Server 24.04 LTS" })}${field("os_family", "操作系统", existing?.os_family || "ubuntu", { placeholder: "ubuntu / rocky / debian" })}${field("version", "系统版本", existing?.version || "", { placeholder: "例如 24.04" })}<div class="field full"><label>镜像来源</label><div class="source-switch"><label><input type="radio" name="source_type" value="local" ${sourceType === "local" ? "checked" : ""}> <b>本地镜像</b><span class="source-sub">已存放在宿主机镜像目录</span></label><label><input type="radio" name="source_type" value="remote" ${sourceType === "remote" ? "checked" : ""}> <b>远程镜像</b><span class="source-sub">HTTP(S) / OSS 对象地址</span></label></div></div><div class="field full" data-local-fields>${field("local_path", "本地镜像路径", sourceType === "local" ? existing?.source_location || "" : "", { full: true, placeholder: "/data/cloud-init/images/ubuntu.qcow2", hint: "绝对路径或 KVM_IMAGE_ROOT 下的相对路径" })}</div><div class="field full" data-remote-fields>${field("remote_url", "远程镜像地址", sourceType === "remote" ? existing?.source_location || "" : "", { full: true, placeholder: "https://oss.example.com/images/ubuntu.qcow2" })}<div class="modal-grid">${field("checksum", "SHA-256", existing?.checksum || "", { placeholder: "64 位十六进制校验值" })}${field("file_name", "本地缓存文件名", existing?.file_name || "", { placeholder: "ubuntu-24.04.qcow2" })}</div></div><div class="field full"><label><input name="enabled" type="checkbox" ${existing?.enabled ? "checked" : ""}> 镜像就绪后允许用户申请</label><span class="input-hint">远程镜像只有同步状态为 READY 时才能启用。</span></div></div>`,
    submitText: existing ? "保存镜像" : "创建镜像",
    onSubmit: async (formData, currentForm) => {
      const type = formData.get("source_type");
      const location = formData
        .get(type === "local" ? "local_path" : "remote_url")
        .trim();
      const data = {
        id: formData.get("id").trim(),
        name: formData.get("name").trim(),
        source_type: type,
        source_location: location,
        checksum: type === "remote" ? formData.get("checksum").trim() : "",
        file_name:
          type === "remote"
            ? formData.get("file_name").trim()
            : location.split("/").filter(Boolean).pop(),
        os_family: formData.get("os_family").trim(),
        version: formData.get("version").trim(),
        enabled: currentForm.elements.enabled.checked,
      };
      await api(existing ? `/images/${existing.id}` : "/images", {
        method: existing ? "PATCH" : "POST",
        body: JSON.stringify(data),
      });
      toast(existing ? "镜像已更新" : "镜像已创建");
      await render("images");
    },
  });
  const syncSourceFields = () => {
    const type = form.elements.source_type.value;
    const local = form.querySelector("[data-local-fields]");
    const remote = form.querySelector("[data-remote-fields]");
    local.hidden = type !== "local";
    remote.hidden = type !== "remote";
    local.querySelector("input").required = type === "local";
    remote
      .querySelectorAll("input")
      .forEach((input) => (input.required = type === "remote"));
  };
  form.querySelectorAll('[name="source_type"]').forEach((input) => {
    input.onchange = syncSourceFields;
  });
  syncSourceFields();
}

function openNetworkModal(existing = null) {
  showFormModal({
    title: existing ? "编辑网络" : "新增网络",
    description:
      "网络和唯一有效的 IP 范围一起保存。修改范围时，旧范围中的空闲地址会被替换；存在占用地址时后台会拒绝缩小范围。",
    content: `<div class="modal-grid">${field("name", "网络名称", existing?.name || "", { placeholder: "例如 研发临时网络" })}${field("bridge", "宿主机 Bridge", existing?.bridge || "br0", { placeholder: "br0" })}${field("cidr", "网段 CIDR", existing?.cidr || "", { placeholder: "192.168.50.0/24" })}${field("gateway", "默认网关", existing?.gateway || "", { placeholder: "192.168.50.1" })}${field("ip_range_start", "可分配起始 IP", existing?.ip_range_start || "", { placeholder: "192.168.50.100" })}${field("ip_range_end", "可分配结束 IP", existing?.ip_range_end || "", { placeholder: "192.168.50.150" })}${field("dns_servers", "DNS 服务器", (existing?.dns_servers || []).join(", "), { full: true, placeholder: "223.5.5.5, 1.1.1.1", hint: "多个地址使用英文逗号分隔" })}<div class="notice full">保存后地址池只保留上述范围；网关地址会自动排除。虚拟机分配前 Agent 仍会执行占用探测。</div><div class="field full"><label><input name="enabled" type="checkbox" ${existing?.enabled === false ? "" : "checked"}> 允许该网络参与虚拟机分配</label></div></div>`,
    submitText: existing ? "保存网络" : "创建网络",
    onSubmit: async (formData, form) => {
      const data = {
        name: formData.get("name").trim(),
        cidr: formData.get("cidr").trim(),
        gateway: formData.get("gateway").trim(),
        ip_range_start: formData.get("ip_range_start").trim(),
        ip_range_end: formData.get("ip_range_end").trim(),
        dns_servers: formData
          .get("dns_servers")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        bridge: formData.get("bridge").trim(),
        enabled: form.elements.enabled.checked,
      };
      const result = await api(
        existing ? `/networks/${existing.id}` : "/networks",
        {
          method: existing ? "PATCH" : "POST",
          body: JSON.stringify(data),
        },
      );
      if (!existing) state.selectedNetworkID = result.id;
      toast(existing ? "网络和 IP 范围已更新" : "网络和 IP 范围已创建");
      await render("network");
    },
  });
}

function openHostQuotaModal(host) {
  showFormModal({
    title: `调整 ${host.name} 的调度额度`,
    description:
      "三项配额同时保存，不能低于已预占资源，也不能超过 Agent 上报的安全上限。",
    content: `<div class="quota-overview"><div><span>CPU：已用 / Agent 上限</span><b>${host.reserved_cpu} / ${host.agent_allocatable_cpu} C</b></div><div><span>内存：已用 / Agent 上限</span><b>${gb(host.reserved_memory_mb)} / ${gb(host.agent_allocatable_memory_mb)}</b></div><div><span>磁盘：已用 / Agent 上限</span><b>${host.reserved_disk_gb} / ${host.agent_allocatable_disk_gb} GB</b></div></div><div class="modal-grid">${field("cpu", "CPU 调度额度（核）", host.allocatable_cpu, { type: "number", min: host.reserved_cpu, max: host.agent_allocatable_cpu })}${field("memory_mb", "内存调度额度（MB）", host.allocatable_memory_mb, { type: "number", min: host.reserved_memory_mb, max: host.agent_allocatable_memory_mb, step: 256 })}${field("disk_gb", "磁盘调度额度（GB）", host.allocatable_disk_gb, { type: "number", min: host.reserved_disk_gb, max: host.agent_allocatable_disk_gb })}<div class="notice">实际可调度值始终取“管理员额度”和“Agent 上限”的较小值。</div></div>`,
    submitText: "保存三项配额",
    onSubmit: async (formData) => {
      await api(`/hosts/${host.id}/quota`, {
        method: "PATCH",
        body: JSON.stringify({
          cpu: Number(formData.get("cpu")),
          memory_mb: Number(formData.get("memory_mb")),
          disk_gb: Number(formData.get("disk_gb")),
        }),
      });
      toast("宿主机 CPU、内存和磁盘额度已同时更新");
      await render("hosts");
    },
  });
}

function bindManagement() {
  const goLDAP = $("[data-go-ldap]");
  if (goLDAP) goLDAP.onclick = () => render("ldap");
  const ldapForm = $("#ldap-config-form");
  if (ldapForm)
    ldapForm.onsubmit = async (event) => {
      event.preventDefault();
      const submit = ldapForm.querySelector('[type="submit"]');
      submit.disabled = true;
      submit.textContent = "保存中…";
      try {
        const data = new FormData(ldapForm);
        await api("/ldap/config", {
          method: "PUT",
          body: JSON.stringify({
            ...Object.fromEntries(data),
            enabled: ldapForm.elements.enabled.checked,
            start_tls: ldapForm.elements.start_tls.checked,
            clear_bind_password: ldapForm.elements.clear_bind_password.checked,
          }),
        });
        toast("LDAP 配置已保存");
        await render(syncLDAP.dataset.syncLdap === "users" ? "users" : "ldap");
      } catch (error) {
        toast(error.message, "error");
        submit.disabled = false;
        submit.textContent = "保存 LDAP 配置";
      }
    };
  const newUser = $("[data-new-user]");
  if (newUser) newUser.onclick = openLocalUserModal;
  const syncLDAP = $("[data-sync-ldap]");
  if (syncLDAP)
    syncLDAP.onclick = async () => {
      try {
        const result = await api("/ldap/sync", { method: "POST" });
        toast(`LDAP 同步完成：${result.synced} 个用户`);
        await render("ldap");
      } catch (error) {
        toast(error.message, "error");
      }
    };
  const testLDAP = $("[data-test-ldap]");
  if (testLDAP)
    testLDAP.onclick = async () => {
      testLDAP.disabled = true;
      testLDAP.textContent = "测试中…";
      try {
        const result = await api("/ldap/test", { method: "POST" });
        toast("LDAP 连接测试成功。", "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        testLDAP.disabled = false;
        testLDAP.textContent = "测试连接";
      }
    };
  document.querySelectorAll("[data-edit-user]").forEach((button) => {
    button.onclick = () =>
      openEditUserModal(JSON.parse(button.dataset.editUser));
  });
  document.querySelectorAll("[data-reset-user]").forEach((button) => {
    button.onclick = () =>
      openResetPasswordModal(JSON.parse(button.dataset.resetUser));
  });
  document.querySelectorAll("[data-delete-user]").forEach((button) => {
    button.onclick = () =>
      showConfirmModal({
        title: `删除用户 ${button.dataset.name}`,
        description:
          "存在虚拟机的用户不能删除，可以先停用账号。删除用户会清除其全部登录会话。",
        confirmText: "删除用户",
        danger: true,
        onConfirm: async () => {
          await api(`/users/${button.dataset.deleteUser}`, {
            method: "DELETE",
          });
          toast("用户已删除");
          await render("users");
        },
      });
  });
  const newFlavor = $("[data-new-flavor]");
  if (newFlavor) newFlavor.onclick = () => openFlavorModal();
  document.querySelectorAll("[data-edit-flavor]").forEach((button) => {
    button.onclick = () =>
      openFlavorModal(JSON.parse(button.dataset.editFlavor));
  });
  const newImage = $("[data-new-image]");
  if (newImage) newImage.onclick = () => openImageModal();
  document.querySelectorAll("[data-edit-image]").forEach((button) => {
    button.onclick = () => openImageModal(JSON.parse(button.dataset.editImage));
  });
  const newNetwork = $("[data-new-network]");
  if (newNetwork) newNetwork.onclick = () => openNetworkModal();
  document.querySelectorAll("[data-edit-network]").forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      openNetworkModal(JSON.parse(button.dataset.editNetwork));
    };
  });
  document.querySelectorAll("[data-delete-host]").forEach((button) => {
    button.onclick = () =>
      showConfirmModal({
        title: `删除宿主机纳管记录 ${button.dataset.name}`,
        description:
          "必须先停止该宿主机 Agent 并等待状态变为离线。此操作只删除平台纳管记录，不会删除宿主机上的任何外部虚拟机。存在平台活动实例或执行中任务时会拒绝删除。",
        confirmText: "删除纳管记录",
        danger: true,
        onConfirm: async () => {
          await api(`/hosts/${button.dataset.deleteHost}`, {
            method: "DELETE",
          });
          toast("宿主机纳管记录已删除");
          await render("hosts");
        },
      });
  });
  document.querySelectorAll("[data-delete-image]").forEach((button) => {
    button.onclick = () =>
      showConfirmModal({
        title: `删除镜像 ${button.dataset.name}`,
        description:
          "只删除平台中的镜像元数据，不会删除宿主机本地文件或远程对象。已被申请单引用的镜像只能停用，不能删除。",
        confirmText: "删除镜像记录",
        danger: true,
        onConfirm: async () => {
          await api(`/images/${button.dataset.deleteImage}`, {
            method: "DELETE",
          });
          toast("镜像记录已删除");
          await render("images");
        },
      });
  });
  document.querySelectorAll("[data-delete-flavor]").forEach((button) => {
    button.onclick = () =>
      showConfirmModal({
        title: `删除资源规格 ${button.dataset.name}`,
        description:
          "已被申请单引用的资源规格只能停用，不能删除，以保证历史记录完整。",
        confirmText: "删除资源规格",
        danger: true,
        onConfirm: async () => {
          await api(`/flavors/${button.dataset.deleteFlavor}`, {
            method: "DELETE",
          });
          toast("资源规格已删除");
          await render("flavors");
        },
      });
  });
  document.querySelectorAll("[data-delete-network]").forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      showConfirmModal({
        title: `删除网络 ${button.dataset.name}`,
        description:
          "只有地址池内全部 IP 均为空闲时才能删除。删除网络会同时移除其空闲 IP，已分配、预留或隔离地址会阻止操作。",
        confirmText: "删除网络",
        danger: true,
        onConfirm: async () => {
          await api(`/networks/${button.dataset.deleteNetwork}`, {
            method: "DELETE",
          });
          state.selectedNetworkID = null;
          toast("网络及空闲地址池已删除");
          await render("network");
        },
      });
    };
  });
  document.querySelectorAll("[data-host-quota]").forEach((button) => {
    button.onclick = () =>
      openHostQuotaModal(JSON.parse(button.dataset.hostQuota));
  });
  document.querySelectorAll("[data-select-network]").forEach((card) => {
    card.onclick = () => {
      state.selectedNetworkID = card.dataset.selectNetwork;
      render("network");
    };
  });
}

function openRenewModal(instanceID, instanceName) {
  showFormModal({
    title: `续期 ${instanceName}`,
    description:
      "续期时长会在当前到期时间基础上累加；7 天以内自动执行，超过 7 天需要管理员审批。",
    compact: true,
    content: `<div class="modal-grid">${field("hours", "续期时长（小时）", 24, { type: "number", min: 1, max: 720, full: true, hint: "1-168 小时自动续期；169-720 小时进入审批" })}<div class="field full"><label>续期原因</label><textarea name="reason" required maxlength="300" placeholder="说明继续使用的项目和预计完成时间"></textarea></div></div>`,
    submitText: "确认续期",
    onSubmit: async (formData) => {
      const result = await api(`/instances/${instanceID}/renew`, {
        method: "POST",
        body: JSON.stringify({ hours: Number(formData.get("hours")), reason: formData.get("reason").trim() }),
      });
      toast(result.approval_required ? `续期已提交审批：${result.request_no}` : `实例 ${instanceName} 已续期`);
      await render(
        result.approval_required ? "requests" : state.page === "instance-detail" ? "instance-detail" : "my-instances",
      );
    },
  });
}

function openRestoreModal(instanceID, instanceName) {
  showFormModal({
    title: `恢复 ${instanceName}`,
    description: "恢复会启动保留的原虚拟机，磁盘和原 IP 保持不变。7 天以内自动执行，超过 7 天需要管理员审批。",
    compact: true,
    content: `<div class="modal-grid">${field("hours", "恢复后的租期（小时）", 24, { type: "number", min: 1, max: 720, full: true, hint: "1-168 小时自动恢复；169-720 小时进入审批" })}<div class="field full"><label>恢复原因</label><textarea name="reason" required maxlength="300" placeholder="说明恢复数据和继续使用的原因"></textarea></div></div>`,
    submitText: "确认恢复",
    onSubmit: async (formData) => {
      const result = await api(`/instances/${instanceID}/restore`, {
        method: "POST",
        body: JSON.stringify({ hours: Number(formData.get("hours")), reason: formData.get("reason").trim() }),
      });
      toast(result.approval_required ? `恢复申请已提交审批：${result.request_no}` : `实例 ${instanceName} 正在恢复`);
      await render(result.approval_required ? "requests" : "my-instances");
    },
  });
}

function openApprovalDecisionModal(button) {
  const approve = button.dataset.approvalDecision === "APPROVE";
  showFormModal({
    title: `${approve ? "批准" : "拒绝"} ${button.dataset.approvalNo}`,
    description: approve
      ? "批准后平台将立即调度资源并执行。创建申请的初始密码可由申请人在实例详情中重置获取。"
      : "拒绝后不会分配或变更任何资源，请填写明确原因。",
    compact: true,
    content: `<div class="modal-grid">${approve ? field("adjusted_hours", "批准租期（小时）", button.dataset.approvalHours || 168, { type: "number", min: 1, max: 720, full: true, hint: "可按实际情况调整后批准" }) : ""}<div class="field full"><label>审批意见${approve ? "（选填）" : ""}</label><textarea name="comment" ${approve ? "" : "required"} placeholder="${approve ? "例如：项目周期确认，批准使用" : "请输入拒绝原因"}"></textarea></div></div>`,
    submitText: approve ? "确认批准" : "确认拒绝",
    onSubmit: async (formData) => {
      await api(`/approvals/${button.dataset.approvalId}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: button.dataset.approvalDecision, comment: formData.get("comment").trim(), adjusted_hours: approve ? Number(formData.get("adjusted_hours")) : 0 }),
      });
      toast(approve ? "审批已通过，平台开始执行" : "审批已拒绝");
      await render("approvals");
    },
  });
  if (!approve) $("#modal-form [type=submit]").classList.add("danger");
}

function openShortResubmitModal(button) {
  showFormModal({
    title: `改为短租期重提 ${button.dataset.approvalNo}`,
    description: "租期不超过 7 天会立即执行，无需再次等待审批；原审批记录继续保留用于追溯。",
    compact: true,
    content: `<div class="modal-grid">${field("hours", "短租期（小时）", 168, { type: "number", min: 1, max: 168, full: true })}<div class="field full"><label>重提原因</label><textarea name="reason" required maxlength="300" placeholder="说明调整租期后的使用计划"></textarea></div></div>`,
    submitText: "确认重提并执行",
    onSubmit: async (data) => {
      const result = await api(`/approvals/${button.dataset.resubmitShort}/resubmit-short`, {
        method: "POST",
        body: JSON.stringify({ hours: Number(data.get("hours")), reason: data.get("reason").trim() }),
      });
      state.lastCredentials = result.connection || null;
      if (result.connection) {
        $("#content").innerHTML = credentialResult(result);
        bind();
      } else {
        await render("my-instances");
      }
      toast("短租期申请已执行");
    },
  });
}

function openBatchApprovalModal(decision, ids) {
  const approve = decision === "APPROVE";
  showFormModal({
    title: `${approve ? "批量批准" : "批量拒绝"} ${ids.length} 个申请`,
    description: "系统逐条校验当前状态，已被其他管理员处理的申请不会重复执行。",
    compact: true,
    content: `<div class="field full"><label>统一审批意见${approve ? "（选填）" : ""}</label><textarea name="comment" ${approve ? "" : "required"} placeholder="${approve ? "填写批准说明" : "拒绝时必须填写原因"}"></textarea></div>`,
    submitText: approve ? "确认批量批准" : "确认批量拒绝",
    onSubmit: async (data) => {
      const result = await api("/approvals/batch-decision", {
        method: "POST",
        body: JSON.stringify({ ids, decision, comment: data.get("comment").trim() }),
      });
      const failed = result.items.filter((item) => !item.success);
      toast(
        failed.length ? `已处理 ${ids.length - failed.length} 条，${failed.length} 条失败` : `已处理 ${ids.length} 条审批`,
        failed.length ? "warning" : "success",
      );
      await render("approvals");
    },
  });
  if (!approve) $("#modal-form [type=submit]").classList.add("danger");
}

function openInstanceCredentialModal(connection) {
  const form = showFormModal({
    title: "新登录凭据",
    description: "密码重置任务已提交。任务成功后新密码生效，明文只在本次显示。",
    compact: true,
    content: `<div class="credential-warning">请等待实例详情中的“重置实例密码”任务成功后再使用新密码。</div><div class="credential-grid"><div class="full credential-secret"><span>一次性密码</span><code>${esc(connection.password)}</code><button class="btn mini" type="button" data-copy-reset-password>复制密码</button></div><div class="full"><span>SSH 命令</span><code>ssh ${esc(connection.username)}@${esc(connection.ip_address)}</code><button class="btn mini" type="button" data-copy-reset-ssh>复制命令</button></div></div><label class="credential-confirm"><input type="checkbox" data-reset-saved> <span>我已经复制并妥善保存新密码</span></label>`,
    submitText: "我已保存并关闭",
    onSubmit: async () => {},
  });
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  form.querySelector("[data-reset-saved]").onchange = (event) => {
    submit.disabled = !event.target.checked;
  };
  form.querySelector("[data-copy-reset-password]").onclick = async () => {
    await copyText(connection.password);
    toast("新密码已复制");
  };
  form.querySelector("[data-copy-reset-ssh]").onclick = async () => {
    await copyText(`ssh ${connection.username}@${connection.ip_address}`);
    toast("SSH 命令已复制");
  };
}

function bindListControls() {
  document.querySelectorAll("[data-list-filter]").forEach((control) => {
    const update = () => {
      const kind = control.dataset.listFilter;
      state.listFilters[kind][control.name] = control.value.trim();
      state.listFilters[kind].page = 1;
      clearTimeout(state.filterTimer);
      state.filterTimer = setTimeout(
        () => render(kind === "users" ? "users" : kind === "audit" ? "audit" : "all-instances"),
        control.tagName === "INPUT" ? 300 : 0,
      );
    };
    control.oninput = control.tagName === "INPUT" ? update : null;
    control.onchange = update;
  });
  document.querySelectorAll("[data-list-page]").forEach((button) => {
    button.onclick = () => {
      const kind = button.dataset.listPage;
      state.listFilters[kind].page = Number(button.dataset.page);
      render(kind === "users" ? "users" : kind === "audit" ? "audit" : "all-instances");
    };
  });
  document.querySelectorAll("[data-copy-value]").forEach((button) => {
    button.onclick = async () => {
      await copyText(button.dataset.copyValue);
      toast("SSH 命令已复制");
    };
  });
  document.querySelectorAll("[data-export]").forEach((button) => {
    button.onclick = async () => {
      if (button.dataset.export === "users") {
        const result = await api("/users");
        downloadCSV(`用户列表-${new Date().toISOString().slice(0, 10)}.csv`, [
          ["用户名", "显示名称", "邮箱", "来源", "角色", "状态", "最近登录"],
          ...result.items.map((user) => [
            user.username,
            user.display_name,
            user.email,
            user.source,
            user.role,
            user.enabled ? "正常" : "停用",
            fmtDate(user.last_login_at),
          ]),
        ]);
      } else {
        const result = await api("/instances");
        downloadCSV(`实例列表-${new Date().toISOString().slice(0, 10)}.csv`, [
          [
            "实例",
            "使用人",
            "IP",
            "宿主机",
            "规格",
            "镜像",
            "状态",
            "到期时间",
          ],
          ...filterInstanceItems(result.items).map((item) => [
            item.name,
            item.owner,
            item.ip_address,
            item.host,
            item.flavor,
            item.image,
            statusLabels[item.lifecycle_status] || item.lifecycle_status,
            fmtDate(item.expires_at),
          ]),
        ]);
      }
      toast("CSV 已导出");
    };
  });
}

function bind() {
  bindManagement();
  bindListControls();
  document.querySelectorAll("[data-approval-decision]").forEach(
    (button) => (button.onclick = () => openApprovalDecisionModal(button)),
  );
  document.querySelectorAll("[data-approval-instance]").forEach(
    (button) => (button.onclick = () => {
      state.detailInstanceID = button.dataset.approvalInstance;
      render("instance-detail");
    }),
  );
  document.querySelectorAll("[data-withdraw-approval]").forEach((button) => {
    button.onclick = () => showConfirmModal({
      title: `撤回 ${button.dataset.approvalNo}`,
      description: "撤回后管理员不能再处理该申请，审批前没有预占任何资源。",
      confirmText: "确认撤回",
      danger: true,
      onConfirm: async () => {
        await api(`/approvals/${button.dataset.withdrawApproval}/withdraw`, { method: "POST", body: "{}" });
        toast("申请已撤回");
        await render("requests");
      },
    });
  });
  document.querySelectorAll("[data-resubmit-short]").forEach(
    (button) => (button.onclick = () => openShortResubmitModal(button)),
  );
  const approvalSelections = [...document.querySelectorAll("[data-approval-select]")];
  const updateBatchCount = () => {
    const target = document.querySelector("[data-batch-count]");
    if (target) target.textContent = `已选择 ${approvalSelections.filter((item) => item.checked).length} 项`;
  };
  const selectAll = document.querySelector("[data-approval-select-all]");
  if (selectAll) selectAll.onchange = () => {
    approvalSelections.filter((item) => !item.disabled).forEach((item) => { item.checked = selectAll.checked; });
    updateBatchCount();
  };
  approvalSelections.forEach((item) => { item.onchange = updateBatchCount; });
  document.querySelectorAll("[data-batch-approval]").forEach((button) => {
    button.onclick = () => {
      const ids = approvalSelections.filter((item) => item.checked).map((item) => item.value);
      if (!ids.length) return toast("请先选择审批单", "warning");
      openBatchApprovalModal(button.dataset.batchApproval, ids);
    };
  });
  document
    .querySelectorAll("[data-go]")
    .forEach((b) => (b.onclick = () => render(b.dataset.go)));
  document.querySelectorAll("[data-instance-action]").forEach(
    (b) =>
      (b.onclick = async () => {
        const action = b.dataset.instanceAction;
        try {
          if (action === "detail") {
            state.detailInstanceID = b.dataset.instanceId;
            return render("instance-detail");
          } else if (action === "console_vnc" || action === "console_serial") {
            const mode = action === "console_vnc" ? "vnc" : "serial";
            const popup = window.open("about:blank", `vmp-console-${b.dataset.instanceId}-${mode}`);
            if (!popup) {
              toast("浏览器已拦截控制台窗口，请允许本站弹窗后重新连接。", "warning", { title: "无法打开控制台" });
              return;
            }
            try {
              const session = await api(`/instances/${b.dataset.instanceId}/console-sessions`, {
                method: "POST",
                body: JSON.stringify({ mode }),
              });
              const fragment = new URLSearchParams({ mode, ws: session.websocket_url, name: b.dataset.instanceName, instance: b.dataset.instanceId });
              popup.location.replace(`/console.html#${fragment.toString()}`);
            } catch (error) {
              popup.close();
              toast(error.message, "error");
            }
            return;
          } else if (action === "renew") {
            openRenewModal(b.dataset.instanceId, b.dataset.instanceName);
            return;
          } else if (action === "restore") {
            openRestoreModal(b.dataset.instanceId, b.dataset.instanceName);
            return;
          } else {
            if (action === "reset_password") {
              showConfirmModal({
                title: `重置 ${b.dataset.instanceName} 的登录密码`,
                description:
                  "平台将通过 QEMU Guest Agent 修改虚拟机系统密码。新密码只展示一次，任务执行期间请勿关机或重启实例。",
                confirmText: "生成并重置密码",
                onConfirm: async () => {
                  const result = await api(
                    `/instances/${b.dataset.instanceId}/actions`,
                    {
                      method: "POST",
                      body: JSON.stringify({ action: "reset_password" }),
                    },
                  );
                  toast("密码重置任务已提交");
                  setTimeout(
                    () => openInstanceCredentialModal(result.connection),
                    0,
                  );
                },
              });
              return;
            }
            if (action === "release") {
              const restored = Number(b.dataset.restoreCount || 0) >= 1;
              showConfirmModal({
                title: `释放 ${b.dataset.instanceName}`,
                description: restored
                  ? "该实例已使用过一次保留期恢复，本次释放将直接删除虚拟机、磁盘并释放原 IP，不再进入第二次保留期。"
                  : "实例将先关机并进入 7 天保留期，期间保留磁盘和原 IP；保留期结束后才删除并释放 IP。",
                confirmText: "确认释放",
                danger: true,
                onConfirm: async () => {
                  await api(`/instances/${b.dataset.instanceId}/actions`, {
                    method: "POST",
                    body: JSON.stringify({ action: "release" }),
                  });
                  toast("释放任务已提交");
                  await render("my-instances");
                },
              });
              return;
            }
            if (action === "force_delete") {
              showConfirmModal({
                title: `立即删除 ${b.dataset.instanceName}`,
                description:
                  "此操作不保留 7 天，将立即删除虚拟机及磁盘。宿主机删除成功后，原 IP 和资源配额会同时释放，操作不可恢复。",
                confirmText: "确认立即删除",
                danger: true,
                onConfirm: async () => {
                  await api(`/instances/${b.dataset.instanceId}/actions`, {
                    method: "POST",
                    body: JSON.stringify({ action: "force_delete" }),
                  });
                  toast("立即删除任务已提交");
                  await render("my-instances");
                },
              });
              return;
            }
            await api("/instances/" + b.dataset.instanceId + "/actions", {
              method: "POST",
              body: JSON.stringify({ action }),
            });
            toast("实例操作已提交");
          }
          render("my-instances");
        } catch (err) {
          toast(err.message, "error");
        }
      }),
  );
  document.querySelectorAll("[data-host]").forEach(
    (b) =>
      (b.onclick = async () => {
        await api("/hosts/" + b.dataset.host + "/status", {
          method: "PATCH",
          body: JSON.stringify({ status: b.dataset.status }),
        });
        toast("宿主机调度状态已更新");
        render("hosts");
      }),
  );
  document.querySelectorAll("[data-toggle-image]").forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          await api("/images/" + b.dataset.toggleImage, {
            method: "PATCH",
            body: JSON.stringify({ enabled: b.dataset.enabled === "true" }),
          });
          toast("镜像状态已更新");
          render("images");
        } catch (e) {
          toast(e.message, "error");
        }
      }),
  );
  document.querySelectorAll("[data-toggle-flavor]").forEach(
    (b) =>
      (b.onclick = async () => {
        await api("/flavors/" + b.dataset.toggleFlavor, {
          method: "PATCH",
          body: JSON.stringify({
            name: b.dataset.name,
            cpu: Number(b.dataset.cpu),
            memory_mb: Number(b.dataset.memory),
            disk_gb: Number(b.dataset.disk),
            enabled: b.dataset.enabled === "true",
          }),
        });
        toast("规格状态已更新");
        render("flavors");
      }),
  );
  const copy = $("[data-copy-credentials]");
  if (copy)
    copy.onclick = async () => {
      const c = state.lastCredentials;
      if (!c) return;
      await copyText(
        `SSH: ssh ${c.username}@${c.ip_address}\nIP: ${c.ip_address}\n用户名: ${c.username}\n密码: ${c.password}`,
      );
      toast("连接信息已复制");
    };
  const copyPassword = $("[data-copy-password]");
  if (copyPassword)
    copyPassword.onclick = async () => {
      await copyText(state.lastCredentials?.password || "");
      toast("一次性密码已复制");
    };
  const copySSH = $("[data-copy-ssh]");
  if (copySSH)
    copySSH.onclick = async () => {
      const c = state.lastCredentials;
      await copyText(`ssh ${c.username}@${c.ip_address}`);
      toast("SSH 命令已复制");
    };
  const credentialsSaved = $("[data-credentials-saved]");
  if (credentialsSaved)
    credentialsSaved.onchange = () => {
      $("[data-credentials-continue]").disabled = !credentialsSaved.checked;
    };
  const f = $("#apply-form");
  if (f) {
    const nameInput = f.querySelector("[data-instance-name]");
    const nameHint = f.querySelector("[data-name-hint]");
    const updateApplySummary = () => {
      const flavor = f.querySelector('[name="flavor_id"]:checked');
      const image = f.elements.image_id?.selectedOptions?.[0];
      const network = f.elements.network_id?.selectedOptions?.[0];
      const hours = Number(f.elements.lease_hours?.value || 0);
      document
        .querySelectorAll(".flavor-option")
        .forEach((option) =>
          option.classList.toggle(
            "selected",
            option.contains(flavor),
          ),
        );
      const leaseLabel = hours < 24 ? `${hours} 小时` : `${hours / 24} 天`;
      const expiry = new Date(Date.now() + hours * 3600000);
      const setText = (selector, value) => {
        const target = document.querySelector(selector);
        if (target) target.textContent = value;
      };
      setText("[data-summary-flavor]", flavor?.dataset.name || "-");
      setText("[data-summary-image]", image?.textContent || "-");
      setText(
        "[data-summary-network]",
        network?.textContent?.split("·")[1]?.trim() || "-",
      );
      setText("[data-summary-lease]", leaseLabel);
      setText("[data-summary-expiry]", fmtDate(expiry.toISOString()));
      setText(
        "[data-summary-resource]",
        flavor
          ? `${gb(flavor.dataset.memory)} 内存 · ${flavor.dataset.disk} GB 磁盘`
          : "-",
      );
    };
    f.querySelectorAll('[name="flavor_id"], [name="image_id"], [name="network_id"], [name="lease_hours"]').forEach(
      (control) => (control.onchange = updateApplySummary),
    );
    updateApplySummary();
    nameInput.oninput = () => {
      const valid = /^[a-zA-Z0-9-]+$/.test(nameInput.value);
      nameInput.setCustomValidity(
        nameInput.value && !valid ? "实例名称只能包含字母、数字和连字符" : "",
      );
      nameHint.textContent =
        valid || !nameInput.value
          ? "仅支持字母、数字和连字符"
          : "名称中包含不支持的字符";
      nameHint.classList.toggle(
        "validation-error",
        Boolean(nameInput.value) && !valid,
      );
    };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(f));
      data.lease_hours = Number(data.lease_hours);
      const btn = f.querySelector("[type=submit]");
      btn.disabled = true;
      btn.textContent = "提交中…";
      try {
        const r = await api("/applications", {
          method: "POST",
          body: JSON.stringify(data),
        });
        if (r.approval_required) {
          state.lastCredentials = null;
          $("#content").innerHTML = approvalSubmittedResult(r);
          toast(`申请 ${r.request_no} 已进入管理员审批`);
          bind();
          return;
        }
        state.lastCredentials = r.connection || null;
        $("#content").innerHTML = credentialResult(r);
        toast(`申请 ${r.request_no} 已提交，正在异步交付`);
        bind();
      } catch (err) {
        showAlert({
          title: "虚拟机申请未提交",
          message: err.message,
          type: "error",
        });
        btn.disabled = false;
        btn.textContent = "提交申请 →";
      }
    };
  }
}
document
  .querySelectorAll("nav button")
  .forEach((b) => (b.onclick = () => render(b.dataset.page)));
function toast(message, type = "success", options = {}) {
  const center = $("#notification-center");
  const titles = {
    success: "操作成功",
    warning: "请注意",
    error: "操作失败",
    info: "系统提示",
  };
  const symbols = { success: "✓", warning: "!", error: "!", info: "i" };
  const notice = document.createElement("div");
  notice.className = `notification ${type}`;
  notice.setAttribute("role", type === "error" ? "alert" : "status");
  notice.innerHTML = `<span class="notification-symbol" aria-hidden="true">${symbols[type] || "i"}</span><div class="notification-copy"><b>${esc(options.title || titles[type] || titles.info)}</b><span>${esc(localizeError(message))}</span></div><button type="button" class="notification-close" aria-label="关闭提示">×</button>`;
  const remove = () => {
    notice.classList.add("leaving");
    setTimeout(() => notice.remove(), 180);
  };
  notice.querySelector(".notification-close").onclick = remove;
  center.appendChild(notice);
  requestAnimationFrame(() => notice.classList.add("show"));
  while (center.children.length > 3) center.firstElementChild.remove();
  setTimeout(remove, options.duration || (type === "error" ? 8000 : 5000));
}
function showLogin(message = "") {
  closeAlert();
  $("#notification-center").replaceChildren();
  state.currentUser = null;
  state.lastCredentials = null;
  state.detailInstanceID = null;
  state.pendingApprovalNotified = false;
  $("#content").replaceChildren();
  $("#page-title").textContent = "";
  document
    .querySelectorAll("nav button")
    .forEach((button) => button.classList.remove("active"));
  $("#app-shell").hidden = true;
  $("#login-screen").hidden = false;
  const error = $("#login-error");
  error.textContent = message ? localizeError(message) : "";
  error.classList.toggle("show", Boolean(message));
  $("#login-form [name=username]").focus();
}

function applyCurrentUser(user) {
  $("#content").replaceChildren();
  state.currentUser = user;
  $("#login-screen").hidden = true;
  $("#app-shell").hidden = false;
  document
    .querySelectorAll("[data-admin]")
    .forEach((element) => (element.hidden = user.role !== "ADMIN"));
  $("#current-user").textContent = user.display_name || user.username;
  $("#current-role").textContent =
    `${user.role === "ADMIN" ? "管理员" : "普通用户"} · ${user.source === "LDAP" ? "LDAP" : "本地"}`;
  $("#password-button").hidden = user.source !== "LOCAL";
  $("#user-avatar").textContent = (user.display_name || user.username)
    .slice(0, 2)
    .toUpperCase();
  if (user.role === "ADMIN") updateApprovalIndicator(true);
}

async function updateApprovalIndicator(showNotice = false) {
  if (state.currentUser?.role !== "ADMIN") return;
  try {
    const result = await api("/approvals?status=PENDING");
    const count = result.items.length;
    const badge = $("#approval-nav-count");
    badge.textContent = String(count);
    badge.hidden = count === 0;
    if (showNotice && count > 0 && !state.pendingApprovalNotified) {
      state.pendingApprovalNotified = true;
      toast(`有 ${count} 条长租期申请等待审批，请及时处理。`, "warning", {
        title: "待审批提醒",
        duration: 8000,
      });
    }
  } catch {}
}

async function logout() {
  try {
    await api("/auth/logout", { method: "POST" });
  } finally {
    closeModal();
    showLogin();
  }
}

function openOwnPasswordModal(force = false) {
  const form = showFormModal({
    title: force ? "首次登录修改密码" : "修改登录密码",
    description: force
      ? "为保证账号安全，请修改管理员设置的初始密码后再继续使用。"
      : "修改后旧密码将立即失效。",
    content: `<div class="modal-grid">${field("current_password", "当前密码", "", { type: "password", full: true, autocomplete: "current-password" })}${field("new_password", "新密码", "", { type: "password", full: true, autocomplete: "new-password", hint: "至少 10 位，包含大写字母、小写字母和数字" })}${field("confirm_password", "确认新密码", "", { type: "password", full: true, autocomplete: "new-password" })}</div>`,
    submitText: "保存新密码",
    onSubmit: async (data) => {
      if (data.get("new_password") !== data.get("confirm_password"))
        throw new Error("两次输入的新密码不一致");
      await api("/auth/password", {
        method: "POST",
        body: JSON.stringify({
          current_password: data.get("current_password"),
          new_password: data.get("new_password"),
        }),
      });
      state.currentUser.must_change_password = false;
      toast("密码已修改");
      await render(state.currentUser.role === "ADMIN" ? "dashboard" : "apply");
    },
  });
  if (force) {
    const cancel = form.querySelector("[data-modal-cancel]");
    cancel.textContent = "退出登录";
    cancel.onclick = logout;
    form.querySelector(".modal-close").hidden = true;
    form.closest(".modal-backdrop").onclick = () => {};
  }
}

async function boot() {
  const initialRoute = window.location.hash.replace(/^#\/?/, "").split("/");
  if (pages[initialRoute[0]]) {
    state.page = initialRoute[0];
    if (state.page === "instance-detail" && initialRoute[1])
      state.detailInstanceID = initialRoute[1];
  }
  try {
    const result = await api("/auth/me");
    applyCurrentUser(result.user);
    if (result.user.must_change_password) openOwnPasswordModal(true);
    else await render(state.page);
  } catch (error) {
    showLogin(error.status === 401 ? "" : error.message);
  }
}

$("#login-form").onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  const error = $("#login-error");
  error.classList.remove("show");
  submit.disabled = true;
  submit.querySelector("span").textContent = "登录中…";
  try {
    const data = Object.fromEntries(new FormData(form));
    const result = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify(data),
    });
    form.reset();
    applyCurrentUser(result.user);
    if (result.user.must_change_password) openOwnPasswordModal(true);
    else await render(result.user.role === "ADMIN" ? "dashboard" : "apply");
  } catch (reason) {
    error.textContent = reason.message;
    error.classList.add("show");
  } finally {
    submit.disabled = false;
    submit.querySelector("span").textContent =
      form.elements.source.value === "LDAP" ? "LDAP 登录" : "平台登录";
  }
};

document.querySelectorAll("[data-login-source]").forEach((button) => {
  button.onclick = () => {
    const source = button.dataset.loginSource;
    document
      .querySelectorAll("[data-login-source]")
      .forEach((item) => item.classList.toggle("active", item === button));
    $("#login-form [name=source]").value = source;
    $("#login-description").textContent =
      source === "LDAP"
        ? "使用已由管理员同步到平台的 LDAP 账号登录。"
        : "使用管理员在平台中创建的账号登录。";
    $("#login-form [type=submit] span").textContent =
      source === "LDAP" ? "LDAP 登录" : "平台登录";
  };
});

$("#logout-button").onclick = logout;

$("#password-button").onclick = () => openOwnPasswordModal(false);

boot();
async function refreshMyInstanceTable() {
  if (
    state.page !== "my-instances" ||
    document.hidden ||
    $("#modal-root").children.length ||
    document.activeElement?.matches("input,select,textarea,button")
  )
    return;
  const container = $('[data-instance-table="mine"]');
  if (!container) return;
  try {
    const result = await api("/instances?scope=mine");
    container.innerHTML = instanceTable(result.items, false, true);
    bind();
  } catch (error) {
    if (error.status === 401) showLogin();
  }
}
setInterval(() => {
  if (
    state.currentUser &&
    !state.currentUser.must_change_password &&
    state.page === "my-instances"
  )
    refreshMyInstanceTable();
}, 10000);
