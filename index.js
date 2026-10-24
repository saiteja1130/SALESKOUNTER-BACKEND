import express from "express";
import cors from "cors";
import { env } from "./configs/env.js";
import { connectPlatformDB, isDbConnected } from "./configs/db.js";
import { cookieParser } from "./middlewares/cookieParser.js";

import authRoutes from "./routes/authRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import entitlementRoutes from "./routes/entitlementRoutes.js";
import onboardingRoutes from "./routes/onboardingRoutes.js";
import leadRoutes from "./routes/leadRoutes.js";
import teamRoutes from "./routes/teamRoutes.js";
import aiConfigRoutes from "./routes/aiConfigRoutes.js";
import followUpRoutes from "./routes/followUpRoutes.js";
import organizationRoutes from "./routes/organizationRoutes.js";
import { startFollowUpSchedulerWorker } from "./helpers/followUpEngine.js";

const app = express();

// Enable CORS with credentials for HTTP-only cookies
app.use(
  cors({
    origin: env.FRONTEND_URL,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json());
app.use(cookieParser);

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    databaseConnected: isDbConnected(),
    environment: env.NODE_ENV,
    singleSessionEnforced: true,
  });
});

// Platform routes
app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/entitlements", entitlementRoutes);
app.use("/api/onboarding", onboardingRoutes);
app.use("/api/leads", leadRoutes);
app.use("/api/team", teamRoutes);
app.use("/api/ai", aiConfigRoutes);
app.use("/api/follow-ups", followUpRoutes);
app.use("/api/organization", organizationRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Endpoint ${req.method} ${req.originalUrl} not found.`,
  });
});

// Centralized error handler
app.use((err, req, res, next) => {
  console.error("[Unhandled Error]", err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal server error.",
  });
});

// Start server and connect to MongoDB platform db
const PORT = env.PORT || 5000;
app.listen(PORT, async () => {
  console.log(`=======================================================`);
  console.log(`🚀 Conversly AI Backend running on port ${PORT}`);
  console.log(`📡 Frontend CORS allowed: ${env.FRONTEND_URL}`);
  console.log(`🔒 Single-login session enforcement: ACTIVE`);
  console.log(`=======================================================`);
  await connectPlatformDB();
  startFollowUpSchedulerWorker();
});

export default app;
