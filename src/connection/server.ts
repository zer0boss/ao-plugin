/**
 * WebSocket Server
 *
 * AO Plugin V2: WebSocket 服务器实现
 * 等待 Control Plane 主动连接
 *
 * 重构: 移除全局状态，每个 ConnectionManager 拥有独立的服务器实例
 */

import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import type {
  WebSocketServerOptions,
  ControlPlaneConnection,
  WebSocketServerManager,
  ServerHandlers,
  Logger,
} from "../types.js";
import { log } from "../logger.js";

interface ServerState {
  wss: WebSocketServer | null;
  connections: Map<string, ControlPlaneConnection>;
  isRunning: boolean;
  handlers: ServerHandlers | null;
  options: WebSocketServerOptions | null;
  logger?: Logger;
  heartbeatInterval?: NodeJS.Timeout;
}

// ============================================================================
// Helper Functions (stateless)
// ============================================================================

function createConnection(ws: WebSocket, remoteAddress: string): ControlPlaneConnection {
  const conn: ControlPlaneConnection = {
    id: randomUUID(),
    ws,
    connectedAt: Date.now(),
    lastPingAt: Date.now(),
    isAuthenticated: false,
    metadata: {
      remoteAddress,
    },
  };
  return conn;
}

function sendError(conn: ControlPlaneConnection, code: string, message: string): void {
  const response = {
    type: "error",
    timestamp: Date.now(),
    payload: {
      code,
      message,
    },
  };

  if (conn.ws.readyState === WebSocket.OPEN) {
    conn.ws.send(JSON.stringify(response));
  }
}

// ============================================================================
// Server Factory (creates isolated state per instance)
// ============================================================================

export function createWebSocketServer(
  options: WebSocketServerOptions,
  handlers: ServerHandlers,
  logger?: Logger
): WebSocketServerManager {
  // 创建独立的状态实例，避免多账户间的状态冲突
  const state: ServerState = {
    wss: null,
    connections: new Map(),
    isRunning: false,
    handlers: handlers,
    options: options,
    logger: logger,
  };

  // ============================================================================
  // Connection Management (with closure over state)
  // ============================================================================

  function addConnection(conn: ControlPlaneConnection): void {
    state.connections.set(conn.id, conn);
    state.logger?.info?.(`[AO Server] Connection added: ${conn.id} (total: ${state.connections.size})`);
  }

  function removeConnection(connId: string): void {
    const conn = state.connections.get(connId);
    if (conn) {
      state.connections.delete(connId);
      state.logger?.info?.(`[AO Server] Connection removed: ${connId} (total: ${state.connections.size})`);

      // Notify handler
      if (state.handlers) {
        try {
          state.handlers.onDisconnect(connId);
        } catch (err) {
          state.logger?.error?.(`[AO Server] Error in onDisconnect handler: ${err}`);
        }
      }
    }
  }

  function getConnection(connId: string): ControlPlaneConnection | undefined {
    return state.connections.get(connId);
  }

  function getAllConnections(): ControlPlaneConnection[] {
    return Array.from(state.connections.values());
  }

  // ============================================================================
  // Message Handling (with closure over state)
  // ============================================================================

  function handleMessage(connId: string, data: WebSocket.RawData): void {
    const conn = getConnection(connId);
    if (!conn) {
      state.logger?.warn?.(`[AO Server] Message from unknown connection: ${connId}`);
      return;
    }

    try {
      const message = JSON.parse(data.toString());

      // Special handling for ping message - no logging
      if (message.type === "ping") {
        handlePing(conn, message);
        return;
      }

      state.logger?.info?.(`[AO Server] Received message from ${connId}:`);
      state.logger?.info?.(`[AO Server]   type: ${message.type}`);
      state.logger?.info?.(`[AO Server]   id: ${message.id}`);
      state.logger?.info?.(`[AO Server]   isAuthenticated: ${conn.isAuthenticated}`);

      // Special handling for disconnect message - clean up old connections
      // This is used by Control Plane to release connection slots before reconnecting
      if (message.type === "disconnect") {
        handleDisconnect(conn, message);
        return;
      }

      // Special handling for auth message
      if (message.type === "auth" && !conn.isAuthenticated) {
        state.logger?.info?.(`[AO Server]   -> Handling auth message`);
        handleAuth(conn, message).catch((err) => {
          state.logger?.error?.(`[AO Server] Auth error: ${err}`);
        });
        return;
      }

      // Require authentication for other messages
      if (!conn.isAuthenticated) {
        state.logger?.warn?.(`[AO Server]   -> Rejecting: not authenticated`);
        sendError(conn, "AUTH_REQUIRED", "Authentication required");
        return;
      }

      // Forward to handler
      state.logger?.info?.(`[AO Server]   -> Forwarding to handler`);
      if (state.handlers) {
        state.handlers.onMessage(connId, message);
      }
    } catch (err) {
      state.logger?.error?.(`[AO Server] Failed to parse message: ${err}`);
      if (conn.isAuthenticated) {
        sendError(conn, "PARSE_ERROR", "Invalid message format");
      }
    }
  }

  async function handleAuth(
    conn: ControlPlaneConnection,
    message: { id?: string; payload?: { apiKey?: string; controlPlaneId?: string; version?: string } }
  ): Promise<void> {
    const payload = message.payload || {};
    const apiKey = payload.apiKey || "";
    const controlPlaneId = payload.controlPlaneId || "unknown";

    state.logger?.info?.(`[AO Server] Auth attempt from: ${conn.id} (controlPlaneId: ${controlPlaneId})`);

    if (!state.handlers) {
      sendError(conn, "SERVER_ERROR", "Server not ready");
      return;
    }

    try {
      const isValid = await state.handlers.onAuth(apiKey, {
        controlPlaneId,
        remoteAddress: conn.metadata.remoteAddress,
      });

      if (isValid) {
        conn.isAuthenticated = true;
        conn.metadata.controlPlaneId = controlPlaneId;
        conn.metadata.version = payload.version;

        // Send auth response
        const response = {
          type: "auth_response",
          inReplyTo: message.id || "",
          timestamp: Date.now(),
          payload: {
            success: true,
            connectionId: conn.id,
          },
        };
        conn.ws.send(JSON.stringify(response));

        state.logger?.info?.(`[AO Server] Auth successful: ${conn.id} (controlPlaneId: ${controlPlaneId})`);

        // Notify handler
        state.handlers.onConnection(conn);
      } else {
        state.logger?.warn?.(`[AO Server] Auth failed: ${conn.id}`);
        sendError(conn, "AUTH_FAILED", "Invalid API key");

        // Close connection after a short delay
        setTimeout(() => {
          conn.ws.close(1008, "Authentication failed");
        }, 100);
      }
    } catch (err) {
      state.logger?.error?.(`[AO Server] Auth error: ${err}`);
      sendError(conn, "AUTH_ERROR", "Authentication error");
    }
  }

  function handlePing(conn: ControlPlaneConnection, message: { id?: string }): void {
    conn.lastPingAt = Date.now();

    const response = {
      type: "pong",
      inReplyTo: message.id || "",
      timestamp: Date.now(),
    };

    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify(response));
    }
  }

  function handleDisconnect(
    conn: ControlPlaneConnection,
    message: { id?: string; payload?: { reason?: string; controlPlaneId?: string } }
  ): void {
    const reason = message.payload?.reason || "unknown";
    const controlPlaneId = message.payload?.controlPlaneId || "unknown";

    state.logger?.info?.(`[AO Server] Disconnect request received from ${conn.id}`);
    state.logger?.info?.(`[AO Server]   reason: ${reason}`);
    state.logger?.info?.(`[AO Server]   controlPlaneId: ${controlPlaneId}`);

    // 如果是 new_connection_request，关闭所有来自同一 controlPlaneId 的旧连接
    if (reason === "new_connection_request" && controlPlaneId !== "unknown") {
      state.logger?.info?.(`[AO Server] Cleaning up old connections for controlPlaneId: ${controlPlaneId}`);
      let cleanedCount = 0;

      for (const [oldConnId, oldConn] of state.connections) {
        // 跳过当前连接（临时连接）
        if (oldConnId === conn.id) continue;

        // 检查是否来自同一 controlPlaneId
        if (oldConn.metadata.controlPlaneId === controlPlaneId) {
          state.logger?.info?.(`[AO Server]   Closing old connection: ${oldConnId}`);
          try {
            if (oldConn.ws.readyState === WebSocket.OPEN) {
              oldConn.ws.close(1000, "Replaced by new connection");
            }
          } catch (e) {
            // Ignore
          }
          removeConnection(oldConnId);
          cleanedCount++;
        }
      }

      state.logger?.info?.(`[AO Server] Cleaned up ${cleanedCount} old connections for ${controlPlaneId}`);
    }

    // Send acknowledgment
    const response = {
      type: "disconnect_ack",
      inReplyTo: message.id || "",
      timestamp: Date.now(),
      payload: { success: true },
    };

    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify(response));
    }

    // Close this temporary connection after short delay
    setTimeout(() => {
      try {
        if (conn.ws.readyState === WebSocket.OPEN) {
          conn.ws.close(1000, "Disconnect requested");
        }
      } catch (e) {
        // Ignore
      }
      removeConnection(conn.id);
    }, 100);
  }

  // ============================================================================
  // Health Check (with closure over state)
  // ============================================================================

  function startHealthCheck(): void {
    if (state.heartbeatInterval) {
      clearInterval(state.heartbeatInterval);
    }

    const intervalMs = state.options?.healthCheckIntervalMs || 30000;
    const pingTimeoutMs = 30000; // 30 seconds to respond to ping
    const inactivityTimeoutMs = 90000; // 90 seconds no activity = zombie

    state.heartbeatInterval = setInterval(() => {
      const now = Date.now();

      for (const [connId, conn] of state.connections) {
        if (!conn.isAuthenticated) continue;

        const inactivityElapsed = now - conn.lastPingAt;

        // Check for inactive connections first
        if (inactivityElapsed > inactivityTimeoutMs) {
          state.logger?.warn?.(`[AO Server] Connection inactive too long: ${connId} (elapsed: ${inactivityElapsed}ms)`);
          try {
            conn.ws.terminate();
          } catch (e) {
            // Ignore
          }
          removeConnection(connId);
          continue;
        }

        // Send WebSocket-level ping to verify connection is alive
        // This helps detect zombie connections where TCP is broken but readyState is still OPEN
        if (conn.ws.readyState === WebSocket.OPEN) {
          try {
            // Track pending pong to detect zombies
            if (!conn.pendingPongAt) {
              conn.pendingPongAt = now;
              conn.ws.ping();
            } else {
              const pongElapsed = now - conn.pendingPongAt;
              // No pong received for 30 seconds after ping = zombie
              if (pongElapsed > pingTimeoutMs) {
                state.logger?.warn?.(`[AO Server] No pong response, zombie detected: ${connId} (pong elapsed: ${pongElapsed}ms)`);
                try {
                  conn.ws.terminate();
                } catch (e) {
                  // Ignore
                }
                removeConnection(connId);
              }
            }
          } catch (err) {
            state.logger?.warn?.(`[AO Server] Ping failed, removing connection: ${connId}, ${err}`);
            removeConnection(connId);
          }
        } else if (conn.ws.readyState !== WebSocket.CONNECTING) {
          // Connection is CLOSING or CLOSED, clean up
          state.logger?.warn?.(`[AO Server] Connection in bad state: ${connId} (readyState: ${conn.ws.readyState})`);
          removeConnection(connId);
        }
      }
    }, intervalMs);
  }

  function stopHealthCheck(): void {
    if (state.heartbeatInterval) {
      clearInterval(state.heartbeatInterval);
      state.heartbeatInterval = undefined;
    }
  }

  // ============================================================================
  // Return WebSocketServerManager with methods capturing state via closure
  // ============================================================================

  return {
    async start(): Promise<void> {
      if (state.isRunning) {
        throw new Error("Server already running");
      }

      return new Promise((resolve, reject) => {
        try {
          const wss = new WebSocketServer({
            host: options.host,
            port: options.port,
            maxPayload: 10 * 1024 * 1024, // 10MB
          });

          wss.on("connection", (ws, req) => {
            const remoteAddress = req.socket.remoteAddress || "unknown";
            const timestamp = new Date().toISOString();
            state.logger?.info?.(`[AO Server] ========================================`);
            state.logger?.info?.(`[AO Server] NEW WebSocket CONNECTION!`);
            state.logger?.info?.(`[AO Server]   remoteAddress: ${remoteAddress}`);
            state.logger?.info?.(`[AO Server]   timestamp: ${timestamp}`);
            state.logger?.info?.(`[AO Server]   connections: ${state.connections.size}/${options.maxConnections}`);
            state.logger?.info?.(`[AO Server] ========================================`);

            // Check max connections - but allow disconnect messages to clean up old connections
            if (state.connections.size >= options.maxConnections) {
              state.logger?.warn?.(`[AO Server] Max connections reached, attempting cleanup...`);

              // Try to clean up zombie/stale connections first
              const now = Date.now();
              const zombieThreshold = 60000; // 60 seconds of inactivity
              const deadConnections: string[] = [];

              for (const [connId, conn] of state.connections) {
                const inactivityElapsed = now - conn.lastPingAt;
                // Check for connections that haven't responded to ping or are inactive
                if (inactivityElapsed > zombieThreshold || conn.ws.readyState !== WebSocket.OPEN) {
                  deadConnections.push(connId);
                }
              }

              // Clean up dead connections
              if (deadConnections.length > 0) {
                state.logger?.info?.(`[AO Server] Cleaning up ${deadConnections.length} zombie connections`);
                for (const deadConnId of deadConnections) {
                  try {
                    const deadConn = state.connections.get(deadConnId);
                    if (deadConn) {
                      deadConn.ws.terminate();
                    }
                  } catch (e) {
                    // Ignore
                  }
                  removeConnection(deadConnId);
                }
                state.logger?.info?.(`[AO Server] After cleanup: ${state.connections.size}/${options.maxConnections} connections`);
              }

              // If still at max, accept connection temporarily to check for disconnect message
              // This allows CP to clean up old connections even when server is full
              if (state.connections.size >= options.maxConnections) {
                state.logger?.warn?.(`[AO Server] Still at max, accepting temporarily for disconnect check: ${remoteAddress}`);

                // Wait for first message with timeout
                let handledDisconnect = false;
                const tempMessageHandler = (data: WebSocket.RawData) => {
                  try {
                    const msg = JSON.parse(data.toString());
                    if (msg.type === "disconnect") {
                      handledDisconnect = true;
                      // Create a temporary connection object for handleDisconnect
                      const tempConn: ControlPlaneConnection = {
                        id: "temp-" + randomUUID(),
                        ws,
                        connectedAt: Date.now(),
                        lastPingAt: Date.now(),
                        isAuthenticated: false,
                        metadata: { remoteAddress },
                      };
                      // This will clean up old connections for the same controlPlaneId
                      handleDisconnect(tempConn, msg);
                    }
                  } catch (e) {
                    // Ignore parse errors
                  }
                };

                ws.on("message", tempMessageHandler);

                // Set timeout to close if no disconnect message received
                setTimeout(() => {
                  if (!handledDisconnect) {
                    ws.off("message", tempMessageHandler);
                    ws.close(1013, "Server is full");
                  }
                }, 2000);

                // Send welcome to allow disconnect message
                const welcomeMsg = {
                  type: "welcome",
                  timestamp: Date.now(),
                  payload: {
                    server: "AO Plugin V2",
                    requiresAuth: true,
                    message: "Please send disconnect message to clean up old connections",
                  },
                };
                ws.send(JSON.stringify(welcomeMsg));
                return;
              }
            }

            const conn = createConnection(ws, remoteAddress);
            addConnection(conn);

            state.logger?.info?.(`[AO Server] Connection created: ${conn.id}`);
            state.logger?.info?.(`[AO Server] Total connections: ${state.connections.size}`);

            // Setup WebSocket event handlers
            ws.on("message", (data) => {
              try {
                const text = data.toString();
                // Only log non-ping messages at info level
                if (!text.includes('"type":"ping"')) {
                  state.logger?.info?.(`[AO Server] RAW msg: ${text.substring(0, 200)}${text.length > 200 ? '...' : ''}`);
                }
              } catch (e) {
                state.logger?.warn?.(`[AO Server] RAW msg: [binary data]`);
              }
              handleMessage(conn.id, data);
            });

            ws.on("pong", () => {
              // Received pong response - connection is alive
              conn.pendingPongAt = undefined;
              conn.lastPingAt = Date.now();
            });

            ws.on("close", (code, reason) => {
              state.logger?.info?.(`[AO Server] Connection closed: ${conn.id} (code: ${code}, reason: ${reason || 'none'})`);
              removeConnection(conn.id);
            });

            ws.on("error", (err) => {
              state.logger?.error?.(`[AO Server] Connection error: ${conn.id}, ${err}`);
              removeConnection(conn.id);
            });

            // Send welcome message
            const welcomeMsg = {
              type: "welcome",
              timestamp: Date.now(),
              payload: {
                server: "AO Plugin V2",
                requiresAuth: true,
                message: "Please send auth message with apiKey and controlPlaneId",
              },
            };
            state.logger?.info?.(`[AO Server] Sending welcome message to ${conn.id}: ${JSON.stringify(welcomeMsg)}`);
            ws.send(JSON.stringify(welcomeMsg));
          });

          wss.on("error", (err) => {
            state.logger?.error?.(`[AO Server] Server error: ${err}`);
            reject(err);
          });

          wss.on("listening", () => {
            state.isRunning = true;
            state.wss = wss;
            state.logger?.info?.(`[AO Server] Listening on ${options.host}:${options.port}`);

            // Start health check
            startHealthCheck();

            resolve();
          });
        } catch (err) {
          reject(err);
        }
      });
    },

    async stop(): Promise<void> {
      if (!state.isRunning) {
        return;
      }

      stopHealthCheck();

      // Close all connections
      for (const [connId, conn] of state.connections) {
        try {
          conn.ws.close(1001, "Server shutting down");
        } catch (err) {
          state.logger?.error?.(`[AO Server] Error closing connection: ${connId}, ${err}`);
        }
      }
      state.connections.clear();

      // Close server
      if (state.wss) {
        return new Promise((resolve) => {
          state.wss?.close(() => {
            state.isRunning = false;
            state.wss = null;
            state.logger?.info?.("[AO Server] Stopped");
            resolve();
          });
        });
      }

      state.isRunning = false;
    },

    getConnections(): ControlPlaneConnection[] {
      return getAllConnections();
    },

    getConnection(id: string): ControlPlaneConnection | undefined {
      return getConnection(id);
    },

    broadcast(message: unknown): void {
      const data = JSON.stringify(message);
      let sentCount = 0;
      let skippedCount = 0;
      const msgType = (message as {type?: string})?.type || 'unknown';
      const deadConnections: string[] = []; // Track dead connections for cleanup

      log("INFO", `[AO Server] *** BROADCAST CALLED *** msgType=${msgType}`);
      log("INFO", `[AO Server]   connections count: ${state.connections.size}`);

      state.logger?.info?.(`[AO Server] Broadcast started: msgType=${msgType}`);

      // Log full message content for reply messages
      if (msgType === 'reply') {
        const replyMsg = message as {type: string; inReplyTo?: string; sessionId?: string; content?: string};
        log("INFO", `[AO Server] Broadcast reply content: inReplyTo=${replyMsg.inReplyTo || 'N/A'}, sessionId=${replyMsg.sessionId || 'N/A'}, content=${replyMsg.content || 'N/A'}`);
        state.logger?.info?.(`[AO Server] Broadcast reply content: inReplyTo=${replyMsg.inReplyTo || 'N/A'}, sessionId=${replyMsg.sessionId || 'N/A'}, content=${replyMsg.content || 'N/A'}`);
      }

      log("INFO", `[AO Server] Broadcast data preview: ${data.substring(0, 500)}${data.length > 500 ? '...' : ''}`);
      state.logger?.info?.(`[AO Server] Broadcast data preview: ${data.substring(0, 500)}${data.length > 500 ? '...' : ''}`);

      for (const [connId, conn] of state.connections) {
        const isAuth = conn.isAuthenticated;
        const isOpen = conn.ws.readyState === WebSocket.OPEN;

        log("INFO", `[AO Server] Broadcast check: connId=${connId}, isAuthenticated=${isAuth}, readyState=${conn.ws.readyState}, isOpen=${isOpen}`);
        state.logger?.info?.(`[AO Server] Broadcast check: connId=${connId}, isAuthenticated=${isAuth}, readyState=${conn.ws.readyState}, isOpen=${isOpen}`);

        if (conn.isAuthenticated && conn.ws.readyState === WebSocket.OPEN) {
          try {
            conn.ws.send(data);
            sentCount++;
            log("INFO", `[AO Server] Broadcast sent to ${connId}`);
            state.logger?.info?.(`[AO Server] Broadcast sent to ${connId}`);
          } catch (err) {
            // Send failed - this is a zombie/stale connection, mark for removal
            log("ERROR", `[AO Server] Broadcast error (zombie detected): ${connId}, ${err}`);
            state.logger?.error?.(`[AO Server] Broadcast error (zombie detected): ${connId}, ${err}`);
            deadConnections.push(connId);
          }
        } else {
          skippedCount++;
          log("WARN", `[AO Server] Broadcast skipped: ${connId} (auth=${isAuth}, open=${isOpen})`);
          state.logger?.warn?.(`[AO Server] Broadcast skipped: ${connId} (auth=${isAuth}, open=${isOpen})`);
        }
      }

      // Clean up dead/zombie connections detected during broadcast
      if (deadConnections.length > 0) {
        log("WARN", `[AO Server] Cleaning up ${deadConnections.length} zombie connections: ${deadConnections.join(', ')}`);
        state.logger?.warn?.(`[AO Server] Cleaning up ${deadConnections.length} zombie connections: ${deadConnections.join(', ')}`);
        for (const deadConnId of deadConnections) {
          try {
            const deadConn = state.connections.get(deadConnId);
            if (deadConn) {
              deadConn.ws.terminate(); // Force close the underlying socket
            }
          } catch (e) {
            // Ignore errors during cleanup
          }
          removeConnection(deadConnId);
        }
      }

      log("INFO", `[AO Server] Broadcast done: sent=${sentCount}, skipped=${skippedCount}, zombiesRemoved=${deadConnections.length}, msgType=${msgType}`);
      state.logger?.info?.(`[AO Server] Broadcast: sent=${sentCount}, skipped=${skippedCount}, zombiesRemoved=${deadConnections.length}, msgType=${msgType}`);
    },

    sendTo(connectionId: string, message: unknown): boolean {
      const conn = getConnection(connectionId);

      // DEBUG: 打印所有连接
      log("INFO", `[AO Server] sendTo called: target=${connectionId}`);
      log("INFO", `[AO Server]   all connections: ${Array.from(state.connections.keys()).join(', ')}`);
      log("INFO", `[AO Server]   conn found: ${!!conn}`);

      if (conn) {
        log("INFO", `[AO Server]   conn.id: ${conn.id}`);
        log("INFO", `[AO Server]   conn.isAuthenticated: ${conn.isAuthenticated}`);
        log("INFO", `[AO Server]   conn.ws.readyState: ${conn.ws.readyState}`);
        log("INFO", `[AO Server]   WebSocket.OPEN: ${WebSocket.OPEN}`);
      }

      if (conn && conn.isAuthenticated && conn.ws.readyState === WebSocket.OPEN) {
        try {
          const data = JSON.stringify(message);
          log("INFO", `[AO Server]   sending data: ${data.substring(0, 200)}...`);
          conn.ws.send(data);
          log("INFO", `[AO Server]   send() completed without error`);
          state.logger?.info?.(`[AO Server] Send to ${connectionId}: success, msgType=${(message as {type?: string})?.type || 'unknown'}`);
          return true;
        } catch (err) {
          // Send failed - this is a zombie/stale connection, clean it up
          state.logger?.error?.(`[AO Server] Send error (zombie detected): ${connectionId}, ${err}`);
          try {
            conn.ws.terminate();
          } catch (e) {
            // Ignore
          }
          removeConnection(connectionId);
        }
      } else {
        state.logger?.warn?.(`[AO Server] Send to ${connectionId}: failed - conn=${!!conn}, auth=${conn?.isAuthenticated}, state=${conn?.ws?.readyState}`);
      }
      return false;
    },

    isRunning(): boolean {
      return state.isRunning;
    },
  };
}

// ============================================================================
// Legacy exports (deprecated - for backward compatibility)
// ============================================================================

/**
 * @deprecated Use createWebSocketServer() instead.
 * These functions are kept for backward compatibility but will be removed.
 */

// Global state for legacy compatibility (single-account scenarios)
let _legacyState: {
  connections: Map<string, ControlPlaneConnection>;
} | null = null;

function getLegacyState(): { connections: Map<string, ControlPlaneConnection> } {
  if (!_legacyState) {
    _legacyState = { connections: new Map() };
  }
  return _legacyState;
}

export function getConnections(): ControlPlaneConnection[] {
  return Array.from(getLegacyState().connections.values());
}

export function getConnectionById(id: string): ControlPlaneConnection | undefined {
  return getLegacyState().connections.get(id);
}