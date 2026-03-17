/**
 * Connection Pool Implementation
 *
 * 管理多个 WebSocket 连接，提供连接复用和健康检查
 */

import WebSocket from "ws";
import type {
  WebSocketConnection,
  ConnectionPoolOptions,
  PoolHealthStats,
} from "../types.js";
import { createCircuitBreaker, type CircuitBreaker } from "./circuit-breaker.js";

export interface ConnectionPool {
  getConnection(): Promise<WebSocketConnection>;
  releaseConnection(conn: WebSocketConnection): void;
  removeConnection(conn: WebSocketConnection): void;
  getHealthStats(): PoolHealthStats;
  close(): Promise<void>;
  startHealthCheck(): void;
  stopHealthCheck(): void;
}

export interface ConnectionPoolConfig {
  minConnections?: number;
  maxConnections?: number;
  idleTimeoutMs?: number;
  healthCheckIntervalMs?: number;
  connectionTimeoutMs?: number;
  url: string;
  headers?: Record<string, string>;
}

export function createConnectionPool(config: ConnectionPoolConfig): ConnectionPool {
  const options: ConnectionPoolOptions = {
    minConnections: config.minConnections ?? 1,
    maxConnections: config.maxConnections ?? 5,
    idleTimeoutMs: config.idleTimeoutMs ?? 60000,
    healthCheckIntervalMs: config.healthCheckIntervalMs ?? 30000,
    connectionTimeoutMs: config.connectionTimeoutMs ?? 10000,
  };

  const connections: Map<string, WebSocketConnection> = new Map();
  const availableConnections: Set<string> = new Set();
  const circuitBreaker = createCircuitBreaker({
    failureThreshold: 3,
    recoveryTimeout: 30000,
    halfOpenMaxCalls: 2,
  });

  let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  let connectionIdCounter = 0;

  function generateConnectionId(): string {
    return `conn-${Date.now()}-${++connectionIdCounter}`;
  }

  async function createConnection(): Promise<WebSocketConnection> {
    return await circuitBreaker.execute(async () => {
      const connectionId = generateConnectionId();
      const ws = new WebSocket(config.url, {
        headers: config.headers,
        handshakeTimeout: options.connectionTimeoutMs,
      });

      return await new Promise<WebSocketConnection>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.terminate();
          reject(new Error(`Connection timeout after ${options.connectionTimeoutMs}ms`));
        }, options.connectionTimeoutMs);

        ws.once("open", () => {
          clearTimeout(timeout);

          const conn: WebSocketConnection = {
            id: connectionId,
            ws,
            state: "connected",
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
            lastHealthCheckAt: Date.now(),
            errorCount: 0,
            metadata: {},
          };

          connections.set(connectionId, conn);

          // 监听关闭事件
          ws.once("close", () => {
            conn.state = "closed";
            availableConnections.delete(connectionId);
            connections.delete(connectionId);
          });

          // 监听错误
          ws.once("error", (error) => {
            conn.errorCount++;
            conn.metadata.lastError = error.message;

            if (conn.errorCount >= 3) {
              conn.state = "unhealthy";
              ws.close();
            }
          });

          resolve(conn);
        });

        ws.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
    });
  }

  async function getConnection(): Promise<WebSocketConnection> {
    // 首先尝试复用空闲连接
    for (const connId of availableConnections) {
      const conn = connections.get(connId);
      if (conn && conn.state === "connected") {
        availableConnections.delete(connId);
        conn.lastUsedAt = Date.now();
        return conn;
      }
    }

    // 如果没有空闲连接，检查当前总数
    const currentCount = connections.size;
    if (currentCount < options.maxConnections) {
      const conn = await createConnection();
      return conn;
    }

    // 等待有空闲连接（简单实现：轮询等待）
    return await waitForAvailableConnection();
  }

  async function waitForAvailableConnection(
    maxWaitMs: number = 5000
  ): Promise<WebSocketConnection> {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      for (const connId of availableConnections) {
        const conn = connections.get(connId);
        if (conn && conn.state === "connected") {
          availableConnections.delete(connId);
          conn.lastUsedAt = Date.now();
          return conn;
        }
      }

      // 短暂等待后重试
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error("Timeout waiting for available connection");
  }

  function releaseConnection(conn: WebSocketConnection): void {
    if (connections.has(conn.id) && conn.state === "connected") {
      availableConnections.add(conn.id);
      conn.lastUsedAt = Date.now();
    }
  }

  function removeConnection(conn: WebSocketConnection): void {
    availableConnections.delete(conn.id);
    connections.delete(conn.id);

    if (conn.state !== "closed") {
      conn.state = "closed";
      try {
        conn.ws.close();
      } catch {
        // 忽略关闭错误
      }
    }
  }

  function getHealthStats(): PoolHealthStats {
    let active = 0;
    let idle = 0;
    let unhealthy = 0;
    let connecting = 0;

    for (const conn of connections.values()) {
      switch (conn.state) {
        case "connected":
          if (availableConnections.has(conn.id)) {
            idle++;
          } else {
            active++;
          }
          break;
        case "connecting":
          connecting++;
          break;
        case "unhealthy":
          unhealthy++;
          break;
      }
    }

    return {
      total: connections.size,
      active,
      idle,
      unhealthy,
      connecting,
    };
  }

  function startHealthCheck(): void {
    if (healthCheckTimer) {
      return;
    }

    healthCheckTimer = setInterval(() => {
      const now = Date.now();
      const stats = getHealthStats();

      // 检查是否需要创建新的连接以达到最小连接数
      if (stats.idle + stats.active < options.minConnections) {
        const needed = options.minConnections - (stats.idle + stats.active);
        for (let i = 0; i < needed && connections.size < options.maxConnections; i++) {
          createConnection()
            .then((conn) => {
              releaseConnection(conn);
            })
            .catch(() => {
              // 忽略创建失败
            });
        }
      }

      // 清理超时空闲连接
      for (const conn of connections.values()) {
        if (
          conn.state === "connected" &&
          availableConnections.has(conn.id) &&
          now - conn.lastUsedAt > options.idleTimeoutMs
        ) {
          // 保持最小连接数
          const stats = getHealthStats();
          if (stats.idle + stats.active > options.minConnections) {
            removeConnection(conn);
          }
        }

        // 标记长时间未健康检查的连接
        if (now - conn.lastHealthCheckAt > options.healthCheckIntervalMs * 2) {
          conn.state = "unhealthy";
        }
      }
    }, options.healthCheckIntervalMs);
  }

  function stopHealthCheck(): void {
    if (healthCheckTimer) {
      clearInterval(healthCheckTimer);
      healthCheckTimer = null;
    }
  }

  async function close(): Promise<void> {
    stopHealthCheck();

    const closePromises = Array.from(connections.values()).map((conn) => {
      return new Promise<void>((resolve) => {
        if (conn.state === "closed") {
          resolve();
          return;
        }

        const timeout = setTimeout(() => {
          try {
            conn.ws.terminate();
          } catch {
            // 忽略
          }
          resolve();
        }, 5000);

        conn.ws.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });

        try {
          conn.ws.close();
        } catch {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    await Promise.all(closePromises);
    connections.clear();
    availableConnections.clear();
  }

  return {
    getConnection,
    releaseConnection,
    removeConnection,
    getHealthStats,
    close,
    startHealthCheck,
    stopHealthCheck,
  };
}

/**
 * 创建带认证的连接池
 */
export function createAuthenticatedConnectionPool(
  url: string,
  apiKey?: string,
  config?: Omit<ConnectionPoolConfig, "url" | "headers">
): ConnectionPool {
  const headers: Record<string, string> = {};

  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  return createConnectionPool({
    url,
    headers,
    ...config,
  });
}
