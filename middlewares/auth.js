import { env } from "../configs/env.js";
import { isDbConnected, getTenantDB } from "../configs/db.js";
import { Session } from "../models/platform/Session.js";
import { User } from "../models/platform/User.js";
import { Organization } from "../models/platform/Organization.js";
import { OrganizationMember } from "../models/platform/OrganizationMember.js";
import { Subscription } from "../models/platform/Subscription.js";
import { getTenantModels } from "../models/tenant/schemas.js";
import { computeEntitlements } from "../helpers/entitlements.js";

/**
 * Require valid authenticated session with single-login verification
 */
export async function requireAuth(req, res, next) {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection unavailable. Please verify MONGODB_URI in BACKEND/.env.",
      });
    }

    const token = req.cookies[env.SESSION_COOKIE_NAME];
    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Authentication required. Please sign in.",
      });
    }

    // Look up session in platform DB
    const session = await Session.findOne({ token });
    if (!session || new Date(session.expiresAt) < new Date()) {
      return res.status(401).json({
        success: false,
        code: "SESSION_EXPIRED",
        message: "Your session has expired or you signed in from another window/device.",
      });
    }

    // Resolve user
    const user = await User.findById(session.userId);
    if (!user) {
      await Session.deleteOne({ _id: session._id });
      return res.status(401).json({
        success: false,
        message: "User account no longer exists.",
      });
    }

    // If user is a standalone platform administrator without an organization
    if (user.role === "admin" && !session.organizationId) {
      req.user = user;
      req.membership = null;
      req.organization = null;
      req.subscription = null;
      req.entitlements = null;
      req.tenantDb = null;
      req.tenantModels = null;
      req.sessionToken = token;
      return next();
    }

    // Resolve organization membership
    const membership = await OrganizationMember.findOne({
      userId: user._id,
      organizationId: session.organizationId,
      status: "active",
    });

    if (!membership && user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "You are not an active member of this organization.",
      });
    }

    // Resolve organization
    const organization = session.organizationId
      ? await Organization.findById(session.organizationId)
      : null;

    if (!organization && user.role !== "admin") {
      return res.status(404).json({
        success: false,
        message: "Organization not found.",
      });
    }

    // Resolve subscription and entitlements
    const subscription = organization
      ? await Subscription.findOne({ organizationId: organization._id })
      : null;
    const entitlements = subscription ? computeEntitlements(subscription) : null;

    // Resolve tenant DB on shared cluster
    const tenantDb = organization ? getTenantDB(organization.tenantDbName) : null;
    const tenantModels = tenantDb ? getTenantModels(tenantDb) : null;

    // Attach to request
    req.user = user;
    req.membership = membership;
    req.organization = organization;
    req.subscription = subscription;
    req.entitlements = entitlements;
    req.tenantDb = tenantDb;
    req.tenantModels = tenantModels;
    req.sessionToken = token;

    next();
  } catch (err) {
    console.error("[Auth Middleware Error]", err);
    res.status(500).json({
      success: false,
      message: "Internal server error during authentication verification.",
    });
  }
}

/**
 * Require system platform administrator privileges
 */
export function requirePlatformAdmin(req, res, next) {
  if (req.user?.role === "admin") {
    return next();
  }
  return res.status(403).json({
    success: false,
    message: "Platform administrator access required.",
  });
}

/**
 * Require organization owner (or platform admin) for organization-level actions
 */
export function requireOwnerOrAdmin(req, res, next) {
  if (req.user?.role === "admin" || req.membership?.role === "owner") {
    return next();
  }
  return res.status(403).json({
    success: false,
    message: "Admin or Organization Owner privileges required for this action.",
  });
}
