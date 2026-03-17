/**
 * Message Handler
 *
 * 处理 Control Plane 和 AO Plugin 之间的消息协议
 * - 入站消息：解析、验证、转发给 OpenClaw
 * - 出站消息：格式化、发送给 Control Plane
 */

import type {
  AoAccount,
  ControlPlaneMessage,
  ChatMessage,
  AuthMessage,
  PingMessage,
  ReplyMessage,
  PongMessage,
  StatusMessage,
  InboundMessageType,
  OutboundMessageType,
  Logger,
  ChannelOutbound,
} from "../types.js";
import type { ChannelOutboundContext } from "openclaw/plugin-sdk";

// ============================================================================
// Message Handlers Registry
// ============================================================================

type MessageHandler<T> = (
  message: T,
  ctx: HandlerContext
) => Promise<HandlerResult> | HandlerResult;

interface HandlerContext {
  account: AoAccount;
  connectionId: string;
  logger?: Logger;
  sendReply: (reply: ReplyMessage) => void;
  sendStatus: (status: StatusMessage) => void;
  forwardToOpenClaw: (message: ControlPlaneMessage) => Promise<void>;
}

interface HandlerResult {
  success: boolean;
  error?: string;
  reply?: ReplyMessage;
}

const messageHandlers = new Map<InboundMessageType, MessageHandler<unknown>>();

// ============================================================================
// Inbound Message Handlers
// ============================================================================

/**
 * 处理鉴权消息
 * 注意：实际鉴权逻辑在 server.ts 中处理，这里只处理鉴权后的确认
 */
function handleAuthMessage(message: AuthMessage): HandlerResult {
  // 鉴权已在 server.ts 中完成，这里返回成功
  return {
    success: true,
    reply: {
      type: "reply",
      inReplyTo: message.id,
      sessionId: "",
      content: JSON.stringify({
        success: true,
        connectionId: "", // 由 server.ts 填充
      }),
      from: {
        id: "ao-plugin",
        name: "AO Plugin",
        type: "agent",
      },
      metadata: { authResponse: true },
    },
  };
}

/**
 * 处理聊天消息
 */
async function handleChatMessage(
  message: ChatMessage,
  ctx: HandlerContext
): Promise<HandlerResult> {
  ctx.logger?.info?.(`[AO Handler] ========== Chat Message Flow ==========`);
  ctx.logger?.info?.(`[AO Handler] 1. Received from Control Plane:`);
  ctx.logger?.info?.(`[AO Handler]    messageId: ${message.id}`);
  ctx.logger?.info?.(`[AO Handler]    sessionId: ${message.sessionId}`);
  ctx.logger?.info?.(`[AO Handler]    from: ${message.from?.name} (${message.from?.id})`);
  ctx.logger?.info?.(`[AO Handler]    content: ${message.content?.substring(0, 100)}${message.content?.length > 100 ? '...' : ''}`);
  ctx.logger?.info?.(`[AO Handler]    metadata: ${JSON.stringify(message.metadata || {})}`);

  try {
    // 转发给 OpenClaw
    ctx.logger?.info?.(`[AO Handler] 2. Forwarding to OpenClaw...`);
    await ctx.forwardToOpenClaw(message as unknown as ControlPlaneMessage);
    ctx.logger?.info?.(`[AO Handler] 3. Successfully forwarded to OpenClaw`);
    ctx.logger?.info?.(`[AO Handler]    (OpenClaw will reply via callback)`);

    return {
      success: true,
    };
  } catch (err) {
    ctx.logger?.error?.(`[AO Handler] ERROR: Failed to forward to OpenClaw: ${err}`);
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
      reply: {
        type: "reply",
        inReplyTo: message.id,
        sessionId: message.sessionId,
        content: "消息处理失败",
        from: {
          id: "ao-plugin",
          name: "AO Plugin",
          type: "agent",
        },
      },
    };
  }
}

/**
 * 处理命令消息
 */
async function handleCommandMessage(
  message: ControlPlaneMessage,
  ctx: HandlerContext
): Promise<HandlerResult> {
  ctx.logger?.info?.(`[AO Handler] Command message: ${message.id}`);

  const payload = message.payload as Record<string, unknown>;
  const command = payload?.command as string;

  switch (command) {
    case "ping":
      return {
        success: true,
        reply: {
          type: "reply",
          inReplyTo: message.id,
          sessionId: "",
          content: "pong",
          from: {
            id: "ao-plugin",
            name: "AO Plugin",
            type: "agent",
          },
        },
      };

    case "status":
      return {
        success: true,
        reply: {
          type: "reply",
          inReplyTo: message.id,
          sessionId: "",
          content: JSON.stringify({
            status: "connected",
            accountId: ctx.account.accountId,
            timestamp: Date.now(),
          }),
          from: {
            id: "ao-plugin",
            name: "AO Plugin",
            type: "agent",
          },
        },
      };

    default:
      // 未知命令，转发给 OpenClaw 处理
      await ctx.forwardToOpenClaw(message);
      return { success: true };
  }
}

/**
 * 处理 Ping 消息
 */
function handlePingMessage(message: PingMessage): HandlerResult {
  return {
    success: true,
    reply: {
      type: "reply",
      inReplyTo: message.id,
      sessionId: "",
      content: "",
      from: {
        id: "ao-plugin",
        name: "AO Plugin",
        type: "agent",
      },
    } as ReplyMessage,
  };
}

/**
 * 处理系统消息
 */
async function handleSystemMessage(
  message: ControlPlaneMessage,
  ctx: HandlerContext
): Promise<HandlerResult> {
  ctx.logger?.debug?.(`[AO Handler] System message: ${message.id}`);

  const payload = message.payload as Record<string, unknown>;
  const action = payload?.action as string;

  switch (action) {
    case "heartbeat":
      return {
        success: true,
        reply: {
          type: "reply",
          inReplyTo: message.id,
          sessionId: "",
          content: JSON.stringify({ status: "alive" }),
          from: {
            id: "ao-plugin",
            name: "AO Plugin",
            type: "agent",
          },
        },
      };

    default:
      // 转发给 OpenClaw
      await ctx.forwardToOpenClaw(message);
      return { success: true };
  }
}

// ============================================================================
// Message Router
// ============================================================================

/**
 * 路由入站消息到对应的处理器
 */
export async function routeInboundMessage(
  message: ControlPlaneMessage,
  ctx: HandlerContext
): Promise<HandlerResult> {
  const { type } = message;

  // Log all incoming messages being routed
  ctx.logger?.info?.(`[AO Handler] >>> routeInboundMessage called:`);
  ctx.logger?.info?.(`[AO Handler]     connectionId: ${ctx.connectionId}`);
  ctx.logger?.info?.(`[AO Handler]     message type: ${type}`);
  ctx.logger?.info?.(`[AO Handler]     message id: ${message.id}`);
  if (type === "chat") {
    ctx.logger?.info?.(`[AO Handler]     message sessionId: ${(message as unknown as ChatMessage).sessionId || 'N/A'}`);
  } else {
    ctx.logger?.info?.(`[AO Handler]     message sessionId: N/A`);
  }
  ctx.logger?.info?.(`[AO Handler]     routing to handler...`);

  switch (type) {
    case "auth":
      return handleAuthMessage(message as unknown as AuthMessage);

    case "chat":
      return await handleChatMessage(message as unknown as ChatMessage, ctx);

    case "command":
      return await handleCommandMessage(message, ctx);

    case "ping":
      return handlePingMessage(message as unknown as PingMessage);

    case "system":
      return await handleSystemMessage(message, ctx);

    default:
      ctx.logger?.warn?.(`[AO Handler] Unknown message type: ${type}`);
      return {
        success: false,
        error: `Unknown message type: ${type}`,
      };
  }
}

// ============================================================================
// Outbound Message Builders
// ============================================================================

/**
 * 创建回复消息
 */
export function createReplyMessage(
  inReplyTo: string,
  sessionId: string,
  content: string,
  metadata?: Record<string, unknown>
): ReplyMessage {
  return {
    type: "reply",
    inReplyTo,
    sessionId,
    content,
    from: {
      id: "ao-plugin",
      name: "OpenClaw",
      type: "agent",
    },
    metadata,
  };
}

/**
 * 创建 Pong 消息
 */
export function createPongMessage(inReplyTo: string): PongMessage {
  return {
    type: "pong",
    inReplyTo,
    timestamp: Date.now(),
  };
}

/**
 * 创建状态消息
 */
export function createStatusMessage(
  inReplyTo: string,
  status: "connected" | "disconnected" | "error",
  connections: number,
  uptime: number
): StatusMessage {
  return {
    type: "status",
    inReplyTo,
    timestamp: Date.now(),
    payload: {
      status,
      connections,
      uptime,
    },
  };
}

/**
 * 创建错误消息
 */
export function createErrorMessage(
  inReplyTo: string,
  code: string,
  message: string
): ReplyMessage {
  return {
    type: "reply",
    inReplyTo,
    sessionId: "",
    content: JSON.stringify({ error: code, message }),
    from: {
      id: "ao-plugin",
      name: "AO Plugin",
      type: "agent",
    },
    metadata: { error: true },
  };
}

// ============================================================================
// Message Serialization
// ============================================================================

/**
 * 序列化消息为 JSON 字符串
 */
export function serializeMessage(message: unknown): string {
  return JSON.stringify(message);
}

/**
 * 解析 JSON 消息
 */
export function parseMessage(data: string | Buffer): ControlPlaneMessage | null {
  try {
    return JSON.parse(data.toString()) as ControlPlaneMessage;
  } catch {
    return null;
  }
}

// ============================================================================
// Message Validation
// ============================================================================

/**
 * 验证入站消息格式
 */
export function validateInboundMessage(message: unknown): message is ControlPlaneMessage {
  if (!message || typeof message !== "object") {
    return false;
  }

  const msg = message as Record<string, unknown>;

  // 检查必需字段
  if (!msg.type || typeof msg.type !== "string") {
    return false;
  }

  if (!msg.id || typeof msg.id !== "string") {
    return false;
  }

  if (!msg.timestamp || typeof msg.timestamp !== "number") {
    return false;
  }

  // 验证消息类型
  const validTypes: InboundMessageType[] = ["auth", "chat", "command", "ping", "system"];
  if (!validTypes.includes(msg.type as InboundMessageType)) {
    return false;
  }

  return true;
}

/**
 * 验证聊天消息
 */
export function validateChatMessage(message: unknown): message is ChatMessage {
  const msg = message as unknown as ChatMessage;

  if (!msg.content || typeof msg.content !== "string") {
    return false;
  }

  if (!msg.from || typeof msg.from !== "object") {
    return false;
  }

  if (!msg.from.id || typeof msg.from.id !== "string") {
    return false;
  }

  if (!msg.from.name || typeof msg.from.name !== "string") {
    return false;
  }

  return true;
}

// ============================================================================
// Context Builder for OpenClaw
// ============================================================================

/**
 * 从 Control Plane 消息构建 OpenClaw 出站上下文
 */
export function buildOutboundContext(
  message: ChatMessage,
  account: AoAccount
): Partial<ChannelOutboundContext> {
  return {
    text: message.content,
    to: message.from.id,
    accountId: account.accountId,
  };
}

// ============================================================================
// Error Messages
// ============================================================================

export const MessageErrors = {
  INVALID_FORMAT: "消息格式无效",
  MISSING_TYPE: "缺少消息类型",
  MISSING_ID: "缺少消息 ID",
  MISSING_TIMESTAMP: "缺少时间戳",
  UNKNOWN_TYPE: "未知的消息类型",
  AUTH_REQUIRED: "需要鉴权",
  AUTH_FAILED: "鉴权失败",
  SESSION_NOT_FOUND: "会话不存在",
  RATE_LIMITED: "请求过于频繁",
  INTERNAL_ERROR: "内部错误",
} as const;
