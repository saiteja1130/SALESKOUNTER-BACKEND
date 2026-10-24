import express from "express";
import { requireAuth, requireOwnerOrAdmin } from "../middlewares/auth.js";
import {
  listRules,
  createRule,
  updateRule,
  toggleRuleStatus,
  deleteRule,
  getQuietHours,
  updateQuietHours,
  listScheduled,
  cancelJob,
  postponeJob,
  triggerJob,
} from "../controllers/followUpController.js";

const router = express.Router();

// Require authenticated session for all follow-ups endpoints
router.use(requireAuth);

// Rules CRUD
router.get("/rules", listRules);
router.post("/rules", requireOwnerOrAdmin, createRule);
router.put("/rules/:id", requireOwnerOrAdmin, updateRule);
router.patch("/rules/:id/status", requireOwnerOrAdmin, toggleRuleStatus);
router.delete("/rules/:id", requireOwnerOrAdmin, deleteRule);

// Organization Quiet Hours
router.get("/quiet-hours", getQuietHours);
router.put("/quiet-hours", requireOwnerOrAdmin, updateQuietHours);

// Scheduled Follow-Up Jobs
router.get("/scheduled", listScheduled);
router.post("/scheduled/:id/cancel", cancelJob);
router.post("/scheduled/:id/postpone", postponeJob);
router.post("/scheduled/:id/trigger", triggerJob);

export default router;
