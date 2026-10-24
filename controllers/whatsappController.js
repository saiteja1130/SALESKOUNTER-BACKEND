import {
  startConnection,
  disconnectConnection,
  removeConnection,
  getWorkerStatus,
} from "../helpers/whatsappManager.js";
import { assertCanAddConnection } from "../helpers/entitlements.js";
import QRCode from "qrcode";

/**
 * List all WhatsApp connections for the organization
 */
export async function listConnections(req, res) {
  try {
    const connections = await req.tenantModels.WhatsAppConnection.find({})
      .sort({ createdAt: -1 })
      .lean();

    // Attach active worker status & in-memory QR info
    const enriched = connections.map((conn) => {
      const worker = getWorkerStatus(conn._id);
      return {
        ...conn,
        activeWorker: worker ? { hasSocket: worker.hasSocket, hasQr: Boolean(worker.qr) } : null,
      };
    });

    res.json({
      success: true,
      connections: enriched,
      entitlements: req.entitlements,
    });
  } catch (err) {
    console.error("[WhatsApp Controller] listConnections error:", err);
    res.status(500).json({ success: false, message: err.message || "Failed to load connections" });
  }
}

/**
 * Create a new connection slot (enforces plan entitlements)
 */
export async function createConnection(req, res) {
  try {
    // Assert subscription limit
    await assertCanAddConnection(req.tenantModels, req.entitlements);

    const displayName = (req.body.displayName || "WhatsApp Business Line").trim();

    const connection = await req.tenantModels.WhatsAppConnection.create({
      displayName,
      status: "disconnected",
      phoneNumber: "",
      linkedPhone: "",
    });

    res.status(201).json({
      success: true,
      connection,
    });
  } catch (err) {
    console.error("[WhatsApp Controller] createConnection error:", err);
    res.status(400).json({ success: false, message: err.message || "Failed to create connection" });
  }
}

/**
 * Get status and active QR for a specific connection
 */
export async function getConnectionStatus(req, res) {
  try {
    const { id } = req.params;
    const connection = await req.tenantModels.WhatsAppConnection.findById(id);

    if (!connection) {
      return res.status(404).json({ success: false, message: "Connection not found" });
    }

    const workerStatus = getWorkerStatus(id);
    let qrDataUrl = null;
    if (workerStatus?.qr) {
      try {
        qrDataUrl = await QRCode.toDataURL(workerStatus.qr);
      } catch (err) {
        console.error("QR render error:", err);
      }
    }

    res.json({
      success: true,
      connection,
      qr: workerStatus?.qr || null,
      qrDataUrl,
      qrExpiresAt: workerStatus?.qrExpiresAt || null,
    });
  } catch (err) {
    console.error("[WhatsApp Controller] getConnectionStatus error:", err);
    res.status(500).json({ success: false, message: err.message || "Failed to fetch status" });
  }
}

/**
 * Start or resume QR login lifecycle for a connection slot
 */
export async function startConnectionEndpoint(req, res) {
  try {
    const { id } = req.params;
    const connection = await req.tenantModels.WhatsAppConnection.findById(id);

    if (!connection) {
      return res.status(404).json({ success: false, message: "Connection not found" });
    }

    // Start Baileys connection asynchronously
    startConnection({
      connectionId: connection._id,
      tenantModels: req.tenantModels,
      orgId: req.organization._id,
    }).catch((err) => {
      console.error(`[WhatsApp Controller] Async start error for ${id}:`, err);
    });

    res.json({
      success: true,
      message: "WhatsApp connection initializing. Scan QR code when displayed.",
      status: "initializing",
    });
  } catch (err) {
    console.error("[WhatsApp Controller] startConnection error:", err);
    res.status(500).json({ success: false, message: err.message || "Failed to start connection" });
  }
}

/**
 * Manually disconnect a WhatsApp connection
 */
export async function disconnectConnectionEndpoint(req, res) {
  try {
    const { id } = req.params;
    const connection = await req.tenantModels.WhatsAppConnection.findById(id);

    if (!connection) {
      return res.status(404).json({ success: false, message: "Connection not found" });
    }

    await disconnectConnection({
      connectionId: connection._id,
      tenantModels: req.tenantModels,
      orgId: req.organization._id,
    });

    res.json({
      success: true,
      message: "WhatsApp connection disconnected successfully",
    });
  } catch (err) {
    console.error("[WhatsApp Controller] disconnectConnection error:", err);
    res.status(500).json({ success: false, message: err.message || "Failed to disconnect" });
  }
}

/**
 * Delete connection slot and wipe all stored auth credentials
 */
export async function removeConnectionEndpoint(req, res) {
  try {
    const { id } = req.params;
    const connection = await req.tenantModels.WhatsAppConnection.findById(id);

    if (!connection) {
      return res.status(404).json({ success: false, message: "Connection not found" });
    }

    await removeConnection({
      connectionId: connection._id,
      tenantModels: req.tenantModels,
      orgId: req.organization._id,
    });

    res.json({
      success: true,
      message: "WhatsApp connection slot removed and auth credentials wiped",
    });
  } catch (err) {
    console.error("[WhatsApp Controller] removeConnection error:", err);
    res.status(500).json({ success: false, message: err.message || "Failed to remove connection" });
  }
}
