/**
 * 模拟 AO 服务器，给 Control Plane 发消息测试
 */
import { WebSocketServer } from "ws";

const PORT = 18080;

const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });

console.log(`模拟 AO 服务器启动在端口 ${PORT}`);
console.log(`请修改 Control Plane 配置连接到这个端口`);
console.log(`或者临时停止 AO Plugin，让这个脚本监听 18080\n`);

wss.on("connection", (ws, req) => {
  const addr = req.socket.remoteAddress;
  console.log(`\n=== 有客户端连接: ${addr} ===\n`);

  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    console.log("收到:", msg.type, msg.id || "");

    if (msg.type === "auth") {
      // 认证响应
      const connId = "test-conn-" + Date.now();
      ws.send(JSON.stringify({
        type: "auth_response",
        inReplyTo: msg.id,
        timestamp: Date.now(),
        payload: { success: true, connectionId: connId }
      }));
      console.log("已发送 auth_response, connectionId:", connId);

      // 3秒后给 Control Plane 发消息
      setTimeout(() => {
        console.log("\n*** 发送测试消息给 Control Plane ***");
        ws.send(JSON.stringify({
          type: "reply",
          inReplyTo: "test-msg",
          sessionId: "7cb0ed30-3932-447f-9eb3-9f1cdce7f310",
          content: "你就是头猪",
          from: { id: "test", name: "Test", type: "agent" },
          timestamp: Date.now()
        }));
        console.log("*** 消息已发送 ***\n");
      }, 3000);
    }

    if (msg.type === "ping") {
      ws.send(JSON.stringify({
        type: "pong",
        inReplyTo: msg.id,
        timestamp: Date.now()
      }));
    }
  });

  ws.on("close", () => console.log("客户端断开"));
  ws.on("error", (e) => console.error("错误:", e.message));
});

console.log("等待 Control Plane 连接...");