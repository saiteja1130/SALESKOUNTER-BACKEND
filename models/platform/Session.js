import mongoose from "mongoose";
import { generateRandomToken } from "../../helpers/crypto.js";
import { env } from "../../configs/env.js";

const sessionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: false,
      default: null,
      index: true,
    },
    token: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 0 }, // MongoDB automatic TTL deletion
    },
    userAgent: {
      type: String,
      default: "",
    },
    ipAddress: {
      type: String,
      default: "",
    },
  },
  {
    timestamps: true,
  }
);

/**
 * Enforces single login session:
 * Deletes any existing active sessions for this user before creating a new one.
 */
sessionSchema.statics.createSingleSession = async function ({
  userId,
  organizationId = null,
  userAgent = "",
  ipAddress = "",
}) {
  // Invalidate any existing sessions for this user to enforce single-login policy
  await this.deleteMany({ userId });

  const token = generateRandomToken(48);
  const expiresAt = new Date(Date.now() + env.SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);

  const session = await this.create({
    userId,
    organizationId,
    token,
    expiresAt,
    userAgent,
    ipAddress,
  });

  return session;
};

export const Session = mongoose.model("Session", sessionSchema);
