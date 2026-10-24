import { getTodayDateIST } from "../helpers/crypto.js";
import {
  tryConsumeDailyLeadQuota,
  rollbackDailyLeadQuota,
} from "../helpers/entitlements.js";

const ALLOWED_STATUSES = ["New", "Interested", "In-followup", "Converted", "Lost"];

/**
 * Normalizes input lead status
 */
function normalizeStatus(status) {
  if (!status) return "New";
  if (ALLOWED_STATUSES.includes(status)) return status;
  if (status.toLowerCase() === "contacted" || status.toLowerCase() === "interested") return "Interested";
  if (status.toLowerCase() === "follow-up" || status.toLowerCase() === "in-followup") return "In-followup";
  if (status.toLowerCase() === "converted") return "Converted";
  if (status.toLowerCase() === "lost") return "Lost";
  return "New";
}

/**
 * GET /api/leads
 * Paginated and filtered tenant lead list strictly enforcing server-side salesperson visibility
 */
export async function listLeads(req, res) {
  try {
    const { tenantModels } = req;
    if (!tenantModels) {
      return res.status(400).json({ success: false, message: "Tenant database unavailable." });
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const { status, assignedToId, search } = req.query;

    const filter = {};

    // Enforce trusted server-side salesperson visibility (never trust client headers)
    if (req.membership?.role === "salesperson") {
      const canViewAll = Boolean(req.membership?.canViewAllLeads);
      if (!canViewAll) {
        const userEmail = req.user.email.toLowerCase().trim();
        const rep = await tenantModels.TeamMember.findOne({ email: userEmail });
        if (rep) {
          filter.$or = [{ assignedToId: rep._id }, { email: userEmail }];
        } else {
          filter.assignedToId = req.user._id;
        }
      }
    }

    // Apply status filter
    if (status && status !== "all") {
      filter.status = status;
    }

    // Apply assignee filter
    if (assignedToId && assignedToId !== "all") {
      if (assignedToId === "unassigned") {
        filter.assignedToId = null;
      } else {
        filter.assignedToId = assignedToId;
      }
    }

    // Apply search filter across name, phone, email, and product
    if (search && search.trim()) {
      const q = search.trim();
      const searchRegex = { $regex: q, $options: "i" };
      const searchCondition = [
        { name: searchRegex },
        { phone: searchRegex },
        { email: searchRegex },
        { "collectedData.interestedProduct": searchRegex },
      ];

      if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, { $or: searchCondition }];
        delete filter.$or;
      } else {
        filter.$or = searchCondition;
      }
    }

    const totalCount = await tenantModels.Lead.countDocuments(filter);
    const leads = await tenantModels.Lead.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    // Map _id to id for seamless frontend usage
    const serializedLeads = leads.map((l) => {
      const doc = l.toObject();
      return {
        ...doc,
        id: doc._id.toString(),
      };
    });

    return res.json({
      success: true,
      leads: serializedLeads,
      totalCount,
      page,
      limit,
      totalPages: Math.ceil(totalCount / limit) || 1,
    });
  } catch (err) {
    console.error("[List Leads Error]", err);
    return res.status(500).json({ success: false, message: "Failed to list leads." });
  }
}

/**
 * GET /api/leads/team-members
 * Lists active tenant representatives for assignee selection
 */
export async function listTeamMembers(req, res) {
  try {
    const { tenantModels } = req;
    if (!tenantModels) {
      return res.status(400).json({ success: false, message: "Tenant database unavailable." });
    }

    const members = await tenantModels.TeamMember.find({
      status: { $ne: "disabled" },
    }).sort({ name: 1 });

    const serialized = members.map((m) => ({
      id: m._id.toString(),
      name: m.name,
      email: m.email,
      phone: m.phone,
      role: m.role,
      status: m.status,
      canViewAllLeads: Boolean(m.canViewAllLeads),
      assignedLeadsCount: m.assignedLeadsCount,
    }));

    return res.json({
      success: true,
      teamMembers: serialized,
    });
  } catch (err) {
    console.error("[List Team Members Error]", err);
    return res.status(500).json({ success: false, message: "Failed to list team members." });
  }
}

/**
 * GET /api/leads/:id
 * Retrieve a single lead by ID with server-side visibility enforcement
 */
export async function getLead(req, res) {
  try {
    const { tenantModels } = req;
    const lead = await tenantModels.Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ success: false, message: "Lead not found." });
    }

    // Server-side salesperson authorization
    if (req.membership?.role === "salesperson") {
      const canViewAll = Boolean(req.membership?.canViewAllLeads);
      if (!canViewAll) {
        const userEmail = req.user.email.toLowerCase().trim();
        const rep = await tenantModels.TeamMember.findOne({ email: userEmail });
        const repIdStr = rep ? rep._id.toString() : "";
        const leadAssigneeIdStr = lead.assignedToId ? lead.assignedToId.toString() : "";

        if (leadAssigneeIdStr !== repIdStr && lead.email !== userEmail) {
          return res.status(403).json({
            success: false,
            message: "Access denied. You can only view leads assigned to your account.",
          });
        }
      }
    }

    const doc = lead.toObject();
    return res.json({
      success: true,
      lead: { ...doc, id: doc._id.toString() },
    });
  } catch (err) {
    console.error("[Get Lead Error]", err);
    return res.status(500).json({ success: false, message: "Failed to retrieve lead." });
  }
}

/**
 * POST /api/leads
 * Creates a new lead with strict duplicate phone check, round-robin / rep validation,
 * and concurrency-safe daily IST quota reservation.
 */
export async function createLead(req, res) {
  let quotaReservation = null;
  try {
    const { tenantModels, entitlements } = req;
    if (!tenantModels) {
      return res.status(400).json({ success: false, message: "Tenant database unavailable." });
    }

    const {
      name,
      phone,
      email,
      status,
      source,
      assignedToId,
      collectedData,
      whatsappPhoneNumber,
      whatsappConnectionId,
      notes,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Full name is required." });
    }
    if (!phone || !phone.trim()) {
      return res.status(400).json({ success: false, message: "WhatsApp phone number is required." });
    }

    const cleanName = name.trim();
    const cleanPhone = phone.trim();
    const cleanEmail = email ? email.toLowerCase().trim() : "";
    const cleanStatus = normalizeStatus(status);
    const cleanSource = source ? source.trim() : "WhatsApp Inbound";

    // 1. Strict Duplicate Phone Validation (Before quota check)
    const existingPhone = await tenantModels.Lead.findOne({ phone: cleanPhone });
    if (existingPhone) {
      return res.status(409).json({
        success: false,
        code: "DUPLICATE_PHONE",
        message: `A lead with phone number "${cleanPhone}" already exists in your workspace pipeline.`,
      });
    }

    // 2. Assignee Resolution
    let resolvedAssigneeId = null;
    let resolvedAssigneeName = "Unassigned";

    if (assignedToId === "round-robin") {
      // Auto assign via Round-Robin among active sales reps
      const activeReps = await tenantModels.TeamMember.find({
        role: "salesperson",
        status: "active",
      }).sort({ assignedLeadsCount: 1, createdAt: 1 });

      if (activeReps.length > 0) {
        const chosenRep = activeReps[0];
        resolvedAssigneeId = chosenRep._id;
        resolvedAssigneeName = chosenRep.name;
      } else {
        // Keep in unassigned if no active reps exist
        resolvedAssigneeId = null;
        resolvedAssigneeName = "Unassigned";
      }
    } else if (!assignedToId || assignedToId === "unassigned") {
      // Explicitly unassigned choice
      resolvedAssigneeId = null;
      resolvedAssigneeName = "Unassigned";
    } else {
      // Specific representative selected
      const rep = await tenantModels.TeamMember.findById(assignedToId);
      if (!rep) {
        return res.status(400).json({
          success: false,
          code: "REP_NOT_FOUND",
          message: "The selected sales representative does not exist.",
        });
      }

      // Owner assignment forbidden
      if (rep.role === "owner") {
        return res.status(400).json({
          success: false,
          code: "OWNER_ASSIGNMENT_NOT_ALLOWED",
          message: "Leads cannot be assigned to the organization owner. Please assign to an active sales representative.",
        });
      }

      if (rep.status !== "active") {
        return res.status(400).json({
          success: false,
          code: "REP_NOT_ACTIVE",
          message: "Cannot assign leads to an inactive or paused sales representative.",
        });
      }

      resolvedAssigneeId = rep._id;
      resolvedAssigneeName = rep.name;
    }

    // 3. Atomically Reserve IST Daily Quota
    quotaReservation = await tryConsumeDailyLeadQuota(tenantModels, entitlements);

    // 4. Save Lead
    const newLead = await tenantModels.Lead.create({
      name: cleanName,
      phone: cleanPhone,
      email: cleanEmail,
      status: cleanStatus,
      source: cleanSource,
      assignedToId: resolvedAssigneeId,
      assignedToName: resolvedAssigneeName,
      assignedTo: resolvedAssigneeName,
      whatsappPhoneNumber: whatsappPhoneNumber || "+1 (555) 839-2041",
      whatsappConnectionId: whatsappConnectionId || null,
      createdDateIST: quotaReservation.todayIST,
      collectedData: {
        interestedProduct: collectedData?.interestedProduct || "",
        budgetRange: collectedData?.budgetRange || "Bespoke Package",
        deliveryCity: collectedData?.deliveryCity || "",
      },
      notes: Array.isArray(notes) ? notes : [],
      lastContactAt: new Date(),
      aiHandled: true,
      needsAttention: false,
    });

    // 5. Update assigned count on team member
    if (resolvedAssigneeId) {
      await tenantModels.TeamMember.findByIdAndUpdate(resolvedAssigneeId, {
        $inc: { assignedLeadsCount: 1 },
      });
    }

    const doc = newLead.toObject();
    return res.status(201).json({
      success: true,
      message: "New WhatsApp lead created successfully within quota.",
      lead: { ...doc, id: doc._id.toString() },
      quota: quotaReservation,
    });
  } catch (err) {
    if (quotaReservation && req.tenantModels) {
      await rollbackDailyLeadQuota(req.tenantModels, quotaReservation.todayIST);
    }
    const isLimitError = err.message && err.message.includes("limit");
    return res.status(isLimitError ? 403 : 400).json({
      success: false,
      code: isLimitError ? "DAILY_LEAD_LIMIT_REACHED" : "LEAD_CREATION_FAILED",
      message: err.message || "Failed to create lead.",
    });
  }
}

/**
 * PUT /api/leads/:id
 * Updates lead details with role validation and accurate rep count synchronization
 */
export async function updateLead(req, res) {
  try {
    const { tenantModels } = req;
    const lead = await tenantModels.Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ success: false, message: "Lead not found." });
    }

    const {
      name,
      phone,
      email,
      status,
      source,
      assignedToId,
      collectedData,
      notes,
      aiHandled,
      needsAttention,
    } = req.body;

    const isOwnerOrAdmin = req.user?.role === "admin" || req.membership?.role === "owner";

    // Enforce role-based edit permissions
    if (!isOwnerOrAdmin) {
      if (req.membership?.role === "salesperson") {
        const canViewAll = Boolean(req.membership?.canViewAllLeads);
        const userEmail = req.user.email.toLowerCase().trim();
        const rep = await tenantModels.TeamMember.findOne({ email: userEmail });
        const repIdStr = rep ? rep._id.toString() : "";
        const leadAssigneeIdStr = lead.assignedToId ? lead.assignedToId.toString() : "";

        if (!canViewAll && leadAssigneeIdStr !== repIdStr && lead.email !== userEmail) {
          return res.status(403).json({
            success: false,
            message: "You are only authorized to edit leads assigned to you.",
          });
        }

        // Salesperson cannot reassign or unassign leads
        if (assignedToId !== undefined) {
          const targetRepStr = (!assignedToId || assignedToId === "unassigned") ? "" : assignedToId.toString();
          if (targetRepStr !== leadAssigneeIdStr) {
            return res.status(403).json({
              success: false,
              message: "Sales representatives cannot reassign leads. Contact your workspace owner.",
            });
          }
        }
      } else {
        return res.status(403).json({ success: false, message: "Unauthorized to update leads." });
      }
    }

    // Check phone uniqueness if phone is changing
    if (phone && phone.trim() !== lead.phone) {
      const cleanPhone = phone.trim();
      const existing = await tenantModels.Lead.findOne({
        phone: cleanPhone,
        _id: { $ne: lead._id },
      });
      if (existing) {
        return res.status(409).json({
          success: false,
          code: "DUPLICATE_PHONE",
          message: `Phone number "${cleanPhone}" is already in use by another lead.`,
        });
      }
      lead.phone = cleanPhone;
    }

    if (name) lead.name = name.trim();
    if (email !== undefined) lead.email = email.trim();
    if (status) lead.status = normalizeStatus(status);
    if (source) lead.source = source.trim();

    // Assignee change check (authorized for owners/admins)
    if (isOwnerOrAdmin && assignedToId !== undefined) {
      const oldRepId = lead.assignedToId ? lead.assignedToId.toString() : null;
      let newRepId = null;
      let newRepName = "Unassigned";

      if (assignedToId && assignedToId !== "unassigned") {
        const rep = await tenantModels.TeamMember.findById(assignedToId);
        if (!rep) {
          return res.status(400).json({ success: false, message: "Representative not found." });
        }
        if (rep.role === "owner") {
          return res.status(400).json({
            success: false,
            code: "OWNER_ASSIGNMENT_NOT_ALLOWED",
            message: "Leads cannot be assigned to the organization owner.",
          });
        }
        if (rep.status !== "active") {
          return res.status(400).json({ success: false, message: "Representative is not active." });
        }
        newRepId = rep._id.toString();
        newRepName = rep.name;
        lead.assignedToId = rep._id;
      } else {
        lead.assignedToId = null;
      }

      lead.assignedToName = newRepName;
      lead.assignedTo = newRepName;

      // Accurately synchronize assigned counts without drift
      if (oldRepId !== newRepId) {
        if (oldRepId) {
          await tenantModels.TeamMember.updateOne(
            { _id: oldRepId, assignedLeadsCount: { $gt: 0 } },
            { $inc: { assignedLeadsCount: -1 } }
          );
        }
        if (newRepId) {
          await tenantModels.TeamMember.updateOne(
            { _id: newRepId },
            { $inc: { assignedLeadsCount: 1 } }
          );
        }
      }
    }

    if (collectedData) {
      lead.collectedData = {
        interestedProduct: collectedData.interestedProduct !== undefined ? collectedData.interestedProduct : lead.collectedData?.interestedProduct,
        budgetRange: collectedData.budgetRange !== undefined ? collectedData.budgetRange : lead.collectedData?.budgetRange,
        deliveryCity: collectedData.deliveryCity !== undefined ? collectedData.deliveryCity : lead.collectedData?.deliveryCity,
      };
    }

    if (Array.isArray(notes)) {
      lead.notes = notes;
    }

    if (aiHandled !== undefined) lead.aiHandled = Boolean(aiHandled);
    if (needsAttention !== undefined) lead.needsAttention = Boolean(needsAttention);
    lead.lastContactAt = new Date();

    await lead.save();

    const doc = lead.toObject();
    return res.json({
      success: true,
      message: "Lead details updated successfully.",
      lead: { ...doc, id: doc._id.toString() },
    });
  } catch (err) {
    console.error("[Update Lead Error]", err);
    return res.status(500).json({ success: false, message: "Failed to update lead." });
  }
}

/**
 * POST /api/leads/:id/assign
 * Assigns or reassigns a lead to an active sales representative.
 * Restricted to organization owners and admins; maintains exact rep counts.
 */
export async function assignLead(req, res) {
  try {
    const { tenantModels } = req;
    const isOwnerOrAdmin = req.user?.role === "admin" || req.membership?.role === "owner";
    if (!isOwnerOrAdmin) {
      return res.status(403).json({
        success: false,
        message: "Only organization owners and administrators can assign or reassign leads.",
      });
    }

    const { assignedToId } = req.body;
    const lead = await tenantModels.Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ success: false, message: "Lead not found." });
    }

    const oldRepId = lead.assignedToId ? lead.assignedToId.toString() : null;

    if (!assignedToId || assignedToId === "unassigned") {
      lead.assignedToId = null;
      lead.assignedToName = "Unassigned";
      lead.assignedTo = "Unassigned";
      await lead.save();

      // Decrement previous rep count if was assigned
      if (oldRepId) {
        await tenantModels.TeamMember.updateOne(
          { _id: oldRepId, assignedLeadsCount: { $gt: 0 } },
          { $inc: { assignedLeadsCount: -1 } }
        );
      }

      const doc = lead.toObject();
      return res.json({
        success: true,
        message: "Lead unassigned successfully.",
        lead: { ...doc, id: doc._id.toString() },
      });
    }

    const rep = await tenantModels.TeamMember.findById(assignedToId);
    if (!rep) {
      return res.status(400).json({ success: false, message: "Representative not found." });
    }
    if (rep.role === "owner") {
      return res.status(400).json({
        success: false,
        code: "OWNER_ASSIGNMENT_NOT_ALLOWED",
        message: "Leads cannot be assigned to the organization owner.",
      });
    }
    if (rep.status !== "active") {
      return res.status(400).json({
        success: false,
        message: "Cannot assign to an inactive sales representative.",
      });
    }

    const newRepId = rep._id.toString();
    lead.assignedToId = rep._id;
    lead.assignedToName = rep.name;
    lead.assignedTo = rep.name;
    await lead.save();

    // Accurately synchronize counts
    if (oldRepId !== newRepId) {
      if (oldRepId) {
        await tenantModels.TeamMember.updateOne(
          { _id: oldRepId, assignedLeadsCount: { $gt: 0 } },
          { $inc: { assignedLeadsCount: -1 } }
        );
      }
      await tenantModels.TeamMember.updateOne(
        { _id: rep._id },
        { $inc: { assignedLeadsCount: 1 } }
      );
    }

    const doc = lead.toObject();
    return res.json({
      success: true,
      message: `Lead assigned to ${rep.name}.`,
      lead: { ...doc, id: doc._id.toString() },
    });
  } catch (err) {
    console.error("[Assign Lead Error]", err);
    return res.status(500).json({ success: false, message: "Failed to assign lead." });
  }
}

/**
 * POST /api/leads/bulk-assign
 * Bulk assigns multiple leads to an active sales representative.
 * Restricted to organization owners and admins; maintains exact rep counts.
 */
export async function bulkAssignLeads(req, res) {
  try {
    const { tenantModels } = req;
    const isOwnerOrAdmin = req.user?.role === "admin" || req.membership?.role === "owner";
    if (!isOwnerOrAdmin) {
      return res.status(403).json({
        success: false,
        message: "Only organization owners and administrators can bulk assign leads.",
      });
    }

    const { leadIds, assignedToId } = req.body;

    if (!Array.isArray(leadIds) || leadIds.length === 0) {
      return res.status(400).json({ success: false, message: "leadIds array is required." });
    }

    let targetId = null;
    let targetName = "Unassigned";

    if (assignedToId && assignedToId !== "unassigned") {
      const rep = await tenantModels.TeamMember.findById(assignedToId);
      if (!rep) {
        return res.status(400).json({ success: false, message: "Representative not found." });
      }
      if (rep.role === "owner") {
        return res.status(400).json({
          success: false,
          code: "OWNER_ASSIGNMENT_NOT_ALLOWED",
          message: "Leads cannot be assigned to the organization owner.",
        });
      }
      if (rep.status !== "active") {
        return res.status(400).json({ success: false, message: "Representative is not active." });
      }
      targetId = rep._id;
      targetName = rep.name;
    }

    // Find all leads that match the requested IDs
    const foundLeads = await tenantModels.Lead.find({ _id: { $in: leadIds } });

    const oldCounts = {};
    let newRepInc = 0;
    const leadsToChange = [];

    const targetIdStr = targetId ? targetId.toString() : null;

    for (const l of foundLeads) {
      const oldIdStr = l.assignedToId ? l.assignedToId.toString() : null;
      if (oldIdStr !== targetIdStr) {
        leadsToChange.push(l._id);
        if (oldIdStr) {
          oldCounts[oldIdStr] = (oldCounts[oldIdStr] || 0) + 1;
        }
        if (targetIdStr) {
          newRepInc++;
        }
      }
    }

    if (leadsToChange.length > 0) {
      await tenantModels.Lead.updateMany(
        { _id: { $in: leadsToChange } },
        {
          $set: {
            assignedToId: targetId,
            assignedToName: targetName,
            assignedTo: targetName,
          },
        }
      );

      // Decrement counts from old assignees
      for (const [oldRepId, dec] of Object.entries(oldCounts)) {
        await tenantModels.TeamMember.updateOne(
          { _id: oldRepId, assignedLeadsCount: { $gt: 0 } },
          { $inc: { assignedLeadsCount: -dec } }
        );
      }

      // Increment count on target representative
      if (targetId && newRepInc > 0) {
        await tenantModels.TeamMember.updateOne(
          { _id: targetId },
          { $inc: { assignedLeadsCount: newRepInc } }
        );
      }
    }

    return res.json({
      success: true,
      message: `Successfully assigned ${leadsToChange.length} leads to ${targetName}.`,
      updatedCount: leadsToChange.length,
    });
  } catch (err) {
    console.error("[Bulk Assign Error]", err);
    return res.status(500).json({ success: false, message: "Failed to bulk assign leads." });
  }
}

/**
 * POST /api/leads/bulk-status
 * Bulk updates the pipeline stage for selected leads with role enforcement
 */
export async function bulkStatusUpdate(req, res) {
  try {
    const { tenantModels } = req;
    const { leadIds, status } = req.body;

    if (!Array.isArray(leadIds) || leadIds.length === 0) {
      return res.status(400).json({ success: false, message: "leadIds array is required." });
    }

    const cleanStatus = normalizeStatus(status);
    const isOwnerOrAdmin = req.user?.role === "admin" || req.membership?.role === "owner";

    const updateFilter = { _id: { $in: leadIds } };

    // Salespeople can only update status for their own assigned leads unless authorized
    if (!isOwnerOrAdmin) {
      if (req.membership?.role === "salesperson") {
        const canViewAll = Boolean(req.membership?.canViewAllLeads);
        if (!canViewAll) {
          const userEmail = req.user.email.toLowerCase().trim();
          const rep = await tenantModels.TeamMember.findOne({ email: userEmail });
          if (!rep) {
            return res.status(403).json({ success: false, message: "Sales representative record not found." });
          }
          updateFilter.assignedToId = rep._id;
        }
      } else {
        return res.status(403).json({ success: false, message: "Unauthorized to update lead statuses." });
      }
    }

    const result = await tenantModels.Lead.updateMany(
      updateFilter,
      { $set: { status: cleanStatus } }
    );

    return res.json({
      success: true,
      message: `Updated status for ${result.modifiedCount} leads to "${cleanStatus}".`,
      updatedCount: result.modifiedCount,
    });
  } catch (err) {
    console.error("[Bulk Status Error]", err);
    return res.status(500).json({ success: false, message: "Failed to bulk update lead status." });
  }
}

/**
 * DELETE /api/leads/:id
 * Deletes a lead (owner authorized) and decrements assignee count
 */
export async function deleteLead(req, res) {
  try {
    const { tenantModels } = req;
    if (req.membership?.role !== "owner" && req.user.role !== "admin") {
      return res.status(403).json({ success: false, message: "Only organization owners can delete leads." });
    }

    const lead = await tenantModels.Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ success: false, message: "Lead not found." });
    }

    // Decrement assignee count if lead was assigned
    if (lead.assignedToId) {
      await tenantModels.TeamMember.updateOne(
        { _id: lead.assignedToId, assignedLeadsCount: { $gt: 0 } },
        { $inc: { assignedLeadsCount: -1 } }
      );
    }

    await tenantModels.Lead.deleteOne({ _id: lead._id });

    return res.json({
      success: true,
      message: "Lead removed from workspace.",
    });
  } catch (err) {
    console.error("[Delete Lead Error]", err);
    return res.status(500).json({ success: false, message: "Failed to delete lead." });
  }
}
