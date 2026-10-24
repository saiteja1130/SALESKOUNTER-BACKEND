import mongoose from "mongoose";

const organizationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 100,
    },
    industry: {
      type: String,
      trim: true,
      default: "",
      maxlength: 100,
    },
    whatsappPhone: {
      type: String,
      trim: true,
      default: "",
      maxlength: 30,
    },
    timezone: {
      type: String,
      trim: true,
      default: "Asia/Kolkata",
      maxlength: 50,
    },
    logo: {
      type: String,
      default: "",
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    tenantDbName: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    provisioningStatus: {
      type: String,
      enum: ["pending", "ready", "failed"],
      default: "pending",
      index: true,
    },
    provisioningError: {
      type: String,
      default: null,
    },
    onboarding: {
      status: {
        type: String,
        enum: ["not_started", "in_progress", "completed", "skipped"],
        default: "not_started",
        index: true,
      },
      currentStep: {
        type: Number,
        default: 1,
      },
      aiPersonality: {
        status: {
          type: String,
          enum: ["pending", "completed"],
          default: "pending",
        },
        companyName: { type: String, default: "" },
        tone: { type: String, default: "Professional & Courteous" },
        welcomeMessage: { type: String, default: "" },
        services: [{ type: String }],
        completedAt: { type: Date, default: null },
      },
      geminiSetup: {
        status: {
          type: String,
          enum: ["pending", "completed"],
          default: "pending",
        },
        apiKeyEncrypted: { type: String, default: "" },
        completedAt: { type: Date, default: null },
      },
      inviteRep: {
        status: {
          type: String,
          enum: ["pending", "completed", "skipped"],
          default: "pending",
        },
        invitedReps: [
          {
            name: { type: String, trim: true },
            email: { type: String, trim: true, lowercase: true },
            phone: { type: String, trim: true },
            invitedAt: { type: Date, default: () => new Date() },
          },
        ],
        completedAt: { type: Date, default: null },
      },
      whatsapp: {
        status: {
          type: String,
          enum: ["pending", "completed", "deferred"],
          default: "deferred",
        },
        completedAt: { type: Date, default: null },
      },
      completedAt: { type: Date, default: null },
      skippedAt: { type: Date, default: null },
    },
  },
  {
    timestamps: true,
  }
);

export const Organization = mongoose.model("Organization", organizationSchema);
