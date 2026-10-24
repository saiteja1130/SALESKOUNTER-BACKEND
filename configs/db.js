import mongoose from "mongoose";
import { env } from "./env.js";

let isConnecting = false;
let isConnected = false;

export async function connectPlatformDB() {
  if (isConnected || isConnecting) return;
  isConnecting = true;

  try {
    const uri = env.MONGODB_URI;
    console.log(`[Database] Connecting to central MongoDB platform db (${env.PLATFORM_DB_NAME})...`);
    
    await mongoose.connect(uri, {
      dbName: env.PLATFORM_DB_NAME,
      serverSelectionTimeoutMS: 5000,
    });

    isConnected = true;
    isConnecting = false;
    console.log(`[Database] Connected successfully to platform database: ${env.PLATFORM_DB_NAME}`);
  } catch (err) {
    isConnecting = false;
    isConnected = false;
    console.warn(`[Database] MongoDB connection warning: ${err.message}`);
    console.warn(`[Database] Please configure a valid MongoDB Atlas URI in BACKEND/.env when ready.`);
  }
}

export function isDbConnected() {
  return mongoose.connection.readyState === 1;
}

/**
 * Returns a tenant-specific Mongoose Db connection using the shared cluster.
 * Clients never pass database names; the server resolves this securely from the organization registry.
 */
export function getTenantDB(tenantDbName) {
  if (!tenantDbName) {
    throw new Error("Tenant database name is required.");
  }
  return mongoose.connection.useDb(tenantDbName, { useCache: true });
}
