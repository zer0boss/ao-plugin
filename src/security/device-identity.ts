/**
 * Device Identity Management
 *
 * ED25519 设备身份管理，支持密钥生成、签名和验证
 */

import { generateKeyPairSync, createSign, createVerify, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { DeviceIdentity } from "../types.js";

// ============================================================================
// Key Generation and Management
// ============================================================================

/**
 * 生成设备身份（ED25519 密钥对）
 */
export function generateDeviceIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const deviceId = fingerprintPublicKey(publicKeyPem);

  return {
    deviceId,
    publicKeyPem,
    privateKeyPem,
    createdAt: Date.now(),
  };
}

/**
 * 计算公钥指纹（SHA256）
 */
export function fingerprintPublicKey(publicKeyPem: string): string {
  const hash = createHash("sha256").update(publicKeyPem).digest("hex");
  // 返回前 32 位作为设备 ID
  return hash.substring(0, 32);
}

/**
 * 加载或创建设备身份
 */
export function loadOrCreateDeviceIdentity(storagePath?: string): DeviceIdentity {
  // 如果提供了存储路径，尝试加载
  if (storagePath) {
    const loaded = loadDeviceIdentity(storagePath);
    if (loaded) {
      return loaded;
    }
  }

  // 创建新的身份
  const identity = generateDeviceIdentity();

  // 保存到磁盘
  if (storagePath) {
    saveDeviceIdentity(identity, storagePath);
  }

  return identity;
}

/**
 * 从磁盘加载设备身份
 */
export function loadDeviceIdentity(storagePath: string): DeviceIdentity | null {
  try {
    if (!fs.existsSync(storagePath)) {
      return null;
    }

    const data = fs.readFileSync(storagePath, "utf-8");
    const identity = JSON.parse(data) as DeviceIdentity;

    // 验证必需字段
    if (
      !identity.deviceId ||
      !identity.publicKeyPem ||
      !identity.privateKeyPem
    ) {
      return null;
    }

    return identity;
  } catch (error) {
    console.error("Failed to load device identity:", error);
    return null;
  }
}

/**
 * 保存设备身份到磁盘
 */
export function saveDeviceIdentity(
  identity: DeviceIdentity,
  storagePath: string
): void {
  try {
    const dir = path.dirname(storagePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 设置严格的文件权限（仅所有者读写）
    const data = JSON.stringify(identity, null, 2);
    fs.writeFileSync(storagePath, data, { mode: 0o600 });
  } catch (error) {
    console.error("Failed to save device identity:", error);
    throw error;
  }
}

/**
 * 旋转设备密钥（生成新密钥对）
 */
export function rotateDeviceIdentity(
  oldIdentity: DeviceIdentity,
  storagePath?: string
): DeviceIdentity {
  const newIdentity = generateDeviceIdentity();

  // 保存新身份
  if (storagePath) {
    // 备份旧身份
    const backupPath = `${storagePath}.backup.${Date.now()}`;
    try {
      fs.copyFileSync(storagePath, backupPath);
    } catch {
      // 忽略备份错误
    }

    saveDeviceIdentity(newIdentity, storagePath);
  }

  return newIdentity;
}

// ============================================================================
// V3 Protocol Signatures
// ============================================================================

/**
 * 构建 V3 协议认证载荷
 */
export function buildDeviceAuthPayloadV3(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string;
  nonce: string;
  platform: string;
  deviceFamily?: string;
}): string {
  const parts = [
    `v3:${params.deviceId}`,
    `client:${params.clientId}`,
    `mode:${params.clientMode}`,
    `role:${params.role}`,
    `scopes:${params.scopes.join(",")}`,
    `signed:${params.signedAtMs}`,
    params.token ? `token:${params.token}` : "token:",
    `nonce:${params.nonce}`,
    `platform:${params.platform}`,
    params.deviceFamily ? `family:${params.deviceFamily}` : "family:",
  ];
  return parts.join("|");
}

/**
 * 使用设备私钥签名数据
 */
export function signWithDeviceKey(
  privateKeyPem: string,
  data: string
): string {
  const sign = createSign("RSA-SHA256");
  sign.update(data);
  sign.end();
  return sign.sign(privateKeyPem, "base64");
}

/**
 * 使用设备公钥验证签名
 */
export function verifyWithDeviceKey(
  publicKeyPem: string,
  data: string,
  signature: string
): boolean {
  try {
    const verify = createVerify("RSA-SHA256");
    verify.update(data);
    verify.end();
    return verify.verify(publicKeyPem, signature, "base64");
  } catch {
    return false;
  }
}

// ============================================================================
// Nonce Generation
// ============================================================================

/**
 * 生成安全的随机 nonce
 */
export function generateNonce(length: number = 32): string {
  return randomBytes(length).toString("hex");
}

/**
 * 生成时间戳 nonce（带随机后缀）
 */
export function generateTimestampNonce(): string {
  const timestamp = Date.now().toString(36);
  const random = randomBytes(8).toString("hex");
  return `${timestamp}-${random}`;
}

// ============================================================================
// Challenge Response
// ============================================================================

/**
 * 响应服务器 challenge
 */
export function createChallengeResponse(
  identity: DeviceIdentity,
  nonce: string,
  additionalData?: Record<string, unknown>
): {
  deviceId: string;
  signature: string;
  timestamp: number;
  data: Record<string, unknown>;
} {
  const payload = JSON.stringify({
    nonce,
    deviceId: identity.deviceId,
    timestamp: Date.now(),
    ...additionalData,
  });

  const signature = signWithDeviceKey(identity.privateKeyPem, payload);

  return {
    deviceId: identity.deviceId,
    signature,
    timestamp: Date.now(),
    data: JSON.parse(payload),
  };
}

// ============================================================================
// Device Identity Manager
// ============================================================================

export interface DeviceIdentityManager {
  getIdentity(): DeviceIdentity;
  rotateIdentity(): DeviceIdentity;
  sign(data: string): string;
  verify(data: string, signature: string, deviceId?: string): boolean;
}

export function createDeviceIdentityManager(
  storagePath?: string
): DeviceIdentityManager {
  let identity = loadOrCreateDeviceIdentity(storagePath);

  function getIdentity(): DeviceIdentity {
    return identity;
  }

  function rotateIdentity(): DeviceIdentity {
    identity = rotateDeviceIdentity(identity, storagePath);
    return identity;
  }

  function sign(data: string): string {
    return signWithDeviceKey(identity.privateKeyPem, data);
  }

  function verify(data: string, signature: string, deviceId?: string): boolean {
    // 如果提供了 deviceId，验证是否匹配
    if (deviceId && deviceId !== identity.deviceId) {
      return false;
    }
    return verifyWithDeviceKey(identity.publicKeyPem, data, signature);
  }

  return {
    getIdentity,
    rotateIdentity,
    sign,
    verify,
  };
}
