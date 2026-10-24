import {
  getOrganizationSeatUsage,
  createTeamInvitation,
  resendTeamInvitation,
  revokeTeamInvitation,
  verifyInvitationToken,
  acceptTeamInvitation,
  updateMemberStatus,
  removeMember,
} from "../helpers/teamService.js";
import { Invitation } from "../models/platform/Invitation.js";

/**
 * GET /api/team
 * Lists active/paused/disabled team members, pending invitations, and current seat usage
 */
export async function listTeam(req, res) {
  try {
    const { tenantModels, organization } = req;
    if (!tenantModels || !organization) {
      return res.status(400).json({ success: false, message: "Workspace database unavailable." });
    }

    // 1. Fetch team members (excluding removed)
    const members = await tenantModels.TeamMember.find({
      status: { $ne: "removed" },
    }).sort({ role: 1, name: 1 });

    const serializedMembers = members.map((m) => ({
      id: m._id.toString(),
      name: m.name,
      email: m.email,
      phone: m.phone,
      role: m.role,
      status: m.status,
      canViewAllLeads: Boolean(m.canViewAllLeads),
      assignedLeadsCount: m.assignedLeadsCount || 0,
      createdAt: m.createdAt,
    }));

    // 2. Fetch pending invitations
    const pendingInvites = await Invitation.find({
      organizationId: organization._id,
      status: "pending",
      expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 });

    const serializedInvites = pendingInvites.map((inv) => ({
      id: inv._id.toString(),
      name: inv.name,
      email: inv.email,
      phone: inv.phone,
      role: inv.role,
      status: inv.status,
      expiresAt: inv.expiresAt,
      createdAt: inv.createdAt,
    }));

    // 3. Compute seat usage
    const seatUsage = await getOrganizationSeatUsage(organization._id, tenantModels);

    return res.json({
      success: true,
      members: serializedMembers,
      invitations: serializedInvites,
      seatUsage,
    });
  } catch (err) {
    console.error("[List Team Error]", err);
    return res.status(500).json({ success: false, message: "Failed to load team data." });
  }
}

/**
 * POST /api/team/invitations
 * Creates and delivers a sales representative invitation within seat capacity
 */
export async function inviteTeamMember(req, res) {
  try {
    const { tenantModels, organization, user } = req;
    if (!tenantModels || !organization) {
      return res.status(400).json({ success: false, message: "Workspace database unavailable." });
    }

    const { name, email, phone } = req.body;

    const result = await createTeamInvitation({
      organization,
      inviterUser: user,
      name,
      email,
      phone,
      tenantModels,
    });

    return res.status(201).json({
      success: true,
      message: `Invitation successfully sent to ${result.rep.name} (${result.rep.email}).`,
      invitation: {
        id: result.invitation._id.toString(),
        name: result.invitation.name,
        email: result.invitation.email,
        phone: result.invitation.phone,
        status: result.invitation.status,
        expiresAt: result.invitation.expiresAt,
      },
      inviteLink: result.inviteLink,
      seatUsage: result.seatUsage,
      rep: result.rep,
    });
  } catch (err) {
    const isLimit = err.message && err.message.includes("limit");
    return res.status(isLimit ? 403 : 400).json({
      success: false,
      code: isLimit ? "SEAT_LIMIT_REACHED" : "INVITE_FAILED",
      message: err.message || "Failed to invite team member.",
    });
  }
}

/**
 * POST /api/team/invitations/:id/resend
 * Resends a valid pending invitation
 */
export async function resendInvite(req, res) {
  try {
    const { tenantModels, organization, user } = req;
    const { id } = req.params;

    const result = await resendTeamInvitation({
      invitationId: id,
      organizationId: organization._id,
      inviterUser: user,
      tenantModels,
      organizationName: organization.name,
    });

    return res.json({
      success: true,
      message: `Invitation resent successfully to ${result.invitation.email}.`,
      invitation: {
        id: result.invitation._id.toString(),
        name: result.invitation.name,
        email: result.invitation.email,
        status: result.invitation.status,
        expiresAt: result.invitation.expiresAt,
      },
      inviteLink: result.inviteLink,
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      message: err.message || "Failed to resend invitation.",
    });
  }
}

/**
 * POST /api/team/invitations/:id/revoke
 * Revokes an invitation and immediately releases its reserved seat
 */
export async function revokeInvite(req, res) {
  try {
    const { tenantModels, organization } = req;
    const { id } = req.params;

    const result = await revokeTeamInvitation({
      invitationId: id,
      organizationId: organization._id,
      tenantModels,
    });

    return res.json({
      success: true,
      message: "Invitation revoked and seat reservation released successfully.",
      seatUsage: result.seatUsage,
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      message: err.message || "Failed to revoke invitation.",
    });
  }
}

/**
 * GET /api/team/invitations/verify
 * Public endpoint to verify token validity before showing acceptance page
 */
export async function verifyInvite(req, res) {
  try {
    const { token } = req.query;
    const result = await verifyInvitationToken(token);

    if (!result.valid) {
      return res.status(400).json({
        success: false,
        message: result.error,
      });
    }

    return res.json({
      success: true,
      invitation: result.invitation,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Failed to verify invitation token.",
    });
  }
}

/**
 * POST /api/team/invitations/accept
 * Public endpoint to accept invitation and activate account
 */
export async function acceptInvite(req, res) {
  try {
    const { token, password, fullName } = req.body;

    const result = await acceptTeamInvitation({
      token,
      password,
      fullName,
      res,
    });

    return res.json({
      success: true,
      message: "Invitation accepted successfully! Welcome to your sales workspace.",
      user: result.user,
      organization: result.organization,
    });
  } catch (err) {
    const isLimit = err.message && err.message.includes("limit");
    return res.status(isLimit ? 403 : 400).json({
      success: false,
      code: isLimit ? "SEAT_LIMIT_REACHED" : "ACCEPT_FAILED",
      message: err.message || "Failed to accept invitation.",
    });
  }
}

/**
 * PATCH /api/team/:memberId/status
 * Updates team member status (active, paused, disabled)
 */
export async function changeMemberStatus(req, res) {
  try {
    const { tenantModels, organization } = req;
    const { memberId } = req.params;
    const { status } = req.body;

    const result = await updateMemberStatus({
      memberId,
      status,
      organizationId: organization._id,
      tenantModels,
    });

    return res.json({
      success: true,
      message: `Representative status updated to "${status}".`,
      member: result.member,
      seatUsage: result.seatUsage,
    });
  } catch (err) {
    const isLimit = err.message && err.message.includes("limit");
    return res.status(isLimit ? 403 : 400).json({
      success: false,
      code: isLimit ? "SEAT_LIMIT_REACHED" : "STATUS_UPDATE_FAILED",
      message: err.message || "Failed to update member status.",
    });
  }
}

/**
 * DELETE /api/team/:memberId
 * Removes a representative with lead reassignment / unassignment
 */
export async function deleteTeamMember(req, res) {
  try {
    const { tenantModels, organization } = req;
    const { memberId } = req.params;
    const { reassignOption, reassignTargetId } = req.body;

    const result = await removeMember({
      memberId,
      reassignOption: reassignOption || "unassign",
      reassignTargetId,
      organizationId: organization._id,
      tenantModels,
    });

    return res.json({
      success: true,
      message: `Representative removed successfully.${
        result.reassignedCount > 0
          ? ` ${result.reassignedCount} leads reallocated.`
          : ""
      }`,
      reassignedCount: result.reassignedCount,
      seatUsage: result.seatUsage,
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      message: err.message || "Failed to remove team member.",
    });
  }
}
