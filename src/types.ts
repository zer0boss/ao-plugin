/**
 * AO Plugin V2 - Type Definitions
 *
 * 统一的类型定义，确保 TypeScript 源码和编译产物一致
 * V2 架构：AO Plugin 作为 WebSocket 服务器等待 Control Plane 连接
 */

import type WebSocket from "ws";
import type {
  OpenClawConfig,
  ChannelAccountSnapshot,
  ChannelOutboundContext,
  ChannelGatewayContext,
} from "openclaw/plugin-sdk";
import type { OutboundDeliveryResult } from "openclaw/plugin-sdk/twitch";

export { OpenClawConfig };

// ============================================================================
// Connection Mode Types
// ============================================================================

export type ConnectionMode = "server" | "client" | "hybrid";

export interface AoHealthCheckConfig {
  enabled: boolean;
  intervalMs: number;
  timeoutMs: number;
}

// ============================================================================
// Account & Configuration Types (V2 - Server Mode)
// ============================================================================

export interface AoAccount {
  accountId: string;
  enabled: boolean;
  configured: boolean;

  // V2: Server mode configuration (AO Plugin 作为服务器)
  listenHost: string;
  listenPort: number;
  apiKey: string;
  maxConnections: number;
  healthCheck: AoHealthCheckConfig;

  // V2: Optional client mode configuration (Control Plane 发现)
  controlPlaneUrl?: string;

  // Legacy (deprecated, kept for migration compatibility)
  bridgeBaseUrl?: string;

  // Common settings
  token?: string;
  password?: string;
  timeoutMs: number;
  defaultTo?: string;
  channelId?: string;
  webhookSecret?: string;
  connectionMode: ConnectionMode;
  bootstrapEnabled: boolean;
  retryMaxAttempts: number;
  retryBackoffMs: number;
  tlsFingerprint?: string;
  mtls?: AoMtlsConfig;
}

export interface AoRetryConfig {
  maxAttempts: number;
  backoffMs: number;
  maxBackoffMs: number;
  jitter: boolean;
}

export interface AoCircuitBreakerConfig {
  enabled: boolean;
  failureThreshold: number;
  recoveryTimeout: number;
  halfOpenMaxCalls: number;
}

export interface AoMtlsConfig {
  enabled: boolean;
  certPath?: string;
  keyPath?: string;
  caPath?: string;
  autoRotate: boolean;
}

export interface AoMessageQueueConfig {
  enabled: boolean;
  maxSize: number;
  persistPath?: string;
}

export interface AoMetricsConfig {
  enabled: boolean;
  port: number;
  path: string;
}

export interface AoConfig {
  enabled?: boolean;

  // V2: Server mode (primary)
  listenHost?: string;
  listenPort?: number;
  apiKey?: string;
  maxConnections?: number;
  healthCheck?: Partial<AoHealthCheckConfig>;

  // V2: Client mode (optional, for hybrid scenarios)
  controlPlaneUrl?: string;
  connectionMode?: ConnectionMode;

  // Legacy (deprecated)
  bridgeBaseUrl?: string;

  token?: string;
  password?: string;
  timeoutMs?: number;
  defaultTo?: string;
  channelId?: string;
  webhookSecret?: string;
  bootstrapEnabled?: boolean;
  retry?: Partial<AoRetryConfig>;
  circuitBreaker?: Partial<AoCircuitBreakerConfig>;
  mtls?: Partial<AoMtlsConfig>;
  messageQueue?: Partial<AoMessageQueueConfig>;
  metrics?: Partial<AoMetricsConfig>;
  accounts?: Record<string, AoConfig>;
}

// ============================================================================
// WebSocket Server Types (V2 - New)
// ============================================================================

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
  pendingPongAt?: number; // Timestamp when we sent a WebSocket ping, waiting for pong
  isAuthenticated: boolean;
  metadata: {
    controlPlaneId?: string;
    version?: string;
    remoteAddress?: string;
  };
}

export interface WebSocketServerManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  getConnections(): ControlPlaneConnection[];
  getConnection(id: string): ControlPlaneConnection | undefined;
  broadcast(message: unknown): void;
  sendTo(connectionId: string, message: unknown): boolean;
  isRunning(): boolean;
}

export interface ServerHandlers {
  onConnection: (conn: ControlPlaneConnection) => void;
  onDisconnect: (connId: string) => void;
  onMessage: (connId: string, message: unknown) => void;
  onAuth: (apiKey: string, metadata?: Record<string, unknown>) => boolean | Promise<boolean>;
}

// ============================================================================
// Message Protocol Types (V2 - Control Plane Protocol)
// ============================================================================

export type InboundMessageType = "auth" | "chat" | "command" | "ping" | "system";
export type OutboundMessageType = "auth_response" | "reply" | "pong" | "status" | "error";

// Control Plane → AO Plugin
export interface ControlPlaneMessage {
  type: InboundMessageType;
  id: string;
  timestamp: number;
  payload: unknown;
}

export interface AuthMessage {
  type: "auth";
  id: string;
  timestamp: number;
  payload: {
    apiKey: string;
    controlPlaneId: string;
    version?: string;
  };
}

export interface ChatMessage {
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

export interface PingMessage {
  type: "ping";
  id: string;
  timestamp: number;
}

// AO Plugin → Control Plane
export interface OpenClawMessage {
  type: OutboundMessageType;
  inReplyTo: string;
  timestamp: number;
  payload: unknown;
}

export interface AuthResponseMessage {
  type: "auth_response";
  inReplyTo: string;
  timestamp: number;
  payload: {
    success: boolean;
    connectionId: string;
    error?: string;
  };
}

export interface ReplyMessage {
  type: "reply";
  inReplyTo: string;
  sessionId: string;
  content: string;
  from: {
    id: string;
    name: string;
    type: "agent";
  };
  metadata?: Record<string, unknown>;
}

export interface PongMessage {
  type: "pong";
  inReplyTo: string;
  timestamp: number;
}

export interface StatusMessage {
  type: "status";
  inReplyTo: string;
  timestamp: number;
  payload: {
    status: "connected" | "disconnected" | "error";
    connections: number;
    uptime: number;
  };
}

export interface ClientConnectionOptions {
  url: string;
  apiKey: string;
  reconnectIntervalMs: number;
  maxReconnectAttempts: number;
  heartbeatIntervalMs: number;
}

// ============================================================================
// Circuit Breaker Types
// ============================================================================

export type CircuitBreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  failureThreshold: number;
  recoveryTimeout: number;
  halfOpenMaxCalls: number;
}

export interface CircuitBreakerMetrics {
  state: CircuitBreakerState;
  failureCount: number;
  successCount: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  totalCalls: number;
  rejectedCalls: number;
}

// ============================================================================
// Connection Pool Types (Legacy - for client mode)
// ============================================================================

export interface WebSocketConnection {
  id: string;
  ws: WebSocket;
  state: "connecting" | "connected" | "idle" | "unhealthy" | "closed";
  createdAt: number;
  lastUsedAt: number;
  lastHealthCheckAt: number;
  errorCount: number;
  metadata: Record<string, unknown>;
}

export interface ConnectionPoolOptions {
  minConnections: number;
  maxConnections: number;
  idleTimeoutMs: number;
  healthCheckIntervalMs: number;
  connectionTimeoutMs: number;
}

export interface PoolHealthStats {
  total: number;
  active: number;
  idle: number;
  unhealthy: number;
  connecting: number;
}

// ============================================================================
// Message Queue Types
// ============================================================================

export type QueuedMessageStatus = "pending" | "processing" | "completed" | "failed" | "retrying";

export interface QueuedMessage {
  id: string;
  eventId: string;
  accountId: string;
  target: string;
  content: string;
  status: QueuedMessageStatus;
  attemptCount: number;
  createdAt: number;
  scheduledAt: number;
  completedAt?: number;
  error?: string;
  metadata: Record<string, unknown>;
}

export interface MessageQueueOptions {
  maxSize: number;
  persistPath?: string;
  retryIntervalMs: number;
  maxRetryAttempts: number;
}

export interface MessageQueueStats {
  pendingCount: number;
  processingCount: number;
  failedCount: number;
  totalCount: number;
}

// ============================================================================
// Security Types
// ============================================================================

export interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAt: number;
}

export interface MtlsCredentials {
  cert: string;
  key: string;
  ca?: string;
}

export interface SignedRequest {
  timestamp: string;
  signature: string;
  payload: string;
}

// ============================================================================
// Metrics Types
// ============================================================================

export interface ConnectionMetrics {
  connectionsTotal: number;
  connectionsActive: number;
  connectionsFailed: number;
  reconnectionsTotal: number;
  reconnectionsFailed: number;
}

export interface MessageMetrics {
  messagesReceivedTotal: number;
  messagesSentTotal: number;
  messagesFailedTotal: number;
  messageLatencySeconds: number[];
}

export interface AoMetrics {
  connections: ConnectionMetrics;
  messages: MessageMetrics;
  errors: Record<string, number>;
  lastTickAt: number;
}

// ============================================================================
// Error Types
// ============================================================================

export type AoBridgeErrorCode =
  | "AO_TIMEOUT"
  | "AO_NETWORK"
  | "AO_AUTH_FAILED"
  | "AO_PROTOCOL_ERROR"
  | "AO_TARGET_OFFLINE"
  | "AO_RATE_LIMITED"
  | "AO_BRIDGE_UNAVAILABLE"
  | "AO_UNKNOWN";

export interface AoBridgeError extends Error {
  code: AoBridgeErrorCode;
  retryable: boolean;
  status?: number;
  attempt?: number;
}

// ============================================================================
// Legacy WebSocket Message Types (for backward compatibility)
// ============================================================================

export interface WebSocketFrame {
  type: "req" | "res" | "event";
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
  event?: string;
  payload?: Record<string, unknown>;
}

export interface AoBootstrapPayload {
  channelId?: string;
  channel_id?: string;
  channel_config?: {
    channelId?: string;
  };
}

// ============================================================================
// Plugin Types (from OpenClaw SDK)
// ============================================================================

export interface ChannelPlugin<T = AoAccount> {
  id: string;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  reload: { configPrefixes: string[] };
  configSchema: { schema: Record<string, unknown> };
  config: ChannelConfig<T>;
  messaging: ChannelMessaging;
  gateway: ChannelGateway;
  outbound: ChannelOutbound;
}

export interface ChannelMeta {
  id: string;
  label: string;
  selectionLabel: string;
  docsPath: string;
  blurb: string;
  order: number;
}

export type ChatType = "direct" | "group" | "channel";

export interface ChannelCapabilities {
  chatTypes: Array<ChatType | "thread">;
  media: boolean;
}

export interface ChannelConfig<T> {
  listAccountIds: (cfg: OpenClawConfig) => string[];
  resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => T;
  defaultAccountId: () => string;
  isEnabled: (account: T) => boolean;
  isConfigured: (account: T) => boolean;
  describeAccount: (account: T) => ChannelAccountSnapshot;
  resolveDefaultTo: (params: { cfg: OpenClawConfig; accountId?: string | null }) => string | undefined;
}

export interface ChannelMessaging {
  normalizeTarget: (target: string) => string;
  targetResolver: {
    looksLikeId: (input: string) => boolean;
    hint: string;
  };
}

export interface ChannelGateway {
  startAccount: (ctx: ChannelGatewayContext) => Promise<void>;
}

export interface ChannelOutbound {
  deliveryMode: "direct" | "gateway" | "hybrid";
  textChunkLimit: number;
  sendText: (ctx: ChannelOutboundContext) => Promise<OutboundDeliveryResult>;
}

export interface AccountStatus {
  accountId: string;
  running: boolean;
  wsUrl?: string;
  channelId?: string;
  lastError?: string | null;
  lastStartAt?: number;
  lastStopAt?: number;
  lastTickAt?: number;
}

export interface Logger {
  info?: (msg: string) => void;
  debug?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

// ============================================================================
// Utility Types
// ============================================================================

export type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;
export type RequireFields<T, K extends keyof T> = T & Required<Pick<T, K>>;
