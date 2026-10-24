import { Router } from "express";
import {
  listTeam,
  inviteTeamMember,
  resendInvite,
  revokeInvite,
  verifyInvite,
  acceptInvite,
  changeMemberStatus,
  deleteTeamMember,
} from "../controllers/teamController.js";
import { requireAuth, requireOwnerOrAdmin } from "../middlewares/auth.js";

const router = Router();

// Public invitation acceptance endpoints
router.get("/invitations/verify", verifyInvite);
router.post("/invitations/accept", acceptInvite);

// Authenticated owner/admin team management endpoints
router.get("/", requireAuth, requireOwnerOrAdmin, listTeam);
router.post("/invitations", requireAuth, requireOwnerOrAdmin, inviteTeamMember);
router.post("/invitations/:id/resend", requireAuth, requireOwnerOrAdmin, resendInvite);
router.post("/invitations/:id/revoke", requireAuth, requireOwnerOrAdmin, revokeInvite);
router.patch("/:memberId/status", requireAuth, requireOwnerOrAdmin, changeMemberStatus);
router.delete("/:memberId", requireAuth, requireOwnerOrAdmin, deleteTeamMember);

export default router;
