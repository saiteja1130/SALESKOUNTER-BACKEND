import crypto from "node:crypto";
import makeWASocket, {
  DisconnectReason,
  BufferJSON,
  initAuthCreds,
  proto,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import { getWhatsAppEncryptionSecret, encryptSecret, decryptSecret } from "./crypto.js";
import { emitToOrg, emitToUser } from "./whatsappSocketGateway.js";
import { handleMessagesUpsert, handleReactionEvent, handleMessageUpdateEvent, handleMessageDeleteEvent } from "./messageHandler.js";
import { Organization } from "../models/platform/Organization.js";
import { Subscription } from "../models/platform/Subscription.js";
import { computeEntitlements } from "./entitlements.js";
import { getTenantDB, isDbConnected } from "../configs/db.js";
import { getTenantModels } from "../models/tenant/schemas.js";

// Unique worker process instance identifier for distributed leases
const INSTANCE_ID = `proc_${process.pid}_${crypto.randomBytes(6).toString("hex")}`;
const LEASE_DURATION_MS = 30000;
const LEASE_HEARTBEAT_MS = 10000;

// In-process active worker cache
const activeWorkers = new Map();
let watchdogTimer = null;

/**
 * Build database-backed Baileys authentication state with AES-256-GCM encryption
 */
async function buildDBAuthState(tenantModels, connectionId) {
  const encryptionSecret = getWhatsAppEncryptionSecret();
  // Baileys emits credential and Signal-key updates concurrently. Serialize
  // writes per connection so older snapshots cannot overwrite newer state.
  let authWriteQueue = Promise.resolve();
  const enqueueAuthWrite = (write) => {
    const pending = authWriteQueue.then(write, write);
    authWriteQueue = pending.catch(() => {});
    return pending;
  };

  // Load existing credentials or initialize clean credentials
  const authStateDoc = await tenantModels.WhatsAppAuthState.findOne({ connectionId });
  let creds;

  if (authStateDoc && authStateDoc.encryptedCreds) {
    try {
      const decrypted = decryptSecret(authStateDoc.encryptedCreds, encryptionSecret);
      creds = JSON.parse(decrypted, BufferJSON.reviver);
    } catch (err) {
      throw new Error(`Stored WhatsApp credentials could not be decrypted for connection ${connectionId}: ${err.message}`);
    }
  } else {
    creds = initAuthCreds();
  }

  // Define keys store backed by WhatsAppAuthKey collection
  const baseKeys = {
    get: async (type, ids) => {
      const result = {};
      const stringIds = ids.map((id) => String(id));
      const keyDocs = await tenantModels.WhatsAppAuthKey.find({
        connectionId,
        keyType: type,
        keyId: { $in: stringIds },
      });

      for (const doc of keyDocs) {
        if (!doc.encryptedValue) continue;
        const decrypted = decryptSecret(doc.encryptedValue, encryptionSecret);
        let parsed = JSON.parse(decrypted, BufferJSON.reviver);
        if (type === "app-state-sync-key" && parsed) {
          parsed = proto.Message.AppStateSyncKeyData.fromObject(parsed);
        }
        result[doc.keyId] = parsed;
      }
      return result;
    },

    set: async (data) => enqueueAuthWrite(async () => {
        const operations = [];
        for (const type of Object.keys(data)) {
          for (const keyId of Object.keys(data[type])) {
            const val = data[type][keyId];
            if (val === null || val === undefined) {
              // Delete key
              operations.push({
                deleteOne: {
                  filter: { connectionId, keyType: type, keyId: String(keyId) },
                },
              });
            } else {
              // Upsert key
              const serialized = JSON.stringify(val, BufferJSON.replacer);
              const encryptedValue = encryptSecret(serialized, encryptionSecret);
              operations.push({
                updateOne: {
                  filter: { connectionId, keyType: type, keyId: String(keyId) },
                  update: { $set: { encryptedValue } },
                  upsert: true,
                },
              });
            }
          }
        }

        if (operations.length > 0) {
          await tenantModels.WhatsAppAuthKey.bulkWrite(operations);
        }
    }),
  };

  const keys = makeCacheableSignalKeyStore(baseKeys);

  const saveCreds = async () => enqueueAuthWrite(async () => {
      const serialized = JSON.stringify(creds, BufferJSON.replacer);
      const encryptedCreds = encryptSecret(serialized, encryptionSecret);
      await tenantModels.WhatsAppAuthState.updateOne(
        { connectionId },
        { $set: { encryptedCreds } },
        { upsert: true }
      );
    });

  return {
    state: {
      creds,
      keys,
    },
    saveCreds,
  };
}

/**
 * Acquire or refresh distributed MongoDB lease for this connection
 */
async function acquireLease(tenantModels, connectionId) {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + LEASE_DURATION_MS);

  const doc = await tenantModels.WhatsAppConnection.findOneAndUpdate(
    {
      _id: connectionId,
      $or: [
        { leaseOwner: INSTANCE_ID },
        { leaseUntil: { $lt: now } },
        { leaseOwner: "" },
        { leaseOwner: null },
      ],
    },
    {
      $set: {
        leaseOwner: INSTANCE_ID,
        leaseUntil: leaseUntil,
      },
    },
    { returnDocument: 'after' }
  );

  return Boolean(doc);
}

/**
 * Release distributed MongoDB lease on shutdown or disconnect
 */
async function releaseLease(tenantModels, connectionId) {
  try {
    await tenantModels.WhatsAppConnection.updateOne(
      { _id: connectionId, leaseOwner: INSTANCE_ID },
      { $set: { leaseOwner: "", leaseUntil: null } }
    );
  } catch (err) {
    console.error(`[WA Lease] Failed to release lease for ${connectionId}:`, err.message);
  }
}

/**
 * Start heartbeat timer to maintain distributed lease
 */
function startHeartbeat(worker, tenantModels, connectionId) {
  if (worker.heartbeatTimer) clearInterval(worker.heartbeatTimer);

  worker.heartbeatTimer = setInterval(async () => {
    try {
      const now = new Date();
      const renewed = await tenantModels.WhatsAppConnection.findOneAndUpdate(
        { _id: connectionId, leaseOwner: INSTANCE_ID },
        { $set: { leaseUntil: new Date(now.getTime() + LEASE_DURATION_MS) } }
      );

      if (!renewed) {
        console.warn(`[WA Lease] Lost lease for ${connectionId}, shutting down local worker`);
        cleanupWorker(connectionId);
      }
    } catch (err) {
      console.error(`[WA Lease] Heartbeat error for ${connectionId}:`, err.message);
    }
  }, LEASE_HEARTBEAT_MS);
}

/**
 * Clean up local worker state and timers
 */
function cleanupWorker(connectionId) {
  const workerKey = connectionId.toString();
  const worker = activeWorkers.get(workerKey);
  if (!worker) return;

  if (worker.heartbeatTimer) clearInterval(worker.heartbeatTimer);
  if (worker.reconnectTimer) clearTimeout(worker.reconnectTimer);
  if (worker.socket) {
    try {
      worker.socket.ev.removeAllListeners();
      worker.socket.end(new Error("Worker terminated"));
    } catch {}
  }
  activeWorkers.delete(workerKey);
}

/**
 * Start Baileys connection with database auth, lease ownership, and QR streaming
 */
export async function startConnection({ connectionId, tenantModels, orgId, ownerUserId }) {
  const workerKey = connectionId.toString();

  // Check if active worker is already running and connected
  const existingWorker = activeWorkers.get(workerKey);
  if (existingWorker) {
    const connDoc = await tenantModels.WhatsAppConnection.findById(connectionId);
    if (existingWorker.socket && existingWorker.connected && connDoc?.status === "connected") {
      return { status: "connected", linkedPhone: connDoc.linkedPhone };
    }
    // Remove stale local state before acquiring/refreshing its lease.
    cleanupWorker(connectionId);
  }

  // Attempt to acquire distributed lease
  const leaseAcquired = await acquireLease(tenantModels, connectionId);
  if (!leaseAcquired) {
    throw new Error("Connection is currently owned by another active worker process. Please try again shortly.");
  }

  await tenantModels.WhatsAppConnection.updateOne(
    { _id: connectionId },
    { $set: { status: "initializing", requiresNewQR: false } }
  );

  emitToOrg(orgId, "whatsapp:connection_status", {
    connectionId,
    status: "initializing",
  });

  const worker = {
    socket: null,
    connected: false,
    qr: null,
    qrExpiresAt: null,
    heartbeatTimer: null,
    reconnectTimer: null,
    stoppedIntentionally: false,
    orgId,
    ownerUserId: ownerUserId?.toString() || "",
    tenantModels,
  };
  activeWorkers.set(workerKey, worker);
  startHeartbeat(worker, tenantModels, connectionId);

  let state;
  let saveCreds;
  let socket;
  try {
    ({ state, saveCreds } = await buildDBAuthState(tenantModels, connectionId));

    // Initialize Baileys socket with history sync explicitly disabled.
    socket = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: ["Conversly AI", "Chrome", "1.0.0"],
      syncFullHistory: false,
      markOnlineOnConnect: true,
      keepAliveIntervalMs: 20000,
      connectTimeoutMs: 60000,
    });
  } catch (err) {
    cleanupWorker(connectionId);
    await releaseLease(tenantModels, connectionId);
    await tenantModels.WhatsAppConnection.updateOne(
      { _id: connectionId },
      { $set: { status: "failed", disconnectedAt: new Date(), lastDisconnectReason: err.message || "Failed to initialize WhatsApp socket" } }
    );
    emitToOrg(orgId, "whatsapp:connection_status", { connectionId, status: "failed", reason: err.message || "Failed to initialize WhatsApp socket" });
    throw err;
  }

  worker.socket = socket;

  // Persist auth credentials on update
  socket.ev.on("creds.update", () => {
    saveCreds().catch((err) => {
      console.error(`[WA Auth] Failed to persist credentials for ${connectionId}:`, err.message);
    });
  });

  // Connection lifecycle handler
  socket.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Handle QR generation event
    if (qr) {
      const expiresAt = new Date(Date.now() + 50000); // QR is valid for ~50s
      worker.qr = qr;
      worker.qrExpiresAt = expiresAt;

      await tenantModels.WhatsAppConnection.updateOne(
        { _id: connectionId },
        {
          $set: {
            status: "qr_pending",
            requiresNewQR: false,
            qrExpiresAt: expiresAt,
          },
        }
      );

      emitToOrg(orgId, "whatsapp:connection_status", {
        connectionId,
        status: "qr_pending",
        qrExpiresAt: expiresAt,
      });

      let qrDataUrl = null;
      try {
        qrDataUrl = await QRCode.toDataURL(qr);
      } catch (err) {
        console.error("[WA Manager] Error generating QR data URL:", err.message);
      }

      emitToUser(worker.ownerUserId, "whatsapp:qr_updated", {
        connectionId,
        qrDataUrl,
        expiresAt,
      });
    }

    if (connection === "connecting") {
      await tenantModels.WhatsAppConnection.updateOne(
        { _id: connectionId },
        { $set: { status: "connecting", qrExpiresAt: worker.qrExpiresAt || null } }
      );
      emitToOrg(orgId, "whatsapp:connection_status", {
        connectionId,
        status: "connecting",
      });
    }

    // Handle connected (open)
    if (connection === "open") {
      worker.connected = true;
      worker.qr = null;
      worker.qrExpiresAt = null;

      const user = socket.user;
      const linkedPhone = user?.id ? user.id.split(":")[0].replace(/[^0-9]/g, "") : "";
      const linkedName = user?.name || "";

      await tenantModels.WhatsAppConnection.updateOne(
        { _id: connectionId },
        {
          $set: {
            status: "connected",
            linkedPhone,
            phoneNumber: linkedPhone,
            linkedName,
            connectedAt: new Date(),
            disconnectedAt: null,
            lastSeen: new Date(),
            lastDisconnectReason: "",
            requiresNewQR: false,
            qrExpiresAt: null,
            reconnectAttempts: 0,
          },
        }
      );

      emitToOrg(orgId, "whatsapp:connection_status", {
        connectionId,
        status: "connected",
        linkedPhone,
        linkedName,
        connectedAt: new Date(),
      });
      console.log(`[WA Manager] Connection ${connectionId} OPEN. Linked to +${linkedPhone} (${linkedName})`);
    }

    // Handle disconnect (close)
    if (connection === "close") {
      worker.connected = false;
      worker.qr = null;
      worker.qrExpiresAt = null;

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      const isReplaced = statusCode === DisconnectReason.connectionReplaced;
      const isQrTimeout = statusCode === 408;
      const isRestartRequired = statusCode === DisconnectReason.restartRequired;

      console.warn(`[WA Manager] Connection ${connectionId} CLOSED. Code: ${statusCode}, Intentionally stopped: ${worker.stoppedIntentionally}`);

      if (worker.stoppedIntentionally) {
        await tenantModels.WhatsAppConnection.updateOne(
          { _id: connectionId },
          {
            $set: {
              status: "disconnected",
              disconnectedAt: new Date(),
              lastDisconnectReason: "Manually disconnected by user",
              qrExpiresAt: null,
            },
          }
        );
        emitToOrg(orgId, "whatsapp:connection_status", {
          connectionId,
          status: "disconnected",
          reason: "Manually disconnected",
        });
        await releaseLease(tenantModels, connectionId);
        cleanupWorker(connectionId);
        return;
      }

      if (isLoggedOut) {
        await tenantModels.WhatsAppConnection.updateOne(
          { _id: connectionId },
          {
            $set: {
              status: "logged_out",
              requiresNewQR: true,
              disconnectedAt: new Date(),
              lastDisconnectReason: "Logged out from phone device",
              qrExpiresAt: null,
            },
          }
        );

        // Wipe encrypted auth state since credentials have been invalidated
        await tenantModels.WhatsAppAuthState.deleteOne({ connectionId });
        await tenantModels.WhatsAppAuthKey.deleteMany({ connectionId });

        emitToOrg(orgId, "whatsapp:connection_status", {
          connectionId,
          status: "logged_out",
          requiresNewQR: true,
          reason: "Device session revoked or unlinked from WhatsApp",
        });

        await releaseLease(tenantModels, connectionId);
        cleanupWorker(connectionId);
        return;
      }

      if (isReplaced) {
        await tenantModels.WhatsAppConnection.updateOne(
          { _id: connectionId },
          {
            $set: {
              status: "disconnected",
              disconnectedAt: new Date(),
              lastDisconnectReason: "Connection replaced by another active session",
              qrExpiresAt: null,
            },
          }
        );
        emitToOrg(orgId, "whatsapp:connection_status", {
          connectionId,
          status: "disconnected",
          reason: "Connection replaced elsewhere",
        });
        await releaseLease(tenantModels, connectionId);
        cleanupWorker(connectionId);
        return;
      }

      // A QR that was never scanned expires normally. Stop and wait for the
      // user to request a fresh QR instead of reconnecting forever.
      if (isQrTimeout && !state.creds.registered) {
        await tenantModels.WhatsAppConnection.updateOne(
          { _id: connectionId },
          { $set: { status: "disconnected", disconnectedAt: new Date(), lastDisconnectReason: "QR code expired; request a new QR code", requiresNewQR: true, qrExpiresAt: null } }
        );
        emitToOrg(orgId, "whatsapp:connection_status", { connectionId, status: "disconnected", requiresNewQR: true, reason: "QR code expired. Start the connection again to generate a new QR code." });
        await releaseLease(tenantModels, connectionId);
        cleanupWorker(connectionId);
        return;
      }

      // Transient failure -> Exponential backoff reconnect
      const connDoc = await tenantModels.WhatsAppConnection.findById(connectionId);
      const attempts = (connDoc?.reconnectAttempts || 0) + 1;
      const MAX_RECONNECT_ATTEMPTS = 8;

      if (attempts > MAX_RECONNECT_ATTEMPTS) {
        await tenantModels.WhatsAppConnection.updateOne(
          { _id: connectionId },
          {
            $set: {
              status: "failed",
              disconnectedAt: new Date(),
              lastDisconnectReason: "Max reconnect attempts exceeded",
              qrExpiresAt: null,
            },
          }
        );
        emitToOrg(orgId, "whatsapp:connection_status", {
          connectionId,
          status: "failed",
          reason: "Max reconnect attempts exceeded",
        });
        await releaseLease(tenantModels, connectionId);
        cleanupWorker(connectionId);
        return;
      }

      const delay = isRestartRequired ? 250 : Math.min(2000 * Math.pow(2, attempts - 1), 60000);
      await tenantModels.WhatsAppConnection.updateOne(
        { _id: connectionId },
        {
          $set: {
            status: "reconnecting",
            reconnectAttempts: attempts,
            lastDisconnectReason: lastDisconnect?.error?.message || "Network connection dropped",
            qrExpiresAt: null,
          },
        }
      );

      emitToOrg(orgId, "whatsapp:connection_status", {
        connectionId,
        status: "reconnecting",
        reconnectAttempts: attempts,
        nextAttemptInMs: delay,
      });

      worker.reconnectTimer = setTimeout(() => {
        startConnection({ connectionId, tenantModels, orgId, ownerUserId: worker.ownerUserId }).catch((err) => {
          console.error(`[WA Manager] Reconnect error for ${connectionId}:`, err.message);
        });
      }, delay);
    }
  });

  // Wire inbound message event
  socket.ev.on("messages.upsert", (event) => {
    handleMessagesUpsert({
      messages: event.messages,
      type: event.type,
      connectionId,
      tenantModels,
      orgId,
    }).catch((err) => {
      console.error(`[WA Manager] messages.upsert processing error for ${connectionId}:`, err);
    });
  });

  // Wire reaction event
  socket.ev.on("messages.reaction", (reactions) => {
    handleReactionEvent({
      reactions,
      connectionId,
      tenantModels,
      orgId,
    }).catch((err) => {
      console.error(`[WA Manager] reaction processing error for ${connectionId}:`, err);
    });
  });

  socket.ev.on("messages.update", (updates) => {
    handleMessageUpdateEvent({ updates, connectionId, tenantModels, orgId }).catch((err) => {
      console.error(`[WA Manager] message update processing error for ${connectionId}:`, err);
    });
  });

  // Wire message delete event
  socket.ev.on("messages.delete", (data) => {
    handleMessageDeleteEvent({
      data,
      connectionId,
      tenantModels,
      orgId,
    }).catch((err) => {
      console.error(`[WA Manager] delete processing error for ${connectionId}:`, err);
    });
  });

  return { status: "initializing" };
}

/**
 * Disconnect a WhatsApp connection intentionally
 */
export async function disconnectConnection({ connectionId, tenantModels, orgId }) {
  const workerKey = connectionId.toString();
  const worker = activeWorkers.get(workerKey);

  if (worker) {
    worker.stoppedIntentionally = true;
    if (worker.heartbeatTimer) clearInterval(worker.heartbeatTimer);
    if (worker.reconnectTimer) clearTimeout(worker.reconnectTimer);
    if (worker.socket) {
      try {
        worker.socket.end(undefined);
      } catch {}
    }
    activeWorkers.delete(workerKey);
  }

  await releaseLease(tenantModels, connectionId);

  await tenantModels.WhatsAppConnection.updateOne(
    { _id: connectionId },
    {
      $set: {
        status: "disconnected",
        disconnectedAt: new Date(),
        lastDisconnectReason: "Manually disconnected by user",
        qrExpiresAt: null,
      },
    }
  );

  emitToOrg(orgId, "whatsapp:connection_status", {
    connectionId,
    status: "disconnected",
    reason: "Manually disconnected",
  });

  return { success: true };
}

/**
 * Delete connection slot and wipe associated auth state records
 */
export async function removeConnection({ connectionId, tenantModels, orgId }) {
  await disconnectConnection({ connectionId, tenantModels, orgId });

  // Delete credentials and Signal key store records
  await tenantModels.WhatsAppAuthState.deleteOne({ connectionId });
  await tenantModels.WhatsAppAuthKey.deleteMany({ connectionId });
  await tenantModels.WhatsAppConnection.deleteOne({ _id: connectionId });

  return { success: true };
}

/**
 * Get active worker status and current valid QR if available
 */
export function getWorkerStatus(connectionId) {
  const worker = activeWorkers.get(connectionId.toString());
  if (!worker) return null;

  const now = new Date();
  const isQrValid = worker.qr && worker.qrExpiresAt && worker.qrExpiresAt > now;

  return {
    hasSocket: Boolean(worker.socket),
    qr: isQrValid ? worker.qr : null,
    qrExpiresAt: isQrValid ? worker.qrExpiresAt : null,
  };
}

/**
 * Get active Baileys socket instance for sending outbound messages
 */
export function getActiveSocket(connectionId) {
  const worker = activeWorkers.get(connectionId.toString());
  return worker?.connected ? worker.socket : null;
}

/**
 * Restore active WhatsApp connections across all tenant organizations on server startup
 */
export async function restoreActiveConnections() {
  try {
    if (!isDbConnected()) {
      console.log("[WA Manager] MongoDB is not connected. Skipping connection restoration on boot.");
      return;
    }
    const orgs = await Organization.find({});
    console.log(`[WA Manager] Checking connections across ${orgs.length} organization(s)...`);

    for (const org of orgs) {
      try {
        const tenantDb = getTenantDB(org.tenantDbName);
        const tenantModels = getTenantModels(tenantDb);

        // Check subscription entitlements
        const subscription = await Subscription.findOne({ organizationId: org._id });
        const entitlements = subscription ? computeEntitlements(subscription) : null;

        if (entitlements && entitlements.isExpired) {
          console.log(`[WA Manager] Skipping expired organization: ${org.name}`);
          continue;
        }

        // Find connections that have credentials stored or were connected/connecting
        const connections = await tenantModels.WhatsAppConnection.find({
          status: { $in: ["connected", "connecting", "reconnecting", "qr_pending"] },
        });

        for (const conn of connections) {
          // Check if auth credentials exist
          const hasAuth = await tenantModels.WhatsAppAuthState.findOne({ connectionId: conn._id });
          if (hasAuth && hasAuth.encryptedCreds) {
            console.log(`[WA Manager] Restoring connection ${conn._id} (${conn.displayName}) for org ${org.name}`);
            startConnection({ connectionId: conn._id, tenantModels, orgId: org._id, ownerUserId: org.ownerId }).catch((err) => {
              console.error(`[WA Manager] Failed to restore connection ${conn._id}:`, err.message);
            });
          } else {
            // No credentials exist, set to disconnected
            await tenantModels.WhatsAppConnection.updateOne(
              { _id: conn._id },
              { $set: { status: "disconnected" } }
            );
          }
        }
      } catch (orgErr) {
        console.error(`[WA Manager] Error restoring connections for ${org.name}:`, orgErr.message);
      }
    }
  } catch (err) {
    console.error("[WA Manager] Fatal error in restoreActiveConnections:", err.message);
  }
}

/** Recover connections whose owning process disappeared without a close event. */
export function startWhatsAppWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(async () => {
    if (!isDbConnected()) return;
    try {
      const now = new Date();
      const orgs = await Organization.find({});
      for (const org of orgs) {
        try {
          const tenantModels = getTenantModels(getTenantDB(org.tenantDbName));
          const staleConnections = await tenantModels.WhatsAppConnection.find({
            status: { $in: ["connected", "connecting", "reconnecting"] },
            $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }, { leaseOwner: "" }],
          }).limit(25);
          for (const connection of staleConnections) {
            if (activeWorkers.has(connection._id.toString())) continue;
            const auth = await tenantModels.WhatsAppAuthState.findOne({ connectionId: connection._id });
            if (!auth?.encryptedCreds) continue;
            startConnection({ connectionId: connection._id, tenantModels, orgId: org._id, ownerUserId: org.ownerId })
              .catch((err) => console.warn(`[WA Watchdog] Recovery deferred for ${connection._id}:`, err.message));
          }
        } catch (orgErr) {
          console.warn(`[WA Watchdog] Scan failed for org ${org._id}:`, orgErr.message);
        }
      }
    } catch (err) {
      console.error("[WA Watchdog] Scan failed:", err.message);
    }
  }, 30000);
  watchdogTimer.unref?.();
}
