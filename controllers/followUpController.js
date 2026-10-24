import {
  evaluateEligibleLeadsAndSchedule,
  executeDueFollowUps,
  dispatchSingleJobNow,
} from "../helpers/followUpEngine.js";

/**
 * Middleware or inline check enforcing Follow-up Automations plan access
 */
export function checkFollowUpsAccess(req, res, { allowReadOnly = false } = {}) {
  const isEntitled = Boolean(req.entitlements?.canAccessFollowUps);
  const isReadOnly = Boolean(req.entitlements?.isReadOnly);

  if (allowReadOnly) {
    return true;
  }

  if (!isEntitled || isReadOnly) {
    res.status(403).json({
      success: false,
      code: "FOLLOWUPS_ADDON_REQUIRED",
      message:
        "Follow-up automations are included in Enterprise or available as an add-on for Basic & Growth plans. Please upgrade to unlock automated follow-ups.",
    });
    return false;
  }
  return true;
}

/**
 * GET /api/follow-ups/rules
 * Lists all configured follow-up automation rules
 */
export async function listRules(req, res) {
  try {
    if (!checkFollowUpsAccess(req, res, { allowReadOnly: true })) return;

    const { FollowUpRule, ScheduledFollowUp, Lead } = req.tenantModels;

    const rules = await FollowUpRule.find().sort({ createdAt: -1 });
    const scheduled = await ScheduledFollowUp.find({ status: "pending" });
    const leads = await Lead.find({ status: { $ne: "Lost" } });

    // Format rules with dynamic counts
    const formatted = rules.map((r) => {
      const waitingCount = scheduled.filter(
        (s) => s.ruleId && s.ruleId.toString() === r._id.toString()
      ).length;
      const eligibleCount = leads.filter(
        (l) => r.targetStatus === "Any" || l.status === r.targetStatus
      ).length;

      return {
        id: r._id.toString(),
        title: r.title,
        triggerCondition: r.triggerCondition,
        delayHours: r.delayHours,
        targetStatus: r.targetStatus,
        actionType: r.actionType,
        messageTemplate: r.messageTemplate,
        quietHoursEnabled: r.quietHoursEnabled,
        quietHoursStart: r.quietHoursStart,
        quietHoursEnd: r.quietHoursEnd,
        isActive: r.isActive,
        waitingCount,
        eligibleCount,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    });

    return res.json({
      success: true,
      rules: formatted,
    });
  } catch (err) {
    console.error("[List Rules Error]", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to list follow-up rules.",
    });
  }
}

/**
 * POST /api/follow-ups/rules
 * Creates a new follow-up rule
 */
export async function createRule(req, res) {
  try {
    if (!checkFollowUpsAccess(req, res)) return;

    const {
      title,
      triggerCondition,
      delayHours,
      targetStatus,
      actionType,
      messageTemplate,
      quietHoursEnabled,
      quietHoursStart,
      quietHoursEnd,
    } = req.body || {};

    if (!title || !String(title).trim()) {
      return res.status(400).json({ success: false, message: "Rule title is required." });
    }
    if (!messageTemplate || !String(messageTemplate).trim()) {
      return res.status(400).json({ success: false, message: "Message template is required." });
    }

    const { FollowUpRule } = req.tenantModels;

    const newRule = await FollowUpRule.create({
      title: String(title).trim(),
      triggerCondition: triggerCondition || "inactive_hours",
      delayHours: Math.max(1, Math.min(720, Number(delayHours) || 24)),
      targetStatus: targetStatus || "Interested",
      actionType: actionType || "ai_send_whatsapp",
      messageTemplate: String(messageTemplate).trim(),
      quietHoursEnabled: quietHoursEnabled !== false,
      quietHoursStart: quietHoursStart || "21:00",
      quietHoursEnd: quietHoursEnd || "08:00",
      isActive: true,
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });

    // Run scheduler immediately to queue any currently eligible leads
    evaluateEligibleLeadsAndSchedule({
      tenantDb: req.tenantDb,
      organization: req.organization,
      entitlements: req.entitlements,
    }).catch(() => {});

    return res.status(201).json({
      success: true,
      message: `Follow-up rule "${newRule.title}" created successfully.`,
      rule: {
        id: newRule._id.toString(),
        title: newRule.title,
        triggerCondition: newRule.triggerCondition,
        delayHours: newRule.delayHours,
        targetStatus: newRule.targetStatus,
        actionType: newRule.actionType,
        messageTemplate: newRule.messageTemplate,
        quietHoursEnabled: newRule.quietHoursEnabled,
        quietHoursStart: newRule.quietHoursStart,
        quietHoursEnd: newRule.quietHoursEnd,
        isActive: newRule.isActive,
      },
    });
  } catch (err) {
    console.error("[Create Rule Error]", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to create follow-up rule.",
    });
  }
}

/**
 * PUT /api/follow-ups/rules/:id
 * Updates an existing follow-up rule
 */
export async function updateRule(req, res) {
  try {
    if (!checkFollowUpsAccess(req, res)) return;

    const { id } = req.params;
    const { FollowUpRule } = req.tenantModels;

    const rule = await FollowUpRule.findById(id);
    if (!rule) {
      return res.status(404).json({ success: false, message: "Follow-up rule not found." });
    }

    const {
      title,
      triggerCondition,
      delayHours,
      targetStatus,
      actionType,
      messageTemplate,
      quietHoursEnabled,
      quietHoursStart,
      quietHoursEnd,
    } = req.body || {};

    if (title !== undefined) rule.title = String(title).trim();
    if (triggerCondition !== undefined) rule.triggerCondition = triggerCondition;
    if (delayHours !== undefined) rule.delayHours = Math.max(1, Math.min(720, Number(delayHours) || 24));
    if (targetStatus !== undefined) rule.targetStatus = targetStatus;
    if (actionType !== undefined) rule.actionType = actionType;
    if (messageTemplate !== undefined) rule.messageTemplate = String(messageTemplate).trim();
    if (quietHoursEnabled !== undefined) rule.quietHoursEnabled = quietHoursEnabled !== false;
    if (quietHoursStart !== undefined) rule.quietHoursStart = quietHoursStart;
    if (quietHoursEnd !== undefined) rule.quietHoursEnd = quietHoursEnd;

    rule.updatedBy = req.user._id;
    await rule.save();

    return res.json({
      success: true,
      message: `Follow-up rule "${rule.title}" updated successfully.`,
      rule: {
        id: rule._id.toString(),
        title: rule.title,
        triggerCondition: rule.triggerCondition,
        delayHours: rule.delayHours,
        targetStatus: rule.targetStatus,
        actionType: rule.actionType,
        messageTemplate: rule.messageTemplate,
        quietHoursEnabled: rule.quietHoursEnabled,
        quietHoursStart: rule.quietHoursStart,
        quietHoursEnd: rule.quietHoursEnd,
        isActive: rule.isActive,
      },
    });
  } catch (err) {
    console.error("[Update Rule Error]", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to update follow-up rule.",
    });
  }
}

/**
 * PATCH /api/follow-ups/rules/:id/status
 * Toggles active or paused status of a follow-up rule
 */
export async function toggleRuleStatus(req, res) {
  try {
    if (!checkFollowUpsAccess(req, res)) return;

    const { id } = req.params;
    const { FollowUpRule } = req.tenantModels;

    const rule = await FollowUpRule.findById(id);
    if (!rule) {
      return res.status(404).json({ success: false, message: "Follow-up rule not found." });
    }

    rule.isActive = !rule.isActive;
    rule.updatedBy = req.user._id;
    await rule.save();

    if (rule.isActive) {
      evaluateEligibleLeadsAndSchedule({
        tenantDb: req.tenantDb,
        organization: req.organization,
        entitlements: req.entitlements,
      }).catch(() => {});
    }

    return res.json({
      success: true,
      message: rule.isActive ? `Activated rule "${rule.title}"` : `Paused rule "${rule.title}"`,
      isActive: rule.isActive,
    });
  } catch (err) {
    console.error("[Toggle Rule Error]", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to toggle rule status.",
    });
  }
}

/**
 * DELETE /api/follow-ups/rules/:id
 * Deletes a rule and cancels any future pending jobs queued under it
 */
export async function deleteRule(req, res) {
  try {
    if (!checkFollowUpsAccess(req, res)) return;

    const { id } = req.params;
    const { FollowUpRule, ScheduledFollowUp } = req.tenantModels;

    const rule = await FollowUpRule.findById(id);
    if (!rule) {
      return res.status(404).json({ success: false, message: "Follow-up rule not found." });
    }

    // Cancel pending jobs queued under this rule
    await ScheduledFollowUp.updateMany(
      { ruleId: rule._id, status: "pending" },
      { $set: { status: "cancelled", lastError: "Rule deleted by administrator" } }
    );

    await FollowUpRule.findByIdAndDelete(id);

    return res.json({
      success: true,
      message: `Follow-up rule "${rule.title}" removed successfully.`,
    });
  } catch (err) {
    console.error("[Delete Rule Error]", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to delete rule.",
    });
  }
}

/**
 * GET /api/follow-ups/quiet-hours
 * Reads organization quiet hours settings
 */
export async function getQuietHours(req, res) {
  try {
    if (!checkFollowUpsAccess(req, res, { allowReadOnly: true })) return;

    const { QuietHours } = req.tenantModels;
    let settings = await QuietHours.findOne();

    if (!settings) {
      settings = await QuietHours.create({
        enabled: true,
        quietStart: "21:00",
        quietEnd: "08:00",
        morningReleaseTime: "08:15",
        timezone: req.organization?.timezone || "Asia/Kolkata",
      });
    }

    return res.json({
      success: true,
      quietHours: {
        enabled: settings.enabled,
        quietStart: settings.quietStart,
        quietEnd: settings.quietEnd,
        morningReleaseTime: settings.morningReleaseTime,
        timezone: settings.timezone,
      },
    });
  } catch (err) {
    console.error("[Get Quiet Hours Error]", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to load quiet hours settings.",
    });
  }
}

/**
 * PUT /api/follow-ups/quiet-hours
 * Updates organization quiet hours settings
 */
export async function updateQuietHours(req, res) {
  try {
    if (!checkFollowUpsAccess(req, res)) return;

    const { enabled, quietStart, quietEnd, morningReleaseTime, timezone } = req.body || {};
    const { QuietHours } = req.tenantModels;

    let settings = await QuietHours.findOne();
    if (!settings) {
      settings = new QuietHours({});
    }

    if (enabled !== undefined) settings.enabled = Boolean(enabled);
    if (quietStart !== undefined) settings.quietStart = String(quietStart).trim();
    if (quietEnd !== undefined) settings.quietEnd = String(quietEnd).trim();
    if (morningReleaseTime !== undefined) settings.morningReleaseTime = String(morningReleaseTime).trim();
    if (timezone !== undefined) settings.timezone = String(timezone).trim();

    await settings.save();

    return res.json({
      success: true,
      message: `Quiet hours schedule updated (${settings.quietStart} – ${settings.quietEnd}, release at ${settings.morningReleaseTime}).`,
      quietHours: {
        enabled: settings.enabled,
        quietStart: settings.quietStart,
        quietEnd: settings.quietEnd,
        morningReleaseTime: settings.morningReleaseTime,
        timezone: settings.timezone,
      },
    });
  } catch (err) {
    console.error("[Update Quiet Hours Error]", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to update quiet hours settings.",
    });
  }
}

/**
 * GET /api/follow-ups/scheduled
 * Lists scheduled follow-up jobs
 */
export async function listScheduled(req, res) {
  try {
    if (!checkFollowUpsAccess(req, res, { allowReadOnly: true })) return;

    const { ScheduledFollowUp } = req.tenantModels;
    const query = {};

    // If non-owner salesperson, filter by assigned leads only (unless global visibility allowed)
    if (req.membership?.role === "salesperson" && !req.membership?.canViewAllLeads) {
      query.assignedToId = req.user._id;
    }

    if (req.query.status) {
      query.status = req.query.status;
    }

    // Trigger scheduled lead evaluation check in background only if entitled and not read-only
    if (req.entitlements?.canAccessFollowUps && !req.entitlements?.isReadOnly) {
      evaluateEligibleLeadsAndSchedule({
        tenantDb: req.tenantDb,
        organization: req.organization,
        entitlements: req.entitlements,
      }).catch(() => {});
    }

    const jobs = await ScheduledFollowUp.find(query).sort({ dueAt: 1 }).limit(100);

    const formatted = jobs.map((j) => ({
      id: j._id.toString(),
      ruleId: j.ruleId?.toString(),
      ruleTitle: j.ruleTitle,
      leadId: j.leadId?.toString(),
      leadName: j.leadName,
      leadPhone: j.leadPhone,
      assignedToId: j.assignedToId?.toString(),
      scheduledTime: j.dueAt || j.scheduledTime,
      dueAt: j.dueAt,
      status: j.status,
      actionType: j.actionType,
      messagePreview: j.messagePreview,
      retryCount: j.retryCount,
      lastError: j.lastError,
      executedAt: j.executedAt,
      createdAt: j.createdAt,
    }));

    return res.json({
      success: true,
      scheduled: formatted,
    });
  } catch (err) {
    console.error("[List Scheduled Jobs Error]", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to list scheduled jobs.",
    });
  }
}

/**
 * POST /api/follow-ups/scheduled/:id/cancel
 * Cancels a pending scheduled job
 */
export async function cancelJob(req, res) {
  try {
    if (!checkFollowUpsAccess(req, res)) return;

    const { id } = req.params;
    const { ScheduledFollowUp } = req.tenantModels;

    const job = await ScheduledFollowUp.findById(id);
    if (!job) {
      return res.status(404).json({ success: false, message: "Scheduled job not found." });
    }

    if (req.membership?.role === "salesperson" && !req.membership?.canViewAllLeads) {
      if (job.assignedToId && job.assignedToId.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: "You are not authorized to modify this scheduled follow-up.",
        });
      }
    }

    job.status = "cancelled";
    job.lastError = "Manually cancelled by user";
    await job.save();

    return res.json({
      success: true,
      message: "Scheduled follow-up cancelled.",
      jobId: job._id.toString(),
    });
  } catch (err) {
    console.error("[Cancel Job Error]", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to cancel job.",
    });
  }
}

/**
 * POST /api/follow-ups/scheduled/:id/postpone
 * Postpones a pending job by 24 hours
 */
export async function postponeJob(req, res) {
  try {
    if (!checkFollowUpsAccess(req, res)) return;

    const { id } = req.params;
    const { ScheduledFollowUp } = req.tenantModels;

    const job = await ScheduledFollowUp.findById(id);
    if (!job) {
      return res.status(404).json({ success: false, message: "Scheduled job not found." });
    }

    if (req.membership?.role === "salesperson" && !req.membership?.canViewAllLeads) {
      if (job.assignedToId && job.assignedToId.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: "You are not authorized to postpone this scheduled follow-up.",
        });
      }
    }

    const currentDue = new Date(job.dueAt || job.scheduledTime || Date.now());
    currentDue.setHours(currentDue.getHours() + 24);

    job.dueAt = currentDue;
    job.scheduledTime = currentDue;
    await job.save();

    return res.json({
      success: true,
      message: "Scheduled follow-up postponed by 24 hours.",
      newDueAt: currentDue,
    });
  } catch (err) {
    console.error("[Postpone Job Error]", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to postpone job.",
    });
  }
}

/**
 * POST /api/follow-ups/scheduled/:id/trigger
 * Manually dispatches a scheduled job immediately
 */
export async function triggerJob(req, res) {
  try {
    if (!checkFollowUpsAccess(req, res)) return;

    const { id } = req.params;
    const { ScheduledFollowUp } = req.tenantModels;

    const job = await ScheduledFollowUp.findById(id);
    if (!job) {
      return res.status(404).json({ success: false, message: "Scheduled job not found." });
    }

    if (req.membership?.role === "salesperson" && !req.membership?.canViewAllLeads) {
      if (job.assignedToId && job.assignedToId.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: "You are not authorized to trigger this follow-up.",
        });
      }
    }

    const result = await dispatchSingleJobNow({
      tenantDb: req.tenantDb,
      organization: req.organization,
      jobId: id,
      entitlements: req.entitlements,
    });

    return res.json({
      success: true,
      message: result.message,
      job: {
        id: result.job._id.toString(),
        status: result.job.status,
        executedAt: result.job.executedAt,
      },
    });
  } catch (err) {
    console.error("[Trigger Job Error]", err);
    return res.status(err.status || 500).json({
      success: false,
      message: err.message || "Failed to trigger scheduled follow-up.",
      code: err.code,
    });
  }
}
