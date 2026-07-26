import { rateLimit } from "express-rate-limit";
import { writeAudit } from "./audit.mjs";
import {
  createSession,
  deleteExpiredSessions,
  deleteSession,
  findUserForLogin,
  sessionCookieOptions,
  verifyRequestOrigin,
} from "./auth.mjs";
import {
  deleteLogo,
  readBranding,
  readBrandingCss,
  readLogo,
  updateBranding,
  updateLogo,
} from "./branding.mjs";
import {
  addCheckIn,
  addDocument,
  addTimeEntry,
  createCohort,
  createHost,
  createPeriod,
  createPlacement,
  createStudent,
  exportAuditEvents,
  getPlacement,
  listAuditEvents,
  listHosts,
  listLookups,
  listPlacements,
  listReferenceData,
  listStudents,
  readDashboard,
  runRetention,
  supersedeDocument,
  updateDocument,
  updateCheckIn,
  updateCohort,
  updateHost,
  updatePeriod,
  updatePlacement,
  updateStudent,
  updateTimeEntry,
} from "./data.mjs";
import { databaseReady } from "./db.mjs";
import { createCursorCodec } from "./cursor.mjs";
import { AppError, notFound } from "./errors.mjs";
import { DUMMY_PASSWORD_HASH, verifyPassword } from "./password.mjs";
import { exportData, importCsv, importTemplate } from "./portability.mjs";
import {
  AuditResponse,
  AuditExportQuery,
  AuditQuery,
  BrandingBody,
  BrandingResponse,
  ChangePasswordBody,
  CheckInBody,
  CheckInPatchBody,
  CollectionQuery,
  CohortBody,
  CohortPatchBody,
  DashboardResponse,
  DimensionsResponse,
  DocumentPatchBody,
  DocumentSupersedeBody,
  DocumentSupersedeResponse,
  DocumentBody,
  EmptyBody,
  ExportQuery,
  HostBody,
  HostPatchBody,
  HostListResponse,
  IdParams,
  IdResponse,
  IdRevisionResponse,
  LoginBody,
  LookupParams,
  LookupQuery,
  LookupResponse,
  OkResponse,
  PasswordResetBody,
  PeriodPatchBody,
  PlacementDocumentParams,
  PlacementCheckInParams,
  PlacementEntryParams,
  PeriodBody,
  PlacementBody,
  PlacementDetailResponse,
  PlacementPatchBody,
  PlacementListResponse,
  PlacementQuery,
  ReferenceDataResponse,
  ReferenceParams,
  ReferenceQuery,
  RevisionResponse,
  RetentionBody,
  RetentionResponse,
  SessionResponse,
  StudentBody,
  StudentListResponse,
  StudentPatchBody,
  TimeEntryBody,
  TimeEntryPatchBody,
  UserCreateBody,
  UserPatchBody,
  UsersResponse,
  ImportParams,
  ImportQuery,
  ImportResponse,
  parseInput,
  serialize,
} from "./schemas.mjs";
import {
  changeOwnPassword,
  createUser,
  listUsers,
  resetUserPassword,
  updateUser,
} from "./users.mjs";
import { APP_VERSION } from "./version.mjs";

const loginLimiter = rateLimit({
  windowMs: 60_000,
  limit: 8,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: (request, response) => {
    response.status(429).json({
      error: {
        code: "rate_limited",
        message: "Too many sign-in attempts. Try again shortly.",
        requestId: request.id,
      },
    });
  },
});

function body(schema, request) {
  return parseInput(schema, request.body ?? {});
}

function params(schema, request) {
  return parseInput(schema, request.params ?? {});
}

function query(schema, request) {
  return parseInput(schema, request.query ?? {});
}

function json(response, schema, value, status = 200) {
  return response.status(status).json(serialize(schema, value));
}

function expectedRevision(request) {
  const header = request.get("If-Match");
  if (header === undefined) {
    throw new AppError(
      428,
      "precondition_required",
      'Send the branding revision as a strong If-Match value, for example "3".',
    );
  }
  const match = /^"([1-9]\d*)"$/.exec(header);
  const revision = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(revision)) {
    throw new AppError(
      400,
      "invalid_precondition",
      'If-Match must contain exactly one strong positive integer revision, for example "3".',
    );
  }
  return revision;
}

export function registerApiRoutes(app, services = {}) {
  const { db, config } = app.locals.vector;
  const passwordVerifier = services.verifyPassword ?? verifyPassword;
  const cursorCodec = services.cursorCodec ?? createCursorCodec();

  app.get("/api/health/live", (_request, response) => {
    response.json({ status: "ok", version: APP_VERSION });
  });

  app.get("/api/health/ready", (request, response) => {
    if (!databaseReady(db)) {
      return response.status(503).json({
        error: {
          code: "not_ready",
          message: "The database is not ready.",
          requestId: request.id,
        },
      });
    }
    const migrations = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version;
    return response.json({
      status: "ready",
      version: APP_VERSION,
      database: "ok",
      migrations,
    });
  });

  app.get("/api/public/branding", (_request, response) => {
    const branding = readBranding(db);
    response.set("ETag", `"${branding.revision}"`);
    json(response, BrandingResponse, branding);
  });

  app.get("/api/public/branding.css", (_request, response) => {
    response
      .type("text/css; charset=utf-8")
      .set("X-Content-Type-Options", "nosniff")
      .set("Cache-Control", "no-cache")
      .send(readBrandingCss(db));
  });

  app.get("/api/public/branding/logo", (_request, response) => {
    const logo = readLogo(db);
    if (!logo) throw notFound("Brand logo");
    response
      .type("image/png")
      .set("X-Content-Type-Options", "nosniff")
      .set("Cache-Control", "no-cache")
      .send(logo.body);
  });

  app.get("/api/session", (request, response) => {
    json(response, SessionResponse, {
      authenticated: Boolean(request.user),
      user: request.user ?? null,
      csrfToken: request.session?.csrfToken ?? null,
      expiresAt: request.session?.expiresAt ?? null,
    });
  });

  app.post("/api/auth/login", loginLimiter, async (request, response) => {
    verifyRequestOrigin(request, config);
    const input = body(LoginBody, request);
    deleteExpiredSessions(db);
    const row = findUserForLogin(db, input.email);
    const passwordMatches = await passwordVerifier(
      input.password,
      row?.password_hash ?? DUMMY_PASSWORD_HASH,
    );
    const valid = row?.active === 1 && passwordMatches;
    if (!valid) {
      if (row?.school_id) {
        writeAudit(db, {
          schoolId: row.school_id,
          actorUserId: null,
          action: "auth.login_failed",
          entityType: "user",
          entityId: row.id,
          metadata: { reasonCode: row.active === 1 ? "invalid_credentials" : "inactive_user" },
          requestId: request.id,
        });
      }
      throw new AppError(401, "invalid_credentials", "Email or password is incorrect.");
    }

    const now = new Date().toISOString();
    const loginResult = db.transaction(() => {
      const fresh = db.prepare(`
        SELECT u.*, s.name AS school_name, s.product_name
        FROM users u
        JOIN schools s ON s.id = u.school_id
        WHERE u.id = ?
      `).get(row.id);
      if (
        !fresh
        || fresh.active !== 1
        || fresh.revision !== row.revision
        || fresh.password_hash !== row.password_hash
      ) {
        throw new AppError(401, "invalid_credentials", "Email or password is incorrect.");
      }
      const createdSession = createSession(db, fresh.id, config.sessionHours);
      db.prepare("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, fresh.id);
      writeAudit(db, {
        schoolId: fresh.school_id,
        actorUserId: fresh.id,
        action: "auth.login_succeeded",
        entityType: "user",
        entityId: fresh.id,
        metadata: {},
        requestId: request.id,
      });
      return { session: createdSession, user: fresh };
    }).immediate();
    response.cookie(
      "vector_session",
      loginResult.session.token,
      sessionCookieOptions(config, loginResult.session.expiresAt),
    );
    return json(response, SessionResponse, {
      authenticated: true,
      user: {
        id: loginResult.user.id,
        email: loginResult.user.email,
        displayName: loginResult.user.display_name,
        role: loginResult.user.role,
        dataScope: loginResult.user.data_scope,
        mustChangePassword: loginResult.user.must_change_password === 1,
        schoolName: loginResult.user.school_name,
        productName: loginResult.user.product_name,
      },
      csrfToken: loginResult.session.csrfToken,
      expiresAt: loginResult.session.expiresAt.toISOString(),
    });
  });

  app.post("/api/auth/logout", (request, response) => {
    body(EmptyBody, request);
    db.transaction(() => {
      deleteSession(db, request.cookies.vector_session);
      writeAudit(db, {
        schoolId: request.user.schoolId,
        actorUserId: request.user.id,
        action: "auth.logout",
        entityType: "user",
        entityId: request.user.id,
        metadata: {},
        requestId: request.id,
      });
    })();
    response.clearCookie("vector_session", sessionCookieOptions(config));
    return json(response, OkResponse, { ok: true });
  });

  app.post("/api/auth/change-password", async (request, response) => {
    const input = body(ChangePasswordBody, request);
    await changeOwnPassword(
      db,
      request.user,
      input.currentPassword,
      input.newPassword,
      request.id,
      services,
    );
    response.clearCookie("vector_session", sessionCookieOptions(config));
    return json(response, OkResponse, { ok: true });
  });

  app.get("/api/dashboard", (request, response) => {
    json(response, DashboardResponse, readDashboard(db, request.user));
  });

  app.get("/api/placements", (request, response) => {
    const filters = query(PlacementQuery, request);
    json(
      response,
      PlacementListResponse,
      listPlacements(db, request.user, filters, cursorCodec),
    );
  });

  app.get("/api/placements/:id", (request, response) => {
    const { id } = params(IdParams, request);
    json(response, PlacementDetailResponse, getPlacement(db, request.user, id));
  });

  app.get("/api/students", (request, response) => {
    const filters = query(CollectionQuery, request);
    json(
      response,
      StudentListResponse,
      listStudents(db, request.user, filters, cursorCodec),
    );
  });

  app.get("/api/hosts", (request, response) => {
    const filters = query(CollectionQuery, request);
    json(response, HostListResponse, listHosts(db, request.user, filters, cursorCodec));
  });

  app.get("/api/reference-data/:resource", (request, response) => {
    const { resource } = params(ReferenceParams, request);
    const filters = query(ReferenceQuery, request);
    json(
      response,
      ReferenceDataResponse,
      listReferenceData(db, request.user, resource, filters, cursorCodec),
    );
  });

  app.get("/api/lookups/:resource", (request, response) => {
    const { resource } = params(LookupParams, request);
    const filters = query(LookupQuery, request);
    json(
      response,
      LookupResponse,
      listLookups(db, request.user, resource, filters, cursorCodec),
    );
  });

  app.post("/api/students", (request, response) => {
    const id = createStudent(db, request.user, body(StudentBody, request), request.id);
    json(response, IdResponse, { id }, 201);
  });

  app.post("/api/hosts", (request, response) => {
    const id = createHost(db, request.user, body(HostBody, request), request.id);
    json(response, IdResponse, { id }, 201);
  });

  app.patch("/api/students/:id", (request, response) => {
    const { id } = params(IdParams, request);
    const revision = updateStudent(
      db,
      request.user,
      id,
      body(StudentPatchBody, request),
      request.id,
    );
    json(response, IdRevisionResponse, { id, revision });
  });

  app.patch("/api/hosts/:id", (request, response) => {
    const { id } = params(IdParams, request);
    const revision = updateHost(
      db,
      request.user,
      id,
      body(HostPatchBody, request),
      request.id,
    );
    json(response, IdRevisionResponse, { id, revision });
  });

  app.post("/api/cohorts", (request, response) => {
    const id = createCohort(db, request.user, body(CohortBody, request), request.id);
    json(response, IdResponse, { id }, 201);
  });

  app.patch("/api/cohorts/:id", (request, response) => {
    const { id } = params(IdParams, request);
    const revision = updateCohort(
      db,
      request.user,
      id,
      body(CohortPatchBody, request),
      request.id,
    );
    json(response, IdRevisionResponse, { id, revision });
  });

  app.post("/api/periods", (request, response) => {
    const id = createPeriod(db, request.user, body(PeriodBody, request), request.id);
    json(response, IdResponse, { id }, 201);
  });

  app.patch("/api/periods/:id", (request, response) => {
    const { id } = params(IdParams, request);
    const revision = updatePeriod(
      db,
      request.user,
      id,
      body(PeriodPatchBody, request),
      request.id,
    );
    json(response, IdRevisionResponse, { id, revision });
  });

  app.post("/api/placements", (request, response) => {
    const id = createPlacement(db, request.user, body(PlacementBody, request), request.id);
    json(response, IdResponse, { id }, 201);
  });

  app.patch("/api/placements/:id", (request, response) => {
    const { id } = params(IdParams, request);
    const revision = updatePlacement(
      db,
      request.user,
      id,
      body(PlacementPatchBody, request),
      request.id,
    );
    json(response, IdRevisionResponse, { id, revision });
  });

  app.post("/api/placements/:id/time-entries", (request, response) => {
    const placement = params(IdParams, request);
    const id = addTimeEntry(
      db,
      request.user,
      placement.id,
      body(TimeEntryBody, request),
      request.id,
    );
    json(response, IdResponse, { id }, 201);
  });

  app.post("/api/placements/:id/check-ins", (request, response) => {
    const placement = params(IdParams, request);
    const id = addCheckIn(
      db,
      request.user,
      placement.id,
      body(CheckInBody, request),
      request.id,
    );
    json(response, IdResponse, { id }, 201);
  });

  app.post("/api/placements/:id/documents", (request, response) => {
    const placement = params(IdParams, request);
    const id = addDocument(
      db,
      request.user,
      placement.id,
      body(DocumentBody, request),
      request.id,
    );
    json(response, IdResponse, { id }, 201);
  });

  app.patch("/api/placements/:placementId/time-entries/:entryId", (request, response) => {
    const route = params(PlacementEntryParams, request);
    const revision = updateTimeEntry(
      db,
      request.user,
      route.placementId,
      route.entryId,
      body(TimeEntryPatchBody, request),
      request.id,
    );
    json(response, IdRevisionResponse, { id: route.entryId, revision });
  });

  app.patch("/api/placements/:placementId/check-ins/:checkInId", (request, response) => {
    const route = params(PlacementCheckInParams, request);
    const revision = updateCheckIn(
      db,
      request.user,
      route.placementId,
      route.checkInId,
      body(CheckInPatchBody, request),
      request.id,
    );
    json(response, IdRevisionResponse, { id: route.checkInId, revision });
  });

  app.patch("/api/placements/:placementId/documents/:documentId", (request, response) => {
    const route = params(PlacementDocumentParams, request);
    const revision = updateDocument(
      db,
      request.user,
      route.placementId,
      route.documentId,
      body(DocumentPatchBody, request),
      request.id,
    );
    json(response, IdRevisionResponse, { id: route.documentId, revision });
  });

  app.post(
    "/api/placements/:placementId/documents/:documentId/supersede",
    (request, response) => {
      const route = params(PlacementDocumentParams, request);
      const result = supersedeDocument(
        db,
        request.user,
        route.placementId,
        route.documentId,
        body(DocumentSupersedeBody, request),
        request.id,
      );
      json(response, DocumentSupersedeResponse, result, 201);
    },
  );

  app.get("/api/audit", (request, response) => {
    const filters = query(AuditQuery, request);
    json(
      response,
      AuditResponse,
      listAuditEvents(db, request.user, filters, cursorCodec),
    );
  });

  app.get("/api/audit/export", (request, response) => {
    const filters = query(AuditExportQuery, request);
    const exported = exportAuditEvents(
      db,
      request.user,
      filters,
      request.id,
      cursorCodec,
    );
    response
      .type("text/csv; charset=utf-8")
      .set("Content-Disposition", `attachment; filename="${exported.filename}"`)
      .set("Cache-Control", "no-store")
      .send(exported.body);
  });

  app.post("/api/maintenance/retention", (request, response) => {
    const input = body(RetentionBody, request);
    if (!input.dryRun && input.confirm !== "ERASE EXPIRED RECORDS") {
      throw new AppError(
        422,
        "confirmation_required",
        "Use the exact retention confirmation phrase before deleting records.",
      );
    }
    json(response, RetentionResponse, runRetention(db, request.user, input, request.id));
  });

  app.get("/api/users", (request, response) => {
    json(response, UsersResponse, { items: listUsers(db, request.user) });
  });

  app.post("/api/users", async (request, response) => {
    const id = await createUser(
      db,
      request.user,
      body(UserCreateBody, request),
      request.id,
      services,
    );
    json(response, IdResponse, { id }, 201);
  });

  app.patch("/api/users/:id", (request, response) => {
    const user = params(IdParams, request);
    const revision = updateUser(
      db,
      request.user,
      user.id,
      body(UserPatchBody, request),
      request.id,
    );
    json(response, IdRevisionResponse, { id: user.id, revision });
  });

  app.post("/api/users/:id/reset-password", async (request, response) => {
    const user = params(IdParams, request);
    const input = body(PasswordResetBody, request);
    const revision = await resetUserPassword(
      db,
      request.user,
      user.id,
      input,
      request.id,
      services,
    );
    json(response, IdRevisionResponse, { id: user.id, revision });
  });

  app.get("/api/import/:resource/template", (request, response) => {
    const { resource } = params(ImportParams, request);
    const template = importTemplate(request.user, resource);
    response
      .type(template.contentType)
      .set("Content-Disposition", `attachment; filename="${template.filename}"`)
      .set("Cache-Control", "no-store")
      .send(template.body);
  });

  app.post("/api/import/:resource", (request, response) => {
    const { resource } = params(ImportParams, request);
    const options = query(ImportQuery, request);
    if (typeof request.body !== "string") {
      throw new AppError(415, "unsupported_media_type", "Imports require a text/csv request body.");
    }
    json(
      response,
      ImportResponse,
      importCsv(db, request.user, resource, request.body, options, request.id),
    );
  });

  app.get("/api/export", (request, response) => {
    const options = query(ExportQuery, request);
    const exported = exportData(
      db,
      request.user,
      options,
      request.id,
      cursorCodec,
    );
    response
      .type(exported.contentType)
      .set("Content-Disposition", `attachment; filename="${exported.filename}"`)
      .set("Cache-Control", "no-store")
      .send(exported.body);
  });

  app.patch("/api/branding", (request, response) => {
    json(
      response,
      BrandingResponse,
      updateBranding(db, request.user, body(BrandingBody, request), request.id),
    );
  });

  app.put("/api/branding/logo", (request, response) => {
    const result = updateLogo(
      db,
      request.user,
      request.body,
      expectedRevision(request),
      request.id,
    );
    response.set("ETag", `"${result.revision}"`);
    json(
      response,
      DimensionsResponse,
      result,
    );
  });

  app.delete("/api/branding/logo", (request, response) => {
    const revision = deleteLogo(
      db,
      request.user,
      expectedRevision(request),
      request.id,
    );
    response.set("ETag", `"${revision}"`);
    json(response, RevisionResponse, { revision });
  });
}
