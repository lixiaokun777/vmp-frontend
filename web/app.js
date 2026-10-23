const $ = (s) => document.querySelector(s);
class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
const cancelledContextMessage = "页面或登录会话已更新";
let sessionEpoch = 0;
let renderSequence = 0;
const pendingRequests = new Set();
const pageTimers = new Set();
const pendingIPProbeRequests = new Set();
let hostCredentialSecret = null;

function isCancelledContext(reason) {
  return reason?.name === "AbortError" || reason?.message === cancelledContextMessage || reason === cancelledContextMessage;
}
function cancelledContext() {
  return new Error(cancelledContextMessage);
}
function clearPageWork() {
  pendingRequests.forEach((controller) => controller.abort());
  pendingRequests.clear();
  pageTimers.forEach((timer) => clearTimeout(timer));
  pageTimers.clear();
  clearTimeout(state.filterTimer);
  state.filterTimer = null;
}
function schedulePageWork(callback, delay = 0) {
  const epoch = sessionEpoch;
  const sequence = renderSequence;
  const timer = setTimeout(() => {
    pageTimers.delete(timer);
    if (epoch === sessionEpoch && sequence === renderSequence) callback();
  }, delay);
  pageTimers.add(timer);
  return timer;
}
function beginSession() {
  // 会话和导航同时换代，即使浏览器取消请求后旧响应仍返回，也不能回写新账号页面。
  sessionEpoch += 1;
  renderSequence += 1;
  clearPageWork();
  pendingIPProbeRequests.clear();
  clearHostCredentialSecret();
  state.hostCredentialRequestPending = false;
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
  const epoch = sessionEpoch;
  const sequence = renderSequence;
  const controller = new AbortController();
  pendingRequests.add(controller);
  const checkContext = () => {
    if (epoch !== sessionEpoch || sequence !== renderSequence || controller.signal.aborted) throw cancelledContext();
  };
  try {
    const method = String(opts.method || "GET").toUpperCase();
    const r = await fetch("/api/v1" + path, {
      credentials: "same-origin",
      ...opts,
      headers: { "Content-Type": "application/json", ...opts.headers, ...(!["GET", "HEAD"].includes(method) ? { "X-VMP-Request": "1" } : {}) },
      signal: controller.signal,
    });
    checkContext();
    if (r.status === 204) return null;
    const j = await r.json().catch(() => {
      checkContext();
      throw new ApiError("平台服务返回异常，请稍后重试或联系管理员检查服务状态。", r.status);
    });
    checkContext();
    if (!r.ok) throw new ApiError(localizeError(j.error), r.status);
    return j;
  } catch (error) {
    if (controller.signal.aborted || epoch !== sessionEpoch || sequence !== renderSequence) throw cancelledContext();
    throw error;
  } finally {
    pendingRequests.delete(controller);
  }
};
const state = {
  page: "dashboard",
  lastCredentials: null,
  detailInstanceID: null,
  selectedNetworkID: null,
  currentUser: null,
  credentialsPending: false,
  credentialModalPending: false,
  hostCredentialRequestPending: false,
  partialSequence: 0,
  busyCount: 0,
  interactionUntil: 0,
  listFilters: {
    users: { keyword: "", role: "", source: "", status: "", page: 1, pageSize: 20 },
    instances: { keyword: "", status: "", host_id: "", page: 1, pageSize: 20 },
    mine: { keyword: "", status: "", page: 1, pageSize: 20 },
    requests: { keyword: "", status: "", type: "", page: 1, pageSize: 20 },
    approvals: { keyword: "", status: "PENDING", type: "", page: 1, pageSize: 20 },
    ips: { keyword: "", status: "", page: 1, pageSize: 20 },
    audit: { keyword: "", action: "", resourceType: "", outcome: "", scope: "HUMAN", dateFrom: "", dateTo: "", page: 1, pageSize: 20 },
  },
};
const initialListFilters = JSON.parse(JSON.stringify(state.listFilters));
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
  notifications: "通知设置",
  policy: "平台策略",
  audit: "操作审计",
};
const statusLabels = {
  ACTIVE: "正常",
  CORDONED: "暂停调度",
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
  return `<span class="pill ${ok ? "ok" : warn ? "warn" : bad ? "bad" : "blue"}">${esc(statusLabels[v] || v || "-")}</span>`;
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
  const page = numeric(result.page, state.listFilters[kind].page);
  const size = numeric(result.page_size, state.listFilters[kind].pageSize);
  const total = numeric(result.total, result.items?.length || 0);
  const pages = Math.max(1, Math.ceil(total / size));
  return `<div class="pagination" data-current-kind="${esc(kind)}" data-current-page="${page}"><span>共 ${total} 条，第 ${page} / ${pages} 页</span><div><select aria-label="每页条数" data-list-filter="${esc(kind)}" name="pageSize">${[10, 20, 50, 100].map((value) => `<option value="${value}" ${value === size ? "selected" : ""}>每页 ${value} 条</option>`).join("")}</select><button class="btn mini" data-list-page="${esc(kind)}" data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>上一页</button><button class="btn mini" data-list-page="${esc(kind)}" data-page="${page + 1}" ${page >= pages ? "disabled" : ""}>下一页</button></div></div>`;
}
const listPages = { users: "users", instances: "all-instances", mine: "my-instances", requests: "requests", approvals: "approvals", ips: "network", audit: "audit" };
function listURL(path, kind, extra = {}) {
  const filters = state.listFilters[kind];
  const params = new URLSearchParams({page: filters.page, page_size: filters.pageSize, ...extra});
  Object.entries(filters).forEach(([key, value]) => {
    if (!["page", "pageSize"].includes(key) && value !== "") params.set(key, value);
  });
  return path + "?" + params.toString();
}
function filterSelect(kind, name, label, options) {
  const value = state.listFilters[kind][name];
  return `<select aria-label="${esc(label)}" data-list-filter="${esc(kind)}" name="${esc(name)}"><option value="">${esc(label)}</option>${options.map(([key, text]) => `<option value="${esc(key)}" ${value === key ? "selected" : ""}>${esc(text)}</option>`).join("")}</select>`;
}
async function collectExportItems(path, kind) {
  // 固定本次筛选条件，显式遍历服务器分页，不把当前页误当全部导出结果。
  const parameters = new URLSearchParams(listURL(path, kind).split("?")[1]);
  parameters.set("page_size", "100");
  const items = [];
  const seen = new Set();
  for (let page = 1; page <= 100; page += 1) {
    parameters.set("page", String(page));
    const result = await api(path + "?" + parameters.toString());
    if (numeric(result.total, result.items.length) > 10000) throw new Error("筛选结果超过 10000 条，请缩小条件后导出，避免占用过多浏览器内存");
    result.items.forEach((item) => { if (!seen.has(item.id)) { seen.add(item.id); items.push(item); } });
    if (page * numeric(result.page_size, 100) >= numeric(result.total, result.items.length)) return items;
  }
  throw new Error("导出结果过大，请缩小筛选范围");
}
function listToolbar(kind, placeholder, controls = "") {
  return `<div class="list-toolbar table-toolbar"><input type="search" class="list-search" aria-label="${esc(placeholder)}" data-list-filter="${esc(kind)}" name="keyword" value="${esc(state.listFilters[kind].keyword)}" placeholder="${esc(placeholder)}"><div class="table-filter-group">${controls}<button class="btn mini" data-refresh-page>刷新</button><small data-last-refreshed>刚刚更新</small></div></div>`;
}
const lifecycleOptions = ["RUNNING", "STOPPED", "RETAINED", "PROVISIONING", "STARTING", "STOPPING", "REBOOTING", "DELETING", "ERROR"].map((key) => [key, statusLabels[key]]);
const approvalOptions = ["PENDING", "PROCESSING", "APPROVED", "APPROVED_FAILED", "REJECTED", "EXPIRED", "WITHDRAWN", "FAILED"].map((key) => [key, statusLabels[key]]);
function downloadCSV(filename, rows) {
  const csv = rows
    .map((row) =>
      row
        .map((value) => {
          let text = String(value ?? "");
          if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
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
  return (numeric(m) / 1024).toFixed(1) + " GiB";
}
function lead(title, desc, action = "") {
  return `<div class="page-lead"><div><h2>${esc(title)}</h2><p>${esc(desc)}</p></div>${action}</div>`;
}
function pathID(value) {
  return encodeURIComponent(String(value ?? ""));
}
function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function instanceResources(instance) {
  const snapshot = instance.resource_snapshot || instance.resources;
  return snapshot || (typeof instance.flavor === "object" ? instance.flavor : {});
}
function flavorUsage(flavors, instances) {
  const usage = new Map(flavors.map((flavor) => [flavor.id, { running: 0, retained: 0, reserved: 0 }]));
  instances.forEach((instance) => {
    const item = usage.get(instance.flavor_id);
    if (!item) return;
    if (instance.lifecycle_status === "RUNNING") item.running += 1;
    if (instance.lifecycle_status === "RETAINED") item.retained += 1;
    if (!["RELEASED", "DELETED"].includes(instance.lifecycle_status)) {
      // 统计使用实际分配快照，修改套餐或同名套餐不会改变历史实例的占用量。
      item.reserved += numeric(instanceResources(instance).memory_mb);
    }
  });
  return usage;
}
function userStatus(user) {
  if (!user.enabled) return '<span class="pill">● 已停用</span>';
  if (user.source === "LDAP" && user.ldap_directory_present === false) return '<span class="pill bad">● LDAP 目录不可用</span>';
  return user.must_change_password ? '<span class="pill warn">● 首次需改密</span>' : '<span class="pill ok">● 正常</span>';
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
  const previousFocus = document.activeElement;
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (previousFocus?.isConnected) previousFocus.focus();
  if (!copied) throw new Error("浏览器未能自动复制，请手动选中连接信息或密码后复制并保存");
}

let modalPreviousFocus = null;
let fieldSerial = 0;
function modalFocusTrap(event, root, close) {
  if (event.key === "Escape") { event.preventDefault(); close(); return; }
  if (event.key !== "Tab") return;
  const focusable = [...root.querySelectorAll('button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]')].filter((node) => !node.hidden && node.getClientRects().length);
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
function setBackgroundInert(value) {
  $("#app-shell").inert = value;
  $("#login-screen").inert = value;
}
function clearHostCredentialSecret() {
  if (!hostCredentialSecret) return;
  // 清空持有对象及可见字段；复制按钮即使被旧闭包保留，也不能再取到令牌。
  hostCredentialSecret.runtimeToken = "";
  hostCredentialSecret.hostID = "";
  hostCredentialSecret = null;
  state.credentialModalPending = false;
  document.querySelectorAll("[data-host-credential-sensitive]").forEach((node) => {
    if ("value" in node) node.value = "";
    node.textContent = "";
  });
}
function hostCredentialRequestNotice() {
  showAlert({ title: "凭据签发正在进行", message: "请等待本次请求完成后保存结果。签发可能已使旧凭据失效；此时离开无法确认结果，请勿重复签发。", type: "warning" });
}
function confirmCredentialDiscard(next) {
  const root = $("#alert-root");
  alertPreviousFocus = document.activeElement;
  $("#modal-root").inert = true;
  setBackgroundInert(true);
  const hostSecret = Boolean(hostCredentialSecret);
  const title = hostSecret ? "宿主凭据尚未确认保存" : "登录密码尚未确认保存";
  const description = hostSecret ? "离开后不能再次查看本次令牌，旧凭据已失效。请先保存并更新目标 Agent；仍要离开时，保持宿主暂停调度，后续只能由管理员重新签发。" : "离开后不能再次查看本次密码。请先复制并保存；如仍要离开，可稍后在实例详情重新重置密码。";
  root.innerHTML = `<div class="alert-backdrop"><section class="alert-dialog warning" role="alertdialog" aria-modal="true" aria-labelledby="credential-leave-title" aria-describedby="credential-leave-description"><div class="alert-symbol" aria-hidden="true">!</div><div class="alert-copy"><span class="alert-eyebrow">离开前请确认</span><h3 id="credential-leave-title">${title}</h3><p id="credential-leave-description">${description}</p></div><div class="alert-actions"><button class="btn primary" type="button" data-stay-credentials>${hostSecret ? "继续保存凭据" : "继续保存密码"}</button><button class="btn danger" type="button" data-discard-credentials>确认离开</button></div></section></div>`;
  root.querySelector("[data-stay-credentials]").onclick = closeAlert;
  root.querySelector("[data-discard-credentials]").onclick = () => { state.credentialsPending = false; state.credentialModalPending = false; closeAlert(); next(); };
  root.onkeydown = (event) => modalFocusTrap(event, root, closeAlert);
  schedulePageWork(() => root.querySelector("[data-stay-credentials]")?.focus());
}
function closeModal(force = false) {
  if (force !== true && state.hostCredentialRequestPending) { hostCredentialRequestNotice(); return false; }
  if (force !== true && state.credentialModalPending) { confirmCredentialDiscard(() => closeModal(true)); return false; }
  const refreshHost = Boolean(hostCredentialSecret) && state.page === "hosts";
  clearHostCredentialSecret();
  state.credentialModalPending = false;
  $("#modal-root").innerHTML = "";
  $("#modal-root").inert = false;
  setBackgroundInert(Boolean($("#alert-root").children.length));
  if (modalPreviousFocus?.isConnected) modalPreviousFocus.focus();
  modalPreviousFocus = null;
  if (refreshHost) schedulePageWork(() => { if (state.page === "hosts") refreshPageData(true); });
  return true;
}

let alertPreviousFocus = null;
function closeAlert() {
  $("#alert-root").replaceChildren();
  $("#modal-root").inert = false;
  setBackgroundInert(Boolean($("#modal-root").children.length));
  alertPreviousFocus?.focus();
  alertPreviousFocus = null;
}

function showAlert({
  title = "操作未完成",
  message,
  type = "error",
  actionText = "我知道了",
}) {
  if (isCancelledContext(message)) return;
  const root = $("#alert-root");
  if (!root.children.length) alertPreviousFocus = document.activeElement;
  $("#modal-root").inert = true;
  setBackgroundInert(true);
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
  schedulePageWork(() => root.querySelector("[data-alert-confirm]")?.focus());
}

function showFormModal({
  title,
  description = "",
  content,
  submitText = "保存",
  compact = false,
  onSubmit,
  validationRules = null,
  keepOpen = false,
}) {
  const root = $("#modal-root");
  modalPreviousFocus = document.activeElement;
  setBackgroundInert(true);
  root.innerHTML = `<div class="modal-backdrop"><form class="modal-card ${compact ? "compact" : ""}" id="modal-form" role="dialog" aria-modal="true" aria-labelledby="modal-title" aria-describedby="modal-description"><div class="modal-head"><div><h3 id="modal-title">${esc(title)}</h3><p id="modal-description">${esc(description)}</p></div><button class="modal-close" type="button" aria-label="关闭">×</button></div><div class="modal-body">${content}<div class="form-error" id="modal-error" role="alert"></div></div><div class="modal-actions"><button class="btn" type="button" data-modal-cancel>取消</button><button class="btn primary" type="submit">${esc(submitText)}</button></div></form></div>`;
  const form = $("#modal-form");
  if (validationRules) { form.noValidate = true; bindInlineValidation(form, validationRules); }
  root.querySelector(".modal-close").onclick = closeModal;
  root.querySelector("[data-modal-cancel]").onclick = closeModal;
  root.querySelector(".modal-backdrop").onclick = (event) => {
    if (event.target === event.currentTarget) closeModal();
  };
  root.onkeydown = (event) => modalFocusTrap(event, root, () => { if (!form.dataset.forcePassword) closeModal(); });
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (validationRules && !validateFields(form, validationRules)) return;
    const error = $("#modal-error");
    const submit = form.querySelector('[type="submit"]');
    if (submit.disabled) return;
    error.classList.remove("show");
    submit.disabled = true;
    submit.textContent = "提交中…";
    try {
      await onSubmit(new FormData(form), form);
      if (root.querySelector("#modal-form") === form) {
        if (keepOpen) { submit.disabled = false; submit.textContent = submitText; }
        else closeModal(true);
      }
    } catch (reason) {
      if (isCancelledContext(reason) || root.querySelector("#modal-form") !== form) return;
      error.textContent = localizeError(reason.message || "操作失败");
      error.classList.add("show");
      submit.disabled = false;
      submit.textContent = submitText;
    }
  };
  schedulePageWork(() => { if (form.isConnected) form.querySelector("input,select,textarea")?.focus(); });
  bindAccessibleFields(form);
  return form;
}

function field(name, label, value = "", options = {}) {
  const type = options.type || "text";
  const id = `field-${++fieldSerial}`;
  const attrs = [
    `id="${id}"`,
    `name="${esc(name)}"`,
    `type="${esc(type)}"`,
    `value="${esc(value)}"`,
    options.required === false ? "" : "required",
    options.min !== undefined ? `min="${esc(options.min)}"` : "",
    options.max !== undefined ? `max="${esc(options.max)}"` : "",
    options.step !== undefined ? `step="${esc(options.step)}"` : "",
    options.placeholder ? `placeholder="${esc(options.placeholder)}"` : "",
    options.autocomplete ? `autocomplete="${esc(options.autocomplete)}"` : "",
    options.hint ? `aria-describedby="${id}-hint"` : "",
    options.maxlength !== undefined ? `maxlength="${esc(options.maxlength)}"` : "",
    options.inlineError ? `data-error-id="${id}-error"` : "",
    options.readonly ? "readonly" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<div class="field ${options.full ? "full" : ""}"><label for="${id}">${esc(label)}</label><input ${attrs}>${options.hint ? `<span class="input-hint" id="${id}-hint">${esc(options.hint)}</span>` : ""}${options.inlineError ? `<span class="field-error" id="${id}-error" data-field-error="${esc(name)}" role="alert" hidden></span>` : ""}</div>`;
}

const applicationValidationRules = {
  instance_name: value => /^[a-zA-Z0-9-]{1,48}$/.test(value) ? "" : "实例名称需为 1–48 位字母、数字或连字符",
  purpose: value => value.trim() ? "" : "请填写用途说明，不能只输入空格",
};
function passwordValidationErrors(values) {
  return {
    current_password: values.current_password ? "" : "请输入当前密码",
    new_password: values.new_password.length >= 10 && /[A-Z]/.test(values.new_password) && /[a-z]/.test(values.new_password) && /[0-9]/.test(values.new_password) ? "" : "新密码至少 10 位，包含大写字母、小写字母和数字",
    confirm_password: values.confirm_password && values.confirm_password === values.new_password ? "" : "两次输入的新密码不一致",
  };
}
function setFieldError(form, name, message) {
  const input = form.elements[name];
  const slot = form.querySelector(`[data-field-error="${name}"]`);
  if (!input || !slot) return;
  slot.textContent = message; slot.hidden = !message;
  input.setAttribute("aria-invalid", String(Boolean(message)));
  const ids = new Set((input.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
  if (message) ids.add(slot.id); else ids.delete(slot.id);
  if (ids.size) input.setAttribute("aria-describedby", [...ids].join(" ")); else input.removeAttribute("aria-describedby");
}
function validateFields(form, rules) {
  let first = null;
  for (const [name, rule] of Object.entries(rules)) {
    const input = form.elements[name]; const message = rule(input?.value || "", form);
    setFieldError(form, name, message); if (message && !first) first = input;
  }
  first?.focus(); return !first;
}
function bindInlineValidation(form, rules) {
  for (const [name, rule] of Object.entries(rules)) {
    const input = form.elements[name]; if (!input) continue;
    input.onblur = () => setFieldError(form, name, rule(input.value, form));
    input.oninput = () => {
      if (input.getAttribute("aria-invalid") === "true") setFieldError(form, name, rule(input.value, form));
      if (name === "new_password" && form.elements.confirm_password?.getAttribute("aria-invalid") === "true") setFieldError(form, "confirm_password", rules.confirm_password(form.elements.confirm_password.value, form));
    };
  }
}
function bindAccessibleFields(root = document) {
  root.querySelectorAll(".field").forEach((wrapper) => {
    const label = wrapper.querySelector("label");
    const control = wrapper.querySelector('input:not([type="radio"]):not([type="checkbox"]), select, textarea');
    if (!label || !control || label.contains(control)) return;
    if (!control.id) control.id = `field-${++fieldSerial}`;
    label.htmlFor = control.id;
  });
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
	if (state.currentUser?.role !== "ADMIN") return myOverview();
  const [s, instances] = await Promise.all([
    api("/summary"),
    api("/instances?scope=mine&page_size=5"),
  ]);
  const ratio = s.allocatable_memory_mb
    ? Math.round((s.reserved_memory_mb / s.allocatable_memory_mb) * 100)
    : 0;
  return `${lead("资源总览", "临时计算资源、我的虚拟机与平台容量状态")}${s.pending_approvals ? `<button class="pending-approval-banner" data-go="approvals"><b>待审批 ${esc(s.pending_approvals)} 条</b><span>有长租期申请等待处理，点击立即审批 →</span></button>` : ""}<div class="cards"><div class="metric"><span class="label">在线宿主机</span><strong>${esc(s.active_hosts)}</strong><small>由 Agent 持续心跳</small></div><div class="metric"><span class="label">运行中实例</span><strong>${esc(s.running_instances)}</strong><small>${esc(s.provisioning_instances)} 台交付中</small></div><div class="metric"><span class="label">我的虚拟机</span><strong>${numeric(instances.total, instances.items.length)}</strong><small>当前账号 ${esc(state.currentUser?.username || "-")}</small></div><div class="metric"><span class="label">内存预占率</span><strong>${ratio}%</strong><small>${gb(s.reserved_memory_mb)} / ${gb(s.allocatable_memory_mb)}</small></div></div><div class="grid2"><div class="panel"><h3>集群容量</h3><div class="capacity-row"><div><span>临时资源池内存</span><b>${ratio}%</b></div><div class="capacity"><span style="width:${ratio}%"></span></div></div><p style="color:var(--muted)">申请时在同一个数据库事务内完成宿主机资源和 IP 地址预占，避免并发超卖。</p></div><div class="panel"><h3>快捷操作</h3><div class="quick"><button data-go="apply">＋<br>申请虚拟机</button><button data-go="my-instances">▣<br>我的虚拟机</button><button data-go="hosts">⌁<br>宿主状态</button><button data-go="network">⌘<br>网络 IP</button></div></div></div>${instances.items.length ? `<div class="panel" style="margin-top:18px"><h3>我的最近实例</h3>${instanceTable(instances.items.slice(0, 5), false)}</div>` : ""}`;
}

function quotaText(used, limit, formatter = (value) => value) {
  return limit > 0 ? `${formatter(used)} / ${formatter(limit)}` : `${formatter(used)} / 不限`;
}

function quotaPercent(used, limit) {
  if (!limit) return 0;
  return Math.min(100, Math.round((Number(used || 0) / Number(limit)) * 100));
}

async function myOverview() {
  const [overview, instances] = await Promise.all([
    api("/me/overview"),
    api("/instances?scope=mine&page_size=5"),
  ]);
  const limits = overview.limits || {};
  const expiry = overview.nearest_expiry ? leaseState(overview.nearest_expiry) : null;
  const quotas = [
    ["实例", overview.quota_instances, limits.instances, (value) => `${value} 台`],
    ["CPU", overview.used_cpu, limits.cpu, (value) => `${value} 核`],
    ["内存", overview.used_memory_mb, limits.memory_mb, gb],
    ["磁盘", overview.used_disk_gb, limits.disk_gb, (value) => `${value} GiB`],
  ];
  return `${lead("我的概览", "查看个人临时资源、配额占用和最近到期提醒", '<button class="btn primary" data-go="apply">＋ 申请虚拟机</button>')}<div class="cards user-overview-cards"><div class="metric"><span class="label">在用虚拟机</span><strong>${esc(overview.active_instances || 0)} 台</strong><small>保留期实例另计入配额</small></div><div class="metric"><span class="label">配额占用实例</span><strong>${esc(overview.quota_instances || 0)} 台</strong><small>${limits.instances ? `上限 ${esc(limits.instances)} 台` : "平台暂未限制台数"}</small></div><div class="metric ${Number(overview.expiring_24h || 0) ? "metric-warning" : ""}"><span class="label">最近到期</span><strong>${overview.nearest_expiry ? esc(expiry?.text || fmtDate(overview.nearest_expiry)) : "暂无"}</strong><small>${overview.nearest_expiry ? fmtDate(overview.nearest_expiry) : "当前没有运行中的临时资源"}</small></div><div class="metric"><span class="label">24 小时内到期</span><strong>${esc(overview.expiring_24h || 0)} 台</strong><small>${Number(overview.expiring_24h || 0) ? "请及时续期或备份数据" : "近期没有到期风险"}</small></div></div><div class="panel overview-quota-panel"><div class="section-heading"><div><h3>我的配额</h3><p>保留期和失败待清理实例仍会占用资源配额</p></div></div><div class="overview-quota-grid">${quotas.map(([name, used, limit, formatter]) => `<div class="overview-quota-item"><div><b>${esc(name)}</b><span>${esc(quotaText(Number(used || 0), Number(limit || 0), formatter))}</span></div><div class="capacity"><span style="width:${quotaPercent(used, limit)}%"></span></div></div>`).join("")}</div></div>${instances.items.length ? `<div class="panel" style="margin-top:18px"><div class="section-heading"><div><h3>最近的虚拟机</h3><p>点击详情可查看交付状态、任务和近 24 小时监控</p></div><button class="btn mini" data-go="my-instances">查看全部</button></div>${instanceTable(instances.items.slice(0, 5), false, true)}</div>` : '<div class="panel empty overview-empty">还没有虚拟机，点击右上角“申请虚拟机”开始使用。</div>'}`;
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
  return `${lead("申请虚拟机", "7 天以内自动交付；超过 7 天由管理员审批后调度")}<div class="apply-layout"><form class="form-card apply-card" id="apply-form" novalidate><div class="form-grid">${field("instance_name","实例名称 *","",{maxlength:48,inlineError:true,placeholder:"例如 dev-api-01",hint:"1–48 位字母、数字或连字符"})}<div class="field"><label>使用时长 <span class="required-mark">*</span></label><select name="lease_hours"><option value="8">8 小时 · 自动交付</option><option value="24" selected>1 天 · 自动交付</option><option value="72">3 天 · 自动交付</option><option value="168">7 天 · 自动交付</option><option value="336">14 天 · 需要审批</option></select></div><div class="field full"><label>资源规格 <span class="required-mark">*</span></label><div class="flavor-selector">${flavors.map((x, index) => `<label class="flavor-option ${index === 0 ? "selected" : ""}"><input type="radio" name="flavor_id" value="${esc(x.id)}" data-name="${esc(x.name)}" data-cpu="${esc(x.cpu)}" data-memory="${esc(x.memory_mb)}" data-disk="${esc(x.disk_gb)}" ${index === 0 ? "checked" : ""}><b>${esc(x.name)}</b><span>${esc(x.cpu)} vCPU · ${gb(x.memory_mb)} · ${esc(x.disk_gb)} GiB 系统盘</span><small>${x.cpu >= 4 ? "适合构建 / 数据库" : x.cpu >= 2 ? "适合常规开发" : "适合轻量编译 / 测试"}</small></label>`).join("")}</div></div><div class="field"><label>系统镜像 <span class="required-mark">*</span></label><select name="image_id">${images.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("")}</select></div><div class="field"><label>网络 <span class="required-mark">*</span></label><select name="network_id">${networks
    .filter((x) => x.enabled)
    .map(
      (x) =>
        `<option value="${esc(x.id)}">${esc(x.name)} · ${esc(x.cidr)} · 可用 ${esc(x.free)}</option>`,
    )
    .join(
      "",
    )}</select></div><div class="field full"><label>用途说明 <span class="required-mark">*</span></label><textarea name="purpose" required placeholder="说明项目、使用场景以及需要临时服务器的原因"></textarea><span id="apply-purpose-error" class="field-error" data-field-error="purpose" role="alert" hidden></span></div></div><div class="form-actions"><button type="button" class="btn" data-go="dashboard">取消</button><button class="btn primary" type="submit">提交申请 →</button></div></form><div class="apply-side"><div class="panel apply-summary"><h3>申请摘要</h3><span class="source-sub">随左侧选择实时更新</span><dl><div><dt>规格</dt><dd data-summary-flavor>${esc(firstFlavor?.name || "-")}</dd></div><div><dt>镜像</dt><dd data-summary-image>${esc(firstImage?.name || "-")}</dd></div><div><dt>网络</dt><dd data-summary-network>${esc(firstNetwork?.cidr || "-")}</dd></div><div><dt>租期</dt><dd data-summary-lease>1 天</dd></div><div><dt>预计到期</dt><dd data-summary-expiry>-</dd></div><div><dt>预计占用</dt><dd data-summary-resource>${firstFlavor ? `${gb(firstFlavor.memory_mb)} 内存 · ${esc(firstFlavor.disk_gb)} GB 磁盘` : "-"}</dd></div></dl></div><div class="panel apply-notice"><h3>交付说明</h3><ul><li>7 天以内自动调度，通常 1–3 分钟完成交付</li><li>超过 7 天等待管理员审批，审批期间不占用资源</li><li>登录密码仅展示一次，丢失可在实例详情重置</li><li>到期关机后进入 7 天保留期，可保留原 IP 恢复</li></ul></div></div></div>`;
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
  if (x.lifecycle_status === "ERROR" && !x.ip_recovery_pending) buttons.push(["retry", "重试创建"]);
  if (["RUNNING", "STOPPED"].includes(x.lifecycle_status))
    buttons.push(["renew", "续期"]);
  if (x.lifecycle_status === "RETAINED" && Number(x.restore_count || 0) < 1) buttons.push(["restore", "恢复"]);
  if (["RUNNING", "STOPPED"].includes(x.lifecycle_status))
    buttons.push(["release", "释放"]);
  if (["RUNNING", "STOPPED", "RETAINED", "ERROR"].includes(x.lifecycle_status))
    buttons.push(["force_delete", "立即删除"]);
  const pending = x.ip_recovery_pending
    ? '<button class="btn mini" disabled>IP 复核中…</button>'
    : [
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
          `<button class="btn mini ${action === "release" || action === "force_delete" ? "danger" : ""}" data-instance-action="${action}" data-instance-id="${esc(x.id)}" data-instance-name="${esc(x.name)}" data-restore-count="${Number(x.restore_count || 0)}">${label}</button>`,
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
  const result = await api(listURL("/instances", "mine", {scope: "mine"}));
  const expiring = result.items.filter((item) => { const hours = (new Date(item.expires_at).getTime() - Date.now()) / 3600000; return ["RUNNING", "STOPPED"].includes(item.lifecycle_status) && hours > 0 && hours < 24; });
  const count = numeric(result.expiring_total, expiring.length);
  return lead("我的虚拟机", "当前账号的临时虚拟机，搜索与分页均由服务端处理", '<button class="btn primary" data-go="apply">＋ 申请虚拟机</button>') + listToolbar("mine", "搜索实例名或 IP", filterSelect("mine", "status", "全部状态", lifecycleOptions)) + '<section data-page-results><span hidden data-expiring-count="' + count + '"></span>' + (count ? '<div class="expiry-alert"><b>' + count + ' 台虚拟机将在 24 小时内到期</b><span>按当前账号全部实例统计，不受筛选或分页影响；普通到期后保留 7 天，已恢复过的实例不再享受第二次保留。</span></div>' : "") + '<div class="resource-table-wrap" data-instance-table="mine">' + instanceTable(result.items, false, true) + '</div>' + pagination("mine", result) + '</section>';
}

function approvalTable(items, administrator = false) {
  const columns = administrator ? 9 : 7;
  const rows = items.length
    ? items.map((item) => {
        const resultError = item.result?.error ? `<span class="source-sub validation-error">${esc(item.result.error)}</span>` : "";
        const assigned = item.assigned_reviewer ? `<span class="source-sub">待处理人：${esc(item.assigned_reviewer)}${item.delegated_from ? " · 代理 " + esc(item.delegated_from) : ""}</span>` : "";
        const review = item.reviewer ? `${esc(item.reviewer)}${item.review_comment ? `<span class="source-sub">${esc(item.review_comment)}</span>` : ""}` : (assigned || "-");
        const resultInstanceID = item.result?.instance_id || item.result?.id || item.instance_id;
        const result = resultInstanceID
          ? `<button class="btn mini" data-approval-instance="${esc(resultInstanceID)}">查看实例</button>${item.request_type === "CREATE" ? '<span class="source-sub">批准后请在实例详情重置登录密码</span>' : ""}`
          : "-";
        const actions = administrator && item.status === "PENDING"
          ? `<div class="row-actions"><button class="btn mini primary" data-approval-decision="APPROVE" data-approval-id="${esc(item.id)}" data-approval-no="${esc(item.request_no)}" data-approval-hours="${esc(item.requested_hours)}">批准</button><button class="btn mini danger" data-approval-decision="REJECT" data-approval-id="${esc(item.id)}" data-approval-no="${esc(item.request_no)}">拒绝</button><button class="btn mini" data-transfer-approval="${esc(item.id)}" data-approval-no="${esc(item.request_no)}">转交</button></div>`
          : "-";
        const userActions = item.status === "PENDING"
          ? `<button class="btn mini danger" data-withdraw-approval="${esc(item.id)}" data-approval-no="${esc(item.request_no)}">撤回</button>`
          : ["REJECTED", "EXPIRED", "FAILED", "WITHDRAWN"].includes(item.status) && !item.result?.execution_uncertain
            ? `<button class="btn mini" data-resubmit-short="${esc(item.id)}" data-approval-type="${esc(item.request_type)}" data-approval-no="${esc(item.request_no)}">改成短租期重提</button>${result}`
            : result;
        const remaining = item.status === "PENDING" ? `<span class="source-sub">审批截止 ${fmtDate(item.expires_at)}</span>` : "";
        return `<tr>${administrator ? `<td><input type="checkbox" data-approval-select value="${esc(item.id)}" ${item.status === "PENDING" ? "" : "disabled"}></td>` : ""}<td><b>${esc(item.request_no)}</b><span class="source-sub">${fmtDate(item.created_at)}</span>${remaining}</td><td>${esc(approvalTypeLabel(item.request_type))}</td>${administrator ? `<td><b>${esc(item.applicant)}</b></td>` : ""}<td><b>${esc(item.instance_name || "-")}</b><span class="source-sub">${esc(item.reason || "-")}</span></td><td>${leaseHoursLabel(item.requested_hours)}</td><td>${status(item.status)}${resultError}</td><td>${review}</td><td>${administrator ? actions : userActions}</td></tr>`;
      }).join("")
    : `<tr><td colspan="${columns}" class="empty">暂无审批记录</td></tr>`;
  return `<div class="resource-table-wrap"><table><thead><tr>${administrator ? '<th><input type="checkbox" data-approval-select-all></th>' : ""}<th>审批单 / 时间</th><th>类型</th>${administrator ? "<th>申请人</th>" : ""}<th>实例 / 原因</th><th>申请时长</th><th>状态</th><th>审批意见</th><th>${administrator ? "操作" : "结果"}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

const failureDiagnoses = {
  IP_ADDRESS_IN_USE: ["IP 地址已被占用", "平台会自动换用可用地址；若地址池均被占用或隔离，请联系管理员复核地址池。"],
  IP_PROBE_FAILED: ["IP 探测未完成", "请联系管理员检查宿主机的 iputils-arping、网桥、VLAN 和探测权限，然后在实例详情重试。"],
  NO_SCHEDULABLE_HOST: ["暂无可调度宿主机", "可改用较小规格后重试，或联系管理员检查宿主资源、镜像和网络就绪状态。"],
  IMAGE_NOT_READY: ["镜像尚未就绪", "请联系管理员在镜像页面完成目标宿主同步和校验后重试。"],
  NETWORK_NOT_READY: ["宿主网络未就绪", "请联系管理员检查目标宿主网桥、链路和网络白名单。"],
  DELIVERY_FAILED: ["虚拟机交付检查失败", "可在实例详情打开 VNC/串口控制台排查 cloud-init 与网络，确认后重试创建。"],
  EXECUTION_UNCERTAIN: ["执行结果暂时无法确认", "请勿重复申请；联系管理员核对宿主机实际虚拟机和任务记录后再处理。"],
};

const taskTypeLabels = {CREATE_INSTANCE:"创建虚拟机",DELETE_INSTANCE:"删除虚拟机",DELETE:"删除虚拟机",START_INSTANCE:"开机",STOP_INSTANCE:"关机",REBOOT_INSTANCE:"重启",RESET_INSTANCE_PASSWORD:"重置登录密码",SYNC_IMAGE:"同步镜像",PROBE_IP_ADDRESS:"IP 地址复核"};
function failureDiagnosis(code, message = "") {
  const normalized = String(code || "").toUpperCase();
  if (failureDiagnoses[normalized]) return {code: normalized, title: failureDiagnoses[normalized][0], advice: failureDiagnoses[normalized][1]};
  if (/capacity|schedulable host/i.test(message)) return {code: "RESOURCE_CAPACITY", title: "资源容量不足", advice: "尝试选择较小规格，或联系管理员释放/扩充宿主机可分配资源。"};
  if (/image/i.test(message)) return {code: "IMAGE_ERROR", title: "镜像交付失败", advice: "请联系管理员检查镜像同步状态、摘要和宿主机缓存。"};
  return {code: normalized || "DELIVERY_ERROR", title: "自动交付失败", advice: "请先进入实例详情查看任务记录并尝试重试；仍失败时将申请单号和错误码提供给管理员。"};
}

function applicationDeliveryTable(items) {
  const rows = items.length ? items.map((item) => {
    const failed = item.task_status === "FAILED" || item.lifecycle_status === "ERROR" || item.delivery_status === "FAILED";
    const diagnosis = failed ? failureDiagnosis(item.error_code, item.error_message || item.delivery_message) : null;
    const stateLabel = failed ? status("FAILED") : status(item.lifecycle_status || item.task_status || item.status);
    const result = item.instance_id ? `<button class="btn mini" data-approval-instance="${esc(item.instance_id)}">查看实例</button>` : "-";
    return `<tr><td><b>${esc(item.request_no)}</b><span class="source-sub">${fmtDate(item.created_at)}</span></td><td><b>${esc(item.instance_name)}</b><span class="source-sub">${esc(item.flavor)} · ${esc(item.image)}</span></td><td>${leaseHoursLabel(item.lease_hours)}</td><td>${stateLabel}${diagnosis ? `<span class="diagnosis-code">${esc(diagnosis.code)}</span>` : ""}</td><td>${diagnosis ? `<div class="failure-diagnosis"><b>${esc(diagnosis.title)}</b><span>${esc(diagnosis.advice)}</span>${item.error_message ? `<small>原始信息：${esc(item.error_message)}</small>` : ""}</div>` : '<span class="source-sub">平台正在处理或已完成交付</span>'}</td><td>${result}</td></tr>`;
  }).join("") : '<tr><td colspan="6" class="empty">暂无自动交付记录</td></tr>';
  return `<div class="resource-table-wrap application-delivery-table sticky-actions"><table><thead><tr><th>申请单 / 时间</th><th>实例 / 配置</th><th>租期</th><th>状态</th><th>诊断与下一步</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

async function requestsPage() {
  const [result, applications] = await Promise.all([api(listURL("/approvals", "requests", {scope: "mine"})), api("/applications?scope=mine&page=1&page_size=10")]);
  const controls = filterSelect("requests", "status", "全部状态", approvalOptions) + filterSelect("requests", "type", "全部类型", [["CREATE", "创建虚拟机"], ["RENEW", "续期"], ["RESTORE", "恢复"]]);
  return lead("我的申请", "查看自动交付诊断、长租期审批、撤回和执行结果", '<button class="btn primary" data-go="apply">＋ 申请虚拟机</button>') + '<section data-page-results><div class="panel request-section"><div class="section-heading"><div><h3>最近自动交付</h3><p>失败记录会给出结构化错误码和下一步处理建议</p></div></div>' + applicationDeliveryTable(applications.items) + '</div><div class="request-approval-section"><div class="section-heading"><div><h3>审批记录</h3><p>超过 7 天的创建、续期和恢复申请</p></div></div>' + listToolbar("requests", "搜索审批单、实例或原因", controls) + approvalTable(result.items, false) + pagination("requests", result) + '</div></section>';
}
async function approvalsPage() {
  const [result, delegation] = await Promise.all([api(listURL("/approvals", "approvals")), api("/approval-delegation")]);
  state.approvalAdministrators = delegation.administrators || [];
  const controls = filterSelect("approvals", "status", "全部状态", approvalOptions) + filterSelect("approvals", "type", "全部类型", [["CREATE", "创建虚拟机"], ["RENEW", "续期"], ["RESTORE", "恢复"]]);
  return lead("待我审批", "审批单可按状态检索、转交；默认 24 小时未处理自动关闭", '<button class="btn" data-approval-delegation>设置审批代理</button>') + listToolbar("approvals", "搜索审批单、申请人、实例或原因", controls) + '<section data-page-results><div class="batch-actions"><span data-batch-count>已选择 0 项</span><button class="btn mini primary" data-batch-approval="APPROVE">批量批准</button><button class="btn mini danger" data-batch-approval="REJECT">批量拒绝</button></div>' + approvalTable(result.items, true) + pagination("approvals", result) + '</section>';
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
  const [result, hosts] = await Promise.all([api(listURL("/instances", "instances")), api("/hosts")]);
  const controls = filterSelect("instances", "status", "全部状态", lifecycleOptions) + filterSelect("instances", "host_id", "全部宿主机", hosts.items.map((host) => [host.id, host.name]));
  return lead("全部实例", "平台创建的全部临时虚拟机", '<button class="btn" data-export="instances">导出筛选结果 CSV</button>') + listToolbar("instances", "搜索实例、使用人或 IP", controls) + '<section data-page-results><div class="resource-table-wrap" data-instance-table="all">' + instanceTable(result.items, true, true) + '</div>' + pagination("instances", result) + '</section>';
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
  const recovery = instance.ip_recovery_pending || instance.ip_recovery_message
    ? `<div class="notice instance-ip-recovery" role="status"><b>${instance.ip_recovery_pending ? "IP 复核中" : "最近 IP 复核"}</b>：${esc(localizeError(instance.ip_recovery_message || "正在复核隔离地址；尚未开始重新创建，完成后请查看结果。"))}</div>` : "";
  return `${recovery}<div class="delivery-progress"><div class="delivery-progress-head"><div><h3>交付进度</h3><p>Agent 完成磁盘、启动和网络检查后，实例才会进入运行中。</p></div>${instance.ip_recovery_pending ? '<span class="pill warn">IP 复核中</span>' : failed ? '<span class="pill bad">交付失败</span>' : completed ? '<span class="pill ok">交付完成</span>' : '<span class="pill warn">交付中</span>'}</div><div class="delivery-steps">${steps.map(([label, stepState], index) => `<div class="delivery-step ${stepState}"><i>${stepState === "done" ? "✓" : index + 1}</i><span>${label}</span></div>`).join("")}</div></div>`;
}

async function instanceDetailPage() {
  if (!state.detailInstanceID) return lead("实例详情", "未选择实例");
  const [x, metrics] = await Promise.all([
    api("/instances/" + pathID(state.detailInstanceID)),
    api("/instances/" + pathID(state.detailInstanceID) + "/metrics?hours=24"),
  ]);
  const i = x.instance;
  const scheduling = schedulingDecisionHTML(i.scheduling);
  const resources = instanceResources(i);
  const toolbar = `<div class="row-actions" data-live-actions><button class="btn" data-go="my-instances">返回列表</button>${instanceActions(i, false)}<button class="btn mini" data-auto-renew="${esc(i.id)}">自动续期设置</button><button class="btn mini" data-refresh-page>刷新状态</button></div>`;
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
            `<tr><td><b>${esc(taskTypeLabels[task.task_type] || "未知任务")}</b><span class="source-sub">${esc(task.task_type)}</span></td><td>${status(task.status)}</td><td>${esc(task.attempt)}/${esc(task.max_attempts)}</td><td>${task.error_message ? `${esc(task.error_message)}${task.error_code ? `<span class="diagnosis-code">${esc(task.error_code)}</span><span class="source-sub">${esc(failureDiagnosis(task.error_code, task.error_message).advice)}</span>` : ""}` : "-"}</td><td>${fmtDate(task.created_at)}</td></tr>`,
        )
        .join("")
    : '<tr><td colspan="5" class="empty">暂无任务</td></tr>';
  return `${lead(i.name, "虚拟机配置、租期、任务和审计记录", toolbar)}<section data-page-results>${deliveryProgress(i, x.tasks)}<div class="cards"><div class="metric"><span class="label">状态</span><strong>${esc(i.lifecycle_status)}</strong><small>${esc(i.provider_status)}</small></div><div class="metric"><span class="label">资源</span><strong>${esc(resources.cpu)}C / ${gb(resources.memory_mb)}</strong><small>${esc(resources.disk_gb)} GB 系统盘</small></div><div class="metric"><span class="label">IP 地址</span><strong>${esc(i.ip_address || "-")}</strong><small>${esc(i.username || "-")}</small></div><div class="metric"><span class="label">租期</span><strong>${fmtDate(i.expires_at)}</strong><small>${i.retention_until ? `保留至 ${fmtDate(i.retention_until)}` : "未进入保留期"}</small></div></div>${scheduling}${instanceMonitoring(metrics.items || [], resources)}<div class="grid2"><div class="panel"><h3>实例信息</h3><dl class="detail-list"><div><dt>申请单</dt><dd>${esc(i.request_no)}</dd></div><div><dt>用途</dt><dd>${esc(i.purpose)}</dd></div><div><dt>宿主机</dt><dd>${esc(i.host || "-")}</dd></div><div><dt>镜像</dt><dd>${esc(i.image.name)}</dd></div><div><dt>镜像来源</dt><dd>${esc(i.image.source_type)} / ${esc(i.image.sync_status)}</dd></div><div><dt>镜像位置</dt><dd>${esc(i.image.source_location || "-")}</dd></div><div><dt>创建时间</dt><dd>${fmtDate(i.created_at)}</dd></div></dl></div><div class="panel"><h3>最近审计</h3>${audit}</div></div><div class="panel" style="margin-top:18px"><h3>任务历史</h3><div class="resource-table-wrap"><table><thead><tr><th>任务</th><th>状态</th><th>尝试</th><th>错误</th><th>时间</th></tr></thead><tbody>${tasks}</tbody></table></div></div></section>`;
}

function metricChart(items, key, ceiling, color, unit) {
  const points = items
    .filter((item) => item[key] !== null && item[key] !== undefined && item[key] !== "")
    .map((item) => ({time: new Date(item.collected_at).getTime(), value: Number(item[key])}))
    .filter((item) => Number.isFinite(item.time) && Number.isFinite(item.value))
    .sort((left, right) => left.time - right.time);
  if (points.length < 2) return '<div class="monitoring-empty">数据采集中，连续收到至少两个心跳后显示曲线。</div>';
  const width = 620, height = 150, padding = 14;
  const minTime = points[0].time, maxTime = points[points.length - 1].time;
  const maxValue = Math.max(Number(ceiling || 0), ...points.map((point) => point.value), 1);
  const x = (time) => padding + ((time - minTime) / Math.max(1, maxTime - minTime)) * (width - padding * 2);
  const y = (value) => height - padding - (Math.min(maxValue, Math.max(0, value)) / maxValue) * (height - padding * 2);
  const line = points.map((point, index) => `${index ? "L" : "M"}${x(point.time).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ");
  const latest = points[points.length - 1].value;
  const average = points.reduce((sum, point) => sum + point.value, 0) / points.length;
  return `<div class="monitoring-chart"><div class="monitoring-value"><b>${latest.toFixed(1)}${unit}</b><span>24h 平均 ${average.toFixed(1)}${unit}</span></div><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="最近 24 小时监控曲线"><line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" class="chart-axis"></line><line x1="${padding}" y1="${padding}" x2="${width - padding}" y2="${padding}" class="chart-grid"></line><path d="${line}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"></path></svg><div class="monitoring-range"><span>${new Date(minTime).toLocaleTimeString("zh-CN", {hour: "2-digit", minute: "2-digit"})}</span><span>${new Date(maxTime).toLocaleTimeString("zh-CN", {hour: "2-digit", minute: "2-digit"})}</span></div></div>`;
}

function instanceMonitoring(items, resources) {
  const memoryLimit = Number(resources.memory_mb || 0);
  const latest = items.reduce((result, item) => {
    const current = new Date(item.collected_at).getTime();
    return Number.isFinite(current) && current > result.time ? {time: current, value: item.collected_at} : result;
  }, {time: 0, value: ""});
  return `<div class="panel monitoring-panel"><div class="section-heading"><div><h3>近 24 小时基础监控</h3><p>由宿主机 libvirt 每分钟采集；CPU 为规格总算力占比，内存优先使用 guest balloon 数据。</p></div><span class="source-sub">${latest.value ? `最近采样 ${fmtDate(latest.value)}` : "等待 Agent 指标"}</span></div><div class="monitoring-grid"><div><h4>CPU 使用率</h4>${metricChart(items, "cpu_usage_percent", 100, "#665cf6", "%")}</div><div><h4>内存使用</h4>${metricChart(items, "memory_usage_mb", memoryLimit, "#17a673", " MiB")}</div></div></div>`;
}

const auditActionLabels = {
  "policy.update": "修改平台策略",
  "instance.auto_renew.configure": "设置自动续期",
  "instance.auto_renew": "自动续期",
  "approval.delegation.configure": "设置审批代理",
  "approval.transfer": "转交审批",
  "history.archive": "生成历史归档",
  "history.purge": "清理已归档源记录",
  "history.archive.delete": "删除历史归档",
  "images.sync": "同步镜像到宿主机",
  "notifications.config": "修改群通知配置",
  "notifications.test": "发送群通知测试",
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
  "hosts.credentials.rotate": "轮换宿主机独立凭据",
  "hosts.credentials.revoke": "吊销宿主机独立凭据",
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
  "ip.probe.request": "重新探测隔离 IP",
  "network.probe_quarantined": "批量复核隔离 IP",
  "ip.probe.completed": "隔离 IP 探测完成",
  "instance.ip_recovery.request": "实例地址恢复复核",
  "instance.ip_recovery.completed": "实例地址恢复复核完成",
  "ip.address.quarantine": "隔离冲突 IP",
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
    ? result.items.map((item) => `<tr><td><b>${esc(auditActionLabels[item.action] || item.action)}</b><span class="source-sub">${esc(item.action)}</span></td><td><b>${esc(item.actor)}</b><span class="source-sub">${esc(item.source_ip || "-")}</span></td><td>${esc(auditResourceLabels[item.resource_type] || item.resource_type)}<span class="source-sub audit-resource">${esc(item.resource_id)}</span></td><td>${item.outcome === "SUCCESS" ? '<span class="pill ok">● 成功</span>' : '<span class="pill bad">● 失败</span>'}</td><td>${fmtDate(item.created_at)}</td><td><details class="audit-detail"><summary>查看</summary><pre>${esc(JSON.stringify(item.detail || {}, null, 2))}</pre>${item.user_agent ? `<small>${esc(item.user_agent)}</small>` : ""}</details></td></tr>`).join("")
    : '<tr><td colspan="6" class="empty">没有符合条件的操作记录</td></tr>';
  const availableActions = [...new Set([...Object.keys(auditActionLabels), ...(result.actions || [])])].sort((left, right) => (auditActionLabels[left] || left).localeCompare(auditActionLabels[right] || right, "zh-CN"));
  const actionOptions = availableActions.map((action) => `<option value="${esc(action)}" ${filters.action === action ? "selected" : ""}>${esc(auditActionLabels[action] || action)}</option>`).join("");
  const resourceOptions = (result.resource_types || []).map((type) => `<option value="${esc(type)}" ${filters.resourceType === type ? "selected" : ""}>${esc(auditResourceLabels[type] || type)}</option>`).join("");
  return `${lead("操作审计", "平台级操作流水，用于问题追溯与合规审查；系统事件默认隔离展示")}<div class="resource-table-wrap audit-table"><div class="list-toolbar table-toolbar audit-filters"><input type="search" class="list-search" aria-label="搜索操作人、动作或资源 ID" data-list-filter="audit" name="keyword" value="${esc(filters.keyword)}" placeholder="搜索操作人 / 动作 / 资源 ID"><div class="table-filter-group"><select aria-label="审计来源" data-list-filter="audit" name="scope"><option value="HUMAN" ${filters.scope === "HUMAN" ? "selected" : ""}>人工操作</option><option value="SYSTEM" ${filters.scope === "SYSTEM" ? "selected" : ""}>系统事件</option><option value="ALL" ${filters.scope === "ALL" ? "selected" : ""}>全部来源</option></select><select aria-label="审计动作" data-list-filter="audit" name="action"><option value="">全部动作</option>${actionOptions}</select><select aria-label="审计资源类型" data-list-filter="audit" name="resourceType"><option value="">全部资源</option>${resourceOptions}</select><select aria-label="审计结果" data-list-filter="audit" name="outcome"><option value="">全部结果</option><option value="SUCCESS" ${filters.outcome === "SUCCESS" ? "selected" : ""}>成功</option><option value="FAILED" ${filters.outcome === "FAILED" ? "selected" : ""}>失败</option></select><label class="audit-date">开始 <input type="date" data-list-filter="audit" name="dateFrom" value="${esc(filters.dateFrom)}"></label><label class="audit-date">结束 <input type="date" data-list-filter="audit" name="dateTo" value="${esc(filters.dateTo)}"></label><button class="btn mini" data-refresh-page>刷新</button><span>共 <b data-live-total>${esc(result.total)}</b> 条</span></div></div><section data-page-results><table><thead><tr><th>操作</th><th>操作人 / 来源 IP</th><th>资源</th><th>结果</th><th>时间</th><th>详情</th></tr></thead><tbody>${rows}</tbody></table><div class="pagination"><span>第 ${esc(result.page)} / ${pages} 页</span><div><button class="btn mini" data-list-page="audit" data-page="${numeric(result.page, 1) - 1}" ${result.page <= 1 ? "disabled" : ""}>上一页</button><button class="btn mini" data-list-page="audit" data-page="${numeric(result.page, 1) + 1}" ${result.page >= pages ? "disabled" : ""}>下一页</button></div></div></section></div>`;
}

function hostCredentialActionLabel(host) {
  if (host.credential_status === "MISSING") return "签发凭据";
  if (host.credential_status === "REVOKED") return "重新签发凭据";
  if (host.credential_status === "ACTIVE") return "轮换凭据";
  return "签发 / 轮换凭据";
}
function hostCredentialStatusHTML(host) {
  const labels = { MISSING: "未签发独立凭据", ACTIVE: "独立凭据有效", REVOKED: "凭据已吊销" };
  const known = Object.hasOwn(labels, host.credential_status);
  const generation = Number(host.credential_generation);
  const level = host.credential_status === "ACTIVE" ? "ok" : host.credential_status === "REVOKED" ? "bad" : "warn";
  return `<div class="host-credential-status"><span class="pill ${known ? level : ""}">${known ? labels[host.credential_status] : "凭据状态未上报"}</span>${Number.isSafeInteger(generation) && generation > 0 ? `<span class="source-sub">代次 ${generation}</span>` : ""}${host.credential_updated_at ? `<span class="source-sub">更新于 ${esc(fmtDate(host.credential_updated_at))}</span>` : ""}</div>`;
}
async function hosts() {
  const x = await api("/hosts");
  return `${lead("宿主机", "Agent 上报硬件安全上限，管理员同时配置 CPU、内存和磁盘调度额度", '<button class="btn" data-refresh-page>刷新宿主状态</button>')}<section data-page-results><div class="host-grid wide">${
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
            return `<div class="quota-line"><span>${label}</span><div class="capacity"><span style="width:${percent}%"></span></div><b>${esc(used)} / ${esc(quota)} / ${esc(limit)} ${unit}</b></div>`;
          })
          .join(
            "",
          )}<dl><div><dt>管理 IP</dt><dd>${esc(h.management_ip || "未上报")}</dd></div><div><dt>最近心跳</dt><dd>${fmtDate(h.last_heartbeat_at)}</dd></div><div><dt>发现 / 外部虚拟机</dt><dd>${esc(h.discovered_instances || 0)} / ${esc(h.external_instances || 0)} 台</dd></div><div><dt>libvirt</dt><dd>${esc(facts.libvirt_version || "-")}</dd></div><div><dt>QEMU</dt><dd>${esc(facts.hypervisor_version || "-")}</dd></div></dl>${hostCredentialStatusHTML(h)}<div class="form-actions">${state.currentUser?.role === "ADMIN" ? `<button class="btn host-credential-action" data-host-credentials='${esc(JSON.stringify({id: h.id, name: h.name, management_ip: h.management_ip, credential_status: h.credential_status, credential_generation: h.credential_generation}))}'>${hostCredentialActionLabel(h)}</button>` : ""}<button class="btn" data-host-quota='${esc(JSON.stringify(h))}'>配置调度额度</button><button class="btn" data-host="${esc(h.id)}" data-status="${h.status === "CORDONED" ? "ACTIVE" : "CORDONED"}">${h.status === "CORDONED" ? "恢复调度" : "暂停调度"}</button><button class="btn danger" data-delete-host="${esc(h.id)}" data-name="${esc(h.name)}">删除纳管</button></div></div>`;
      })
      .join("") || '<div class="panel empty">暂无已注册 Agent</div>'
  }</div></section>`;
}

async function images() {
  const x = await api("/images?all=1");
  return `${lead("镜像管理", "统一管理宿主机本地镜像与 HTTP(S) / OSS 远程镜像", '<button class="btn primary" data-new-image>＋ 新增镜像</button>')}<div class="management-toolbar"><span class="summary">共 ${x.items.length} 个镜像，远程镜像在校验和同步完成前不可启用</span></div><section data-page-results><div class="resource-table-wrap sticky-actions"><table><thead><tr><th>镜像</th><th>来源</th><th>完整路径 / 远程地址</th><th>系统</th><th>宿主机就绪 / 同步</th><th>状态</th><th>操作</th></tr></thead><tbody>${x.items.map((i) => `<tr><td><b>${esc(i.name)}</b><span class="source-sub">ID: ${esc(i.id)}</span></td><td><span class="type-badge ${i.source_type === "remote" ? "remote" : ""}">${i.source_type === "remote" ? "远程镜像" : "本地镜像"}</span></td><td class="source-cell"><span class="source-main">${esc(i.source_location || "未配置")}</span><span class="source-sub">${i.source_type === "remote" ? `本地缓存：${esc(i.file_name || "-")}` : `镜像文件：${esc(i.file_name || "-")}`}</span>${i.checksum ? `<span class="source-sub">SHA-256：${esc(i.checksum)}</span>` : ""}</td><td>${esc(i.os_family)} ${esc(i.version)}</td><td>${status(i.sync_status)}${imageReadinessHTML(i)}</td><td>${i.enabled ? status("ACTIVE") : '<span class="pill">${i.desired_enabled ? "待宿主机就绪" : "已停用"}</span>'}</td><td><div class="row-actions"><button class="btn mini" data-edit-image='${esc(JSON.stringify(i))}'>编辑</button>${i.source_type === "remote" ? `<button class="btn mini" data-image-sync='${esc(JSON.stringify(i))}'>同步到宿主机</button>` : ""}<button class="btn mini" data-toggle-image="${esc(i.id)}" data-enabled="${!(i.desired_enabled ?? i.enabled)}">${(i.desired_enabled ?? i.enabled) ? "停用" : "启用"}</button><button class="btn mini danger" data-delete-image="${esc(i.id)}" data-name="${esc(i.name)}">删除</button></div></td></tr>`).join("")}</tbody></table></div></section>`;
}
async function flavors() {
  const [x, summary] = await Promise.all([
    api("/flavors?all=1"),
    api("/summary"),
  ]);
  const usage = new Map(x.items.map((flavor) => [flavor.id, {running: numeric(flavor.usage?.running), retained: numeric(flavor.usage?.retained), reserved: numeric(flavor.usage?.memory_mb)}]));
  return `${lead("资源规格", "固定规格定义，用户申请时选择", '<button class="btn primary" data-new-flavor>＋ 新增规格</button>')}<div class="flavor-admin-grid">${x.items.map((f) => `<div class="flavor-admin-card"><div class="flavor-admin-head"><div><h3>${esc(f.name)}</h3><p>${esc(f.cpu)} vCPU · ${gb(f.memory_mb)} · ${esc(f.disk_gb)} GiB</p></div>${f.enabled ? status("ACTIVE") : '<span class="pill">已停用</span>'}</div><div class="flavor-admin-actions"><button class="btn mini" data-edit-flavor='${esc(JSON.stringify(f))}'>编辑</button><button class="btn mini" data-toggle-flavor="${esc(f.id)}" data-name="${esc(f.name)}" data-cpu="${esc(f.cpu)}" data-memory="${esc(f.memory_mb)}" data-disk="${esc(f.disk_gb)}" data-enabled="${!f.enabled}">${f.enabled ? "停用" : "启用"}</button><button class="btn mini danger" data-delete-flavor="${esc(f.id)}" data-name="${esc(f.name)}">删除</button></div></div>`).join("")}</div><div class="resource-table-wrap flavor-usage"><div class="table-caption">各规格当前占用</div><table><thead><tr><th>规格</th><th>运行中</th><th>保留中</th><th>内存预占</th><th>占比</th></tr></thead><tbody>${x.items.map((f) => { const item = usage.get(f.id); const ratio = summary.allocatable_memory_mb ? Math.min(100, Math.round((item.reserved / summary.allocatable_memory_mb) * 100)) : 0; return `<tr><td><b>${esc(f.name)}</b><span class="source-sub">${esc(f.cpu)} vCPU · ${gb(f.memory_mb)} · ${esc(f.disk_gb)} GiB</span></td><td>${item.running}</td><td>${item.retained}</td><td>${gb(item.reserved)}</td><td><div class="usage-ratio"><div class="capacity"><span style="width:${ratio}%"></span></div><small>${ratio}%</small></div></td></tr>`; }).join("")}</tbody></table></div>`;
}
function canProbeIP(ip) {
  return state.currentUser?.role === "ADMIN" && ip.status === "QUARANTINED" && !ip.instance_id && !ip.probe_pending && ip.last_probe_status !== "PENDING";
}
function ipProbeStatusHTML(ip) {
  if (ip.probe_pending || ip.last_probe_status === "PENDING") return '<span class="pill warn">复核中</span>';
  const labels = {FREE: "探测空闲", IN_USE: "检测到占用", ERROR: "探测失败"};
  const text = labels[ip.last_probe_status];
  if (!text) return '<span class="source-sub">尚无探测结果</span>';
  return `<span class="pill ${ip.last_probe_status === "FREE" ? "ok" : "bad"}">${text}</span>`;
}
function ipProbeHost(ip) {
  const value = ip.last_probe_host;
  return typeof value === "string" ? value : value?.name || value?.host_name || value?.host_id || "";
}
function ipProbeRow(ip) {
  const metadata = esc(JSON.stringify({id: ip.id, address: ip.address, status: ip.status, instance_id: ip.instance_id, probe_pending: ip.probe_pending}));
  const actions = canProbeIP(ip)
    ? `<div class="row-actions"><button class="btn mini" data-ip-probe='${metadata}'>重新探测</button><button class="btn mini" data-ip-probe-release='${metadata}'>探测并解除隔离</button></div>`
    : ip.probe_pending ? '<span class="source-sub">等待复核结果</span>' : ip.instance_id ? '<span class="source-sub">实例关联地址不可解除</span>' : "—";
  return `<tr data-ip-address="${esc(ip.id)}" tabindex="-1"><td><b>${esc(ip.address)}</b></td><td>${esc(ip.instance_name || "—")}<span class="source-sub">${esc(ip.owner || "—")}</span></td><td>${ip.lifecycle_status === "RETAINED" ? '<span class="pill warn">保留中</span>' : status(ip.status)}</td><td>${esc(fmtDate(ip.allocated_at || ip.reserved_at))}</td><td>${ipProbeStatusHTML(ip)}<span class="source-sub">${esc(fmtDate(ip.last_probe_at))}</span>${ipProbeHost(ip) ? `<span class="source-sub">宿主：${esc(ipProbeHost(ip))}</span>` : ""}</td><td class="network-probe-message">${ip.last_probe_message ? esc(localizeError(ip.last_probe_message)) : "—"}</td><td>${actions}</td></tr>`;
}
async function requestIPProbe(ip, releaseIfFree = false) {
  if (state.currentUser?.role !== "ADMIN") throw new Error("仅管理员可以复核隔离 IP");
  if (!canProbeIP(ip)) throw new Error("只能复核未关联实例且没有探测任务的隔离 IP；已分配或保留地址不能解除");
  const key = `${sessionEpoch}:ip:${ip.id}`;
  if (pendingIPProbeRequests.has(key)) throw new Error("这个 IP 已提交探测，请等待本次结果");
  pendingIPProbeRequests.add(key);
  try {
    return await api(`/ip-addresses/${pathID(ip.id)}/probe`, {method: "POST", body: JSON.stringify({release_if_free: Boolean(releaseIfFree)})});
  } finally { pendingIPProbeRequests.delete(key); }
}
async function requestNetworkProbe(network, limit = 32) {
  if (state.currentUser?.role !== "ADMIN") throw new Error("仅管理员可以批量复核隔离 IP");
  if (!Number.isInteger(limit) || limit < 1 || limit > 64) throw new Error("每轮探测上限必须为 1 至 64 的整数");
  const key = `${sessionEpoch}:network:${network.id}`;
  if (pendingIPProbeRequests.has(key)) throw new Error("本网络的复核请求正在提交，请勿重复操作");
  pendingIPProbeRequests.add(key);
  try {
    return await api(`/networks/${pathID(network.id)}/probe-quarantined`, {method: "POST", body: JSON.stringify({release_if_free: true, limit})});
  } finally { pendingIPProbeRequests.delete(key); }
}
function notifyIPProbeSubmitted(result, batch = false) {
  let message = typeof result?.message === "string" && result.message.trim()
    ? localizeError(result.message)
    : batch ? "批量复核任务已提交，本轮有数量上限。仅探测成功且确认未占用的隔离地址会恢复空闲，其余仍保持隔离。" : "复核任务已提交，结果将自动更新；此时尚未解除隔离。";
  if (batch) message += ` 本轮排队 ${numeric(result?.queued)} 条，跳过 ${numeric(result?.skipped)} 条，单轮上限 ${numeric(result?.limit, 32)} 条；尚未复核或异常待查 ${numeric(result?.remaining)} 条，已确认占用 ${numeric(result?.confirmed_in_use)} 条仍保持隔离。排队不等于已解除，未复核地址需完成本轮后继续检查。`;
  toast(message, "info", {title: batch ? "隔离 IP 批量复核" : result?.already_pending ? "已有 IP 复核任务" : "IP 复核已提交", duration: 10000});
}
function openIPProbeReleaseModal(ip) {
  if (!canProbeIP(ip)) return toast("仅管理员可复核未关联实例的隔离 IP，请刷新地址状态后重试。", "error");
  showFormModal({
    title: `探测并解除隔离：${ip.address}`,
    description: "平台将从可用宿主异步探测这个 IP。只有探测成功、确认未被占用且仍无实例关联时才解除隔离；占用、探测异常或条件变化时保持隔离，不能强制清空。",
    content: '<div class="notice">请先确认此地址范围已从外部 DHCP 动态池排除。平台保留 IP 不能阻止外部 DHCP 把地址发给其他设备。</div>',
    submitText: "提交探测并安全解除",
    onSubmit: async (_data, form) => {
      const result = await requestIPProbe(ip, true);
      notifyIPProbeSubmitted(result);
      if (form.isConnected && $("#modal-root").querySelector("#modal-form") === form) closeModal(true);
      await refreshPageData(true);
    },
  });
}
function openNetworkProbeModal(network) {
  if (state.currentUser?.role !== "ADMIN") return toast("仅管理员可以批量复核隔离 IP。", "error");
  showFormModal({
    title: `批量复核隔离 IP：${network.name}`,
    description: "只复核本网络未关联实例的隔离地址；默认每轮 32 个，最多 64 个，已分配和保留期 IP 不会处理。只有探测成功且未占用的地址会解除隔离，失败或仍被占用的地址保持隔离。",
    content: `<div class="notice">当前隔离 ${numeric(network.quarantined)} 个。任务异步执行，提交后在地址表查看结果；超过单轮上限的地址需完成本轮后再复核。先从外部 DHCP 动态池排除平台地址范围。</div>${field("limit", "本轮最多探测地址数", 32, {type: "number", min: 1, max: 64})}`,
    submitText: "提交批量安全复核",
    onSubmit: async (data, form) => {
      const result = await requestNetworkProbe(network, Number(data.get("limit")));
      notifyIPProbeSubmitted(result, true);
      if (form.isConnected && $("#modal-root").querySelector("#modal-form") === form) closeModal(true);
      await refreshPageData(true);
    },
  });
}
async function network() {
  const networks = await api("/networks");
  const selected = networks.items.find((item) => item.id === state.selectedNetworkID) || networks.items[0];
  if (selected) state.selectedNetworkID = selected.id;
  const ips = selected ? await api(listURL("/ip-addresses", "ips", {network_id: selected.id})) : {items: [], total: 0, page: 1, page_size: 20};
  const cards = networks.items.map((item) => '<div class="host network-card ' + (selected?.id === item.id ? "selected" : "") + '" data-select-network="' + esc(item.id) + '"><div class="host-head"><div><h3>' + esc(item.name) + '</h3><span class="source-sub">' + esc(item.cidr) + '</span></div>' + (item.enabled ? status("ACTIVE") : '<span class="pill">已停用</span>') + '</div><dl><div><dt>IP 范围</dt><dd>' + esc(item.ip_range_start || "-") + ' – ' + esc(item.ip_range_end || "-") + '</dd></div><div><dt>网关 / Bridge</dt><dd>' + esc(item.gateway) + ' / ' + esc(item.bridge) + '</dd></div><div><dt>空闲 / 隔离</dt><dd>' + numeric(item.free) + ' / ' + numeric(item.quarantined) + ' 个</dd></div><div><dt>已分配 / 总数</dt><dd>' + numeric(item.allocated) + ' / ' + numeric(item.total) + '</dd></div></dl><div class="form-actions"><button class="btn primary" data-edit-network="' + esc(JSON.stringify(item)) + '">编辑网络与 IP 范围</button>' + (state.currentUser?.role === "ADMIN" ? '<button class="btn" data-network-probe="' + esc(JSON.stringify(item)) + '" ' + (numeric(item.quarantined) ? "" : "disabled") + '>批量复核隔离 IP</button>' : "") + '<button class="btn danger" data-delete-network="' + esc(item.id) + '" data-name="' + esc(item.name) + '">删除网络</button></div></div>').join("");
  if (!selected) return lead("网络 IP", "维护网络和唯一地址范围", '<button class="btn primary" data-new-network>＋ 新增网络</button>') + '<div class="panel empty">尚未定义网络，请先创建。</div>';
  const rows = ips.items.map(ipProbeRow).join("");
  const controls = filterSelect("ips", "status", "全部 IP 状态", ["FREE", "ALLOCATED", "RESERVED", "QUARANTINED"].map((key) => [key, statusLabels[key]]));
  return lead("网络 IP", "按网络查看地址范围，服务端筛选和分页", '<button class="btn primary" data-new-network>＋ 新增网络</button>') + '<div class="host-grid network-grid" data-live-network-cards>' + cards + '</div><div class="notice network-probe-help">平台保留 IP 不能阻止外部 DHCP 分配同一地址。请从 DHCP 动态地址池排除平台范围；恢复或开机前仍会再次检查冲突。隔离不是实例占用，不会仅因手工复核请求就变为空闲。</div>' + listToolbar("ips", "搜索 IP、实例或使用人", controls) + '<section class="network-ip-results" data-page-results><div class="panel ip-pool-panel"><h3>' + esc(selected.name) + ' · 地址池</h3><p class="source-sub">' + esc(selected.ip_range_start || "-") + ' – ' + esc(selected.ip_range_end || "-") + '；筛选结果 ' + numeric(ips.total) + ' 个</p><div class="ip-grid">' + ips.items.map((ip) => '<span class="ip ' + (["FREE", "ALLOCATED", "RESERVED", "QUARANTINED"].includes(ip.status) ? ip.status.toLowerCase() : "unknown") + '" title="' + esc(ip.instance_name || statusLabels[ip.status] || ip.status) + '">' + esc(ip.address) + '<small>' + esc(ip.probe_pending ? "复核中" : statusLabels[ip.status] || ip.status) + '</small></span>').join("") + '</div></div><div class="resource-table-wrap allocated-table network-ip-table"><div class="table-caption">本页地址状态与最近探测</div><div class="table-scroll"><table><thead><tr><th>IP 地址</th><th>实例 / 使用人</th><th>地址状态</th><th>分配 / 预留时间</th><th>最近探测 / 宿主</th><th>探测说明</th><th>操作</th></tr></thead><tbody>' + (rows || '<tr><td colspan="7" class="empty">本页没有符合筛选的地址</td></tr>') + '</tbody></table></div></div>' + pagination("ips", ips) + '</section>';
}

async function usersPage() {
  const [result, ldap] = await Promise.all([api(listURL("/users", "users")), api("/ldap/status")]);
  const controls = filterSelect("users", "source", "全部来源", [["LOCAL", "平台创建"], ["LDAP", "LDAP"]]) + filterSelect("users", "role", "全部角色", [["ADMIN", "管理员"], ["USER", "普通用户"]]) + filterSelect("users", "status", "全部状态", [["ENABLED", "正常"], ["DISABLED", "已停用"], ["DIRECTORY_UNAVAILABLE", "LDAP 目录不可用"], ["MUST_CHANGE_PASSWORD", "首次需改密"]]);
  const actions = '<div class="row-actions"><button class="btn" data-go-ldap>LDAP 配置</button>' + (ldap.enabled ? '<button class="btn" data-sync-ldap="users">同步 LDAP</button>' : "") + '<button class="btn" data-export="users">导出筛选结果 CSV</button><button class="btn primary" data-new-user>＋ 创建本地用户</button></div>';
  const rows = result.items.map((user) => "<tr><td><b>" + esc(user.display_name || user.username) + "</b><span class='source-sub'>" + esc(user.username) + (user.email ? " · " + esc(user.email) : "") + "</span></td><td>" + (user.source === "LDAP" ? "LDAP" : "平台创建") + "</td><td>" + (user.role === "ADMIN" ? "管理员" : "普通用户") + "</td><td>" + userStatus(user) + "</td><td>" + fmtDate(user.last_login_at) + "</td><td><div class='row-actions'><button class='btn mini' data-edit-user='" + esc(JSON.stringify(user)) + "'>编辑</button>" + (user.source === "LOCAL" ? "<button class='btn mini' data-reset-user='" + esc(JSON.stringify(user)) + "'>重置密码</button>" : "") + "<button class='btn mini danger' data-delete-user='" + esc(user.id) + "' data-name='" + esc(user.username) + "'>删除</button></div></td></tr>").join("");
  return lead("用户管理", "平台停用与 LDAP 目录状态分别展示，服务端搜索和分页", actions) + listToolbar("users", "搜索用户名、显示名称或邮箱", controls) + '<section data-page-results><div class="resource-table-wrap user-table"><table><thead><tr><th>用户</th><th>来源</th><th>角色</th><th>状态</th><th>最近登录</th><th>操作</th></tr></thead><tbody>' + (rows || '<tr><td colspan="6" class="empty">没有符合条件的用户</td></tr>') + '</tbody></table>' + pagination("users", result) + '</div></section>';
}

function ldapTransportInsecure(url, startTLS) { return /^ldap:\/\//i.test(String(url || "").trim()) && !startTLS; }
function ldapTransportWarning(config) {
  return `<div class="ldap-transport-warning" id="ldap-transport-warning" role="status" ${ldapTransportInsecure(config.url, config.start_tls) ? "" : "hidden"}>当前 LDAP 连接未启用传输加密，服务账号绑定凭据和目录登录密码可能以明文在网络中传输。建议启用 StartTLS，或改用 ldaps:// 地址。</div>`;
}
function bindLDAPTransportWarning(form) {
  const update = () => {
    const warning = form.querySelector("#ldap-transport-warning");
    if (warning) warning.hidden = !ldapTransportInsecure(form.elements.url.value, form.elements.start_tls.checked);
  };
  form.elements.url.addEventListener("input", update);
  form.elements.start_tls.addEventListener("change", update);
  update();
}
function ldapFields(config) {
  return `<div class="ldap-section"><div class="ldap-section-head"><span>01</span><div><h3>连接信息</h3><p>配置目录服务地址和查询账号</p></div></div><div class="form-grid">${field("url", "LDAP 地址", config.url || "", { full: true, placeholder: "ldaps://ldap.example.com:636" })}${field("base_dn", "Base DN", config.base_dn || "", { full: true, placeholder: "dc=example,dc=com" })}${field("bind_dn", "服务账号 DN", config.bind_dn || "", { full: true, required: false, placeholder: "cn=vmp-reader,ou=service,dc=example,dc=com" })}${field("bind_password", "服务账号密码", "", { type: "password", full: true, required: false, autocomplete: "new-password", placeholder: config.has_bind_password ? "已加密保存，留空不修改" : "匿名查询可留空" })}<label class="ldap-check"><input name="start_tls" type="checkbox" ${config.start_tls ? "checked" : ""}><span><b>启用 StartTLS</b><small>仅用于 ldap:// 连接</small></span></label><label class="ldap-check"><input name="clear_bind_password" type="checkbox"><span><b>清除绑定密码</b><small>下次保存时清除已有密文</small></span></label></div></div><div class="ldap-section"><div class="ldap-section-head"><span>02</span><div><h3>用户查询规则</h3><p>定义登录查找和批量同步范围</p></div></div><div class="form-grid">${field("login_filter", "登录过滤器", config.login_filter || "(uid=%s)", { full: true, hint: "必须包含 %s 用户名占位符" })}${field("sync_filter", "同步过滤器", config.sync_filter || "(objectClass=person)", { full: true })}</div></div><div class="ldap-section"><div class="ldap-section-head"><span>03</span><div><h3>属性映射</h3><p>将 LDAP 属性映射到平台用户字段</p></div></div><div class="form-grid ldap-attributes">${field("username_attribute", "用户名属性", config.username_attribute || "uid")}${field("display_name_attribute", "显示名称属性", config.display_name_attribute || "cn")}${field("email_attribute", "邮箱属性", config.email_attribute || "mail")}</div></div>`;
}

async function ldapPage() {
  const [config, users] = await Promise.all([
    api("/ldap/status"),
    api("/users?source=LDAP&page_size=1"),
  ]);
  const stateText = config.enabled
    ? "LDAP 登录与同步已启用"
    : config.configured
      ? "配置已保存，当前未启用"
      : "尚未配置 LDAP 目录";
  const syncedUsers = numeric(users.total, users.items.filter((user) => user.source === "LDAP").length);
  return `${lead("LDAP 配置", "连接企业目录服务，同步用户并支持目录密码登录", `<div class="row-actions"><span class="pill ${config.enabled ? "ok" : ""}">● ${config.enabled ? "已启用" : "未启用"}</span><button class="btn" data-test-ldap ${config.enabled ? "" : "disabled"}>○ 测试连接</button></div>`)}<form class="ldap-config-page" id="ldap-config-form"><div class="ldap-config-main">${ldapTransportWarning(config)}${ldapFields(config)}<div class="ldap-form-actions"><button class="btn" type="button" data-go="ldap">取消</button><button class="btn primary" type="submit">保存配置</button></div></div><div class="ldap-config-side"><div class="ldap-side-card"><h3>连接状态</h3><span class="source-sub">通过“测试连接”验证当前配置</span><dl><div><dt>功能状态</dt><dd><span class="pill ${config.enabled ? "ok" : ""}">● ${config.enabled ? "已启用" : "未启用"}</span></dd></div><div><dt>配置状态</dt><dd>${config.configured ? "已保存" : "未配置"}</dd></div><div><dt>同步用户数</dt><dd><b>${syncedUsers}</b></dd></div></dl>${config.enabled ? '<button class="btn ldap-side-action" type="button" data-sync-ldap>○ 立即同步 LDAP</button>' : '<button class="btn ldap-side-action" type="button" disabled>○ 立即同步 LDAP</button>'}</div><div class="ldap-side-card ldap-enable-card"><span class="side-label">功能开关</span><label class="ldap-toggle"><input name="enabled" type="checkbox" ${config.requested_enabled ? "checked" : ""}><span></span><b>启用 LDAP 登录</b></label><p>启用后，已同步用户可从 LDAP 入口登录。</p><div class="ldap-security"><b>密码安全</b><p>服务账号密码使用 AES-GCM 加密，页面不会回显明文。</p><span>${config.has_bind_password ? "● 已保存绑定密码" : "○ 未保存绑定密码"}</span></div></div><div class="ldap-side-card ldap-tips"><h3>配置提示</h3><ul><li>建议使用只读服务账号，权限最小化</li><li>密码加密存储，接口不会回显明文</li><li>同步为异步任务，大量用户需数分钟</li><li>目录用户使用 LDAP 密码登录平台</li></ul></div></div></form>`;
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
      await api(`/users/${pathID(user.id)}`, {
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
      await api(`/users/${pathID(user.id)}/password`, {
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
  notifications: notificationsPage,
  policy: policyPage,
};
async function render(page = state.page) {
  setMobileNavigation(false);
  if (state.hostCredentialRequestPending) { hostCredentialRequestNotice(); return; }
  if (state.credentialsPending || state.credentialModalPending) {
    confirmCredentialDiscard(() => render(page));
    return;
  }
  renderSequence += 1;
  state.partialSequence += 1;
  state.lastCredentials = null;
  clearPageWork();
  closeModal(true);
  const epoch = sessionEpoch;
  const sequence = renderSequence;
  const isCurrent = () => epoch === sessionEpoch && sequence === renderSequence;
  state.rendering = true;
  if (!pages[page]) page = "dashboard";
  if (
    state.currentUser?.role !== "ADMIN" &&
    !["dashboard", "apply", "my-instances", "instance-detail", "requests"].includes(page)
  )
    page = "dashboard";
  state.page = page;
  const route =
    page === "instance-detail" && state.detailInstanceID
      ? `#/${page}/${pathID(state.detailInstanceID)}`
      : `#/${page}`;
  if (window.location.hash !== route)
    window.history.replaceState(null, "", route);
  $("#page-title").textContent =
    page === "dashboard" && state.currentUser?.role !== "ADMIN"
      ? "我的概览"
      : labels[page];
  document
    .querySelectorAll("nav button")
    .forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  $("#content").innerHTML = '<div class="panel empty">正在加载…</div>';
  try {
    const content = await pages[page]();
    if (!isCurrent()) return;
    $("#content").innerHTML = content;
    $("#api-state").textContent = "服务正常";
    $("#api-state").className = "pill ok";
    bind();
    if (state.currentUser?.role === "ADMIN" && ["dashboard", "approvals"].includes(page)) {
      const notify = Boolean(state.pendingApprovalNoticeRequested);
      state.pendingApprovalNoticeRequested = false;
      updateApprovalIndicator(notify);
    }
  } catch (e) {
    if (!isCurrent() || isCancelledContext(e)) return;
    if (e.status === 401) {
      showLogin();
      return;
    }
    $("#content").innerHTML =
      `<div class="panel empty"><b>加载失败</b><br>${esc(e.message)}</div>`;
    $("#api-state").textContent = "服务异常";
    $("#api-state").className = "pill bad";
  } finally {
    if (isCurrent()) state.rendering = false;
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
      await api(existing ? `/flavors/${pathID(existing.id)}` : "/flavors", {
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
    content: `<div class="modal-grid">${field("id", "镜像 ID", existing?.id || "", { placeholder: "例如 ubuntu-2404", readonly: Boolean(existing), hint: "创建后不可修改" })}${field("name", "镜像名称", existing?.name || "", { placeholder: "例如 Ubuntu Server 24.04 LTS" })}${field("os_family", "操作系统", existing?.os_family || "ubuntu", { placeholder: "ubuntu / rocky / debian" })}${field("version", "系统版本", existing?.version || "", { placeholder: "例如 24.04" })}<div class="field full"><label>镜像来源</label><div class="source-switch"><label><input type="radio" name="source_type" value="local" ${sourceType === "local" ? "checked" : ""}> <b>本地镜像</b><span class="source-sub">已存放在宿主机镜像目录</span></label><label><input type="radio" name="source_type" value="remote" ${sourceType === "remote" ? "checked" : ""}> <b>远程镜像</b><span class="source-sub">HTTP(S) / OSS 对象地址</span></label></div></div><div class="field full" data-local-fields>${field("local_path", "本地镜像路径", sourceType === "local" ? existing?.source_location || "" : "", { full: true, placeholder: "/data/cloud-init/images/ubuntu.qcow2", hint: "绝对路径或 KVM_IMAGE_ROOT 下的相对路径" })}</div><div class="field full" data-remote-fields>${field("remote_url", "远程镜像地址", sourceType === "remote" ? existing?.source_location || "" : "", { full: true, placeholder: "https://oss.example.com/images/ubuntu.qcow2" })}<div class="modal-grid">${field("checksum", "SHA-256", existing?.checksum || "", { placeholder: "64 位十六进制校验值" })}${field("file_name", "本地缓存文件名", existing?.file_name || "", { placeholder: "ubuntu-24.04.qcow2" })}</div></div><div class="field full"><label><input name="enabled" type="checkbox" ${(existing?.desired_enabled ?? existing?.enabled) ? "checked" : ""}> 镜像就绪后允许用户申请</label><span class="input-hint">远程镜像只有同步状态为 READY 时才能启用。</span></div></div>`,
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
      await api(existing ? `/images/${pathID(existing.id)}` : "/images", {
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
        existing ? `/networks/${pathID(existing.id)}` : "/networks",
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
    content: `<div class="quota-overview"><div><span>CPU：已用 / Agent 上限</span><b>${esc(host.reserved_cpu)} / ${esc(host.agent_allocatable_cpu)} C</b></div><div><span>内存：已用 / Agent 上限</span><b>${gb(host.reserved_memory_mb)} / ${gb(host.agent_allocatable_memory_mb)}</b></div><div><span>磁盘：已用 / Agent 上限</span><b>${esc(host.reserved_disk_gb)} / ${esc(host.agent_allocatable_disk_gb)} GB</b></div></div><div class="modal-grid">${field("cpu", "CPU 调度额度（核）", host.allocatable_cpu, { type: "number", min: host.reserved_cpu, max: host.agent_allocatable_cpu })}${field("memory_mb", "内存调度额度（MB）", host.allocatable_memory_mb, { type: "number", min: host.reserved_memory_mb, max: host.agent_allocatable_memory_mb, step: 256 })}${field("disk_gb", "磁盘调度额度（GB）", host.allocatable_disk_gb, { type: "number", min: host.reserved_disk_gb, max: host.agent_allocatable_disk_gb })}<div class="notice">实际可调度值始终取“管理员额度”和“Agent 上限”的较小值。</div></div>`,
    submitText: "保存三项配额",
    onSubmit: async (formData) => {
      await api(`/hosts/${pathID(host.id)}/quota`, {
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

function hostCredentialTargetHTML(host) {
  return `<dl class="host-credential-target detail-list"><div><dt>目标宿主</dt><dd>${esc(host.name || "未命名宿主")}</dd></div><div><dt>宿主 UUID</dt><dd><code>${esc(host.id)}</code></dd></div><div><dt>管理 IP</dt><dd>${esc(host.management_ip || "未上报，请先核对目标宿主")}</dd></div></dl>`;
}
function hostCredentialEnv(secret) {
  return `AGENT_HOST_ID=${secret.hostID}\nAGENT_RUNTIME_TOKEN=${secret.runtimeToken}`;
}
function openHostCredentialResult(host, result) {
  clearHostCredentialSecret();
  closeAlert();
  const secret = { hostID: result.host_id, runtimeToken: result.runtime_token };
  hostCredentialSecret = secret;
  const form = showFormModal({
    title: "宿主凭据已签发",
    description: "旧凭据已立即失效。新令牌只在本次显示，请保存到目标 Agent，勿发群聊或截图。",
    content: `${hostCredentialTargetHTML(host)}<div class="credential-warning">宿主不会自动恢复调度。将下方两项导入本台 Agent 的 agent.env，保护文件为 0600；仍以只读模式启动，核对原 UUID、管理 IP 和新心跳，再按部署手册清空一次性导入字段。不要复制到其他宿主。</div><div class="credential-grid"><div class="full credential-secret"><span>宿主 UUID</span><code data-host-credential-sensitive>${esc(secret.hostID)}</code><button class="btn mini" type="button" data-copy-host-credential="id">复制 UUID</button></div><div class="full credential-secret host-credential-secret"><span>一次性 Agent 令牌</span><code data-host-credential-sensitive>${esc(secret.runtimeToken)}</code><button class="btn mini" type="button" data-copy-host-credential="token">复制令牌</button></div><div class="full host-credential-env"><span>agent.env 两行导入片段</span><pre data-host-credential-sensitive>${esc(hostCredentialEnv(secret))}</pre><button class="btn mini" type="button" data-copy-host-credential="env">复制 agent.env 片段</button></div></div><label class="credential-confirm"><input type="checkbox" data-host-credentials-saved><span>我已保存目标宿主 UUID 和新令牌，并了解旧凭据已失效</span></label>`,
    submitText: "我已保存并关闭",
    onSubmit: async () => {
      if (!form.querySelector("[data-host-credentials-saved]").checked) throw new Error("请先保存本次宿主凭据并勾选确认");
      closeModal(true);
      toast("新凭据已签发，旧值已失效。请更新目标 Agent 并确认新心跳；宿主仍保持暂停调度。", "warning", {title: "请完成 Agent 凭据导入", duration: 10000});
    },
  });
  form.classList.add("host-credential-modal");
  state.credentialModalPending = true;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  form.querySelector("[data-host-credentials-saved]").onchange = (event) => {
    submit.disabled = !event.target.checked;
    state.credentialModalPending = !event.target.checked;
  };
  const epoch = sessionEpoch;
  form.querySelectorAll("[data-copy-host-credential]").forEach((button) => {
    button.onclick = async () => {
      if (hostCredentialSecret !== secret || !secret.runtimeToken || epoch !== sessionEpoch || !form.isConnected) throw cancelledContext();
      const kind = button.dataset.copyHostCredential;
      await copyText(kind === "id" ? secret.hostID : kind === "token" ? secret.runtimeToken : hostCredentialEnv(secret));
      if (hostCredentialSecret === secret && epoch === sessionEpoch && form.isConnected) toast(kind === "id" ? "宿主 UUID 已复制" : kind === "token" ? "Agent 令牌已复制，请安全保存" : "agent.env 导入片段已复制，请仅用于目标宿主");
    };
  });
  protectAsyncButtons();
  return form;
}
function openHostCredentialModal(host) {
  if (state.currentUser?.role !== "ADMIN") {
    toast("仅管理员可以签发宿主机凭据。", "error");
    return;
  }
  const form = showFormModal({
    title: `${hostCredentialActionLabel(host)}：${host.name || "目标宿主"}`,
    description: "只改变这一台宿主的身份凭据并暂停调度，不会操作虚拟机。旧值立即失效，不能找回。",
    content: `${hostCredentialTargetHTML(host)}${hostCredentialStatusHTML(host)}<div class="credential-warning">旧凭据立即失效。先核对 UUID、名称和管理 IP，排空任务并停止目标 Agent。签发后必须更新这一台 Agent 的凭据；丢失新令牌只能再次签发。宿主保持暂停调度，不会自动恢复写模式。</div><div class="host-credential-checks"><label class="credential-confirm"><input type="checkbox" name="confirmed_host_ready" required><span>我已停止这台宿主的 Agent，确认没有正在执行的任务</span></label></div>`,
    submitText: "确认签发新凭据",
    onSubmit: async (_data, currentForm) => {
      if (state.currentUser?.role !== "ADMIN") throw new Error("当前账号无权签发宿主凭据");
      if (!currentForm.isConnected || $("#modal-root").querySelector("#modal-form") !== currentForm) throw cancelledContext();
      if (!currentForm.elements.confirmed_host_ready?.checked) throw new Error("请确认目标 Agent 已停止，且没有正在执行的任务");
      if (state.hostCredentialRequestPending) throw new Error("凭据签发正在进行，请勿重复提交");
      const epoch = sessionEpoch, sequence = renderSequence;
      state.hostCredentialRequestPending = true;
      let result;
      try {
        result = await api(`/hosts/${pathID(host.id)}/credentials/rotate`, {method: "POST", body: "{}"});
        if (!result || result.host_id !== host.id || typeof result.runtime_token !== "string" || !/^[A-Za-z0-9_-]{32,512}$/.test(result.runtime_token)) {
          throw new Error("签发响应不完整，不能确认新凭据。旧值可能已失效，请保持 Agent 停止和宿主暂停调度，联系管理员核对后再重新签发。");
        }
        if (epoch !== sessionEpoch || sequence !== renderSequence || !currentForm.isConnected) throw cancelledContext();
        openHostCredentialResult(host, result);
      } catch (error) {
        if (error.status === 401) showLogin();
        if (!isCancelledContext(error) && !(error instanceof ApiError && error.status >= 400)) {
          throw new Error("未能确认本次凭据签发结果，旧值可能已失效。请保持目标 Agent 停止和宿主暂停调度，核对后再重新签发；不要连续重复点击。");
        }
        throw error;
      } finally {
        // 响应仅用于本次弹窗；不放入全局 state、存储、日志或 HTML 数据属性。
        if (result && typeof result === "object") result.runtime_token = "";
        if (epoch === sessionEpoch && sequence === renderSequence) state.hostCredentialRequestPending = false;
      }
    },
  });
  form.classList.add("host-credential-modal");
}

function bindManagement() {
  document.querySelectorAll("[data-ip-probe]").forEach((button) => {
    button.onclick = async () => {
      const result = await requestIPProbe(JSON.parse(button.dataset.ipProbe), false);
      notifyIPProbeSubmitted(result);
      await refreshPageData(true);
    };
  });
  document.querySelectorAll("[data-ip-probe-release]").forEach((button) => {
    button.onclick = () => openIPProbeReleaseModal(JSON.parse(button.dataset.ipProbeRelease));
  });
  document.querySelectorAll("[data-network-probe]").forEach((button) => {
    button.onclick = () => openNetworkProbeModal(JSON.parse(button.dataset.networkProbe));
  });
  document.querySelectorAll("[data-host-credentials]").forEach((button) => {
    button.onclick = () => openHostCredentialModal(JSON.parse(button.dataset.hostCredentials));
  });
  bindNotifications();
  const goLDAP = $("[data-go-ldap]");
  if (goLDAP) goLDAP.onclick = () => render("ldap");
  const ldapForm = $("#ldap-config-form");
  if (ldapForm) bindLDAPTransportWarning(ldapForm);
  if (ldapForm)
    ldapForm.onsubmit = async (event) => {
      event.preventDefault();
      const submit = ldapForm.querySelector('[type="submit"]');
      if (submit.disabled) return;
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
        await render("ldap");
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
        await render(syncLDAP.dataset.syncLdap === "users" ? "users" : "ldap");
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
          await api(`/users/${pathID(button.dataset.deleteUser)}`, {
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
          await api(`/hosts/${pathID(button.dataset.deleteHost)}`, {
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
          await api(`/images/${pathID(button.dataset.deleteImage)}`, {
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
          await api(`/flavors/${pathID(button.dataset.deleteFlavor)}`, {
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
          await api(`/networks/${pathID(button.dataset.deleteNetwork)}`, {
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
    card.onclick = (event) => {
      // 操作按钮及内部图标的点击不切换网络，避免冒泡重绘清掉弹窗与筛选。
      if (event.target.closest("button,a,input,select,textarea,label")) return;
      state.selectedNetworkID = card.dataset.selectNetwork;
      state.listFilters.ips.page = 1;
      state.listFilters.ips.keyword = "";
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
      const result = await api(`/instances/${pathID(instanceID)}/renew`, {
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
      const result = await api(`/instances/${pathID(instanceID)}/restore`, {
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
      await api(`/approvals/${pathID(button.dataset.approvalId)}/decision`, {
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
      const result = await api(`/approvals/${pathID(button.dataset.resubmitShort)}/resubmit-short`, {
        method: "POST",
        body: JSON.stringify({ hours: Number(data.get("hours")), reason: data.get("reason").trim() }),
      });
      state.lastCredentials = result.connection || null;
      state.credentialsPending = Boolean(result.connection);
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
  state.credentialModalPending = true;
  submit.disabled = true;
  form.querySelector("[data-reset-saved]").onchange = (event) => {
    submit.disabled = !event.target.checked;
    state.credentialModalPending = !event.target.checked;
  };
  form.querySelector("[data-copy-reset-password]").onclick = async () => {
    await copyText(connection.password);
    toast("新密码已复制");
  };
  form.querySelector("[data-copy-reset-ssh]").onclick = async () => {
    await copyText(`ssh ${connection.username}@${connection.ip_address}`);
    toast("SSH 命令已复制");
  };
  protectAsyncButtons();
}

function bindListControls() {
  document.querySelectorAll("[data-current-kind]").forEach((node) => { state.listFilters[node.dataset.currentKind].page = numeric(node.dataset.currentPage, 1); });
  document.querySelectorAll("[data-list-filter]").forEach((control) => {
    const update = () => {
      if (control.dataset.composing === "true") return;
      const kind = control.dataset.listFilter;
      state.listFilters[kind][control.name] = control.name === "pageSize" ? numeric(control.value, 20) : control.value.trim();
      state.listFilters[kind].page = 1;
      clearTimeout(state.filterTimer);
      pageTimers.delete(state.filterTimer);
      state.filterTimer = schedulePageWork(
        () => { state.filterTimer = null; refreshPageData(true); },
        control.tagName === "INPUT" ? 300 : 0,
      );
    };
    control.oninput = control.tagName === "INPUT" ? update : null;
    control.onchange = update;
    control.oncompositionstart = () => { control.dataset.composing = "true"; };
    control.oncompositionend = () => { control.dataset.composing = "false"; update(); };
  });
  document.querySelectorAll("[data-list-page]").forEach((button) => {
    button.onclick = () => {
      const kind = button.dataset.listPage;
      state.listFilters[kind].page = Number(button.dataset.page);
      refreshPageData(true);
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
        const items = await collectExportItems("/users", "users");
        downloadCSV(`用户列表-${new Date().toISOString().slice(0, 10)}.csv`, [
          ["用户名", "显示名称", "邮箱", "来源", "角色", "状态", "最近登录"],
          ...items.map((user) => [
            user.username,
            user.display_name,
            user.email,
            user.source,
            user.role,
            !user.enabled ? "停用" : user.source === "LDAP" && user.ldap_directory_present === false ? "LDAP 目录不可用" : user.must_change_password ? "首次需改密" : "正常",
            fmtDate(user.last_login_at),
          ]),
        ]);
      } else {
        const items = await collectExportItems("/instances", "instances");
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
          ...items.map((item) => [
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
  bindAccessibleFields();
  bindManagement();
  bindListControls();
  bindPlatformFeatures();
  const expiry = $("[data-expiring-count]");
  if (state.page === "my-instances" && expiry) {
    const count = numeric(expiry.dataset.expiringCount);
    if (count && String(count) !== state.expiryNoticeKey) schedulePageWork(() => toast(count + " 台虚拟机将在 24 小时内到期，请及时续期。", "warning"));
    state.expiryNoticeKey = String(count);
  }
  document.querySelectorAll("[data-refresh-page]").forEach((button) => { button.onclick = async () => refreshPageData(true); });
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
        await api(`/approvals/${pathID(button.dataset.withdrawApproval)}/withdraw`, { method: "POST", body: "{}" });
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
              // 只传实例和模式，控制台窗口自行向同源授权接口领取票据，不信任地址栏中的连接地址。
              const fragment = new URLSearchParams({ mode, name: b.dataset.instanceName, instance: b.dataset.instanceId });
              popup.opener = null;
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
                    `/instances/${pathID(b.dataset.instanceId)}/actions`,
                    {
                      method: "POST",
                      body: JSON.stringify({ action: "reset_password" }),
                    },
                  );
                  toast("密码重置任务已提交");
                  schedulePageWork(
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
                  await api(`/instances/${pathID(b.dataset.instanceId)}/actions`, {
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
                  await api(`/instances/${pathID(b.dataset.instanceId)}/actions`, {
                    method: "POST",
                    body: JSON.stringify({ action: "force_delete" }),
                  });
                  toast("立即删除任务已提交");
                  await render("my-instances");
                },
              });
              return;
            }
            const result = await api("/instances/" + pathID(b.dataset.instanceId) + "/actions", {
              method: "POST",
              body: JSON.stringify({ action }),
            });
            toast(result?.message || "实例操作已提交，请等待实际任务结果。", "info", {title: result?.recovery_pending ? "正在复核隔离 IP" : "实例操作已提交", duration: result?.recovery_pending ? 10000 : 5000});
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
        await api("/hosts/" + pathID(b.dataset.host) + "/status", {
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
          await api("/images/" + pathID(b.dataset.toggleImage), {
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
        await api("/flavors/" + pathID(b.dataset.toggleFlavor), {
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
      state.credentialsPending = !credentialsSaved.checked;
    };
  const f = $("#apply-form");
  if (f) {
    bindInlineValidation(f, applicationValidationRules);
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
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (!validateFields(f, applicationValidationRules)) return;
      const data = Object.fromEntries(new FormData(f));
      data.lease_hours = Number(data.lease_hours);
      const btn = f.querySelector("[type=submit]");
      if (btn.disabled) return;
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
        state.credentialsPending = Boolean(r.connection);
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
  protectAsyncButtons();
}
async function runButton(button, operation) {
  if (button.disabled) return;
  const original = button.textContent;
  const epoch = sessionEpoch;
  button.disabled = true;
  state.busyCount += 1;
  try { await operation(); }
  catch (error) {
    if (!isCancelledContext(error)) {
      if (error.status === 401) showLogin();
      else toast(error.message || "操作未完成", "error");
    }
  } finally {
    state.busyCount = Math.max(0, state.busyCount - 1);
    if (button.isConnected) { button.disabled = false; if (epoch === sessionEpoch) button.textContent = original; }
  }
}
function protectAsyncButtons() {
  document.querySelectorAll("button").forEach((button) => {
    const handler = button.onclick;
    if (typeof handler !== "function" || handler.constructor.name !== "AsyncFunction") return;
    button.dataset.asyncProtected = "true";
    button.onclick = (event) => runButton(button, () => handler.call(button, event));
  });
}
document
  .querySelectorAll("nav button")
  .forEach((b) => (b.onclick = () => render(b.dataset.page)));
function toast(message, type = "success", options = {}) {
  if (isCancelledContext(message)) return;
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
  setMobileNavigation(false, false);
  beginSession();
  closeModal(true);
  closeAlert();
  $("#notification-center").replaceChildren();
  state.currentUser = null;
  state.lastCredentials = null;
  state.credentialsPending = false;
  state.credentialModalPending = false;
  state.busyCount = 0;
  state.rendering = false;
  state.detailInstanceID = null;
  state.pendingApprovalNotified = false;
  state.pendingApprovalNoticeRequested = false;
  state.selectedNetworkID = null;
  state.expiryNoticeKey = null;
  state.listFilters = JSON.parse(JSON.stringify(initialListFilters));
  notificationHistoryState.page = 1;
  notificationHistoryState.status = "";
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
  beginSession();
  closeModal(true);
  state.lastCredentials = null;
  $("#content").replaceChildren();
  state.currentUser = user;
  $("#login-screen").hidden = true;
  $("#app-shell").hidden = false;
  document
    .querySelectorAll("[data-admin]")
    .forEach((element) => (element.hidden = user.role !== "ADMIN"));
  const dashboardLabel = document.querySelector("[data-dashboard-label]");
  if (dashboardLabel)
    dashboardLabel.textContent = user.role === "ADMIN" ? "资源总览" : "我的概览";
  $("#current-user").textContent = user.display_name || user.username;
  $("#current-role").textContent =
    `${user.role === "ADMIN" ? "管理员" : "普通用户"} · ${user.source === "LDAP" ? "LDAP" : "本地"}`;
  $("#password-button").hidden = user.source !== "LOCAL";
  $("#user-avatar").textContent = (user.display_name || user.username)
    .slice(0, 2)
    .toUpperCase();
  state.pendingApprovalNoticeRequested = user.role === "ADMIN";
}

async function updateApprovalIndicator(showNotice = false) {
  if (state.currentUser?.role !== "ADMIN") return;
  try {
    const result = await api("/approvals?status=PENDING");
    const count = numeric(result.total, result.items.length);
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
  if (state.hostCredentialRequestPending) { hostCredentialRequestNotice(); return; }
  if (state.credentialsPending || state.credentialModalPending) { confirmCredentialDiscard(logout); return; }
  showLogin();
  const submit = $("#login-form [type=submit]");
  submit.disabled = true;
  try {
    await api("/auth/logout", { method: "POST" });
  } finally {
    closeModal();
    showLogin();
    submit.disabled = false;
    $("#logout-button").disabled = false;
  }
}

function openOwnPasswordModal(force = false) {
  const form = showFormModal({
    title: force ? "首次登录修改密码" : "修改登录密码",
    description: force
      ? "为保证账号安全，请修改管理员设置的初始密码后再继续使用。"
      : "修改后旧密码将立即失效。",
    content: `<div class="modal-grid">${field("current_password", "当前密码", "", { type: "password", full: true, inlineError:true, autocomplete: "current-password" })}${field("new_password", "新密码", "", { type: "password", full: true, inlineError:true, autocomplete: "new-password", hint: "至少 10 位，包含大写字母、小写字母和数字" })}${field("confirm_password", "确认新密码", "", { type: "password", full: true, inlineError:true, autocomplete: "new-password" })}</div>`,
    submitText: "保存新密码",
    validationRules: Object.fromEntries(["current_password", "new_password", "confirm_password"].map(name => [name, (_value, form) => passwordValidationErrors(Object.fromEntries(["current_password", "new_password", "confirm_password"].map(key => [key, form.elements[key].value])))[name]])),
    onSubmit: async (data) => {
      await api("/auth/password", {
        method: "POST",
        body: JSON.stringify({
          current_password: data.get("current_password"),
          new_password: data.get("new_password"),
        }),
      });
      state.currentUser.must_change_password = false;
      toast("密码已修改");
      await render("dashboard");
    },
  });
  if (force) {
    form.dataset.forcePassword = "true";
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
      state.detailInstanceID = decodeRouteID(initialRoute[1]);
  }
  try {
    const result = await api("/auth/me");
    applyCurrentUser(result.user);
    if (result.user.must_change_password) openOwnPasswordModal(true);
    else await render(state.page);
  } catch (error) {
    if (isCancelledContext(error)) return;
    showLogin(error.status === 401 ? "" : error.message);
  }
}

$("#login-form").onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  if (submit.disabled) return;
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
    setLoginSource(data.source);
    applyCurrentUser(result.user);
    if (result.user.must_change_password) openOwnPasswordModal(true);
    else await render("dashboard");
  } catch (reason) {
    if (isCancelledContext(reason)) return;
    error.textContent = reason.message;
    error.classList.add("show");
  } finally {
    submit.disabled = false;
    submit.querySelector("span").textContent =
      form.elements.source.value === "LDAP" ? "LDAP 登录" : "平台登录";
  }
};

function decodeRouteID(value) {
  try { return decodeURIComponent(value); } catch { return ""; }
}
function setLoginSource(value) {
    const source = value === "LDAP" ? "LDAP" : "LOCAL";
    document
      .querySelectorAll("[data-login-source]")
      .forEach((item) => { const selected = item.dataset.loginSource === source; item.classList.toggle("active", selected); item.setAttribute("aria-selected", String(selected)); item.tabIndex = selected ? 0 : -1; });
    $("#login-form [name=source]").value = source;
    $("#login-description").textContent =
      source === "LDAP"
        ? "使用已由管理员同步到平台的 LDAP 账号登录。"
        : "使用管理员在平台中创建的账号登录。";
    $("#login-form [type=submit] span").textContent =
      source === "LDAP" ? "LDAP 登录" : "平台登录";
}
document.querySelectorAll("[data-login-source]").forEach((button) => {
  button.onclick = () => setLoginSource(button.dataset.loginSource);
  button.onkeydown = (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...document.querySelectorAll("[data-login-source]")];
    const current = buttons.indexOf(button);
    const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    setLoginSource(buttons[index].dataset.loginSource); buttons[index].focus();
  };
});

$("#logout-button").onclick = logout;

$("#password-button").onclick = () => openOwnPasswordModal(false);

boot();
async function refreshPageData(manual = false) {
  const page = state.page;
  if (state.rendering || !state.currentUser || document.hidden || $("#modal-root").children.length || $("#alert-root").children.length) return;
  if (document.querySelector('[data-list-filter][data-composing="true"]')) return;
  if (!manual && (state.busyCount || state.interactionUntil > Date.now() || state.filterTimer || document.querySelector("[data-approval-select]:checked"))) return;
  const target = $("[data-page-results]");
  if (!target) return;
  const epoch = sessionEpoch, sequence = renderSequence, partial = ++state.partialSequence;
  const active = document.activeElement;
  const restore = active?.closest?.("[data-page-results]") && active.dataset?.listFilter ? {kind: active.dataset.listFilter, name: active.name} : null;
  const ipRow = state.page === "network" ? active?.closest?.("[data-ip-address]") : null;
  const probeFocus = ipRow ? {id: ipRow.dataset.ipAddress, action: active.dataset?.ipProbeRelease ? "[data-ip-probe-release]" : active.dataset?.ipProbe ? "[data-ip-probe]" : ""} : null;
  try {
    const html = await pages[page]();
    if (epoch !== sessionEpoch || sequence !== renderSequence || partial !== state.partialSequence || !target.isConnected) return;
    if (!manual && (state.interactionUntil > Date.now() || $("#modal-root").children.length || $("#alert-root").children.length)) return;
    const template = document.createElement("template");
    template.innerHTML = html;
    const next = template.content.querySelector("[data-page-results]");
    if (!next) return;
    target.innerHTML = next.innerHTML;
    const actions = $("[data-live-actions]");
    const nextActions = template.content.querySelector("[data-live-actions]");
    if (actions && nextActions) actions.innerHTML = nextActions.innerHTML;
    const total = $("[data-live-total]");
    const nextTotal = template.content.querySelector("[data-live-total]");
    if (total && nextTotal) total.textContent = nextTotal.textContent;
    const networkCards = $("[data-live-network-cards]");
    const nextNetworkCards = template.content.querySelector("[data-live-network-cards]");
    if (networkCards && nextNetworkCards) networkCards.innerHTML = nextNetworkCards.innerHTML;
    document.querySelectorAll("[data-last-refreshed]").forEach((node) => { node.textContent = "更新于 " + new Date().toLocaleTimeString("zh-CN", {hour12: false}); });
    bind();
    if (restore) document.querySelector('[data-list-filter="' + restore.kind + '"][name="' + restore.name + '"]')?.focus();
    if (probeFocus) {
      // 不把后台 ID 拼入 CSS 选择器；复核完成后按钮消失时把焦点保留在同一地址行。
      const nextRow = [...document.querySelectorAll("[data-ip-address]")].find((node) => node.dataset.ipAddress === probeFocus.id);
      (probeFocus.action ? nextRow?.querySelector(probeFocus.action) || nextRow : nextRow)?.focus();
    }
  } catch (error) {
    if (isCancelledContext(error)) return;
    if (error.status === 401) showLogin();
    else if (manual) toast(error.message, "error");
    else { const node = $("[data-last-refreshed]"); if (node) node.textContent = "刷新失败，可手动重试"; }
  }
}
async function refreshMyInstanceTable() { return refreshPageData(false); }
setInterval(() => {
  if (state.currentUser && !state.currentUser.must_change_password && ["my-instances", "all-instances", "instance-detail", "requests", "approvals", "images", "network"].includes(state.page)) refreshPageData(false);
}, 10000);
window.addEventListener("beforeunload", (event) => {
  if (state.credentialsPending || state.credentialModalPending || state.hostCredentialRequestPending) { event.preventDefault(); event.returnValue = ""; }
});
window.addEventListener("pagehide", clearHostCredentialSecret);
document.addEventListener("pointerdown", () => { state.interactionUntil = Date.now() + 700; }, true);
