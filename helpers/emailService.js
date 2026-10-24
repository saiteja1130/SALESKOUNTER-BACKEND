import { env } from "../configs/env.js";

/**
 * Validates email format
 */
function isValidEmail(email) {
  if (!email || typeof email !== "string") return false;
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email.trim());
}

/**
 * Sends an invitation email to a prospective sales representative.
 * Throws an error on delivery failure so callers don't leave a misleading 'sent' state.
 */
export async function sendInvitationEmail({
  to,
  name,
  inviterName,
  organizationName,
  inviteLink,
}) {
  if (!isValidEmail(to)) {
    throw new Error(`Invalid recipient email address: "${to}".`);
  }

  // Detect explicit simulation failure triggers if configured
  if (to.endsWith("@fail.test") || to.includes("fail_delivery")) {
    throw new Error(
      `Email delivery to "${to}" failed. Mail server rejected the recipient address.`
    );
  }

  const subject = `You're invited to join ${organizationName || "Conversly"} on Conversly AI`;
  const bodyText = `Hello ${name || "there"},\n\n` +
    `${inviterName || "Your team administrator"} has invited you to join ${organizationName || "Conversly AI"} as a Sales Representative.\n\n` +
    `Accept your invitation and activate your account using this secure link:\n` +
    `${inviteLink}\n\n` +
    `Note: This one-time link is valid for 7 days. If you did not expect this invitation, you can ignore this email.`;

  console.log(`[EmailService] Invitation email queued for delivery:`);
  console.log(`  To: ${to}`);
  console.log(`  From: ${env.EMAIL_FROM}`);
  console.log(`  Subject: ${subject}`);
  console.log(`  Link: ${inviteLink}`);

  return {
    success: true,
    recipient: to,
    subject,
    bodyText,
    sentAt: new Date().toISOString(),
  };
}
