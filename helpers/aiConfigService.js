import { encryptSecret, decryptSecret } from "./crypto.js";

/**
 * Returns default configuration seeded from organization name or industry
 */
export function getDefaultAiConfig(organization) {
  const orgName = organization?.name || "Artisan Living";
  return {
    agentName: "Elena Vance",
    agentRole: "Design Consultant & Sales Advisor",
    companyName: orgName,
    maxWords: 55,
    businessDescription: `${orgName} designs bespoke residential furniture and handcrafted architectural millwork for discerning homeowners and interior designers.`,
    antiAiGuardrails: "NEVER say 'As an AI language model'. Never use corporate apologies like 'I apologize for any inconvenience'. Speak concisely like a busy professional sales rep on WhatsApp.",
    welcomeMessage: `Hello! Welcome to ${orgName}. How can we assist you today?`,
    services: [
      {
        id: "s-default-1",
        name: "Bespoke Dining Tables",
        description: "Custom solid oak and Carrara marble dining tables made to measure.",
      },
      {
        id: "s-default-2",
        name: "Architectural Millwork",
        description: "Built-in library shelving, cabinetry, and custom wood panels.",
      },
      {
        id: "s-default-3",
        name: "Interior Design Consultation",
        description: "1-on-1 virtual or on-site space planning and material curation.",
      },
      {
        id: "s-default-4",
        name: "White-Glove Delivery",
        description: "Full room placement, uncrating, and debris removal nationwide.",
      },
    ],
    rules: [
      {
        id: "r-default-1",
        title: "Strict Discount Cap",
        instruction: "Never offer or agree to discounts greater than 10%. For larger requests, offer to connect them with a human sales manager.",
        active: true,
      },
      {
        id: "r-default-2",
        title: "Human Rep Escalation",
        instruction: "If the user explicitly asks to speak to a real person or manager, acknowledge immediately and alert a sales rep.",
        active: true,
      },
    ],
    fieldsToCollect: [
      { id: "f-default-1", label: "Estimated Budget", key: "budget", required: true },
      { id: "f-default-2", label: "Project Timeline", key: "timeline", required: true },
      { id: "f-default-3", label: "Room or Property Type", key: "room_type", required: true },
      { id: "f-default-4", label: "Delivery City & State", key: "location", required: false },
    ],
    ctaLink: "https://calendly.com",
    minTurnsForCTA: 3,
    restrictedFields: [
      "Credit card numbers",
      "Bank routing & account numbers",
      "Account passwords or PINs",
      "Social Security or Tax IDs",
      "Internal wholesale supplier pricing",
    ],
    revision: 1,
    status: "published",
  };
}

/**
 * Validates payload constraints for all 6 Teach AI sections
 */
export function validateAiConfig(payload = {}) {
  const errors = [];

  // Section 1
  if (payload.agentName !== undefined) {
    if (typeof payload.agentName !== "string" || !payload.agentName.trim()) {
      errors.push("Agent Name is required.");
    } else if (payload.agentName.length > 60) {
      errors.push("Agent Name cannot exceed 60 characters.");
    }
  }

  if (payload.companyName !== undefined) {
    if (typeof payload.companyName !== "string" || !payload.companyName.trim()) {
      errors.push("Company Name is required.");
    } else if (payload.companyName.length > 100) {
      errors.push("Company Name cannot exceed 100 characters.");
    }
  }

  if (payload.agentRole !== undefined && payload.agentRole.length > 100) {
    errors.push("Agent Role cannot exceed 100 characters.");
  }

  if (payload.maxWords !== undefined) {
    const num = Number(payload.maxWords);
    if (isNaN(num) || num < 10 || num > 200) {
      errors.push("Word limit must be between 10 and 200 words.");
    }
  }

  if (payload.businessDescription !== undefined && payload.businessDescription.length > 2000) {
    errors.push("Business Description cannot exceed 2000 characters.");
  }

  if (payload.antiAiGuardrails !== undefined && payload.antiAiGuardrails.length > 1000) {
    errors.push("Guardrails cannot exceed 1000 characters.");
  }

  // Section 2
  if (payload.welcomeMessage !== undefined) {
    if (typeof payload.welcomeMessage !== "string" || !payload.welcomeMessage.trim()) {
      errors.push("Welcome Message is required.");
    } else if (payload.welcomeMessage.length > 500) {
      errors.push("Welcome Message cannot exceed 500 characters.");
    }
  }

  if (payload.services !== undefined) {
    if (!Array.isArray(payload.services)) {
      errors.push("Services must be an array.");
    } else if (payload.services.length > 30) {
      errors.push("Services catalog cannot exceed 30 items.");
    } else {
      payload.services.forEach((s, idx) => {
        if (!s.name || !String(s.name).trim()) {
          errors.push(`Service #${idx + 1} must have a name.`);
        } else if (String(s.name).length > 100) {
          errors.push(`Service "${s.name}" name cannot exceed 100 characters.`);
        }
        if (s.description && String(s.description).length > 500) {
          errors.push(`Service "${s.name}" description cannot exceed 500 characters.`);
        }
      });
    }
  }

  // Section 3
  if (payload.rules !== undefined) {
    if (!Array.isArray(payload.rules)) {
      errors.push("Conversation rules must be an array.");
    } else if (payload.rules.length > 30) {
      errors.push("Conversation rules cannot exceed 30 items.");
    } else {
      payload.rules.forEach((r, idx) => {
        if (!r.title || !String(r.title).trim()) {
          errors.push(`Rule #${idx + 1} must have a title.`);
        } else if (String(r.title).length > 100) {
          errors.push(`Rule "${r.title}" title cannot exceed 100 characters.`);
        }
        if (!r.instruction || !String(r.instruction).trim()) {
          errors.push(`Rule #${idx + 1} must have instructions.`);
        } else if (String(r.instruction).length > 500) {
          errors.push(`Rule "${r.title}" instruction cannot exceed 500 characters.`);
        }
      });
    }
  }

  // Section 4: Fields to Collect (enforce unique keys!)
  if (payload.fieldsToCollect !== undefined) {
    if (!Array.isArray(payload.fieldsToCollect)) {
      errors.push("Fields to collect must be an array.");
    } else if (payload.fieldsToCollect.length > 20) {
      errors.push("Cannot collect more than 20 distinct lead fields.");
    } else {
      const seenKeys = new Set();
      payload.fieldsToCollect.forEach((f, idx) => {
        const rawKey = (f.key || "").trim().toLowerCase();
        if (!rawKey) {
          errors.push(`Field #${idx + 1} must have an internal key.`);
        } else if (!/^[a-z0-9_]+$/.test(rawKey)) {
          errors.push(`Field key "${rawKey}" must contain only lowercase letters, numbers, and underscores.`);
        } else if (seenKeys.has(rawKey)) {
          errors.push(`Duplicate field key "${rawKey}" detected. Each lead field key must be unique.`);
        } else {
          seenKeys.add(rawKey);
        }

        if (!f.label || !String(f.label).trim()) {
          errors.push(`Field #${idx + 1} must have a display label.`);
        } else if (String(f.label).length > 60) {
          errors.push(`Field "${f.label}" label cannot exceed 60 characters.`);
        }
      });
    }
  }

  // Section 5
  if (payload.ctaLink !== undefined && payload.ctaLink) {
    const link = String(payload.ctaLink).trim();
    if (link.length > 500) {
      errors.push("Booking link cannot exceed 500 characters.");
    } else if (!/^https?:\/\/.+/i.test(link)) {
      errors.push("Booking link must be a valid HTTP or HTTPS URL (e.g. https://calendly.com/your-name).");
    }
  }

  if (payload.minTurnsForCTA !== undefined) {
    const turns = Number(payload.minTurnsForCTA);
    if (isNaN(turns) || turns < 1 || turns > 20) {
      errors.push("Minimum conversation turns before booking link must be between 1 and 20.");
    }
  }

  // Section 6
  if (payload.restrictedFields !== undefined) {
    if (!Array.isArray(payload.restrictedFields)) {
      errors.push("Restricted fields must be an array of strings.");
    } else if (payload.restrictedFields.length > 20) {
      errors.push("Cannot specify more than 20 restricted topics.");
    } else {
      payload.restrictedFields.forEach((field) => {
        if (typeof field === "string" && field.length > 100) {
          errors.push(`Restricted item "${field.slice(0, 20)}..." cannot exceed 100 characters.`);
        }
      });
    }
  }

  if (errors.length > 0) {
    const error = new Error(errors[0]);
    error.status = 400;
    error.code = "AI_CONFIG_VALIDATION_ERROR";
    error.errors = errors;
    throw error;
  }
}

/**
 * Strips secret keys from AI configuration object before returning to frontend
 */
export function sanitizeAiConfigResponse(doc, hasGeminiKey = false) {
  if (!doc) return null;
  const raw = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };

  delete raw.encryptedGeminiApiKey;
  delete raw.__v;

  return {
    ...raw,
    hasGeminiKey,
  };
}

/**
 * Retrieves the current organization AI configuration from tenant DB
 */
export async function getOrganizationAiConfig(tenantDb, organization) {
  const { AiConfig } = tenantDb.models;

  let configDoc = await AiConfig.findOne();

  // If first visit, create default record in tenant DB
  if (!configDoc) {
    const defaults = getDefaultAiConfig(organization);
    // If onboarding already stored personality info, populate from there
    if (organization?.onboarding?.aiPersonality) {
      const p = organization.onboarding.aiPersonality;
      if (p.companyName) defaults.companyName = p.companyName;
      if (p.welcomeMessage) defaults.welcomeMessage = p.welcomeMessage;
      if (Array.isArray(p.services) && p.services.length > 0) {
        defaults.services = p.services.map((s, i) => ({
          id: `s-onboard-${i}`,
          name: String(s),
          description: "Premium handcrafted service.",
        }));
      }
    }

    configDoc = await AiConfig.create(defaults);
  }

  const hasKey = Boolean(
    configDoc.encryptedGeminiApiKey ||
    organization?.onboarding?.geminiSetup?.apiKeyEncrypted ||
    process.env.GEMINI_API_KEY
  );

  return sanitizeAiConfigResponse(configDoc, hasKey);
}

/**
 * Saves AI configuration with concurrency revision check and validation
 */
export async function saveOrganizationAiConfig({
  tenantDb,
  organization,
  userId,
  configData,
  expectedRevision,
}) {
  const { AiConfig } = tenantDb.models;

  validateAiConfig(configData);

  let configDoc = await AiConfig.findOne();
  if (!configDoc) {
    const defaults = getDefaultAiConfig(organization);
    configDoc = new AiConfig(defaults);
  }

  // Concurrency check: If expectedRevision was specified and DB is ahead
  if (
    expectedRevision !== undefined &&
    expectedRevision !== null &&
    typeof expectedRevision === "number" &&
    configDoc.revision > expectedRevision
  ) {
    const conflictErr = new Error(
      `Configuration has been updated by another user (Server revision ${configDoc.revision} vs your revision ${expectedRevision}). Please reload to merge your edits.`
    );
    conflictErr.status = 409;
    conflictErr.code = "STALE_REVISION_ERROR";
    conflictErr.currentRevision = configDoc.revision;
    throw conflictErr;
  }

  // Update Section 1
  if (configData.agentName !== undefined) configDoc.agentName = configData.agentName.trim();
  if (configData.agentRole !== undefined) configDoc.agentRole = configData.agentRole.trim();
  if (configData.companyName !== undefined) configDoc.companyName = configData.companyName.trim();
  if (configData.maxWords !== undefined) configDoc.maxWords = Number(configData.maxWords);
  if (configData.businessDescription !== undefined) configDoc.businessDescription = configData.businessDescription.trim();
  if (configData.antiAiGuardrails !== undefined) configDoc.antiAiGuardrails = configData.antiAiGuardrails.trim();

  // Update Section 2
  if (configData.welcomeMessage !== undefined) configDoc.welcomeMessage = configData.welcomeMessage.trim();
  if (configData.services !== undefined) {
    configDoc.services = configData.services.map((s) => ({
      id: s.id || `s-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: String(s.name).trim(),
      description: String(s.description || "").trim(),
    }));
  }

  // Update Section 3
  if (configData.rules !== undefined) {
    configDoc.rules = configData.rules.map((r) => ({
      id: r.id || `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title: String(r.title).trim(),
      instruction: String(r.instruction).trim(),
      active: r.active !== false,
    }));
  }

  // Update Section 4
  if (configData.fieldsToCollect !== undefined) {
    configDoc.fieldsToCollect = configData.fieldsToCollect.map((f) => ({
      id: f.id || `f-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      label: String(f.label).trim(),
      key: String(f.key).trim().toLowerCase(),
      required: f.required !== false,
    }));
  }

  // Update Section 5
  if (configData.ctaLink !== undefined) configDoc.ctaLink = String(configData.ctaLink || "").trim();
  if (configData.minTurnsForCTA !== undefined) configDoc.minTurnsForCTA = Number(configData.minTurnsForCTA);

  // Update Section 6
  if (configData.restrictedFields !== undefined) {
    configDoc.restrictedFields = configData.restrictedFields.map((f) => String(f).trim()).filter(Boolean);
  }

  // If new Gemini key is provided, encrypt and store
  if (configData.geminiApiKey && typeof configData.geminiApiKey === "string" && configData.geminiApiKey.trim()) {
    configDoc.encryptedGeminiApiKey = encryptSecret(configData.geminiApiKey.trim());
  }

  configDoc.revision += 1;
  configDoc.lastUpdatedBy = userId;
  configDoc.updatedAt = new Date();

  await configDoc.save();

  const hasKey = Boolean(
    configDoc.encryptedGeminiApiKey ||
    organization?.onboarding?.geminiSetup?.apiKeyEncrypted ||
    process.env.GEMINI_API_KEY
  );

  return sanitizeAiConfigResponse(configDoc, hasKey);
}

/**
 * Publishes configuration to make it active
 */
export async function publishOrganizationAiConfig({ tenantDb, organization, userId }) {
  const { AiConfig } = tenantDb.models;

  let configDoc = await AiConfig.findOne();
  if (!configDoc) {
    const defaults = getDefaultAiConfig(organization);
    configDoc = new AiConfig(defaults);
  }

  configDoc.status = "published";
  configDoc.publishedAt = new Date();
  configDoc.revision += 1;
  configDoc.lastUpdatedBy = userId;

  await configDoc.save();

  const hasKey = Boolean(
    configDoc.encryptedGeminiApiKey ||
    organization?.onboarding?.geminiSetup?.apiKeyEncrypted ||
    process.env.GEMINI_API_KEY
  );

  return sanitizeAiConfigResponse(configDoc, hasKey);
}

/**
 * Encrypts and saves Gemini API key specifically
 */
export async function saveGeminiApiKey({ tenantDb, organization, apiKey }) {
  const cleanKey = (apiKey || "").trim();
  if (!cleanKey) {
    const err = new Error("A valid Gemini API key is required.");
    err.status = 400;
    throw err;
  }

  const encrypted = encryptSecret(cleanKey);

  // Store in tenant DB
  const { AiConfig } = tenantDb.models;
  let configDoc = await AiConfig.findOne();
  if (!configDoc) {
    const defaults = getDefaultAiConfig(organization);
    configDoc = new AiConfig(defaults);
  }
  configDoc.encryptedGeminiApiKey = encrypted;
  await configDoc.save();

  // Also update organization onboarding
  if (organization) {
    if (!organization.onboarding) {
      organization.onboarding = { status: "in_progress" };
    }
    organization.onboarding.geminiSetup = {
      status: "completed",
      apiKeyEncrypted: encrypted,
      completedAt: new Date(),
    };
    await organization.save();
  }

  return { hasGeminiKey: true };
}
