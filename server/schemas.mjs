import * as z from "zod";
import { AppError } from "./errors.mjs";

export const id = z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/);
export const nullableId = id.nullable().optional();
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const timestamp = z.string().max(40);
export const shortText = z.string().max(160);
export const longText = z.string().max(4000);
export const email = z.string().min(3).max(254).email();
export const emptyEmail = z.union([email, z.literal("")]);
export const role = z.enum(["school_admin", "coordinator", "tutor", "viewer"]);
export const dataScope = z.enum(["school", "assigned"]);
export const placementStatus = z.enum(["planned", "active", "review", "complete", "cancelled"]);
export const documentStatus = z.enum(["missing", "draft", "ready", "signed", "archived"]);
export const documentKind = z.enum([
  "training_agreement",
  "attendance_log",
  "evaluation",
  "completion_certificate",
  "other",
]);

export function parseInput(schema, value) {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new AppError(
    400,
    "invalid_request",
    "The request did not match the expected shape.",
    parsed.error.issues.slice(0, 20).map((issue) => ({
      field: issue.path.length === 0 ? "/" : `/${issue.path.join("/")}`,
      rule: issue.code,
    })),
  );
}

export function serialize(schema, value) {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const error = new Error("A response did not match its DTO.");
  error.code = "INVALID_RESPONSE_DTO";
  error.issues = parsed.error.issues.map((issue) => ({
    field: issue.path.join("."),
    rule: issue.code,
  }));
  throw error;
}

export const ErrorResponse = z.object({
  error: z.object({
    code: z.string().max(80),
    message: z.string().max(500),
    requestId: z.string().max(100),
    details: z.unknown().optional(),
  }),
});

export const BrandingResponse = z.object({
  revision: z.number().int().positive(),
  schoolName: z.string().max(120),
  shortName: z.string().max(40),
  productName: z.string().max(60),
  timeZone: z.string().min(1).max(100),
  primaryColor: z.string().regex(/^#[0-9a-f]{6}$/),
  accentColor: z.string().regex(/^#[0-9a-f]{6}$/),
  surfaceColor: z.string().regex(/^#[0-9a-f]{6}$/),
  onPrimaryColor: z.enum(["#000000", "#ffffff"]),
  onAccentColor: z.enum(["#000000", "#ffffff"]),
  onSurfaceColor: z.enum(["#000000", "#ffffff"]),
  supportEmail: z.string().max(254),
  contactText: z.string().max(240),
  footerText: z.string().max(240),
  hasLogo: z.boolean(),
});

export const UserResponse = z.object({
  id,
  email,
  displayName: z.string().max(120),
  role,
  dataScope,
  mustChangePassword: z.boolean(),
  schoolName: z.string().max(120),
  productName: z.string().max(60),
});

export const SessionResponse = z.object({
  authenticated: z.boolean(),
  user: UserResponse.nullable(),
  csrfToken: z.string().max(100).nullable(),
  expiresAt: timestamp.nullable(),
});

export const DashboardResponse = z.object({
  placements: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  review: z.number().int().nonnegative(),
  complete: z.number().int().nonnegative(),
  completion: z.number().int().min(0).max(100),
  documentGaps: z.number().int().nonnegative(),
});

export const PlacementResponse = z.object({
  id,
  studentId: id,
  studentName: z.string().max(250),
  cohortName: z.string().max(160),
  hostId: id,
  hostName: z.string().max(200),
  periodId: id.nullable(),
  schoolTutorId: id.nullable(),
  schoolTutorName: z.string().max(120),
  hostTutorName: z.string().max(120),
  startDate: isoDate,
  endDate: isoDate,
  targetHours: z.number().nonnegative(),
  loggedHours: z.number().nonnegative(),
  status: placementStatus,
  revision: z.number().int().positive(),
  documentGaps: z.number().int().nonnegative(),
  lastCheckInAt: timestamp.nullable(),
});

export const TimeEntryResponse = z.object({
  id,
  entryDate: isoDate,
  hours: z.number().nonnegative(),
  description: z.string().max(500),
  verificationStatus: z.enum(["pending", "verified", "rejected"]),
  canEdit: z.boolean(),
  revision: z.number().int().positive(),
  createdAt: timestamp,
});

export const CheckInResponse = z.object({
  id,
  occurredAt: timestamp,
  channel: z.enum(["in_person", "phone", "email", "video", "other"]),
  summary: z.string().max(2000),
  nextAction: z.string().max(1000),
  voided: z.boolean(),
  voidReason: z.string().max(500),
  canEdit: z.boolean(),
  canVoid: z.boolean(),
  revision: z.number().int().positive(),
  createdAt: timestamp,
});

export const DocumentResponse = z.object({
  id,
  kind: documentKind,
  title: shortText,
  status: documentStatus,
  reference: z.string().max(500),
  dueDate: isoDate.nullable(),
  superseded: z.boolean(),
  supersededById: id.nullable(),
  supersedeReasonCode: z.string().max(80).nullable(),
  canEdit: z.boolean(),
  canArchive: z.boolean(),
  canSupersede: z.boolean(),
  revision: z.number().int().positive(),
  updatedAt: timestamp,
});

export const PlacementDetailResponse = PlacementResponse.extend({
  studentEmail: z.string().max(254),
  studentExternalRef: shortText,
  hostSector: shortText,
  hostContactName: shortText,
  hostContactEmail: z.string().max(254),
  hostContactPhone: z.string().max(80),
  hostAddress: z.string().max(500),
  hostTutorEmail: z.string().max(254),
  notes: longText,
  timeEntries: z.array(TimeEntryResponse),
  checkIns: z.array(CheckInResponse),
  documents: z.array(DocumentResponse),
  readiness: z.object({
    ready: z.boolean(),
    blockers: z.array(z.object({
      code: z.string().max(100),
      message: z.string().max(300),
    })),
    fingerprint: z.string().length(64).regex(/^[0-9a-f]+$/),
    verifiedHours: z.number().nonnegative(),
    targetHours: z.number().positive(),
  }),
});

export const StudentResponse = z.object({
  id,
  externalRef: z.string().max(160).nullable(),
  firstName: z.string().max(120),
  lastName: z.string().max(120),
  email: z.string().max(254),
  active: z.boolean(),
  retentionHold: z.boolean(),
  revision: z.number().int().positive(),
  cohortId: id.nullable(),
  cohortName: z.string().max(160).nullable(),
});

export const HostResponse = z.object({
  id,
  name: z.string().max(200),
  sector: z.string().max(160),
  contactName: z.string().max(160),
  contactEmail: z.string().max(254),
  contactPhone: z.string().max(80),
  address: z.string().max(500),
  active: z.boolean(),
  revision: z.number().int().positive(),
});

const CollectionCursor = z.string().max(2048).regex(/^[A-Za-z0-9_.-]+$/);
const PageCursor = CollectionCursor.nullable();
const CohortResponse = z.object({
  id,
  name: z.string().max(160),
  academicYear: z.string().max(20),
  track: z.string().max(160),
  tutorUserId: id.nullable(),
  active: z.boolean(),
  revision: z.number().int().positive(),
});
const PeriodResponse = z.object({
  id,
  name: z.string().max(160),
  startDate: isoDate,
  endDate: isoDate,
  active: z.boolean(),
  revision: z.number().int().positive(),
});
const TutorResponse = z.object({
  id,
  displayName: z.string().max(120),
  active: z.boolean(),
});
export const PlacementListResponse = z.object({
  items: z.array(PlacementResponse).max(100),
  nextCursor: PageCursor,
});
export const StudentListResponse = z.object({
  items: z.array(StudentResponse).max(100),
  nextCursor: PageCursor,
});
export const HostListResponse = z.object({
  items: z.array(HostResponse).max(100),
  nextCursor: PageCursor,
});
export const ReferenceDataResponse = z.object({
  items: z.array(z.union([CohortResponse, PeriodResponse, TutorResponse])).max(100),
  nextCursor: PageCursor,
});
export const LookupResponse = z.object({
  items: z.array(z.object({
    id,
    label: z.string().max(250),
    secondary: z.string().max(500),
  })).max(20),
  nextCursor: PageCursor,
});

export const AuditEventResponse = z.object({
  id,
  action: z.string().max(100),
  entityType: z.string().max(100),
  entityId: z.string().max(80).nullable(),
  metadata: z.record(z.string(), z.unknown()),
  requestId: z.string().max(100).nullable(),
  createdAt: timestamp,
  actorName: z.string().max(120),
});
export const AuditResponse = z.object({
  items: z.array(AuditEventResponse).max(200),
  nextCursor: PageCursor,
});

export const UsersResponse = z.object({
  items: z.array(z.object({
    id,
    email,
    displayName: z.string().max(120),
    role,
    dataScope,
    active: z.boolean(),
    mustChangePassword: z.boolean(),
    revision: z.number().int().positive(),
    lastLoginAt: timestamp.nullable(),
    createdAt: timestamp,
  })),
});

export const LoginBody = z.strictObject({
  email,
  password: z.string().min(1).max(256),
});
export const EmptyBody = z.strictObject({});
export const IdParams = z.strictObject({ id });
export const PlacementQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: CollectionCursor.optional(),
  query: z.string().max(120).default(""),
  status: z.enum(["all", "planned", "active", "review", "complete", "cancelled"]).default("all"),
});
export const CollectionQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: CollectionCursor.optional(),
  query: z.string().max(120).default(""),
  active: z.enum(["all", "true", "false"]).default("all"),
});
export const ReferenceParams = z.strictObject({
  resource: z.enum(["cohorts", "periods", "tutors"]),
});
export const LookupParams = z.strictObject({
  resource: z.enum(["students", "hosts", "cohorts", "periods", "tutors"]),
});
export const ReferenceQuery = CollectionQuery;
export const LookupQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(20).default(20),
  cursor: CollectionCursor.optional(),
  query: z.string().max(120).default(""),
});
export const AuditQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: CollectionCursor.optional(),
  action: z.string().max(100).default(""),
  actorId: id.optional(),
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
}).refine(
  (value) => !value.fromDate || !value.toDate || value.fromDate <= value.toDate,
  { message: "Audit start date must not follow the end date.", path: ["toDate"] },
);
export const AuditExportQuery = z.strictObject({
  action: z.string().max(100).default(""),
  actorId: id.optional(),
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
}).refine(
  (value) => !value.fromDate || !value.toDate || value.fromDate <= value.toDate,
  { message: "Audit start date must not follow the end date.", path: ["toDate"] },
);

export const StudentBody = z.strictObject({
  cohortId: nullableId,
  externalRef: z.string().max(160).optional(),
  firstName: z.string().trim().min(1).max(120),
  lastName: z.string().trim().min(1).max(120),
  email: emptyEmail.optional(),
});
export const HostBody = z.strictObject({
  name: z.string().trim().min(1).max(200),
  sector: z.string().max(160).optional(),
  contactName: z.string().max(160).optional(),
  contactEmail: emptyEmail.optional(),
  contactPhone: z.string().max(80).optional(),
  address: z.string().max(500).optional(),
});
export const StudentPatchBody = z.strictObject({
  revision: z.number().int().positive(),
  cohortId: nullableId,
  externalRef: z.string().max(160).optional(),
  firstName: z.string().trim().min(1).max(120).optional(),
  lastName: z.string().trim().min(1).max(120).optional(),
  email: emptyEmail.optional(),
  active: z.boolean().optional(),
  retentionHold: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 1, {
  message: "At least one field must change.",
});
export const HostPatchBody = z.strictObject({
  revision: z.number().int().positive(),
  name: z.string().trim().min(1).max(200).optional(),
  sector: z.string().max(160).optional(),
  contactName: z.string().max(160).optional(),
  contactEmail: emptyEmail.optional(),
  contactPhone: z.string().max(80).optional(),
  address: z.string().max(500).optional(),
  active: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 1, {
  message: "At least one field must change.",
});
export const CohortBody = z.strictObject({
  name: z.string().trim().min(1).max(160),
  academicYear: z.string().trim().min(4).max(20),
  track: z.string().max(160).optional(),
  tutorUserId: nullableId,
});
export const CohortPatchBody = z.strictObject({
  revision: z.number().int().positive(),
  name: z.string().trim().min(1).max(160).optional(),
  academicYear: z.string().trim().min(4).max(20).optional(),
  track: z.string().max(160).optional(),
  tutorUserId: nullableId,
  active: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 1, {
  message: "At least one field must change.",
});
export const PeriodBody = z.strictObject({
  name: z.string().trim().min(1).max(160),
  startDate: isoDate,
  endDate: isoDate,
});
export const PeriodPatchBody = z.strictObject({
  revision: z.number().int().positive(),
  name: z.string().trim().min(1).max(160).optional(),
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
  active: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 1, {
  message: "At least one field must change.",
});
export const PlacementBody = z.strictObject({
  studentId: id,
  hostId: id,
  periodId: nullableId,
  schoolTutorId: nullableId,
  hostTutorName: z.string().max(120).optional(),
  hostTutorEmail: emptyEmail.optional(),
  startDate: isoDate,
  endDate: isoDate,
  targetHours: z.number().positive().max(2000),
  status: placementStatus.optional(),
  notes: longText.optional(),
});
export const PlacementPatchBody = z.strictObject({
  revision: z.number().int().positive(),
  studentId: id.optional(),
  hostId: id.optional(),
  periodId: nullableId,
  schoolTutorId: nullableId,
  hostTutorName: z.string().max(120).optional(),
  hostTutorEmail: emptyEmail.optional(),
  status: placementStatus.optional(),
  notes: longText.optional(),
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
  targetHours: z.number().positive().max(2000).optional(),
  reopenReasonCode: z.enum([
    "premature_completion",
    "incorrect_evidence",
    "administrative_correction",
  ]).optional(),
}).refine((value) => Object.keys(value).length > 1, {
  message: "At least one field must change.",
});
export const TimeEntryBody = z.strictObject({
  entryDate: isoDate,
  hours: z.number().positive().max(24),
  description: z.string().max(500).optional(),
  verificationStatus: z.enum(["pending", "verified", "rejected"]).optional(),
});
export const CheckInBody = z.strictObject({
  occurredAt: z.string().regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?Z$/,
  ),
  channel: z.enum(["in_person", "phone", "email", "video", "other"]),
  summary: z.string().trim().min(1).max(2000),
  nextAction: z.string().max(1000).optional(),
});
export const CheckInPatchBody = z.strictObject({
  revision: z.number().int().positive(),
  occurredAt: z.string().regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?Z$/,
  ).optional(),
  channel: z.enum(["in_person", "phone", "email", "video", "other"]).optional(),
  summary: z.string().trim().min(1).max(2000).optional(),
  nextAction: z.string().max(1000).optional(),
  voided: z.literal(true).optional(),
  voidReason: z.string().trim().min(10).max(500).optional(),
}).refine((value) => Object.keys(value).length > 1, {
  message: "At least one field must change.",
}).refine((value) => value.voided !== true || Boolean(value.voidReason), {
  message: "A reason is required when voiding a check-in.",
  path: ["voidReason"],
});
export const DocumentBody = z.strictObject({
  kind: documentKind,
  title: z.string().trim().min(1).max(160),
  status: documentStatus,
  reference: z.string().max(500).optional(),
  dueDate: isoDate.nullable().optional(),
});
export const BrandingBody = z.strictObject({
  revision: z.number().int().positive(),
  schoolName: z.string().trim().min(1).max(120),
  shortName: z.string().trim().min(1).max(40),
  productName: z.string().trim().min(1).max(60),
  timeZone: z.string().trim().min(1).max(100),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  surfaceColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  supportEmail: z.union([email, z.literal("")]),
  contactText: z.string().trim().min(1).max(240),
  footerText: z.string().trim().min(1).max(240),
});
export const RetentionBody = z.strictObject({
  beforeDate: isoDate,
  dryRun: z.boolean(),
  confirm: z.string().max(40),
  fingerprint: z.string().length(64).regex(/^[0-9a-f]+$/).optional(),
}).superRefine((value, context) => {
  if (!value.dryRun && !value.fingerprint) {
    context.addIssue({
      code: "custom",
      path: ["fingerprint"],
      message: "Execution requires the fingerprint returned by a dry run.",
    });
  }
});
export const UserCreateBody = z.strictObject({
  email,
  displayName: z.string().trim().min(1).max(120),
  password: z.string().min(14).max(256),
  role,
  dataScope,
});
export const UserPatchBody = z.strictObject({
  revision: z.number().int().positive(),
  displayName: z.string().trim().min(1).max(120).optional(),
  role: role.optional(),
  dataScope: dataScope.optional(),
  active: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 1, {
  message: "At least one field must change.",
});
export const PasswordResetBody = z.strictObject({
  revision: z.number().int().positive(),
  password: z.string().min(14).max(256),
});
export const ChangePasswordBody = z.strictObject({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(14).max(256),
}).refine((value) => value.currentPassword !== value.newPassword, {
  message: "The new password must differ from the current password.",
  path: ["newPassword"],
});
export const TimeEntryPatchBody = z.strictObject({
  revision: z.number().int().positive(),
  entryDate: isoDate.optional(),
  hours: z.number().positive().max(24).optional(),
  description: z.string().max(500).optional(),
  verificationStatus: z.enum(["pending", "verified", "rejected"]).optional(),
}).refine((value) => Object.keys(value).length > 1, {
  message: "At least one field must change.",
});
export const DocumentPatchBody = z.strictObject({
  kind: documentKind.optional(),
  title: z.string().trim().min(1).max(160).optional(),
  status: documentStatus.optional(),
  reference: z.string().max(500).optional(),
  dueDate: isoDate.nullable().optional(),
  revision: z.number().int().positive(),
}).refine((value) => Object.keys(value).length > 1, {
  message: "At least one field must change.",
});
export const DocumentSupersedeBody = z.strictObject({
  revision: z.number().int().positive(),
  reasonCode: z.enum([
    "incorrect_evidence",
    "replacement_received",
    "administrative_correction",
  ]),
  title: z.string().trim().min(1).max(160),
  status: z.enum(["missing", "draft", "ready"]).default("draft"),
  reference: z.string().max(500).optional(),
  dueDate: isoDate.nullable().optional(),
});
export const PlacementEntryParams = z.strictObject({
  placementId: id,
  entryId: id,
});
export const PlacementDocumentParams = z.strictObject({
  placementId: id,
  documentId: id,
});
export const PlacementCheckInParams = z.strictObject({
  placementId: id,
  checkInId: id,
});
export const ImportParams = z.strictObject({
  resource: z.enum(["students", "hosts", "placements"]),
});
export const ImportQuery = z.strictObject({
  dryRun: z.enum(["true", "false"]).transform((value) => value === "true"),
});
export const ImportResponse = z.object({
  resource: z.enum(["students", "hosts", "placements"]),
  dryRun: z.boolean(),
  accepted: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  errors: z.array(z.object({
    row: z.number().int().positive(),
    field: z.string().max(80),
    code: z.string().max(80),
  })),
});
export const ExportQuery = z.strictObject({
  resource: z.enum(["students", "hosts", "placements"]),
  format: z.enum(["csv", "json"]).default("csv"),
  query: z.string().max(120).default(""),
  active: z.enum(["all", "true", "false"]).default("all"),
  status: z.enum(["all", "planned", "active", "review", "complete", "cancelled"]).default("all"),
});

export const OkResponse = z.object({ ok: z.literal(true) });
export const IdResponse = z.object({ id });
export const IdRevisionResponse = z.object({ id, revision: z.number().int().positive() });
export const DocumentSupersedeResponse = z.object({
  id,
  revision: z.number().int().positive(),
  supersededId: id,
  supersededRevision: z.number().int().positive(),
});
export const DimensionsResponse = z.object({
  width: z.number().int().min(16).max(2048),
  height: z.number().int().min(16).max(2048),
  revision: z.number().int().positive(),
});
export const RevisionResponse = z.object({
  revision: z.number().int().positive(),
});
export const RetentionResponse = z.object({
  beforeDate: isoDate,
  dryRun: z.boolean(),
  deletedPlacements: z.number().int().nonnegative(),
  deletedStudents: z.number().int().nonnegative(),
  candidates: z.number().int().min(0).max(1000),
  hasMore: z.boolean(),
  held: z.number().int().nonnegative(),
  cleanupPending: z.boolean(),
  fingerprint: z.string().length(64).regex(/^[0-9a-f]+$/),
  preview: z.array(z.object({
    id,
    externalRef: z.string().max(160).nullable(),
    placementCount: z.number().int().nonnegative(),
    lastPlacementEnd: isoDate.nullable(),
    updatedAt: timestamp,
  })).max(1000),
});
