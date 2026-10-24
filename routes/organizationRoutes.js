import express from "express";
import { requireAuth, requireOwnerOrAdmin } from "../middlewares/auth.js";
import {
  getOrganization,
  updateOrganization,
} from "../controllers/organizationController.js";

const router = express.Router();

// Require authenticated session for all organization endpoints
router.use(requireAuth);

// Read current organization details
router.get("/", getOrganization);

// Update organization settings (Owner or Platform Admin only)
router.patch("/", requireOwnerOrAdmin, updateOrganization);
router.put("/", requireOwnerOrAdmin, updateOrganization);

export default router;
