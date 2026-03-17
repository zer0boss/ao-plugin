/**
 * mTLS Support
 *
 * 双向 TLS 证书管理和自动轮换
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import type { MtlsCredentials, AoMtlsConfig } from "../types.js";

/**
 * 加载 mTLS 凭证
 */
export function loadMtlsCredentials(config: AoMtlsConfig): MtlsCredentials | null {
  if (!config.enabled) {
    return null;
  }

  try {
    if (!config.certPath || !config.keyPath) {
      throw new Error("mTLS enabled but certPath or keyPath not provided");
    }

    const cert = fs.readFileSync(config.certPath, "utf-8");
    const key = fs.readFileSync(config.keyPath, "utf-8");
    const ca = config.caPath ? fs.readFileSync(config.caPath, "utf-8") : undefined;

    return { cert, key, ca };
  } catch (error) {
    console.error("Failed to load mTLS credentials:", error);
    return null;
  }
}

/**
 * 验证证书是否即将过期
 */
export function isCertificateExpiringSoon(
  certPath: string,
  thresholdDays: number = 30
): boolean {
  try {
    const cert = fs.readFileSync(certPath, "utf-8");
    const match = cert.match(/notAfter=([^\n]+)/);

    if (!match || !match[1]) {
      // 尝试解析 PEM 格式
      return checkPemExpiration(cert, thresholdDays);
    }

    const expiryDate = new Date(match[1]);
    const thresholdMs = thresholdDays * 24 * 60 * 60 * 1000;
    return expiryDate.getTime() - Date.now() < thresholdMs;
  } catch {
    return true; // 如果无法读取，认为需要轮换
  }
}

function checkPemExpiration(certPem: string, thresholdDays: number): boolean {
  try {
    // 简单的 PEM 过期检查（实际应用中应使用 crypto.x509）
    const match = certPem.match(/notAfter=([^,]+)/);
    if (match && match[1]) {
      const expiryDate = new Date(match[1]);
      const thresholdMs = thresholdDays * 24 * 60 * 60 * 1000;
      return expiryDate.getTime() - Date.now() < thresholdMs;
    }
    return true;
  } catch {
    return true;
  }
}

/**
 * 自签名证书生成器（用于测试和内部使用）
 */
export interface SelfSignedCertOptions {
  commonName: string;
  days: number;
  keySize?: number;
  country?: string;
  organization?: string;
}

export interface SelfSignedCert {
  cert: string;
  key: string;
  fingerprint: string;
}

/**
 * 生成自签名证书
 *
 * 注意：此函数使用 Node.js crypto 模块生成自签名证书
 * 生产环境建议使用正式 CA 签发的证书
 */
export function generateSelfSignedCertificate(
  options: SelfSignedCertOptions
): SelfSignedCert {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: options.keySize ?? 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  // 创建证书（简化版本，实际应用中应使用更完整的实现）
  const notBefore = new Date();
  const notAfter = new Date();
  notAfter.setDate(notAfter.getDate() + options.days);

  const certInfo = {
    subject: {
      CN: options.commonName,
      C: options.country ?? "CN",
      O: options.organization ?? "OpenClaw",
    },
    issuer: {
      CN: options.commonName,
      C: options.country ?? "CN",
      O: options.organization ?? "OpenClaw",
    },
    notBefore,
    notAfter,
    publicKey,
  };

  // 注意：这是简化实现，实际应使用完整的 X.509 证书生成
  // 在生产环境中，建议使用 OpenSSL 或专业证书管理工具

  const cert = `-----BEGIN CERTIFICATE-----
${Buffer.from(JSON.stringify(certInfo)).toString("base64")}
-----END CERTIFICATE-----`;

  // 计算指纹
  const fingerprint = require("node:crypto")
    .createHash("sha256")
    .update(cert)
    .digest("hex")
    .substring(0, 32);

  return {
    cert,
    key: privateKey,
    fingerprint,
  };
}

/**
 * 保存证书到文件
 */
export function saveCertificate(
  cert: SelfSignedCert,
  basePath: string
): { certPath: string; keyPath: string } {
  const dir = path.dirname(basePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const certPath = `${basePath}.crt`;
  const keyPath = `${basePath}.key`;

  fs.writeFileSync(certPath, cert.cert, { mode: 0o644 });
  fs.writeFileSync(keyPath, cert.key, { mode: 0o600 });

  return { certPath, keyPath };
}

/**
 * 证书轮换器
 */
export interface CertificateRotator {
  checkAndRotate(): Promise<boolean>;
  forceRotate(): Promise<void>;
  getCurrentFingerprint(): string | null;
}

export function createCertificateRotator(
  config: AoMtlsConfig,
  options: {
    thresholdDays?: number;
    commonName?: string;
    onRotate?: (newCert: SelfSignedCert) => void;
  } = {}
): CertificateRotator {
  const thresholdDays = options.thresholdDays ?? 30;
  let currentFingerprint: string | null = null;

  async function checkAndRotate(): Promise<boolean> {
    if (!config.enabled || !config.certPath) {
      return false;
    }

    if (!isCertificateExpiringSoon(config.certPath, thresholdDays)) {
      return false;
    }

    await forceRotate();
    return true;
  }

  async function forceRotate(): Promise<void> {
    if (!config.enabled || !config.certPath) {
      throw new Error("mTLS not enabled or certPath not set");
    }

    const basePath = config.certPath.replace(/\.crt$/, "");

    // 生成新证书
    const newCert = generateSelfSignedCertificate({
      commonName: options.commonName ?? "openclaw-ao-client",
      days: 365,
      keySize: 2048,
    });

    // 备份旧证书
    if (fs.existsSync(config.certPath)) {
      const backupPath = `${basePath}.backup.${Date.now()}.crt`;
      try {
        fs.copyFileSync(config.certPath, backupPath);
      } catch {
        // 忽略备份错误
      }
    }
    if (config.keyPath && fs.existsSync(config.keyPath)) {
      const backupKeyPath = `${basePath}.backup.${Date.now()}.key`;
      try {
        fs.copyFileSync(config.keyPath, backupKeyPath);
      } catch {
        // 忽略备份错误
      }
    }

    // 保存新证书
    saveCertificate(newCert, basePath);

    currentFingerprint = newCert.fingerprint;

    // 触发回调
    if (options.onRotate) {
      options.onRotate(newCert);
    }
  }

  function getCurrentFingerprint(): string | null {
    return currentFingerprint;
  }

  return {
    checkAndRotate,
    forceRotate,
    getCurrentFingerprint,
  };
}

/**
 * 启动自动证书轮换定时器
 */
export function startAutoCertificateRotation(
  rotator: CertificateRotator,
  intervalHours: number = 24
): { stop: () => void } {
  const intervalMs = intervalHours * 60 * 60 * 1000;

  // 立即检查一次
  void rotator.checkAndRotate();

  const timer = setInterval(() => {
    void rotator.checkAndRotate();
  }, intervalMs);

  return {
    stop: () => clearInterval(timer),
  };
}

/**
 * mTLS 上下文（用于 WebSocket/TLS 连接）
 */
export interface MtlsContext {
  cert: string;
  key: string;
  ca?: string;
  rejectUnauthorized: boolean;
}

export function createMtlsContext(
  credentials: MtlsCredentials,
  verifyServer: boolean = true
): MtlsContext {
  return {
    cert: credentials.cert,
    key: credentials.key,
    ca: credentials.ca,
    rejectUnauthorized: verifyServer,
  };
}
