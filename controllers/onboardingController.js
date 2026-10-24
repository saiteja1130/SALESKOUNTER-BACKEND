import { User } from "../models/platform/User.js";
import { Organization } from "../models/platform/Organization.js";
import { OrganizationMember } from "../models/platform/OrganizationMember.js";
import { Subscription } from "../models/platform/Subscription.js";
import { computeEntitlements } from "../helpers/entitlements.js";
import { encryptSecret, hashPassword } from "../helpers/crypto.js";
import { getTenantDB } from "../configs/db.js";
import { getTenantModels } from "../models/tenant/schemas.js";
import { createTeamInvitation } from "../helpers/teamService.js";

function sanitizeOnboarding(onboarding, repCapacity = null) {
  if (!onboarding) {
    return {
      status: "not_started",
      currentStep: 1,
      firstIncompleteStep: 1,
      aiPersonality: {
        status: "pending",
        companyName: "",
        tone: "Professional & Courteous",
        welcomeMessage: "",
        services: [],
      },
      geminiSetup: {
        status: "pending",
        isConfigured: false,
      },
      inviteRep: {
        status: "pending",
        invitedReps: [],
      },
      whatsapp: {
        status: "deferred",
      },
      repCapacity,
    };
  }

  // Calculate the first incomplete step
  let firstIncomplete = 1;
  if (onboarding.aiPersonality?.status !== "completed") {
    firstIncomplete = 1;
  } else if (onboarding.geminiSetup?.status !== "completed") {
    firstIncomplete = 2;
  } else if (onboarding.inviteRep?.status !== "completed") {
    firstIncomplete = 3;
  } else {
    firstIncomplete = 4;
  }

  return {
    status: onboarding.status || "not_started",
    currentStep: onboarding.currentStep || firstIncomplete,
    firstIncompleteStep: firstIncomplete,
    aiPersonality: {
      status: onboarding.aiPersonality?.status || "pending",
      companyName: onboarding.aiPersonality?.companyName || "",
      tone: onboarding.aiPersonality?.tone || "Professional & Courteous",
      welcomeMessage: onboarding.aiPersonality?.welcomeMessage || "",
      services: onboarding.aiPersonality?.services || [],
      completedAt: onboarding.aiPersonality?.completedAt || null,
    },
    geminiSetup: {
      status: onboarding.geminiSetup?.status || "pending",
      isConfigured: Boolean(onboarding.geminiSetup?.apiKeyEncrypted),
      completedAt: onboarding.geminiSetup?.completedAt || null,
    },
    inviteRep: {
      status: onboarding.inviteRep?.status || "pending",
      invitedReps: (onboarding.inviteRep?.invitedReps || []).map((r) => ({
        name: r.name,
        email: r.email,
        phone: r.phone,
        invitedAt: r.invitedAt,
      })),
      completedAt: onboarding.inviteRep?.completedAt || null,
    },
    whatsapp: {
      status: onboarding.whatsapp?.status || "deferred",
      completedAt: onboarding.whatsapp?.completedAt || null,
    },
    completedAt: onboarding.completedAt || null,
    skippedAt: onboarding.skippedAt || null,
    repCapacity,
  };
}

/**
 * GET /api/onboarding/status
 * Fetches organization onboarding progress and subscription rep limits
 */
export async function getOnboardingStatus(req, res) {
  try {
    if (!req.organization) {
      return res.status(400).json({
        success: false,
        message: "No active organization associated with this session.",
      });
    }

    const org = await Organization.findById(req.organization._id);
    if (!org) {
      return res.status(404).json({
        success: false,
        message: "Organization not found.",
      });
    }

    const subscription = await Subscription.findOne({ organizationId: org._id });
    const entitlements = computeEntitlements(subscription);
    const maxAllowed = entitlements.maxSalesReps;

    let currentUsed = 0;
    try {
      const tenantDb = getTenantDB(org.tenantDbName);
      const { TeamMember } = getTenantModels(tenantDb);
      currentUsed = await TeamMember.countDocuments({ role: "salesperson" });
    } catch {
      currentUsed = org.onboarding?.inviteRep?.invitedReps?.length || 0;
    }

    const repCapacity = {
      maxAllowed,
      currentUsed,
      hasAvailableSeats: currentUsed < maxAllowed,
    };

    return res.json({
      success: true,
      onboarding: sanitizeOnboarding(org.onboarding, repCapacity),
    });
  } catch (err) {
    console.error("[Get Onboarding Status Error]", err);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch onboarding status.",
    });
  }
}

/**
 * POST /api/onboarding/step/ai-personality
 * Persists AI personality configuration
 */
export async function saveAiPersonality(req, res) {
  try {
    if (!req.organization) {
      return res.status(400).json({ success: false, message: "Organization required." });
    }

    if (req.membership?.role !== "owner" && req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Only organization owners can modify onboarding settings.",
      });
    }

    const { companyName, tone, welcomeMessage, services } = req.body;

    const org = await Organization.findById(req.organization._id);
    if (!org) {
      return res.status(404).json({ success: false, message: "Organization not found." });
    }

    if (!org.onboarding) {
      org.onboarding = { status: "in_progress", currentStep: 1 };
    }

    org.onboarding.aiPersonality = {
      status: "completed",
      companyName: (companyName || org.name || "").trim(),
      tone: (tone || "Professional & Courteous").trim(),
      welcomeMessage: (welcomeMessage || "Hello! Welcome to our WhatsApp service. How can we assist you today?").trim(),
      services: Array.isArray(services) ? services.map((s) => String(s).trim()).filter(Boolean) : [],
      completedAt: new Date(),
    };

    if (org.onboarding.status === "not_started") {
      org.onboarding.status = "in_progress";
    }
    org.onboarding.currentStep = Math.max(org.onboarding.currentStep || 1, 2);

    await org.save();

    // Optionally sync into tenant DB
    try {
      const tenantDb = getTenantDB(org.tenantDbName);
      await tenantDb.collection("aiConfig").updateOne(
        { _id: "singleton" },
        {
          $set: {
            companyName: org.onboarding.aiPersonality.companyName,
            tone: org.onboarding.aiPersonality.tone,
            welcomeMessage: org.onboarding.aiPersonality.welcomeMessage,
            services: org.onboarding.aiPersonality.services,
            updatedAt: new Date(),
          },
        },
        { upsert: true }
      );
    } catch {
      // Non-blocking tenant sync failure
    }

    return res.json({
      success: true,
      message: "AI personality configuration saved.",
      onboarding: sanitizeOnboarding(org.onboarding),
    });
  } catch (err) {
    console.error("[Save AI Personality Error]", err);
    return res.status(500).json({
      success: false,
      message: "Failed to save AI personality settings.",
    });
  }
}

/**
 * POST /api/onboarding/step/gemini
 * Encrypts and securely stores Google Gemini API key on backend
 */
export async function saveGeminiSetup(req, res) {
  try {
    if (!req.organization) {
      return res.status(400).json({ success: false, message: "Organization required." });
    }

    if (req.membership?.role !== "owner" && req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Only organization owners can modify onboarding settings.",
      });
    }

    const { apiKey } = req.body;
    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      return res.status(400).json({
        success: false,
        message: "A valid Gemini API key is required.",
      });
    }

    const org = await Organization.findById(req.organization._id);
    if (!org) {
      return res.status(404).json({ success: false, message: "Organization not found." });
    }

    if (!org.onboarding) {
      org.onboarding = { status: "in_progress", currentStep: 2 };
    }

    const encryptedKey = encryptSecret(apiKey.trim());
    org.onboarding.geminiSetup = {
      status: "completed",
      apiKeyEncrypted: encryptedKey,
      completedAt: new Date(),
    };

    if (org.onboarding.status === "not_started") {
      org.onboarding.status = "in_progress";
    }
    org.onboarding.currentStep = Math.max(org.onboarding.currentStep || 1, 3);

    await org.save();

    return res.json({
      success: true,
      message: "Gemini API credentials securely stored.",
      onboarding: sanitizeOnboarding(org.onboarding),
    });
  } catch (err) {
    console.error("[Save Gemini Setup Error]", err);
    return res.status(500).json({
      success: false,
      message: "Failed to secure Gemini credentials.",
    });
  }
}

/**
 * POST /api/onboarding/step/invite-rep
 * Uses shared team invitation flow: enforces seat limits and delivers invite link
 */
export async function inviteSalesRep(req, res) {
  try {
    if (!req.organization) {
      return res.status(400).json({ success: false, message: "Organization required." });
    }

    if (req.membership?.role !== "owner" && req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Only organization owners can invite sales representatives.",
      });
    }

    const { name, email, phone } = req.body;
    const org = await Organization.findById(req.organization._id);
    if (!org) {
      return res.status(404).json({ success: false, message: "Organization not found." });
    }

    const tenantDb = getTenantDB(org.tenantDbName);
    const tenantModels = getTenantModels(tenantDb);

    // Call shared invitation service (enforces seat capacity and validates email delivery)
    const result = await createTeamInvitation({
      organization: org,
      inviterUser: req.user,
      name,
      email,
      phone,
      tenantModels,
    });

    if (!org.onboarding) org.onboarding = {};
    if (!org.onboarding.inviteRep) org.onboarding.inviteRep = { invitedReps: [] };

    org.onboarding.inviteRep.invitedReps.push({
      name: result.rep.name,
      email: result.rep.email,
      phone: result.rep.phone,
      invitedAt: new Date(),
    });
    org.onboarding.inviteRep.status = "completed";
    org.onboarding.inviteRep.completedAt = new Date();
    org.onboarding.currentStep = Math.max(org.onboarding.currentStep || 1, 4);

    await org.save();

    return res.json({
      success: true,
      message: `Invitation email sent to ${result.rep.name} (${result.rep.email}).`,
      rep: result.rep,
      inviteLink: result.inviteLink,
      onboarding: sanitizeOnboarding(org.onboarding),
    });
  } catch (err) {
    console.error("[Invite Sales Rep Error]", err);
    const isLimit = err.message && err.message.includes("limit");
    return res.status(isLimit ? 403 : 400).json({
      success: false,
      code: isLimit ? "SEAT_LIMIT_REACHED" : "INVITE_FAILED",
      message: err.message || "Failed to invite sales representative.",
    });
  }
}

/**
 * POST /api/onboarding/step/skip-rep
 * Skips representative invitation during onboarding without reserving a seat
 */
export async function skipSalesRepStep(req, res) {
  try {
    if (!req.organization) {
      return res.status(400).json({ success: false, message: "Organization required." });
    }
    if (req.membership?.role !== "owner" && req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Only organization owners can skip this step.",
      });
    }

    const org = await Organization.findById(req.organization._id);
    if (!org) {
      return res.status(404).json({ success: false, message: "Organization not found." });
    }

    if (!org.onboarding) org.onboarding = {};
    if (!org.onboarding.inviteRep) org.onboarding.inviteRep = { invitedReps: [] };

    org.onboarding.inviteRep.status = "skipped";
    org.onboarding.inviteRep.completedAt = new Date();
    org.onboarding.currentStep = Math.max(org.onboarding.currentStep || 1, 4);

    await org.save();

    return res.json({
      success: true,
      message: "Sales representative setup skipped. No seat reserved.",
      onboarding: sanitizeOnboarding(org.onboarding),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Failed to skip step." });
  }
}

/**
 * POST /api/onboarding/complete
 * Marks onboarding as fully completed. Validates that required steps (AI, Gemini, Sales Rep) are completed.
 */
export async function completeOnboarding(req, res) {
  try {
    if (!req.organization) {
      return res.status(400).json({ success: false, message: "Organization required." });
    }

    if (req.membership?.role !== "owner" && req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Only organization owners can complete onboarding.",
      });
    }

    const org = await Organization.findById(req.organization._id);
    if (!org) {
      return res.status(404).json({ success: false, message: "Organization not found." });
    }

    if (!org.onboarding) {
      org.onboarding = {};
    }

    // Server-side validation of required steps
    const isAiConfigured = org.onboarding.aiPersonality?.status === "completed";
    const isGeminiConfigured =
      org.onboarding.geminiSetup?.status === "completed" &&
      Boolean(org.onboarding.geminiSetup?.apiKeyEncrypted);
    const isRepFinished =
      org.onboarding.inviteRep?.status === "completed" ||
      org.onboarding.inviteRep?.status === "skipped" ||
      (org.onboarding.inviteRep?.invitedReps?.length || 0) > 0;

    if (!isAiConfigured || !isGeminiConfigured || !isRepFinished) {
      const missing = [];
      if (!isAiConfigured) missing.push("AI Personality (Step 1)");
      if (!isGeminiConfigured) missing.push("Gemini API Key (Step 2)");
      if (!isRepFinished) missing.push("Invite Sales Rep (Step 3)");

      return res.status(400).json({
        success: false,
        code: "ONBOARDING_INCOMPLETE",
        message: `Cannot mark onboarding as completed before finishing required steps: ${missing.join(", ")}. Please complete these steps or use "Skip to Dashboard" to finish setup later.`,
        missingSteps: missing,
      });
    }

    org.onboarding.status = "completed";
    org.onboarding.completedAt = new Date();
    // WhatsApp remains deferred and non-blocking
    if (!org.onboarding.whatsapp?.status || org.onboarding.whatsapp?.status === "pending") {
      org.onboarding.whatsapp = {
        status: "deferred",
        completedAt: null,
      };
    }

    await org.save();

    return res.json({
      success: true,
      message: "Onboarding successfully completed! Welcome to your workspace.",
      onboarding: sanitizeOnboarding(org.onboarding),
    });
  } catch (err) {
    console.error("[Complete Onboarding Error]", err);
    return res.status(500).json({
      success: false,
      message: "Failed to finalize onboarding.",
    });
  }
}

/**
 * POST /api/onboarding/skip
 * Skips the onboarding flow and permanently dismisses mandatory redirection across sessions.
 * Preserves all previously completed steps.
 */
export async function skipOnboarding(req, res) {
  try {
    if (!req.organization) {
      return res.status(400).json({ success: false, message: "Organization required." });
    }

    if (req.membership?.role !== "owner" && req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Only organization owners can skip onboarding.",
      });
    }

    const org = await Organization.findById(req.organization._id);
    if (!org) {
      return res.status(404).json({ success: false, message: "Organization not found." });
    }

    if (!org.onboarding) {
      org.onboarding = {};
    }

    org.onboarding.status = "skipped";
    org.onboarding.skippedAt = new Date();

    await org.save();

    return res.json({
      success: true,
      message: "Onboarding skipped. You can review or complete setup anytime from Settings.",
      onboarding: sanitizeOnboarding(org.onboarding),
    });
  } catch (err) {
    console.error("[Skip Onboarding Error]", err);
    return res.status(500).json({
      success: false,
      message: "Failed to skip onboarding.",
    });
  }
}
