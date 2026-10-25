import express from "express";
import bcrypt from "bcrypt";
import { randomBytes } from "node:crypto";
import {
  hashOpaqueToken,
  normalizeEmail,
  normalizeDisplayName,
  passwordIsValid,
  safeStringEqual,
} from "./security.js";

const TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const HOST_LEASE_MS = 90 * 1000;
const MAX_SESSION_PLAYERS = 32;
const MIN_SESSION_PLAYERS = 2;
const authAttempts = new Map();

function apiError(status, code, message = code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function publicAccount(account) {
  return {
    id: account.id,
    email: account.email,
    displayName: account.displayName,
    createdAt: account.createdAt,
  };
}

function publicSession(session) {
  return {
    id: session.id,
    label: session.label,
    gameVersion: session.gameVersion,
    region: session.region,
    maxPlayers: session.maxPlayers,
    currentPlayers: session.activePlayers,
    private: session.isPrivate,
    host: session.owner
      ? { id: session.owner.id, displayName: session.owner.displayName }
      : undefined,
    createdAt: session.createdAt,
    heartbeatAt: session.heartbeatAt,
    expiresAt: session.expiresAt,
  };
}

function issueJoinCode() {
  // The plaintext code is only returned at creation time; only its SHA-256 hash is stored.
  return randomBytes(12).toString("base64url");
}

function pruneRateLimitEntries() {
  const now = Date.now();
  for (const [key, value] of authAttempts) {
    if (value.resetAt <= now) authAttempts.delete(key);
  }
  // Prevent unbounded growth on a long-running development server.
  if (authAttempts.size > 5000) {
    const entries = [...authAttempts.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
    for (const [key] of entries.slice(0, authAttempts.size - 4000)) authAttempts.delete(key);
  }
}

function applyAuthRateLimit(req, res, next) {
  // This is a small per-process safety net, not a replacement for edge/WAF rate limiting.
  const now = Date.now();
  const address = req.ip || req.socket?.remoteAddress || "unknown";
  const key = req.path + ":" + address;
  const current = authAttempts.get(key);
  if (!current || current.resetAt <= now) {
    authAttempts.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
    pruneRateLimitEntries();
    return next();
  }
  if (current.count >= 10) {
    res.set("Retry-After", String(Math.max(1, Math.ceil((current.resetAt - now) / 1000))));
    return res.status(429).json({ error: "rate_limited" });
  }
  current.count += 1;
  return next();
}

async function createAuthSession(prisma, account) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + TOKEN_LIFETIME_MS);
  await prisma.pcPortAuthSession.create({
    data: {
      accountId: account.id,
      tokenHash: hashOpaqueToken(token),
      expiresAt,
    },
  });
  return { token, expiresAt };
}

export function createPcPortRouter(prisma) {
  const router = express.Router();

  // Keep this API independent from the legacy ROS-shaped XML endpoints.
  router.use(express.json({ limit: "32kb" }));
  router.use(express.urlencoded({ extended: false, limit: "32kb" }));

  router.get("/status", (_req, res) => {
    res.json({
      service: "lso-pcport",
      apiVersion: 1,
      authentication: "independent-account-tokens",
      accountApi: "enabled",
      sessionDirectory: "enabled",
      sessionMembership: "enabled",
      gameTransport: "not-implemented",
      gameWorldSimulation: "not-implemented",
      gtaVPC161Compatibility: "not-verified",
    });
  });

  router.post("/auth/register", applyAuthRateLimit, asyncRoute(async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const displayName = normalizeDisplayName(req.body?.displayName);
    const password = req.body?.password;

    if (!email) throw apiError(400, "invalid_email");
    if (!displayName) throw apiError(400, "invalid_display_name");
    if (!passwordIsValid(password)) {
      throw apiError(400, "invalid_password", "Password must be at least 10 characters and no more than 72 UTF-8 bytes.");
    }

    try {
      const account = await prisma.pcPortAccount.create({
        data: {
          email,
          displayName,
          displayNameNormalized: displayName.toLowerCase(),
          passwordHash: await bcrypt.hash(password, 12),
        },
      });
      const session = await createAuthSession(prisma, account);
      return res.status(201).json({
        account: publicAccount(account),
        token: session.token,
        expiresAt: session.expiresAt,
      });
    } catch (error) {
      if (error?.code === "P2002") throw apiError(409, "account_conflict");
      throw error;
    }
  }));

  router.post("/auth/login", applyAuthRateLimit, asyncRoute(async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    if (!email || typeof password !== "string" || password.length > 128) {
      throw apiError(401, "invalid_credentials");
    }

    const account = await prisma.pcPortAccount.findUnique({ where: { email } });
    if (!account || !(await bcrypt.compare(password, account.passwordHash))) {
      // Keep the same response for unknown users and incorrect passwords.
      throw apiError(401, "invalid_credentials");
    }

    const session = await createAuthSession(prisma, account);
    return res.json({
      account: publicAccount(account),
      token: session.token,
      expiresAt: session.expiresAt,
    });
  }));

  const requireAuth = asyncRoute(async (req, _res, next) => {
    const authorization = req.get("authorization") || "";
    const match = authorization.match(/^Bearer\s+([A-Za-z0-9_-]{40,128})$/i);
    if (!match) throw apiError(401, "authentication_required");

    const authSession = await prisma.pcPortAuthSession.findFirst({
      where: {
        tokenHash: hashOpaqueToken(match[1]),
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: { account: true },
    });
    if (!authSession) throw apiError(401, "invalid_or_expired_token");

    req.pcAccount = authSession.account;
    req.pcAuthSession = authSession;
    return next();
  });

  router.get("/auth/me", requireAuth, (req, res) => {
    res.json({ account: publicAccount(req.pcAccount) });
  });

  router.post("/auth/logout", requireAuth, asyncRoute(async (req, res) => {
    await prisma.pcPortAuthSession.update({
      where: { id: req.pcAuthSession.id },
      data: { revokedAt: new Date() },
    });
    res.json({ ok: true });
  }));

  router.get("/sessions", requireAuth, asyncRoute(async (req, res) => {
    const gameVersion = typeof req.query.gameVersion === "string"
      ? req.query.gameVersion.trim().slice(0, 64)
      : "";
    const region = typeof req.query.region === "string"
      ? req.query.region.trim().slice(0, 24)
      : "";
    const sessions = await prisma.pcPortGameSession.findMany({
      where: {
        expiresAt: { gt: new Date() },
        ...(gameVersion ? { gameVersion } : {}),
        ...(region ? { region } : {}),
        OR: [{ isPrivate: false }, { ownerId: req.pcAccount.id }],
      },
      include: {
        owner: { select: { id: true, displayName: true } },
      },
      orderBy: { heartbeatAt: "desc" },
      take: 100,
    });

    return res.json({
      sessions: sessions
        .filter((session) => session.activePlayers < session.maxPlayers || session.ownerId === req.pcAccount.id)
        .map(publicSession),
    });
  }));

  router.post("/sessions", requireAuth, asyncRoute(async (req, res) => {
    const label = typeof req.body?.label === "string" ? req.body.label.trim() : "";
    const gameVersion = typeof req.body?.gameVersion === "string" ? req.body.gameVersion.trim() : "";
    const region = typeof req.body?.region === "string" ? req.body.region.trim().toLowerCase() : "auto";
    const maxPlayers = Number(req.body?.maxPlayers ?? 16);
    const isPrivate = req.body?.private === true;

    if (!label || label.length > 48) throw apiError(400, "invalid_label");
    if (!gameVersion || gameVersion.length > 64) throw apiError(400, "invalid_game_version");
    if (!/^[a-z0-9-]{2,24}$/.test(region)) throw apiError(400, "invalid_region");
    if (!Number.isInteger(maxPlayers) || maxPlayers < MIN_SESSION_PLAYERS || maxPlayers > MAX_SESSION_PLAYERS) {
      throw apiError(400, "invalid_max_players");
    }

    const joinCode = isPrivate ? issueJoinCode() : null;
    const now = new Date();
    const session = await prisma.$transaction(async (tx) => {
      const created = await tx.pcPortGameSession.create({
        data: {
          ownerId: req.pcAccount.id,
          label,
          gameVersion,
          region,
          maxPlayers,
          activePlayers: 1,
          isPrivate,
          joinCodeHash: joinCode ? hashOpaqueToken(joinCode) : null,
          heartbeatAt: now,
          expiresAt: new Date(now.getTime() + HOST_LEASE_MS),
        },
      });
      await tx.pcPortSessionMember.create({
        data: { sessionId: created.id, accountId: req.pcAccount.id },
      });
      return created;
    });

    return res.status(201).json({
      session: publicSession({ ...session, owner: req.pcAccount }),
      ...(joinCode ? { joinCode } : {}),
      heartbeatIntervalSeconds: 30,
      note: "Directory listing only; this endpoint does not establish game networking.",
    });
  }));

  router.post("/sessions/:id/heartbeat", requireAuth, asyncRoute(async (req, res) => {
    const now = new Date();
    const updated = await prisma.pcPortGameSession.updateMany({
      where: { id: req.params.id, ownerId: req.pcAccount.id },
      data: {
        heartbeatAt: now,
        expiresAt: new Date(now.getTime() + HOST_LEASE_MS),
      },
    });
    if (!updated.count) throw apiError(404, "session_not_found");
    return res.json({
      ok: true,
      heartbeatIntervalSeconds: 30,
      expiresAt: new Date(now.getTime() + HOST_LEASE_MS),
    });
  }));

  router.post("/sessions/:id/join", requireAuth, asyncRoute(async (req, res) => {
    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      const session = await tx.pcPortGameSession.findUnique({
        where: { id: req.params.id },
      });
      if (!session || session.expiresAt <= now) throw apiError(404, "session_not_found");
      if (session.ownerId === req.pcAccount.id) {
        return { alreadyMember: true, activePlayers: session.activePlayers };
      }

      if (session.isPrivate) {
        const joinCode = typeof req.body?.joinCode === "string" ? req.body.joinCode : "";
        if (!joinCode || !safeStringEqual(session.joinCodeHash || "", hashOpaqueToken(joinCode))) {
          throw apiError(403, "invalid_join_code");
        }
      }

      const existing = await tx.pcPortSessionMember.findUnique({
        where: {
          sessionId_accountId: {
            sessionId: session.id,
            accountId: req.pcAccount.id,
          },
        },
      });
      if (existing) return { alreadyMember: true, activePlayers: session.activePlayers };

      const reserved = await tx.pcPortGameSession.updateMany({
        where: {
          id: session.id,
          expiresAt: { gt: now },
          activePlayers: { lt: session.maxPlayers },
        },
        data: { activePlayers: { increment: 1 } },
      });
      if (reserved.count !== 1) throw apiError(409, "session_full_or_expired");

      await tx.pcPortSessionMember.create({
        data: { sessionId: session.id, accountId: req.pcAccount.id },
      });
      const updated = await tx.pcPortGameSession.findUnique({
        where: { id: session.id },
      });
      return { alreadyMember: false, activePlayers: updated.activePlayers };
    });

    return res.json({
      ok: true,
      alreadyMember: result.alreadyMember,
      currentPlayers: result.activePlayers,
      note: "Membership recorded; actual game connection is not provided by this API.",
    });
  }));

  router.post("/sessions/:id/leave", requireAuth, asyncRoute(async (req, res) => {
    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      const session = await tx.pcPortGameSession.findUnique({
        where: { id: req.params.id },
      });
      if (!session) return { left: true, hostEnded: false };
      const member = await tx.pcPortSessionMember.findUnique({
        where: {
          sessionId_accountId: {
            sessionId: session.id,
            accountId: req.pcAccount.id,
          },
        },
      });
      if (!member) return { left: true, hostEnded: false };

      if (session.ownerId === req.pcAccount.id) {
        await tx.pcPortSessionMember.deleteMany({ where: { sessionId: session.id } });
        await tx.pcPortGameSession.update({
          where: { id: session.id },
          data: { activePlayers: 0, expiresAt: now, heartbeatAt: now },
        });
        return { left: true, hostEnded: true };
      }

      await tx.pcPortSessionMember.delete({ where: { id: member.id } });
      const updated = await tx.pcPortGameSession.update({
        where: { id: session.id },
        data: { activePlayers: { decrement: 1 } },
      });
      return { left: true, hostEnded: false, currentPlayers: updated.activePlayers };
    });

    return res.json(result);
  }));

  router.use((error, _req, res, _next) => {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    if (status >= 500) console.error("[PC port API]", error);
    return res.status(status).json({
      error: status >= 500 ? "internal_error" : error.code || "request_failed",
      ...(status < 500 && error.message && error.message !== error.code
        ? { message: error.message }
        : {}),
    });
  });

  return router;
}
