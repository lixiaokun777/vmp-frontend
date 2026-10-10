const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "web/app.js"), "utf8");
const platformSource = fs.readFileSync(path.join(root, "web/platform.js"), "utf8");
const numberNames = ["max_instances", "max_cpu", "max_memory_mb", "max_disk_gb", "max_future_lease_hours", "max_continuous_lease_hours", "auto_renew_hours", "auto_renew_max_count", "audit_retention_days", "notification_retention_days", "approval_retention_days"];

function helperSource(name) {
  const start = appSource.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `真实页面缺少 ${name} 辅助函数`);
  const end = appSource.indexOf("\n}", start);
  assert.ok(end >= 0, `无法读取 ${name} 辅助函数`);
  return appSource.slice(start, end + 2);
}

function policyBrowser(policy = {}, archives = []) {
  const requests = [];
  const nodes = new Map();
  const modals = [];
  const modalSubmit = {classList: {add() {}}};
  const context = vm.createContext({
    api: async (url, options = {}) => {
      requests.push({url, ...options});
      return url === "/platform-policy" ? policy : {items: archives};
    },
    $: (selector) => nodes.get(selector) || (selector === "#modal-form [type=submit]" ? modalSubmit : null),
    document: {querySelectorAll: () => []},
    state: {page: "policy"},
    fmtDate: () => "2026/10/10 12:00:00",
    runButton: async (_button, callback) => callback(),
    toast() {}, closeModal() {}, protectAsyncButtons() {},
    showFormModal: (options) => modals.push(options),
    FormData: class {
      constructor(form) { this.values = form.values; }
      get(name) { return this.values[name]; }
    },
  });
  // 使用实际字段渲染函数，避免布局回归只验证测试中的假输入框。
  vm.runInContext("let fieldSerial = 0;\n" + ["esc", "numeric", "lead", "field", "pathID"].map(helperSource).join("\n") + "\n" + platformSource, context);
  return {context, requests, nodes, modals};
}

test("平台策略三张全宽分组卡片共享一个表单和一次提交", async () => {
  const policy = Object.fromEntries(numberNames.map((name, index) => [name, index + 1]));
  policy.auto_renew_enabled = true;
  const browser = policyBrowser(policy);
  const html = await browser.context.policyPage();
  assert.equal((html.match(/<form\b/g) || []).length, 1);
  assert.match(html, /<form class="policy-settings-form" id="platform-policy-form">/);
  assert.doesNotMatch(html, /<form class="form-card"/);
  assert.equal((html.match(/class="policy-settings-card /g) || []).length, 3);
  for (const type of ["resource", "renew", "retention"]) {
    assert.match(html, new RegExp(`policy-${type}-card`));
    assert.match(html, new RegExp(`aria-labelledby="policy-${type}-title"`));
  }
  for (const name of numberNames) {
    assert.equal((html.match(new RegExp(`name="${name}"`, "g")) || []).length, 1);
    assert.match(html, new RegExp(`name="${name}"[^>]*type="number"[^>]*value="${policy[name]}"`));
  }
  assert.equal((html.match(/name="auto_renew_enabled"/g) || []).length, 1);
  assert.match(html, /name="auto_renew_enabled" checked/);
  assert.match(html, /name="auto_renew_hours"[^>]*min="0"[^>]*max="168"/);
  assert.equal((html.match(/type="submit"/g) || []).length, 1);
  assert.match(html, /<\/form><section class="resource-table-wrap history-management" data-history-section>/);
  assert.deepEqual(browser.requests.map((item) => item.url).sort(), ["/history/archives", "/platform-policy"]);
});

test("策略重排保留全部数字字段和自动续期的统一保存接口", async () => {
  const browser = policyBrowser();
  const values = Object.fromEntries(numberNames.map((name, index) => [name, String(index + 1)]));
  const submit = {disabled: false};
  const form = {values, elements: {auto_renew_enabled: {checked: true}}, querySelector: () => submit};
  browser.nodes.set("#platform-policy-form", form);
  browser.context.bindPlatformFeatures();
  await form.onsubmit({preventDefault() {}});
  assert.equal(browser.requests.length, 1);
  assert.equal(browser.requests[0].url, "/platform-policy");
  assert.equal(browser.requests[0].method, "PUT");
  assert.deepEqual(JSON.parse(browser.requests[0].body), {...Object.fromEntries(numberNames.map((name) => [name, Number(values[name])])), auto_renew_enabled: true});
  values.max_cpu = "-1";
  await assert.rejects(form.onsubmit({preventDefault() {}}), /非负整数/);
  values.max_cpu = "0";
  values.auto_renew_hours = "0";
  await assert.rejects(form.onsubmit({preventDefault() {}}), /至少为 1/);
  assert.equal(browser.requests.length, 1);
});

test("归档空态独立展示四步备份流程且仅保留一个生成入口", () => {
  const browser = policyBrowser();
  const html = browser.context.historySection({items: []});
  assert.match(html, /policy-history-header/);
  assert.match(html, /policy-history-heading/);
  assert.match(html, /policy-history-actions/);
  assert.match(html, /class="policy-history-empty" role="status"/);
  assert.match(html, /生成只打包数据，不会立即删除源记录/);
  assert.equal((html.match(/data-create-archive/g) || []).length, 1);
  assert.equal((html.match(/data-refresh-archives/g) || []).length, 1);
  assert.equal((html.match(/<li>/g) || []).length, 4);
  assert.doesNotMatch(html, /data-purge-archive|data-delete-archive/);
});

test("归档重排不改变下载和清理按钮状态且继续编码外部元数据", () => {
  const browser = policyBrowser();
  const attack = '<img src=x onerror="alert(1)">';
  const item = {id: attack, category: "audit", checksum: attack, created_by: attack, row_count: 1, size_bytes: 1024};
  const waiting = browser.context.historySection({items: [item]});
  assert.match(waiting, /table-scroll policy-history-table/);
  assert.doesNotMatch(waiting, /<img/);
  assert.match(waiting, /data-purge-archive=[^>]+disabled/);
  assert.match(waiting, /data-delete-archive=[^>]+disabled/);
  const downloaded = browser.context.historySection({items: [{...item, downloaded_at: "2026-10-10"}]});
  assert.doesNotMatch(downloaded, /data-purge-archive=[^>]+disabled/);
  assert.match(downloaded, /data-delete-archive=[^>]+disabled/);
  const purged = browser.context.historySection({items: [{...item, downloaded_at: "2026-10-10", purged_at: "2026-10-10"}]});
  assert.match(purged, /data-purge-archive=[^>]+disabled/);
  assert.doesNotMatch(purged, /data-delete-archive=[^>]+disabled/);
});

test("归档确认继续要求完整校验和及备份确认文字", async () => {
  const browser = policyBrowser();
  const item = {id: "fixture-archive", category: "audit", checksum: "a".repeat(64), row_count: 5};
  browser.context.archiveConfirmation(item);
  const modal = browser.modals[0];
  const invalid = {get: (name) => name === "checksum" ? "b".repeat(64) : "已下载并校验归档"};
  await assert.rejects(modal.onSubmit(invalid), /未执行清理/);
  assert.equal(browser.requests.length, 0);
  const valid = {get: (name) => name === "checksum" ? item.checksum : "已下载并校验归档"};
  await modal.onSubmit(valid);
  assert.equal(browser.requests[0].url, "/history/archives/fixture-archive/purge");
  assert.equal(browser.requests[0].method, "POST");
  assert.deepEqual(JSON.parse(browser.requests[0].body), {checksum: item.checksum, confirm: "已下载并校验归档"});
});
