import mongoose from "mongoose";

const adminAuditLogSchema = new mongoose.Schema(
  {
    adminUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    targetOrganizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    action: {
      type: String,
      required: true,
      enum: [
        "PLAN_UPDATED",
        "STATUS_UPDATED",
        "DATES_EXTENDED",
        "REP_ADDON_CHANGED",
        "FEATURE_ADDON_CHANGED",
        "MANUAL_PROVISION_RETRY",
      ],
    },
    previousState: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    newState: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    note: {
      type: String,
      default: "",
    },
  },
  {
    timestamps: true,
  }
);

export const AdminAuditLog = mongoose.model("AdminAuditLog", adminAuditLogSchema);
