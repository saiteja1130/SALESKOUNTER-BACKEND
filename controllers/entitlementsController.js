import { getTodayDateIST } from "../helpers/crypto.js";
import {
  assertCanAddConnection,
  assertCanAddSalesRep,
  tryConsumeDailyLeadQuota,
  rollbackDailyLeadQuota,
} from "../helpers/entitlements.js";

/**
 * GET /api/entitlements/usage
 * Returns current tenant usage vs plan limits
 */
export async function getTenantUsage(req, res) {
  try {
    const { tenantModels, entitlements } = req;
    const todayIST = getTodayDateIST();

    const [connectionsCount, repsCount, todayCounter, totalLeadsCount] = await Promise.all([
      tenantModels.WhatsAppConnection.countDocuments({ status: { $ne: "disconnected" } }),
      tenantModels.TeamMember.countDocuments({ role: "salesperson", status: { $ne: "disabled" } }),
      tenantModels.DailyLeadCounter.findOne({ dateIST: todayIST }),
      tenantModels.Lead.countDocuments(),
    ]);

    const todayLeads = todayCounter ? todayCounter.count : 0;

    return res.json({
      success: true,
      entitlements,
      usage: {
        todayIST,
        whatsappConnections: {
          current: connectionsCount,
          max: entitlements.maxConnections,
          remaining: Math.max(0, entitlements.maxConnections - connectionsCount),
          isExceeded: connectionsCount > entitlements.maxConnections,
        },
        salesReps: {
          current: repsCount,
          max: entitlements.maxSalesReps,
          remaining: Math.max(0, entitlements.maxSalesReps - repsCount),
          isExceeded: repsCount > entitlements.maxSalesReps,
        },
        dailyLeads: {
          todayCount: todayLeads,
          maxLimit: entitlements.dailyLeadLimit,
          remaining: Math.max(0, entitlements.dailyLeadLimit - todayLeads),
          isExceeded: todayLeads >= entitlements.dailyLeadLimit,
          resetsAt: "12:00 AM IST",
        },
        totalLeadsCount,
        campaigns: {
          allowed: entitlements.canAccessCampaigns,
        },
        followUps: {
          allowed: entitlements.canAccessFollowUps,
        },
        isReadOnly: entitlements.isReadOnly,
      },
    });
  } catch (err) {
    console.error("[Get Usage Error]", err);
    return res.status(500).json({ success: false, message: "Error fetching usage data." });
  }
}

import { createLead } from "./leadController.js";

/**
 * POST /api/entitlements/lead
 * Creates a lead while atomically validating the IST daily limit
 */
export async function createLeadWithQuota(req, res) {
  return createLead(req, res);
}

