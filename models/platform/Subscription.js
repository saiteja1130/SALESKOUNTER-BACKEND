import mongoose from "mongoose";

const subscriptionSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      unique: true,
      index: true,
    },
    plan: {
      type: String,
      enum: ["trial", "basic", "growth", "enterprise"],
      default: "trial",
      required: true,
    },
    status: {
      type: String,
      enum: ["active", "expired", "cancelled"],
      default: "active",
      index: true,
    },
    billingCycle: {
      type: String,
      enum: ["trial", "monthly", "quarterly", "yearly"],
      default: "trial",
    },
    startDate: {
      type: Date,
      default: () => new Date(),
    },
    endDate: {
      type: Date,
      required: true,
    },
    repAddons: {
      type: Number,
      default: 0,
      min: 0,
    },
    campaignsAddon: {
      type: Boolean,
      default: false,
    },
    followUpsAddon: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

export const Subscription = mongoose.model("Subscription", subscriptionSchema);
