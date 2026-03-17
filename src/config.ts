/**
 * Configuration Management
 *
 * 外部化配置管理，支持热更新和多账户配置验证
 * V2: 支持服务器模式（AO Plugin 作为 WebSocket 服务器）
 */

import type {
  AoConfig,
  AoAccount,
  AoRetryConfig,
  AoCircuitBreakerConfig,
  AoMtlsConfig,
  AoMessageQueueConfig,
  AoMetricsConfig,
  AoHealthCheckConfig,
  ConnectionMode,
  OpenClawConfig,
} from "./types.js";

// ============================================================================
// Default Configurations
// ============================================================================

export const DEFAULT_RETRY_CONFIG: AoRetryConfig = {
  maxAttempts: 3,
  backoffMs: 800,
  maxBackoffMs: 30000,
  jitter: true,
};

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: AoCircuitBreakerConfig = {
  enabled: true,
  failureThreshold: 5,
  recoveryTimeout: 30000,
  halfOpenMaxCalls: 3,
};

export const DEFAULT_MTLS_CONFIG: AoMtlsConfig = {
  enabled: false,
  autoRotate: true,
};

export const DEFAULT_MESSAGE_QUEUE_CONFIG: AoMessageQueueConfig = {
  enabled: true,
  maxSize: 1000,
  persistPath: "./data/ao-queue",
};

export const DEFAULT_METRICS_CONFIG: AoMetricsConfig = {
  enabled: true,
  port: 9090,
  path: "/metrics",
};

// V2: Server mode defaults
export const DEFAULT_HEALTH_CHECK_CONFIG: AoHealthCheckConfig = {
  enabled: true,
  intervalMs: 30000,
  timeoutMs: 10000,
};

export const DEFAULT_LISTEN_HOST = "0.0.0.0";
export const DEFAULT_LISTEN_PORT = 18080;
export const DEFAULT_MAX_CONNECTIONS = 10;
export const DEFAULT_CONNECTION_MODE: ConnectionMode = "server";

export const DEFAULT_TIMEOUT_MS = 10000;
export const DEFAULT_ACCOUNT_ID = "default";

// ============================================================================
// Configuration Resolvers
// ============================================================================

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function asPositiveInt(value: unknown, fallback: number, min: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.floor(value));
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return fallback;
}

export function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return undefined;
}

export function resolveRetryConfig(config?: Partial<AoRetryConfig>): AoRetryConfig {
  return {
    maxAttempts: asPositiveInt(config?.maxAttempts, DEFAULT_RETRY_CONFIG.maxAttempts, 1),
    backoffMs: asPositiveInt(config?.backoffMs, DEFAULT_RETRY_CONFIG.backoffMs, 100),
    maxBackoffMs: asPositiveInt(config?.maxBackoffMs, DEFAULT_RETRY_CONFIG.maxBackoffMs, 1000),
    jitter: asBoolean(config?.jitter, DEFAULT_RETRY_CONFIG.jitter),
  };
}

export function resolveCircuitBreakerConfig(
  config?: Partial<AoCircuitBreakerConfig>
): AoCircuitBreakerConfig {
  return {
    enabled: asBoolean(config?.enabled, DEFAULT_CIRCUIT_BREAKER_CONFIG.enabled),
    failureThreshold: asPositiveInt(
      config?.failureThreshold,
      DEFAULT_CIRCUIT_BREAKER_CONFIG.failureThreshold,
      1
    ),
    recoveryTimeout: asPositiveInt(
      config?.recoveryTimeout,
      DEFAULT_CIRCUIT_BREAKER_CONFIG.recoveryTimeout,
      1000
    ),
    halfOpenMaxCalls: asPositiveInt(
      config?.halfOpenMaxCalls,
      DEFAULT_CIRCUIT_BREAKER_CONFIG.halfOpenMaxCalls,
      1
    ),
  };
}

export function resolveMtlsConfig(config?: Partial<AoMtlsConfig>): AoMtlsConfig {
  return {
    enabled: asBoolean(config?.enabled, DEFAULT_MTLS_CONFIG.enabled),
    certPath: asString(config?.certPath),
    keyPath: asString(config?.keyPath),
    caPath: asString(config?.caPath),
    autoRotate: asBoolean(config?.autoRotate, DEFAULT_MTLS_CONFIG.autoRotate),
  };
}

export function resolveMessageQueueConfig(
  config?: Partial<AoMessageQueueConfig>
): AoMessageQueueConfig {
  return {
    enabled: asBoolean(config?.enabled, DEFAULT_MESSAGE_QUEUE_CONFIG.enabled),
    maxSize: asPositiveInt(config?.maxSize, DEFAULT_MESSAGE_QUEUE_CONFIG.maxSize, 1),
    persistPath: asString(config?.persistPath) ?? DEFAULT_MESSAGE_QUEUE_CONFIG.persistPath,
  };
}

export function resolveMetricsConfig(config?: Partial<AoMetricsConfig>): AoMetricsConfig {
  return {
    enabled: asBoolean(config?.enabled, DEFAULT_METRICS_CONFIG.enabled),
    port: asPositiveInt(config?.port, DEFAULT_METRICS_CONFIG.port, 1),
    path: asString(config?.path) ?? DEFAULT_METRICS_CONFIG.path,
  };
}

// V2: Health check config resolver
export function resolveHealthCheckConfig(config?: Partial<AoHealthCheckConfig>): AoHealthCheckConfig {
  return {
    enabled: asBoolean(config?.enabled, DEFAULT_HEALTH_CHECK_CONFIG.enabled),
    intervalMs: asPositiveInt(config?.intervalMs, DEFAULT_HEALTH_CHECK_CONFIG.intervalMs, 1000),
    timeoutMs: asPositiveInt(config?.timeoutMs, DEFAULT_HEALTH_CHECK_CONFIG.timeoutMs, 1000),
  };
}

// V2: Connection mode resolver
export function resolveConnectionMode(value?: string): ConnectionMode {
  if (value === "server" || value === "client" || value === "hybrid") {
    return value;
  }
  return DEFAULT_CONNECTION_MODE;
}

// ============================================================================
// Account Resolution
// ============================================================================

export function resolveAoSection(cfg: OpenClawConfig): Record<string, unknown> {
  const channels = asRecord(cfg.channels);
  return asRecord(channels.ao);
}

export function resolveAoAccount(
  cfg: OpenClawConfig,
  accountId?: string | null
): AoAccount {
  const section = resolveAoSection(cfg);
  const accounts = asRecord(section.accounts);
  const resolvedAccountId =
    typeof accountId === "string" && accountId.trim()
      ? accountId.trim()
      : DEFAULT_ACCOUNT_ID;
  const account = asRecord(accounts[resolvedAccountId]);

  const merged: Record<string, unknown> = {
    ...section,
    ...account,
  };

  // V2: Server mode configuration (primary)
  const listenHost = asString(merged.listenHost) ?? DEFAULT_LISTEN_HOST;
  const listenPort = asPositiveInt(merged.listenPort, DEFAULT_LISTEN_PORT, 1);
  const apiKey = asString(merged.apiKey) ?? "";
  const maxConnections = asPositiveInt(merged.maxConnections, DEFAULT_MAX_CONNECTIONS, 1);
  const healthCheck = resolveHealthCheckConfig(asRecord(merged.healthCheck));

  // V2: Optional client mode (for hybrid scenarios)
  const controlPlaneUrl = asString(merged.controlPlaneUrl);
  const connectionMode = resolveConnectionMode(asString(merged.connectionMode));

  // Legacy (for migration compatibility)
  const bridgeBaseUrl = asString(merged.bridgeBaseUrl);

  // Common settings
  const timeoutMs = asPositiveInt(merged.timeoutMs, DEFAULT_TIMEOUT_MS, 1000);
  const defaultTo = asString(merged.defaultTo);
  const channelId = asString(merged.channelId);
  const webhookSecret = asString(merged.webhookSecret);
  const tlsFingerprint = asString(merged.tlsFingerprint);

  const retry = resolveRetryConfig(asRecord(merged.retry));
  const circuitBreaker = resolveCircuitBreakerConfig(asRecord(merged.circuitBreaker));
  const mtls = resolveMtlsConfig(asRecord(merged.mtls));
  const messageQueue = resolveMessageQueueConfig(asRecord(merged.messageQueue));
  const metrics = resolveMetricsConfig(asRecord(merged.metrics));

  const bootstrapEnabled = asBoolean(merged.bootstrapEnabled, true);
  const enabled = asBoolean(merged.enabled, true);

  // V2: Account is "configured" if it has server mode config (listenPort + apiKey)
  // or legacy bridgeBaseUrl (for backward compatibility)
  const isServerConfigured = listenPort > 0 && apiKey.length > 0;
  const isClientConfigured = Boolean(controlPlaneUrl);
  const isLegacyConfigured = Boolean(bridgeBaseUrl);

  return {
    accountId: resolvedAccountId,
    enabled,
    configured: isServerConfigured || isClientConfigured || isLegacyConfigured,

    // V2: Server mode
    listenHost,
    listenPort,
    apiKey,
    maxConnections,
    healthCheck,

    // V2: Client mode
    controlPlaneUrl,

    // Legacy
    bridgeBaseUrl,

    // Common
    token: asString(merged.token),
    password: asString(merged.password),
    timeoutMs,
    defaultTo,
    channelId,
    connectionMode,
    bootstrapEnabled,
    webhookSecret,
    retryMaxAttempts: retry.maxAttempts,
    retryBackoffMs: retry.backoffMs,
    tlsFingerprint,
    mtls,
  };
}

export function listAoAccountIds(cfg: OpenClawConfig): string[] {
  const section = resolveAoSection(cfg);
  const accounts = asRecord(section.accounts);
  const ids = Object.keys(accounts).filter((id) => id.trim());
  return ids.length > 0 ? ids : [DEFAULT_ACCOUNT_ID];
}

// ============================================================================
// Config Schema (for OpenClaw validation)
// ============================================================================

export const aoConfigSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },

    // V2: Server mode configuration
    listenHost: { type: "string" },
    listenPort: { type: "number", minimum: 1, maximum: 65535 },
    apiKey: { type: "string" },
    maxConnections: { type: "number", minimum: 1 },
    healthCheck: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        intervalMs: { type: "number", minimum: 1000 },
        timeoutMs: { type: "number", minimum: 1000 },
      },
    },

    // V2: Client mode configuration (for hybrid scenarios)
    controlPlaneUrl: { type: "string" },
    connectionMode: { type: "string", enum: ["server", "client", "hybrid"] },

    // Legacy (deprecated, kept for migration)
    bridgeBaseUrl: { type: "string" },

    token: { type: "string" },
    password: { type: "string" },
    timeoutMs: { type: "number", minimum: 1000 },
    defaultTo: { type: "string" },
    channelId: { type: "string" },
    webhookSecret: { type: "string" },
    bootstrapEnabled: { type: "boolean" },
    tlsFingerprint: { type: "string" },
    retry: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxAttempts: { type: "number", minimum: 1 },
        backoffMs: { type: "number", minimum: 100 },
        maxBackoffMs: { type: "number", minimum: 1000 },
        jitter: { type: "boolean" },
      },
    },
    circuitBreaker: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        failureThreshold: { type: "number", minimum: 1 },
        recoveryTimeout: { type: "number", minimum: 1000 },
        halfOpenMaxCalls: { type: "number", minimum: 1 },
      },
    },
    mtls: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        certPath: { type: "string" },
        keyPath: { type: "string" },
        caPath: { type: "string" },
        autoRotate: { type: "boolean" },
      },
    },
    messageQueue: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        maxSize: { type: "number", minimum: 1 },
        persistPath: { type: "string" },
      },
    },
    metrics: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        port: { type: "number", minimum: 1 },
        path: { type: "string" },
      },
    },
    accounts: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean" },

          // V2: Server mode
          listenHost: { type: "string" },
          listenPort: { type: "number", minimum: 1, maximum: 65535 },
          apiKey: { type: "string" },
          maxConnections: { type: "number", minimum: 1 },
          healthCheck: {
            type: "object",
            additionalProperties: false,
            properties: {
              enabled: { type: "boolean" },
              intervalMs: { type: "number", minimum: 1000 },
              timeoutMs: { type: "number", minimum: 1000 },
            },
          },

          // V2: Client mode
          controlPlaneUrl: { type: "string" },
          connectionMode: { type: "string", enum: ["server", "client", "hybrid"] },

          // Legacy
          bridgeBaseUrl: { type: "string" },

          token: { type: "string" },
          password: { type: "string" },
          timeoutMs: { type: "number", minimum: 1000 },
          defaultTo: { type: "string" },
          channelId: { type: "string" },
          webhookSecret: { type: "string" },
          bootstrapEnabled: { type: "boolean" },
          tlsFingerprint: { type: "string" },
          retry: {
            type: "object",
            additionalProperties: false,
            properties: {
              maxAttempts: { type: "number", minimum: 1 },
              backoffMs: { type: "number", minimum: 100 },
              maxBackoffMs: { type: "number", minimum: 1000 },
              jitter: { type: "boolean" },
            },
          },
          circuitBreaker: {
            type: "object",
            additionalProperties: false,
            properties: {
              enabled: { type: "boolean" },
              failureThreshold: { type: "number", minimum: 1 },
              recoveryTimeout: { type: "number", minimum: 1000 },
              halfOpenMaxCalls: { type: "number", minimum: 1 },
            },
          },
          mtls: {
            type: "object",
            additionalProperties: false,
            properties: {
              enabled: { type: "boolean" },
              certPath: { type: "string" },
              keyPath: { type: "string" },
              caPath: { type: "string" },
              autoRotate: { type: "boolean" },
            },
          },
          messageQueue: {
            type: "object",
            additionalProperties: false,
            properties: {
              enabled: { type: "boolean" },
              maxSize: { type: "number", minimum: 1 },
              persistPath: { type: "string" },
            },
          },
          metrics: {
            type: "object",
            additionalProperties: false,
            properties: {
              enabled: { type: "boolean" },
              port: { type: "number", minimum: 1 },
              path: { type: "string" },
            },
          },
        },
      },
    },
  },
};

// ============================================================================
// Environment Variable Support
// ============================================================================

export function loadFromEnv(): Partial<AoConfig> {
  const config: Partial<AoConfig> = {};

  // V2: Server mode environment variables
  if (process.env.AO_LISTEN_HOST) {
    config.listenHost = process.env.AO_LISTEN_HOST;
  }
  if (process.env.AO_LISTEN_PORT) {
    config.listenPort = parseInt(process.env.AO_LISTEN_PORT, 10);
  }
  if (process.env.AO_API_KEY) {
    config.apiKey = process.env.AO_API_KEY;
  }
  if (process.env.AO_MAX_CONNECTIONS) {
    config.maxConnections = parseInt(process.env.AO_MAX_CONNECTIONS, 10);
  }
  if (process.env.AO_CONNECTION_MODE) {
    config.connectionMode = process.env.AO_CONNECTION_MODE as ConnectionMode;
  }
  if (process.env.AO_CONTROL_PLANE_URL) {
    config.controlPlaneUrl = process.env.AO_CONTROL_PLANE_URL;
  }

  // Legacy (deprecated)
  if (process.env.AO_BRIDGE_BASE_URL) {
    config.bridgeBaseUrl = process.env.AO_BRIDGE_BASE_URL;
  }

  // Common settings
  if (process.env.AO_TOKEN) {
    config.token = process.env.AO_TOKEN;
  }
  if (process.env.AO_PASSWORD) {
    config.password = process.env.AO_PASSWORD;
  }
  if (process.env.AO_DEFAULT_TO) {
    config.defaultTo = process.env.AO_DEFAULT_TO;
  }
  if (process.env.AO_CHANNEL_ID) {
    config.channelId = process.env.AO_CHANNEL_ID;
  }
  if (process.env.AO_WEBHOOK_SECRET) {
    config.webhookSecret = process.env.AO_WEBHOOK_SECRET;
  }
  if (process.env.AO_TIMEOUT_MS) {
    config.timeoutMs = parseInt(process.env.AO_TIMEOUT_MS, 10);
  }

  // Boolean environment variables
  if (process.env.AO_ENABLED !== undefined) {
    config.enabled = process.env.AO_ENABLED === "true";
  }
  if (process.env.AO_BOOTSTRAP_ENABLED !== undefined) {
    config.bootstrapEnabled = process.env.AO_BOOTSTRAP_ENABLED === "true";
  }

  // Retry config
  const retry: Partial<AoRetryConfig> = {};
  if (process.env.AO_RETRY_MAX_ATTEMPTS) {
    retry.maxAttempts = parseInt(process.env.AO_RETRY_MAX_ATTEMPTS, 10);
  }
  if (process.env.AO_RETRY_BACKOFF_MS) {
    retry.backoffMs = parseInt(process.env.AO_RETRY_BACKOFF_MS, 10);
  }
  if (Object.keys(retry).length > 0) {
    config.retry = retry;
  }

  // Circuit breaker config
  const circuitBreaker: Partial<AoCircuitBreakerConfig> = {};
  if (process.env.AO_CIRCUIT_BREAKER_ENABLED !== undefined) {
    circuitBreaker.enabled = process.env.AO_CIRCUIT_BREAKER_ENABLED === "true";
  }
  if (process.env.AO_CIRCUIT_BREAKER_THRESHOLD) {
    circuitBreaker.failureThreshold = parseInt(process.env.AO_CIRCUIT_BREAKER_THRESHOLD, 10);
  }
  if (Object.keys(circuitBreaker).length > 0) {
    config.circuitBreaker = circuitBreaker;
  }

  // mTLS config
  const mtls: Partial<AoMtlsConfig> = {};
  if (process.env.AO_MTLS_ENABLED !== undefined) {
    mtls.enabled = process.env.AO_MTLS_ENABLED === "true";
  }
  if (process.env.AO_MTLS_CERT_PATH) {
    mtls.certPath = process.env.AO_MTLS_CERT_PATH;
  }
  if (process.env.AO_MTLS_KEY_PATH) {
    mtls.keyPath = process.env.AO_MTLS_KEY_PATH;
  }
  if (process.env.AO_MTLS_CA_PATH) {
    mtls.caPath = process.env.AO_MTLS_CA_PATH;
  }
  if (Object.keys(mtls).length > 0) {
    config.mtls = mtls;
  }

  // Health check config
  const healthCheck: Partial<AoHealthCheckConfig> = {};
  if (process.env.AO_HEALTH_CHECK_ENABLED !== undefined) {
    healthCheck.enabled = process.env.AO_HEALTH_CHECK_ENABLED === "true";
  }
  if (process.env.AO_HEALTH_CHECK_INTERVAL_MS) {
    healthCheck.intervalMs = parseInt(process.env.AO_HEALTH_CHECK_INTERVAL_MS, 10);
  }
  if (process.env.AO_HEALTH_CHECK_TIMEOUT_MS) {
    healthCheck.timeoutMs = parseInt(process.env.AO_HEALTH_CHECK_TIMEOUT_MS, 10);
  }
  if (Object.keys(healthCheck).length > 0) {
    config.healthCheck = healthCheck;
  }

  // Metrics config
  const metrics: Partial<AoMetricsConfig> = {};
  if (process.env.AO_METRICS_ENABLED !== undefined) {
    metrics.enabled = process.env.AO_METRICS_ENABLED === "true";
  }
  if (process.env.AO_METRICS_PORT) {
    metrics.port = parseInt(process.env.AO_METRICS_PORT, 10);
  }
  if (Object.keys(metrics).length > 0) {
    config.metrics = metrics;
  }

  return config;
}
