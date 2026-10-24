import { Organization } from "../models/platform/Organization.js";

const PROTECTED_FIELDS = [
  "slug",
  "tenantDbName",
  "ownerId",
  "subscription",
  "subscriptionId",
  "provisioningStatus",
  "provisioningError",
  "onboarding",
  "_id",
  "id",
  "createdAt",
  "updatedAt",
];

const PHONE_REGEX = /^\+?[0-9\s\-()]{7,25}$/;

/**
 * Format organization object for client consumption
 */
function formatOrganization(org) {
  return {
    id: org._id.toString(),
    name: org.name,
    slug: org.slug,
    industry: org.industry || "",
    whatsappPhone: org.whatsappPhone || "",
    timezone: org.timezone || "Asia/Kolkata",
    logo: org.logo || "",
    ownerId: org.ownerId?.toString() || "",
    provisioningStatus: org.provisioningStatus,
    createdAt: org.createdAt,
    updatedAt: org.updatedAt,
  };
}

/**
 * GET /api/organization
 * Reads the authenticated organization's details
 */
export async function getOrganization(req, res) {
  try {
    if (!req.organization) {
      return res.status(404).json({
        success: false,
        message: "Organization not found for active session.",
      });
    }

    return res.json({
      success: true,
      organization: formatOrganization(req.organization),
    });
  } catch (err) {
    console.error("[Get Organization Error]", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to retrieve organization settings.",
    });
  }
}

/**
 * PATCH /api/organization
 * PUT /api/organization
 * Updates editable organization fields (owner-only)
 */
export async function updateOrganization(req, res) {
  try {
    if (!req.organization) {
      return res.status(404).json({
        success: false,
        message: "Organization not found for active session.",
      });
    }

    // Role verification: Only organization owner (or platform admin) can edit
    const isOwner = req.membership?.role === "owner" || req.user.role === "admin";
    if (!isOwner) {
      return res.status(403).json({
        success: false,
        message: "Only organization owners are authorized to modify organization settings.",
      });
    }

    const payload = req.body || {};

    // 1. Explicitly reject attempts to modify protected tenant identity fields
    for (const key of Object.keys(payload)) {
      if (PROTECTED_FIELDS.includes(key)) {
        return res.status(400).json({
          success: false,
          code: "PROTECTED_FIELD_REJECTED",
          message: `Modification of protected organization field "${key}" is strictly prohibited.`,
        });
      }
    }

    // 2. Validate and normalize allowed fields
    const { name, industry, whatsappPhone, timezone, logo } = payload;

    // Validate Name (if provided)
    if (name !== undefined) {
      if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 100) {
        return res.status(400).json({
          success: false,
          code: "INVALID_ORG_NAME",
          message: "Organization name is required and must be between 2 and 100 characters.",
        });
      }
      req.organization.name = name.trim();
    }

    // Validate Industry (if provided)
    if (industry !== undefined) {
      if (typeof industry !== "string" || industry.trim().length > 100) {
        return res.status(400).json({
          success: false,
          code: "INVALID_INDUSTRY",
          message: "Industry cannot exceed 100 characters.",
        });
      }
      req.organization.industry = industry.trim();
    }

    // Validate WhatsApp Phone (if provided)
    if (whatsappPhone !== undefined) {
      const trimmedPhone = String(whatsappPhone).trim();
      if (trimmedPhone && !PHONE_REGEX.test(trimmedPhone)) {
        return res.status(400).json({
          success: false,
          code: "INVALID_PHONE_FORMAT",
          message:
            "Invalid WhatsApp phone number format. Please provide a valid phone number (e.g. +1 555-0192 or +91 9876543210).",
        });
      }
      req.organization.whatsappPhone = trimmedPhone;
    }

    // Validate Timezone (if provided)
    if (timezone !== undefined) {
      if (typeof timezone !== "string" || timezone.trim().length > 50) {
        return res.status(400).json({
          success: false,
          code: "INVALID_TIMEZONE",
          message: "Timezone must be a valid timezone string (e.g. Asia/Kolkata).",
        });
      }
      req.organization.timezone = timezone.trim();
    }

    // Validate Logo URL (if provided)
    if (logo !== undefined) {
      req.organization.logo = typeof logo === "string" ? logo.trim() : "";
    }

    // 3. Save to platform Organization record in platform database
    await req.organization.save();

    return res.json({
      success: true,
      message: "Organization details updated successfully.",
      organization: formatOrganization(req.organization),
    });
  } catch (err) {
    console.error("[Update Organization Error]", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to update organization settings.",
    });
  }
}
