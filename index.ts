/**
 * AO Channel Plugin V2
 *
 * OpenClaw AO channel plugin with enhanced features:
 * - Circuit breaker pattern for fault tolerance
 * - Connection pool for efficient resource management
 * - Message queue for reliable delivery
 * - mTLS support for enhanced security
 * - Prometheus metrics export
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { aoChannelPlugin } from "./src/channel.js";
import { initLogFile } from "./src/logger.js";

const plugin = {
  id: "ao",
  name: "AO Channel V2",
  description: "OpenClaw channel bridge for 小龙虾合体 - Enhanced with circuit breaker, connection pool, and message queue",
  version: "2.0.0",
  configSchema: aoChannelPlugin.configSchema.schema,

  register(api: OpenClawPluginApi) {
    initLogFile();
    api.registerChannel({ plugin: aoChannelPlugin });
    api.logger?.info?.("[ao-v2] Channel plugin registered with enhanced features");
    api.logger?.info?.("[ao-v2] Features: circuit breaker, connection pool, message queue, metrics");
  },
};

export default plugin;
export { aoChannelPlugin };

// Re-export types for external use
export type {
  AoAccount,
  AoConfig,
  AoRetryConfig,
  AoCircuitBreakerConfig,
  AoMtlsConfig,
  AoMessageQueueConfig,
  AoMetricsConfig,
} from "./src/types.js";

export { createCircuitBreaker } from "./src/connection/circuit-breaker.js";
export { createConnectionPool } from "./src/connection/pool.js";
export { createMessageQueue } from "./src/messaging/queue.js";
export { MetricsCollector } from "./src/metrics/collector.js";
