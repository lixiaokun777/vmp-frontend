const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function element() {
  const classes = new Set();
  const children = [];
  return {
    innerHTML: "", textContent: "", value: "", hidden: false, disabled: false, dataset: {}, style: {}, children,
    isConnected: true,
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name), toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } },
    focus() {}, matches() { return false; }, setAttribute() {},
    replaceChildren() { this.innerHTML = ""; children.splice(0); },
    appendChild(child) { children.push(child); }, remove() {}, querySelector() { return element(); }, querySelectorAll() { return []; },
  };
}
function browser(options = {}) {
  const nodes = new Map();
  const get = (selector) => nodes.get(selector);
  ["#modal-root", "#alert-root", "#notification-center", "#content", "#page-title", "#api-state", "#app-shell", "#login-screen", "#login-error", "#logout-button", "#password-button", "#current-user", "#current-role", "#user-avatar", "#approval-nav-count", "#login-description"].forEach((selector) => nodes.set(selector, element()));
  const form = element();
  const submit = element();
  const span = element();
  submit.querySelector = () => span;
  form.elements = { username: {value: "fixture"}, password: {value: "fixture-only"}, source: {value: "LOCAL"} };
  form.reset = () => { form.elements.source.value = "LOCAL"; };
  form.querySelector = () => submit;
  nodes.set("#login-form", form);
  nodes.set("#login-form [type=submit]", submit);
  nodes.set("#login-form [type=submit] span", span);
  nodes.set("#login-form [name=source]", form.elements.source);
  nodes.set("#login-form [name=username]", element());
  const tabs = [element(), element()];
  tabs[0].dataset.loginSource = "LOCAL";
  tabs[1].dataset.loginSource = "LDAP";
  const timers = new Map();
  let timerID = 0;
  const document = { hidden: false, activeElement: element(), body: element(), addEventListener() {}, querySelector: (selector) => get(selector) || null, querySelectorAll: (selector) => selector === "[data-login-source]" ? tabs : [], createElement: () => element() };
  const window = { location: {hash: "", href: "http://fixture.test/", origin: "http://fixture.test", protocol: "http:"}, history: {replaceState(_state, _title, route) { window.location.hash = route; }}, addEventListener() {} };
  const context = vm.createContext({ document, window, location: window.location, console, URL, URLSearchParams, AbortController, Blob, navigator: {},
    setTimeout(callback) { const id = ++timerID; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); }, setInterval() { return 0; }, requestAnimationFrame(callback) { callback(); },
    fetch: options.fetch || (() => new Promise(() => {})),
    FormData: class { constructor(target) { this.values = Object.entries(target.elements || {}).map(([key, value]) => [key, value.value ?? ""]); } [Symbol.iterator]() { return this.values[Symbol.iterator](); } },
  });
  vm.runInContext(read("web/notifications.js"), context);
  vm.runInContext(read("web/platform.js"), context);
  vm.runInContext(read("web/app.js"), context);
  return { context, get, nodes, tabs, timers, run: (code) => vm.runInContext(code, context) };
}
function response(payload, status = 200) {
  return {status, ok: status >= 200 && status < 300, json: async () => payload};
}

test("旧管理员响应不能在退出后覆盖普通用户页面", async () => {
  const b = browser();
  const old = deferred();
  b.context.oldPage = old.promise;
  b.run('state.currentUser={role:"ADMIN"}; pages.users=()=>oldPage; pages.apply=async()=>"普通用户申请页面";');
  const pending = b.context.render("users");
  b.context.showLogin();
  b.context.applyCurrentUser({ role: "USER", username: "ordinary", source: "LOCAL" });
  await b.context.render("apply");
  old.resolve("上一个管理员用户表");
  await pending;
  assert.equal(b.get("#content").innerHTML, "普通用户申请页面");
  assert.equal(b.get("#page-title").textContent, "申请虚拟机");
});

test("较晚的旧导航响应不能覆盖新导航", async () => {
  const b = browser();
  const old = deferred();
  b.context.oldPage = old.promise;
  b.run('state.currentUser={role:"ADMIN"}; pages.users=()=>oldPage; pages.images=async()=>"当前镜像页面";');
  const pending = b.context.render("users");
  await b.context.render("images");
  old.resolve("过时用户页面");
  await pending;
  assert.equal(b.get("#content").innerHTML, "当前镜像页面");
});

test("旧页面的 401 不会退出已经登录的新会话", async () => {
  const b = browser();
  const old = deferred();
  b.context.oldPage = old.promise;
  b.run('state.currentUser={role:"ADMIN"}; pages.users=()=>oldPage; pages.apply=async()=>"新用户页面";');
  const pending = b.context.render("users");
  b.context.showLogin();
  b.context.applyCurrentUser({role: "USER", source: "LOCAL", username: "new-user"});
  await b.context.render("apply");
  old.reject(Object.assign(new Error("旧账号已失效"), {status: 401}));
  await pending;
  assert.equal(b.run("state.currentUser.username"), "new-user");
  assert.equal(b.get("#app-shell").hidden, false);
  assert.equal(b.get("#content").innerHTML, "新用户页面");
});

test("启动时在途 auth/me 的旧 401 不会退出之后登录的账号", async () => {
  const old = deferred();
  const b = browser({fetch: () => old.promise});
  b.run('pages.apply=async()=>"新会话";');
  b.context.applyCurrentUser({role: "USER", username: "new-user", source: "LOCAL"});
  await b.context.render("apply");
  old.resolve(response({error: "unauthorized"}, 401));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(b.run("state.currentUser.username"), "new-user");
  assert.equal(b.get("#content").innerHTML, "新会话");
});

test("取消不可靠时仍按会话代际丢弃请求和延迟 JSON", async () => {
  const b = browser();
  const old = deferred();
  let signal;
  b.context.fetch = (_url, options) => { signal = options.signal; return old.promise; };
  const pending = b.run('api("/users")');
  b.context.beginSession();
  assert.equal(signal.aborted, true);
  old.resolve(response({items: ["旧用户数据"]}));
  await assert.rejects(pending, /页面或登录会话已更新/);
  const json = deferred();
  b.context.fetch = async () => ({ok: true, status: 200, json: () => json.promise});
  const bodyPending = b.run('api("/users")');
  await Promise.resolve();
  b.context.beginSession();
  json.resolve({items: ["过时 JSON"]});
  await assert.rejects(bodyPending, /页面或登录会话已更新/);
});

test("所有写请求携带平台自定义防跨站请求头", async () => {
  const b = browser();
  const requests = [];
  b.context.fetch = async (_url, options) => {requests.push(options); return response({});};
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    b.context.requestMethod = method;
    await b.run('api("/fixture", {method: requestMethod, headers: {"X-VMP-Request": "0"}})');
  }
  await b.run('api("/fixture")');
  requests.slice(0, 4).forEach((request) => assert.equal(request.headers["X-VMP-Request"], "1"));
  assert.equal(requests[4].headers["X-VMP-Request"], undefined);
});

test("导航清除旧过滤器回调，退出清除用户级缓存", async () => {
  const b = browser();
  b.run('state.currentUser={role:"ADMIN"}; pages.images=async()=>"镜像"; state.listFilters.users.keyword="上一位用户";');
  let called = false;
  b.context.schedulePageWork(() => { called = true; }, 300);
  await b.context.render("images");
  [...b.timers.values()].forEach((callback) => callback());
  assert.equal(called, false);
  b.context.showLogin();
  assert.equal(b.run("state.listFilters.users.keyword"), "");
  assert.equal(b.run("notificationHistoryState.page"), 1);
});

test("申请页面和宿主机字段只能作为文本与属性值", async () => {
  const b = browser();
  const attack = '</option></select><img src=x onerror="alert(1)">';
  const id = 'id" autofocus onfocus="alert(1)';
  const fixtures = {
    "/api/v1/flavors": {items: [{id, name: attack, cpu: 1, memory_mb: 2048, disk_gb: 40}]},
    "/api/v1/images": {items: [{id, name: attack}]},
    "/api/v1/networks": {items: [{id, name: attack, cidr: attack, enabled: true, free: attack}]},
    "/api/v1/hosts": {items: [{id, name: attack, facts: {host: {libvirt_version: attack, hypervisor_version: attack, bridges: [attack]}}}]},
  };
  b.context.fetch = async (url) => response(fixtures[url]);
  const apply = await b.context.applyPage();
  const hosts = await b.context.hosts();
  assert.ok(!apply.includes("<img"));
  assert.ok(!hosts.includes("<img"));
  assert.ok(apply.includes("&lt;img"));
  assert.ok(apply.includes('value="id&quot; autofocus onfocus=&quot;alert(1)"'));
  assert.ok(b.context.lead(attack, attack).includes("&lt;img"));
  assert.ok(!b.context.status(attack).includes("<img"));
  assert.equal(b.context.pathID("id/next?role=ADMIN"), "id%2Fnext%3Frole%3DADMIN");
});

test("加载错误中的 HTML 不执行，也不能跨导航显示", async () => {
  const b = browser();
  b.run('state.currentUser={role:"ADMIN"}; pages.users=async()=>{throw new Error("异常 <img src=x onerror=alert(1)>")};');
  await b.context.render("users");
  assert.ok(!b.get("#content").innerHTML.includes("<img"));
  assert.ok(b.get("#content").innerHTML.includes("&lt;img"));
});

test("LDAP 首次保存没有同步按钮也可完成并刷新", async () => {
  const b = browser();
  const form = element();
  form.elements = {enabled: {checked: true}, start_tls: {checked: false}, clear_bind_password: {checked: false}, url: {value: "ldaps://fixture.test"}};
  b.nodes.set("#ldap-config-form", form);
  const notices = [];
  let rendered;
  b.context.toast = (message, type) => notices.push({message, type});
  b.context.render = async (page) => { rendered = page; };
  b.context.fetch = async () => response({});
  b.context.bindManagement();
  await form.onsubmit({preventDefault() {}});
  assert.equal(rendered, "ldap");
  assert.equal(notices.length, 1);
  assert.equal(notices[0].message, "LDAP 配置已保存");
});

test("LDAP 登录 reset 后来源、选中状态和文案保持一致", async () => {
  const b = browser();
  const form = b.get("#login-form");
  b.context.setLoginSource("LDAP");
  b.context.render = async () => {};
  b.context.fetch = async () => response({user: {role: "USER", source: "LDAP", username: "ldap-fixture"}});
  await form.onsubmit({preventDefault() {}, currentTarget: form});
  b.context.showLogin();
  assert.equal(form.elements.source.value, "LDAP");
  assert.ok(b.tabs[1].classList.contains("active"));
  assert.equal(b.get("#login-form [type=submit] span").textContent, "LDAP 登录");
});

test("同名规格按 ID 和分配快照聚合，不随套餐变更", () => {
  const b = browser();
  const usage = b.context.flavorUsage([{id: "a", name: "同名", memory_mb: 32768}, {id: "b", name: "同名", memory_mb: 65536}], [
    {flavor_id: "a", lifecycle_status: "RUNNING", resource_snapshot: {memory_mb: 2048}},
    {flavor_id: "b", lifecycle_status: "RETAINED", resource_snapshot: {memory_mb: 8192}},
  ]);
  assert.equal(usage.get("a").reserved, 2048);
  assert.equal(usage.get("b").reserved, 8192);
  assert.equal(usage.get("a").running, 1);
  assert.equal(usage.get("b").retained, 1);
});

test("实例详情展示分配快照而非可变套餐", async () => {
  const b = browser();
  b.run('state.detailInstanceID="fixture";');
  b.context.fetch = async () => response({instance: {name: "fixture", flavor: {cpu: 64, memory_mb: 65536, disk_gb: 1024}, image: {name: "fixture"}, resource_snapshot: {cpu: 1, memory_mb: 2048, disk_gb: 40}}, tasks: [], audit_logs: []});
  const detail = await b.context.instanceDetailPage();
  assert.ok(detail.includes("1C / 2.0 GiB"));
  assert.ok(detail.includes("40 GB 系统盘"));
  assert.ok(!detail.includes("64C /"));
});

test("通知记录中的消息和计数同样编码", () => {
  const b = browser();
  const attack = '<img src=x onerror="alert(1)">';
  const output = b.context.notificationHistory({total: attack, page: attack, items: [{kind: "TEST", status: "SENT", instance_name: attack, owner: attack, attempts: attack, message: attack}]});
  assert.ok(!output.includes("<img"));
  assert.ok(output.includes("&lt;img"));
});

test("通知记录的旧请求不能回写重新登录后的页面", async () => {
  const b = browser();
  const old = deferred();
  const target = element();
  const button = element();
  b.nodes.set("#notification-history", target);
  b.nodes.set("[data-notification-refresh]", button);
  b.run('state.currentUser={role:"ADMIN"}; state.page="notifications";');
  b.context.fetch = () => old.promise;
  b.context.bindNotificationHistory();
  const pending = button.onclick();
  b.context.showLogin();
  b.run('state.currentUser={role:"ADMIN",username:"new-admin"}; state.page="notifications";');
  target.innerHTML = "新会话的发送记录";
  old.resolve(response({total: 0, page: 1, items: []}));
  await pending;
  assert.equal(target.innerHTML, "新会话的发送记录");
});

test("LDAP 目录可用性与管理员停用状态分别展示", () => {
  const b = browser();
  assert.match(b.context.userStatus({source: "LDAP", enabled: true, ldap_directory_present: false}), /LDAP 目录不可用/);
  assert.match(b.context.userStatus({source: "LDAP", enabled: false, ldap_directory_present: true}), /已停用/);
  assert.match(b.context.userStatus({source: "LOCAL", enabled: true, ldap_directory_present: false}), /正常/);
});

test("旧审批执行结果不确定时不提供盲重提入口", () => {
  const b = browser();
  const approval = {id: "fixture", status: "FAILED", request_type: "RENEW", request_no: "APR-fixture", requested_hours: 336, result: {execution_uncertain: true, error: "请先核查"}};
  assert.ok(!b.context.approvalTable([approval]).includes("data-resubmit-short"));
  approval.result.execution_uncertain = false;
  assert.ok(b.context.approvalTable([approval]).includes("data-resubmit-short"));
});

test("静态入口使用禁止内联脚本的 CSP 且不被 location 覆盖", () => {
  const config = read("deployments/nginx.conf");
  assert.match(config, /script-src 'self';/);
  assert.ok(!config.includes("script-src 'self' 'unsafe-inline'"));
  assert.ok(!config.includes("unsafe-eval"));
  assert.match(config, /frame-ancestors 'none'/);
  assert.match(config, /Referrer-Policy "no-referrer"/);
  assert.equal((config.match(/add_header Cache-Control/g) || []).length, 1);
  for (const name of ["web/index.html", "web/console.html"]) assert.ok(!read(name).match(/<script[^>]*>\s*[^<\s]/));
});

test("控制台丢弃 hash 的旧 ws，连接地址必须来自授权接口", async () => {
  const b = browser();
  ["#console-screen", "#console-status", "#console-name", "#console-mode", "#console-reconnect"].forEach((selector) => b.nodes.set(selector, element()));
  b.context.window.location.hash = "#mode=vnc&instance=fixture&ws=ws%3A%2F%2Fevil.test%2Ffake";
  const connections = [];
  b.context.RFB = class {constructor(_screen, endpoint) {connections.push(endpoint);} addEventListener() {} disconnect() {} };
  b.context.fetch = async (url, options) => {assert.equal(url, "/api/v1/instances/fixture/console-sessions"); assert.equal(options.headers["X-VMP-Request"], "1"); return response({websocket_url: "/api/v1/console/vnc?ticket=fixture-ticket"});};
  const consoleContext = vm.createContext({...b.context, document: b.context.document, window: b.context.window});
  vm.runInContext(read("web/console.js").replace(/^import RFB[^\n]*\n/, ""), consoleContext);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!b.context.window.location.hash.includes("ws="));
  assert.deepEqual(connections, ["ws://fixture.test/api/v1/console/vnc?ticket=fixture-ticket"]);
  assert.throws(() => consoleContext.consoleEndpoint("javascript:alert(1)"), /连接地址无效/);
  assert.throws(() => consoleContext.consoleEndpoint("ws://user:pass@agent.fixture.test/api/v1/console/vnc?ticket=x"), /连接地址无效/);
  assert.throws(() => consoleContext.consoleEndpoint("ws://agent.fixture.test/api/v1/console/serial?ticket=x"), /连接地址无效/);
  b.context.window.location.protocol = "https:";
  b.context.window.location.href = "https://fixture.test/";
  assert.throws(() => consoleContext.consoleEndpoint("ws://fixture.test/api/v1/console/vnc?ticket=x"), /连接地址无效/);
  assert.equal(consoleContext.consoleEndpoint("/api/v1/console/vnc?ticket=x"), "wss://fixture.test/api/v1/console/vnc?ticket=x");
  assert.throws(() => consoleContext.consoleEndpoint("wss://agent.fixture.test/api/v1/console/vnc?ticket=x"), /连接地址无效/);
});

test("重新连接后旧控制台事件不能覆盖当前状态", async () => {
  const b = browser();
  ["#console-screen", "#console-status", "#console-name", "#console-mode", "#console-reconnect"].forEach((selector) => b.nodes.set(selector, element()));
  b.context.window.location.hash = "#mode=vnc&instance=fixture";
  const events = [];
  b.context.RFB = class {constructor() {this.listeners={}; events.push(this);} addEventListener(name, callback) {this.listeners[name]=callback;} disconnect() {} };
  b.context.fetch = async () => response({websocket_url: "/api/v1/console/vnc?ticket=fixture"});
  const consoleContext = vm.createContext({...b.context, document: b.context.document, window: b.context.window});
  vm.runInContext(read("web/console.js").replace(/^import RFB[^\n]*\n/, ""), consoleContext);
  await new Promise((resolve) => setImmediate(resolve));
  await consoleContext.requestConnection();
  events[1].listeners.connect();
  events[0].listeners.disconnect({detail: {clean: false}});
  assert.equal(b.get("#console-status").textContent, "已连接");
  assert.equal(events.length, 2);
});

test("用户、实例、审批和 IP 将分页与完整筛选传给服务器", () => {
  const b = browser();
  b.run('state.listFilters.instances={keyword:"用户 & VM",status:"DELETING",host_id:"host-1",page:3,pageSize:50}; state.listFilters.users.status="DIRECTORY_UNAVAILABLE"; state.listFilters.requests.type="RESTORE"; state.listFilters.ips.status="QUARANTINED";');
  const instances = new URL(b.context.listURL("/instances", "instances"), "https://fixture.test");
  assert.equal(instances.searchParams.get("keyword"), "用户 & VM");
  assert.equal(instances.searchParams.get("page"), "3");
  assert.equal(instances.searchParams.get("page_size"), "50");
  assert.equal(instances.searchParams.get("host_id"), "host-1");
  assert.equal(instances.searchParams.get("status"), "DELETING");
  assert.match(b.context.listURL("/users", "users"), /status=DIRECTORY_UNAVAILABLE/);
  assert.match(b.context.listURL("/approvals", "requests", {scope: "mine"}), /scope=mine/);
  assert.match(b.context.listURL("/approvals", "requests"), /type=RESTORE/);
  assert.match(b.context.listURL("/ip-addresses", "ips", {network_id: "net-1"}), /status=QUARANTINED/);
  assert.deepEqual(JSON.parse(b.run('JSON.stringify(lifecycleOptions.map(item=>item[0]))')), ["RUNNING", "STOPPED", "RETAINED", "PROVISIONING", "STARTING", "STOPPING", "REBOOTING", "DELETING", "ERROR"]);
});

test("CSV 明确遍历全部服务端页而不是仅当前页", async () => {
  const b = browser();
  b.run('state.listFilters.users.keyword="qa"; state.listFilters.users.page=3;');
  const requests = [];
  b.context.fetch = async (value) => {
    const url = new URL(value, "https://fixture.test"); requests.push(url);
    const page = Number(url.searchParams.get("page"));
    const offset = (page - 1) * 100;
    return response({items: Array.from({length: page === 1 ? 100 : 30}, (_, index) => ({id: offset + index})), total: 130, page, page_size: 100});
  };
  const items = await b.context.collectExportItems("/users", "users");
  assert.equal(items.length, 130);
  assert.deepEqual(requests.map((url) => url.searchParams.get("page")), ["1", "2"]);
  requests.forEach((url) => {assert.equal(url.searchParams.get("keyword"), "qa"); assert.equal(url.searchParams.get("page_size"), "100");});
});

test("超出 CSV 内存上限明确报错而非静默截断", async () => {
  const b = browser();
  b.context.fetch = async () => response({items: [], total: 10001, page: 1, page_size: 100});
  await assert.rejects(b.context.collectExportItems("/users", "users"), /超过 10000 条/);
});

test("首页与待审批徽标采用服务器总数，不受当前页大小影响", async () => {
  const b = browser();
  b.run('state.currentUser={role:"ADMIN",username:"fixture"};');
  b.context.fetch = async (url) => url.includes("summary") ? response({}) : url.includes("approvals") ? response({items: [{}], total: 72}) : response({items: [], total: 123});
  const html = await b.context.dashboard();
  assert.ok(html.includes("<strong>123</strong>"));
  await b.context.updateApprovalIndicator(false);
  assert.equal(b.get("#approval-nav-count").textContent, "72");
});

test("到期提示使用全账号 expiring_total，不用本页行数冒充", async () => {
  const b = browser();
  b.context.fetch = async () => response({items: [], total: 85, page: 3, page_size: 20, expiring_total: 29});
  const html = await b.context.myInstances();
  assert.ok(html.includes("29 台虚拟机将在 24 小时内到期"));
  assert.ok(html.includes("data-expiring-count=\"29\""));
});

test("规格页面直接读取服务器全量快照聚合，不读取分页实例", async () => {
  const b = browser(); const requests = [];
  b.context.fetch = async (url) => {requests.push(url); return response(url.includes("flavors") ? {items: [{id:"f1",name:"基础",cpu:1,memory_mb:99999,disk_gb:40,usage:{running:35,retained:4,memory_mb:14336}}]} : {allocatable_memory_mb:40960});};
  const html = await b.context.flavors();
  assert.ok(html.includes("14.0 GiB"));
  assert.ok(html.includes("<td>35</td>"));
  assert.ok(!requests.some((url) => url.includes("instances")));
});

test("相同按钮在请求未结束时只能执行一次并统一显示错误", async () => {
  const b = browser(); const button = element(); const pending = deferred(); let calls = 0;
  const operation = () => {calls += 1; return pending.promise;};
  const first = b.context.runButton(button, operation);
  await b.context.runButton(button, operation);
  assert.equal(calls, 1);
  pending.reject(new Error("隔离测试操作失败")); await first;
  assert.equal(button.disabled, false);
  assert.equal(b.run("state.busyCount"), 0);
  assert.equal(b.get("#notification-center").children.length, 1);
});

test("尚未保存凭据的导航先确认，不能直接销毁密码页", async () => {
  const b = browser(); const alert = b.get("#alert-root"); const buttons = new Map();
  alert.querySelector = (selector) => {if (!buttons.has(selector)) buttons.set(selector, element()); return buttons.get(selector);};
  b.run('state.currentUser={role:"USER"}; state.credentialsPending=true; pages.apply=async()=>"确认后新页面";');
  b.get("#content").innerHTML = "一次性凭据页";
  await b.context.render("apply");
  assert.equal(b.get("#content").innerHTML, "一次性凭据页");
  assert.ok(alert.innerHTML.includes("登录密码尚未确认保存"));
  buttons.get("[data-discard-credentials]").onclick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(b.get("#content").innerHTML, "确认后新页面");
  assert.equal(b.run("state.credentialsPending"), false);
});

test("新镜像宿主状态与归档元数据保持编码，清理按钮遵守下载状态", () => {
  const b = browser(); const attack = '<img src=x onerror="alert(1)">';
  const image = b.context.imageReadinessHTML({host_readiness: [{host_name:attack,status:"FAILED",error:attack}]});
  assert.ok(!image.includes("<img"));
  const history = b.context.historySection({items:[{id:attack,category:"audit",checksum:attack,row_count:1}]});
  assert.ok(!history.includes("<img"));
  assert.match(history, /data-purge-archive=[^>]+disabled/);
  assert.match(history, /data-delete-archive=[^>]+disabled/);
});

test("普通用户的平台策略导航被裁剪，已获授权的新页面仍受角色检查", async () => {
  const b = browser(); b.run('state.currentUser={role:"USER"}; pages.dashboard=async()=>"我的概览"; pages.policy=async()=>"管理员策略";');
  await b.context.render("policy");
  assert.equal(b.get("#content").innerHTML, "我的概览");
});

test("普通用户概览成为可见入口并按个人接口读取配额和到期信息", async () => {
  const html = read("web/index.html");
  assert.match(html, /data-page="dashboard"[^>]*>[\s\S]*data-dashboard-label/);
  assert.doesNotMatch(html.match(/<button[^>]*data-page="dashboard"[^>]*>/)?.[0] || "", /data-admin/);
  const b = browser();
  b.context.fetch = async (url) => {
    if (url.endsWith("/api/v1/me/overview")) return response({active_instances: 2, quota_instances: 3, used_cpu: 4, used_memory_mb: 6144, used_disk_gb: 120, nearest_expiry: "2026-10-12T12:00:00Z", expiring_24h: 1, limits: {instances: 5, cpu: 8, memory_mb: 16384, disk_gb: 300}});
    if (url.includes("/api/v1/instances?")) return response({items: [], total: 0, page: 1, page_size: 5});
    throw new Error(`unexpected URL ${url}`);
  };
  b.run('state.currentUser={role:"USER",username:"alice"}');
  const result = await b.context.myOverview();
  assert.match(result, /我的概览/);
  assert.match(result, /2 台/);
  assert.match(result, /4 核 \/ 8 核/);
  assert.match(result, /24 小时内到期/);
});

test("结构化交付错误给出中文自助诊断且监控无数据不伪造零值", () => {
  const b = browser();
  const diagnosis = b.context.failureDiagnosis("IP_PROBE_FAILED", "tool failed");
  assert.equal(diagnosis.title, "IP 探测未完成");
  assert.match(diagnosis.advice, /iputils-arping/);
  const empty = b.context.metricChart([], "cpu_usage_percent", 100, "#000", "%");
  assert.match(empty, /数据采集中/);
  assert.doesNotMatch(empty, />0(?:\.0)?%/);
  const missing = b.context.metricChart([
    {collected_at: "2026-10-12T00:00:00Z", cpu_usage_percent: null},
    {collected_at: "2026-10-12T00:01:00Z", cpu_usage_percent: null},
  ], "cpu_usage_percent", 100, "#000", "%");
  assert.match(missing, /数据采集中/);
  assert.doesNotMatch(missing, />0(?:\.0)?%/);
  const chart = b.context.metricChart([
    {collected_at: "2026-10-12T00:00:00Z", cpu_usage_percent: 10},
    {collected_at: "2026-10-12T00:01:00Z", cpu_usage_percent: 20},
  ], "cpu_usage_percent", 100, "#000", "%");
  assert.match(chart, /20\.0%/);
  assert.match(chart, /24h 平均 15\.0%/);
});
