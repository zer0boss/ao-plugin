# AO Plugin V2 重新设计文档

## 使用流程

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           实际使用流程                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Step 1: OpenClaw 启动                                                       │
│  ─────────────────────────────────────────────────────────────────────────  │
│  ┌─────────────┐    加载 AO 插件     ┌─────────────────────────────────┐   │
│  │  OpenClaw   │ ──────────────────▶ │  AO Plugin                      │   │
│  │             │                     │  - 启动 WebSocket 服务器        │   │
│  │             │                     │  - 监听端口 (如 18080)          │   │
│  │             │                     │  - 等待 Control Plane 连接      │   │
│  └─────────────┘                     │  - 状态: "waiting"              │   │
│                                      └─────────────────────────────────┘   │
│                                                                             │
│  Step 2: Control Plane 启动                                                  │
│  ─────────────────────────────────────────────────────────────────────────  │
│  ┌─────────────────────┐                                                  │
│  │  Control Plane      │                                                  │
│  │  - 读取实例列表     │                                                  │
│  │  - 发现 OpenClaw#1  │ ─────── WebSocket 连接 ───────┐                  │
│  │  - 发现 OpenClaw#2  │ ─────── WebSocket 连接 ───────┼──▶ 多个实例      │
│  └─────────────────────┘                                   │               │
│                                                            ▼               │
│  Step 3: 鉴权与连接建立                                                      │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                             ┌─────────────┐ │
│  Control Plane ─── 发送鉴权请求 (apiKey) ───────────────▶   │ AO Plugin   │ │
│  (客户端)         ◀── 鉴权成功 + 注册成功 ───────────────   │ (服务器)    │ │
│                    ─── 建立双向 WebSocket 通道 ───▶        │             │ │
│                                                             │ 状态:       │ │
│                                                             │ "connected" │ │
│                                                             └─────────────┘ │
│                                                                             │
│  Step 4: 常态化通信                                                          │
│  ─────────────────────────────────────────────────────────────────────────  │
│  ┌─────────────────┐         WebSocket 双向通信          ┌─────────────────┐ │
│  │ Control Plane   │ ◀─────────────────────────────────▶ │  OpenClaw       │ │
│  │                 │                                   │  (via AO)       │ │
│  │ - 发送消息      │                                   │ - 接收消息      │ │
│  │ - 接收回复      │                                   │ - 发送回复      │ │
│  │ - 心跳检查      │                                   │ - 心跳响应      │ │
│  └─────────────────┘                                   └─────────────────┘ │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 架构变更

### 当前代码（客户端模式）❌

```typescript
// AO Plugin 作为客户端连接外部服务
const ws = new WebSocket("ws://bridge-url/ws/openclaw");
```

- 需要 `bridgeBaseUrl` 配置
- AO 主动连接外部服务
- 不符合实际使用流程

### 新设计（服务器模式）✅

```typescript
// AO Plugin 作为服务器等待 Control Plane 连接
const wss = new WebSocket.Server({ port: account.listenPort });
wss.on("connection", (ws, req) => {
  // 处理 Control Plane 连接
  handleControlPlaneConnection(ws, req);
});
```

- 需要 `listenPort` / `listenHost` 配置
- AO 被动等待 Control Plane 连接
- 符合实际使用流程

## 配置变更

### 旧配置（废弃）

```json
{
  "channels.ao": {
    "bridgeBaseUrl": "http://127.0.0.1:18080"
  }
}
```

### 新配置

```json
{
  "channels.ao": {
    "enabled": true,
    "listenHost": "0.0.0.0",
    "listenPort": 18080,
    "apiKey": "your-secret-api-key",
    "authType": "token",
    "connectionMode": "websocket",
    "healthCheck": {
      "enabled": true,
      "intervalMs": 30000,
      "timeoutMs": 10000
    },
    "accounts": {
      "account1": {
        "enabled": true,
        "listenPort": 18081,
        "apiKey": "account-specific-key"
      }
    }
  }
}
```

## 核心组件重新设计

### 1. WebSocket 服务器 (新增)

```typescript
// src/connection/server.ts
export interface WebSocketServerOptions {
  host: string;
  port: number;
  apiKey: string;
  maxConnections: number;
  healthCheckIntervalMs: number;
}

export interface ControlPlaneConnection {
  id: string;
  ws: WebSocket;
  connectedAt: number;
  lastPingAt: number;
  metadata: {
    controlPlaneId?: string;
    version?: string;
  };
}

export function createWebSocketServer(
  options: WebSocketServerOptions,
  handlers: {
    onConnection: (conn: ControlPlaneConnection) => void;
    onDisconnect: (connId: string) => void;
    onMessage: (connId: string, message: unknown) => void;
    onAuth: (apiKey: string) => boolean | Promise<boolean>;
  }
): WebSocketServerManager;
```

### 2. 连接管理器 (重构)

```typescript
// src/connection/manager.ts
export interface ConnectionManager {
  // 管理多个 Control Plane 连接
  getConnections(): ControlPlaneConnection[];
  getConnection(id: string): ControlPlaneConnection | undefined;

  // 广播消息给所有 Control Plane
  broadcast(message: unknown): void;

  // 发送消息给特定 Control Plane
  sendTo(connectionId: string, message: unknown): boolean;

  // 检查健康状态
  checkHealth(): HealthStatus;
}
```

### 3. 消息处理器 (重构)

```typescript
// src/messaging/handler.ts
export interface MessageHandler {
  // 处理来自 Control Plane 的消息
  handleInbound(
    connectionId: string,
    message: ControlPlaneMessage,
    ctx: ChannelGatewayContext
  ): Promise<void>;

  // 发送消息给 Control Plane
  handleOutbound(
    message: OpenClawMessage,
    targetConnectionId?: string
  ): Promise<DeliveryResult>;
}

// 消息类型定义
export interface ControlPlaneMessage {
  type: "chat" | "command" | "ping" | "system";
  id: string;
  timestamp: number;
  payload: unknown;
}

export interface OpenClawMessage {
  type: "reply" | "pong" | "status" | "error";
  inReplyTo: string;
  timestamp: number;
  payload: unknown;
}
```

### 4. 频道实现 (重构)

```typescript
// src/channel.ts
export const aoChannelPlugin: ChannelPlugin<AoAccount> = {
  id: "ao",
  meta: { ... },
  capabilities: { ... },
  config: { ... },

  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account as AoAccount;

      // 启动 WebSocket 服务器（不是客户端！）
      const server = createWebSocketServer(
        {
          host: account.listenHost,
          port: account.listenPort,
          apiKey: account.apiKey,
          maxConnections: account.maxConnections ?? 10,
          healthCheckIntervalMs: account.healthCheckIntervalMs ?? 30000,
        },
        {
          onConnection: (conn) => {
            ctx.log?.info?.(`[${account.accountId}] Control Plane connected: ${conn.id}`);
            ctx.setStatus?.({
              accountId: account.accountId,
              running: true,
              connected: true,
              connectionId: conn.id,
            });
          },
          onDisconnect: (connId) => {
            ctx.log?.info?.(`[${account.accountId}] Control Plane disconnected: ${connId}`);
          },
          onMessage: (connId, message) => {
            void handleControlPlaneMessage(connId, message, ctx);
          },
          onAuth: async (apiKey) => {
            // 验证 Control Plane 提供的 apiKey
            return apiKey === account.apiKey;
          },
        }
      );

      await server.start();

      // 保持运行直到 abortSignal
      await waitForAbortSignal(ctx.abortSignal);

      await server.stop();
    },
  },

  outbound: {
    deliveryMode: "gateway",
    textChunkLimit: 4000,
    sendText: async (ctx) => {
      // 发送消息给 Control Plane
      const account = ctx.account as AoAccount;
      const connectionManager = getConnectionManager(account.accountId);

      // 广播给所有连接的 Control Plane（或选择特定连接）
      const result = await connectionManager.broadcast({
        type: "reply",
        inReplyTo: ctx.messageId,
        timestamp: Date.now(),
        payload: {
          content: ctx.text,
          target: ctx.to,
          sessionId: ctx.sessionId,
        },
      });

      return {
        channel: "ao",
        messageId: ctx.messageId,
        conversationId: ctx.to,
        meta: { connectionCount: result.sentCount },
      };
    },
  },
};
```

## 协议设计

### 连接建立流程

```
Control Plane                    AO Plugin (OpenClaw)
     │                                   │
     │────── WebSocket 连接 ───────────▶│
     │                                   │
     │────── 鉴权消息 ─────────────────▶│
     │  {                              │
     │    "type": "auth",              │
     │    "apiKey": "secret-key",      │
     │    "controlPlaneId": "cp-001"   │
     │  }                              │
     │                                   │
     │◀───── 鉴权响应 ──────────────────│
     │  {                              │
     │    "type": "auth_response",     │
     │    "success": true,             │
     │    "connectionId": "conn-123"   │
     │  }                              │
     │                                   │
     │◀──── 连接建立，双向通信 ─────────▶│
```

### 消息格式

```typescript
// Control Plane → AO Plugin
interface InboundMessage {
  type: "chat";
  id: string;
  sessionId: string;
  content: string;
  from: {
    id: string;
    name: string;
    type: "user" | "agent";
  };
  metadata?: Record<string, unknown>;
}

// AO Plugin → Control Plane
interface OutboundMessage {
  type: "reply";
  inReplyTo: string;  // 对应 InboundMessage.id
  sessionId: string;
  content: string;
  from: {
    id: string;
    name: string;
    type: "agent";
  };
}

// 心跳
interface PingMessage {
  type: "ping";
  timestamp: number;
}

interface PongMessage {
  type: "pong";
  inReplyTo: string;  // ping message id
  timestamp: number;
}
```

## 健康检查机制

### 双向心跳

```typescript
// AO Plugin 端
class HealthChecker {
  private connections: Map<string, ControlPlaneConnection>;
  private checkInterval: NodeJS.Timeout;

  start() {
    this.checkInterval = setInterval(() => {
      this.checkAllConnections();
    }, 30000); // 30秒检查一次
  }

  private checkConnections() {
    for (const [id, conn] of this.connections) {
      const elapsed = Date.now() - conn.lastPingAt;

      if (elapsed > 60000) {
        // 超过60秒没有心跳，断开连接
        this.disconnect(id, "heartbeat timeout");
      } else if (elapsed > 30000) {
        // 超过30秒，发送 ping
        this.sendPing(id);
      }
    }
  }
}
```

## 文件结构

```
plugins/AO/
├── index.ts                    # 插件入口
├── package.json
├── tsconfig.json
├── openclaw.plugin.json
├── src/
│   ├── types.ts                # 类型定义（更新）
│   ├── config.ts               # 配置管理（更新）
│   ├── channel.ts              # 主频道实现（重写）
│   ├── connection/
│   │   ├── server.ts           # WebSocket 服务器（新增）
│   │   ├── manager.ts          # 连接管理器（新增）
│   │   └── auth.ts             # 鉴权逻辑（新增）
│   ├── messaging/
│   │   ├── handler.ts          # 消息处理器（重写）
│   │   ├── protocol.ts         # 协议定义（新增）
│   │   └── queue.ts            # 消息队列
│   ├── security/
│   │   └── signature.ts        # 签名验证
│   └── metrics/
│       └── collector.ts        # 指标收集
└── tests/
    └── ...
```

## 实施计划

### Phase 1: 核心重构（1-2天）

1. **更新类型定义** (types.ts)
   - 移除 `bridgeBaseUrl`
   - 添加 `listenHost`, `listenPort`, `maxConnections`
   - 定义新的消息协议类型

2. **实现 WebSocket 服务器** (connection/server.ts)
   - 创建 `WebSocket.Server`
   - 实现鉴权握手
   - 管理连接生命周期

3. **重构频道实现** (channel.ts)
   - `startAccount` 启动服务器而非客户端
   - `outbound` 广播消息给所有 Control Plane

### Phase 2: Control Plane 连接器（1-2天）

1. **实现连接管理器** (connection/manager.ts)
   - 多连接管理
   - 负载均衡（可选）
   - 连接状态追踪

2. **实现消息处理器** (messaging/handler.ts)
   - 处理 Control Plane 消息
   - 转发给 OpenClaw
   - 回复路由

### Phase 3: 健康检查与优化（1天）

1. **双向心跳机制**
2. **自动重连支持**（Control Plane 端）
3. **指标收集更新**

## 配置迁移指南

### 从旧配置迁移

```bash
# 旧配置
{
  "bridgeBaseUrl": "http://127.0.0.1:18080"
}

# 新配置
{
  "listenHost": "0.0.0.0",
  "listenPort": 18080,
  "apiKey": "your-secret-key"
}
```

## 与 Control Plane 集成

Control Plane 需要实现 AO Plugin 客户端：

```typescript
// Control Plane 端
class AoPluginConnector {
  async connect(instance: OpenClawInstance) {
    const ws = new WebSocket(`ws://${instance.host}:${instance.port}`);

    // 发送鉴权
    ws.send(JSON.stringify({
      type: "auth",
      apiKey: instance.apiKey,
      controlPlaneId: this.controlPlaneId,
    }));

    // 等待鉴权响应
    // ...

    // 保持心跳
    this.startHeartbeat(ws);
  }
}
```
