import express from "express";
import { requireAuth, requireOwnerOrAdmin } from "../middlewares/auth.js";
import {
  getAiConfigHandler,
  updateAiConfigHandler,
  publishAiConfigHandler,
  testAiConversationHandler,
  saveGeminiKeyHandler,
} from "../controllers/aiConfigController.js";

const router = express.Router();

// All AI config endpoints require authenticated tenant session
router.use(requireAuth);

// Read current AI training configuration
router.get("/config", getAiConfigHandler);

// Save configuration (Owner or Admin only)
router.put("/config", requireOwnerOrAdmin, updateAiConfigHandler);

// Publish configuration to active live state (Owner or Admin only)
router.post("/publish", requireOwnerOrAdmin, publishAiConfigHandler);

// Test simulator interaction against Gemini (Owner or Admin only)
router.post("/test", requireOwnerOrAdmin, testAiConversationHandler);

// Securely store encrypted Gemini credential (Owner or Admin only)
router.post("/gemini-key", requireOwnerOrAdmin, saveGeminiKeyHandler);

export default router;
