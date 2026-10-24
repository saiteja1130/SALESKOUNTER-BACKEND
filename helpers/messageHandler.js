import { getTodayDateIST } from "./crypto.js";
import { tryConsumeDailyLeadQuota } from "./entitlements.js";
import { Subscription } from "../models/platform/Subscription.js";
import { Organization } from "../models/platform/Organization.js";
import { computeEntitlements } from "./entitlements.js";
import { emitToOrg } from "./whatsappSocketGateway.js";
import { enqueueOutboundMessage } from "./outboundQueue.js";
import { testGeminiConversation } from "./geminiService.js";

// Opt-out detection regex
const OPT_OUT_REGEX = /^(stop|unsubscribe|cancel|quit|optout|opt out|end)$/i;

/**
 * Extract clean plain text from various Baileys message structures
 */
function extractMessageText(msg) {
  const message = msg?.message;
  if (!message) return "";

  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  if (message.documentMessage?.caption) return message.documentMessage.caption;

  // Unpack ephemeral and view-once wrappers
  if (message.ephemeralMessage?.message) {
    return extractMessageText({ message: message.ephemeralMessage.message });
  }
  if (message.viewOnceMessage?.message) {
    return extractMessageText({ message: message.viewOnceMessage.message });
  }
  if (message.viewOnceMessageV2?.message) {
    return extractMessageText({ message: message.viewOnceMessageV2.message });
  }

  return "";
}

/**
 * Check if message is ephemeral/disappearing and return expiration seconds
 */
function getEphemeralExpiration(msg) {
  const message = msg?.message;
  if (!message) return 0;

  if (message.ephemeralMessage) {
    return message.ephemeralMessage?.message?.extendedTextMessage?.contextInfo?.expiration || 604800; // default 7 days
  }
  if (msg.messageContextInfo?.expiration) {
    return msg.messageContextInfo.expiration;
  }
  return 0;
}

/**
 * Normalize WhatsApp JID to E.164 phone number string
 */
function normalizeJidToPhone(jid = "") {
  const cleaned = jid.split("@")[0].replace(/[^0-9]/g, "");
  if (!cleaned) return "";
  return `+${cleaned}`;
}

/**
 * Concurrency limiter pool helper (5 concurrent messages max)
 */
function createConcurrencyPool(concurrency = 5) {
  let active = 0;
  const queue = [];

  const next = () => {
    active--;
    if (queue.length > 0) {
      const task = queue.shift();
      active++;
      task();
    }
  };

  return (fn) =>
    new Promise((resolve, reject) => {
      const execute = async () => {
        try {
          const res = await fn();
          resolve(res);
        } catch (err) {
          reject(err);
        } finally {
          next();
        }
      };

      if (active < concurrency) {
        active++;
        execute();
      } else {
        queue.push(execute);
      }
    });
}

const pool = createConcurrencyPool(5);

/**
 * Main Baileys messages.upsert handler
 */
export async function handleMessagesUpsert({ messages, type, connectionId, tenantModels, orgId }) {
  // Ignore historical appends — history sync is disabled on first connect
  if (type !== "notify") return;
  if (!Array.isArray(messages) || messages.length === 0) return;

  await Promise.all(
    messages.map((msg) =>
      pool(() => processSingleMessage({ msg, connectionId, tenantModels, orgId }))
    )
  );
}

/**
 * Process a single inbound or outbound WhatsApp message
 */
async function processSingleMessage({ msg, connectionId, tenantModels, orgId }) {
  const jid = msg?.key?.remoteJid || "";

  // 1. Filter out groups, broadcasts, status, and newsletters
  if (
    !jid ||
    jid.endsWith("@g.us") ||
    jid.includes("@broadcast") ||
    jid.endsWith("@newsletter")
  ) {
    return;
  }

  const rawText = extractMessageText(msg).trim();
  const normalizedPhone = normalizeJidToPhone(jid);
  const waMessageId = msg.key.id;
  const isFromMe = Boolean(msg.key.fromMe);

  // 2. Handle FromMe (messages sent by the business owner/user from phone)
  if (isFromMe) {
    if (!normalizedPhone || !rawText) return;
    const existingLead = await tenantModels.Lead.findOne({ phone: normalizedPhone });
    if (existingLead) {
      await tenantModels.WhatsAppMessage.create({
        leadId: existingLead._id,
        connectionId,
        direction: "outbound",
        body: rawText,
        whatsappMessageId: waMessageId,
        sendStatus: "sent",
        source: "manual",
        sentAt: new Date(),
      });
      emitToOrg(orgId, "whatsapp:message_updated", {
        leadId: existingLead._id,
        direction: "outbound",
        body: rawText,
        source: "manual",
      });
    }
    return;
  }

  // 3. Inbound message: Deduplicate with WhatsAppInboxEvent
  let inboxEvent;
  const ephemeralExpiry = getEphemeralExpiration(msg);

  try {
    inboxEvent = await tenantModels.WhatsAppInboxEvent.create({
      connectionId,
      whatsappMessageId: waMessageId,
      remoteJid: jid,
      fromPhone: normalizedPhone,
      messageType: rawText ? "text" : "other",
      rawText: rawText || "[Media or attachment]",
      processingStatus: "pending",
      isEphemeral: Boolean(ephemeralExpiry),
      ephemeralExpiry: ephemeralExpiry || 0,
      receivedAt: new Date(),
    });
  } catch (err) {
    if (err.code === 11000) {
      // Already recorded and processed
      return;
    }
    throw err;
  }

  // 4. Opt-out keyword detection
  const isOptOutKeyword = OPT_OUT_REGEX.test(rawText);

  // 5. Resolve or create CRM lead
  let lead = await tenantModels.Lead.findOne({ phone: normalizedPhone });

  if (lead) {
    await tenantModels.Lead.updateOne(
      { _id: lead._id },
      { $set: { lastContactAt: new Date() } }
    );
  } else {
    // Lead does not exist yet: verify plan daily lead quota
    const subscription = await Subscription.findOne({ organizationId: orgId });
    const entitlements = computeEntitlements(subscription);

    try {
      await tryConsumeDailyLeadQuota(tenantModels, entitlements);
    } catch (quotaErr) {
      console.warn(`[Message Handler] Lead quota exceeded for org ${orgId}:`, quotaErr.message);
      await tenantModels.WhatsAppInboxEvent.updateOne(
        { _id: inboxEvent._id },
        {
          $set: {
            processingStatus: "quota_blocked",
            errorMessage: quotaErr.message,
          },
        }
      );
      emitToOrg(orgId, "whatsapp:lead_updated", {
        status: "quota_blocked",
        phone: normalizedPhone,
        message: quotaErr.message,
      });
      return;
    }

    // Create new lead in CRM
    lead = await tenantModels.Lead.create({
      name: msg.pushName || "WhatsApp Prospect",
      phone: normalizedPhone,
      source: "WhatsApp Inbound",
      status: "New",
      whatsappConnectionId: connectionId,
      whatsappPhoneNumber: normalizedPhone,
      createdDateIST: getTodayDateIST(),
      aiHandled: true,
      lastContactAt: new Date(),
    });

    emitToOrg(orgId, "whatsapp:lead_updated", {
      leadId: lead._id,
      name: lead.name,
      phone: lead.phone,
      source: lead.source,
      status: lead.status,
    });
  }

  // If customer opted out, mark suppression
  if (isOptOutKeyword) {
    console.log(`[Message Handler] Opt-out keyword detected from ${normalizedPhone}`);
    await tenantModels.Lead.updateOne(
      { _id: lead._id },
      {
        $set: {
          whatsappOptOutAt: new Date(),
          whatsappOptOutReason: `Customer opted out via keyword: "${rawText}"`,
          aiHandled: false,
        },
      }
    );
  }

  // 6. Save CRM WhatsApp Message record
  const crmMessage = await tenantModels.WhatsAppMessage.create({
    leadId: lead._id,
    connectionId,
    direction: "inbound",
    body: rawText || "[Media Message]",
    whatsappMessageId: waMessageId,
    sendStatus: "sent",
    source: "inbound",
    isEphemeral: Boolean(ephemeralExpiry),
    ephemeralExpiry: ephemeralExpiry || 0,
    ephemeralExpiresAt: ephemeralExpiry ? new Date(Date.now() + ephemeralExpiry * 1000) : null,
    sentAt: new Date(),
  });

  // Mark inbox event completed
  await tenantModels.WhatsAppInboxEvent.updateOne(
    { _id: inboxEvent._id },
    {
      $set: {
        processingStatus: "processed",
        leadId: lead._id,
      },
    }
  );

  emitToOrg(orgId, "whatsapp:message_received", {
    messageId: crmMessage._id,
    leadId: lead._id,
    leadName: lead.name,
    phone: normalizedPhone,
    body: rawText,
    isEphemeral: Boolean(ephemeralExpiry),
  });

  // 7. Automated AI Qualification & Response Generation
  if (
    !isOptOutKeyword &&
    lead.aiHandled !== false &&
    !lead.whatsappOptOutAt &&
    rawText.length > 0
  ) {
    try {
      const orgDoc = await Organization.findById(orgId);
      const aiConfigDoc = await tenantModels.AiConfig.findOne({ status: "published" }) || await tenantModels.AiConfig.findOne();

      // Retrieve recent conversation history for context
      const recentMessages = await tenantModels.WhatsAppMessage.find({
        leadId: lead._id,
      })
        .sort({ createdAt: -1 })
        .limit(10);

      const conversationHistory = recentMessages.reverse().map((m) => ({
        sender: m.direction === "inbound" ? "user" : "ai",
        text: m.body,
      }));

      const geminiResult = await testGeminiConversation({
        organization: orgDoc,
        tenantDb: tenantModels.Lead.db,
        config: aiConfigDoc || {},
        messages: conversationHistory,
      });

      if (geminiResult?.responseText) {
        // Enqueue AI response via persistent outbound worker
        await enqueueOutboundMessage({
          leadId: lead._id,
          connectionId,
          body: geminiResult.responseText,
          idempotencyKey: `ai_reply:${waMessageId}`,
          source: "ai",
          tenantModels,
          orgId,
        });

        // If qualification data was extracted, persist to lead
        if (geminiResult.extractedData && Object.keys(geminiResult.extractedData).length > 0) {
          const updates = {};
          for (const [key, val] of Object.entries(geminiResult.extractedData)) {
            updates[`collectedData.${key}`] = val;
          }
          await tenantModels.Lead.updateOne({ _id: lead._id }, { $set: updates });
          emitToOrg(orgId, "whatsapp:lead_updated", {
            leadId: lead._id,
            collectedData: geminiResult.extractedData,
          });
        }
      }
    } catch (aiErr) {
      console.warn(`[Message Handler] AI reply generation skipped for ${lead._id}:`, aiErr.message);
    }
  }
}

/**
 * Handle WhatsApp reaction events
 */
export async function handleReactionEvent({ reactions, connectionId, tenantModels, orgId }) {
  if (!Array.isArray(reactions) || reactions.length === 0) return;

  for (const r of reactions) {
    const targetMsgId = r.key?.id;
    if (!targetMsgId) continue;

    const actor = r.key.participant || r.key.remoteJid;
    const emoji = r.text || "";

    const message = await tenantModels.WhatsAppMessage.findOne({
      whatsappMessageId: targetMsgId,
    });
    if (!message) continue;

    if (!emoji) {
      // Reaction removed
      await tenantModels.WhatsAppMessage.updateOne(
        { _id: message._id, "reactions.actorJid": actor },
        { $set: { "reactions.$.removedAt": new Date() } }
      );
    } else {
      // Upsert reaction
      const existingReaction = message.reactions?.find((rx) => rx.actorJid === actor);
      if (existingReaction) {
        await tenantModels.WhatsAppMessage.updateOne(
          { _id: message._id, "reactions.actorJid": actor },
          { $set: { "reactions.$.emoji": emoji, "reactions.$.removedAt": null } }
        );
      } else {
        await tenantModels.WhatsAppMessage.updateOne(
          { _id: message._id },
          {
            $push: {
              reactions: {
                actorJid: actor,
                emoji,
                addedAt: new Date(),
                removedAt: null,
              },
            },
          }
        );
      }
    }

    emitToOrg(orgId, "whatsapp:reaction", {
      targetMessageId: targetMsgId,
      actor,
      emoji,
    });
  }
}

/**
 * Handle WhatsApp message deletion events (content redaction)
 */
export async function handleMessageDeleteEvent({ data, connectionId, tenantModels, orgId }) {
  const keys = data?.keys || (Array.isArray(data) ? data : [data]);
  if (!keys || keys.length === 0) return;

  for (const k of keys) {
    const msgId = k?.id;
    if (!msgId) continue;

    await tenantModels.WhatsAppMessage.updateOne(
      { whatsappMessageId: msgId },
      { $set: { body: "[Message was deleted by sender]" } }
    );

    await tenantModels.WhatsAppInboxEvent.updateOne(
      { whatsappMessageId: msgId },
      { $set: { rawText: "[Message was deleted]" } }
    );

    emitToOrg(orgId, "whatsapp:message_deleted", {
      whatsappMessageId: msgId,
    });
  }
}
