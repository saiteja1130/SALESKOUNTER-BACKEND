import { Organization } from "../models/platform/Organization.js";
import { Subscription } from "../models/platform/Subscription.js";
import { AdminAuditLog } from "../models/platform/AdminAuditLog.js";
import { computeEntitlements } from "../helpers/entitlements.js";

/**
 * GET /api/admin/organizations
 * List all organizations with their subscription status and details
 */
export async function getAdminOrganizations(req, res) {
  try {
    const orgs = await Organization.find().sort({ createdAt: -1 }).populate("ownerId", "name email");
    const orgIds = orgs.map((o) => o._id);
    const subscriptions = await Subscription.find({ organizationId: { $in: orgIds } });
    const subMap = new Map(subscriptions.map((s) => [s.organizationId.toString(), s]));

    const result = orgs.map((org) => {
      const sub = subMap.get(org._id.toString());
      return {
        id: org._id,
        name: org.name,
        slug: org.slug,
        tenantDbName: org.tenantDbName,
        owner: org.ownerId,
        provisioningStatus: org.provisioningStatus,
        subscription: sub
          ? {
              id: sub._id,
              plan: sub.plan,
              status: sub.status,
              billingCycle: sub.billingCycle,
              startDate: sub.startDate,
              endDate: sub.endDate,
              repAddons: sub.repAddons,
              campaignsAddon: sub.campaignsAddon,
              followUpsAddon: sub.followUpsAddon,
              entitlements: computeEntitlements(sub),
            }
          : null,
      };
    });

    return res.json({ success: true, organizations: result });
  } catch (err) {
    console.error("[Admin Organizations Error]", err);
    return res.status(500).json({ success: false, message: "Error fetching organizations." });
  }
}

/**
 * PATCH /api/admin/subscriptions/:orgId
 * Manually update plan, dates, status, or add-ons with audit logging.
 * Preserves data and recomputes entitlements without deleting user records.
 */
export async function updateSubscription(req, res) {
  try {
    const { orgId } = req.params;
    const {
      plan,
      status,
      billingCycle,
      startDate,
      endDate,
      repAddons,
      campaignsAddon,
      followUpsAddon,
      note,
    } = req.body;

    const subscription = await Subscription.findOne({ organizationId: orgId });
    if (!subscription) {
      return res.status(404).json({ success: false, message: "Subscription not found for organization." });
    }

    const previousState = {
      plan: subscription.plan,
      status: subscription.status,
      billingCycle: subscription.billingCycle,
      startDate: subscription.startDate,
      endDate: subscription.endDate,
      repAddons: subscription.repAddons,
      campaignsAddon: subscription.campaignsAddon,
      followUpsAddon: subscription.followUpsAddon,
    };

    const ALLOWED_PLANS = ["trial", "basic", "growth", "enterprise"];
    const ALLOWED_STATUSES = ["active", "expired", "cancelled"];
    const ALLOWED_CYCLES = ["trial", "monthly", "quarterly", "yearly"];

    if (plan !== undefined && !ALLOWED_PLANS.includes(plan)) {
      return res.status(400).json({
        success: false,
        message: `Invalid plan. Allowed plans are: ${ALLOWED_PLANS.join(", ")}.`,
      });
    }

    if (status !== undefined && !ALLOWED_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Allowed statuses are: ${ALLOWED_STATUSES.join(", ")}.`,
      });
    }

    if (billingCycle !== undefined && !ALLOWED_CYCLES.includes(billingCycle)) {
      return res.status(400).json({
        success: false,
        message: `Invalid billingCycle. Allowed cycles are: ${ALLOWED_CYCLES.join(", ")}.`,
      });
    }

    let parsedStart = subscription.startDate;
    if (startDate !== undefined) {
      parsedStart = new Date(startDate);
      if (isNaN(parsedStart.getTime())) {
        return res.status(400).json({ success: false, message: "Invalid startDate format." });
      }
    }

    let parsedEnd = subscription.endDate;
    if (endDate !== undefined) {
      parsedEnd = new Date(endDate);
      if (isNaN(parsedEnd.getTime())) {
        return res.status(400).json({ success: false, message: "Invalid endDate format." });
      }
    }

    if (parsedEnd <= parsedStart) {
      return res.status(400).json({
        success: false,
        message: "endDate must be strictly after startDate.",
      });
    }

    if (repAddons !== undefined) {
      const parsedReps = Number(repAddons);
      if (!Number.isInteger(parsedReps) || parsedReps < 0) {
        return res.status(400).json({
          success: false,
          message: "repAddons must be a valid non-negative integer.",
        });
      }
      subscription.repAddons = parsedReps;
    }

    if (campaignsAddon !== undefined) {
      if (typeof campaignsAddon !== "boolean") {
        return res.status(400).json({
          success: false,
          message: "campaignsAddon must be a boolean (true or false).",
        });
      }
      subscription.campaignsAddon = campaignsAddon;
    }

    if (followUpsAddon !== undefined) {
      if (typeof followUpsAddon !== "boolean") {
        return res.status(400).json({
          success: false,
          message: "followUpsAddon must be a boolean (true or false).",
        });
      }
      subscription.followUpsAddon = followUpsAddon;
    }

    if (plan !== undefined) subscription.plan = plan;
    if (status !== undefined) subscription.status = status;
    if (billingCycle !== undefined) subscription.billingCycle = billingCycle;
    if (startDate !== undefined) subscription.startDate = parsedStart;
    if (endDate !== undefined) subscription.endDate = parsedEnd;

    await subscription.save();

    const newState = {
      plan: subscription.plan,
      status: subscription.status,
      billingCycle: subscription.billingCycle,
      startDate: subscription.startDate,
      endDate: subscription.endDate,
      repAddons: subscription.repAddons,
      campaignsAddon: subscription.campaignsAddon,
      followUpsAddon: subscription.followUpsAddon,
    };

    // Record audit log
    await AdminAuditLog.create({
      adminUserId: req.user._id,
      targetOrganizationId: orgId,
      action: "PLAN_UPDATED",
      previousState,
      newState,
      note: note || "Subscription modified by admin",
    });

    const entitlements = computeEntitlements(subscription);

    return res.json({
      success: true,
      message: "Subscription updated successfully.",
      subscription,
      entitlements,
    });
  } catch (err) {
    console.error("[Update Subscription Error]", err);
    return res.status(500).json({ success: false, message: "Error updating subscription." });
  }
}

/**
 * GET /api/admin/audit-logs
 */
export async function getAuditLogs(req, res) {
  try {
    const logs = await AdminAuditLog.find()
      .sort({ createdAt: -1 })
      .limit(100)
      .populate("adminUserId", "name email")
      .populate("targetOrganizationId", "name slug");

    return res.json({ success: true, logs });
  } catch (err) {
    console.error("[Get Audit Logs Error]", err);
    return res.status(500).json({ success: false, message: "Error fetching audit logs." });
  }
}
