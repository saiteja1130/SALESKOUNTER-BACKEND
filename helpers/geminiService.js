import { decryptSecret } from "./crypto.js";

/**
 * Resolves the decrypted Google Gemini API key for an organization.
 * Hierarchy:
 * 1. Explicit key in request (if provided for direct testing)
 * 2. Tenant database AiConfig.encryptedGeminiApiKey
 * 3. Platform Organization.onboarding.geminiSetup.apiKeyEncrypted
 * 4. Process environment GEMINI_API_KEY
 */
export async function resolveGeminiApiKey(tenantDb, organization, explicitKey) {
  if (explicitKey && typeof explicitKey === "string" && explicitKey.trim()) {
    return explicitKey.trim();
  }

  // 1. Tenant DB AiConfig
  if (tenantDb) {
    try {
      const { AiConfig } = tenantDb.models;
      if (AiConfig) {
        const configDoc = await AiConfig.findOne();
        if (configDoc?.encryptedGeminiApiKey) {
          const decrypted = decryptSecret(configDoc.encryptedGeminiApiKey);
          if (decrypted) return decrypted;
        }
      }
    } catch {
      // Non-blocking fallback
    }
  }

  // 2. Platform Organization onboarding
  if (organization?.onboarding?.geminiSetup?.apiKeyEncrypted) {
    const decrypted = decryptSecret(organization.onboarding.geminiSetup.apiKeyEncrypted);
    if (decrypted) return decrypted;
  }

  // 3. Environment fallback
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()) {
    return process.env.GEMINI_API_KEY.trim();
  }

  return null;
}

/**
 * Compiles the 6 Teach AI sections into a cohesive Gemini System Instruction
 */
export function buildCompiledSystemPrompt(config = {}) {
  let prompt = `[IDENTITY & BRAND PERSONA]\n`;
  prompt += `You are ${config.agentName || "Elena Vance"}, a ${config.agentRole || "Design Consultant & Sales Advisor"} representing ${config.companyName || "Artisan Living"}.\n`;
  if (config.businessDescription) {
    prompt += `Business Overview: ${config.businessDescription}\n`;
  }
  prompt += `\n[GUARDRAILS & STYLE]\n`;
  if (config.antiAiGuardrails) {
    prompt += `Negative Constraints: ${config.antiAiGuardrails}\n`;
  }
  prompt += `Conciseness Rule: WhatsApp messages must be natural, engaging, and strictly under ${config.maxWords || 55} words. Avoid robotic, overly formal language.\n\n`;

  prompt += `[SERVICES CATALOG]\n`;
  if (Array.isArray(config.services) && config.services.length > 0) {
    config.services.forEach((s) => {
      prompt += `- ${s.name}: ${s.description || "Bespoke service tailored to client requirements."}\n`;
    });
  } else {
    prompt += `Offer general bespoke design and custom manufacturing consultations.\n`;
  }
  prompt += `\n[CONVERSATION RULES]\n`;
  if (Array.isArray(config.rules) && config.rules.length > 0) {
    const activeRules = config.rules.filter((r) => r.active !== false);
    if (activeRules.length > 0) {
      activeRules.forEach((r) => {
        prompt += `- ${r.title}: ${r.instruction}\n`;
      });
    } else {
      prompt += `Guide the customer toward identifying their project specifications and timeline.\n`;
    }
  }
  prompt += `\n[LEAD DETAILS TO EXTRACT]\n`;
  if (Array.isArray(config.fieldsToCollect) && config.fieldsToCollect.length > 0) {
    const fieldsList = config.fieldsToCollect.map((f) => `${f.label} (key: "${f.key}")`).join(", ");
    prompt += `Track these qualification fields: ${fieldsList}.\n`;
    prompt += `When you discover or clarify any of these details from the conversation, append a hidden comment at the very end of your response in this exact format:\n<!-- QUALIFICATION: {"field_key": "extracted_value"} -->\n`;
  } else {
    prompt += `Identify customer budget, timeline, and product interests whenever mentioned.\n`;
  }

  prompt += `\n[BOOKING LINKS & TIMING]\n`;
  prompt += `Booking URL: ${config.ctaLink || "https://calendly.com"}\n`;
  prompt += `Pacing constraint: Do not offer the booking link until at least message Turn ${config.minTurnsForCTA || 3} unless the user explicitly asks how to schedule, book, or visit.\n\n`;

  prompt += `[RESTRICTED INFORMATION TO AVOID]\n`;
  if (Array.isArray(config.restrictedFields) && config.restrictedFields.length > 0) {
    prompt += `STRICT PROHIBITION: NEVER ask for, echo, or prompt the user for: ${config.restrictedFields.join(", ")}. If the client sends confidential data voluntarily, acknowledge receipt securely without repeating the details, and recommend a direct private manager call.\n`;
  } else {
    prompt += `Never ask for payment card numbers, passwords, or government IDs.\n`;
  }

  return prompt;
}

/**
 * Sanitizes messages so secrets or raw API keys are never exposed in error traces
 */
function sanitizeErrorMessage(msg = "") {
  return msg
    .replace(/key=[a-zA-Z0-9_\-]+/gi, "key=[REDACTED]")
    .replace(/AIza[a-zA-Z0-9_\-]{35}/gi, "[REDACTED_API_KEY]");
}

/**
 * Calls Google Gemini REST API with AbortController timeout
 */
export async function testGeminiConversation({
  organization,
  tenantDb,
  config,
  messages = [],
  explicitKey = null,
}) {
  const apiKey = await resolveGeminiApiKey(tenantDb, organization, explicitKey);

  if (!apiKey) {
    const err = new Error(
      "Google Gemini API key is not configured. Please save your API key in Workspace Settings to enable AI responses."
    );
    err.code = "GEMINI_KEY_MISSING";
    err.status = 400;
    throw err;
  }

  const systemInstructionText = buildCompiledSystemPrompt(config);

  // Format messages for Gemini API
  // Gemini requires alternating roles: "user" | "model"
  const formattedContents = [];
  let lastRole = null;

  for (const m of messages) {
    const rawRole = m.sender === "ai" || m.sender === "model" ? "model" : "user";
    const text = (m.text || "").trim();
    if (!text) continue;

    if (rawRole === lastRole) {
      // Append text to existing turn
      const lastTurn = formattedContents[formattedContents.length - 1];
      lastTurn.parts.push({ text });
    } else {
      formattedContents.push({
        role: rawRole,
        parts: [{ text }],
      });
      lastRole = rawRole;
    }
  }

  // Ensure conversation does not start with model turn (Gemini requires starting with user turn)
  if (formattedContents.length > 0 && formattedContents[0].role === "model") {
    formattedContents.unshift({
      role: "user",
      parts: [{ text: "Hello" }],
    });
  }

  // If conversation is empty, provide a default user turn
  if (formattedContents.length === 0) {
    formattedContents.push({
      role: "user",
      parts: [{ text: "Hi, I have a question about your products." }],
    });
  }

  const payload = {
    systemInstruction: {
      parts: [{ text: systemInstructionText }],
    },
    contents: formattedContents,
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 350,
      topP: 0.95,
    },
  };

  const startTime = Date.now();
  const modelName = "gemini-1.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(
    apiKey
  )}`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15-second timeout

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      let errBody = {};
      try {
        errBody = await response.json();
      } catch {
        // Non-JSON error
      }

      const googleMsg = errBody?.error?.message || `HTTP ${response.status} ${response.statusText}`;
      const sanitized = sanitizeErrorMessage(googleMsg);

      if (response.status === 400 && /API_KEY_INVALID|key not valid/i.test(googleMsg)) {
        const err = new Error("The configured Google Gemini API key is invalid or revoked.");
        err.code = "GEMINI_KEY_INVALID";
        err.status = 400;
        throw err;
      }

      if (response.status === 429) {
        const err = new Error("Gemini API rate limit exceeded. Please wait a moment and try again.");
        err.code = "GEMINI_RATE_LIMITED";
        err.status = 429;
        throw err;
      }

      const err = new Error(`Gemini Provider Error: ${sanitized}`);
      err.code = "GEMINI_PROVIDER_ERROR";
      err.status = response.status >= 500 ? 502 : 400;
      throw err;
    }

    const data = await response.json();
    const candidate = data.candidates?.[0];
    const rawReply = candidate?.content?.parts?.[0]?.text || "Thank you for contacting us! How can I assist you today?";

    // Extract any qualification metadata hidden comments: <!-- QUALIFICATION: {...} -->
    let extractedData = null;
    let cleanText = rawReply;

    const qualMatch = rawReply.match(/<!--\s*QUALIFICATION:\s*(\{[\s\S]*?\})\s*-->/i);
    if (qualMatch && qualMatch[1]) {
      try {
        extractedData = JSON.parse(qualMatch[1]);
        cleanText = rawReply.replace(qualMatch[0], "").trim();
      } catch {
        // Non-fatal parse failure
      }
    }

    return {
      text: cleanText,
      extractedData,
      latencyMs,
      model: modelName,
      turnsProcessed: formattedContents.length,
    };
  } catch (err) {
    if (err.name === "AbortError") {
      const timeoutErr = new Error("Request to Gemini API timed out after 15 seconds. Please try again.");
      timeoutErr.code = "GEMINI_TIMEOUT";
      timeoutErr.status = 504;
      throw timeoutErr;
    }
    err.message = sanitizeErrorMessage(err.message);
    throw err;
  }
}
