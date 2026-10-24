import mongoose from "mongoose";

export const whatsAppConnectionSchema = new mongoose.Schema(
  {
    phoneNumber: {
      type: String,
      required: true,
      trim: true,
    },
    displayName: {
      type: String,
      default: "WhatsApp Business Line",
    },
    status: {
      type: String,
      enum: ["connected", "disconnected", "pairing"],
      default: "connected",
    },
    connectedAt: {
      type: Date,
      default: () => new Date(),
    },
  },
  { timestamps: true }
);

export const teamMemberSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    phone: {
      type: String,
      default: "",
    },
    role: {
      type: String,
      enum: ["salesperson", "owner"],
      default: "salesperson",
    },
    status: {
      type: String,
      enum: ["active", "invited", "paused", "disabled", "removed"],
      default: "active",
    },
    canViewAllLeads: {
      type: Boolean,
      default: false,
    },
    assignedLeadsCount: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

export const leadSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    email: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
    },
    source: {
      type: String,
      default: "WhatsApp Inbound",
    },
    status: {
      type: String,
      enum: ["New", "Interested", "In-followup", "Converted", "Lost"],
      default: "New",
      index: true,
    },
    assignedToId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TeamMember",
      default: null,
      index: true,
    },
    assignedToName: {
      type: String,
      default: "Unassigned",
    },
    assignedTo: {
      type: String,
      default: "Unassigned",
    },
    // References the specific WhatsApp connection channel for multi-inbox filtering
    whatsappConnectionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WhatsAppConnection",
      default: null,
      index: true,
    },
    whatsappPhoneNumber: {
      type: String,
      default: "",
      index: true,
    },
    createdDateIST: {
      type: String, // "YYYY-MM-DD" in Asia/Kolkata timezone
      required: true,
      index: true,
    },
    value: {
      type: Number,
      default: 0,
    },
    collectedData: {
      interestedProduct: { type: String, default: "" },
      budgetRange: { type: String, default: "Bespoke Package" },
      deliveryCity: { type: String, default: "" },
    },
    notes: [
      {
        id: { type: String },
        authorId: { type: String },
        authorName: { type: String },
        text: { type: String },
        createdAt: { type: Date, default: () => new Date() },
      },
    ],
    lastContactAt: {
      type: Date,
      default: () => new Date(),
    },
    aiHandled: {
      type: Boolean,
      default: true,
    },
    needsAttention: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

// Daily lead counter for concurrent-safe quota enforcement resetting at midnight IST
export const dailyLeadCounterSchema = new mongoose.Schema(
  {
    dateIST: {
      type: String, // "YYYY-MM-DD"
      required: true,
      unique: true,
      index: true,
    },
    count: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true }
);

export const campaignSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ["Draft", "Scheduled", "Active", "Completed", "Paused"],
      default: "Draft",
    },
    template: {
      type: String,
      default: "",
    },
    totalRecipients: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

export const followUpRuleSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    triggerCondition: {
      type: String,
      enum: ["inactive_hours", "status_changed", "unanswered_ai"],
      default: "inactive_hours",
      required: true,
    },
    delayHours: {
      type: Number,
      required: true,
      min: 1,
      max: 720,
      default: 24,
    },
    targetStatus: {
      type: String,
      enum: ["Any", "New", "Interested", "In-followup", "Converted", "Lost"],
      default: "Interested",
      required: true,
    },
    actionType: {
      type: String,
      enum: ["ai_send_whatsapp", "notify_salesperson"],
      default: "ai_send_whatsapp",
      required: true,
    },
    messageTemplate: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1000,
    },
    quietHoursEnabled: {
      type: Boolean,
      default: true,
    },
    quietHoursStart: {
      type: String,
      default: "21:00",
    },
    quietHoursEnd: {
      type: String,
      default: "08:00",
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
  },
  { timestamps: true }
);

export const quietHoursSchema = new mongoose.Schema(
  {
    enabled: {
      type: Boolean,
      default: true,
    },
    quietStart: {
      type: String,
      default: "21:00",
    },
    quietEnd: {
      type: String,
      default: "08:00",
    },
    morningReleaseTime: {
      type: String,
      default: "08:15",
    },
    timezone: {
      type: String,
      default: "Asia/Kolkata",
    },
  },
  { timestamps: true }
);

export const scheduledFollowUpSchema = new mongoose.Schema(
  {
    ruleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FollowUpRule",
      required: true,
      index: true,
    },
    ruleTitle: {
      type: String,
      default: "",
    },
    leadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
      required: true,
      index: true,
    },
    leadName: {
      type: String,
      default: "",
    },
    leadPhone: {
      type: String,
      default: "",
    },
    assignedToId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TeamMember",
      default: null,
    },
    scheduledTime: {
      type: Date,
      required: true,
      index: true,
    },
    dueAt: {
      type: Date,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "cancelled", "failed"],
      default: "pending",
      index: true,
    },
    actionType: {
      type: String,
      default: "ai_send_whatsapp",
    },
    messagePreview: {
      type: String,
      default: "",
    },
    retryCount: {
      type: Number,
      default: 0,
    },
    lastError: {
      type: String,
      default: "",
    },
    executedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// Indexes for rapid due-job polling and lead-rule deduplication checks
scheduledFollowUpSchema.index({ leadId: 1, ruleId: 1, status: 1 });
scheduledFollowUpSchema.index({ status: 1, dueAt: 1 });

// Backward compatibility alias
export const followUpSchema = scheduledFollowUpSchema;

export const aiConfigSchema = new mongoose.Schema(
  {
    // Section 1: Brand Identity & Style
    agentName: {
      type: String,
      default: "Elena Vance",
      trim: true,
      maxlength: 60,
    },
    agentRole: {
      type: String,
      default: "Design Consultant & Sales Advisor",
      trim: true,
      maxlength: 100,
    },
    companyName: {
      type: String,
      default: "Artisan Living",
      trim: true,
      maxlength: 100,
    },
    maxWords: {
      type: Number,
      default: 55,
      min: 10,
      max: 200,
    },
    businessDescription: {
      type: String,
      default: "Artisan Living designs bespoke residential furniture and handcrafted architectural millwork for discerning homeowners and interior designers.",
      maxlength: 2000,
    },
    antiAiGuardrails: {
      type: String,
      default: "NEVER say 'As an AI language model'. Never use corporate apologies like 'I apologize for any inconvenience'. Speak concisely like a busy professional sales rep on WhatsApp.",
      maxlength: 1000,
    },

    // Section 2: Greetings & Services
    welcomeMessage: {
      type: String,
      default: "Hello! Welcome to our WhatsApp service. How can we assist you today?",
      maxlength: 500,
    },
    services: [
      {
        id: { type: String, required: true },
        name: { type: String, required: true, maxlength: 100 },
        description: { type: String, default: "", maxlength: 500 },
      },
    ],

    // Section 3: Conversation Rules
    rules: [
      {
        id: { type: String, required: true },
        title: { type: String, required: true, maxlength: 100 },
        instruction: { type: String, required: true, maxlength: 500 },
        active: { type: Boolean, default: true },
      },
    ],

    // Section 4: Lead Details to Collect
    fieldsToCollect: [
      {
        id: { type: String, required: true },
        label: { type: String, required: true, maxlength: 60 },
        key: { type: String, required: true, maxlength: 40 },
        required: { type: Boolean, default: true },
      },
    ],

    // Section 5: Booking Links & Timing
    ctaLink: {
      type: String,
      default: "",
      maxlength: 500,
    },
    minTurnsForCTA: {
      type: Number,
      default: 3,
      min: 1,
      max: 20,
    },

    // Section 6: Information to Avoid
    restrictedFields: [
      {
        type: String,
        maxlength: 100,
      },
    ],

    // Metadata, Revisioning, and Concurrency
    revision: {
      type: Number,
      default: 1,
    },
    status: {
      type: String,
      enum: ["draft", "published"],
      default: "published",
    },
    publishedAt: {
      type: Date,
      default: () => new Date(),
    },
    lastUpdatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },

    // Encrypted API credential storage (AES-256-GCM)
    encryptedGeminiApiKey: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

/**
 * Returns typed tenant models bound to a specific tenant DB connection
 */
export function getTenantModels(tenantDb) {
  return {
    WhatsAppConnection:
      tenantDb.models.WhatsAppConnection ||
      tenantDb.model("WhatsAppConnection", whatsAppConnectionSchema),
    TeamMember:
      tenantDb.models.TeamMember ||
      tenantDb.model("TeamMember", teamMemberSchema),
    Lead:
      tenantDb.models.Lead ||
      tenantDb.model("Lead", leadSchema),
    DailyLeadCounter:
      tenantDb.models.DailyLeadCounter ||
      tenantDb.model("DailyLeadCounter", dailyLeadCounterSchema),
    Campaign:
      tenantDb.models.Campaign ||
      tenantDb.model("Campaign", campaignSchema),
    FollowUpRule:
      tenantDb.models.FollowUpRule ||
      tenantDb.model("FollowUpRule", followUpRuleSchema),
    QuietHours:
      tenantDb.models.QuietHours ||
      tenantDb.model("QuietHours", quietHoursSchema),
    ScheduledFollowUp:
      tenantDb.models.ScheduledFollowUp ||
      tenantDb.model("ScheduledFollowUp", scheduledFollowUpSchema),
    FollowUp:
      tenantDb.models.ScheduledFollowUp ||
      tenantDb.model("ScheduledFollowUp", scheduledFollowUpSchema),
    AiConfig:
      tenantDb.models.AiConfig ||
      tenantDb.model("AiConfig", aiConfigSchema),
  };
}
