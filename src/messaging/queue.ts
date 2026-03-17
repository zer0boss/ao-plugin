/**
 * Message Queue Implementation
 *
 * 持久化消息队列，支持消息确认、幂等性处理和重试
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  QueuedMessage,
  QueuedMessageStatus,
  MessageQueueOptions,
  MessageQueueStats,
} from "../types.js";

export interface MessageQueue {
  enqueue: (message: Omit<QueuedMessage, "id" | "createdAt" | "status" | "attemptCount">) => Promise<string>;
  dequeue: () => Promise<QueuedMessage | null>;
  confirm: (messageId: string) => Promise<void>;
  retry: (messageId: string) => Promise<void>;
  fail: (messageId: string, error: string) => Promise<void>;
  getPendingCount: () => number;
  getStats: () => MessageQueueStats;
  getMessage: (messageId: string) => QueuedMessage | null;
  startProcessor: (processor: MessageProcessor) => void;
  stopProcessor: () => void;
  close: () => Promise<void>;
}

export type MessageProcessor = (message: QueuedMessage) => Promise<void>;

export interface MessageQueueConfig {
  maxSize?: number;
  persistPath?: string;
  retryIntervalMs?: number;
  maxRetryAttempts?: number;
}

export function createMessageQueue(config: MessageQueueConfig = {}): MessageQueue {
  const options: MessageQueueOptions = {
    maxSize: config.maxSize ?? 1000,
    persistPath: config.persistPath,
    retryIntervalMs: config.retryIntervalMs ?? 5000,
    maxRetryAttempts: config.maxRetryAttempts ?? 3,
  };

  const messages: Map<string, QueuedMessage> = new Map();
  const processingQueue: Set<string> = new Set();
  const processedIds: Set<string> = new Set(); // 用于幂等性检查
  let processor: MessageProcessor | null = null;
  let processingTimer: ReturnType<typeof setInterval> | null = null;
  let isRunning = false;
  let messageIdCounter = 0;

  // 如果配置了持久化路径，加载已有消息
  if (options.persistPath) {
    loadFromDisk();
  }

  function generateMessageId(): string {
    return `msg-${Date.now()}-${++messageIdCounter}`;
  }

  function loadFromDisk(): void {
    try {
      if (!options.persistPath) return;

      const dir = path.dirname(options.persistPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (!fs.existsSync(options.persistPath)) {
        return;
      }

      const data = fs.readFileSync(options.persistPath, "utf-8");
      const loaded = JSON.parse(data) as QueuedMessage[];

      for (const msg of loaded) {
        messages.set(msg.id, msg);
        if (msg.status === "completed") {
          processedIds.add(msg.id);
        }
      }
    } catch (error) {
      console.error("Failed to load message queue from disk:", error);
    }
  }

  function saveToDisk(): void {
    try {
      if (!options.persistPath) return;

      const dir = path.dirname(options.persistPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const data = JSON.stringify(Array.from(messages.values()), null, 2);
      fs.writeFileSync(options.persistPath, data, "utf-8");
    } catch (error) {
      console.error("Failed to save message queue to disk:", error);
    }
  }

  async function enqueue(
    message: Omit<QueuedMessage, "id" | "createdAt" | "status" | "attemptCount">
  ): Promise<string> {
    if (messages.size >= options.maxSize) {
      throw new Error(`Message queue is full (max: ${options.maxSize})`);
    }

    // 检查是否已存在相同 eventId（幂等性）
    const existing = Array.from(messages.values()).find(
      (m) => m.eventId === message.eventId && m.status !== "failed"
    );
    if (existing) {
      return existing.id;
    }

    const id = generateMessageId();
    const queuedMessage: QueuedMessage = {
      ...message,
      id,
      status: "pending",
      attemptCount: 0,
      createdAt: Date.now(),
    };

    messages.set(id, queuedMessage);
    saveToDisk();

    // 如果处理器正在运行，立即触发处理
    if (isRunning && processor) {
      processNext();
    }

    return id;
  }

  async function dequeue(): Promise<QueuedMessage | null> {
    // 找到最早的 pending 消息
    let oldest: QueuedMessage | null = null;

    for (const message of messages.values()) {
      if (message.status === "pending") {
        if (!oldest || message.createdAt < oldest.createdAt) {
          oldest = message;
        }
      }
    }

    if (oldest) {
      oldest.status = "processing";
      processingQueue.add(oldest.id);
      saveToDisk();
      return oldest;
    }

    return null;
  }

  async function confirm(messageId: string): Promise<void> {
    const message = messages.get(messageId);
    if (!message) return;

    message.status = "completed";
    message.completedAt = Date.now();
    processingQueue.delete(messageId);
    processedIds.add(messageId);
    saveToDisk();

    // 清理已处理的消息（保留最近 1000 条用于幂等性检查）
    cleanupOldMessages();
  }

  async function retry(messageId: string): Promise<void> {
    const message = messages.get(messageId);
    if (!message) return;

    if (message.attemptCount >= options.maxRetryAttempts) {
      await fail(messageId, `Max retry attempts (${options.maxRetryAttempts}) exceeded`);
      return;
    }

    message.status = "retrying";
    message.attemptCount++;
    message.scheduledAt = Date.now() + options.retryIntervalMs * message.attemptCount;
    processingQueue.delete(messageId);
    saveToDisk();

    // 延迟后重新标记为 pending
    setTimeout(() => {
      const msg = messages.get(messageId);
      if (msg && msg.status === "retrying") {
        msg.status = "pending";
        saveToDisk();

        if (isRunning && processor) {
          processNext();
        }
      }
    }, options.retryIntervalMs * message.attemptCount);
  }

  async function fail(messageId: string, error: string): Promise<void> {
    const message = messages.get(messageId);
    if (!message) return;

    message.status = "failed";
    message.error = error;
    message.completedAt = Date.now();
    processingQueue.delete(messageId);
    saveToDisk();
  }

  function getPendingCount(): number {
    let count = 0;
    for (const message of messages.values()) {
      if (message.status === "pending") {
        count++;
      }
    }
    return count;
  }

  function getStats(): MessageQueueStats {
    let pendingCount = 0;
    let processingCount = 0;
    let failedCount = 0;

    for (const message of messages.values()) {
      switch (message.status) {
        case "pending":
        case "retrying":
          pendingCount++;
          break;
        case "processing":
          processingCount++;
          break;
        case "failed":
          failedCount++;
          break;
      }
    }

    return {
      pendingCount,
      processingCount,
      failedCount,
      totalCount: messages.size,
    };
  }

  function getMessage(messageId: string): QueuedMessage | null {
    return messages.get(messageId) ?? null;
  }

  function cleanupOldMessages(): void {
    // 只保留最近的 1000 条已完成消息用于幂等性检查
    const completedMessages = Array.from(messages.values())
      .filter((m) => m.status === "completed")
      .sort((a, b) => b.createdAt - a.createdAt);

    if (completedMessages.length > 1000) {
      const toRemove = completedMessages.slice(1000);
      for (const msg of toRemove) {
        messages.delete(msg.id);
        processedIds.delete(msg.id);
      }
      saveToDisk();
    }
  }

  async function processNext(): Promise<void> {
    if (!processor) return;

    const message = await dequeue();
    if (!message) return;

    try {
      await processor(message);
      await confirm(message.id);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      // 判断是否应该重试
      const shouldRetry = message.attemptCount < options.maxRetryAttempts;

      if (shouldRetry) {
        await retry(message.id);
      } else {
        await fail(message.id, errorMsg);
      }
    }

    // 继续处理下一条
    if (isRunning) {
      setImmediate(processNext);
    }
  }

  function startProcessor(proc: MessageProcessor): void {
    if (isRunning) {
      return;
    }

    processor = proc;
    isRunning = true;

    // 启动处理循环
    processNext();

    // 启动定时检查，处理重试的消息
    processingTimer = setInterval(() => {
      if (!isRunning) return;
      processNext();
    }, options.retryIntervalMs);
  }

  function stopProcessor(): void {
    isRunning = false;

    if (processingTimer) {
      clearInterval(processingTimer);
      processingTimer = null;
    }

    processor = null;
  }

  async function close(): Promise<void> {
    stopProcessor();
    saveToDisk();
  }

  return {
    enqueue,
    dequeue,
    confirm,
    retry,
    fail,
    getPendingCount,
    getStats,
    getMessage,
    startProcessor,
    stopProcessor,
    close,
  };
}

/**
 * 创建内存队列（非持久化）
 */
export function createMemoryQueue(config?: MessageQueueConfig): MessageQueue {
  return createMessageQueue({
    ...config,
    persistPath: undefined,
  });
}

/**
 * 创建持久化队列
 */
export function createPersistentQueue(
  persistPath: string,
  config?: Omit<MessageQueueConfig, "persistPath">
): MessageQueue {
  return createMessageQueue({
    ...config,
    persistPath,
  });
}
