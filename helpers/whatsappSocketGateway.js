import { env } from "../configs/env.js";
import { Session } from "../models/platform/Session.js";
import { User } from "../models/platform/User.js";
import { OrganizationMember } from "../models/platform/OrganizationMember.js";

let ioInstance = null;

/**
 * Parse cookies from raw header string
 */
function parseCookieHeader(header) {
  const cookies = {};
  if (!header) return cookies;
  const pairs = header.split(";");
  for (const pair of pairs) {
    const idx = pair.indexOf("=");
    if (idx !== -1) {
      const key = pair.slice(0, idx).trim();
      const val = pair.slice(idx + 1).trim();
      try {
        cookies[key] = decodeURIComponent(val);
      } catch {
        cookies[key] = val;
      }
    }
  }
  return cookies;
}

/**
 * Attach and configure Socket.IO gateway with cookie-based platform authentication
 */
export function attachWhatsAppSocketGateway(io) {
  ioInstance = io;

  // Socket authentication middleware
  io.use(async (socket, next) => {
    try {
      const cookieHeader = socket.handshake.headers.cookie;
      const cookies = parseCookieHeader(cookieHeader);
      const token = cookies[env.SESSION_COOKIE_NAME];

      if (!token) {
        return next(new Error("Authentication required: missing session cookie"));
      }

      const session = await Session.findOne({ token });
      if (!session || new Date(session.expiresAt) < new Date()) {
        return next(new Error("Session expired or invalid"));
      }

      const user = await User.findById(session.userId);
      if (!user) {
        return next(new Error("User account not found"));
      }

      // Check organization membership
      let orgId = session.organizationId ? session.organizationId.toString() : null;
      if (orgId && user.role !== "admin") {
        const membership = await OrganizationMember.findOne({
          userId: user._id,
          organizationId: session.organizationId,
          status: "active",
        });
        if (!membership) {
          return next(new Error("User is not an active member of this organization"));
        }
      }

      socket.data = {
        userId: user._id.toString(),
        orgId: orgId,
        role: user.role,
        userName: user.name,
      };

      next();
    } catch (err) {
      console.error("[Socket Gateway Auth Error]", err.message);
      next(new Error("Socket authentication failed"));
    }
  });

  io.on("connection", (socket) => {
    const { userId, orgId, userName } = socket.data;

    // Join authorized personal user room
    if (userId) {
      socket.join(`user:${userId}`);
    }

    // Join authorized organization room (server-derived, never client-controlled)
    if (orgId) {
      socket.join(`org:${orgId}`);
      console.log(`[Socket.IO] User ${userName || userId} joined org room: org:${orgId}`);
    }

    socket.on("disconnect", (reason) => {
      // Clean disconnect
    });
  });

  return io;
}

/**
 * Return current Socket.IO server instance
 */
export function getIO() {
  return ioInstance;
}

/**
 * Emit an event to all connected clients in an organization room
 */
export function emitToOrg(orgId, event, data) {
  if (!ioInstance || !orgId) return;
  const payload = {
    ...data,
    orgId: orgId.toString(),
    serverTimestamp: new Date().toISOString(),
  };
  ioInstance.to(`org:${orgId.toString()}`).emit(event, payload);
}

/**
 * Emit an event to a specific user's personal room
 */
export function emitToUser(userId, event, data) {
  if (!ioInstance || !userId) return;
  const payload = {
    ...data,
    userId: userId.toString(),
    serverTimestamp: new Date().toISOString(),
  };
  ioInstance.to(`user:${userId.toString()}`).emit(event, payload);
}
