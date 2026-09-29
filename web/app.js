const $ = (s) => document.querySelector(s);
const api = async (path, opts = {}) => {
  const r = await fetch("/api/v1" + path, {
    headers: { "Content-Type": "application/json", "X-User": "lixiaokun" },
    ...opts,
  });
  if (r.status === 204) return null;
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "请求失败");
  return j;
};
const state = {
  page: "dashboard",
  lastCredentials: null,
  detailInstanceID: null,
  selectedNetworkID: null,
};
const labels = {
  dashboard: "资源总览",
  apply: "申请虚拟机",
  "my-instances": "我的虚拟机",
  "all-instances": "全部实例",
  "instance-detail": "实例详情",
  hosts: "宿主机",
  images: "镜像",
  flavors: "资源规格",
  network: "网络 IP",
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
    ].includes(v),
    bad = ["FAILED", "ERROR", "OFFLINE"].includes(v);
  return `<span class="pill ${ok ? "ok" : warn ? "warn" : bad ? "bad" : "blue"}">${v || "-"}</span>`;
}
function fmtDate(v) {
  return v ? new Date(v).toLocaleString("zh-CN", { hour12: false }) : "-";
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
      error.textContent = reason.message || "操作失败";
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
  return `${lead("申请已提交", "虚拟机正在异步交付，请立即保存下面的一次性凭据")}<div class="form-card credential-card"><div class="credential-warning">密码只在本次申请成功后显示，平台不保存明文密码。</div><div class="credential-grid"><div><span>申请单</span><strong>${esc(r.request_no)}</strong></div><div><span>交付状态</span><strong>交付中</strong></div><div><span>IP 地址</span><code>${esc(c.ip_address)}</code></div><div><span>用户名</span><code>${esc(c.username)}</code></div><div class="full"><span>一次性密码</span><code>${esc(c.password)}</code></div></div><div class="form-actions"><button class="btn" data-copy-credentials>复制连接信息</button><button class="btn primary" data-go="my-instances">查看我的虚拟机</button></div></div>`;
}

async function dashboard() {
  const [s, instances] = await Promise.all([
    api("/summary"),
    api("/instances?scope=mine"),
  ]);
  const ratio = s.allocatable_memory_mb
    ? Math.round((s.reserved_memory_mb / s.allocatable_memory_mb) * 100)
    : 0;
  return `${lead("资源总览", "临时计算资源、我的虚拟机与平台容量状态")}<div class="cards"><div class="metric"><span class="label">在线宿主机</span><strong>${s.active_hosts}</strong><small>由 Agent 持续心跳</small></div><div class="metric"><span class="label">运行中实例</span><strong>${s.running_instances}</strong><small>${s.provisioning_instances} 台交付中</small></div><div class="metric"><span class="label">我的虚拟机</span><strong>${instances.items.length}</strong><small>当前账号 lixiaokun</small></div><div class="metric"><span class="label">内存预占率</span><strong>${ratio}%</strong><small>${gb(s.reserved_memory_mb)} / ${gb(s.allocatable_memory_mb)}</small></div></div><div class="grid2"><div class="panel"><h3>集群容量</h3><div class="capacity-row"><div><span>临时资源池内存</span><b>${ratio}%</b></div><div class="capacity"><span style="width:${ratio}%"></span></div></div><p style="color:var(--muted)">申请时在同一个数据库事务内完成宿主机资源和 IP 地址预占，避免并发超卖。</p></div><div class="panel"><h3>快捷操作</h3><div class="quick"><button data-go="apply">＋<br>申请虚拟机</button><button data-go="my-instances">▣<br>我的虚拟机</button><button data-go="hosts">⌁<br>宿主状态</button><button data-go="network">⌘<br>网络 IP</button></div></div></div>${instances.items.length ? `<div class="panel" style="margin-top:18px"><h3>我的最近实例</h3>${instanceTable(instances.items.slice(0, 5), false)}</div>` : ""}`;
}

async function applyPage() {
  const [f, i, n] = await Promise.all([
    api("/flavors"),
    api("/images"),
    api("/networks"),
  ]);
  return `${lead("申请虚拟机", "选择固定规格、镜像、网络和租期，提交后自动调度")}<form class="form-card" id="apply-form"><div class="form-grid"><div class="field"><label>实例名称</label><input name="instance_name" required maxlength="48" pattern="[a-zA-Z0-9-]+" placeholder="例如 dev-api-01"><small>仅支持字母、数字和连字符</small></div><div class="field"><label>使用时长</label><select name="lease_hours"><option value="8">8 小时</option><option value="24" selected>1 天</option><option value="72">3 天</option><option value="168">7 天</option><option value="336">14 天</option></select></div><div class="field"><label>资源规格</label><select name="flavor_id">${f.items.map((x) => `<option value="${x.id}">${x.name} · ${x.disk_gb}G 系统盘</option>`).join("")}</select></div><div class="field"><label>系统镜像</label><select name="image_id">${i.items.map((x) => `<option value="${x.id}">${x.name}</option>`).join("")}</select></div><div class="field full"><label>网络</label><select name="network_id">${n.items
    .filter((x) => x.enabled)
    .map(
      (x) =>
        `<option value="${x.id}">${x.name} · ${x.cidr} · 可用 ${x.free}</option>`,
    )
    .join(
      "",
    )}</select></div><div class="field full"><label>用途说明</label><textarea name="purpose" required placeholder="说明项目、使用场景以及需要临时服务器的原因"></textarea></div></div><div class="form-actions"><button type="button" class="btn" data-go="dashboard">取消</button><button class="btn primary" type="submit">提交申请</button></div></form>`;
}

function instanceActions(x, includeDetail = true) {
  const buttons = includeDetail ? [["detail", "详情"]] : [];
  if (x.lifecycle_status === "RUNNING")
    buttons.push(["stop", "关机"], ["reboot", "重启"]);
  if (x.lifecycle_status === "STOPPED") buttons.push(["start", "开机"]);
  if (x.lifecycle_status === "ERROR") buttons.push(["retry", "重试创建"]);
  if (["RUNNING", "STOPPED", "RETAINED"].includes(x.lifecycle_status))
    buttons.push(["renew", "续期"]);
  if (["RUNNING", "STOPPED"].includes(x.lifecycle_status))
    buttons.push(["release", "释放"]);
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
          `<button class="btn mini ${action === "release" ? "danger" : ""}" data-instance-action="${action}" data-instance-id="${x.id}" data-instance-name="${esc(x.name)}">${label}</button>`,
      )
      .join("") + pending
  );
}
function instanceTable(items, showOwner = true, showActions = false) {
  const columns = (showOwner ? 7 : 6) + (showActions ? 1 : 0);
  return `<table><thead><tr><th>实例</th>${showOwner ? "<th>使用人</th>" : ""}<th>规格 / 镜像</th><th>宿主机</th><th>IP 地址</th><th>状态</th><th>到期时间</th>${showActions ? "<th>操作</th>" : ""}</tr></thead><tbody>${items.length ? items.map((x) => `<tr><td><b>${esc(x.name)}</b><br><small>${esc(x.username || "-")}</small></td>${showOwner ? `<td>${esc(x.owner || "-")}</td>` : ""}<td>${esc(x.flavor)}<br><small>${esc(x.image)}</small></td><td>${esc(x.host || "-")}</td><td>${esc(x.ip_address || "分配中")}</td><td>${status(x.lifecycle_status)}</td><td>${fmtDate(x.expires_at)}${x.retention_until ? `<br><small>保留至 ${fmtDate(x.retention_until)}</small>` : ""}</td>${showActions ? `<td><div class="instance-actions">${instanceActions(x)}</div></td>` : ""}</tr>`).join("") : `<tr><td colspan="${columns}" class="empty">暂无实例，先提交一台试试</td></tr>`}</tbody></table>`;
}
async function myInstances() {
  const x = await api("/instances?scope=mine");
  return (
    lead(
      "我的虚拟机",
      "当前账号申请并由平台管理的临时虚拟机",
      '<button class="btn primary" data-go="apply">＋ 申请虚拟机</button>',
    ) + instanceTable(x.items, false, true)
  );
}
async function allInstances() {
  const x = await api("/instances");
  return (
    lead("全部实例", "平台创建的全部临时虚拟机") +
    instanceTable(x.items, true, false)
  );
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
  return `${lead(i.name, "虚拟机配置、租期、任务和审计记录", toolbar)}<div class="cards"><div class="metric"><span class="label">状态</span><strong>${esc(i.lifecycle_status)}</strong><small>${esc(i.provider_status)}</small></div><div class="metric"><span class="label">资源</span><strong>${i.flavor.cpu}C / ${gb(i.flavor.memory_mb)}</strong><small>${i.flavor.disk_gb} GB 系统盘</small></div><div class="metric"><span class="label">IP 地址</span><strong>${esc(i.ip_address || "-")}</strong><small>${esc(i.username || "-")}</small></div><div class="metric"><span class="label">租期</span><strong>${fmtDate(i.expires_at)}</strong><small>${i.retention_until ? `保留至 ${fmtDate(i.retention_until)}` : "未进入保留期"}</small></div></div><div class="grid2"><div class="panel"><h3>实例信息</h3><dl class="detail-list"><div><dt>申请单</dt><dd>${esc(i.request_no)}</dd></div><div><dt>用途</dt><dd>${esc(i.purpose)}</dd></div><div><dt>宿主机</dt><dd>${esc(i.host || "-")}</dd></div><div><dt>镜像</dt><dd>${esc(i.image.name)}</dd></div><div><dt>镜像来源</dt><dd>${esc(i.image.source_type)} / ${esc(i.image.sync_status)}</dd></div><div><dt>镜像位置</dt><dd>${esc(i.image.source_location || "-")}</dd></div><div><dt>创建时间</dt><dd>${fmtDate(i.created_at)}</dd></div></dl></div><div class="panel"><h3>最近审计</h3>${audit}</div></div><div class="panel" style="margin-top:18px"><h3>任务历史</h3><div class="resource-table-wrap"><table><thead><tr><th>任务</th><th>状态</th><th>尝试</th><th>错误</th><th>时间</th></tr></thead><tbody>${tasks}</tbody></table></div></div>`;
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
          )}<dl><div><dt>最近心跳</dt><dd>${fmtDate(h.last_heartbeat_at)}</dd></div><div><dt>发现 / 外部虚拟机</dt><dd>${h.discovered_instances || 0} / ${h.external_instances || 0} 台</dd></div><div><dt>libvirt</dt><dd>${facts.libvirt_version || "-"}</dd></div><div><dt>QEMU</dt><dd>${facts.hypervisor_version || "-"}</dd></div></dl><div class="form-actions"><button class="btn" data-host-quota='${esc(JSON.stringify(h))}'>配置调度额度</button><button class="btn" data-host="${h.id}" data-status="${h.status === "CORDONED" ? "ACTIVE" : "CORDONED"}">${h.status === "CORDONED" ? "恢复调度" : "暂停调度"}</button></div></div>`;
      })
      .join("") || '<div class="panel empty">暂无已注册 Agent</div>'
  }</div>`;
}

async function images() {
  const x = await api("/images?all=1");
  return `${lead("镜像管理", "统一管理宿主机本地镜像与 HTTP(S) / OSS 远程镜像", '<button class="btn primary" data-new-image>＋ 新增镜像</button>')}<div class="management-toolbar"><span class="summary">共 ${x.items.length} 个镜像，远程镜像在校验和同步完成前不可启用</span></div><div class="resource-table-wrap"><table><thead><tr><th>镜像</th><th>来源</th><th>完整路径 / 远程地址</th><th>系统</th><th>同步</th><th>状态</th><th>操作</th></tr></thead><tbody>${x.items.map((i) => `<tr><td><b>${esc(i.name)}</b><span class="source-sub">ID: ${esc(i.id)}</span></td><td><span class="type-badge ${i.source_type === "remote" ? "remote" : ""}">${i.source_type === "remote" ? "远程镜像" : "本地镜像"}</span></td><td class="source-cell"><span class="source-main">${esc(i.source_location || "未配置")}</span><span class="source-sub">${i.source_type === "remote" ? `本地缓存：${esc(i.file_name || "-")}` : `镜像文件：${esc(i.file_name || "-")}`}</span>${i.checksum ? `<span class="source-sub">SHA-256：${esc(i.checksum)}</span>` : ""}</td><td>${esc(i.os_family)} ${esc(i.version)}</td><td>${status(i.sync_status)}</td><td>${i.enabled ? status("ACTIVE") : '<span class="pill">DISABLED</span>'}</td><td><div class="row-actions"><button class="btn mini" data-edit-image='${esc(JSON.stringify(i))}'>编辑</button><button class="btn mini" data-toggle-image="${i.id}" data-enabled="${!i.enabled}">${i.enabled ? "停用" : "启用"}</button></div></td></tr>`).join("")}</tbody></table></div>`;
}
async function flavors() {
  const x = await api("/flavors?all=1");
  return `${lead("资源规格", "管理员可同时维护 vCPU、内存和系统盘组合", '<button class="btn primary" data-new-flavor>＋ 新增规格</button>')}<div class="host-grid">${x.items.map((f) => `<div class="host"><div class="host-head"><div><h3>${esc(f.name)}</h3><span class="source-sub">${esc(f.id)}</span></div>${f.enabled ? status("ACTIVE") : '<span class="pill">DISABLED</span>'}</div><dl><div><dt>vCPU</dt><dd>${f.cpu} C</dd></div><div><dt>内存</dt><dd>${gb(f.memory_mb)}</dd></div><div><dt>系统盘</dt><dd>${f.disk_gb} GB</dd></div><div><dt>适用场景</dt><dd>${f.cpu >= 4 ? "编译 / 集成测试" : "日常开发"}</dd></div></dl><div class="form-actions"><button class="btn" data-edit-flavor='${esc(JSON.stringify(f))}'>编辑规格</button><button class="btn" data-toggle-flavor="${f.id}" data-name="${esc(f.name)}" data-cpu="${f.cpu}" data-memory="${f.memory_mb}" data-disk="${f.disk_gb}" data-enabled="${!f.enabled}">${f.enabled ? "停用" : "启用"}</button></div></div>`).join("")}</div>`;
}
async function network() {
  const n = await api("/networks");
  if (!state.selectedNetworkID && n.items.length)
    state.selectedNetworkID = n.items[0].id;
  const selected =
    n.items.find((item) => item.id === state.selectedNetworkID) || n.items[0];
  const ips = selected
    ? await api("/ip-addresses?network_id=" + selected.id)
    : { items: [] };
  return `${lead("网络 IP", "先定义网段与 Bridge，再向该网段加入可分配 IP 范围；Agent 创建前会执行占用探测", '<button class="btn primary" data-new-network>＋ 新增网络</button>')}<div class="host-grid">${n.items.map((x) => `<div class="host network-card ${selected?.id === x.id ? "selected" : ""}" data-select-network="${x.id}"><div class="host-head"><div><h3>${esc(x.name)}</h3><span class="source-sub">${esc(x.cidr)}</span></div>${x.enabled ? status("ACTIVE") : '<span class="pill">DISABLED</span>'}</div><dl><div><dt>网关</dt><dd>${esc(x.gateway)}</dd></div><div><dt>Bridge</dt><dd>${esc(x.bridge)}</dd></div><div><dt>DNS</dt><dd>${esc((x.dns_servers || []).join(", ") || "-")}</dd></div><div><dt>空闲 / 总数</dt><dd>${x.free} / ${x.total}</dd></div></dl><div class="capacity"><span style="width:${x.total ? Math.round(((x.allocated + x.reserved) / x.total) * 100) : 0}%"></span></div><div class="form-actions"><button class="btn" data-edit-network='${esc(JSON.stringify(x))}'>编辑网络</button><button class="btn primary" data-ip-range="${x.id}" data-network-name="${esc(x.name)}">添加 IP 范围</button></div></div>`).join("") || '<div class="panel empty">尚未定义网络，请先由管理员创建</div>'}</div>${selected ? `<div class="panel" style="margin-top:18px"><div class="ip-pool-head"><div><h3>${esc(selected.name)} · IP 地址池</h3><span class="source-sub">${ips.items.length} 个地址，点击上方网络卡片可切换</span></div><div class="ip-legend"><span>空闲</span><span class="used">已分配</span><span class="reserved">预留</span><span class="quarantine">隔离</span></div></div><div class="ip-grid">${ips.items.map((ip) => `<span class="ip ${ip.status.toLowerCase()}" title="${esc(ip.instance_name || ip.status)}">${esc(ip.address)}<small>${ip.status}</small></span>`).join("")}</div></div>` : ""}`;
}

const pages = {
  dashboard,
  apply: applyPage,
  "my-instances": myInstances,
  "all-instances": allInstances,
  "instance-detail": instanceDetailPage,
  hosts,
  images,
  flavors,
  network,
};
async function render(page = state.page) {
  state.page = page;
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
  } catch (e) {
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
    description: "网段本身不会自动产生 IP，保存后还需添加可分配地址范围。",
    content: `<div class="modal-grid">${field("name", "网络名称", existing?.name || "", { placeholder: "例如 研发临时网络" })}${field("bridge", "宿主机 Bridge", existing?.bridge || "br0", { placeholder: "br0" })}${field("cidr", "网段 CIDR", existing?.cidr || "", { placeholder: "10.200.8.0/22" })}${field("gateway", "默认网关", existing?.gateway || "", { placeholder: "10.200.11.254" })}${field("dns_servers", "DNS 服务器", (existing?.dns_servers || []).join(", "), { full: true, placeholder: "10.200.1.10, 10.200.1.11", hint: "多个地址使用英文逗号分隔" })}<div class="field full"><label><input name="enabled" type="checkbox" ${existing?.enabled === false ? "" : "checked"}> 允许该网络参与虚拟机分配</label></div></div>`,
    submitText: existing ? "保存网络" : "创建网络",
    onSubmit: async (formData, form) => {
      const data = {
        name: formData.get("name").trim(),
        cidr: formData.get("cidr").trim(),
        gateway: formData.get("gateway").trim(),
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
      toast(existing ? "网络已更新" : "网络已创建，请继续添加 IP 范围");
      await render("network");
    },
  });
}

function openIPRangeModal(networkID, networkName) {
  showFormModal({
    title: "添加 IP 范围",
    description: `目标网络：${networkName}。重复地址会自动跳过，创建虚拟机前 Agent 会 ping 探测是否被占用。`,
    compact: true,
    content: `<div class="modal-grid">${field("start", "起始 IP", "", { placeholder: "10.200.9.20" })}${field("end", "结束 IP", "", { placeholder: "10.200.9.99" })}<div class="notice full">范围必须完全位于已定义的 CIDR 内，网关地址不会加入地址池。</div></div>`,
    submitText: "加入地址池",
    onSubmit: async (formData) => {
      await api(`/networks/${networkID}/ip-ranges`, {
        method: "POST",
        body: JSON.stringify({
          start: formData.get("start").trim(),
          end: formData.get("end").trim(),
        }),
      });
      state.selectedNetworkID = networkID;
      toast("IP 范围已加入资源池");
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
  document.querySelectorAll("[data-ip-range]").forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      openIPRangeModal(
        button.dataset.ipRange,
        button.dataset.networkName || "当前网络",
      );
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
      "续期时长会在当前到期时间基础上累加；保留期内的实例续期后会恢复为已停机状态。",
    compact: true,
    content: `<div class="modal-grid">${field("hours", "续期时长（小时）", 24, { type: "number", min: 1, max: 720, full: true, hint: "可输入 1-720 小时" })}</div>`,
    submitText: "确认续期",
    onSubmit: async (formData) => {
      await api(`/instances/${instanceID}/renew`, {
        method: "POST",
        body: JSON.stringify({ hours: Number(formData.get("hours")) }),
      });
      toast(`实例 ${instanceName} 已续期`);
      await render(
        state.page === "instance-detail" ? "instance-detail" : "my-instances",
      );
    },
  });
}

function bind() {
  bindManagement();
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
          } else if (action === "renew") {
            openRenewModal(b.dataset.instanceId, b.dataset.instanceName);
            return;
          } else {
            if (action === "release") {
              showConfirmModal({
                title: `释放 ${b.dataset.instanceName}`,
                description:
                  "实例将先关机并进入 7 天保留期，保留期结束后才删除磁盘和释放 IP。",
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
            await api("/instances/" + b.dataset.instanceId + "/actions", {
              method: "POST",
              body: JSON.stringify({ action }),
            });
            toast("实例操作已提交");
          }
          render("my-instances");
        } catch (err) {
          toast(err.message);
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
          toast(e.message);
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
        `IP: ${c.ip_address}\n用户名: ${c.username}\n密码: ${c.password}`,
      );
      toast("连接信息已复制");
    };
  const f = $("#apply-form");
  if (f)
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
        state.lastCredentials = r.connection || null;
        $("#content").innerHTML = credentialResult(r);
        toast(`申请 ${r.request_no} 已提交，正在异步交付`);
        bind();
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
        btn.textContent = "提交申请";
      }
    };
}
document
  .querySelectorAll("nav button")
  .forEach((b) => (b.onclick = () => render(b.dataset.page)));
function toast(s) {
  const t = $("#toast");
  t.textContent = s;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 3500);
}
render();
setInterval(() => {
  if (["dashboard", "my-instances", "all-instances"].includes(state.page))
    render();
}, 5000);
