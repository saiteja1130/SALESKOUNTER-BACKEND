import crypto from "node:crypto";
import { env } from "../configs/env.js";

/**
 * Hash a password using scrypt with a unique random salt
 */
export function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString("hex");
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`${salt}:${derivedKey.toString("hex")}`);
    });
  });
}

/**
 * Verify a plain password against the stored salt:hash
 */
export function verifyPassword(password, storedHash) {
  return new Promise((resolve, reject) => {
    if (!storedHash || !storedHash.includes(":")) return resolve(false);
    const [salt, key] = storedHash.split(":");
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      const keyBuffer = Buffer.from(key, "hex");
      const match = crypto.timingSafeEqual(keyBuffer, derivedKey);
      resolve(match);
    });
  });
}

/**
 * Generate a cryptographically secure random token (hex)
 */
export function generateRandomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

/**
 * Return current calendar date string in Indian Standard Time (IST: UTC+05:30)
 * Format: "YYYY-MM-DD"
 * Limits reset at 12:00 a.m. IST according to agreed rules.
 */
export function getTodayDateIST(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(date);
}

/**
 * Convert organization name to URL-friendly db-safe slug
 */
export function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\w-]+/g, "")
    .replace(/--+/g, "_")
    .slice(0, 30);
}

const derivedKeyCache = new Map();
function getDerivedEncryptionKey(secret) {
  let key = derivedKeyCache.get(secret);
  if (!key) {
    key = crypto.scryptSync(secret, "conversly_secret_salt", 32);
    derivedKeyCache.set(secret, key);
  }
  return key;
}

/**
 * Encrypt sensitive credentials (e.g. API keys) using AES-256-GCM
 */
export function encryptSecret(plainText, secret = env.SESSION_SECRET) {
  if (!plainText) return "";
  if (!secret) {
    throw new Error("Encryption secret is not configured.");
  }
  const iv = crypto.randomBytes(12);
  const key = getDerivedEncryptionKey(secret);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypt sensitive credentials previously encrypted with encryptSecret
 */
export function decryptSecret(encryptedPayload, secret = env.SESSION_SECRET) {
  if (!encryptedPayload || !encryptedPayload.includes(":")) return "";
  if (!secret) return "";
  try {
    const [ivHex, tagHex, dataHex] = encryptedPayload.split(":");
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const encrypted = Buffer.from(dataHex, "hex");
    const key = getDerivedEncryptionKey(secret);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf8");
  } catch (err) {
    return "";
  }
}

export function getWhatsAppEncryptionSecret() {
  const secret = env.WHATSAPP_ENCRYPTION_SECRET || env.SESSION_SECRET;
  if (!secret) {
    throw new Error("WhatsApp encryption secret is not configured.");
  }
  return secret;
}
