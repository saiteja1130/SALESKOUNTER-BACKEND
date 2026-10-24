import { Router } from "express";
import { getTenantUsage, createLeadWithQuota } from "../controllers/entitlementsController.js";
import { requireAuth } from "../middlewares/auth.js";

const router = Router();

router.use(requireAuth);

router.get("/usage", getTenantUsage);
router.post("/lead", createLeadWithQuota);

export default router;
