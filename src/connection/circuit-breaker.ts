/**
 * Circuit Breaker Pattern Implementation
 *
 * 实现断路器模式，防止级联故障，提升系统稳定性
 *
 * 状态转换:
 * CLOSED -> OPEN: 失败次数达到阈值
 * OPEN -> HALF_OPEN: 恢复超时后
 * HALF_OPEN -> CLOSED: 半开状态下成功次数达到阈值
 * HALF_OPEN -> OPEN: 半开状态下失败
 */

import type {
  CircuitBreakerState,
  CircuitBreakerOptions,
  CircuitBreakerMetrics,
} from "../types.js";

export interface CircuitBreaker {
  execute: <T>(fn: () => Promise<T>) => Promise<T>;
  recordSuccess: () => void;
  recordFailure: () => void;
  getState: () => CircuitBreakerState;
  getMetrics: () => CircuitBreakerMetrics;
  reset: () => void;
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  recoveryTimeout: number;
  halfOpenMaxCalls: number;
}

export function createCircuitBreaker(
  config: Partial<CircuitBreakerConfig> = {}
): CircuitBreaker {
  const options: CircuitBreakerOptions = {
    failureThreshold: config.failureThreshold ?? 5,
    recoveryTimeout: config.recoveryTimeout ?? 30000,
    halfOpenMaxCalls: config.halfOpenMaxCalls ?? 3,
  };

  let state: CircuitBreakerState = "CLOSED";
  let failureCount = 0;
  let successCount = 0;
  let lastFailureTime: number | null = null;
  let lastSuccessTime: number | null = null;
  let totalCalls = 0;
  let rejectedCalls = 0;
  let halfOpenCallCount = 0;
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;

  function getState(): CircuitBreakerState {
    return state;
  }

  function getMetrics(): CircuitBreakerMetrics {
    return {
      state,
      failureCount,
      successCount,
      lastFailureTime,
      lastSuccessTime,
      totalCalls,
      rejectedCalls,
    };
  }

  function transitionToOpen(): void {
    state = "OPEN";
    halfOpenCallCount = 0;

    // 设置恢复定时器
    if (recoveryTimer) {
      clearTimeout(recoveryTimer);
    }
    recoveryTimer = setTimeout(() => {
      transitionToHalfOpen();
    }, options.recoveryTimeout);
  }

  function transitionToHalfOpen(): void {
    state = "HALF_OPEN";
    failureCount = 0;
    successCount = 0;
    halfOpenCallCount = 0;
  }

  function transitionToClosed(): void {
    state = "CLOSED";
    failureCount = 0;
    successCount = 0;
    halfOpenCallCount = 0;

    if (recoveryTimer) {
      clearTimeout(recoveryTimer);
      recoveryTimer = null;
    }
  }

  function recordSuccess(): void {
    lastSuccessTime = Date.now();

    if (state === "HALF_OPEN") {
      successCount++;
      halfOpenCallCount++;

      if (successCount >= options.halfOpenMaxCalls) {
        transitionToClosed();
      }
    } else if (state === "CLOSED") {
      failureCount = 0;
    }
  }

  function recordFailure(): void {
    lastFailureTime = Date.now();
    failureCount++;

    if (state === "HALF_OPEN") {
      transitionToOpen();
    } else if (state === "CLOSED" && failureCount >= options.failureThreshold) {
      transitionToOpen();
    }
  }

  async function execute<T>(fn: () => Promise<T>): Promise<T> {
    totalCalls++;

    if (state === "OPEN") {
      rejectedCalls++;
      throw new Error(
        `Circuit breaker is OPEN. Last failure at ${lastFailureTime}. Recovery in ${options.recoveryTimeout}ms`
      );
    }

    if (state === "HALF_OPEN") {
      if (halfOpenCallCount >= options.halfOpenMaxCalls) {
        rejectedCalls++;
        throw new Error(
          `Circuit breaker is HALF_OPEN and has reached max calls (${options.halfOpenMaxCalls})`
        );
      }
      halfOpenCallCount++;
    }

    try {
      const result = await fn();
      recordSuccess();
      return result;
    } catch (error) {
      recordFailure();
      throw error;
    }
  }

  function reset(): void {
    transitionToClosed();
    totalCalls = 0;
    rejectedCalls = 0;
  }

  // 清理函数，用于插件卸载时
  function destroy(): void {
    if (recoveryTimer) {
      clearTimeout(recoveryTimer);
    }
  }

  // 绑定 destroy 到 CircuitBreaker 对象
  const breaker: CircuitBreaker = {
    execute,
    recordSuccess,
    recordFailure,
    getState,
    getMetrics,
    reset,
  };

  // 将 destroy 作为隐藏属性添加，供内部使用
  Object.defineProperty(breaker, "_destroy", {
    value: destroy,
    writable: false,
    enumerable: false,
    configurable: false,
  });

  return breaker;
}

/**
 * 带断路器的重试执行器
 *
 * @param fn - 要执行的异步函数
 * @param circuitBreaker - 断路器实例
 * @param maxRetries - 最大重试次数
 * @param retryDelay - 重试延迟（毫秒）
 * @returns 执行结果
 */
export async function executeWithCircuitBreaker<T>(
  fn: () => Promise<T>,
  circuitBreaker: CircuitBreaker,
  maxRetries: number = 3,
  retryDelay: number = 1000
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await circuitBreaker.execute(fn);
    } catch (error) {
      lastError = error as Error;

      // 如果是断路器打开的错，直接抛出
      if (error instanceof Error && error.message.includes("Circuit breaker")) {
        throw error;
      }

      // 如果还有重试机会，等待后重试
      if (attempt <= maxRetries) {
        await sleep(retryDelay * attempt); // 指数退避
      }
    }
  }

  throw lastError ?? new Error("Execute failed after retries");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 创建带抖动的退避延迟
 *
 * @param baseDelay - 基础延迟
 * @param attempt - 尝试次数
 * @param maxDelay - 最大延迟
 * @returns 计算后的延迟
 */
export function calculateBackoffWithJitter(
  baseDelay: number,
  attempt: number,
  maxDelay: number = 30000
): number {
  const exponentialDelay = baseDelay * Math.pow(2, Math.max(0, attempt - 1));
  const jitter = Math.random() * 0.3 * exponentialDelay; // 30% 抖动
  return Math.min(exponentialDelay + jitter, maxDelay);
}
