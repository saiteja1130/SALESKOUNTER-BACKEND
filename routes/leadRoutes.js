import { Router } from "express";
import { requireAuth } from "../middlewares/auth.js";
import {
  listLeads,
  getLead,
  createLead,
  updateLead,
  assignLead,
  bulkAssignLeads,
  bulkStatusUpdate,
  deleteLead,
  listTeamMembers,
} from "../controllers/leadController.js";

const router = Router();

router.use(requireAuth);

router.get("/team-members", listTeamMembers);
router.get("/", listLeads);
router.post("/", createLead);
router.get("/:id", getLead);
router.put("/:id", updateLead);
router.post("/:id/assign", assignLead);
router.post("/bulk-assign", bulkAssignLeads);
router.post("/bulk-status", bulkStatusUpdate);
router.delete("/:id", deleteLead);

export default router;
