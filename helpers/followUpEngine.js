import { getTenantModels } from "../models/tenant/schemas.js";
import { Organization } from "../models/platform/Organization.js";
import { Subscription } from "../models/platform/Subscription.js";
import { computeEntitlements } from "./entitlements.js";
import { getTenantDB, isDbConnected } from "../configs/db.js";
import { enqueueOutboundMessage } from "./outboundQueue.js";

/**
 * Follow-up Engine: Cadence Evaluation, Quiet-Hours Windowing, and Atomic Execution
 */

/**
 * Calculates whether a UTC timestamp falls within organization quiet hours
 * and pushes the due time to the morning release window if needed.
 *
 * Example:
 * Quiet window: 21:00 to 08:00 (spans overnight).
 * Release time: 08:15.
 * Timezone: Asia/Kolkata (or organization timezone).
 */
export function calculateNextAllowedDeliveryTime({
  dueTimeUTC = new Date(),
  quietStart = "21:00",
  quietEnd = "08:00",
  morningReleaseTime = "08:15",
  timezone = "Asia/Kolkata",
  quietHoursEnabled = true,
}) {
  if (!quietHoursEnabled) {
    return new Date(dueTimeUTC);
  }

  try {
    // Parse time parts
    const [startH, startM] = quietStart.split(":").map(Number);
    const [endH, endM] = quietEnd.split(":").map(Number);
    const [releaseH, releaseM] = morningReleaseTime.split(":").map(Number);

    // Get date string in target timezone
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });

    const parts = formatter.formatToParts(dueTimeUTC);
    const partMap = {};
    parts.forEach((p) => {
      partMap[p.type] = p.value;
    });

    const year = parseInt(partMap.year, 10);
    const month = parseInt(partMap.month, 10);
    const day = parseInt(partMap.day, 10);
    const hour = parseInt(partMap.hour, 10);
    const minute = parseInt(partMap.minute, 10);

    const currentMinutes = hour * 60 + minute;
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    let inQuietHours = false;
    let addDays = 0;

    if (startMinutes > endMinutes) {
      // Overnight window (e.g. 21:00 to 08:00)
      if (currentMinutes >= startMinutes) {
        // Late evening, after start -> release tomorrow morning
        inQuietHours = true;
        addDays = 1;
      } else if (currentMinutes < endMinutes) {
        // Early morning, before end -> release today morning
        inQuietHours = true;
        addDays = 0;
      }
    } else {
      // Daytime window (e.g. 13:00 to 15:00)
      if (currentMinutes >= startMinutes && currentMinutes < endMinutes) {
        inQuietHours = true;
        addDays = 0;
      }
    }

    if (!inQuietHours) {
      return new Date(dueTimeUTC);
    }

    // Construct local release time ISO in that timezone
    const targetDate = new Date(Date.UTC(year, month - 1, day + addDays, 0, 0, 0));
    const targetY = targetDate.getUTCFullYear();
    const targetM = String(targetDate.getUTCMonth() + 1).padStart(2, "0");
    const targetD = String(targetDate.getUTCDate()).padStart(2, "0");

    // Convert release time in target timezone to UTC Date
    const releaseIsoString = `${targetY}-${targetM}-${targetD}T${String(releaseH).padStart(2, "0")}:${String(
      releaseM
    ).padStart(2, "0")}:00`;

    // Calculate timezone offset at that date to get exact UTC Date
    const testUtc = new Date(releaseIsoString + "Z");
    const localAtTest = new Date(testUtc.toLocaleString("en-US", { timeZone: timezone }));
    const offsetMs = testUtc.getTime() - localAtTest.getTime();

    return new Date(testUtc.getTime() + offsetMs);
  } catch (err) {
    // If timezone parsing fails, fallback to raw due time
    return new Date(dueTimeUTC);
  }
}

/**
 * Replaces lead variables in follow-up message templates
 */
export function interpolateMessageTemplate(template, lead) {
  if (!template) return "";
  let text = String(template);
  text = text.replace(/\{\{\s*lead_name\s*\}\}/gi, lead?.name || "there");
  text = text.replace(
    /\{\{\s*interested_product\s*\}\}/gi,
    lead?.collectedData?.interestedProduct || "our bespoke artisan collection"
  );
  text = text.replace(/\{\{\s*budget\s*\}\}/gi, lead?.collectedData?.budgetRange || "custom quote");
  return text;
}

/**
 * Evaluates active follow-up rules across tenant leads and queues eligible jobs.
 * Enforces deduplication and quiet-hours delivery adjustments.
 */
export async function evaluateEligibleLeadsAndSchedule({ tenantDb, organization, entitlements }) {
  if (!entitlements?.canAccessFollowUps) {
    return { scheduledCount: 0, reason: "ENTITLEMENT_LACKED" };
  }

  const { FollowUpRule, ScheduledFollowUp, Lead, QuietHours } = getTenantModels(tenantDb);

  // 1. Load quiet hours settings
  let quietSettings = await QuietHours.findOne();
  if (!quietSettings) {
    quietSettings = {
      enabled: true,
      quietStart: "21:00",
      quietEnd: "08:00",
      morningReleaseTime: "08:15",
      timezone: organization?.timezone || "Asia/Kolkata",
    };
  }

  // 2. Fetch active rules
  const activeRules = await FollowUpRule.find({ isActive: true });
  if (activeRules.length === 0) {
    return { scheduledCount: 0, reason: "NO_ACTIVE_RULES" };
  }

  let totalScheduled = 0;
  const now = new Date();

  for (const rule of activeRules) {
    // Determine target lead query
    const leadQuery = { status: { $ne: "Lost" } };
    if (rule.targetStatus && rule.targetStatus !== "Any") {
      leadQuery.status = rule.targetStatus;
    }

    const leads = await Lead.find(leadQuery);

    for (const lead of leads) {
      let isEligible = false;
      const lastContact = new Date(lead.lastContactAt || lead.createdAt);
      const hoursSinceContact = (now.getTime() - lastContact.getTime()) / (3600 * 1000);

      if (rule.triggerCondition === "inactive_hours") {
        if (hoursSinceContact >= rule.delayHours) {
          isEligible = true;
        }
      } else if (rule.triggerCondition === "status_changed") {
        const hoursSinceUpdate = (now.getTime() - new Date(lead.updatedAt).getTime()) / (3600 * 1000);
        if (hoursSinceUpdate >= rule.delayHours) {
          isEligible = true;
        }
      } else if (rule.triggerCondition === "unanswered_ai") {
        if (lead.aiHandled && hoursSinceContact >= rule.delayHours) {
          isEligible = true;
        }
      }

      if (!isEligible) continue;

      // Deduplication: Has a job already been queued or completed for this lead & rule?
      const existingJob = await ScheduledFollowUp.findOne({
        leadId: lead._id,
        ruleId: rule._id,
        status: { $in: ["pending", "processing", "completed"] },
      });

      if (existingJob) {
        continue;
      }

      // Calculate scheduled due time (accounting for quiet hours)
      const rawDueAt = new Date(lastContact.getTime() + rule.delayHours * 3600 * 1000);
      const initialDueAt = rawDueAt < now ? now : rawDueAt;

      const adjustedDueAt = calculateNextAllowedDeliveryTime({
        dueTimeUTC: initialDueAt,
        quietStart: rule.quietHoursStart || quietSettings.quietStart,
        quietEnd: rule.quietHoursEnd || quietSettings.quietEnd,
        morningReleaseTime: quietSettings.morningReleaseTime,
        timezone: quietSettings.timezone || "Asia/Kolkata",
        quietHoursEnabled: rule.quietHoursEnabled !== false && quietSettings.enabled !== false,
      });

      const messagePreview = interpolateMessageTemplate(rule.messageTemplate, lead);

      await ScheduledFollowUp.create({
        ruleId: rule._id,
        ruleTitle: rule.title,
        leadId: lead._id,
        leadName: lead.name,
        leadPhone: lead.phone,
        assignedToId: lead.assignedToId || null,
        scheduledTime: initialDueAt,
        dueAt: adjustedDueAt,
        status: "pending",
        actionType: rule.actionType,
        messagePreview,
        retryCount: 0,
      });

      totalScheduled += 1;
    }
  }

  return { scheduledCount: totalScheduled };
}

/**
 * Claims and executes due follow-up jobs atomically.
 */
export async function executeDueFollowUps({ tenantDb, organization, entitlements }) {
  if (!entitlements?.canAccessFollowUps) {
    return { executedCount: 0, reason: "ENTITLEMENT_LACKED" };
  }

  const { ScheduledFollowUp, FollowUpRule, Lead } = getTenantModels(tenantDb);
  const now = new Date();

  // Find due pending jobs
  const dueJobs = await ScheduledFollowUp.find({
    status: "pending",
    dueAt: { $lte: now },
  }).limit(25);

  let executedCount = 0;

  for (const job of dueJobs) {
    // Claim job atomically
    const claimed = await ScheduledFollowUp.findOneAndUpdate(
      { _id: job._id, status: "pending" },
      { $set: { status: "processing" } },
      { returnDocument: 'after' }
    );

    if (!claimed) continue;

    try {
      const lead = await Lead.findById(claimed.leadId);
      if (!lead || lead.status === "Lost") {
        claimed.status = "cancelled";
        claimed.lastError = "Lead no longer active or in Lost stage.";
        await claimed.save();
        continue;
      }

      const rule = await FollowUpRule.findById(claimed.ruleId);
      if (!rule || !rule.isActive) {
        claimed.status = "cancelled";
        claimed.lastError = "Parent follow-up rule was paused or deleted.";
        await claimed.save();
        continue;
      }

      // Check if lead replied after this job was queued
      if (new Date(lead.lastContactAt).getTime() > new Date(claimed.createdAt).getTime()) {
        claimed.status = "cancelled";
        claimed.lastError = "Lead replied before follow-up was dispatched.";
        await claimed.save();
        continue;
      }

      // Enqueue real WhatsApp message via persistent outbound worker
      if (claimed.messagePreview) {
        await enqueueOutboundMessage({
          leadId: lead._id,
          connectionId: lead.whatsappConnectionId,
          body: claimed.messagePreview,
          idempotencyKey: `followup:${claimed._id}`,
          source: "follow_up",
          tenantModels: getTenantModels(tenantDb),
          orgId: organization._id,
        });
      }

      lead.lastContactAt = new Date();
      await lead.save();

      claimed.status = "completed";
      claimed.executedAt = new Date();
      await claimed.save();

      executedCount += 1;
    } catch (err) {
      claimed.status = "failed";
      claimed.retryCount = (claimed.retryCount || 0) + 1;
      claimed.lastError = err.message || "Failed to dispatch follow-up.";
      await claimed.save();
    }
  }

  return { executedCount };
}

/**
 * Manually dispatches a pending job immediately.
 */
export async function dispatchSingleJobNow({ tenantDb, organization, jobId, entitlements }) {
  if (!entitlements?.canAccessFollowUps) {
    const err = new Error("Follow-ups feature is not included in your subscription.");
    err.status = 403;
    err.code = "FOLLOWUPS_ADDON_REQUIRED";
    throw err;
  }

  const { ScheduledFollowUp, Lead } = getTenantModels(tenantDb);

  const job = await ScheduledFollowUp.findById(jobId);
  if (!job) {
    const err = new Error("Scheduled follow-up job not found.");
    err.status = 404;
    throw err;
  }

  if (job.status !== "pending") {
    const err = new Error(`Job cannot be triggered because it is already marked "${job.status}".`);
    err.status = 400;
    throw err;
  }

  const lead = await Lead.findById(job.leadId);
  if (lead && job.messagePreview) {
    await enqueueOutboundMessage({
      leadId: lead._id,
      connectionId: lead.whatsappConnectionId,
      body: job.messagePreview,
      idempotencyKey: `followup:${job._id}:manual`,
      source: "follow_up",
      tenantModels: getTenantModels(tenantDb),
      orgId: organization._id,
    });
    lead.lastContactAt = new Date();
    await lead.save();
  }

  job.status = "completed";
  job.executedAt = new Date();
  await job.save();

  return {
    job,
    lead,
    message: `Follow-up message dispatched immediately to ${job.leadName || "customer"}.`,
  };
}

/**
 * Sweeps all organizations to evaluate and execute due follow-ups.
 * Safe against single-tenant failures and enforces plan entitlement checks.
 */
export async function processAllOrganizationsFollowUps() {
  try {
    if (!isDbConnected()) {
      return;
    }
    const organizations = await Organization.find();
    for (const org of organizations) {
      try {
        const subscription = await Subscription.findOne({ organizationId: org._id });
        const entitlements = computeEntitlements(subscription);
        if (!entitlements.canAccessFollowUps) {
          continue;
        }

        const tenantDb = getTenantDB(org.tenantDbName);
        await evaluateEligibleLeadsAndSchedule({
          tenantDb,
          organization: org,
          entitlements,
        });

        await executeDueFollowUps({
          tenantDb,
          organization: org,
          entitlements,
        });
      } catch (orgErr) {
        // Individual tenant failure should not stop processing of others
        console.warn(`[Follow-ups Worker] Tenant pass skipped for ${org.name}:`, orgErr.message);
      }
    }
  } catch (err) {
    console.error("[Follow-ups Worker Sweeper Error]", err);
  }
}

/**
 * Initializes the periodic background worker interval.
 */
export function startFollowUpSchedulerWorker({ intervalMs = 60000 } = {}) {
  // First run after 5s warm-up
  setTimeout(() => {
    processAllOrganizationsFollowUps().catch(() => {});
  }, 5000);

  // Periodic recurring check
  const interval = setInterval(() => {
    processAllOrganizationsFollowUps().catch(() => {});
  }, intervalMs);

  return interval;
}
