const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const isolated = {id: "ip/1?next=bad", address: "192.0.2.130", status: "QUARANTINED", instance_id: null, probe_pending: false, last_probe_status: "UNKNOWN"};
const network = {id: "network/1", name: "隔离回归网络", cidr: "192.0.2.0/24", gateway: "192.0.2.1", bridge: "br0", enabled: true, quarantined: 40, free: 2, allocated: 1, total: 43};
function response(payload, status = 200) { return {status, ok: status >= 200 && status < 300, json: async () => payload}; }
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return {promise, resolve}; }
function element() {
  const classes = new Set();
  return {innerHTML: "", textContent: "", value: "", children: [], dataset: {}, disabled: false, isConnected: true,
    classList: {add: (...names) => names.forEach((name) => classes.add(name)), remove: (name) => classes.delete(name), toggle() {}},
    focus() {}, closest() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; },
    replaceChildren() { this.innerHTML = ""; this.children = []; }, appendChild(child) { this.children.push(child); }, setAttribute() {},
  };
}
function browser() {
  const nodes = new Map(), arrays = new Map(), timers = new Map();
  for (const selector of ["#modal-root", "#alert-root", "#notification-center", "#content", "#page-title", "#api-state", "#app-shell", "#login-screen", "#login-error", "#logout-button", "#password-button", "#current-user", "#current-role", "#user-avatar", "#approval-nav-count", "#login-description", "#login-form", "#login-form [type=submit]", "#login-form [type=submit] span", "#login-form [name=source]", "#login-form [name=username]"]) nodes.set(selector, element());
  const get = (selector) => nodes.get(selector) || null;
  const form = get("#login-form"); form.elements = {source: {value: "LOCAL"}};
  const document = {activeElement: element(), hidden: false, querySelector: get, querySelectorAll: (selector) => arrays.get(selector) || [], addEventListener() {}, createElement: () => element()};
  const window = {location: {hash: "", origin: "http://fixture.test", href: "http://fixture.test/"}, history: {replaceState(_state, _title, hash) { window.location.hash = hash; }}, addEventListener() {}};
  let timerID = 0;
  const context = vm.createContext({document, window, location: window.location, URL, URLSearchParams, AbortController, console, navigator: {}, FormData: class {},
    fetch: () => new Promise(() => {}), setTimeout(fn) { const id = ++timerID; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); }, setInterval() {}, requestAnimationFrame() {},
  });
  for (const file of ["web/notifications.js", "web/platform.js", "web/app.js"]) vm.runInContext(read(file), context);
  const b = {context, get, nodes, arrays, timers, document, run: (code) => vm.runInContext(code, context), notices: [], modals: []};
  context.toast = (message, type, options) => b.notices.push({message, type, options});
  context.showFormModal = (spec) => { b.modals.push(spec); return element(); };
  b.run('state.currentUser={role:"ADMIN",username:"fixture-admin",source:"LOCAL"};state.page="network";');
  return b;
}

test("仅管理员可探测未绑定、未排队的隔离IP，已分配保留地址没有解除入口", async () => {
  const b = browser();
  assert.equal(b.context.canProbeIP(isolated), true);
  for (const change of [{status: "FREE"}, {status: "ALLOCATED"}, {status: "RESERVED"}, {instance_id: "retained-instance"}, {probe_pending: true}, {last_probe_status: "PENDING"}]) {
    const ip = {...isolated, ...change};
    assert.equal(b.context.canProbeIP(ip), false);
    assert.ok(!b.context.ipProbeRow(ip).includes("data-ip-probe="));
    await assert.rejects(b.context.requestIPProbe(ip, true), /只能复核/);
  }
  b.run('state.currentUser={role:"USER"};');
  assert.equal(b.context.canProbeIP(isolated), false);
  assert.ok(!b.context.ipProbeRow(isolated).includes("data-ip-probe="));
  await assert.rejects(b.context.requestIPProbe(isolated), /仅管理员/);
  await assert.rejects(b.context.requestNetworkProbe(network), /仅管理员/);
});

test("探测结果、说明和宿主按文本/属性编码，未知状态不拼接CSS或HTML", () => {
  const b = browser();
  const attack = '说明 <img src=x onerror="alert(1)">';
  const html = b.context.ipProbeRow({...isolated, address: attack, owner: attack, last_probe_message: attack, last_probe_host: attack, last_probe_status: 'bad" onclick="alert(1)'});
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;img"));
  assert.ok(html.includes('data-ip-address="ip/1?next=bad"'));
  assert.ok(html.includes("尚无探测结果"));
  assert.ok(!html.includes('class="pill bad" onclick='));
  for (const [state, label] of [["PENDING", "复核中"], ["FREE", "探测空闲"], ["IN_USE", "检测到占用"], ["ERROR", "探测失败"]]) assert.ok(b.context.ipProbeStatusHTML({...isolated, last_probe_status: state}).includes(label));
});

test("单IP复核和安全解除使用精确布尔值、安全头和编码路径", async () => {
  const b = browser(); const requests = [];
  b.context.fetch = async (url, options) => { requests.push({url, options}); return response({task_id: "probe-task", probe_pending: true, message: "已提交探测，尚未解除隔离"}, 202); };
  await b.context.requestIPProbe(isolated, false);
  await b.context.requestIPProbe(isolated, true);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.url, "/api/v1/ip-addresses/ip%2F1%3Fnext%3Dbad/probe");
    assert.equal(request.options.method, "POST");
    assert.equal(request.options.headers["X-VMP-Request"], "1");
    assert.equal(request.options.credentials, "same-origin");
  }
  assert.equal(JSON.parse(requests[0].options.body).release_if_free, false);
  assert.equal(JSON.parse(requests[1].options.body).release_if_free, true);
});

test("同一IP在途只能提交一次，服务失败后可重新核对而不误报成功", async () => {
  const b = browser(); const pending = deferred(); let requests = 0;
  b.context.fetch = async () => { requests++; return pending.promise; };
  const first = b.context.requestIPProbe(isolated);
  await assert.rejects(b.context.requestIPProbe(isolated, true), /已提交探测/);
  assert.equal(requests, 1);
  pending.resolve(response({error: "没有可用宿主机完成探测"}, 409));
  await assert.rejects(first, /没有可用宿主机/);
  assert.equal(b.run("pendingIPProbeRequests.size"), 0);
  assert.equal(b.notices.length, 0);
});

test("批量复核默认32且最多64，返回排队跳过剩余数量而非解除成功", async () => {
  const b = browser(); let request;
  const result = {queued: 32, skipped: 2, limit: 32, max_limit: 64, remaining: 8, confirmed_in_use: 5, message: "批量复核任务已排队"};
  b.context.fetch = async (url, options) => { request = {url, options}; return response(result, 202); };
  await b.context.requestNetworkProbe(network);
  assert.equal(request.url, "/api/v1/networks/network%2F1/probe-quarantined");
  assert.deepEqual(JSON.parse(request.options.body), {release_if_free: true, limit: 32});
  assert.equal(request.options.headers["X-VMP-Request"], "1");
  for (const value of [0, 65, 1.5, NaN]) await assert.rejects(b.context.requestNetworkProbe(network, value), /1 至 64/);
  b.context.notifyIPProbeSubmitted(result, true);
  const notice = b.notices.at(-1);
  for (const part of ["排队 32", "跳过 2", "上限 32", "异常待查 8", "已确认占用 5", "仍保持隔离", "排队不等于已解除"]) assert.ok(notice.message.includes(part));
  assert.equal(notice.type, "info");
  assert.ok(!notice.message.includes("解除成功"));
});

test("解除和批量入口明确探测条件、DHCP边界、地址上限，没有强制清空选项", () => {
  const b = browser();
  b.context.openIPProbeReleaseModal(isolated);
  const single = b.modals.at(-1);
  assert.ok(single.description.includes("只有探测成功"));
  assert.ok(single.description.includes("不能强制清空"));
  assert.ok(single.content.includes("DHCP"));
  b.context.openNetworkProbeModal(network);
  const batch = b.modals.at(-1);
  assert.ok(batch.description.includes("默认每轮 32"));
  assert.ok(batch.content.includes('name="limit"'));
  assert.ok(batch.content.includes('max="64"'));
});

test("网络表列出本页地址而非把隔离等同占用，所有新消息编码", async () => {
  const b = browser();
  const attack = "异常 <script>alert(1)</script>";
  b.context.fetch = async (url) => response(url === "/api/v1/networks" ? {items: [network]} : {items: [isolated, {...isolated, id: "free", address: "192.0.2.131", status: "FREE", last_probe_status: "FREE", last_probe_message: attack, last_probe_host: attack}], total: 2, page: 1, page_size: 20});
  const html = await b.context.network();
  for (const text of ["空闲 / 隔离", "批量复核隔离 IP", "本页地址状态与最近探测", "探测并解除隔离", "DHCP 动态地址池", "最近探测 / 宿主"]) assert.ok(html.includes(text));
  assert.ok(!html.includes("本页已占用 IP"));
  assert.ok(html.includes("192.0.2.131"));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("已有pending提示按原消息展示，不把仅探测或重复请求说成已解除", () => {
  const b = browser();
  b.context.notifyIPProbeSubmitted({already_pending: true, probe_pending: true, message: "已有探测任务，本次不会升级为解除操作"});
  assert.equal(b.notices[0].options.title, "已有 IP 复核任务");
  assert.ok(b.notices[0].message.includes("不会升级"));
  b.context.notifyIPProbeSubmitted({probe_pending: true});
  assert.ok(b.notices[1].message.includes("尚未解除隔离"));
});

test("实例retry复核响应显示复核中和真实消息，不误报已创建", async () => {
  const b = browser(); const button = element();
  button.dataset = {instanceAction: "retry", instanceId: "instance/1", instanceName: "隔离测试实例"};
  b.arrays.set("[data-instance-action]", [button]);
  b.context.fetch = async () => response({status: "ERROR", recovery_pending: true, message: "IP正在复核，成功后自动继续原创建"}, 202);
  b.context.render = async () => {};
  b.context.bind();
  await button.onclick();
  assert.equal(b.notices[0].options.title, "正在复核隔离 IP");
  assert.equal(b.notices[0].type, "info");
  assert.ok(b.notices[0].message.includes("自动继续原创建"));
  const pending = b.context.instanceActions({id: "i", lifecycle_status: "ERROR", ip_recovery_pending: true});
  assert.ok(pending.includes("IP 复核中"));
  assert.ok(!pending.includes('data-instance-action="retry"'));
  assert.ok(b.context.deliveryProgress({lifecycle_status: "ERROR", ip_recovery_pending: true, ip_recovery_message: "复核 <img src=x>"}, []).includes("复核 &lt;img"));
});

test("旧探测响应不能跨会话和导航显示，旧网络响应不覆盖新页面", async () => {
  const b = browser(); const pending = deferred();
  b.context.fetch = async () => pending.promise;
  const probe = b.context.requestIPProbe(isolated);
  b.context.beginSession();
  pending.resolve(response({message: "旧管理员探测数据"}, 202));
  await assert.rejects(probe, /页面或登录会话已更新/);
  assert.equal(b.run("pendingIPProbeRequests.size"), 0);
  const old = deferred();
  b.context.fetch = async (url) => url === "/api/v1/networks" ? response({items: [network]}) : old.promise;
  b.run('pages.images=async()=>"当前镜像页面";');
  const previous = b.context.render("network");
  await Promise.resolve();
  await b.context.render("images");
  old.resolve(response({items: [isolated], total: 1}));
  await previous;
  assert.equal(b.get("#content").innerHTML, "当前镜像页面");
});

test("网络轮询保留筛选焦点、刷新结果与卡片并在弹窗期间暂停", async () => {
  const b = browser(); const results = element(), cards = element(), search = element();
  search.value = "192.0.2.130"; b.document.activeElement = search;
  b.nodes.set("[data-page-results]", results); b.nodes.set("[data-live-network-cards]", cards);
  const nextResults = element(), nextCards = element(); nextResults.innerHTML = "新的IP结果"; nextCards.innerHTML = "新的隔离数量";
  b.document.createElement = () => ({innerHTML: "", content: {querySelector: (selector) => selector === "[data-page-results]" ? nextResults : selector === "[data-live-network-cards]" ? nextCards : null}});
  let requests = 0; b.context.fixtureNetworkPage = async () => { requests++; return "局部结果"; };
  b.run("pages.network=fixtureNetworkPage;");
  await b.context.refreshPageData(false);
  assert.equal(results.innerHTML, "新的IP结果"); assert.equal(cards.innerHTML, "新的隔离数量");
  assert.equal(b.document.activeElement, search); assert.equal(search.value, "192.0.2.130");
  b.get("#modal-root").children.push(element());
  await b.context.refreshPageData(false);
  assert.equal(requests, 1);
  assert.ok(read("web/app.js").includes('"images", "network"].includes(state.page)'));
});

test("窄屏仅表格内部滚动，网卡和探测说明有溢出约束", () => {
  const css = read("web/management.css");
  assert.ok(css.includes(".network-ip-table .table-scroll"));
  assert.ok(css.includes("overflow-x: auto"));
  assert.ok(css.includes(".network-ip-results, .network-ip-table, .network-grid"));
  assert.ok(css.includes(".network-probe-message"));
});

test("解除后按钮消失将焦点保留在同一地址行，中文输入期间不刷新", async () => {
  const b = browser(); const results = element(), oldRow = element(), newRow = element(), button = element();
  oldRow.dataset.ipAddress = isolated.id; newRow.dataset.ipAddress = isolated.id;
  button.dataset.ipProbeRelease = JSON.stringify(isolated);
  button.closest = (selector) => selector === "[data-ip-address]" ? oldRow : null;
  b.document.activeElement = button;
  newRow.focus = () => { b.document.activeElement = newRow; };
  b.arrays.set("[data-ip-address]", [newRow]); b.nodes.set("[data-page-results]", results);
  const next = element(); next.innerHTML = "解除后的空闲行";
  b.document.createElement = () => ({innerHTML: "", content: {querySelector: (selector) => selector === "[data-page-results]" ? next : null}});
  let refreshes = 0; b.context.fixtureNetworkPage = async () => { refreshes++; return "新的IP状态"; };
  b.run("pages.network=fixtureNetworkPage;");
  await b.context.refreshPageData(false);
  assert.equal(b.document.activeElement, newRow);
  assert.equal(results.innerHTML, "解除后的空闲行");
  b.nodes.set('[data-list-filter][data-composing="true"]', element());
  await b.context.refreshPageData(false);
  assert.equal(refreshes, 1);
});

test("真实bind卡片冒泡：批量按钮及子图标不清弹窗和搜索，普通卡片点击可切网络", () => {
  const b = browser(), card = element(), button = element(), icon = element();
  card.dataset.selectNetwork = network.id;
  button.dataset.networkProbe = JSON.stringify(network);
  button.closest = (selector) => selector === "button,a,input,select,textarea,label" ? button : null;
  icon.closest = (selector) => selector === "button,a,input,select,textarea,label" ? button : null;
  b.arrays.set("[data-network-probe]", [button]);
  b.arrays.set("[data-select-network]", [card]);
  b.run('state.selectedNetworkID="原网络";state.listFilters.ips.keyword="192.0.2.130";state.listFilters.ips.page=3;');
  let renders = 0;
  b.context.render = () => { renders++; b.modals.length = 0; };
  b.context.bindManagement();
  for (const target of [button, icon]) {
    // 先走按钮监听，再按真实DOM顺序冒泡到父卡片的监听。
    const event = {target, currentTarget: button};
    button.onclick(event);
    event.currentTarget = card;
    card.onclick(event);
    assert.equal(renders, 0);
    assert.ok(b.modals.at(-1).title.includes("批量复核隔离 IP"));
    assert.equal(b.run("state.selectedNetworkID"), "原网络");
    assert.equal(b.run("state.listFilters.ips.keyword"), "192.0.2.130");
    assert.equal(b.run("state.listFilters.ips.page"), 3);
  }
  for (const tag of ["a", "input", "select", "textarea", "label"]) {
    const control = element(); control.closest = () => ({tagName: tag.toUpperCase()});
    card.onclick({target: control, currentTarget: card});
    assert.equal(renders, 0);
  }
  const title = element();
  card.onclick({target: title, currentTarget: card});
  assert.equal(renders, 1);
  assert.equal(b.run("state.selectedNetworkID"), network.id);
  assert.equal(b.run("state.listFilters.ips.keyword"), "");
  assert.equal(b.run("state.listFilters.ips.page"), 1);
});
