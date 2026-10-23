const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const host = {id: "7e418a5f-607a-49e3-8c55-c0e8904897a0", name: "隔离测试宿主", management_ip: "192.0.2.21", credential_status: "MISSING", credential_generation: 0};
const token = "vmpa_" + "x".repeat(43);
function response(payload, status = 200) {
  return {status, ok: status >= 200 && status < 300, json: async () => payload};
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return {promise, resolve};
}
function element() {
  const selectors = new Map();
  const classes = new Set();
  let html = "";
  const node = {
    textContent: "", value: "", children: [], dataset: {}, disabled: false, isConnected: true,
    classList: {add: (...names) => names.forEach((name) => classes.add(name)), remove: (name) => classes.delete(name), contains: (name) => classes.has(name), toggle() {}},
    querySelector(selector) { if (!selectors.has(selector)) selectors.set(selector, element()); return selectors.get(selector); },
    querySelectorAll() { return []; }, focus() {}, setAttribute() {},
    replaceChildren() { this.innerHTML = ""; },
  };
  Object.defineProperty(node, "innerHTML", {
    get: () => html,
    set(value) { html = value; node.children = value ? [element()] : []; },
  });
  return node;
}
function browser() {
  const nodes = new Map();
  const get = (selector) => { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); };
  const listeners = new Map();
  const timers = new Map();
  let timerID = 0;
  const window = {location: {hash: "", href: "http://fixture.test/", origin: "http://fixture.test"}, history: {replaceState(_state, _title, hash) { window.location.hash = hash; }}, addEventListener(name, fn) { listeners.set(name, fn); }};
  const document = {activeElement: element(), hidden: false, querySelector: get, querySelectorAll: () => [], addEventListener() {}};
  const context = vm.createContext({document, window, location: window.location, URL, URLSearchParams, AbortController, console, navigator: {},
    fetch: () => new Promise(() => {}),
    setTimeout(fn) { const id = ++timerID; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); }, setInterval() {}, requestAnimationFrame() {},
  });
  for (const file of ["web/mobile-navigation.js", "web/notifications.js", "web/platform.js", "web/app.js"]) vm.runInContext(read(file), context);
  const b = {context, get, listeners, timers, run: (code) => vm.runInContext(code, context), copied: [], notices: [], modals: []};
  context.toast = (message, type) => b.notices.push({message, type});
  context.copyText = async (value) => { b.copied.push(value); };
  context.showFormModal = (specification) => {
    if (b.form) b.form.isConnected = false;
    const form = element();
    form.elements = {confirmed_host_ready: {checked: false}};
    const saved = element();
    saved.checked = false;
    const submit = element();
    const copies = ["id", "token", "env"].map((kind) => { const button = element(); button.dataset.copyHostCredential = kind; return button; });
    form.querySelector = (selector) => selector === "[data-host-credentials-saved]" ? saved : submit;
    form.querySelectorAll = (selector) => selector === "[data-copy-host-credential]" ? copies : [];
    b.modals.push(specification); b.form = form; b.saved = saved; b.submit = submit; b.copies = copies;
    const modal = get("#modal-root");
    modal.innerHTML = specification.content;
    modal.querySelector = (selector) => selector === "#modal-form" && modal.innerHTML ? b.form : null;
    return form;
  };
  b.run('state.currentUser={role:"ADMIN",username:"fixture-admin",source:"LOCAL"};state.page="hosts";');
  b.issue = () => { context.openHostCredentialModal({...host}); return b.modals.at(-1); };
  return b;
}

test("管理员卡片显示真实凭据元数据，兼容未上报字段且普通用户没有入口", async () => {
  const b = browser();
  b.context.fetch = async () => response({items: [host, {...host, id: "second", credential_status: "ACTIVE", credential_generation: 4}, {...host, id: "third", credential_status: "REVOKED"}, {id: "legacy", name: "旧宿主"}]});
  const html = await b.context.hosts();
  for (const label of ["签发凭据", "轮换凭据", "重新签发凭据", "凭据状态未上报", "代次 4", "192.0.2.21"]) assert.ok(html.includes(label));
  assert.ok(html.includes("data-page-results"));
  assert.ok(!html.includes("runtime_token"));
  b.run('state.currentUser={role:"USER"};');
  assert.ok(!(await b.context.hosts()).includes("data-host-credentials="));
  b.context.openHostCredentialModal(host);
  assert.equal(b.modals.length, 0);
});

test("目标名称、UUID、管理IP按上下文编码，签发只需一个明确确认项", () => {
  const b = browser();
  b.context.openHostCredentialModal({...host, name: '<img src=x onerror="alert(1)">', management_ip: '<script>secret</script>'});
  const spec = b.modals.at(-1);
  assert.ok(!spec.content.includes("<img"));
  assert.ok(!spec.content.includes("<script>"));
  assert.ok(spec.content.includes("&lt;img"));
  assert.ok(spec.content.includes(host.id));
  assert.equal((spec.content.match(/type="checkbox"/g) || []).length, 1);
  assert.ok(spec.content.includes("旧凭据立即失效"));
});

test("未确认停Agent和排空任务时不会发签发请求", async () => {
  const b = browser();
  const spec = b.issue();
  let requests = 0;
  b.context.fetch = async () => { requests++; return response({}); };
  await assert.rejects(spec.onSubmit(null, b.form), /Agent 已停止/);
  assert.equal(requests, 0);
});

test("签发请求使用安全头，成功仅显示一次并分别复制UUID、令牌和两行env", async () => {
  const b = browser();
  const spec = b.issue();
  const originalForm = b.form;
  originalForm.elements.confirmed_host_ready.checked = true;
  const issued = {host_id: host.id, runtime_token: token, generation: 1, status: "CORDONED"};
  let request;
  b.context.fetch = async (url, options) => { request = {url, options}; return response(issued); };
  await spec.onSubmit(null, originalForm);
  assert.equal(request.url, "/api/v1/hosts/" + host.id + "/credentials/rotate");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers["X-VMP-Request"], "1");
  assert.equal(request.options.credentials, "same-origin");
  assert.equal(b.modals.at(-1).title, "宿主凭据已签发");
  assert.equal(issued.runtime_token, "");
  assert.equal(b.run("state.credentialModalPending"), true);
  assert.equal(b.submit.disabled, true);
  assert.ok(!b.run("JSON.stringify(state)").includes(token));
  assert.ok(!b.modals.at(-1).content.includes("data-copy-value"));
  for (const button of b.copies) await button.onclick();
  assert.deepEqual(b.copied, [host.id, token, `AGENT_HOST_ID=${host.id}\nAGENT_RUNTIME_TOKEN=${token}`]);
  const envLines = b.copied[2].split("\n");
  assert.equal(envLines.length, 2);
  assert.equal(envLines[0].slice("AGENT_HOST_ID=".length), host.id);
  assert.equal(envLines[1].slice("AGENT_RUNTIME_TOKEN=".length), token);
  assert.ok(!b.copied[2].includes("\\n"));
  b.saved.checked = true;
  b.saved.onchange({target: b.saved});
  assert.equal(b.submit.disabled, false);
  await b.modals.at(-1).onSubmit();
  assert.equal(b.run("hostCredentialSecret"), null);
  assert.equal(b.get("#modal-root").innerHTML, "");
  assert.ok(b.notices.some((notice) => notice.message.includes("旧值已失效")));
  assert.ok(!b.notices.some((notice) => notice.message.includes(token)));
  assert.ok(b.timers.size > 0);
});

test("失败不显示成功凭据，重复点击及在途关闭/导航/退出受保护", async () => {
  const b = browser();
  const spec = b.issue();
  const originalForm = b.form;
  originalForm.elements.confirmed_host_ready.checked = true;
  const pending = deferred();
  let requests = 0;
  b.context.fetch = async () => { requests++; return pending.promise; };
  const issue = spec.onSubmit(null, originalForm);
  assert.equal(b.run("state.hostCredentialRequestPending"), true);
  await assert.rejects(spec.onSubmit(null, originalForm), /请勿重复提交/);
  assert.equal(b.context.closeModal(), false);
  await b.context.render("images");
  await b.context.logout();
  assert.equal(b.run("state.page"), "hosts");
  let prevented = false;
  b.listeners.get("beforeunload")({preventDefault() { prevented = true; }});
  assert.equal(prevented, true);
  pending.resolve(response({error: "宿主仍有在途任务"}, 409));
  await assert.rejects(issue, /在途任务/);
  assert.equal(requests, 1);
  assert.equal(b.modals.length, 1);
  assert.equal(b.run("hostCredentialSecret"), null);
  assert.equal(b.run("state.hostCredentialRequestPending"), false);
});

test("网络错误或响应对象不匹配时明确结果不确定，不误报成功", async () => {
  for (const result of [null, {host_id: "错误目标", runtime_token: token}, {host_id: host.id, runtime_token: "非法\n内容"}]) {
    const b = browser();
    const spec = b.issue(); b.form.elements.confirmed_host_ready.checked = true;
    b.context.fetch = async () => { if (result === null) throw new Error("network failure"); return response(result); };
    await assert.rejects(spec.onSubmit(null, b.form), /旧值可能已失效/);
    assert.equal(b.modals.length, 1);
    assert.equal(b.run("hostCredentialSecret"), null);
    assert.equal(b.notices.length, 0);
  }
});

test("迟到的签发响应和旧表单不能跨登录会话泄露或轮换", async () => {
  const b = browser();
  const spec = b.issue(); const originalForm = b.form;
  originalForm.elements.confirmed_host_ready.checked = true;
  const pending = deferred();
  let requests = 0;
  b.context.fetch = async () => { requests++; return pending.promise; };
  const issue = spec.onSubmit(null, originalForm);
  b.context.showLogin();
  b.context.applyCurrentUser({role: "ADMIN", username: "another-admin", source: "LOCAL"});
  originalForm.isConnected = false;
  pending.resolve(response({host_id: host.id, runtime_token: token}));
  await assert.rejects(issue, /页面或登录会话已更新/);
  await assert.rejects(spec.onSubmit(null, originalForm), /页面或登录会话已更新/);
  assert.equal(requests, 1);
  assert.equal(b.run("hostCredentialSecret"), null);
  assert.ok(!b.get("#modal-root").innerHTML.includes(token));
});

test("未保存离开确认文案为宿主凭据，确认后销毁令牌；旧复制闭包失效", async () => {
  const b = browser();
  const spec = b.issue(); b.form.elements.confirmed_host_ready.checked = true;
  b.context.fetch = async () => response({host_id: host.id, runtime_token: token});
  await spec.onSubmit(null, b.form);
  const oldCopy = b.copies[1].onclick;
  assert.equal(b.context.closeModal(), false);
  assert.ok(b.get("#alert-root").innerHTML.includes("宿主凭据尚未确认保存"));
  assert.match(b.get("#alert-root").innerHTML, /class="alert-symbol"/);
  assert.ok(!b.get("#alert-root").innerHTML.includes("实例详情重新重置"));
  b.get("#alert-root").querySelector("[data-discard-credentials]").onclick();
  assert.equal(b.run("hostCredentialSecret"), null);
  await assert.rejects(oldCopy(), /页面或登录会话已更新/);
});

test("退出和pagehide清空一次性holder，不持久化令牌", async () => {
  for (const clear of ["showLogin", "pagehide"]) {
    const b = browser(); const spec = b.issue(); b.form.elements.confirmed_host_ready.checked = true;
    b.context.fetch = async () => response({host_id: host.id, runtime_token: token});
    await spec.onSubmit(null, b.form);
    const secret = b.run("hostCredentialSecret");
    if (clear === "showLogin") b.context.showLogin(); else b.listeners.get("pagehide")();
    assert.equal(secret.runtimeToken, "");
    assert.equal(secret.hostID, "");
    assert.equal(b.run("hostCredentialSecret"), null);
  }
});

test("复制失败不提示成功，审计与列表搜索语义一致且日期不受影响", async () => {
  const b = browser(); const spec = b.issue(); b.form.elements.confirmed_host_ready.checked = true;
  b.context.fetch = async () => response({host_id: host.id, runtime_token: token});
  await spec.onSubmit(null, b.form);
  b.context.copyText = async () => { throw new Error("浏览器复制失败"); };
  await assert.rejects(b.copies[1].onclick(), /复制失败/);
  assert.equal(b.notices.length, 0);
  const toolbar = b.context.listToolbar("users", "搜索用户名");
  assert.ok(toolbar.includes('type="search" class="list-search"'));
  b.context.fetch = async () => response({items: [], total: 0, page: 1, page_size: 20});
  const audit = await b.context.auditPage();
  assert.ok(audit.includes('type="search" class="list-search"'));
  for (const label of ["审计来源", "审计动作", "审计资源类型", "审计结果"]) assert.ok(audit.includes('aria-label="' + label + '"'));
  assert.ok(audit.includes('type="date"'));
  assert.ok(!audit.includes("⌕"));
});
