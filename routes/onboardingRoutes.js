import { Router } from "express";
import { requireAuth } from "../middlewares/auth.js";
import {
  getOnboardingStatus,
  saveAiPersonality,
  saveGeminiSetup,
  inviteSalesRep,
  skipSalesRepStep,
  completeOnboarding,
  skipOnboarding,
} from "../controllers/onboardingController.js";

const router = Router();

router.use(requireAuth);

router.get("/status", getOnboardingStatus);
router.post("/step/ai-personality", saveAiPersonality);
router.post("/step/gemini", saveGeminiSetup);
router.post("/step/invite-rep", inviteSalesRep);
router.post("/step/skip-rep", skipSalesRepStep);
router.post("/complete", completeOnboarding);
router.post("/skip", skipOnboarding);

export default router;
