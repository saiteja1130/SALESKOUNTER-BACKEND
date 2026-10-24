import { Router } from "express";
import {
  getAdminOrganizations,
  updateSubscription,
  getAuditLogs,
} from "../controllers/adminController.js";
import { requireAuth, requirePlatformAdmin } from "../middlewares/auth.js";

const router = Router();

// Strictly restrict admin management endpoints to platform admins only
router.use(requireAuth, requirePlatformAdmin);

router.get("/organizations", getAdminOrganizations);
router.patch("/subscriptions/:orgId", updateSubscription);
router.get("/audit-logs", getAuditLogs);

export default router;
