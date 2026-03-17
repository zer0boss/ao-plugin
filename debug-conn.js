/**
 * 调试 WebSocket 连接状态
 */
import WebSocket from "ws";

const PORT = 18080;
const API_KEY = "openclaw-ao-v2-server-key-change-me-in-production";

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);

ws.on("open", () => {
  console.log("[Debug] Connected");
  ws.send(JSON.stringify({
    id: "debug-auth",
    type: "auth",
    timestamp: Date.now(),
    payload: { apiKey: API_KEY, controlPlaneId: "debug-conn-check" }
  }));
});

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === "auth_response") {
    console.log("[Debug] My connectionId:", msg.payload.connectionId);
    console.log("[Debug] Check AO Plugin log for 'all connections'");
    console.log("[Debug] Control Plane connectionId should be: 98c7039c-2eb8-4784-9d59-ab3cd7ff7440");

    // 发送消息
    ws.send(JSON.stringify({
      id: "debug-chat",
      type: "chat",
      timestamp: Date.now(),
      sessionId: "debug-session",
      content: "check connection routing",
      from: { id: "debug", name: "Debug" }
    }));
    console.log("[Debug] Sent chat message");
  }
  if (msg.type === "reply") {
    console.log("[Debug] Got reply:", msg.content?.substring(0, 50));
    ws.close();
    process.exit(0);
  }
});

setTimeout(() => {
  console.log("[Debug] Timeout");
  process.exit(0);
}, 15000);