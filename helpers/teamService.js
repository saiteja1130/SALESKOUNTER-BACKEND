import { env } from "../configs/env.js";
import { getTenantDB } from "../configs/db.js";
import { getTenantModels } from "../models/tenant/schemas.js";
import { User } from "../models/platform/User.js";
import { Organization } from "../models/platform/Organization.js";
import { OrganizationMember } from "../models/platform/OrganizationMember.js";
import { Subscription } from "../models/platform/Subscription.js";
import { Invitation } from "../models/platform/Invitation.js";
import { Session } from "../models/platform/Session.js";
import { computeEntitlements } from "./entitlements.js";
import { generateRandomToken, hashPassword } from "./crypto.js";
import { sendInvitationEmail } from "./emailService.js";

/**
 * Calculates current seat limits and usage for an organization.
 * Owner is NEVER counted as a rep seat.
 * Active reps, paused reps, and pending valid invitations count towards reserved seats.
 * Expired, revoked invites, and disabled or removed reps do NOT count.
 */
export async function getOrganizationSeatUsage(organizationId, tenantModels) {
  const subscription = await Subscription.findOne({ organizationId });
  const entitlements = computeEntitlements(subscription);
  const maxAllowed = entitlements.maxSalesReps;

  // 1. Count active and paused reps in tenant DB (owner excluded)
  const currentReps = await tenantModels.TeamMember.countDocuments({
    role: "salesperson",
    status: { $in: ["active", "paused"] },
  });

  // 2. Count pending non-expired invitations in platform DB
  const pendingInvites = await Invitation.countDocuments({
    organizationId,
    status: "pending",
    expiresAt: { $gt: new Date() },
  });

  const currentUsed = currentReps + pendingInvites;
  const available = Math.max(0, maxAllowed - currentUsed);

  return {
    maxAllowed,
    currentUsed,
    available,
    currentReps,
    pendingInvites,
    plan: subscription?.plan || "trial",
    repAddons: subscription?.repAddons || 0,
    isReadOnly: entitlements.isReadOnly,
  };
}

/**
 * Creates an organization-scoped sales representative invitation.
 * Checks seat capacity atomically and delivers the invite email before committing state.
 */
export async function createTeamInvitation({
  organization,
  inviterUser,
  name,
  email,
  phone,
  tenantModels,
}) {
  const cleanName = (name || "").trim();
  const cleanEmail = (email || "").toLowerCase().trim();
  const cleanPhone = (phone || "").trim();

  if (!cleanName) {
    throw new Error("Full name is required.");
  }
  if (!cleanEmail || !cleanEmail.includes("@")) {
    throw new Error("A valid email address is required.");
  }

  // 1. Exclude owner
  const ownerUser = await User.findById(organization.ownerId);
  if (ownerUser && ownerUser.email.toLowerCase() === cleanEmail) {
    throw new Error("The organization owner cannot be invited as a sales representative.");
  }

  // 2. Check if already active/paused on team
  const existingActiveRep = await tenantModels.TeamMember.findOne({
    email: cleanEmail,
    status: { $in: ["active", "paused"] },
  });
  if (existingActiveRep) {
    throw new Error(`A team member with email "${cleanEmail}" is already active in your sales team.`);
  }

  // 3. Check for existing pending invitation
  const existingPendingInvite = await Invitation.findOne({
    organizationId: organization._id,
    email: cleanEmail,
    status: "pending",
    expiresAt: { $gt: new Date() },
  });
  if (existingPendingInvite) {
    throw new Error(
      `An active invitation for "${cleanEmail}" is already pending. You can resend the existing invitation.`
    );
  }

  // 4. Check seat capacity atomically
  const seatUsage = await getOrganizationSeatUsage(organization._id, tenantModels);
  if (seatUsage.available <= 0) {
    throw new Error(
      `Sales rep seat limit reached for your current subscription plan (${seatUsage.maxAllowed} maximum allowed). Upgrade your plan or add rep add-ons to invite more team members.`
    );
  }

  // 5. Generate secure one-time invitation token
  const token = generateRandomToken(32);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  const inviteLink = `${env.FRONTEND_URL}/accept-invite?token=${token}`;

  // 6. Deliver invitation email first to avoid misleading 'sent' state on failure
  await sendInvitationEmail({
    to: cleanEmail,
    name: cleanName,
    inviterName: inviterUser?.name || "Workspace Administrator",
    organizationName: organization.name,
    inviteLink,
  });

  // 7. Save invitation record in platform DB
  const invitation = await Invitation.create({
    organizationId: organization._id,
    inviterId: inviterUser._id,
    name: cleanName,
    email: cleanEmail,
    phone: cleanPhone,
    role: "salesperson",
    token,
    status: "pending",
    expiresAt,
  });

  // 8. Create or update invited record in tenant DB
  let tenantRep = await tenantModels.TeamMember.findOne({ email: cleanEmail });
  if (tenantRep) {
    tenantRep.name = cleanName;
    if (cleanPhone) tenantRep.phone = cleanPhone;
    tenantRep.status = "invited";
    await tenantRep.save();
  } else {
    tenantRep = await tenantModels.TeamMember.create({
      name: cleanName,
      email: cleanEmail,
      phone: cleanPhone,
      role: "salesperson",
      status: "invited",
      canViewAllLeads: false,
    });
  }

  const updatedUsage = await getOrganizationSeatUsage(organization._id, tenantModels);

  return {
    invitation,
    inviteLink,
    seatUsage: updatedUsage,
    rep: {
      id: tenantRep._id.toString(),
      name: tenantRep.name,
      email: tenantRep.email,
      phone: tenantRep.phone,
      status: tenantRep.status,
    },
  };
}

/**
 * Resends a valid pending invitation with a refreshed token and expiration
 */
export async function resendTeamInvitation({
  invitationId,
  organizationId,
  inviterUser,
  tenantModels,
  organizationName,
}) {
  const invitation = await Invitation.findOne({
    _id: invitationId,
    organizationId,
    status: "pending",
  });

  if (!invitation) {
    throw new Error("Pending invitation not found or already accepted/revoked.");
  }

  const token = generateRandomToken(32);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const inviteLink = `${env.FRONTEND_URL}/accept-invite?token=${token}`;

  // Deliver refreshed email
  await sendInvitationEmail({
    to: invitation.email,
    name: invitation.name,
    inviterName: inviterUser?.name || "Workspace Administrator",
    organizationName: organizationName || "Conversly",
    inviteLink,
  });

  invitation.token = token;
  invitation.expiresAt = expiresAt;
  await invitation.save();

  return { invitation, inviteLink };
}

/**
 * Revokes a pending invitation and immediately releases its reserved seat
 */
export async function revokeTeamInvitation({
  invitationId,
  organizationId,
  tenantModels,
}) {
  const invitation = await Invitation.findOne({
    _id: invitationId,
    organizationId,
    status: "pending",
  });

  if (!invitation) {
    throw new Error("Pending invitation not found or is no longer active.");
  }

  invitation.status = "revoked";
  await invitation.save();

  // In tenant DB, mark invited record as removed or disabled
  await tenantModels.TeamMember.updateOne(
    { email: invitation.email, status: "invited" },
    { $set: { status: "removed" } }
  );

  const seatUsage = await getOrganizationSeatUsage(organizationId, tenantModels);
  return { success: true, seatUsage };
}

/**
 * Verifies an invitation token and returns preview metadata for the acceptance page
 */
export async function verifyInvitationToken(token) {
  if (!token) {
    return { valid: false, error: "Missing invitation token." };
  }

  const invitation = await Invitation.findOne({ token });
  if (!invitation) {
    return { valid: false, error: "Invalid or nonexistent invitation token." };
  }

  if (invitation.status === "revoked") {
    return { valid: false, error: "This invitation has been revoked by the workspace administrator." };
  }

  if (invitation.status === "accepted") {
    return { valid: false, error: "This invitation has already been accepted. Please sign in to your account." };
  }

  if (new Date(invitation.expiresAt) < new Date()) {
    invitation.status = "expired";
    await invitation.save();
    return { valid: false, error: "This invitation link has expired. Please contact the administrator to resend it." };
  }

  const org = await Organization.findById(invitation.organizationId);
  if (!org) {
    return { valid: false, error: "Organization workspace not found." };
  }

  // Check seat capacity in case organization downgraded while invite was pending
  const tenantDb = getTenantDB(org.tenantDbName);
  const tenantModels = getTenantModels(tenantDb);
  const seatUsage = await getOrganizationSeatUsage(org._id, tenantModels);

  if (seatUsage.available <= 0) {
    return {
      valid: false,
      error: "The organization has reached its maximum sales rep seat limit. Please ask the owner to upgrade seats before joining.",
    };
  }

  // Check if an existing platform account exists for this email
  const existingUser = await User.findOne({ email: invitation.email });

  return {
    valid: true,
    invitation: {
      id: invitation._id.toString(),
      name: invitation.name,
      email: invitation.email,
      phone: invitation.phone,
      role: invitation.role,
      organizationName: org.name,
      organizationSlug: org.slug,
      organizationId: org._id.toString(),
      hasExistingAccount: Boolean(existingUser),
    },
  };
}

/**
 * Accepts an invitation: activates user account, adds organization membership,
 * links tenant TeamMember, marks invitation accepted, and provisions a session.
 */
export async function acceptTeamInvitation({
  token,
  password,
  fullName,
  res,
}) {
  const verified = await verifyInvitationToken(token);
  if (!verified.valid) {
    throw new Error(verified.error);
  }

  const invitation = await Invitation.findOne({ token, status: "pending" });
  if (!invitation) {
    throw new Error("Invitation record is no longer available.");
  }

  const org = await Organization.findById(invitation.organizationId);
  if (!org) {
    throw new Error("Organization workspace not found.");
  }

  const tenantDb = getTenantDB(org.tenantDbName);
  const tenantModels = getTenantModels(tenantDb);

  // Re-verify seat capacity atomically
  const seatUsage = await getOrganizationSeatUsage(org._id, tenantModels);
  if (seatUsage.available <= 0) {
    throw new Error(
      "The organization has reached its maximum sales rep seat limit. Please ask the owner to upgrade seats."
    );
  }

  // 1. Resolve or Create Platform User
  let user = await User.findOne({ email: invitation.email });
  if (!user) {
    if (!password || password.length < 6) {
      throw new Error("Please provide a secure password of at least 6 characters.");
    }
    const passwordHash = await hashPassword(password);
    user = await User.create({
      name: (fullName || invitation.name).trim(),
      email: invitation.email,
      passwordHash,
      role: "salesperson",
      isVerified: true,
    });
  }

  // 2. Add or update OrganizationMember
  let membership = await OrganizationMember.findOne({
    organizationId: org._id,
    userId: user._id,
  });

  if (!membership) {
    membership = await OrganizationMember.create({
      organizationId: org._id,
      userId: user._id,
      role: "salesperson",
      status: "active",
      canViewAllLeads: false,
    });
  } else {
    membership.status = "active";
    await membership.save();
  }

  // 3. Link or activate tenant TeamMember
  let tenantRep = await tenantModels.TeamMember.findOne({ email: invitation.email });
  if (tenantRep) {
    tenantRep.name = user.name;
    tenantRep.status = "active";
    if (invitation.phone) tenantRep.phone = invitation.phone;
    await tenantRep.save();
  } else {
    tenantRep = await tenantModels.TeamMember.create({
      name: user.name,
      email: invitation.email,
      phone: invitation.phone || "",
      role: "salesperson",
      status: "active",
      canViewAllLeads: false,
    });
  }

  // 4. Mark invitation as accepted
  invitation.status = "accepted";
  invitation.acceptedAt = new Date();
  invitation.acceptedByUserId = user._id;
  await invitation.save();

  // 5. Establish authenticated session with single-login enforcement
  await Session.deleteMany({ userId: user._id });
  const sessionToken = generateRandomToken(48);
  const sessionExpiresAt = new Date(Date.now() + env.SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);

  await Session.create({
    userId: user._id,
    organizationId: org._id,
    token: sessionToken,
    expiresAt: sessionExpiresAt,
  });

  if (res) {
    res.cookie(env.SESSION_COOKIE_NAME, sessionToken, {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: env.SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
      path: "/",
    });
  }

  return {
    success: true,
    user: {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      role: membership.role,
      isVerified: user.isVerified,
      canViewAllLeads: false,
    },
    organization: {
      id: org._id.toString(),
      name: org.name,
      slug: org.slug,
    },
  };
}

/**
 * Changes a sales representative's status (active, paused, disabled)
 */
export async function updateMemberStatus({
  memberId,
  status,
  organizationId,
  tenantModels,
}) {
  const allowed = ["active", "paused", "disabled"];
  if (!allowed.includes(status)) {
    throw new Error(`Invalid status "${status}". Allowed values: ${allowed.join(", ")}`);
  }

  const member = await tenantModels.TeamMember.findById(memberId);
  if (!member) {
    throw new Error("Team member not found.");
  }

  if (member.role === "owner") {
    throw new Error("The organization owner's status cannot be paused or disabled.");
  }

  // If reactivating from disabled, verify seat capacity
  if (member.status === "disabled" && (status === "active" || status === "paused")) {
    const seatUsage = await getOrganizationSeatUsage(organizationId, tenantModels);
    if (seatUsage.available <= 0) {
      throw new Error(
        `Cannot activate representative. Seat limit reached (${seatUsage.maxAllowed} maximum allowed). Upgrade your plan or purchase rep add-ons.`
      );
    }
  }

  member.status = status;
  await member.save();

  // Synchronize platform OrganizationMember if linked
  const user = await User.findOne({ email: member.email });
  if (user) {
    await OrganizationMember.updateOne(
      { organizationId, userId: user._id },
      { $set: { status } }
    );
  }

  const seatUsage = await getOrganizationSeatUsage(organizationId, tenantModels);

  return {
    member: {
      id: member._id.toString(),
      name: member.name,
      email: member.email,
      phone: member.phone,
      role: member.role,
      status: member.status,
      assignedLeadsCount: member.assignedLeadsCount,
    },
    seatUsage,
  };
}

/**
 * Removes a representative with atomic lead reassignment or unassignment
 */
export async function removeMember({
  memberId,
  reassignOption,
  reassignTargetId,
  organizationId,
  tenantModels,
}) {
  const member = await tenantModels.TeamMember.findById(memberId);
  if (!member) {
    throw new Error("Team member not found.");
  }

  if (member.role === "owner") {
    throw new Error("The organization owner cannot be removed from the team.");
  }

  // 1. Reassign or Unassign existing assigned leads
  const assignedLeads = await tenantModels.Lead.find({ assignedToId: member._id });

  if (assignedLeads.length > 0) {
    if (reassignOption === "reassign") {
      if (!reassignTargetId) {
        throw new Error("A target representative is required when selecting reassignment.");
      }
      const targetRep = await tenantModels.TeamMember.findById(reassignTargetId);
      if (!targetRep || targetRep.status !== "active" || targetRep.role === "owner" || String(targetRep._id) === String(member._id)) {
        throw new Error("Selected target representative is invalid, inactive, or is the owner.");
      }

      await tenantModels.Lead.updateMany(
        { assignedToId: member._id },
        {
          $set: {
            assignedToId: targetRep._id,
            assignedToName: targetRep.name,
            assignedTo: targetRep.name,
          },
        }
      );

      await tenantModels.TeamMember.updateOne(
        { _id: targetRep._id },
        { $inc: { assignedLeadsCount: assignedLeads.length } }
      );
    } else {
      // Unassign leads
      await tenantModels.Lead.updateMany(
        { assignedToId: member._id },
        {
          $set: {
            assignedToId: null,
            assignedToName: "Unassigned",
            assignedTo: "Unassigned",
          },
        }
      );
    }
  }

  // 2. Mark member removed
  member.status = "removed";
  member.assignedLeadsCount = 0;
  await member.save();

  // 3. Update OrganizationMember in platform DB
  const user = await User.findOne({ email: member.email });
  if (user) {
    await OrganizationMember.updateOne(
      { organizationId, userId: user._id },
      { $set: { status: "removed" } }
    );
  }

  const seatUsage = await getOrganizationSeatUsage(organizationId, tenantModels);

  return {
    success: true,
    reassignedCount: assignedLeads.length,
    seatUsage,
  };
}
