import RFB from "/vendor/novnc/core/rfb.js";

const parameters = new URLSearchParams(window.location.hash.slice(1));
const mode = parameters.get("mode");
const instanceID = parameters.get("instance");
const instanceName = parameters.get("name") || "虚拟机";
const screen = document.querySelector("#console-screen");
const status = document.querySelector("#console-status");
const reconnectButton = document.querySelector("#console-reconnect");
document.querySelector("#console-name").textContent = instanceName;
document.querySelector("#console-mode").textContent = mode === "serial" ? "串口控制台" : "VNC 控制台";

// 旧链接中的 ws/票据不可信，也不继续保留在浏览器地址和历史记录中。
parameters.delete("ws");
window.history.replaceState(null, "", "#" + parameters.toString());
let closeCurrent = () => {};
let pendingConnection = null;
let connectionGeneration = 0;

function setStatus(text, kind = "") {
  status.textContent = text;
  status.className = "console-status " + kind;
}
function consoleEndpoint(value) {
  const pageURL = new URL(window.location.href || window.location.origin);
  const endpoint = new URL(value, pageURL);
  if (endpoint.protocol === "http:") endpoint.protocol = "ws:";
  if (endpoint.protocol === "https:") endpoint.protocol = "wss:";
  const expectedProtocol = pageURL.protocol === "https:" ? "wss:" : "ws:";
  if (endpoint.protocol !== expectedProtocol || endpoint.host !== pageURL.host || endpoint.username || endpoint.password || endpoint.hash || endpoint.pathname !== "/api/v1/console/" + mode || !endpoint.searchParams.get("ticket")) {
    throw new Error("平台返回的控制台连接地址无效，请联系管理员检查 Agent 配置。");
  }
  return endpoint.toString();
}
function connectVNC(websocketURL, generation) {
  screen.replaceChildren();
  const rfb = new RFB(screen, websocketURL, { shared: true });
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.focusOnClick = true;
  rfb.addEventListener("connect", () => { if (generation === connectionGeneration) setStatus("已连接", "ok"); });
  rfb.addEventListener("disconnect", (event) => {
    if (generation !== connectionGeneration) return;
    setStatus(event.detail.clean ? "已断开" : "连接中断或票据已失效，请点击右上角「重新连接」", event.detail.clean ? "" : "bad");
  });
  rfb.addEventListener("securityfailure", () => { if (generation === connectionGeneration) setStatus("VNC 认证失败，请点击右上角「重新连接」", "bad"); });
  closeCurrent = () => rfb.disconnect();
}
function connectSerial(websocketURL, generation) {
  screen.replaceChildren();
  const terminalHost = document.createElement("div");
  terminalHost.className = "serial-terminal";
  screen.appendChild(terminalHost);
  const terminal = new window.Terminal({ cursorBlink: true, convertEol: true, fontFamily: '"SFMono-Regular", Consolas, monospace', fontSize: 14, theme: { background: "#090d14", foreground: "#d7dee9", cursor: "#8b7cf6" } });
  terminal.open(terminalHost);
  terminal.writeln("\x1b[90m正在连接 libvirt 串口…\x1b[0m");
  const socket = new WebSocket(websocketURL);
  let receivedText = "";
  const decoder = new TextDecoder();
  socket.binaryType = "arraybuffer";
  socket.onopen = () => { if (generation === connectionGeneration) { setStatus("已连接", "ok"); terminal.focus(); } };
  socket.onmessage = (event) => {
    if (generation !== connectionGeneration) return;
    const data = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : event.data;
    terminal.write(data);
    if (receivedText.length < 4096) receivedText += typeof data === "string" ? data : decoder.decode(data, { stream: true });
  };
  socket.onclose = () => {
    if (generation !== connectionGeneration) return;
    if (receivedText.includes("cannot find character device")) {
      setStatus("当前实例未配置串口，请改用 VNC 控制台。", "bad");
      terminal.writeln("\r\n\x1b[33m当前实例创建时未配置串口设备，请改用 VNC 控制台。\x1b[0m");
    } else {
      setStatus("连接中断或票据已失效，请点击右上角「重新连接」", "bad");
      terminal.writeln("\r\n\x1b[31m请点击右上角「重新连接」申请新票据。\x1b[0m");
    }
  };
  socket.onerror = () => { if (generation === connectionGeneration) setStatus("连接中断或票据已失效，请点击右上角「重新连接」", "bad"); };
  terminal.onData((data) => { if (socket.readyState === WebSocket.OPEN && generation === connectionGeneration) socket.send(data); });
  closeCurrent = () => { socket.close(); terminal.dispose(); };
}
async function requestConnection() {
  const generation = ++connectionGeneration;
  pendingConnection?.abort();
  closeCurrent();
  closeCurrent = () => {};
  if (!instanceID || !["vnc", "serial"].includes(mode)) {
    screen.textContent = "控制台参数不完整，请从实例详情页重新打开。";
    setStatus("无法连接", "bad");
    return;
  }
  const controller = new AbortController();
  pendingConnection = controller;
  reconnectButton.disabled = true;
  setStatus("正在申请新票据");
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    // 连接目标只能来自当前登录账号有权访问的同源 API，不使用地址栏提供的 WebSocket URL。
    const response = await fetch("/api/v1/instances/" + encodeURIComponent(instanceID) + "/console-sessions", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-VMP-Request": "1" }, body: JSON.stringify({ mode }), signal: controller.signal });
    const result = await response.json();
    if (generation !== connectionGeneration) return;
    if (!response.ok) throw new Error(response.status === 401 ? "登录会话已失效，请返回平台重新登录。" : response.status === 403 ? "当前账号无权访问该实例的控制台。" : /[\u3400-\u9fff]/.test(result.error || "") ? result.error : "无法申请控制台票据，请重试或联系管理员。");
    const endpoint = consoleEndpoint(result.websocket_url);
    setStatus("正在连接");
    if (mode === "vnc") connectVNC(endpoint, generation); else connectSerial(endpoint, generation);
  } catch (error) {
    if (generation !== connectionGeneration) return;
    setStatus(error.name === "AbortError" ? "连接请求超时，请点击右上角「重新连接」。" : /[\u3400-\u9fff]/.test(error.message || "") ? error.message : "无法连接平台，请检查网络后点击「重新连接」。", "bad");
  } finally {
    clearTimeout(timeout);
    if (generation === connectionGeneration) { pendingConnection = null; reconnectButton.disabled = false; }
  }
}
reconnectButton.onclick = requestConnection;
window.addEventListener("beforeunload", () => { connectionGeneration += 1; pendingConnection?.abort(); closeCurrent(); });
requestConnection();
