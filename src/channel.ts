/**
 * AO Channel Plugin V2
 *
 * 重构后的 AO 频道插件，整合断路器、连接池、消息队列和指标收集
 */

import type { ChannelGatewayContext } from "openclaw/plugin-sdk";
import { randomUUID } from "node:crypto";
import type {
  ChannelPlugin,
  AoAccount,
  AoConfig,
  AccountStatus,
  Logger,
  ControlPlaneMessage,
  ChatMessage,
  ReplyMessage,
} from "./types.js";
import {
  resolveAoAccount,
  listAoAccountIds,
  aoConfigSchema,
  DEFAULT_ACCOUNT_ID,
  asRecord,
} from "./config.js";
import {
  createConnectionManager,
  getConnectionManager,
  removeConnectionManager,
  type ConnectionManager,
} from "./connection/manager.js";
import {
  routeInboundMessage,
  createReplyMessage,
  parseMessage,
  validateInboundMessage,
  buildOutboundContext,
} from "./messaging/handler.js";
import { log, initLogFile } from "./logger.js";

// ============================================================================
// Constants
// ============================================================================

const PROTOCOL_VERSION = 3;

// ============================================================================
// Error Classification
// ============================================================================

type AoBridgeErrorCode =
  | "AO_TIMEOUT"
  | "AO_NETWORK"
  | "AO_AUTH_FAILED"
  | "AO_PROTOCOL_ERROR"
  | "AO_TARGET_OFFLINE"
  | "AO_RATE_LIMITED"
  | "AO_BRIDGE_UNAVAILABLE"
  | "AO_UNKNOWN";

interface AoBridgeError extends Error {
  code: AoBridgeErrorCode;
  retryable: boolean;
  status?: number;
  attempt?: number;
}

function createBridgeError(params: {
  code: AoBridgeErrorCode;
  message: string;
  retryable: boolean;
  status?: number;
  attempt?: number;
}): AoBridgeError {
  const err = new Error(params.message) as AoBridgeError;
  err.code = params.code;
  err.retryable = params.retryable;
  err.status = params.status;
  err.attempt = params.attempt;
  return err;
}

function classifyHttpError(
  status: number,
  detail: string
): { code: AoBridgeErrorCode; retryable: boolean } {
  if (status === 401 || status === 403) {
    return { code: "AO_AUTH_FAILED", retryable: false };
  }
  if (status === 400 || status === 404 || status === 409 || status === 422) {
    return { code: "AO_PROTOCOL_ERROR", retryable: false };
  }
  if (status === 429) {
    return { code: "AO_RATE_LIMITED", retryable: true };
  }
  if (status === 503 && /no openclaw ws client connected/i.test(detail)) {
    return { code: "AO_TARGET_OFFLINE", retryable: true };
  }
  if (status >= 500) {
    return { code: "AO_BRIDGE_UNAVAILABLE", retryable: true };
  }
  return { code: "AO_UNKNOWN", retryable: false };
}

// ============================================================================
// Utility Functions
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function calculateBackoffWithJitter(
  baseMs: number,
  attempt: number,
  maxMs: number = 30000
): number {
  const exp = Math.max(0, attempt - 1);
  const exponential = baseMs * Math.pow(2, exp);
  const jitter = Math.random() * 0.3 * exponential;
  return Math.min(exponential + jitter, maxMs);
}

function generateEventId(): string {
  try {
    return `ao-${randomUUID()}`;
  } catch {
    return `ao-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function resolveAoWsUrl(baseUrl: string): string {
  const url = new URL("/ws/openclaw", baseUrl);
  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol === "http:") {
    url.protocol = "ws:";
  }
  return url.toString();
}

function parseJsonRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return asRecord(parsed);
  } catch {
    return {};
  }
}

function resolveInboundText(payload: Record<string, unknown>): string {
  const message = asRecord(payload.message);
  const directContent = payload.content;
  const messageContent = message.content;

  if (typeof messageContent === "string" && messageContent.trim()) {
    return messageContent.trim();
  }
  if (typeof directContent === "string" && directContent.trim()) {
    return directContent.trim();
  }
  return "";
}

function resolveBootstrapChannelId(payload: unknown): string | undefined {
  const record = asRecord(payload);

  const direct =
    typeof record.channel_id === "string" && record.channel_id.trim()
      ? record.channel_id.trim()
      : typeof record.channelId === "string" && record.channelId.trim()
        ? record.channelId.trim()
        : undefined;

  if (direct) {
    return direct;
  }

  const channelConfig = asRecord(record.channel_config);
  return typeof channelConfig.channelId === "string" && channelConfig.channelId.trim()
    ? channelConfig.channelId.trim()
    : undefined;
}

// ============================================================================
// Bootstrap API
// ============================================================================

async function fetchBootstrapChannelId(account: AoAccount): Promise<string | undefined> {
  if (!account.bridgeBaseUrl || !account.bootstrapEnabled) {
    return undefined;
  }

  const endpoint = new URL("/api/openclaw/bootstrap", account.bridgeBaseUrl).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), account.timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: "GET",
      headers: {
        ...(account.apiKey ? { authorization: `Bearer ${account.apiKey}` } : {}),
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      return undefined;
    }

    const payload = (await res.json().catch(() => ({}))) as unknown;
    return resolveBootstrapChannelId(payload);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// Connection Manager Integration (V2 Server Mode)
// ============================================================================

interface AoRuntimeState {
  manager: ConnectionManager | null;
  stopped: boolean;
  logger?: Logger;
}

async function createConnectionManagerRuntime(
  account: AoAccount,
  ctx: ChannelGatewayContext,
  state: AoRuntimeState
): Promise<void> {
  // CRITICAL FIX: Remove any existing manager for this account before creating a new one.
  // This ensures we get a fresh manager with fresh handlers that reference the current state.
  // Without this, after a reload, the old manager's handlers would reference a stale state
  // where state.manager is null, causing reply messages to fail.
  const existingManager = getConnectionManager(account.accountId);
  if (existingManager) {
    ctx.log?.warn?.(`[${account.accountId}] Removing existing connection manager before creating new one`);
    removeConnectionManager(account.accountId);
  }

  const forwardToOpenClaw = (connectionId: string) => async (message: ControlPlaneMessage): Promise<void> => {
    if (message.type !== "chat") {
      ctx.log?.debug?.(`[AO Channel] forwardToOpenClaw: ignoring non-chat message type: ${message.type}`);
      return;
    }

    const chatMessage = message as unknown as ChatMessage;
    const sessionId = chatMessage.sessionId || "default";
    const content = chatMessage.content || "";
    const from = chatMessage.from?.id || "ao_bridge";

    log("INFO", `[AO Channel] ========== forwardToOpenClaw called ==========`);
    log("INFO", `[AO Channel]   connectionId: ${connectionId}`);
    log("INFO", `[AO Channel]   originalMessageId: ${message.id}`);
    log("INFO", `[AO Channel]   sessionId: ${sessionId}`);
    log("INFO", `[AO Channel]   from: ${from}`);
    log("INFO", `[AO Channel]   state.manager exists: ${state.manager !== null}`);
    if (state.manager) {
      log("INFO", `[AO Channel]   state.manager.getStats(): ${JSON.stringify(state.manager.getStats())}`);
    }

    ctx.log?.info?.(`[AO Channel] forwardToOpenClaw called:`);
    ctx.log?.info?.(`[AO Channel]   originalMessageId: ${message.id}`);
    ctx.log?.info?.(`[AO Channel]   sessionId: ${sessionId}`);
    ctx.log?.info?.(`[AO Channel]   from: ${from}`);
    ctx.log?.info?.(`[AO Channel]   connectionId: ${connectionId}`);

    await forwardInboundToOpenClaw({
      cfg: ctx.cfg,
      channelRuntime: ctx.channelRuntime,
      accountId: account.accountId,
      connectionId: connectionId,
      payload: {
        sessionId,
        content,
        from: { id: from },
        session: { id: sessionId },
      },
      log: ctx.log,
      reply: async (responseText: string) => {
        // Create reply message and send through connection manager (point-to-point)
        const logPrefix = `[AO Channel]`;
        log("INFO", `${logPrefix} Reply callback triggered by OpenClaw`);
        log("INFO", `${logPrefix}   originalMessageId: ${message.id}`);
        log("INFO", `${logPrefix}   sessionId: ${sessionId}`);
        log("INFO", `${logPrefix}   connectionId: ${connectionId}`);
        log("INFO", `${logPrefix}   responseLength: ${responseText.length} chars`);
        log("INFO", `${logPrefix}   responseText: ${responseText.substring(0, 100)}...`);

        ctx.log?.info?.(`${logPrefix} Reply callback triggered by OpenClaw`);
        ctx.log?.info?.(`${logPrefix}   originalMessageId: ${message.id}`);
        ctx.log?.info?.(`${logPrefix}   sessionId: ${sessionId}`);
        ctx.log?.info?.(`${logPrefix}   connectionId: ${connectionId}`);
        ctx.log?.info?.(`${logPrefix}   responseLength: ${responseText.length} chars`);
        ctx.log?.info?.(`${logPrefix}   responseText: ${responseText}`);

        const reply = createReplyMessage(
          message.id,
          sessionId,
          responseText,
          { source: "openclaw", accountId: account.accountId }
        );

        log("INFO", `${logPrefix}   replyMessageId: ${reply.inReplyTo}`);
        log("INFO", `${logPrefix}   reply type: ${reply.type}`);
        log("INFO", `${logPrefix}   reply content: ${reply.content}`);
        log("INFO", `${logPrefix}   Sending to Control Plane (point-to-point)...`);
        log("INFO", `${logPrefix}   state.manager exists: ${state.manager !== null}`);
        log("INFO", `${logPrefix}   sendToServer type: ${typeof state.manager?.sendToServer}`);
        log("INFO", `${logPrefix}   connectionId for sendToServer: ${connectionId}`);

        // DEBUG: 打印所有可用连接
        if (state.manager) {
          const stats = state.manager.getStats();
          log("INFO", `${logPrefix}   manager stats: ${JSON.stringify(stats)}`);
          const serverConns = state.manager.getServerConnections();
          log("INFO", `${logPrefix}   server connections count: ${serverConns.length}`);
          for (const sc of serverConns) {
            log("INFO", `${logPrefix}     - conn.id: ${sc.id}, isAuthenticated: ${sc.isAuthenticated}`);
          }
        }

        if (!state.manager) {
          log("ERROR", `${logPrefix}   ERROR: state.manager is null!`);
          log("ERROR", `${logPrefix}   This means the connection manager has not been initialized or has been stopped.`);
        } else {
          log("INFO", `${logPrefix}   Calling sendToServer(${connectionId}, reply)...`);
          const sent = state.manager.sendToServer(connectionId, reply);
          log("INFO", `${logPrefix}   sendToServer returned: ${sent}`);
          if (!sent) {
            log("ERROR", `${logPrefix}   sendToServer FAILED! Check if connectionId matches an active connection.`);
          }
        }

        log("INFO", `${logPrefix}   Reply send completed`);
      },
    });
  };

  const manager = createConnectionManager({
    account,
    handlers: {
      onServerConnection: (conn) => {
        ctx.log?.info?.(`[${account.accountId}] Control Plane connected: ${conn.id}`);
        ctx.setStatus?.({
          accountId: account.accountId,
          running: true,
          connected: true,
          lastConnectedAt: Date.now(),
        });
      },
      onServerDisconnect: (connId) => {
        ctx.log?.info?.(`[${account.accountId}] Control Plane disconnected: ${connId}`);
        // Only update status if no more connections
        if (!state.manager?.hasActiveConnection()) {
          ctx.setStatus?.({
            accountId: account.accountId,
            running: true,
            connected: false,
            lastError: `Control Plane connection closed: ${connId}`,
          });
        }
      },
      onServerMessage: async (connId, message) => {
        ctx.log?.info?.(`[${account.accountId}] ========================================`);
        ctx.log?.info?.(`[${account.accountId}] ========== onServerMessage ==========`);
        ctx.log?.info?.(`[${account.accountId}]   connId: ${connId}`);
        ctx.log?.info?.(`[${account.accountId}]   message type: ${(message as {type?: string})?.type || 'unknown'}`);
        ctx.log?.info?.(`[${account.accountId}]   message id: ${(message as {id?: string})?.id || 'unknown'}`);
        ctx.log?.info?.(`[${account.accountId}]   raw message: ${JSON.stringify(message).substring(0, 500)}${JSON.stringify(message).length > 500 ? '...' : ''}`);
        ctx.log?.info?.(`[${account.accountId}] ========================================`);

        const parsedMessage = parseMessage(JSON.stringify(message));
        if (!parsedMessage || !validateInboundMessage(parsedMessage)) {
          ctx.log?.warn?.(`[${account.accountId}] Invalid message from ${connId}: failed validation`);
          ctx.log?.warn?.(`[${account.accountId}]   raw message: ${JSON.stringify(message).substring(0, 300)}`);
          return;
        }

        ctx.log?.info?.(`[${account.accountId}] Message validated, type: ${parsedMessage.type}, id: ${parsedMessage.id}`);
        ctx.log?.info?.(`[${account.accountId}] Routing to handler...`);

        const result = await routeInboundMessage(parsedMessage, {
          account,
          connectionId: connId,
          logger: ctx.log,
          sendReply: (reply) => {
            ctx.log?.info?.(`[${account.accountId}] Sending reply to ${connId}: ${reply.type}`);
            state.manager?.sendToServer(connId, reply);
          },
          sendStatus: (status) => {
            ctx.log?.info?.(`[${account.accountId}] Sending status to ${connId}: ${status.type}`);
            state.manager?.sendToServer(connId, status);
          },
          forwardToOpenClaw: forwardToOpenClaw(connId),
        });

        if (!result.success) {
          ctx.log?.error?.(`[${account.accountId}] Message handling failed: ${result.error}`);
        } else {
          ctx.log?.info?.(`[${account.accountId}] Message handling succeeded`);
        }
      },
      onServerAuth: async (apiKey, metadata) => {
        // Validate API key against account configuration
        const isValid = apiKey === account.apiKey;
        ctx.log?.info?.(
          `[${account.accountId}] Auth attempt from ${metadata?.controlPlaneId || "unknown"}: ${isValid ? "success" : "failed"}`
        );
        return isValid;
      },
      onClientConnect: () => {
        ctx.log?.info?.(`[${account.accountId}] Connected to Control Plane as client`);
        ctx.setStatus?.({
          accountId: account.accountId,
          running: true,
          connected: true,
          lastConnectedAt: Date.now(),
        });
      },
      onClientDisconnect: () => {
        ctx.log?.info?.(`[${account.accountId}] Disconnected from Control Plane as client`);
        if (!state.manager?.hasActiveConnection()) {
          ctx.setStatus?.({
            accountId: account.accountId,
            running: true,
            connected: false,
            lastError: "Control Plane client connection closed",
          });
        }
      },
      onClientMessage: async (message) => {
        const parsedMessage = parseMessage(JSON.stringify(message));
        if (!parsedMessage || !validateInboundMessage(parsedMessage)) {
          ctx.log?.warn?.(`[${account.accountId}] Invalid message from Control Plane`);
          return;
        }

        const result = await routeInboundMessage(parsedMessage, {
          account,
          connectionId: "client",
          logger: ctx.log,
          sendReply: (reply) => {
            state.manager?.sendToControlPlane(reply);
          },
          sendStatus: (status) => {
            state.manager?.sendToControlPlane(status);
          },
          forwardToOpenClaw: forwardToOpenClaw("client"),
        });

        if (!result.success) {
          ctx.log?.error?.(`[${account.accountId}] Message handling failed: ${result.error}`);
        }
      },
      onClientError: (error) => {
        ctx.log?.error?.(`[${account.accountId}] Client connection error: ${error.message}`);
      },
    },
    logger: ctx.log,
  });

  state.manager = manager;

  log("INFO", `[AO Channel] state.manager assigned, manager.getMode(): ${manager.getMode()}`);
  log("INFO", `[AO Channel] state.manager.getStats(): ${JSON.stringify(state.manager.getStats())}`);

  // Start the connection manager
  try {
    await manager.start();
    ctx.log?.info?.(`[${account.accountId}] Connection manager started in ${manager.getMode()} mode`);
    log("INFO", `[AO Channel] Connection manager started in ${manager.getMode()} mode`);

    // Wait for abort signal
    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        if (ctx.abortSignal.aborted || state.stopped) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);

      ctx.abortSignal.addEventListener("abort", () => {
        clearInterval(checkInterval);
        resolve();
      }, { once: true });
    });
  } finally {
    await manager.stop();
    state.manager = null;
    // Remove from global map so next start creates a fresh manager
    removeConnectionManager(account.accountId);
    ctx.setStatus?.({
      accountId: account.accountId,
      running: false,
      lastStopAt: Date.now(),
    });
  }
}

async function forwardInboundToOpenClaw(ctx: {
  cfg: unknown;
  channelRuntime: unknown;
  accountId: string;
  connectionId: string;
  payload: Record<string, unknown>;
  log?: Logger;
  reply?: (responseText: string) => Promise<void>;
}): Promise<void> {
  log("INFO", `[AO Channel] ========== forwardInboundToOpenClaw STARTED ==========`);
  log("INFO", `[AO Channel]   accountId: ${ctx.accountId}`);
  log("INFO", `[AO Channel]   connectionId: ${ctx.connectionId}`);
  log("INFO", `[AO Channel]   payload keys: ${Object.keys(ctx.payload).join(', ')}`);
  log("INFO", `[AO Channel]   ctx.reply exists: ${!!ctx.reply}`);

  const text = resolveInboundText(ctx.payload);
  log("INFO", `[AO Channel]   resolved text length: ${text?.length || 0}`);
  if (!text) {
    ctx.log?.warn?.(`[AO Channel] forwardInboundToOpenClaw: empty text, skipping`);
    log("WARN", `[AO Channel]   EMPTY TEXT - returning early`);
    return;
  }

  const session = asRecord(ctx.payload.session);
  const from = asRecord(ctx.payload.from);
  const eventId =
    (typeof ctx.payload.eventId === "string" && ctx.payload.eventId.trim()) ||
    (typeof asRecord(ctx.payload.message).id === "string" && (asRecord(ctx.payload.message).id as string).trim()) ||
    `ao-in-${Date.now()}`;
  const chatId =
    (typeof session.id === "string" && session.id.trim()) ||
    (typeof ctx.payload.sessionId === "string" && ctx.payload.sessionId.trim()) ||
    "default";
  const senderId =
    (typeof from.id === "string" && from.id.trim()) ||
    (typeof ctx.payload.fromId === "string" && ctx.payload.fromId.trim()) ||
    "ao_bridge";

  // Log message being forwarded to OpenClaw
  const logPrefix = `[AO Channel]`;
  log("INFO", `${logPrefix} >>> Forwarding message to OpenClaw:`);
  log("INFO", `${logPrefix}     eventId: ${eventId}`);
  log("INFO", `${logPrefix}     chatId: ${chatId}`);
  log("INFO", `${logPrefix}     senderId: ${senderId}`);
  log("INFO", `${logPrefix}     content: ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`);

  ctx.log?.info?.(`[AO Channel] >>> Forwarding message to OpenClaw:`);
  ctx.log?.info?.(`[AO Channel]     eventId: ${eventId}`);
  ctx.log?.info?.(`[AO Channel]     chatId: ${chatId}`);
  ctx.log?.info?.(`[AO Channel]     senderId: ${senderId}`);
  ctx.log?.info?.(`[AO Channel]     content: ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`);

  const replyObj = (ctx.channelRuntime as any)?.reply;
  if (!replyObj) {
    ctx.log?.error?.(`[AO Channel]     channelRuntime.reply is undefined!`);
    throw new Error("channelRuntime.reply is undefined - OpenClaw not properly initialized");
  }

  ctx.log?.info?.(`[AO Channel]     channelRuntime.reply keys: ${Object.keys(replyObj).join(', ')}`);

  // Use withReplyDispatcher + dispatchReplyFromConfig
  // The SDK will use its internal getReplyFromConfig by default
  const withDispatcher = replyObj.withReplyDispatcher;
  const dispatchFromConfig = replyObj.dispatchReplyFromConfig;
  const finalizeCtx = replyObj.finalizeInboundContext;

  if (typeof withDispatcher !== "function" || typeof dispatchFromConfig !== "function" || typeof finalizeCtx !== "function") {
    ctx.log?.error?.(`[AO Channel]     Required methods not available!`);
    ctx.log?.error?.(`[AO Channel]     withReplyDispatcher: ${typeof withDispatcher}`);
    ctx.log?.error?.(`[AO Channel]     dispatchReplyFromConfig: ${typeof dispatchFromConfig}`);
    ctx.log?.error?.(`[AO Channel]     finalizeInboundContext: ${typeof finalizeCtx}`);
    throw new Error("Required OpenClaw API methods not found");
  }

  try {
    ctx.log?.info?.(`[AO Channel]     Using createReplyDispatcherWithTyping pattern...`);

    // Check if createReplyDispatcherWithTyping is available
    const createDispatcherWithTyping = replyObj.createReplyDispatcherWithTyping;

    if (typeof createDispatcherWithTyping !== "function") {
      ctx.log?.warn?.(`[AO Channel]     createReplyDispatcherWithTyping not available, falling back to captureDispatcher`);
      // Fallback to the old captureDispatcher pattern
      return await useCaptureDispatcherPattern();
    }

    // Accumulate reply text from deliver callback
    const replyTextParts: string[] = [];
    let replyCalled = false;

    // Create the inbound context
    const inboundCtx = finalizeCtx({
      Body: text,
      BodyForAgent: text,
      RawBody: text,
      CommandBody: text,
      BodyForCommands: text,
      From: senderId,
      To: chatId,
      SessionKey: `ao:${ctx.accountId}:${chatId}`,
      AccountId: ctx.accountId,
      ChatType: "direct",
      SenderId: senderId,
      Provider: "ao",
      Surface: "ao",
      MessageSid: eventId,
      OriginatingChannel: "ao",
      OriginatingTo: chatId,
    });

    ctx.log?.info?.(`[AO Channel]     finalizeInboundContext succeeded`);

    // Create replyOptions with onModelSelected callback
    const replyOptions = {
      onModelSelected: (modelCtx: { provider: string; model: string; thinkLevel?: string }) => {
        ctx.log?.info?.(`[AO Channel]     Model selected: ${modelCtx.provider}/${modelCtx.model}`);
      },
    };

    // Use createReplyDispatcherWithTyping pattern like Feishu plugin
    const { dispatcher, replyOptions: typingReplyOptions, markDispatchIdle } =
      createDispatcherWithTyping({
        deliver: async (payload: any, info: { kind: string }) => {
          log("INFO", `[AO Channel] deliver callback FIRED: kind=${info.kind}`);
          ctx.log?.info?.(`[AO Channel]     deliver called: kind=${info.kind}`);
          if (payload?.text) {
            replyTextParts.push(payload.text);
            log("INFO", `[AO Channel]   accumulated text length: ${payload.text.length}, total parts: ${replyTextParts.length}`);
            ctx.log?.info?.(`[AO Channel]       accumulated ${replyTextParts.length} parts`);
          } else {
            log("WARN", `[AO Channel]   deliver called but no text in payload!`);
          }
        },
        onReplyStart: () => {
          ctx.log?.info?.(`[AO Channel]     onReplyStart called`);
          replyTextParts.length = 0; // Clear any previous parts
        },
        onTypingController: (typing: any) => {
          ctx.log?.debug?.(`[AO Channel]     onTypingController called`);
        },
        onTypingCleanup: () => {
          ctx.log?.debug?.(`[AO Channel]     onTypingCleanup called`);
        },
      });

    // Merge replyOptions
    const mergedReplyOptions = {
      ...replyOptions,
      ...typingReplyOptions,
    };

    // Use the withReplyDispatcher + dispatchReplyFromConfig pattern
    await withDispatcher({
      dispatcher,
      onSettled: () => {
        ctx.log?.info?.(`[AO Channel]     onSettled called`);
        markDispatchIdle();
      },
      run: () =>
        dispatchFromConfig({
          ctx: inboundCtx,
          cfg: ctx.cfg as any || {},
          dispatcher,
          replyOptions: mergedReplyOptions,
        }),
    });

    // After dispatch completes, check if we have reply text
    ctx.log?.info?.(`[AO Channel]     dispatch completed, replyTextParts count: ${replyTextParts.length}`);
    log("INFO", `[AO Channel] dispatch completed, replyTextParts count: ${replyTextParts.length}`);

    if (replyTextParts.length > 0 && !replyCalled) {
      const fullReply = replyTextParts.join('\n');
      log("INFO", `[AO Channel]   fullReply length: ${fullReply.length} chars`);
      log("INFO", `[AO Channel]   fullReply preview: ${fullReply.substring(0, 200)}...`);
      ctx.log?.info?.(`[AO Channel]     Calling reply callback with ${fullReply.length} chars`);
      if (ctx.reply) {
        log("INFO", `[AO Channel]   CALLING ctx.reply NOW!`);
        log("INFO", `[AO Channel]   ctx.reply type: ${typeof ctx.reply}`);
        try {
          await ctx.reply(fullReply);
          replyCalled = true;
          log("INFO", `[AO Channel]   ctx.reply returned successfully`);
        } catch (replyError) {
          log("ERROR", `[AO Channel]   ctx.reply threw error: ${replyError}`);
          ctx.log?.error?.(`[AO Channel]   ctx.reply error: ${replyError}`);
        }
      } else {
        log("ERROR", `[AO Channel]   ctx.reply is undefined!`);
      }
    } else {
      log("WARN", `[AO Channel]   NOT calling reply: parts=${replyTextParts.length}, replyCalled=${replyCalled}`);
      if (replyTextParts.length === 0) {
        log("WARN", `[AO Channel]   No reply text generated by OpenClaw!`);
      }
    }

    ctx.log?.info?.(`[AO Channel]     createReplyDispatcherWithTyping pattern completed successfully`);
    return;
  } catch (err) {
    ctx.log?.error?.(`[AO Channel]     OpenClaw API call failed: ${err}`);
    throw err;
  }

  // Fallback pattern using captureDispatcher
  async function useCaptureDispatcherPattern(): Promise<void> {
    ctx.log?.info?.(`[AO Channel]     Using fallback captureDispatcher pattern...`);

    // Accumulate reply text from dispatcher calls
    const replyTextParts: string[] = [];

    // Create a custom dispatcher that captures replies and calls our callback
    const captureDispatcher = {
      sendToolResult: (payload: any) => {
        ctx.log?.info?.(`[AO Channel]     sendToolResult called`);
        if (payload?.text) {
          replyTextParts.push(payload.text);
        }
        return true;
      },
      sendBlockReply: (payload: any) => {
        ctx.log?.info?.(`[AO Channel]     sendBlockReply called`);
        if (payload?.text) {
          replyTextParts.push(payload.text);
        }
        return true;
      },
      sendFinalReply: (payload: any) => {
        ctx.log?.info?.(`[AO Channel]     sendFinalReply called`);
        if (payload?.text) {
          replyTextParts.push(payload.text);
        }
        return true;
      },
      waitForIdle: async () => {},
      getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
      markComplete: () => {},
    };

    // Create the inbound context
    const inboundCtx = finalizeCtx({
      Body: text,
      BodyForAgent: text,
      RawBody: text,
      CommandBody: text,
      BodyForCommands: text,
      From: senderId,
      To: chatId,
      SessionKey: `ao:${ctx.accountId}:${chatId}`,
      AccountId: ctx.accountId,
      ChatType: "direct",
      SenderId: senderId,
      Provider: "ao",
      Surface: "ao",
      MessageSid: eventId,
      OriginatingChannel: "ao",
      OriginatingTo: chatId,
    });

    ctx.log?.info?.(`[AO Channel]     finalizeInboundContext succeeded`);

    // Create replyOptions with onModelSelected callback
    const replyOptions = {
      onModelSelected: (modelCtx: { provider: string; model: string; thinkLevel?: string }) => {
        ctx.log?.info?.(`[AO Channel]     Model selected: ${modelCtx.provider}/${modelCtx.model}`);
      },
    };

    // Use the withReplyDispatcher + dispatchReplyFromConfig pattern
    await withDispatcher({
      dispatcher: captureDispatcher,
      run: () =>
        dispatchFromConfig({
          ctx: inboundCtx,
          cfg: ctx.cfg as any || {},
          dispatcher: captureDispatcher,
          replyOptions,
        }),
    });

    // After dispatch completes, check if we have reply text
    ctx.log?.info?.(`[AO Channel]     dispatch completed, replyTextParts count: ${replyTextParts.length}`);

    if (replyTextParts.length > 0) {
      const fullReply = replyTextParts.join('\n');
      ctx.log?.info?.(`[AO Channel]     Calling reply callback with ${fullReply.length} chars`);
      if (ctx.reply) {
        await ctx.reply(fullReply);
      }
    }

    ctx.log?.info?.(`[AO Channel]     captureDispatcher pattern completed`);
  }
}

// ============================================================================
// Outbound HTTP with Retry
// ============================================================================

async function postWithRetry(params: {
  endpoint: string;
  account: AoAccount;
  bodyRaw: string;
  headers: Record<string, string>;
  eventId: string;
}): Promise<{ payload: Record<string, unknown>; attempt: number }> {
  let lastError: AoBridgeError | undefined;
  const startTime = Date.now();

  for (let attempt = 1; attempt <= params.account.retryMaxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.account.timeoutMs);

    try {
      const res = await fetch(params.endpoint, {
        method: "POST",
        headers: params.headers,
        body: params.bodyRaw,
        signal: controller.signal,
      });

      const raw = await res.text().catch(() => "");
      const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};

      if (res.ok) {
        return { payload: parsed, attempt };
      }

      const detail =
        typeof parsed.detail === "string" && parsed.detail.trim()
          ? parsed.detail.trim()
          : raw || "unknown error";
      const classified = classifyHttpError(res.status, detail);
      lastError = createBridgeError({
        code: classified.code,
        retryable: classified.retryable,
        status: res.status,
        attempt,
        message: `[${classified.code}] eventId=${params.eventId} attempt=${attempt}/${params.account.retryMaxAttempts} status=${res.status} detail=${detail}`,
      });

      if (!classified.retryable || attempt >= params.account.retryMaxAttempts) {
        throw lastError;
      }

      await sleep(calculateBackoffWithJitter(params.account.retryBackoffMs, attempt));
    } catch (error) {
      if ((error as AoBridgeError).code) {
        if (attempt >= params.account.retryMaxAttempts || !(error as AoBridgeError).retryable) {
          throw error;
        }
        await sleep(calculateBackoffWithJitter(params.account.retryBackoffMs, attempt));
        continue;
      }

      const isAbort = error instanceof Error && error.name === "AbortError";
      const code: AoBridgeErrorCode = isAbort ? "AO_TIMEOUT" : "AO_NETWORK";
      const retryable = true;
      const detail = error instanceof Error ? error.message : String(error);
      lastError = createBridgeError({
        code,
        retryable,
        attempt,
        message: `[${code}] eventId=${params.eventId} attempt=${attempt}/${params.account.retryMaxAttempts} detail=${isAbort ? `timeout(${params.account.timeoutMs}ms)` : detail}`,
      });

      if (attempt >= params.account.retryMaxAttempts) {
        throw lastError;
      }

      await sleep(calculateBackoffWithJitter(params.account.retryBackoffMs, attempt));
    } finally {
      clearTimeout(timer);
    }
  }

  throw (
    lastError ??
    createBridgeError({
      code: "AO_UNKNOWN",
      retryable: false,
      message: `[AO_UNKNOWN] eventId=${params.eventId} detail=unknown error`,
    })
  );
}

// ============================================================================
// Channel Plugin Implementation
// ============================================================================

export const aoChannelPlugin: ChannelPlugin<AoAccount> = {
  id: "ao",
  meta: {
    id: "ao",
    label: "AO",
    selectionLabel: "AO（小龙虾合体）",
    docsPath: "/channels/ao",
    blurb: "Bridge channel between OpenClaw and 小龙虾合体 - V2 with server-mode WebSocket architecture",
    order: 88,
  },
  capabilities: {
    chatTypes: ["direct" as const],
    media: false,
  },
  reload: { configPrefixes: ["channels.ao"] },
  configSchema: { schema: aoConfigSchema },
  config: {
    listAccountIds: (cfg) => listAoAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveAoAccount(cfg, accountId),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isEnabled: (account) => account.enabled,
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      connectionMode: account.connectionMode,
      listenHost: account.listenHost,
      listenPort: account.listenPort,
      controlPlaneUrl: account.controlPlaneUrl,
      defaultTo: account.defaultTo,
      channelId: account.channelId,
      retryMaxAttempts: account.retryMaxAttempts,
      retryBackoffMs: account.retryBackoffMs,
    }),
    resolveDefaultTo: ({ cfg, accountId }) => resolveAoAccount(cfg, accountId).defaultTo,
  },
  messaging: {
    normalizeTarget: (target) => target.trim(),
    targetResolver: {
      looksLikeId: (input) => Boolean(input.trim()),
      hint: "<sessionId>",
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account as AoAccount;

      if (!account.configured) {
        throw new Error("AO gateway start failed: account is not configured");
      }

      const state: AoRuntimeState = {
        manager: null,
        stopped: false,
        logger: ctx.log,
      };

      try {
        await createConnectionManagerRuntime(account, ctx, state);
      } catch (err) {
        ctx.log?.error?.(`[${account.accountId}] Gateway error: ${err}`);
        throw err;
      }
    },
  },
  outbound: {
    deliveryMode: "direct" as const,
    textChunkLimit: 4000,
    sendText: async (ctx) => {
      const account = resolveAoAccount(ctx.cfg, ctx.accountId);

      if (!account.configured) {
        throw new Error("AO channel is not configured");
      }

      const manager = getConnectionManager(ctx.accountId || account.accountId);
      if (!manager) {
        throw new Error("AO channel is not running: connection manager not found");
      }

      if (!manager.hasActiveConnection()) {
        throw new Error("AO channel has no active connection to Control Plane");
      }

      const target = ctx.to?.trim() || account.defaultTo;
      if (!target) {
        throw new Error("AO outbound target is required (set to or channels.ao.defaultTo)");
      }

      const eventId = generateEventId();

      // Create chat message for Control Plane protocol
      const chatMessage: ChatMessage = {
        type: "chat",
        id: eventId,
        sessionId: target,
        content: ctx.text,
        from: {
          id: "openclaw_ao_plugin",
          name: "OpenClaw",
          type: "agent",
        },
        metadata: {
          to: target,
          accountId: account.accountId,
        },
      };

      // Try to send via server connections first, then client connections
      let sent = false;

      // Send to all authenticated server connections
      for (const conn of manager.getServerConnections()) {
        if (conn.isAuthenticated) {
          sent = manager.sendToServer(conn.id, chatMessage) || sent;
        }
      }

      // If no server connections, try client mode
      if (!sent) {
        sent = manager.sendToControlPlane(chatMessage);
      }

      if (!sent) {
        throw new Error("Failed to send message: no active connection available");
      }

      return {
        channel: "ao" as const,
        messageId: eventId,
        conversationId: target,
        meta: {
          accountId: account.accountId,
          connectionMode: manager.getMode(),
          eventId,
          version: "2.0.0",
        },
      };
    },
  },
};

export default aoChannelPlugin;
