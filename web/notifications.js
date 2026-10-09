const notificationHistoryState = { page: 1, status: "" };
const notificationKindLabels = { TEST: "机器人测试", RETAINED: "进入保留期", RETENTION_END: "保留期即将结束" };
const notificationStatusLabels = { PENDING: "等待发送 / 重试", SENT: "已发送", FAILED: "发送失败", CANCELLED: "已取消" };

function notificationHistory(result) {
  const pages = Math.max(1, Math.ceil(result.total / 20));
  const rows = result.items.map((item) => {
    const kind = notificationKindLabels[item.kind] || `到期前 ${item.kind.replace("LEASE_", "")} 小时`;
    const color = item.status === "SENT" ? "ok" : item.status === "FAILED" ? "bad" : item.status === "PENDING" ? "warn" : "blue";
    return `<tr><td><b>${esc(kind)}</b><span class="source-sub">${esc(item.instance_name || "—")}</span></td><td>${esc(item.owner || "—")}</td><td><span class="pill ${color}">${esc(notificationStatusLabels[item.status])}</span></td><td>${esc(item.attempts)} 次</td><td>${fmtDate(item.created_at)}${item.sent_at ? `<span class="source-sub">发送于 ${fmtDate(item.sent_at)}</span>` : ""}</td><td><details class="notification-record"><summary>查看详情</summary><p>${esc(item.last_error || "无错误")}</p>${item.status === "PENDING" ? `<p>下次尝试：${fmtDate(item.next_attempt_at)}</p>` : ""}<pre>${esc(item.message || "尚未发送")}</pre></details></td></tr>`;
  }).join("");
  return `<div class="table-toolbar"><h3>发送记录</h3><div class="table-filter-group"><select aria-label="筛选通知状态" data-notification-filter><option value="">全部状态</option>${Object.entries(notificationStatusLabels).map(([value, label]) => `<option value="${value}" ${notificationHistoryState.status === value ? "selected" : ""}>${label}</option>`).join("")}</select><button class="btn" type="button" data-notification-refresh>刷新记录</button></div></div><div class="table-scroll"><table><thead><tr><th>提醒 / 实例</th><th>使用人</th><th>结果</th><th>尝试次数</th><th>时间</th><th>详情</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="empty">暂无通知记录。保存机器人配置后可发送测试消息。</td></tr>'}</tbody></table></div><div class="pagination"><span>共 ${esc(result.total)} 条，第 ${esc(result.page)} / ${pages} 页</span><div><button class="btn mini" type="button" data-notification-page="${numeric(result.page, 1) - 1}" ${result.page <= 1 ? "disabled" : ""}>上一页</button><button class="btn mini" type="button" data-notification-page="${numeric(result.page, 1) + 1}" ${result.page >= pages ? "disabled" : ""}>下一页</button></div></div>`;
}
function notificationHistoryURL() {
  return `/notifications/events?page=${notificationHistoryState.page}&status=${encodeURIComponent(notificationHistoryState.status)}`;
}
async function notificationsPage() {
  const [c, history] = await Promise.all([api("/notifications/config"), api(notificationHistoryURL())]);
  return lead("通知设置", "通过群机器人提醒虚拟机租期，到期前留出续期与审批时间") +
    `<div class="notification-settings-layout"><form id="notification-config-form" class="notification-settings-main"><section class="panel notification-section"><div class="notification-section-title"><span>1</span><div><h3>群机器人</h3><p>支持 WPS / WOA 群聊 Webhook，包括自建域名和端口</p></div></div><div class="field"><label>Webhook 地址</label><input name="webhook_url" type="password" autocomplete="new-password" placeholder="${esc(c.has_webhook ? "已加密保存，留空保持不变" : "https://你的域名/woa/api/v1/webhook/send?key=...")}"><small>${c.has_webhook ? esc(c.webhook_display) : "地址里的 key 是机器人凭据，不会返回明文。"}</small></div><div class="field"><label>签名密钥（选填）</label><input name="signature_secret" type="password" autocomplete="new-password" placeholder="${c.has_signature_secret ? "已保存，留空保持不变" : "机器人开启签名校验时填写 secret_key"}"></div><div class="notification-checks"><label><input name="clear_webhook" type="checkbox"> 清除已保存的机器人地址</label><label><input name="clear_signature_secret" type="checkbox"> 清除已保存的签名密钥</label></div>${field("platform_url", "平台访问地址", c.platform_url || location.origin, {type: "url", required: false, hint: "群消息附上“我的虚拟机”入口，请填写群成员能访问的地址。"})}</section><section class="panel notification-section"><div class="notification-section-title"><span>2</span><div><h3>提醒规则</h3><p>每分钟检查租期，合并本轮提醒，避免群聊刷屏</p></div></div><label class="notification-switch"><input name="enabled" type="checkbox" ${c.enabled ? "checked" : ""}><div><b>启用自动群通知</b><span>关闭后停止自动发送，管理员仍可发送测试消息。</span></div></label>${field("reminder_hours", "到期前提醒时间（小时）", c.reminder_hours.join(", "), {hint: "默认 24, 1；最多 5 个不重复整数，范围 1–168。短租期只发送当前最紧急的提醒。"})}<div class="notification-checks vertical"><label><input name="notify_retained" type="checkbox" ${c.notify_retained ? "checked" : ""}> 实例进入保留期时提醒，告知恢复入口</label><label><input name="notify_retention_end" type="checkbox" ${c.notify_retention_end ? "checked" : ""}> 保留期结束前 24 小时提醒，提示即将删除磁盘</label><label><input name="mention_owner" type="checkbox" ${c.mention_owner ? "checked" : ""}> 按平台邮箱尝试 @ 使用人；无法匹配时仍显示用户名</label></div><div class="form-actions"><button class="btn primary" type="submit">保存通知配置</button></div></section></form><aside class="notification-settings-side"><section class="panel notification-side-card"><h3>发送状态</h3><dl><div><dt>自动通知</dt><dd><span class="pill ${c.enabled ? "ok" : "blue"}">${c.enabled ? "已启用" : "已关闭"}</span></dd></div><div><dt>机器人地址</dt><dd>${c.has_webhook ? "已配置" : "未配置"}</dd></div><div><dt>签名校验</dt><dd>${c.has_signature_secret ? "已配置" : "未配置"}</dd></div><div><dt>最近尝试</dt><dd>${fmtDate(c.last_attempt_at)}</dd></div><div><dt>最近成功</dt><dd>${fmtDate(c.last_success_at)}</dd></div></dl>${c.last_error ? `<div class="form-error show">${esc(c.last_error)}</div>` : ""}<button class="btn" type="button" data-notification-test ${c.has_webhook ? "" : "disabled"}>发送一条测试消息</button><small>请先保存配置，再在群聊中确认测试消息。</small></section><section class="panel notification-side-card notification-help"><h3>消息内容与发送规则</h3><p>实例名称、使用人、到期时间、剩余时间和平台入口。不会发送登录密码、控制台票据或机器人密钥。</p><p>同一租期同一阶段只提醒一次。续期或恢复后重新计时，释放或删除会取消旧提醒。</p><p>失败最多尝试 5 次，间隔为 1、5、15、30 分钟。重试前再次核对租期，过时消息不再发送。</p><p>机器人开启关键词限制时，请允许“北斗云台”；IP 白名单填写控制面的出口 IP。</p><p>配置页仅管理员可见；北京时间用于群消息中的租期显示。</p></section></aside></div><section class="resource-table-wrap notification-history" id="notification-history">${notificationHistory(history)}</section>`;
}
function bindNotificationHistory() {
  const refresh = async () => {
    try {
      const result = await api(notificationHistoryURL());
      const target = $("#notification-history");
      if (!target || state.page !== "notifications") return;
      target.innerHTML = notificationHistory(result);
      bindNotificationHistory();
    } catch (error) { toast(error.message, "error"); }
  };
  const filter = $("[data-notification-filter]");
  if (filter) filter.onchange = () => {
    notificationHistoryState.status = filter.value;
    notificationHistoryState.page = 1;
    refresh();
  };
  const button = $("[data-notification-refresh]");
  if (button) button.onclick = refresh;
  document.querySelectorAll("[data-notification-page]").forEach((button) => {
    button.onclick = () => {
      notificationHistoryState.page = Number(button.dataset.notificationPage);
      refresh();
    };
  });
}
function bindNotifications() {
  bindNotificationHistory();
  const form = $("#notification-config-form");
  if (form) form.onsubmit = async (event) => {
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    const data = new FormData(form);
    const hours = data.get("reminder_hours").split(/[,，\s]+/).filter(Boolean).map(Number);
    if (!hours.length || hours.length > 5 || hours.some((value) => !Number.isInteger(value) || value < 1 || value > 168) || new Set(hours).size !== hours.length) {
      return showAlert({title: "提醒时间填写有误", message: "请填写 1 至 5 个不重复的整数小时，范围为 1–168，用逗号分隔。"});
    }
    submit.disabled = true;
    submit.textContent = "保存中…";
    try {
      await api("/notifications/config", {method: "PUT", body: JSON.stringify({
        webhook_url: data.get("webhook_url"), signature_secret: data.get("signature_secret"),
        platform_url: data.get("platform_url"), reminder_hours: hours,
        ...Object.fromEntries(["enabled", "clear_webhook", "clear_signature_secret", "notify_retained", "notify_retention_end", "mention_owner"].map((key) => [key, form.elements[key].checked])),
      })});
      toast("通知配置已保存");
      await render("notifications");
    } catch (error) {
      showAlert({title: "通知配置未保存", message: error.message});
      submit.disabled = false;
      submit.textContent = "保存通知配置";
    }
  };
  const test = $("[data-notification-test]");
  if (test) test.onclick = () => showConfirmModal({
    title: "发送群通知测试",
    description: "会向已保存地址对应的群聊发送一条“北斗云台群通知测试”，请确认这是你的目标群。",
    confirmText: "发送测试消息",
    onConfirm: async () => {
      const result = await api("/notifications/test", {method: "POST", body: "{}"});
      toast(result.message);
      await render("notifications");
    },
  });
}
