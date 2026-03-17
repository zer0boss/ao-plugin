/**
 * Metrics Collector and Exporter
 *
 * Prometheus 格式的指标收集和导出
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type {
  ConnectionMetrics,
  MessageMetrics,
  AoMetrics,
  AoMetricsConfig,
} from "../types.js";

// ============================================================================
// Metrics Types
// ============================================================================

interface HistogramValue {
  buckets: Map<number, number>;
  sum: number;
  count: number;
}

interface MetricsRegistry {
  counters: Map<string, number>;
  gauges: Map<string, number>;
  histograms: Map<string, HistogramValue>;
}

// ============================================================================
// Default Buckets (milliseconds)
// ============================================================================

const DEFAULT_LATENCY_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

// ============================================================================
// Metrics Collector
// ============================================================================

export class MetricsCollector {
  private registry: MetricsRegistry;
  private startTime: number;
  private lastTickAt: number = 0;

  constructor() {
    this.registry = {
      counters: new Map(),
      gauges: new Map(),
      histograms: new Map(),
    };
    this.startTime = Date.now();

    // 初始化默认指标
    this.initializeDefaultMetrics();
  }

  private initializeDefaultMetrics(): void {
    // Connection metrics
    this.setGauge("ao_connections_total", 0);
    this.setGauge("ao_connections_active", 0);
    this.setGauge("ao_connections_idle", 0);
    this.setGauge("ao_connections_unhealthy", 0);

    // Message metrics
    this.setCounter("ao_messages_received_total", 0);
    this.setCounter("ao_messages_sent_total", 0);
    this.setCounter("ao_messages_failed_total", 0);

    // Error metrics
    this.setCounter("ao_errors_total", 0);

    // Initialize histograms
    this.registry.histograms.set("ao_message_latency_seconds", {
      buckets: new Map(DEFAULT_LATENCY_BUCKETS.map((b) => [b, 0])),
      sum: 0,
      count: 0,
    });
  }

  // Counter Operations
  incrementCounter(name: string, value: number = 1): void {
    const current = this.registry.counters.get(name) ?? 0;
    this.registry.counters.set(name, current + value);
  }

  setCounter(name: string, value: number): void {
    this.registry.counters.set(name, value);
  }

  getCounter(name: string): number {
    return this.registry.counters.get(name) ?? 0;
  }

  // Gauge Operations
  setGauge(name: string, value: number): void {
    this.registry.gauges.set(name, value);
  }

  incrementGauge(name: string, value: number = 1): void {
    const current = this.registry.gauges.get(name) ?? 0;
    this.registry.gauges.set(name, current + value);
  }

  decrementGauge(name: string, value: number = 1): void {
    const current = this.registry.gauges.get(name) ?? 0;
    this.registry.gauges.set(name, Math.max(0, current - value));
  }

  getGauge(name: string): number {
    return this.registry.gauges.get(name) ?? 0;
  }

  // Histogram Operations
  observeHistogram(name: string, value: number): void {
    let histogram = this.registry.histograms.get(name);

    if (!histogram) {
      histogram = {
        buckets: new Map(DEFAULT_LATENCY_BUCKETS.map((b) => [b, 0])),
        sum: 0,
        count: 0,
      };
      this.registry.histograms.set(name, histogram);
    }

    histogram.count++;
    histogram.sum += value;

    for (const [bucket, count] of histogram.buckets) {
      if (value <= bucket) {
        histogram.buckets.set(bucket, count + 1);
      }
    }
  }

  getHistogram(name: string): HistogramValue | null {
    return this.registry.histograms.get(name) ?? null;
  }

  // Specific Metrics
  recordConnectionConnected(): void {
    this.incrementCounter("ao_connections_total");
    this.incrementGauge("ao_connections_active");
  }

  recordConnectionDisconnected(): void {
    this.decrementGauge("ao_connections_active");
  }

  recordConnectionReconnected(): void {
    this.incrementCounter("ao_reconnections_total");
  }

  recordConnectionFailed(): void {
    this.incrementCounter("ao_connections_failed_total");
  }

  recordMessageReceived(): void {
    this.incrementCounter("ao_messages_received_total");
  }

  recordMessageSent(): void {
    this.incrementCounter("ao_messages_sent_total");
  }

  recordMessageFailed(): void {
    this.incrementCounter("ao_messages_failed_total");
  }

  recordMessageLatency(latencyMs: number): void {
    this.observeHistogram("ao_message_latency_seconds", latencyMs / 1000);
  }

  recordError(errorCode: string): void {
    this.incrementCounter("ao_errors_total", 1);
    this.incrementCounter(`ao_errors_${errorCode}_total`, 1);
  }

  updateConnectionStats(stats: {
    total: number;
    active: number;
    idle: number;
    unhealthy: number;
  }): void {
    this.setGauge("ao_connections_total", stats.total);
    this.setGauge("ao_connections_active", stats.active);
    this.setGauge("ao_connections_idle", stats.idle);
    this.setGauge("ao_connections_unhealthy", stats.unhealthy);
  }

  recordTick(): void {
    this.lastTickAt = Date.now();
    this.setGauge("ao_last_tick_timestamp", this.lastTickAt / 1000);
  }

  // Get All Metrics
  getAllMetrics(): AoMetrics {
    return {
      connections: {
        connectionsTotal: this.getCounter("ao_connections_total"),
        connectionsActive: this.getGauge("ao_connections_active"),
        connectionsFailed: this.getCounter("ao_connections_failed_total"),
        reconnectionsTotal: this.getCounter("ao_reconnections_total"),
        reconnectionsFailed: this.getCounter("ao_reconnections_failed_total"),
      },
      messages: {
        messagesReceivedTotal: this.getCounter("ao_messages_received_total"),
        messagesSentTotal: this.getCounter("ao_messages_sent_total"),
        messagesFailedTotal: this.getCounter("ao_messages_failed_total"),
        messageLatencySeconds: [],
      },
      errors: this.getErrorCounts(),
      lastTickAt: this.lastTickAt,
    };
  }

  private getErrorCounts(): Record<string, number> {
    const errors: Record<string, number> = {};
    for (const [name, value] of this.registry.counters) {
      if (name.startsWith("ao_errors_") && name !== "ao_errors_total") {
        const errorCode = name.replace("ao_errors_", "").replace("_total", "");
        errors[errorCode] = value;
      }
    }
    return errors;
  }

  // Prometheus Export
  exportPrometheusFormat(): string {
    const lines: string[] = [];

    // Header
    lines.push("# OpenClaw AO Plugin Metrics");
    lines.push(`# Generated at ${new Date().toISOString()}`);
    lines.push("");

    // Counters
    lines.push("# Counters");
    for (const [name, value] of this.registry.counters) {
      lines.push(`# TYPE ${name} counter`);
      lines.push(`${name} ${value}`);
    }

    // Gauges
    lines.push("");
    lines.push("# Gauges");
    for (const [name, value] of this.registry.gauges) {
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name} ${value}`);
    }

    // Histograms
    lines.push("");
    lines.push("# Histograms");
    for (const [name, histogram] of this.registry.histograms) {
      const bucketLabels = DEFAULT_LATENCY_BUCKETS.map((bucket) => {
        return `${name}_bucket{le="${bucket}"} ${histogram.buckets.get(bucket) ?? 0}`;
      });

      lines.push(`# TYPE ${name} histogram`);
      lines.push(...bucketLabels);
      lines.push(`${name}_bucket{le="+Inf"} ${histogram.count}`);
      lines.push(`${name}_sum ${histogram.sum}`);
      lines.push(`${name}_count ${histogram.count}`);
    }

    // Uptime
    lines.push("");
    lines.push("# Service Info");
    lines.push(`# TYPE ao_uptime_seconds gauge`);
    lines.push(`ao_uptime_seconds ${(Date.now() - this.startTime) / 1000}`);

    return lines.join("\n");
  }

  // Reset
  reset(): void {
    this.registry.counters.clear();
    this.registry.gauges.clear();
    this.registry.histograms.clear();
    this.initializeDefaultMetrics();
  }
}

// ============================================================================
// Metrics Exporter Server
// ============================================================================

export interface MetricsExporter {
  start(): Promise<void>;
  stop(): Promise<void>;
  getUrl(): string;
}

export function createMetricsExporter(
  collector: MetricsCollector,
  config: AoMetricsConfig
): MetricsExporter {
  let server: Server | null = null;

  async function start(): Promise<void> {
    if (!config.enabled) {
      return;
    }

    if (server) {
      return;
    }

    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // Health check endpoint
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      // Metrics endpoint
      if (req.url === config.path || req.url === "/metrics") {
        const metrics = collector.exportPrometheusFormat();
        res.writeHead(200, {
          "Content-Type": "text/plain; version=0.0.4",
          "Cache-Control": "no-cache",
        });
        res.end(metrics);
        return;
      }

      // 404
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });

    return new Promise((resolve, reject) => {
      server!.listen(config.port, () => {
        console.log(`Metrics exporter listening on port ${config.port}`);
        resolve();
      });

      server!.on("error", (error) => {
        reject(error);
      });
    });
  }

  async function stop(): Promise<void> {
    if (!server) {
      return;
    }

    return new Promise((resolve) => {
      server!.close(() => {
        server = null;
        resolve();
      });
    });
  }

  function getUrl(): string {
    return `http://localhost:${config.port}${config.path}`;
  }

  return {
    start,
    stop,
    getUrl,
  };
}

// ============================================================================
// Global Metrics Instance
// ============================================================================

let globalCollector: MetricsCollector | null = null;

export function getMetricsCollector(): MetricsCollector {
  if (!globalCollector) {
    globalCollector = new MetricsCollector();
  }
  return globalCollector;
}

export function resetGlobalCollector(): void {
  if (globalCollector) {
    globalCollector.reset();
  }
  globalCollector = null;
}
