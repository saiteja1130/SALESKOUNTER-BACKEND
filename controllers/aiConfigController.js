import {
  getOrganizationAiConfig,
  saveOrganizationAiConfig,
  publishOrganizationAiConfig,
  saveGeminiApiKey,
} from "../helpers/aiConfigService.js";
import { testGeminiConversation } from "../helpers/geminiService.js";

/**
 * GET /api/ai/config
 * Retrieves current AI configuration for the authenticated tenant
 */
export async function getAiConfigHandler(req, res) {
  try {
    if (!req.tenantDb) {
      return res.status(503).json({
        success: false,
        message: "Tenant database is not connected.",
      });
    }

    const config = await getOrganizationAiConfig(req.tenantDb, req.organization);
    return res.json({
      success: true,
      config,
    });
  } catch (err) {
    console.error("[Get AI Config Error]", err);
    return res.status(err.status || 500).json({
      success: false,
      message: err.message || "Failed to load AI configuration.",
      code: err.code,
    });
  }
}

/**
 * PUT /api/ai/config
 * Saves the 6-section Teach AI configuration with revision check and input validation
 */
export async function updateAiConfigHandler(req, res) {
  try {
    if (!req.tenantDb) {
      return res.status(503).json({
        success: false,
        message: "Tenant database is not connected.",
      });
    }

    const { expectedRevision, ...configData } = req.body || {};

    const savedConfig = await saveOrganizationAiConfig({
      tenantDb: req.tenantDb,
      organization: req.organization,
      userId: req.user._id,
      configData,
      expectedRevision,
    });

    return res.json({
      success: true,
      message: "AI training configuration saved to cloud successfully.",
      config: savedConfig,
    });
  } catch (err) {
    if (err.status !== 409 && err.status !== 400) {
      console.error("[Update AI Config Error]", err);
    }
    return res.status(err.status || 500).json({
      success: false,
      message: err.message || "Failed to save AI configuration.",
      code: err.code,
      currentRevision: err.currentRevision,
      errors: err.errors,
    });
  }
}

/**
 * POST /api/ai/publish
 * Validates and publishes configuration to active production state
 */
export async function publishAiConfigHandler(req, res) {
  try {
    if (!req.tenantDb) {
      return res.status(503).json({
        success: false,
        message: "Tenant database is not connected.",
      });
    }

    const publishedConfig = await publishOrganizationAiConfig({
      tenantDb: req.tenantDb,
      organization: req.organization,
      userId: req.user._id,
    });

    return res.json({
      success: true,
      message: "AI configuration is now live for all incoming conversations.",
      config: publishedConfig,
    });
  } catch (err) {
    console.error("[Publish AI Config Error]", err);
    return res.status(err.status || 500).json({
      success: false,
      message: err.message || "Failed to publish AI configuration.",
      code: err.code,
    });
  }
}

/**
 * POST /api/ai/test
 * Tests a simulated conversation against Gemini with draft or saved configuration
 */
export async function testAiConversationHandler(req, res) {
  try {
    const { config, messages, explicitKey } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        success: false,
        message: "A conversation history with at least one message is required to test.",
      });
    }

    const result = await testGeminiConversation({
      organization: req.organization,
      tenantDb: req.tenantDb,
      config: config || {},
      messages,
      explicitKey,
    });

    return res.json({
      success: true,
      result,
    });
  } catch (err) {
    if (err.code !== "GEMINI_KEY_MISSING") {
      console.error("[Test AI Conversation Error]", err.message);
    }
    return res.status(err.status || 500).json({
      success: false,
      message: err.message || "Failed to generate AI response from Gemini.",
      code: err.code,
    });
  }
}

/**
 * POST /api/ai/gemini-key
 * Securely encrypts and saves Google Gemini API key
 */
export async function saveGeminiKeyHandler(req, res) {
  try {
    const { apiKey } = req.body || {};
    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      return res.status(400).json({
        success: false,
        message: "A valid Google Gemini API key string is required.",
      });
    }

    const result = await saveGeminiApiKey({
      tenantDb: req.tenantDb,
      organization: req.organization,
      apiKey: apiKey.trim(),
    });

    return res.json({
      success: true,
      hasGeminiKey: result.hasGeminiKey,
      message: "Google Gemini API key securely encrypted and stored on server.",
    });
  } catch (err) {
    console.error("[Save Gemini Key Error]", err);
    return res.status(err.status || 500).json({
      success: false,
      message: err.message || "Failed to save Gemini API key.",
    });
  }
}
