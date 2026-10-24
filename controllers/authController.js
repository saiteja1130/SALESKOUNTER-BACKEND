import mongoose from "mongoose";
import { env } from "../configs/env.js";
import { isDbConnected, getTenantDB } from "../configs/db.js";
import { User } from "../models/platform/User.js";
import { Organization } from "../models/platform/Organization.js";
import { OrganizationMember } from "../models/platform/OrganizationMember.js";
import { Subscription } from "../models/platform/Subscription.js";
import { Session } from "../models/platform/Session.js";
import { getTenantModels } from "../models/tenant/schemas.js";
import {
  hashPassword,
  verifyPassword,
  generateRandomToken,
  slugify,
} from "../helpers/crypto.js";

function formatOrgOnboarding(onboarding) {
  if (!onboarding) return { status: "not_started", currentStep: 1 };
  return {
    status: onboarding.status || "not_started",
    currentStep: onboarding.currentStep || 1,
    aiPersonality: {
      status: onboarding.aiPersonality?.status || "pending",
      companyName: onboarding.aiPersonality?.companyName || "",
      tone: onboarding.aiPersonality?.tone || "Professional & Courteous",
      welcomeMessage: onboarding.aiPersonality?.welcomeMessage || "",
      services: onboarding.aiPersonality?.services || [],
    },
    geminiSetup: {
      status: onboarding.geminiSetup?.status || "pending",
      isConfigured: Boolean(onboarding.geminiSetup?.apiKeyEncrypted),
    },
    inviteRep: {
      status: onboarding.inviteRep?.status || "pending",
      invitedReps: (onboarding.inviteRep?.invitedReps || []).map((r) => ({
        name: r.name,
        email: r.email,
        phone: r.phone,
      })),
    },
    whatsapp: {
      status: onboarding.whatsapp?.status || "deferred",
    },
  };
}
import { computeEntitlements } from "../helpers/entitlements.js";

/**
 * POST /api/auth/signup
 * Create owner, organization, 3-day trial subscription, and tenant database.
 */
export async function signup(req, res) {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message:
          "Database connection unavailable. Please set a valid MONGODB_URI in BACKEND/.env.",
      });
    }

    const { companyName, fullName, email, password } = req.body;

    if (!companyName || !fullName || !email || !password) {
      return res.status(400).json({
        success: false,
        message:
          "All fields are required: companyName, fullName, email, password.",
      });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "An account with this email address already exists.",
      });
    }

    // Hash password using crypto scrypt
    const passwordHash = await hashPassword(password);
    const verificationToken = generateRandomToken(32);
    const verificationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    // Generate unique slug & tenant db name
    const baseSlug = slugify(companyName) || "org";
    const randomSuffix = generateRandomToken(3);
    const slug = `${baseSlug}_${randomSuffix}`;
    const tenantDbName = `tenant_${slug}`;

    let createdUser = null;
    let createdOrg = null;
    let createdMember = null;
    let createdSub = null;

    try {
      // 1. Create owner User (unverified until email token is confirmed)
      createdUser = await User.create({
        name: fullName.trim(),
        email: normalizedEmail,
        passwordHash,
        role: "owner",
        isVerified: false,
        verificationToken,
        verificationExpiresAt,
      });

      // 2. Create Organization record in pending provisioning state
      createdOrg = await Organization.create({
        name: companyName.trim(),
        slug,
        tenantDbName,
        ownerId: createdUser._id,
        provisioningStatus: "pending",
      });

      // 3. Create Organization Member mapping
      createdMember = await OrganizationMember.create({
        organizationId: createdOrg._id,
        userId: createdUser._id,
        role: "owner",
        status: "active",
      });

      // 4. Create 3-day Trial Subscription
      const now = new Date();
      const trialEndDate = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000); // exactly 3 days
      createdSub = await Subscription.create({
        organizationId: createdOrg._id,
        plan: "trial",
        status: "active",
        billingCycle: "trial",
        startDate: now,
        endDate: trialEndDate,
        repAddons: 0,
        campaignsAddon: false,
        followUpsAddon: false,
      });

      // 5. Provision tenant database
      try {
        const tenantDb = getTenantDB(tenantDbName);
        const tenantModels = getTenantModels(tenantDb);
        await tenantModels.WhatsAppConnection.createCollection();
        await tenantModels.TeamMember.createCollection();
        await tenantModels.Lead.createCollection();
        await tenantModels.DailyLeadCounter.createCollection();

        createdOrg.provisioningStatus = "ready";
        await createdOrg.save();
      } catch (provisionErr) {
        console.error("[Tenant Provisioning Error]", provisionErr);
        throw new Error(`Tenant database provisioning failed: ${provisionErr.message}`);
      }

      return res.status(201).json({
        success: true,
        message:
          "Organization workspace created successfully. Please check your email to verify your account.",
        email: normalizedEmail,
      });
    } catch (createErr) {
      // Invariant: Roll back any records created partway through to avoid inconsistent orphan records
      if (createdSub) await Subscription.deleteOne({ _id: createdSub._id }).catch(() => {});
      if (createdMember) await OrganizationMember.deleteOne({ _id: createdMember._id }).catch(() => {});
      if (createdOrg) await Organization.deleteOne({ _id: createdOrg._id }).catch(() => {});
      if (createdUser) await User.deleteOne({ _id: createdUser._id }).catch(() => {});
      throw createErr;
    }
  } catch (err) {
    console.error("[Signup Error]", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to create organization workspace.",
    });
  }
}

/**
 * POST /api/auth/verify-email
 * Validate verification token and mark user verified
 */
export async function verifyEmail(req, res) {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message:
          "Database connection unavailable. Please verify MONGODB_URI in BACKEND/.env.",
      });
    }

    const { token } = req.body;
    if (!token) {
      return res.status(400).json({
        success: false,
        message: "Verification token is required.",
      });
    }

    const user = await User.findOne({ verificationToken: token });
    if (!user) {
      return res.status(400).json({
        success: false,
        message: "Invalid or already used verification token.",
      });
    }

    if (
      user.verificationExpiresAt &&
      new Date(user.verificationExpiresAt) < new Date()
    ) {
      return res.status(400).json({
        success: false,
        code: "TOKEN_EXPIRED",
        message:
          "Verification link has expired. Please request a new verification email.",
      });
    }

    user.isVerified = true;
    user.verificationToken = null;
    user.verificationExpiresAt = null;
    await user.save();

    return res.json({
      success: true,
      message:
        "Email successfully verified. You can now log in to your workspace.",
    });
  } catch (err) {
    console.error("[Verify Email Error]", err);
    return res.status(500).json({
      success: false,
      message: "Error verifying email address.",
    });
  }
}

/**
 * POST /api/auth/resend-verification
 */
export async function resendVerification(req, res) {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message:
          "Database connection unavailable. Please verify MONGODB_URI in BACKEND/.env.",
      });
    }

    const { email } = req.body;
    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email address is required.",
      });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Account not found.",
      });
    }

    if (user.isVerified) {
      return res.status(400).json({
        success: false,
        message: "Account is already verified. Please sign in.",
      });
    }

    const newToken = generateRandomToken(32);
    user.verificationToken = newToken;
    user.verificationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await user.save();

    return res.json({
      success: true,
      message: "A fresh verification link has been sent to your email address.",
      email: user.email,
    });
  } catch (err) {
    console.error("[Resend Verification Error]", err);
    return res.status(500).json({
      success: false,
      message: "Failed to resend verification email.",
    });
  }
}

/**
 * POST /api/auth/login
 * Enforces single active login session per user and sets secure HTTP-only cookie
 */
export async function login(req, res) {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message:
          "Database connection unavailable. Please verify MONGODB_URI in BACKEND/.env.",
      });
    }

    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required.",
      });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password.",
      });
    }

    const isMatch = await verifyPassword(password, user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password.",
      });
    }

    if (!user.isVerified) {
      return res.status(403).json({
        success: false,
        code: "UNVERIFIED_EMAIL",
        message:
          "Please verify your email before logging in. Check your inbox or request a new link.",
        email: user.email,
      });
    }

    // Find user's active organization membership
    const membership = await OrganizationMember.findOne({
      userId: user._id,
      status: "active",
    });

    if (!membership && user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "You are not an active member of any organization workspace.",
      });
    }

    const orgId = membership?.organizationId || null;
    const organization = orgId ? await Organization.findById(orgId) : null;
    const subscription = orgId
      ? await Subscription.findOne({ organizationId: orgId })
      : null;
    const entitlements = subscription ? computeEntitlements(subscription) : null;

    // Enforce SINGLE LOGIN SESSION:
    // Session.createSingleSession deletes all prior sessions for user._id
    const session = await Session.createSingleSession({
      userId: user._id,
      organizationId: orgId,
      userAgent: req.headers["user-agent"] || "",
      ipAddress: req.ip || "",
    });

    // Set secure HTTP-only cookie
    const isProd = env.NODE_ENV === "production";
    res.cookie(env.SESSION_COOKIE_NAME, session.token, {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      maxAge: env.SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
      path: "/",
    });

    return res.json({
      success: true,
      message: "Signed in successfully.",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: membership?.role || user.role,
        isVerified: user.isVerified,
        canViewAllLeads: user.role === "admin" || (membership?.role === "owner") || Boolean(membership?.canViewAllLeads),
      },
      organization: organization
        ? {
            id: organization._id,
            name: organization.name,
            slug: organization.slug,
            industry: organization.industry || "",
            whatsappPhone: organization.whatsappPhone || "",
            timezone: organization.timezone || "Asia/Kolkata",
            logo: organization.logo || "",
            provisioningStatus: organization.provisioningStatus,
            onboarding: formatOrgOnboarding(organization.onboarding),
          }
        : null,
      subscription: subscription
        ? {
            plan: subscription.plan,
            status: subscription.status,
            endDate: subscription.endDate,
            repAddons: subscription.repAddons,
            campaignsAddon: subscription.campaignsAddon,
            followUpsAddon: subscription.followUpsAddon,
          }
        : null,
      entitlements,
    });
  } catch (err) {
    console.error("[Login Error]", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error during login.",
    });
  }
}

/**
 * GET /api/auth/me
 * Restores session from HTTP-only cookie
 */
export async function getMe(req, res) {
  try {
    return res.json({
      success: true,
      user: {
        id: req.user._id,
        name: req.user.name,
        email: req.user.email,
        role: req.membership?.role || req.user.role,
        isVerified: req.user.isVerified,
        canViewAllLeads: req.user.role === "admin" || (req.membership?.role === "owner") || Boolean(req.membership?.canViewAllLeads),
      },
      organization: req.organization
        ? {
            id: req.organization._id,
            name: req.organization.name,
            slug: req.organization.slug,
            industry: req.organization.industry || "",
            whatsappPhone: req.organization.whatsappPhone || "",
            timezone: req.organization.timezone || "Asia/Kolkata",
            logo: req.organization.logo || "",
            provisioningStatus: req.organization.provisioningStatus,
            onboarding: formatOrgOnboarding(req.organization.onboarding),
          }
        : null,
      subscription: req.subscription
        ? {
            plan: req.subscription.plan,
            status: req.subscription.status,
            endDate: req.subscription.endDate,
            repAddons: req.subscription.repAddons,
            campaignsAddon: req.subscription.campaignsAddon,
            followUpsAddon: req.subscription.followUpsAddon,
          }
        : null,
      entitlements: req.entitlements,
    });
  } catch (err) {
    console.error("[GetMe Error]", err);
    return res.status(500).json({
      success: false,
      message: "Error retrieving current session.",
    });
  }
}

/**
 * POST /api/auth/logout
 * Invalidate session in DB and clear HTTP-only cookie
 */
export async function logout(req, res) {
  try {
    const token = req.cookies[env.SESSION_COOKIE_NAME];
    if (token && isDbConnected()) {
      await Session.deleteOne({ token });
    }
    res.clearCookie(env.SESSION_COOKIE_NAME, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
    return res.json({
      success: true,
      message: "Signed out successfully.",
    });
  } catch (err) {
    console.error("[Logout Error]", err);
    return res.status(500).json({
      success: false,
      message: "Error signing out.",
    });
  }
}
