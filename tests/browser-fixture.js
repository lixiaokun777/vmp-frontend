// 仅供本机隔离浏览器回归，不加载生产配置，不连接数据库、LDAP、Webhook 或 KVM。
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const web = path.resolve(__dirname, "../web");
const hostID = "22222222-2222-4222-8222-222222222222";
const users = Array.from({length: 45}, (_, index) => ({id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`, username: index === 0 ? "fixture-admin" : `qa-user-${String(index).padStart(2, "0")}`, display_name: index === 0 ? "隔离测试管理员" : `测试用户 ${index}`, email: `qa-${index}@example.test`, role: index === 0 ? "ADMIN" : "USER", source: index % 3 === 0 && index !== 0 ? "LDAP" : "LOCAL", enabled: index % 11 !== 0 || index === 0, ldap_directory_present: index % 13 !== 0, must_change_password: false, last_login_at: new Date().toISOString()}));
const hosts = [{id: hostID, name: "隔离宿主机", status: "ACTIVE", provider_type: "kvm", agent_mode: "kvm", allocatable_memory_mb: 40960, agent_allocatable_memory_mb: 40960, reserved_memory_mb: 8192, allocatable_cpu: 24, agent_allocatable_cpu: 24, reserved_cpu: 4, allocatable_disk_gb: 500, agent_allocatable_disk_gb: 500, reserved_disk_gb: 80}];
const flavors = [{id: "c1m2", name: "轻量型 1C2G", cpu: 1, memory_mb: 2048, disk_gb: 40, enabled: true, usage: {running: 5, retained: 1, active: 7, memory_mb: 14336}}, {id: "c2m4", name: "标准型 2C4G", cpu: 2, memory_mb: 4096, disk_gb: 60, enabled: true, usage: {running: 4, retained: 0, active: 4, memory_mb: 16384}}];
let instances = Array.from({length: 45}, (_, index) => ({id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`, name: `qa-vm-${String(index).padStart(2, "0")}`, owner: index < 25 ? "fixture-admin" : "qa-user-01", host: hosts[0].name, host_id: hostID, flavor: flavors[0].name, flavor_id: flavors[0].id, resource_snapshot: {cpu: 1, memory_mb: 2048, disk_gb: 40}, image: "Ubuntu 隔离测试", lifecycle_status: index % 9 === 8 ? "RETAINED" : "RUNNING", provider_status: "running", username: "ubuntu", ip_address: `10.30.0.${index + 10}`, expires_at: new Date(Date.now() + 3600000 * (index + 1)).toISOString(), retention_until: index % 9 === 8 ? new Date(Date.now() + 86400000 * 4).toISOString() : null, purpose: "仅隔离浏览器测试", request_no: "QA-" + index, restore_count: 0}));
let approvals = Array.from({length: 42}, (_, index) => ({id: `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`, request_no: "QA-APPROVAL-" + index, request_type: index % 2 ? "RENEW" : "CREATE", applicant: "fixture-admin", instance_name: instances[index]?.name, requested_hours: 336, reason: "隔离回归使用", status: index < 22 ? "PENDING" : "WITHDRAWN", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), assigned_reviewer: "fixture-admin", result: {}}));
const applications = instances.map((instance, index) => ({id: `66666666-6666-4666-8666-${String(index).padStart(12, "0")}`, request_no: `QA-REQUEST-${index}`, applicant: instance.owner, instance_name: instance.name, purpose: "隔离浏览器回归", flavor: instance.flavor, image: instance.image, lease_hours: 24, status: "APPROVED", created_at: new Date(Date.now() - index * 60000).toISOString(), instance_id: instance.id, lifecycle_status: index === 25 ? "ERROR" : instance.lifecycle_status, delivery_status: index === 25 ? "FAILED" : "READY", task_status: index === 25 ? "FAILED" : "SUCCEEDED", error_code: index === 25 ? "IP_PROBE_FAILED" : "", error_message: index === 25 ? "宿主机无法完成可靠 IP 探测" : ""}));
let images = [{id: "ubuntu-local", name: "Ubuntu 本地", file_name: "ubuntu.qcow2", source_type: "local", source_location: "/fixture/images/ubuntu.qcow2", os_family: "ubuntu", version: "22.04", enabled: true, sync_status: "READY", generation: 1, host_readiness: [{host_id: hostID, host_name: hosts[0].name, status: "READY", generation: 1, verified_at: new Date().toISOString()}]}, {id: "ubuntu-remote", name: "Ubuntu 远程", file_name: "remote.qcow2", source_type: "remote", source_location: "https://images.example.test/remote.qcow2", checksum: "a".repeat(64), os_family: "ubuntu", version: "24.04", enabled: false, sync_status: "PENDING", generation: 1, host_readiness: [{host_id: hostID, host_name: hosts[0].name, status: "PENDING", generation: 1}]}];
const network = {id: "55555555-5555-4555-8555-555555555555", name: "隔离测试网络", cidr: "10.30.0.0/24", gateway: "10.30.0.1", bridge: "br0", dns_servers: ["10.30.0.1"], enabled: true, ip_range_start: "10.30.0.10", ip_range_end: "10.30.0.110", total: 101, free: 71, allocated: 30, reserved: 0, quarantined: 0};
const ips = Array.from({length: 101}, (_, index) => ({id: String(index), address: `10.30.0.${index + 10}`, instance_id: index < 30 ? instances[index].id : null, instance_name: index < 30 ? instances[index].name : null, owner: index < 30 ? instances[index].owner : null, lifecycle_status: index < 30 ? instances[index].lifecycle_status : null, status: index < 30 ? "ALLOCATED" : "FREE", updated_at: new Date().toISOString()}));
let policy = {max_instances: 0, max_cpu: 0, max_memory_mb: 0, max_disk_gb: 0, max_future_lease_hours: 0, max_continuous_lease_hours: 0, auto_renew_enabled: false, auto_renew_hours: 24, auto_renew_max_count: 2, audit_retention_days: 0, notification_retention_days: 0, approval_retention_days: 0};
let ldap = {enabled: false, configured: false, requested_enabled: false, url: "", base_dn: "", bind_dn: "", login_filter: "(uid=%s)", sync_filter: "(objectClass=person)", username_attribute: "uid", display_name_attribute: "cn", email_attribute: "mail", start_tls: false, has_bind_password: false};
let notifications = {enabled: false, has_webhook: true, webhook_display: "https://robot.example.test/woa/api/v1/webhook/send?key=••••", has_signature_secret: false, platform_url: "http://127.0.0.1:18882", reminder_hours: [24, 1], notify_retained: true, notify_retention_end: true, mention_owner: true, notify_approvals: true, notify_failures: true, notify_host_alerts: true};
let delegation = null;
let archives = [];
let auto = {};
const requests = [];
const api = "/api/v1";
function paged(rows, url) {
  const keyword = (url.searchParams.get("keyword") || "").toLowerCase();
  const filtered = rows.filter((row) => (!keyword || JSON.stringify(row).toLowerCase().includes(keyword)) && ["role", "source", "host_id"].every((key) => !url.searchParams.get(key) || row[key] === url.searchParams.get(key)) && (!url.searchParams.get("type") || row.request_type === url.searchParams.get("type")) && (!url.searchParams.get("status") || (url.searchParams.get("status") === "ENABLED" ? row.enabled : url.searchParams.get("status") === "DISABLED" ? !row.enabled : url.searchParams.get("status") === "DIRECTORY_UNAVAILABLE" ? row.source === "LDAP" && !row.ldap_directory_present : row.lifecycle_status === url.searchParams.get("status") || row.status === url.searchParams.get("status"))));
  const size = Math.max(1, Math.min(100, Number(url.searchParams.get("page_size") || 20)));
  const page = Math.min(Math.max(1, Number(url.searchParams.get("page") || 1)), Math.max(1, Math.ceil(filtered.length / size)));
  return {items: filtered.slice((page - 1) * size, page * size), total: filtered.length, page, page_size: size};
}
function send(res, value, status = 200) { res.writeHead(status, {"Content-Type": "application/json"}); res.end(JSON.stringify(value)); }
const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  const url = new URL(req.url, "http://127.0.0.1:18882");
  if (!url.pathname.startsWith(api)) {
    const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = path.resolve(web, relative);
    if (!file.startsWith(web + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, {error: "文件不存在"}, 404);
    res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
    return fs.createReadStream(file).pipe(res);
  }
  requests.push({method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), securityHeader: req.headers["x-vmp-request"]});
  let body = ""; for await (const chunk of req) {body += chunk; if (body.length > 65536) return send(res, {error: "请求过大"}, 413);}
  const input = body ? JSON.parse(body) : {};
  if (url.pathname === api + "/fixture-requests") return send(res, {items: requests});
  if (url.pathname === api + "/health") return send(res, {status: "ok"});
  if (url.pathname === api + "/auth/login") {res.setHeader("Set-Cookie", "fixture-session=" + (input.username === "qa-user-01" ? "user" : "admin") + "; HttpOnly; SameSite=Lax; Path=/"); return send(res, {user: input.username === "qa-user-01" ? users[1] : {...users[0], source: input.source}});}
  if (url.pathname === api + "/auth/logout") {res.setHeader("Set-Cookie", "fixture-session=; Max-Age=0; Path=/"); return send(res, {});}
  if (!(req.headers.cookie || "").includes("fixture-session=")) return send(res, {error: "未登录"}, 401);
  const current = (req.headers.cookie || "").includes("fixture-session=user") ? users[1] : users[0];
  if (req.method !== "GET" && req.headers["x-vmp-request"] !== "1") return send(res, {error: "缺少平台安全写请求头"}, 403);
  if (url.pathname === api + "/auth/me") return send(res, {user: current});
  if (url.pathname === api + "/summary") return send(res, {active_hosts: 1, running_instances: 35, provisioning_instances: 0, allocatable_memory_mb: 40960, reserved_memory_mb: 8192, pending_approvals: 22});
  if (url.pathname === api + "/me/overview") {const mine = instances.filter((item) => item.owner === current.username); return send(res, {active_instances: mine.length, quota_instances: mine.length, used_cpu: mine.length, used_memory_mb: mine.length * 2048, used_disk_gb: mine.length * 40, nearest_expiry: mine.map((item) => item.expires_at).sort()[0] || null, expiring_24h: mine.filter((item) => new Date(item.expires_at) < new Date(Date.now() + 86400000)).length, limits: {instances: 30, cpu: 40, memory_mb: 65536, disk_gb: 1600}});}
  if (url.pathname === api + "/users") return send(res, req.method === "GET" ? paged(users, url) : {});
  if (url.pathname === api + "/hosts") return send(res, {items: hosts});
  if (url.pathname === api + "/flavors") return send(res, {items: flavors});
  if (url.pathname === api + "/images") return send(res, {items: images});
  if (url.pathname.match(/\/images\/[^/]+\/sync$/)) {const image = images.find((item) => item.id === url.pathname.split("/")[4]); image.host_readiness[0].status = "SYNCING"; return send(res, {submitted: 1});}
  if (url.pathname === api + "/networks") return send(res, {items: [network]});
  if (url.pathname === api + "/ip-addresses") return send(res, paged(ips, url));
  if (url.pathname === api + "/instances") {const rows = instances.filter((item) => url.searchParams.get("scope") !== "mine" || item.owner === current.username); return send(res, {...paged(rows, url), expiring_total: rows.filter((item) => ["RUNNING", "STOPPED", "STARTING", "REBOOTING"].includes(item.lifecycle_status) && new Date(item.expires_at) > new Date() && new Date(item.expires_at) < new Date(Date.now() + 86400000)).length});}
  if (url.pathname === api + "/approvals") return send(res, paged(approvals, url));
  if (url.pathname === api + "/applications" && req.method === "GET") return send(res, paged(applications.filter((item) => current.role === "ADMIN" && url.searchParams.get("scope") !== "mine" ? true : item.applicant === current.username), url));
  if (url.pathname === api + "/approval-delegation") {if (req.method === "PUT") delegation = input.delegate_username ? input : null; return send(res, {delegation, administrators: [users[0], {username: "fixture-backup", display_name: "隔离代理管理员"}]});}
  if (url.pathname.match(/\/approvals\/[^/]+\/transfer$/)) {const item = approvals.find((row) => row.id === url.pathname.split("/")[4]); item.assigned_reviewer = input.reviewer_username; return send(res, item);}
  if (url.pathname === api + "/platform-policy") {if (req.method === "PUT") policy = input; return send(res, policy);}
  if (url.pathname === api + "/ldap/status") return send(res, ldap);
  if (url.pathname === api + "/ldap/config") {ldap = {...ldap, ...input, configured: true, requested_enabled: input.enabled, enabled: input.enabled, has_bind_password: Boolean(input.bind_password)}; return send(res, ldap);}
  if (url.pathname === api + "/notifications/config") {if (req.method === "PUT") notifications = {...notifications, ...input}; return send(res, notifications);}
  if (url.pathname === api + "/notifications/events") return send(res, {items: [], total: 0, page: 1, page_size: 20});
  if (url.pathname === api + "/audit-logs") return send(res, {items: [], total: 0, page: 1, page_size: 20, actions: [], resource_types: []});
  if (url.pathname.match(/\/instances\/[^/]+\/auto-renew$/)) {const id = url.pathname.split("/")[4]; if (req.method === "PUT") auto[id] = {...input, renewed_count: 0, last_error: ""}; return send(res, {...(auto[id] || {enabled: false, hours: 24, max_renewals: 2, renewed_count: 0, last_error: ""}), platform_enabled: policy.auto_renew_enabled, platform_max_count: policy.auto_renew_max_count, platform_max_hours: policy.auto_renew_hours});}
  if (url.pathname.match(/\/instances\/[^/]+\/metrics$/)) {const now = Date.now(); return send(res, {hours: 24, items: Array.from({length: 24}, (_, index) => ({collected_at: new Date(now - (23 - index) * 3600000).toISOString(), cpu_usage_percent: 8 + (index % 8) * 4, memory_usage_mb: 620 + (index % 6) * 95, memory_metric_source: "guest_unused"}))});}
  if (url.pathname.match(/\/instances\/[^/]+$/)) {const item = instances.find((row) => row.id === url.pathname.split("/")[4]); return send(res, {instance: {...item, flavor: flavors[0], image: images[0]}, audit_logs: [], tasks: [{task_type: "CREATE_INSTANCE", status: "SUCCEEDED", attempt: 1, max_attempts: 3}]});}
  if (url.pathname === api + "/applications") {return send(res, {request_no: "QA-CREATE", connection: {ip_address: "10.30.0.120", username: "ubuntu", password: "Fixture-only-password123!"}});}
  if (url.pathname === api + "/history/archives") {
    if (req.method === "POST") {const data = zlib.gzipSync('{"fixture":"只包含隔离测试数据"}\n'); archives.push({id: crypto.randomUUID(), category: input.category, checksum: crypto.createHash("sha256").update(data).digest("hex"), row_count: 1, created_at: new Date().toISOString(), created_by: current.username, size_bytes: data.length, data}); return send(res, archives[archives.length - 1]);}
    return send(res, {items: archives.map(({data, ...item}) => item)});
  }
  if (url.pathname.includes("/history/archives/")) {const item = archives.find((row) => row.id === url.pathname.split("/")[5]); if (url.pathname.endsWith("/download")) {item.downloaded_at = new Date().toISOString(); res.setHeader("Content-Type", "application/gzip"); return res.end(item.data);} if (input.checksum !== item.checksum) return send(res, {error: "校验和不一致"}, 422); if (req.method === "DELETE") archives = archives.filter((row) => row.id !== item.id); else item.purged_at = new Date().toISOString(); return send(res, {});}
  return send(res, {error: "隔离服务未实现此测试路由"}, 404);
});
server.listen(18882, "127.0.0.1", () => console.log("隔离浏览器服务：http://127.0.0.1:18882"));
