import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, "../.env");

if (fs.existsSync(envPath)) {
  try {
    if (typeof process.loadEnvFile === "function") {
      process.loadEnvFile(envPath);
    } else {
      const content = fs.readFileSync(envPath, "utf-8");
      content.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx !== -1) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      });
    }
  } catch (err) {
    console.warn("Could not load .env automatically:", err.message);
  }
}

export const env = {
  PORT: process.env.PORT || 5000,
  NODE_ENV: process.env.NODE_ENV || "development",
  FRONTEND_URL: process.env.FRONTEND_URL || "http://localhost:3000",
  MONGODB_URI: process.env.MONGODB_URI || "mongodb+srv://admin_user:YourClusterPassword123@cluster0.practice.mongodb.net/?retryWrites=true&w=majority",
  PLATFORM_DB_NAME: process.env.PLATFORM_DB_NAME || "conversly_platform",
  SESSION_SECRET: process.env.SESSION_SECRET || "conversly_super_secure_session_secret_key_2026_dev",
  SESSION_COOKIE_NAME: process.env.SESSION_COOKIE_NAME || "conversly_session",
  SESSION_MAX_AGE_DAYS: parseInt(process.env.SESSION_MAX_AGE_DAYS || "7", 10),
  EMAIL_FROM: process.env.EMAIL_FROM || "no-reply@conversly.ai",
};
