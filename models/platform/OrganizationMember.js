import mongoose from "mongoose";

const organizationMemberSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    role: {
      type: String,
      enum: ["owner", "salesperson"],
      default: "salesperson",
    },
    status: {
      type: String,
      enum: ["active", "invited", "paused", "suspended", "disabled", "removed"],
      default: "active",
    },
    canViewAllLeads: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

organizationMemberSchema.index({ organizationId: 1, userId: 1 }, { unique: true });

export const OrganizationMember = mongoose.model("OrganizationMember", organizationMemberSchema);
