import { writeAudit } from "./audit.mjs";
import { conflict } from "./errors.mjs";
import { requirePermission } from "./rbac.mjs";
import {
  assertBrandPalette,
  assertPng,
  cleanText,
  readableTextColor,
} from "./validation.mjs";
import { assertIanaTimeZone, dateAtInstantInTimeZone } from "./school-time.mjs";

export function readBranding(db) {
  const row = db.prepare(`
    SELECT
      revision,
      name AS schoolName,
      short_name AS shortName,
      product_name AS productName,
      time_zone AS timeZone,
      primary_color AS primaryColor,
      accent_color AS accentColor,
      surface_color AS surfaceColor,
      COALESCE(support_email, '') AS supportEmail,
      contact_text AS contactText,
      footer_text AS footerText,
      logo_blob IS NOT NULL AS hasLogo
    FROM schools
    ORDER BY created_at
    LIMIT 1
  `).get();
  return {
    ...row,
    hasLogo: row.hasLogo === 1,
    onPrimaryColor: readableTextColor(row.primaryColor),
    onAccentColor: readableTextColor(row.accentColor),
    onSurfaceColor: readableTextColor(row.surfaceColor),
  };
}

export function readBrandingCss(db) {
  const branding = readBranding(db);
  return `:root{--primary:${branding.primaryColor};--accent:${branding.accentColor};--surface:${branding.surfaceColor};--on-primary:${branding.onPrimaryColor};--on-accent:${branding.onAccentColor};--on-surface:${branding.onSurfaceColor}}\n`;
}

export function updateBranding(db, user, input, requestId) {
  requirePermission(user, "manage_branding");
  const now = new Date().toISOString();
  const palette = assertBrandPalette(input);
  const branding = {
    schoolName: cleanText(input.schoolName, 120, { required: true }),
    shortName: cleanText(input.shortName, 40, { required: true }),
    productName: cleanText(input.productName, 60, { required: true }),
    timeZone: assertIanaTimeZone(input.timeZone),
    primaryColor: palette.primaryColor,
    accentColor: palette.accentColor,
    surfaceColor: palette.surfaceColor,
    supportEmail: cleanText(input.supportEmail, 254),
    contactText: cleanText(input.contactText, 240, { required: true }),
    footerText: cleanText(input.footerText, 240, { required: true }),
  };
  const current = db.prepare(
    "SELECT time_zone AS timeZone, revision FROM schools WHERE id = ?",
  ).get(user.schoolId);
  if (!current) throw new Error("The school branding record is unavailable.");
  if (current.revision !== input.revision) {
    throw conflict("Branding changed after it was loaded. Refresh and try again.");
  }
  db.transaction(() => {
    if (branding.timeZone !== current.timeZone) {
      const checkIns = db.prepare(`
        SELECT ci.occurred_at AS occurredAt, p.start_date AS startDate, p.end_date AS endDate
        FROM check_ins ci
        JOIN placements p ON p.id = ci.placement_id
        WHERE p.school_id = ?
      `).all(user.schoolId);
      const conflicts = checkIns.filter((checkIn) => {
        const localDate = dateAtInstantInTimeZone(checkIn.occurredAt, branding.timeZone);
        return localDate < checkIn.startDate || localDate > checkIn.endDate;
      });
      if (conflicts.length > 0) {
        const error = new Error(
          "The selected time zone would move recorded check-ins outside their placement dates.",
        );
        error.statusCode = 422;
        error.code = "time_zone_activity_conflict";
        error.details = { count: conflicts.length };
        throw error;
      }
    }
    const result = db.prepare(`
      UPDATE schools
      SET
        name = @schoolName,
        short_name = @shortName,
        product_name = @productName,
        time_zone = @timeZone,
        primary_color = @primaryColor,
        accent_color = @accentColor,
        surface_color = @surfaceColor,
        support_email = NULLIF(@supportEmail, ''),
        contact_text = @contactText,
        footer_text = @footerText,
        revision = revision + 1,
        updated_at = @now
      WHERE id = @schoolId AND revision = @revision
    `).run({
      ...branding,
      revision: input.revision,
      now,
      schoolId: user.schoolId,
    });
    if (result.changes !== 1) {
      throw conflict("Branding changed while it was being saved.");
    }
    writeAudit(db, {
      schoolId: user.schoolId,
      actorUserId: user.id,
      action: "branding.updated",
      entityType: "school",
      entityId: user.schoolId,
      metadata: {
        changedFields: [
          "schoolName",
          "shortName",
          "productName",
          "timeZone",
          "primaryColor",
          "accentColor",
          "surfaceColor",
          "supportEmail",
          "contactText",
          "footerText",
        ],
      },
      requestId,
    });
  }).immediate();
  return readBranding(db);
}

export function readLogo(db) {
  return db.prepare(`
    SELECT logo_mime AS mime, logo_blob AS body, updated_at AS updatedAt
    FROM schools
    WHERE logo_blob IS NOT NULL
    ORDER BY created_at
    LIMIT 1
  `).get();
}

export function updateLogo(db, user, body, expectedRevision, requestId) {
  requirePermission(user, "manage_branding");
  const dimensions = assertPng(body);
  const now = new Date().toISOString();
  return db.transaction(() => {
    const result = db.prepare(`
      UPDATE schools
      SET logo_mime = 'image/png', logo_blob = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(body, now, user.schoolId, expectedRevision);
    if (result.changes !== 1) {
      throw conflict("Branding changed while the logo was being saved.");
    }
    writeAudit(db, {
      schoolId: user.schoolId,
      actorUserId: user.id,
      action: "branding.logo_updated",
      entityType: "school",
      entityId: user.schoolId,
      metadata: { changedFields: ["logo"], count: body.length },
      requestId,
    });
    return { ...dimensions, revision: expectedRevision + 1 };
  }).immediate();
}

export function deleteLogo(db, user, expectedRevision, requestId) {
  requirePermission(user, "manage_branding");
  return db.transaction(() => {
    const result = db.prepare(`
      UPDATE schools
      SET
        logo_mime = NULL,
        logo_blob = NULL,
        revision = revision + 1,
        updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(new Date().toISOString(), user.schoolId, expectedRevision);
    if (result.changes !== 1) {
      throw conflict("Branding changed while the logo was being removed.");
    }
    writeAudit(db, {
      schoolId: user.schoolId,
      actorUserId: user.id,
      action: "branding.logo_deleted",
      entityType: "school",
      entityId: user.schoolId,
      metadata: { changedFields: ["logo"] },
      requestId,
    });
    return expectedRevision + 1;
  }).immediate();
}
