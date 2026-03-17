/**
 * Connection Manager
 *
 * 管理 Control Plane 连接，支持 server/client/hybrid 三种模式
 * - server: AO 作为服务器，等待 Control Plane 连接
 * - client: AO 作为客户端，主动连接 Control Plane
 * - hybrid: 智能模式，根据情况自动切换
 */

import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type {
  AoAccount,
  ControlPlaneConnection,
  ConnectionMode,
  Logger,
  ClientConnectionOptions,
  WebSocketServerManager,
} from "../types.js";
import { log } from "../logger.js";

// ============================================================================
// Connection State Types
// ============================================================================

interface ConnectionState {
  connections: Map<string, ControlPlaneConnection>;
  clientConnections: Map<string, ClientConnectionState>;
  mode: ConnectionMode;
  account: AoAccount;
  logger?: Logger;
  isRunning: boolean;
}

interface ClientConnectionState {
  id: string;
  ws: WebSocket;
  url: string;
  state: "connecting" | "connected" | "authenticated" | "error" | "closed";
  createdAt: number;
  lastPingAt: number;
  reconnectAttempt: number;
  reconnectTimer?: NodeJS.Timeout;
  heartbeatInterval?: NodeJS.Timeout;
}

interface ConnectionManagerHandlers {
  onServerConnection: (conn: ControlPlaneConnection) => void;
  onServerDisconnect: (connId: string) => void;
  onServerMessage: (connId: string, message: unknown) => void;
  onServerAuth: (apiKey: string, metadata?: Record<string, unknown>) => boolean | Promise<boolean>;
  onClientMessage: (message: unknown) => void;
  onClientConnect: () => void;
  onClientDisconnect: () => void;
  onClientError: (error: Error) => void;
}

// ============================================================================
// Module State
// ============================================================================

const managers = new Map<string, ConnectionManager>();

// ============================================================================
// Connection Manager Class
// ============================================================================

export class ConnectionManager {
  private state: ConnectionState;
  private handlers: ConnectionManagerHandlers;
  private serverManager?: WebSocketServerManager;

  constructor(account: AoAccount, handlers: ConnectionManagerHandlers, logger?: Logger) {
    this.state = {
      connections: new Map(),
      clientConnections: new Map(),
      mode: account.connectionMode,
      account,
      logger,
      isRunning: false,
    };
    this.handlers = handlers;
  }

  /**
   * 启动连接管理器
   * 根据模式启动服务器或连接客户端
   */
  async start(): Promise<void> {
    if (this.state.isRunning) {
      return;
    }

    const { mode, account } = this.state;

    this.state.logger?.info?.(`[AO Manager] Starting in ${mode} mode`);

    // 启动服务器模式（server 或 hybrid）
    if (mode === "server" || mode === "hybrid") {
      await this.startServer();
    }

    // 启动客户端模式（client 或 hybrid）
    if (mode === "client" || mode === "hybrid") {
      // hybrid 模式下，延迟启动客户端连接
      // 给服务器一点时间接收连接
      const delay = mode === "hybrid" ? 5000 : 0;
      setTimeout(() => {
        void this.startClient();
      }, delay);
    }

    this.state.isRunning = true;
  }

  /**
   * 停止连接管理器
   */
  async stop(): Promise<void> {
    if (!this.state.isRunning) {
      return;
    }

    this.state.logger?.info?.("[AO Manager] Stopping");

    // 停止客户端连接
    for (const [, clientConn] of this.state.clientConnections) {
      this.cleanupClientConnection(clientConn);
    }
    this.state.clientConnections.clear();

    // 停止服务器
    if (this.serverManager) {
      await this.serverManager.stop();
      this.serverManager = undefined;
    }

    this.state.isRunning = false;
  }

  /**
   * 启动 WebSocket 服务器
   */
  private async startServer(): Promise<void> {
    const { account } = this.state;

    try {
      const { createWebSocketServer } = await import("./server.js");

      this.serverManager = createWebSocketServer(
        {
          host: account.listenHost,
          port: account.listenPort,
          apiKey: account.apiKey,
          maxConnections: account.maxConnections,
          healthCheckIntervalMs: account.healthCheck.intervalMs,
        },
        {
          onConnection: (conn) => {
            this.state.connections.set(conn.id, conn);
            this.handlers.onServerConnection(conn);
          },
          onDisconnect: (connId) => {
            this.state.connections.delete(connId);
            this.handlers.onServerDisconnect(connId);
          },
          onMessage: (connId, message) => {
            this.state.logger?.info?.(`[AO Manager] onServerMessage called:`);
            this.state.logger?.info?.(`[AO Manager]   connId: ${connId}`);
            this.state.logger?.info?.(`[AO Manager]   message type: ${(message as {type?: string})?.type || 'unknown'}`);
            this.state.logger?.info?.(`[AO Manager]   -> calling handlers.onServerMessage...`);
            this.handlers.onServerMessage(connId, message);
          },
          onAuth: async (apiKey, metadata) => {
            return await this.handlers.onServerAuth(apiKey, metadata);
          },
        },
        this.state.logger
      );

      await this.serverManager.start();
      this.state.logger?.info?.(
        `[AO Manager] Server started on ${account.listenHost}:${account.listenPort}`
      );
    } catch (err) {
      this.state.logger?.error?.(`[AO Manager] Failed to start server: ${err}`);
      throw err;
    }
  }

  /**
   * 启动客户端连接（连接到 Control Plane）
   */
  private async startClient(): Promise<void> {
    const { account } = this.state;

    // 检查是否需要连接 Control Plane
    const controlPlaneUrl = account.controlPlaneUrl;
    if (!controlPlaneUrl) {
      this.state.logger?.info?.("[AO Manager] No controlPlaneUrl configured, skipping client mode");
      return;
    }

    // 在 hybrid 模式下，检查是否已经有服务器连接
    // 如果有，就不需要启动客户端
    if (this.state.mode === "hybrid" && this.state.connections.size > 0) {
      this.state.logger?.info?.(
        "[AO Manager] Already have server connections in hybrid mode, skipping client"
      );
      return;
    }

    await this.connectToControlPlane(controlPlaneUrl);
  }

  /**
   * 连接到 Control Plane
   */
  private async connectToControlPlane(url: string): Promise<void> {
    const id = randomUUID();

    this.state.logger?.info?.(`[AO Manager] Connecting to Control Plane: ${url}`);

    const ws = new WebSocket(url);

    const clientConn: ClientConnectionState = {
      id,
      ws,
      url,
      state: "connecting",
      createdAt: Date.now(),
      lastPingAt: Date.now(),
      reconnectAttempt: 0,
    };

    this.state.clientConnections.set(id, clientConn);

    ws.on("open", () => {
      this.state.logger?.info?.(`[AO Manager] Connected to Control Plane: ${url}`);
      clientConn.state = "connected";
      clientConn.reconnectAttempt = 0;

      // 发送鉴权消息
      this.sendAuthMessage(clientConn);
    });

    ws.on("message", (data) => {
      void this.handleClientMessage(clientConn, data);
    });

    ws.on("close", (code, reason) => {
      this.state.logger?.info?.(
        `[AO Manager] Control Plane connection closed: ${url} (code: ${code}, reason: ${reason})`
      );
      this.cleanupClientConnection(clientConn);
      this.state.clientConnections.delete(id);
      this.handlers.onClientDisconnect();

      // 自动重连
      if (this.state.isRunning) {
        this.scheduleReconnect(url);
      }
    });

    ws.on("error", (err) => {
      this.state.logger?.error?.(`[AO Manager] Control Plane connection error: ${url}, ${err}`);
      clientConn.state = "error";
      this.handlers.onClientError(err);
    });
  }

  /**
   * 发送鉴权消息
   */
  private sendAuthMessage(clientConn: ClientConnectionState): void {
    const { account } = this.state;

    const authMessage = {
      type: "auth",
      id: randomUUID(),
      timestamp: Date.now(),
      payload: {
        apiKey: account.apiKey,
        controlPlaneId: `openclaw-${account.accountId}`,
        version: "2.0.0",
      },
    };

    clientConn.ws.send(JSON.stringify(authMessage));
    this.state.logger?.debug?.(`[AO Manager] Auth message sent to Control Plane`);
  }

  /**
   * 处理客户端收到的消息
   */
  private async handleClientMessage(
    clientConn: ClientConnectionState,
    data: WebSocket.RawData
  ): Promise<void> {
    try {
      const message = JSON.parse(data.toString());

      // 处理鉴权响应
      if (message.type === "auth_response") {
        if (message.payload?.success) {
          this.state.logger?.info?.(`[AO Manager] Auth successful with Control Plane`);
          clientConn.state = "authenticated";
          this.handlers.onClientConnect();

          // 启动心跳
          this.startClientHeartbeat(clientConn);
        } else {
          this.state.logger?.error?.(
            `[AO Manager] Auth failed: ${message.payload?.error || "unknown"}`
          );
          clientConn.state = "error";
          clientConn.ws.close();
        }
        return;
      }

      // 处理 pong 响应
      if (message.type === "pong") {
        clientConn.lastPingAt = Date.now();
        return;
      }

      // 转发其他消息
      if (clientConn.state === "authenticated") {
        this.handlers.onClientMessage(message);
      }
    } catch (err) {
      this.state.logger?.error?.(`[AO Manager] Failed to parse message: ${err}`);
    }
  }

  /**
   * 启动客户端心跳
   */
  private startClientHeartbeat(clientConn: ClientConnectionState): void {
    const intervalMs = this.state.account.healthCheck.intervalMs;

    clientConn.heartbeatInterval = setInterval(() => {
      if (clientConn.ws.readyState === WebSocket.OPEN) {
        const pingMessage = {
          type: "ping",
          id: randomUUID(),
          timestamp: Date.now(),
        };
        clientConn.ws.send(JSON.stringify(pingMessage));
      }
    }, intervalMs);
  }

  /**
   * 清理客户端连接资源
   */
  private cleanupClientConnection(clientConn: ClientConnectionState): void {
    if (clientConn.reconnectTimer) {
      clearTimeout(clientConn.reconnectTimer);
    }
    if (clientConn.heartbeatInterval) {
      clearInterval(clientConn.heartbeatInterval);
    }
    if (clientConn.ws.readyState === WebSocket.OPEN) {
      clientConn.ws.close();
    }
  }

  /**
   * 安排重连
   */
  private scheduleReconnect(url: string): void {
    const delay = Math.min(30000, 1000 * Math.pow(2, 1)); // 最大 30 秒

    this.state.logger?.info?.(`[AO Manager] Scheduling reconnect in ${delay}ms`);

    setTimeout(() => {
      if (this.state.isRunning) {
        void this.connectToControlPlane(url);
      }
    }, delay);
  }

  // ========================================================================
  // Public Methods
  // ========================================================================

  /**
   * 获取所有服务器连接
   */
  getServerConnections(): ControlPlaneConnection[] {
    return Array.from(this.state.connections.values());
  }

  /**
   * 获取特定服务器连接
   */
  getServerConnection(id: string): ControlPlaneConnection | undefined {
    return this.state.connections.get(id);
  }

  /**
   * 广播消息给所有服务器连接
   */
  broadcastToServers(message: unknown): void {
    const msgType = (message as {type?: string})?.type || 'unknown';
    log("INFO", `[AO Manager] *** broadcastToServers CALLED ***`);
    log("INFO", `[AO Manager]   message type: ${msgType}`);
    log("INFO", `[AO Manager]   serverConnections count: ${this.state.connections.size}`);
    log("INFO", `[AO Manager]   serverManager exists: ${!!this.serverManager}`);

    this.state.logger?.info?.(`[AO Manager] Broadcasting message to all server connections:`);
    this.state.logger?.info?.(`[AO Manager]   connections: ${this.state.connections.size}`);
    this.state.logger?.info?.(`[AO Manager]   message type: ${msgType}`);

    // Debug: log connection states
    for (const [connId, conn] of this.state.connections) {
      const isAuth = (conn as any).isAuthenticated;
      const wsState = (conn as any).ws?.readyState;
      log("INFO", `[AO Manager]   Connection ${connId}: isAuthenticated=${isAuth}, ws=${wsState}`);
      this.state.logger?.info?.(`[AO Manager]   Connection ${connId}: isAuthenticated=${isAuth}, ws=${wsState}`);
    }

    if (this.serverManager) {
      log("INFO", `[AO Manager]   Calling serverManager.broadcast...`);
      this.state.logger?.info?.(`[AO Manager]   Calling serverManager.broadcast...`);
      this.serverManager.broadcast(message);
      log("INFO", `[AO Manager]   serverManager.broadcast returned`);
      this.state.logger?.info?.(`[AO Manager]   serverManager.broadcast returned`);
    } else {
      log("ERROR", `[AO Manager]   ERROR: serverManager is null!`);
      this.state.logger?.warn?.(`[AO Manager]   No server manager available!`);
    }
  }

  /**
   * 发送消息给特定服务器连接
   */
  sendToServer(connectionId: string, message: unknown): boolean {
    this.state.logger?.info?.(`[AO Manager] Sending message to server connection: ${connectionId}`);
    this.state.logger?.info?.(`[AO Manager]   message type: ${(message as {type?: string})?.type || 'unknown'}`);

    if (this.serverManager) {
      const sent = this.serverManager.sendTo(connectionId, message);
      this.state.logger?.info?.(`[AO Manager]   send result: ${sent ? 'success' : 'failed'}`);
      return sent;
    }
    this.state.logger?.warn?.(`[AO Manager]   No server manager available!`);
    return false;
  }

  /**
   * 发送消息给 Control Plane（客户端模式）
   */
  sendToControlPlane(message: unknown): boolean {
    this.state.logger?.info?.(`[AO Manager] Sending message to Control Plane (client mode):`);
    this.state.logger?.info?.(`[AO Manager]   message type: ${(message as {type?: string})?.type || 'unknown'}`);
    this.state.logger?.info?.(`[AO Manager]   client connections: ${this.state.clientConnections.size}`);

    for (const [, clientConn] of this.state.clientConnections) {
      if (clientConn.state === "authenticated" && clientConn.ws.readyState === WebSocket.OPEN) {
        try {
          clientConn.ws.send(JSON.stringify(message));
          this.state.logger?.info?.(`[AO Manager]   -> Sent successfully`);
          return true;
        } catch (err) {
          this.state.logger?.error?.(`[AO Manager] Send error: ${err}`);
        }
      }
    }
    this.state.logger?.warn?.(`[AO Manager]   -> No authenticated client connection available!`);
    return false;
  }

  /**
   * 是否有活跃的连接（服务器或客户端）
   */
  hasActiveConnection(): boolean {
    // 检查服务器连接
    if (this.state.connections.size > 0) {
      return true;
    }

    // 检查客户端连接
    for (const [, clientConn] of this.state.clientConnections) {
      if (clientConn.state === "authenticated") {
        return true;
      }
    }

    return false;
  }

  /**
   * 获取连接统计
   */
  getStats(): {
    serverConnections: number;
    clientConnections: number;
    mode: ConnectionMode;
    isRunning: boolean;
  } {
    return {
      serverConnections: this.state.connections.size,
      clientConnections: this.state.clientConnections.size,
      mode: this.state.mode,
      isRunning: this.state.isRunning,
    };
  }

  /**
   * 获取当前模式
   */
  getMode(): ConnectionMode {
    return this.state.mode;
  }

  /**
   * 是否正在运行
   */
  isRunning(): boolean {
    return this.state.isRunning;
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

export interface ConnectionManagerOptions {
  account: AoAccount;
  handlers: ConnectionManagerHandlers;
  logger?: Logger;
}

export function createConnectionManager(options: ConnectionManagerOptions): ConnectionManager {
  const { account, handlers, logger } = options;

  // 检查是否已存在
  const existing = managers.get(account.accountId);
  if (existing) {
    logger?.warn?.(`[AO Manager] Connection manager already exists for ${account.accountId}`);
    return existing;
  }

  const manager = new ConnectionManager(account, handlers, logger);
  managers.set(account.accountId, manager);

  return manager;
}

export function getConnectionManager(accountId: string): ConnectionManager | undefined {
  return managers.get(accountId);
}

export function removeConnectionManager(accountId: string): void {
  const manager = managers.get(accountId);
  if (manager) {
    void manager.stop();
    managers.delete(accountId);
  }
}

export function listConnectionManagers(): string[] {
  return Array.from(managers.keys());
}

export function getAllManagers(): Map<string, ConnectionManager> {
  return new Map(managers);
}
