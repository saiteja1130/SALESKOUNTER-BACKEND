import crypto from "node:crypto";
import { getActiveSocket } from "./whatsappManager.js";
import { emitToOrg } from "./whatsappSocketGateway.js";

const INSTANCE_ID = `queue_${process.pid}_${crypto.randomBytes(4).toString("hex")}`;
const MAX_ATTEMPTS = 5;

/**
 * Check if current time falls within tenant quiet hours window
 */
function isWithinQuietHours(quietHours) {
  if (!quietHours || !quietHours.enabled) return false;

  const now = new Date();
  const timeZone = quietHours.timezone || "Asia/Kolkata";
  const nowStr = now.toLocaleTimeString("en-GB", { timeZone, hour12: false, hour: "2-digit", minute: "2-digit" });

  const start = quietHours.quietStart || "21:00";
  const end = quietHours.quietEnd || "08:00";

  if (start <= end) {
    return nowStr >= start && nowStr < end;
  } else {
    // Overnight window (e.g. 21:00 to 08:00)
    return nowStr >= start || nowStr < end;
  }
}

/**
 * Calculate next release time when quiet hours window ends
 */
function getMorningReleaseDate(quietHours) {
  const now = new Date();
  const releaseTime = quietHours?.morningReleaseTime || "08:15";
  const [hours, minutes] = releaseTime.split(":").map(Number);

  const target = new Date(now);
  target.setHours(hours, minutes, 0, 0);

  if (target <= now) {
    target.setDate(target.getDate() + 1);
  }
  return target;
}

/**
 * Enqueue an outbound WhatsApp message job into the durable MongoDB queue
 */
export async function enqueueOutboundMessage({
  leadId,
  connectionId,
  body,
  idempotencyKey,
  source = "manual",
  tenantModels,
  orgId,
}) {
  if (!leadId || !body || !tenantModels) {
    throw new Error("Missing required parameters for enqueueOutboundMessage");
  }

  // Idempotency check: if key provided, check if already exists
  if (idempotencyKey) {
    const existing = await tenantModels.WhatsAppMessage.findOne({
      connectionId,
      idempotencyKey,
    });
    if (existing) {
      console.log(`[Outbound Queue] Skipping duplicate message with idempotencyKey: ${idempotencyKey}`);
      return existing;
    }
  }

  const message = await tenantModels.WhatsAppMessage.create({
    leadId,
    connectionId,
    direction: "outbound",
    body,
    sendStatus: "queued",
    source,
    idempotencyKey,
    nextAttemptAt: new Date(),
  });

  emitToOrg(orgId, "whatsapp:message_updated", {
    messageId: message._id,
    leadId,
    sendStatus: "queued",
    body,
  });

  // Trigger non-blocking queue drain
  drainOutboundQueue({ tenantModels, orgId }).catch((err) => {
    console.error("[Outbound Queue] Drain error:", err.message);
  });

  return message;
}

/**
 * Drain pending outbound messages using atomic distributed MongoDB leases
 */
export async function drainOutboundQueue({ tenantModels, orgId }) {
  const now = new Date();

  // Find candidate jobs ready to send
  const candidateJobs = await tenantModels.WhatsAppMessage.find({
    direction: "outbound",
    sendStatus: { $in: ["queued", "retryable"] },
    $or: [{ nextAttemptAt: { $lte: now } }, { nextAttemptAt: null }],
    $or: [{ leaseUntil: { $lt: now } }, { leaseOwner: "" }, { leaseOwner: null }],
  })
    .sort({ createdAt: 1 })
    .limit(10);

  if (!candidateJobs || candidateJobs.length === 0) return;

  for (const job of candidateJobs) {
    // Atomically claim lease for this job
    const claimedJob = await tenantModels.WhatsAppMessage.findOneAndUpdate(
      {
        _id: job._id,
        sendStatus: { $in: ["queued", "retryable"] },
        $or: [{ leaseUntil: { $lt: now } }, { leaseOwner: "" }, { leaseOwner: null }],
      },
      {
        $set: {
          leaseOwner: INSTANCE_ID,
          leaseUntil: new Date(Date.now() + 30000),
          sendStatus: "sending",
        },
      },
      { new: true }
    );

    if (!claimedJob) continue;

    try {
      await processOutboundJob({ job: claimedJob, tenantModels, orgId });
    } catch (err) {
      console.error(`[Outbound Queue] Error processing job ${claimedJob._id}:`, err.message);
    }
  }
}

/**
 * Process a single outbound message job
 */
async function processOutboundJob({ job, tenantModels, orgId }) {
  // 1. Resolve lead
  const lead = await tenantModels.Lead.findById(job.leadId);
  if (!lead) {
    await tenantModels.WhatsAppMessage.updateOne(
      { _id: job._id },
      {
        $set: {
          sendStatus: "failed",
          lastSendError: "Lead document not found",
          leaseOwner: "",
          leaseUntil: null,
        },
      }
    );
    return;
  }

  // 2. Opt-out safety check
  if (lead.whatsappOptOutAt) {
    console.log(`[Outbound Queue] Lead ${lead._id} is opted-out. Suppressing send.`);
    await tenantModels.WhatsAppMessage.updateOne(
      { _id: job._id },
      {
        $set: {
          sendStatus: "suppressed",
          lastSendError: `Recipient opted out (${lead.whatsappOptOutReason || "Suppressed"})`,
          leaseOwner: "",
          leaseUntil: null,
        },
      }
    );
    emitToOrg(orgId, "whatsapp:message_updated", {
      messageId: job._id,
      leadId: lead._id,
      sendStatus: "suppressed",
    });
    return;
  }

  // 3. Quiet hours check
  const quietHoursDoc = await tenantModels.QuietHours.findOne();
  if (isWithinQuietHours(quietHoursDoc)) {
    const nextRelease = getMorningReleaseDate(quietHoursDoc);
    console.log(`[Outbound Queue] Quiet hours active. Rescheduling job ${job._id} to ${nextRelease.toISOString()}`);
    await tenantModels.WhatsAppMessage.updateOne(
      { _id: job._id },
      {
        $set: {
          sendStatus: "queued",
          nextAttemptAt: nextRelease,
          leaseOwner: "",
          leaseUntil: null,
        },
      }
    );
    return;
  }

  // 4. Resolve connection and active socket
  let connectionId = job.connectionId || lead.whatsappConnectionId;
  if (!connectionId) {
    const defaultConn = await tenantModels.WhatsAppConnection.findOne({ status: "connected" });
    if (defaultConn) {
      connectionId = defaultConn._id;
    }
  }

  if (!connectionId) {
    await tenantModels.WhatsAppMessage.updateOne(
      { _id: job._id },
      {
        $set: {
          sendStatus: "retryable",
          lastSendError: "No WhatsApp connection assigned",
          nextAttemptAt: new Date(Date.now() + 30000),
          leaseOwner: "",
          leaseUntil: null,
        },
      }
    );
    return;
  }

  const socket = getActiveSocket(connectionId);
  if (!socket) {
    const attempts = (job.sendAttempts || 0) + 1;
    await tenantModels.WhatsAppMessage.updateOne(
      { _id: job._id },
      {
        $set: {
          sendStatus: attempts >= MAX_ATTEMPTS ? "failed" : "retryable",
          sendAttempts: attempts,
          lastSendError: "WhatsApp socket is not connected or worker is offline",
          nextAttemptAt: new Date(Date.now() + 20000),
          leaseOwner: "",
          leaseUntil: null,
        },
      }
    );
    return;
  }

  // 5. Target JID formatting
  const rawDigits = (lead.phone || "").replace(/[^0-9]/g, "");
  if (!rawDigits || rawDigits.length < 8) {
    await tenantModels.WhatsAppMessage.updateOne(
      { _id: job._id },
      {
        $set: {
          sendStatus: "failed",
          lastSendError: `Invalid recipient phone number: ${lead.phone}`,
          leaseOwner: "",
          leaseUntil: null,
        },
      }
    );
    return;
  }

  const targetJid = `${rawDigits}@s.whatsapp.net`;

  // 6. Send message via Baileys socket
  try {
    const result = await socket.sendMessage(targetJid, { text: job.body });
    const waMsgId = result?.key?.id || "";

    await tenantModels.WhatsAppMessage.updateOne(
      { _id: job._id },
      {
        $set: {
          sendStatus: "sent",
          whatsappMessageId: waMsgId,
          sentAt: new Date(),
          leaseOwner: "",
          leaseUntil: null,
          lastSendError: "",
        },
      }
    );

    // Update lead last contact
    await tenantModels.Lead.updateOne(
      { _id: lead._id },
      { $set: { lastContactAt: new Date() } }
    );

    emitToOrg(orgId, "whatsapp:message_updated", {
      messageId: job._id,
      leadId: lead._id,
      whatsappMessageId: waMsgId,
      sendStatus: "sent",
      sentAt: new Date(),
    });

    console.log(`[Outbound Queue] Message sent successfully to ${targetJid} (Msg ID: ${waMsgId})`);
  } catch (sendErr) {
    console.error(`[Outbound Queue] Error sending message to ${targetJid}:`, sendErr.message);
    const attempts = (job.sendAttempts || 0) + 1;
    const isPermanent = sendErr?.output?.statusCode === 403 || sendErr?.message?.includes("Forbidden");

    await tenantModels.WhatsAppMessage.updateOne(
      { _id: job._id },
      {
        $set: {
          sendStatus: isPermanent || attempts >= MAX_ATTEMPTS ? "failed" : "retryable",
          sendAttempts: attempts,
          lastSendError: sendErr.message || "Failed to dispatch message",
          nextAttemptAt: new Date(Date.now() + Math.min(5000 * Math.pow(2, attempts), 60000)),
          leaseOwner: "",
          leaseUntil: null,
        },
      }
    );

    emitToOrg(orgId, "whatsapp:message_updated", {
      messageId: job._id,
      leadId: lead._id,
      sendStatus: isPermanent || attempts >= MAX_ATTEMPTS ? "failed" : "retryable",
      error: sendErr.message,
    });
  }
}
