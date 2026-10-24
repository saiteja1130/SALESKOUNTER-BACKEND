import { getTodayDateIST } from "./crypto.js";

export const PLAN_LIMITS = {
  trial: {
    whatsappConnections: 1,
    salesReps: 1,
    dailyLeads: 30,
    campaignsIncluded: false,
    followUpsIncluded: false,
  },
  basic: {
    whatsappConnections: 1,
    salesReps: 2,
    dailyLeads: 30,
    campaignsIncluded: false,
    followUpsIncluded: false,
  },
  growth: {
    whatsappConnections: 2,
    salesReps: 3,
    dailyLeads: 50,
    campaignsIncluded: false,
    followUpsIncluded: false,
  },
  enterprise: {
    whatsappConnections: 3,
    salesReps: 5,
    dailyLeads: 100,
    campaignsIncluded: true,
    followUpsIncluded: true,
  },
};

/**
 * Compute the effective limits and feature entitlements for a subscription.
 */
export function computeEntitlements(subscription) {
  if (!subscription) {
    return {
      plan: "none",
      status: "expired",
      isExpired: true,
      maxConnections: 0,
      maxSalesReps: 0,
      dailyLeadLimit: 0,
      canAccessCampaigns: false,
      canAccessFollowUps: false,
      isReadOnly: true,
    };
  }

  const now = new Date();
  const isExpired =
    subscription.status === "expired" ||
    subscription.status === "cancelled" ||
    new Date(subscription.endDate) < now;
  const base = PLAN_LIMITS[subscription.plan] || PLAN_LIMITS.trial;

  // On trial expiry, cancellation, or downgrade, account enters read-only policy:
  // preserve existing data, block new creations above limits.
  if (isExpired) {
    return {
      plan: subscription.plan,
      status: subscription.status,
      isExpired: true,
      isReadOnly: true,
      maxConnections: 0,
      maxSalesReps: 0,
      dailyLeadLimit: 0,
      canAccessCampaigns: false,
      canAccessFollowUps: false,
      repAddons: subscription.repAddons || 0,
      campaignsAddon: false,
      followUpsAddon: false,
      endDate: subscription.endDate,
    };
  }

  const maxConnections = base.whatsappConnections;
  const maxSalesReps = base.salesReps + (subscription.repAddons || 0);
  const dailyLeadLimit = base.dailyLeads;
  const canAccessCampaigns = base.campaignsIncluded || Boolean(subscription.campaignsAddon);
  const canAccessFollowUps =
    subscription.plan !== "trial" &&
    (base.followUpsIncluded || Boolean(subscription.followUpsAddon));

  return {
    plan: subscription.plan,
    status: subscription.status,
    isExpired: false,
    isReadOnly: false,
    maxConnections,
    maxSalesReps,
    dailyLeadLimit,
    canAccessCampaigns,
    canAccessFollowUps,
    repAddons: subscription.repAddons || 0,
    campaignsAddon: Boolean(subscription.campaignsAddon),
    followUpsAddon: Boolean(subscription.followUpsAddon),
    startDate: subscription.startDate,
    endDate: subscription.endDate,
  };
}

/**
 * Check if a new WhatsApp connection can be added
 */
export async function assertCanAddConnection(tenantModels, entitlements) {
  if (entitlements.isReadOnly || entitlements.isExpired) {
    throw new Error("Subscription is expired or inactive. Adding WhatsApp connections is blocked.");
  }
  // Every retained connection document occupies a plan connection slot
  const currentCount = await tenantModels.WhatsAppConnection.countDocuments({});
  if (currentCount >= entitlements.maxConnections) {
    throw new Error(
      `Connection limit reached. Your ${entitlements.plan.toUpperCase()} plan allows up to ${entitlements.maxConnections} WhatsApp connection(s). Please upgrade to add more.`
    );
  }
  return currentCount;
}

/**
 * Check if a new Sales Rep can be added (Owner does NOT count toward rep seats!)
 */
export async function assertCanAddSalesRep(tenantModels, entitlements) {
  if (entitlements.isReadOnly || entitlements.isExpired) {
    throw new Error("Subscription is expired or inactive. Adding sales reps is blocked.");
  }
  // The owner does not use a sales rep seat
  const currentCount = await tenantModels.TeamMember.countDocuments({
    role: "salesperson",
    status: { $ne: "disabled" },
  });
  if (currentCount >= entitlements.maxSalesReps) {
    throw new Error(
      `Sales rep limit reached. Your plan allows ${entitlements.maxSalesReps} rep(s). You can add extra rep seats from subscription settings.`
    );
  }
  return currentCount;
}

function isDuplicateKeyError(err) {
  if (!err) return false;
  return (
    err.code === 11000 ||
    err.codeName === "DuplicateKey" ||
    (err.name === "MongoServerError" && (err.message?.includes("E11000") || err.message?.includes("duplicate key"))) ||
    Boolean(err.writeErrors?.some((we) => we.code === 11000 || we.errmsg?.includes("E11000"))) ||
    err.errorResponse?.code === 11000
  );
}

/**
 * Atomically reserve a lead creation quota for today (Asia/Kolkata timezone).
 * Completely immune to simultaneous first-request duplicate key races and accurately
 * checks and enforces plan daily limits.
 */
export async function tryConsumeDailyLeadQuota(tenantModels, entitlements) {
  if (entitlements.isReadOnly || entitlements.isExpired) {
    throw new Error("Subscription is expired or inactive. Adding leads is blocked.");
  }

  const todayIST = getTodayDateIST();
  const maxLimit = entitlements.dailyLeadLimit;

  // Attempt with retry to handle any day-start rollover races
  for (let attempt = 0; attempt < 3; attempt++) {
    // Step 1: Ensure today's document exists
    try {
      await tenantModels.DailyLeadCounter.updateOne(
        { dateIST: todayIST },
        { $setOnInsert: { dateIST: todayIST, count: 0 } },
        { upsert: true }
      );
    } catch (err) {
      if (!isDuplicateKeyError(err)) {
        throw err;
      }
      // On duplicate key race, the document was inserted by concurrent request
    }

    // Step 2: Atomically increment count only when strictly below maxLimit
    const result = await tenantModels.DailyLeadCounter.findOneAndUpdate(
      {
        dateIST: todayIST,
        count: { $lt: maxLimit },
      },
      {
        $inc: { count: 1 },
      },
      {
        returnDocument: "after",
      }
    );

    if (result) {
      return { todayIST, currentCount: result.count, maxLimit };
    }

    // Check if limit was reached
    const currentDoc = await tenantModels.DailyLeadCounter.findOne({ dateIST: todayIST });
    if (currentDoc && currentDoc.count >= maxLimit) {
      throw new Error(
        `Daily lead limit of ${maxLimit} reached for today (${todayIST} IST). Quota resets at 12:00 a.m. IST.`
      );
    }
  }

  throw new Error(
    `Daily lead limit of ${maxLimit} reached for today (${todayIST} IST). Quota resets at 12:00 a.m. IST.`
  );
}

/**
 * Rollback a reserved lead quota if subsequent lead creation fails
 */
export async function rollbackDailyLeadQuota(tenantModels, dateIST) {
  try {
    await tenantModels.DailyLeadCounter.updateOne(
      { dateIST, count: { $gt: 0 } },
      { $inc: { count: -1 } }
    );
  } catch (err) {
    console.error("[Quota Rollback Error]", err);
  }
}
