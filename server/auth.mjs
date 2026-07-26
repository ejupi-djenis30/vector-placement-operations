import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AppError } from "./errors.mjs";

export const SESSION_COOKIE = "vector_session";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function userFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    schoolId: row.school_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    dataScope: row.data_scope,
    active: row.active === 1,
    mustChangePassword: row.must_change_password === 1,
    revision: row.revision,
    schoolName: row.school_name,
    productName: row.product_name,
  };
}

export function findUserForLogin(db, email) {
  return db.prepare(`
    SELECT
      u.*,
      s.name AS school_name,
      s.product_name
    FROM users u
    JOIN schools s ON s.id = u.school_id
    WHERE u.email = ? COLLATE NOCASE
    LIMIT 1
  `).get(email.trim().toLowerCase());
}

export function createSession(db, userId, sessionHours) {
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(24).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + sessionHours * 60 * 60 * 1000);
  db.prepare(`
    INSERT INTO sessions (
      id, user_id, token_hash, csrf_token, expires_at, created_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    userId,
    sha256(token),
    csrfToken,
    expiresAt.toISOString(),
    now.toISOString(),
    now.toISOString(),
  );
  return { token, csrfToken, expiresAt };
}

export function deleteSession(db, token) {
  if (!token) return;
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
}

export function deleteExpiredSessions(db, now = new Date().toISOString()) {
  return db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now).changes;
}

export function readSession(db, token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT
      se.id AS session_id,
      se.csrf_token,
      se.expires_at,
      u.*,
      s.name AS school_name,
      s.product_name
    FROM sessions se
    JOIN users u ON u.id = se.user_id
    JOIN schools s ON s.id = u.school_id
    WHERE se.token_hash = ?
      AND se.expires_at > ?
      AND u.active = 1
    LIMIT 1
  `).get(sha256(token), new Date().toISOString());
  if (!row) return null;
  db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?")
    .run(new Date().toISOString(), row.session_id);
  return {
    id: row.session_id,
    csrfToken: row.csrf_token,
    expiresAt: row.expires_at,
    user: userFromRow(row),
  };
}

export function sessionCookieOptions(config, expires = undefined) {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure: config.cookieSecure,
    expires,
  };
}

function requestOrigin(request) {
  const value = request.headers.origin;
  if (typeof value === "string") return value.replace(/\/$/, "");
  return null;
}

export function verifyRequestOrigin(request, config) {
  if (!config.origin) return;
  const expected = config.origin.replace(/\/$/, "");
  const origin = requestOrigin(request);
  if (!origin || origin !== expected) {
    throw new AppError(403, "invalid_origin", "The request origin is not allowed.");
  }
}

export function verifyCsrf(request) {
  const provided = request.headers["x-csrf-token"];
  if (
    typeof provided !== "string"
    || !request.session?.csrfToken
    || provided !== request.session.csrfToken
  ) {
    throw new AppError(403, "invalid_csrf", "The request could not be verified.");
  }
}

export function requireAuthenticated(request) {
  if (!request.user) {
    throw new AppError(401, "authentication_required", "Sign in to continue.");
  }
}
