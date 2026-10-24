import { Router } from "express";
import { requireAuth, requireOwnerOrAdmin } from "../middlewares/auth.js";
import {
  listConnections,
  createConnection,
  getConnectionStatus,
  startConnectionEndpoint,
  disconnectConnectionEndpoint,
  removeConnectionEndpoint,
} from "../controllers/whatsappController.js";

const router = Router();
router.use(requireAuth, requireOwnerOrAdmin);

router.get("/connections", listConnections);
router.post("/connections", createConnection);
router.get("/connections/:id/status", getConnectionStatus);
router.post("/connections/:id/start", startConnectionEndpoint);
router.post("/connections/:id/disconnect", disconnectConnectionEndpoint);
router.delete("/connections/:id", removeConnectionEndpoint);

export default router;
