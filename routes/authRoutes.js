import { Router } from "express";
import {
  signup,
  verifyEmail,
  resendVerification,
  login,
  getMe,
  logout,
} from "../controllers/authController.js";
import { requireAuth } from "../middlewares/auth.js";

const router = Router();

router.post("/signup", signup);
router.post("/verify-email", verifyEmail);
router.post("/resend-verification", resendVerification);
router.post("/login", login);
router.get("/me", requireAuth, getMe);
router.post("/logout", logout);

export default router;
