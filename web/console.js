import RFB from "/vendor/novnc/core/rfb.js";

const parameters = new URLSearchParams(window.location.hash.slice(1));
const mode = parameters.get("mode");
let websocketURL = parameters.get("ws");
const instanceID = parameters.get("instance");
const instanceName = parameters.get("name") || "虚拟机";
const screen = document.querySelector("#console-screen");
const status = document.querySelector("#console-status");
document.querySelector("#console-name").textContent = instanceName;
document.querySelector("#console-mode").textContent = mode === "serial" ? "串口控制台" : "VNC 控制台";

let closeCurrent = () => {};

function setStatus(text, kind = "") {
  status.textContent = text;
  status.className = `console-status ${kind}`;
}

function connectVNC() {
  screen.replaceChildren();
  const rfb = new RFB(screen, websocketURL, { shared: true });
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.focusOnClick = true;
  rfb.addEventListener("connect", () => setStatus("已连接", "ok"));
  rfb.addEventListener("disconnect", (event) => setStatus(event.detail.clean ? "已断开" : "票据已失效，请点击右上角「重新连接」", event.detail.clean ? "" : "bad"));
  rfb.addEventListener("securityfailure", () => setStatus("VNC 认证失败", "bad"));
  closeCurrent = () => rfb.disconnect();
}

function connectSerial() {
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
  socket.onopen = () => { setStatus("已连接", "ok"); terminal.focus(); };
  socket.onmessage = (event) => {
    const data = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : event.data;
    terminal.write(data);
    if (receivedText.length < 4096)
      receivedText += typeof data === "string" ? data : decoder.decode(data, { stream: true });
  };
  socket.onclose = () => {
    setStatus("已断开");
    if (receivedText.includes("cannot find character device")) {
      terminal.writeln("\r\n\x1b[33m当前实例创建时未配置串口设备，请改用 VNC 控制台。新建实例已默认启用串口。\x1b[0m");
    } else {
      setStatus("票据已失效，请点击右上角「重新连接」", "bad");
      terminal.writeln("\r\n\x1b[31m票据已失效，请点击右上角「重新连接」。\x1b[0m");
    }
  };
  socket.onerror = () => setStatus("票据已失效，请点击右上角「重新连接」", "bad");
  terminal.onData((data) => { if (socket.readyState === WebSocket.OPEN) socket.send(data); });
  closeCurrent = () => { socket.close(); terminal.dispose(); };
}

function connect() {
  closeCurrent();
  if (!websocketURL || !["vnc", "serial"].includes(mode)) {
    screen.innerHTML = '<div class="console-placeholder bad">控制台参数不完整，请从实例详情页重新打开。</div>';
    setStatus("无法连接", "bad");
    return;
  }
  setStatus("正在连接");
  if (mode === "vnc") connectVNC(); else connectSerial();
}

document.querySelector("#console-reconnect").onclick = async () => {
  if (!instanceID) {
    setStatus("请从实例详情重新打开", "bad");
    return;
  }
  const button = document.querySelector("#console-reconnect");
  button.disabled = true;
  setStatus("正在申请新票据");
  try {
    const response = await fetch(`/api/v1/instances/${encodeURIComponent(instanceID)}/console-sessions`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "无法重新申请控制台票据");
    websocketURL = result.websocket_url;
    parameters.set("ws", websocketURL);
    window.history.replaceState(null, "", `#${parameters.toString()}`);
    connect();
  } catch (error) {
    setStatus(error.message, "bad");
  } finally {
    button.disabled = false;
  }
};
window.addEventListener("beforeunload", () => closeCurrent());
connect();
