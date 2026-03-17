/**
 * Request Signature
 *
 * HMAC-SHA256 请求签名，用于 Webhook 认证
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { SignedRequest } from "../types.js";

/**
 * 构建签名请求头
 */
export function buildSignedHeaders(
  secret: string,
  payloadRaw: string
): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const digest = createHmac("sha256", secret).update(payloadRaw).digest("base64");

  return {
    "x-openclaw-timestamp": timestamp,
    "x-openclaw-signature": digest,
  };
}

/**
 * 验证请求签名
 */
export function verifyRequestSignature(
  secret: string,
  payloadRaw: string,
  signature: string,
  timestamp: string,
  maxAgeSeconds: number = 300
): { valid: boolean; error?: string } {
  // 验证时间戳
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp, 10);

  if (isNaN(ts)) {
    return { valid: false, error: "Invalid timestamp format" };
  }

  if (Math.abs(now - ts) > maxAgeSeconds) {
    return { valid: false, error: `Timestamp too old (max ${maxAgeSeconds}s)` };
  }

  // 计算期望的签名
  const expectedDigest = createHmac("sha256", secret)
    .update(payloadRaw)
    .digest("base64");

  // 使用 timing-safe 比较防止时序攻击
  try {
    const sigBuffer = Buffer.from(signature, "base64");
    const expectedBuffer = Buffer.from(expectedDigest, "base64");

    if (sigBuffer.length !== expectedBuffer.length) {
      return { valid: false, error: "Signature length mismatch" };
    }

    const valid = timingSafeEqual(sigBuffer, expectedBuffer);
    return { valid };
  } catch {
    return { valid: false, error: "Signature comparison failed" };
  }
}

/**
 * 从请求头提取签名信息
 */
export function extractSignatureFromHeaders(
  headers: Record<string, string | string[] | undefined>
): { signature?: string; timestamp?: string } {
  const signature =
    typeof headers["x-openclaw-signature"] === "string"
      ? headers["x-openclaw-signature"]
      : undefined;

  const timestamp =
    typeof headers["x-openclaw-timestamp"] === "string"
      ? headers["x-openclaw-timestamp"]
      : undefined;

  return { signature, timestamp };
}

/**
 * 创建签名请求
 */
export function createSignedRequest(
  secret: string,
  method: string,
  path: string,
  body: Record<string, unknown>
): SignedRequest {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const payload = JSON.stringify(body);
  const dataToSign = `${method.toUpperCase()}|${path}|${timestamp}|${payload}`;
  const signature = createHmac("sha256", secret).update(dataToSign).digest("base64");

  return {
    timestamp,
    signature,
    payload,
  };
}

/**
 * 验证签名请求
 */
export function verifySignedRequest(
  secret: string,
  method: string,
  path: string,
  request: SignedRequest,
  maxAgeSeconds: number = 300
): { valid: boolean; error?: string; body?: Record<string, unknown> } {
  // 验证时间戳
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(request.timestamp, 10);

  if (isNaN(ts)) {
    return { valid: false, error: "Invalid timestamp format" };
  }

  if (Math.abs(now - ts) > maxAgeSeconds) {
    return { valid: false, error: `Timestamp too old (max ${maxAgeSeconds}s)` };
  }

  // 重建签名数据
  const dataToVerify = `${method.toUpperCase()}|${path}|${request.timestamp}|${request.payload}`;
  const expectedSignature = createHmac("sha256", secret)
    .update(dataToVerify)
    .digest("base64");

  // 比较签名
  try {
    const sigBuffer = Buffer.from(request.signature, "base64");
    const expectedBuffer = Buffer.from(expectedSignature, "base64");

    if (sigBuffer.length !== expectedBuffer.length) {
      return { valid: false, error: "Signature length mismatch" };
    }

    const valid = timingSafeEqual(sigBuffer, expectedBuffer);

    if (!valid) {
      return { valid: false, error: "Signature mismatch" };
    }

    // 解析 payload
    try {
      const body = JSON.parse(request.payload) as Record<string, unknown>;
      return { valid: true, body };
    } catch {
      return { valid: false, error: "Invalid JSON payload" };
    }
  } catch {
    return { valid: false, error: "Signature verification failed" };
  }
}

/**
 * 签名中间件（用于 FastAPI/Express 风格的框架）
 */
export function createSignatureMiddleware(secret: string) {
  return async (
    request: {
      method: string;
      path: string;
      headers: Record<string, string | string[] | undefined>;
      body: string;
    },
    reply: (statusCode: number, body: Record<string, unknown>) => void
  ): Promise<boolean> => {
    const { signature, timestamp } = extractSignatureFromHeaders(request.headers);

    if (!signature || !timestamp) {
      reply(401, { error: "Missing signature headers" });
      return false;
    }

    const result = verifyRequestSignature(
      secret,
      request.body,
      signature,
      timestamp
    );

    if (!result.valid) {
      reply(401, { error: result.error || "Invalid signature" });
      return false;
    }

    return true;
  };
}
