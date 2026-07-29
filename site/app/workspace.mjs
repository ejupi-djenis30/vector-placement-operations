const app = document.querySelector("#app");
const toastRegion = document.querySelector(".toast-region");
const API = new URL("../api/", import.meta.url).pathname.replace(/\/$/, "");
const state = {
  branding: null,
  session: null,
  dashboard: null,
  attention: [],
  attentionNextCursor: null,
  attentionQuery: "",
  attentionCategory: "all",
  coverage: [],
  coverageSummary: { total: 0, unplaced: 0, placed: 0, conflict: 0 },
  coverageNextCursor: null,
  coverageError: "",
  coverageReference: { cohorts: [], periods: [] },
  coverageQuery: "",
  coverageStatus: "all",
  coverageCohortId: "",
  coveragePeriodId: "",
  placements: [],
  placementsNextCursor: null,
  overviewPlacements: [],
  students: [],
  studentsNextCursor: null,
  hosts: [],
  hostsNextCursor: null,
  reference: { cohorts: [], periods: [], tutors: [] },
  referenceNextCursor: { cohorts: null, periods: null, tutors: null },
  referenceQuery: { cohorts: "", periods: "", tutors: "" },
  programmes: [],
  audit: [],
  auditNextCursor: null,
  auditFilters: { action: "", actorId: "", fromDate: "", toDate: "" },
  users: [],
  view: "overview",
  selectedPlacement: null,
  placementQuery: "",
  placementStatus: "all",
  studentQuery: "",
  studentActive: "all",
  hostQuery: "",
  hostActive: "all",
};

const pagedRequests = {
  attention: { generation: 0, controller: null },
  coverage: { generation: 0, controller: null },
  placements: { generation: 0, controller: null },
  students: { generation: 0, controller: null },
  hosts: { generation: 0, controller: null },
  cohorts: { generation: 0, controller: null },
  periods: { generation: 0, controller: null },
  tutors: { generation: 0, controller: null },
};

function resetPageScroll() {
  window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  window.requestAnimationFrame(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  });
}

function element(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "attrs") Object.entries(value).forEach(([name, attribute]) => node.setAttribute(name, attribute));
    else node[key] = value;
  }
  node.append(...children.filter(Boolean));
  return node;
}

function text(value) {
  return document.createTextNode(value ?? "");
}

function initials(name = "") {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "V";
}

function titleCase(value = "") {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function canWrite() {
  return ["school_admin", "coordinator", "tutor"].includes(state.session?.user?.role);
}

function canViewCoverage() {
  const user = state.session?.user;
  return ["school_admin", "coordinator"].includes(user?.role)
    || (user?.role === "viewer" && user.dataScope === "school");
}

function canManagePeople() {
  return ["school_admin", "coordinator"].includes(state.session?.user?.role);
}

function canManagePlacement() {
  return ["school_admin", "coordinator"].includes(state.session?.user?.role);
}

function canManageProgrammes() {
  return ["school_admin", "coordinator"].includes(state.session?.user?.role);
}

function canReviewEvidence() {
  return canManagePlacement();
}

function isSchoolAdmin() {
  return state.session?.user?.role === "school_admin";
}

function canAudit() {
  return ["school_admin", "coordinator"].includes(state.session?.user?.role);
}

function canManageBranding() {
  return state.session?.user?.role === "school_admin";
}

function isFrozenPlacement(placement) {
  return ["complete", "cancelled"].includes(placement.status);
}

function placementTransitions(status) {
  return {
    planned: ["active", "cancelled"],
    active: ["review", "cancelled"],
    review: ["active", "complete", "cancelled"],
    cancelled: ["planned"],
    complete: ["review"],
  }[status] ?? [];
}

function canExport() {
  return ["school_admin", "coordinator", "tutor"].includes(state.session?.user?.role);
}

function statusClass(status) {
  return `status-pill status-${String(status).toLowerCase().replaceAll("_", "-")}`;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(`${value}`.length === 10 ? `${value}T12:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { day: "2-digit", month: "short", year: "numeric" }).format(date);
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function percentage(placement) {
  return Math.min(100, Math.round((placement.loggedHours / placement.targetHours) * 100) || 0);
}

function flash(message, type = "success") {
  const toast = element("div", { class: `toast ${type === "error" ? "error" : ""}`, text: message });
  toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), 5000);
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  headers.set("Accept", "application/json");
  if (options.body && typeof options.body !== "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
    options.body = JSON.stringify(options.body);
  }
  if (options.method && !["GET", "HEAD"].includes(options.method.toUpperCase()) && state.session?.csrfToken) {
    headers.set("X-CSRF-Token", state.session.csrfToken);
  }
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json") ? await response.json().catch(() => null) : await response.text();
  if (!response.ok) {
    const error = new Error(payload?.error?.message || "The request could not be completed.");
    error.code = payload?.error?.code;
    error.details = payload?.error?.details;
    error.status = response.status;
    if (error.code === "authentication_required" && path !== "/auth/login" && state.session?.authenticated) {
      resetCoverageSessionState();
      state.session = null;
      window.setTimeout(() => {
        loginScreen();
        flash("Your session ended. Sign in to continue.", "error");
      }, 0);
    }
    throw error;
  }
  return payload;
}

async function downloadExport(resource) {
  try {
    const params = new URLSearchParams({ resource, format: "csv", query: "", active: "all", status: "all" });
    if (resource === "placements") {
      params.set("query", state.placementQuery);
      params.set("status", state.placementStatus);
    } else if (resource === "students") {
      params.set("query", state.studentQuery);
      params.set("active", state.studentActive);
    } else if (resource === "hosts") {
      params.set("query", state.hostQuery);
      params.set("active", state.hostActive);
    }
    const response = await fetch(`${API}/export?${params}`, {
      headers: { Accept: "text/csv" },
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error?.message || "The filtered export could not be prepared.");
    }
    const filename = response.headers.get("content-disposition")?.match(/filename="?([^";]+)"?/i)?.[1] || `${resource}.csv`;
    const url = URL.createObjectURL(await response.blob());
    const link = element("a", { href: url, download: filename });
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    flash(`${titleCase(resource)} export downloaded for the current filters.`);
  } catch (error) {
    flash(error.message, "error");
  }
}

async function apiAvailable() {
  try {
    const response = await fetch(`${API}/health/live`, { headers: { Accept: "application/json" }, cache: "no-store" });
    const payload = response.ok ? await response.json() : null;
    return payload?.status === "ok";
  } catch {
    return false;
  }
}

function applyBranding(branding) {
  if (!branding) return;
  document.title = `${branding.productName} — Workspace`;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", branding.primaryColor);
  const favicon = document.querySelector('link[rel="icon"]');
  if (favicon) {
    favicon.setAttribute("href", branding.hasLogo ? `${API}/public/branding/logo` : "../assets/vector-mark.svg");
    favicon.setAttribute("type", branding.hasLogo ? "image/png" : "image/svg+xml");
  }
}

function refreshBrandingStylesheet() {
  const link = document.querySelector("#runtime-branding");
  if (link) link.href = `${API}/public/branding.css?v=${Date.now()}`;
}

function brandImage() {
  const image = element("img", { width: 34, height: 34, alt: "" });
  image.src = state.branding?.hasLogo ? `${API}/public/branding/logo` : "../assets/vector-mark.svg";
  return image;
}

async function loadAllActiveCoverageReference(resource) {
  const items = [];
  const seenCursors = new Set();
  let cursor = null;
  do {
    const result = await request(`/reference-data/${resource}?${pageQueryParams({
      limit: 100,
      cursor,
      query: "",
      active: "true",
    })}`);
    items.push(...result.items);
    cursor = result.nextCursor;
    if (cursor) {
      if (seenCursors.has(cursor)) {
        throw new Error(`The active ${resource} cursor repeated before the list completed.`);
      }
      seenCursors.add(cursor);
    }
  } while (cursor);
  return items;
}

async function loadWorkspaceData() {
  Object.values(pagedRequests).forEach((tracker) => {
    tracker.controller?.abort();
    tracker.generation += 1;
  });
  const tasks = [
    request("/dashboard"),
    request(`/placements?${pageQueryParams({ limit: 6, query: "", status: "all" })}`),
    request(`/attention?${pageQueryParams({ limit: 50, query: state.attentionQuery, category: state.attentionCategory })}`),
    request(`/placements?${pageQueryParams({ limit: 50, query: state.placementQuery, status: state.placementStatus })}`),
    request(`/students?${pageQueryParams({ limit: 50, query: state.studentQuery, active: state.studentActive })}`),
    request(`/hosts?${pageQueryParams({ limit: 50, query: state.hostQuery, active: state.hostActive })}`),
    request(`/reference-data/cohorts?${pageQueryParams({ limit: 100, query: state.referenceQuery.cohorts, active: "all" })}`),
    request(`/reference-data/periods?${pageQueryParams({ limit: 100, query: state.referenceQuery.periods, active: "all" })}`),
    request(`/reference-data/tutors?${pageQueryParams({ limit: 100, query: state.referenceQuery.tutors, active: "all" })}`),
    request("/programmes"),
  ];
  if (canViewCoverage()) {
    tasks.push(loadAllActiveCoverageReference("cohorts"));
    tasks.push(loadAllActiveCoverageReference("periods"));
  }
  if (canAudit()) tasks.push(request(`/audit?${auditQueryParams({ limit: 50 })}`));
  if (canManageBranding()) tasks.push(request("/users"));
  const results = await Promise.all(tasks);
  state.dashboard = results[0];
  state.overviewPlacements = results[1].items;
  state.attention = results[2].items;
  state.attentionNextCursor = results[2].nextCursor;
  const [placements, students, hosts, cohorts, periods, tutors, programmes] = results.slice(3, 10);
  state.placements = placements.items;
  state.placementsNextCursor = placements.nextCursor;
  state.students = students.items;
  state.studentsNextCursor = students.nextCursor;
  state.hosts = hosts.items;
  state.hostsNextCursor = hosts.nextCursor;
  state.reference = { cohorts: cohorts.items, periods: periods.items, tutors: tutors.items };
  state.referenceNextCursor = { cohorts: cohorts.nextCursor, periods: periods.nextCursor, tutors: tutors.nextCursor };
  state.programmes = programmes.items;
  let offset = 10;
  if (canViewCoverage()) {
    state.coverageReference = {
      cohorts: results[offset++],
      periods: results[offset++],
    };
    ensureCoverageDefaults();
    await loadCoverage();
  } else {
    state.coverageReference = { cohorts: [], periods: [] };
    resetCoverageState();
  }
  if (canAudit()) {
    const auditResult = results[offset++];
    state.audit = auditResult.items;
    state.auditNextCursor = auditResult.nextCursor;
  } else {
    state.audit = [];
    state.auditNextCursor = null;
  }
  state.users = canManageBranding() ? results[offset]?.items ?? [] : [];
}

function pageQueryParams({
  limit = 50,
  cursor,
  query = "",
  status,
  active,
  category,
  cohortId,
  periodId,
} = {}) {
  const params = new URLSearchParams({ limit: String(limit), query });
  if (cursor) params.set("cursor", cursor);
  if (status) params.set("status", status);
  if (active) params.set("active", active);
  if (category) params.set("category", category);
  if (cohortId) params.set("cohortId", cohortId);
  if (periodId) params.set("periodId", periodId);
  return params.toString();
}

function resetCoverageState(error = "") {
  state.coverage = [];
  state.coverageSummary = { total: 0, unplaced: 0, placed: 0, conflict: 0 };
  state.coverageNextCursor = null;
  state.coverageError = error;
}

function resetCoverageSessionState() {
  const tracker = pagedRequests.coverage;
  tracker.controller?.abort();
  tracker.controller = null;
  tracker.generation += 1;
  state.coverageReference = { cohorts: [], periods: [] };
  state.coverageQuery = "";
  state.coverageStatus = "all";
  state.coverageCohortId = "";
  state.coveragePeriodId = "";
  resetCoverageState();
}

function ensureCoverageDefaults() {
  const activeCohorts = state.coverageReference.cohorts.filter((item) => item.active);
  const activePeriods = state.coverageReference.periods.filter((item) => item.active);
  if (!activeCohorts.some((item) => item.id === state.coverageCohortId)) {
    state.coverageCohortId = activeCohorts[0]?.id ?? "";
  }
  if (!activePeriods.some((item) => item.id === state.coveragePeriodId)) {
    state.coveragePeriodId = activePeriods[0]?.id ?? "";
  }
  if (!state.coverageCohortId || !state.coveragePeriodId) resetCoverageState();
  return { activeCohorts, activePeriods };
}

function coverageRequestIsCurrent(snapshot, generation) {
  return generation === pagedRequests.coverage.generation
    && snapshot.cohortId === state.coverageCohortId
    && snapshot.periodId === state.coveragePeriodId
    && snapshot.status === state.coverageStatus
    && snapshot.query === state.coverageQuery;
}

async function loadCoverage({ append = false } = {}) {
  const tracker = pagedRequests.coverage;
  tracker.controller?.abort();
  tracker.controller = new AbortController();
  const generation = ++tracker.generation;
  const snapshot = {
    cohortId: state.coverageCohortId,
    periodId: state.coveragePeriodId,
    status: state.coverageStatus,
    query: state.coverageQuery,
    cursor: append ? state.coverageNextCursor : null,
  };
  if (!snapshot.cohortId || !snapshot.periodId) {
    resetCoverageState();
    return false;
  }
  if (append && !snapshot.cursor) return false;
  try {
    const result = await request(`/coverage?${pageQueryParams({ limit: 50, ...snapshot })}`, {
      signal: tracker.controller.signal,
    });
    if (!coverageRequestIsCurrent(snapshot, generation)) return false;
    state.coverage = append ? [...state.coverage, ...result.items] : result.items;
    state.coverageSummary = result.summary;
    state.coverageNextCursor = result.nextCursor;
    state.coverageError = "";
    return true;
  } catch (error) {
    if (error.name === "AbortError") return false;
    if (!coverageRequestIsCurrent(snapshot, generation)) return false;
    if (append && error.code === "invalid_cursor") {
      state.coverageNextCursor = null;
      flash("The coverage page cursor expired. The first page has been refreshed.");
      return loadCoverage();
    }
    resetCoverageState(error.message);
    throw error;
  }
}

async function loadPlacements({ append = false } = {}) {
  const tracker = pagedRequests.placements;
  tracker.controller?.abort();
  tracker.controller = new AbortController();
  const generation = ++tracker.generation;
  const snapshot = {
    query: state.placementQuery,
    status: state.placementStatus,
    cursor: append ? state.placementsNextCursor : null,
  };
  if (append && !snapshot.cursor) return false;
  try {
    const result = await request(`/placements?${pageQueryParams({ limit: 50, ...snapshot })}`, { signal: tracker.controller.signal });
    if (generation !== tracker.generation || snapshot.query !== state.placementQuery || snapshot.status !== state.placementStatus) return false;
    state.placements = append ? [...state.placements, ...result.items] : result.items;
    state.placementsNextCursor = result.nextCursor;
    return true;
  } catch (error) {
    if (error.name === "AbortError") return false;
    if (append && error.code === "invalid_cursor") {
      state.placementsNextCursor = null;
      flash("The placement page cursor expired. The first page has been refreshed.");
      return loadPlacements();
    }
    throw error;
  }
}

async function loadAttention({ append = false } = {}) {
  const tracker = pagedRequests.attention;
  tracker.controller?.abort();
  tracker.controller = new AbortController();
  const generation = ++tracker.generation;
  const snapshot = {
    query: state.attentionQuery,
    category: state.attentionCategory,
    cursor: append ? state.attentionNextCursor : null,
  };
  if (append && !snapshot.cursor) return false;
  try {
    const result = await request(`/attention?${pageQueryParams({ limit: 50, ...snapshot })}`, {
      signal: tracker.controller.signal,
    });
    if (
      generation !== tracker.generation
      || snapshot.query !== state.attentionQuery
      || snapshot.category !== state.attentionCategory
    ) return false;
    state.attention = append ? [...state.attention, ...result.items] : result.items;
    state.attentionNextCursor = result.nextCursor;
    return true;
  } catch (error) {
    if (error.name === "AbortError") return false;
    if (append && error.code === "invalid_cursor") {
      state.attentionNextCursor = null;
      flash("The attention page cursor expired. The first page has been refreshed.");
      return loadAttention();
    }
    throw error;
  }
}

async function loadStudents({ append = false } = {}) {
  const tracker = pagedRequests.students;
  tracker.controller?.abort();
  tracker.controller = new AbortController();
  const generation = ++tracker.generation;
  const snapshot = {
    query: state.studentQuery,
    active: state.studentActive,
    cursor: append ? state.studentsNextCursor : null,
  };
  if (append && !snapshot.cursor) return false;
  try {
    const result = await request(`/students?${pageQueryParams({ limit: 50, ...snapshot })}`, { signal: tracker.controller.signal });
    if (generation !== tracker.generation || snapshot.query !== state.studentQuery || snapshot.active !== state.studentActive) return false;
    state.students = append ? [...state.students, ...result.items] : result.items;
    state.studentsNextCursor = result.nextCursor;
    return true;
  } catch (error) {
    if (error.name === "AbortError") return false;
    if (append && error.code === "invalid_cursor") {
      state.studentsNextCursor = null;
      flash("The student page cursor expired. The first page has been refreshed.");
      return loadStudents();
    }
    throw error;
  }
}

async function loadHosts({ append = false } = {}) {
  const tracker = pagedRequests.hosts;
  tracker.controller?.abort();
  tracker.controller = new AbortController();
  const generation = ++tracker.generation;
  const snapshot = {
    query: state.hostQuery,
    active: state.hostActive,
    cursor: append ? state.hostsNextCursor : null,
  };
  if (append && !snapshot.cursor) return false;
  try {
    const result = await request(`/hosts?${pageQueryParams({ limit: 50, ...snapshot })}`, { signal: tracker.controller.signal });
    if (generation !== tracker.generation || snapshot.query !== state.hostQuery || snapshot.active !== state.hostActive) return false;
    state.hosts = append ? [...state.hosts, ...result.items] : result.items;
    state.hostsNextCursor = result.nextCursor;
    return true;
  } catch (error) {
    if (error.name === "AbortError") return false;
    if (append && error.code === "invalid_cursor") {
      state.hostsNextCursor = null;
      flash("The host page cursor expired. The first page has been refreshed.");
      return loadHosts();
    }
    throw error;
  }
}

async function loadReferenceResource(resource, { append = false } = {}) {
  const tracker = pagedRequests[resource];
  tracker.controller?.abort();
  tracker.controller = new AbortController();
  const generation = ++tracker.generation;
  const snapshot = {
    query: state.referenceQuery[resource],
    cursor: append ? state.referenceNextCursor[resource] : null,
  };
  if (append && !snapshot.cursor) return false;
  try {
    const result = await request(`/reference-data/${resource}?${pageQueryParams({ limit: 100, ...snapshot, active: "all" })}`, { signal: tracker.controller.signal });
    if (generation !== tracker.generation || snapshot.query !== state.referenceQuery[resource]) return false;
    state.reference[resource] = append ? [...state.reference[resource], ...result.items] : result.items;
    state.referenceNextCursor[resource] = result.nextCursor;
    return true;
  } catch (error) {
    if (error.name === "AbortError") return false;
    if (append && error.code === "invalid_cursor") {
      state.referenceNextCursor[resource] = null;
      flash(`The ${resource} page cursor expired. The first page has been refreshed.`);
      return loadReferenceResource(resource);
    }
    throw error;
  }
}

function auditQueryParams({ limit, cursor, exportOnly = false } = {}) {
  const params = new URLSearchParams();
  if (!exportOnly) params.set("limit", String(limit ?? 50));
  if (!exportOnly && cursor) params.set("cursor", cursor);
  const { action, actorId, fromDate, toDate } = state.auditFilters;
  if (action.trim()) params.set("action", action.trim());
  if (actorId) params.set("actorId", actorId);
  if (fromDate) params.set("fromDate", fromDate);
  if (toDate) params.set("toDate", toDate);
  return params.toString();
}

async function loadAudit({ append = false } = {}) {
  const cursor = append ? state.auditNextCursor : null;
  try {
    const result = await request(`/audit?${auditQueryParams({ limit: 50, cursor })}`);
    state.audit = append ? [...state.audit, ...result.items] : result.items;
    state.auditNextCursor = result.nextCursor;
  } catch (error) {
    if (append && error.code === "invalid_cursor") {
      state.auditNextCursor = null;
      flash("The audit page cursor expired. The first page has been refreshed.");
      return loadAudit();
    }
    throw error;
  }
}

async function downloadAuditExport() {
  try {
    const query = auditQueryParams({ exportOnly: true });
    const response = await fetch(`${API}/audit/export${query ? `?${query}` : ""}`, {
      headers: { Accept: "text/csv" },
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error?.message || "The audit export could not be prepared.");
    }
    const filename = response.headers.get("content-disposition")?.match(/filename="?([^";]+)"?/i)?.[1] || "audit.csv";
    const url = URL.createObjectURL(await response.blob());
    const link = element("a", { href: url, download: filename });
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    flash("Filtered audit export downloaded.");
  } catch (error) {
    flash(error.message, "error");
  }
}

function unavailableScreen() {
  app.className = "app-unavailable";
  app.replaceChildren(element("section", { class: "unavailable-card" }, [
    element("div", { class: "login-brand" }, [element("img", { src: "../assets/vector-mark.svg", width: 38, height: 38, alt: "" }), text("VECTOR")]),
    element("p", { class: "eyebrow", text: "Self-hosted workspace" }),
    element("h1", { text: "This page needs a VECTOR installation." }),
    element("p", { text: "The public repository site is a product presentation. Sign-in and records are available only when VECTOR is running on your own server." }),
    element("a", { class: "button button-primary", href: "../#self-host", text: "Read the setup path" }),
  ]));
  resetPageScroll();
}

function loginScreen() {
  app.className = "login-screen";
  const email = element("input", { type: "email", id: "login-email", name: "email", autocomplete: "username", required: true });
  const password = element("input", { type: "password", id: "login-password", name: "password", autocomplete: "current-password", required: true });
  const notice = element("p", { class: "notice", hidden: true, attrs: { role: "alert" } });
  const form = element("form", { class: "login-form" }, [
    field("Email", email),
    field("Password", password),
    element("button", { class: "button-submit", type: "submit", text: "Sign in" }),
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    notice.hidden = true;
    const button = form.querySelector("button");
    button.disabled = true;
    button.textContent = "Signing in…";
    try {
      const session = await request("/auth/login", { method: "POST", body: { email: email.value, password: password.value } });
      resetCoverageSessionState();
      state.session = session;
      if (state.session.user?.mustChangePassword) {
        forcedPasswordScreen();
        flash("Set a permanent password before opening the workspace.");
        return;
      }
      await loadWorkspaceData();
      renderWorkspace();
      resetPageScroll();
      flash("Signed in.");
    } catch (error) {
      notice.textContent = error.message;
      notice.classList.add("error");
      notice.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = "Sign in";
    }
  });
  const support = state.branding?.supportEmail
    ? element("a", { class: "text-link", href: `mailto:${state.branding.supportEmail}`, text: state.branding.supportEmail })
    : null;
  app.replaceChildren(element("section", { class: "login-card" }, [
    element("div", { class: "login-brand" }, [brandImage(), text(state.branding?.productName ?? "VECTOR")]),
    element("p", { class: "eyebrow", text: state.branding?.schoolName ?? "Placement operations" }),
    element("h1", { text: "Sign in to the workspace." }),
    element("p", { text: state.branding?.contactText ?? "Use an account created by your installation administrator." }),
    form,
    notice,
    support,
    element("p", { class: "login-helper", text: state.branding?.footerText ?? "Self-hosted placement operations." }),
  ]));
  resetPageScroll();
}

function forcedPasswordScreen() {
  app.className = "login-screen";
  const currentPassword = simpleInput("password", "", { required: true });
  const newPassword = simpleInput("password", "", { required: true });
  const confirmPassword = simpleInput("password", "", { required: true });
  currentPassword.autocomplete = "current-password";
  newPassword.autocomplete = "new-password";
  confirmPassword.autocomplete = "new-password";
  newPassword.minLength = 14;
  confirmPassword.minLength = 14;
  const notice = element("p", { class: "notice", hidden: true, attrs: { role: "alert" } });
  const form = formWithSubmit([
    { label: "Current temporary password", input: currentPassword, full: true },
    { label: "New password", input: newPassword, full: true },
    { label: "Confirm new password", input: confirmPassword, full: true },
  ], "Set permanent password", async () => {
    notice.hidden = true;
    if (newPassword.value !== confirmPassword.value) {
      notice.textContent = "The new password confirmation does not match.";
      notice.classList.add("error");
      notice.hidden = false;
      throw new Error("The new password confirmation does not match.");
    }
    await request("/auth/change-password", {
      method: "POST",
      body: { currentPassword: currentPassword.value, newPassword: newPassword.value },
    });
    resetCoverageSessionState();
    state.session = null;
    loginScreen();
    flash("Password changed. Sign in with the new password.");
  });
  app.replaceChildren(element("section", { class: "login-card" }, [
    element("div", { class: "login-brand" }, [brandImage(), text(state.branding?.productName ?? "VECTOR")]),
    element("p", { class: "eyebrow", text: "First sign-in security" }),
    element("h1", { text: "Set a permanent password." }),
    element("p", { text: "Your temporary password must be replaced before any placement records are loaded." }),
    form,
    notice,
    element("p", { class: "login-helper", text: state.branding?.footerText ?? "Self-hosted placement operations." }),
  ]));
  resetPageScroll();
}

function navButton(view, icon, label) {
  const button = element("button", { type: "button", dataset: { view }, attrs: { "aria-current": state.view === view ? "page" : "false", "aria-label": label } }, [
    element("span", { text: icon, attrs: { "aria-hidden": "true" } }), element("em", { text: label }),
  ]);
  button.addEventListener("click", () => {
    state.view = view;
    state.selectedPlacement = null;
    renderWorkspace();
    resetPageScroll();
    document.querySelector(".view-header h1")?.focus();
  });
  return button;
}

function renderWorkspace() {
  app.className = "workspace-shell";
  const user = state.session.user;
  const sidebar = element("aside", { class: "workspace-sidebar" }, [
    element("a", { class: "brand", href: "../", attrs: { "aria-label": "Back to product page" } }, [
      brandImage(),
      element("span", { text: state.branding.productName }),
    ]),
    element("nav", { attrs: { "aria-label": "Workspace navigation" } }, [
      navButton("overview", "▦", "Overview"),
      navButton("attention", "!", "Attention"),
      ...(canViewCoverage() ? [navButton("coverage", "▥", "Coverage")] : []),
      navButton("placements", "◫", "Placements"),
      navButton("students", "◎", "Students"),
      navButton("hosts", "◇", "Hosts"),
      ...(canManageProgrammes() ? [navButton("programmes", "⌘", "Programmes")] : []),
      ...(canAudit() ? [navButton("audit", "≋", "Audit")] : []),
      ...(canManageBranding() ? [navButton("settings", "⚙", "Settings")] : []),
    ]),
    element("div", { class: "sidebar-meta" }, [
      element("span", { text: titleCase(user.role) }),
      element("strong", { text: state.branding.schoolName }),
      element("small", { text: user.dataScope === "assigned" ? "Assigned placement scope" : "School-wide scope" }),
    ]),
  ]);
  const main = element("main", { class: "workspace-main", id: "workspace-main", tabIndex: -1 });
  main.append(renderTopbar(), renderCurrentView());
  app.replaceChildren(sidebar, main);
}

function renderTopbar() {
  const user = state.session.user;
  const changePassword = element("button", { class: "button-small", type: "button", text: "Change password", onClick: openChangePasswordForm });
  const logout = element("button", { class: "button-small", type: "button", text: "Sign out" });
  logout.addEventListener("click", async () => {
    try {
      await request("/auth/logout", { method: "POST", body: {} });
      resetCoverageSessionState();
      state.session = null;
      state.view = "overview";
      loginScreen();
    } catch (error) { flash(error.message, "error"); }
  });
  return element("header", { class: "workspace-topbar" }, [
    element("p", { text: `${state.branding.productName} / ${state.branding.shortName}` }),
    element("div", { class: "topbar-actions" }, [
      element("span", { class: "user-menu", dataset: { initials: initials(user.displayName) } }, [
        element("span", { text: user.displayName }),
      ]),
      changePassword,
      logout,
    ]),
  ]);
}

function viewHeader(eyebrow, heading, description, action = null) {
  return element("header", { class: "view-header" }, [
    element("div", {}, [
      element("p", { class: "eyebrow", text: eyebrow }),
      element("h1", { text: heading, tabIndex: -1 }),
      element("p", { text: description }),
    ]), action,
  ]);
}

function renderCurrentView() {
  if (state.view === "attention") return renderAttention();
  if (state.view === "coverage" && canViewCoverage()) return renderCoverage();
  if (state.view === "placements") return state.selectedPlacement ? renderPlacementDetail() : renderPlacements();
  if (state.view === "students") return renderStudents();
  if (state.view === "hosts") return renderHosts();
  if (state.view === "programmes") return renderProgrammes();
  if (state.view === "audit") return renderAudit();
  if (state.view === "settings") return renderSettings();
  return renderOverview();
}

function renderOverview() {
  const dashboard = state.dashboard;
  const latest = state.overviewPlacements;
  const attention = dashboard.attention;
  return element("section", {}, [
    viewHeader("01 / Operating overview", "Know what needs attention next.", "A live, role-scoped view of deadlines, reviews and assignments in this installation."),
    element("div", { class: "metrics-grid", attrs: { "aria-label": "Placement metrics" } }, [
      metric("Placements", dashboard.placements, "in your permitted scope"),
      metric("In progress", dashboard.active, `${dashboard.review} waiting for close-out`),
      metric("Needs attention", attention.total, `${attention.overdue} overdue · ${attention.dueSoon} due soon`),
      metric("Hours logged", `${dashboard.completion}%`, `${dashboard.documentGaps} document gap${dashboard.documentGaps === 1 ? "" : "s"}`, true),
    ]),
    element("section", { class: "workspace-card" }, [
      element("div", { class: "card-toolbar" }, [
        element("strong", { text: "Needs attention" }),
        element("button", { class: "button-small", type: "button", text: "Open attention inbox", onClick: () => { state.view = "attention"; renderWorkspace(); document.querySelector(".view-header h1")?.focus(); } }),
      ]),
      attention.items.length
        ? attentionTable(attention.items, { concise: true })
        : emptyPanel("Nothing needs attention in your scope.", "New deadlines, pending reviews and assignment gaps will appear here."),
    ]),
    element("section", { class: "workspace-card" }, [
      element("div", { class: "card-toolbar" }, [
        element("strong", { text: "Placement register" }),
        element("button", { class: "button-small", type: "button", text: "View all placements", onClick: () => { state.view = "placements"; renderWorkspace(); document.querySelector(".view-header h1")?.focus(); } }),
      ]),
      placementTable(latest, { concise: true }),
    ]),
  ]);
}

function attentionStatusClass(severity) {
  return statusClass(severity === "overdue" ? "cancelled" : severity === "due_soon" ? "review" : "active");
}

function attentionTable(rows, { concise = false } = {}) {
  const headers = concise
    ? ["Action", "Placement", "Priority", ""]
    : ["Action", "Student", "Host", "School tutor", "Priority", "Due", ""];
  const table = element("table", { class: "data-table" });
  const thead = element("thead");
  const headerRow = element("tr");
  headers.forEach((value) => headerRow.append(element("th", { scope: "col", text: value })));
  thead.append(headerRow);
  const body = element("tbody");
  rows.forEach((item) => {
    const row = element("tr");
    row.append(element("td", { dataset: { label: "Action" } }, [
      element("strong", { text: item.title }),
      element("small", { text: item.detail }),
    ]));
    if (concise) {
      row.append(element("td", { dataset: { label: "Placement" } }, [
        element("strong", { text: item.studentName }),
        element("small", { text: `${item.hostName}${item.dueDate ? ` · ${formatDate(item.dueDate)}` : ""}` }),
      ]));
    } else {
      row.append(
        element("td", { dataset: { label: "Student" } }, [element("strong", { text: item.studentName })]),
        element("td", { dataset: { label: "Host" } }, [element("strong", { text: item.hostName })]),
        element("td", { dataset: { label: "School tutor" } }, [element("strong", { text: item.schoolTutorName || "Unassigned" })]),
      );
    }
    row.append(element("td", { dataset: { label: "Priority" } }, [
      element("span", { class: attentionStatusClass(item.severity), text: titleCase(item.severity) }),
    ]));
    if (!concise) {
      row.append(element("td", { dataset: { label: "Due" }, text: item.dueDate ? formatDate(item.dueDate) : "No fixed date" }));
    }
    row.append(element("td", { class: "list-actions" }, [
      element("button", { class: "row-button", type: "button", text: "Open placement", onClick: () => openPlacement(item.placementId) }),
    ]));
    body.append(row);
  });
  table.append(thead, body);
  return table;
}

function renderAttentionList(card) {
  card.querySelectorAll(".data-table, .empty-panel, .load-more-row").forEach((node) => node.remove());
  card.append(state.attention.length
    ? attentionTable(state.attention)
    : emptyPanel("No attention items match this view.", "Try a different category or search term."));
  if (state.attentionNextCursor) {
    const loadMore = element("button", { class: "button-small", type: "button", text: "Load more attention items" });
    loadMore.addEventListener("click", async () => {
      loadMore.disabled = true;
      card.setAttribute("aria-busy", "true");
      try {
        await loadAttention({ append: true });
        renderAttentionList(card);
      } catch (error) {
        flash(error.message, "error");
        loadMore.disabled = false;
      } finally {
        card.removeAttribute("aria-busy");
      }
    });
    card.append(element("div", { class: "card-body load-more-row" }, [loadMore]));
  }
}

function renderAttention() {
  const content = element("section", {}, [
    viewHeader("Priority inbox", "What needs attention.", "Deadlines, pending reviews, status changes and tutor assignment gaps in your permitted scope."),
    element("section", { class: "workspace-card" }),
  ]);
  const card = content.querySelector(".workspace-card");
  const search = element("input", {
    type: "search",
    value: state.attentionQuery,
    placeholder: "Search student, host or tutor",
    attrs: { "aria-label": "Search attention items" },
  });
  let searchTimer = null;
  search.addEventListener("input", () => {
    state.attentionQuery = search.value;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(async () => {
      const expectedQuery = state.attentionQuery;
      card.setAttribute("aria-busy", "true");
      try {
        await loadAttention();
        if (state.attentionQuery === expectedQuery) renderAttentionList(card);
      } catch (error) {
        flash(error.message, "error");
      } finally {
        card.removeAttribute("aria-busy");
      }
    }, 250);
  });
  const tabs = element("div", { class: "filter-tabs", attrs: { "aria-label": "Attention category filter" } });
  [["all", "All"], ["evidence", "Evidence"], ["hours", "Hours"], ["status", "Status"], ["assignment", "Assignment"]]
    .forEach(([category, label]) => {
      const tab = element("button", {
        type: "button",
        text: label,
        attrs: { "aria-pressed": String(state.attentionCategory === category) },
      });
      tab.addEventListener("click", async () => {
        state.attentionCategory = category;
        tabs.querySelectorAll("button").forEach((button) => button.setAttribute("aria-pressed", String(button === tab)));
        card.setAttribute("aria-busy", "true");
        try {
          await loadAttention();
          renderAttentionList(card);
        } catch (error) {
          flash(error.message, "error");
        } finally {
          card.removeAttribute("aria-busy");
        }
      });
      tabs.append(tab);
    });
  card.append(element("div", { class: "card-toolbar" }, [
    element("label", { class: "search-field" }, [search]),
    tabs,
  ]));
  renderAttentionList(card);
  return content;
}

function metric(label, value, detail, accent = false) {
  return element("article", { class: `metric ${accent ? "metric-accent" : ""}` }, [
    element("span", { text: label }), element("strong", { text: String(value) }), element("small", { text: detail }),
  ]);
}

function coverageStatusClass(status) {
  if (status === "placed") return statusClass("active");
  if (status === "conflict") return statusClass("review");
  return statusClass("missing");
}

function renderCoverageMetrics(container) {
  const summary = state.coverageSummary;
  container.replaceChildren(
    metric("Students", summary.total, "in the selected cohort"),
    metric("Unplaced", summary.unplaced, "need a placement"),
    metric("Placed", summary.placed, "have one placement"),
    metric("Conflicts", summary.conflict, "have overlapping placements", true),
  );
}

function coverageTable(rows) {
  const table = element("table", { class: "data-table coverage-table" });
  table.append(element("caption", { class: "sr-only", text: "Student placement coverage" }));
  const thead = element("thead");
  const headerRow = element("tr");
  ["Student", "External reference", "Coverage", "Placements", "Actions"]
    .forEach((label) => headerRow.append(element("th", { scope: "col", text: label })));
  thead.append(headerRow);
  const body = element("tbody");
  const selectedPeriod = state.coverageReference.periods.find((item) => item.id === state.coveragePeriodId);
  rows.forEach((item) => {
    const row = element("tr", { dataset: { studentId: item.studentId }, tabIndex: -1 });
    row.append(
      element("td", { dataset: { label: "Student" } }, [
        element("strong", { text: item.studentName }),
        element("small", { text: item.cohortName || "Selected cohort" }),
      ]),
      element("td", {
        dataset: { label: "External reference" },
        text: item.externalRef || "Not recorded",
      }),
      element("td", { dataset: { label: "Coverage" } }, [
        element("span", { class: coverageStatusClass(item.status), text: titleCase(item.status) }),
        element("small", {
          text: `${item.placementCount} placement${item.placementCount === 1 ? "" : "s"}`,
        }),
      ]),
    );

    const placementList = element("div", { class: "coverage-placement-list" });
    if (!item.placements.length) {
      placementList.append(element("span", { class: "notice-inline", text: "No placement in this period." }));
    } else {
      item.placements.forEach((placement) => {
        placementList.append(element("div", { class: "coverage-placement" }, [
          element("strong", { text: placement.hostName }),
          element("small", {
            text: `${titleCase(placement.status)} · ${formatDate(placement.startDate)}–${formatDate(placement.endDate)}`,
          }),
        ]));
      });
      if (item.additionalPlacements) {
        placementList.append(element("small", {
          class: "coverage-additional",
          text: `+${item.additionalPlacements} additional placement${item.additionalPlacements === 1 ? "" : "s"}`,
        }));
      }
    }
    row.append(element("td", { dataset: { label: "Placements" } }, [placementList]));

    const actions = element("div", { class: "list-actions coverage-actions" });
    item.placements.forEach((placement, index) => {
      actions.append(element("button", {
        class: "row-button",
        type: "button",
        text: "Open placement",
        attrs: {
          "aria-label": `Open placement ${index + 1} of ${item.placementCount} for ${item.studentName} at ${placement.hostName}, ${formatDate(placement.startDate)} to ${formatDate(placement.endDate)}`,
        },
        onClick: () => openPlacement(placement.id),
      }));
    });
    if (item.status === "unplaced" && canManagePlacement() && selectedPeriod) {
      actions.append(element("button", {
        class: "row-button",
        type: "button",
        text: "New placement",
        attrs: { "aria-label": `Create placement for ${item.studentName}` },
        onClick: () => openPlacementForm({
          student: {
            id: item.studentId,
            label: item.studentName,
            secondary: item.externalRef || item.cohortName,
          },
          period: {
            id: selectedPeriod.id,
            label: selectedPeriod.name,
            secondary: `${selectedPeriod.startDate} – ${selectedPeriod.endDate}`,
          },
          startDate: selectedPeriod.startDate,
          endDate: selectedPeriod.endDate,
        }, { returnView: "coverage" }),
      }));
    }
    if (!actions.childElementCount) {
      actions.append(element("span", { class: "notice-inline", text: "Read only" }));
    }
    row.append(element("td", { class: "list-actions", dataset: { label: "Actions" } }, [actions]));
    body.append(row);
  });
  table.append(thead, body);
  return table;
}

function coverageErrorPanel(card) {
  const retry = element("button", {
    class: "button-small",
    type: "button",
    text: "Retry coverage refresh",
  });
  retry.addEventListener("click", async () => {
    retry.disabled = true;
    card.setAttribute("aria-busy", "true");
    try {
      const loaded = await loadCoverage();
      if (!loaded) return;
      const metrics = document.querySelector('[data-coverage-metrics="true"]');
      if (metrics) renderCoverageMetrics(metrics);
      renderCoverageList(card);
      flash("Coverage refreshed.");
      card.querySelector(".coverage-result-count")?.focus();
    } catch (error) {
      renderCoverageList(card);
      flash(error.message, "error");
    } finally {
      card.removeAttribute("aria-busy");
      retry.disabled = false;
    }
  });
  return element("div", { class: "empty-panel", attrs: { role: "alert" } }, [
    element("strong", { text: "Coverage could not be loaded." }),
    element("span", {
      text: state.coverageError || "The current coverage data is unavailable. Retry the refresh.",
    }),
    element("div", { class: "load-more-row coverage-error-actions" }, [retry]),
  ]);
}

function renderCoverageList(card, { focusStudentId = null } = {}) {
  const count = card.querySelector(".coverage-result-count");
  const results = card.querySelector(".coverage-results");
  if (state.coverageError) {
    count.textContent = "Coverage unavailable.";
    results.replaceChildren(coverageErrorPanel(card));
    return;
  }
  const loaded = state.coverage.length;
  const matching = state.coverageStatus === "unplaced"
    ? state.coverageSummary.unplaced
    : state.coverageStatus === "placed"
      ? state.coverageSummary.placed
      : state.coverageStatus === "conflict"
        ? state.coverageSummary.conflict
        : state.coverageSummary.total;
  count.textContent = loaded < matching
    ? `${loaded} of ${matching} matching students loaded.`
    : `${matching} matching student${matching === 1 ? "" : "s"}.`;
  const content = state.coverage.length
    ? coverageTable(state.coverage)
    : emptyPanel(
      "No students match this coverage view.",
      "Try another status filter, search term, cohort or placement period.",
    );
  results.replaceChildren(content);
  if (state.coverageNextCursor) {
    const loadMore = element("button", {
      class: "button-small",
      type: "button",
      text: "Load more students",
    });
    loadMore.addEventListener("click", async () => {
      const firstNewIndex = state.coverage.length;
      loadMore.disabled = true;
      card.setAttribute("aria-busy", "true");
      try {
        const loadedPage = await loadCoverage({ append: true });
        if (!loadedPage) return;
        const firstNewStudentId = state.coverage[firstNewIndex]?.studentId ?? null;
        renderCoverageList(card, { focusStudentId: firstNewStudentId });
      } catch (error) {
        renderCoverageList(card);
        flash(error.message, "error");
      } finally {
        card.removeAttribute("aria-busy");
        loadMore.disabled = false;
      }
    });
    results.append(element("div", { class: "card-body load-more-row" }, [loadMore]));
  }
  if (focusStudentId) {
    const row = [...results.querySelectorAll("[data-student-id]")]
      .find((candidate) => candidate.dataset.studentId === focusStudentId);
    row?.focus();
  }
}

function renderCoverage() {
  const { activeCohorts, activePeriods } = ensureCoverageDefaults();
  const missing = [];
  if (!activeCohorts.length) missing.push("an active cohort");
  if (!activePeriods.length) missing.push("an active placement period");
  if (missing.length) {
    const action = canManagePeople()
      ? element("button", {
        class: "button-small",
        type: "button",
        text: "Open reference data",
        onClick: openReferenceDataManager,
      })
      : null;
    return element("section", {}, [
      viewHeader(
        "Cohort coverage",
        "Prepare the coverage board.",
        `Coverage needs ${missing.join(" and ")} before students can be compared.`,
        action,
      ),
      element("section", { class: "workspace-card" }, [
        emptyPanel(
          "Coverage reference data is incomplete.",
          canManagePeople()
            ? "Create or reactivate the missing reference records, then return to this board."
            : "Ask a coordinator or school administrator to prepare the missing reference records.",
        ),
      ]),
    ]);
  }

  const cohort = selectInput(
    activeCohorts.map((item) => [
      item.id,
      item.academicYear ? `${item.name} · ${item.academicYear}` : item.name,
    ]),
    state.coverageCohortId,
    "Select cohort",
  );
  cohort.id = "coverage-cohort";
  cohort.required = true;
  cohort.firstElementChild.disabled = true;
  const period = selectInput(
    activePeriods.map((item) => [
      item.id,
      `${item.name} · ${formatDate(item.startDate)}–${formatDate(item.endDate)}`,
    ]),
    state.coveragePeriodId,
    "Select placement period",
  );
  period.id = "coverage-period";
  period.required = true;
  period.firstElementChild.disabled = true;
  const metrics = element("div", {
    class: "metrics-grid coverage-metrics",
    dataset: { coverageMetrics: "true" },
    attrs: { "aria-label": "Coverage metrics" },
  });
  renderCoverageMetrics(metrics);

  const search = element("input", {
    type: "search",
    value: state.coverageQuery,
    placeholder: "Search student or external reference",
    attrs: { "aria-label": "Search cohort coverage" },
  });
  const tabs = element("div", {
    class: "filter-tabs",
    attrs: { "aria-label": "Coverage status filter" },
  });
  const card = element("section", { class: "workspace-card coverage-results-card" });
  const resultCount = element("p", {
    class: "coverage-result-count",
    tabIndex: -1,
    attrs: { role: "status", "aria-live": "polite", "aria-atomic": "true" },
  });
  const results = element("div", { class: "coverage-results" });
  card.append(
    element("div", { class: "card-toolbar" }, [
      element("label", { class: "search-field" }, [search]),
      tabs,
    ]),
    resultCount,
    results,
  );

  const refreshResults = async (focusId = null) => {
    card.setAttribute("aria-busy", "true");
    try {
      const loaded = await loadCoverage();
      if (!loaded) return;
      renderCoverageMetrics(metrics);
      renderCoverageList(card);
    } catch (error) {
      renderCoverageMetrics(metrics);
      renderCoverageList(card);
      flash(error.message, "error");
    } finally {
      card.removeAttribute("aria-busy");
      if (focusId) document.getElementById(focusId)?.focus();
    }
  };
  cohort.addEventListener("change", () => {
    state.coverageCohortId = cohort.value;
    refreshResults("coverage-cohort");
  });
  period.addEventListener("change", () => {
    state.coveragePeriodId = period.value;
    refreshResults("coverage-period");
  });

  let searchTimer = null;
  search.addEventListener("input", () => {
    state.coverageQuery = search.value;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(async () => {
      const expectedQuery = state.coverageQuery;
      card.setAttribute("aria-busy", "true");
      try {
        const loaded = await loadCoverage();
        if (loaded && state.coverageQuery === expectedQuery) {
          renderCoverageMetrics(metrics);
          renderCoverageList(card);
        }
      } catch (error) {
        if (state.coverageQuery === expectedQuery) {
          renderCoverageMetrics(metrics);
          renderCoverageList(card);
        }
        flash(error.message, "error");
      } finally {
        card.removeAttribute("aria-busy");
      }
    }, 250);
  });
  [["all", "All"], ["unplaced", "Unplaced"], ["placed", "Placed"], ["conflict", "Conflicts"]]
    .forEach(([status, label]) => {
      const tab = element("button", {
        type: "button",
        text: label,
        attrs: { "aria-pressed": String(state.coverageStatus === status) },
      });
      tab.addEventListener("click", async () => {
        state.coverageStatus = status;
        tabs.querySelectorAll("button").forEach((button) => {
          button.setAttribute("aria-pressed", String(button === tab));
        });
        await refreshResults();
      });
      tabs.append(tab);
    });

  const controls = element("section", { class: "workspace-card coverage-controls-card" }, [
    element("div", { class: "card-body coverage-controls" }, [
      field("Cohort", cohort),
      field("Placement period", period),
    ]),
  ]);
  renderCoverageList(card);
  return element("section", {}, [
    viewHeader(
      "Cohort coverage",
      "Every student, accounted for.",
      "Compare one cohort with one placement period, resolve gaps and inspect overlapping placements.",
    ),
    controls,
    metrics,
    card,
  ]);
}

function renderPlacements() {
  const actions = element("div", { class: "topbar-actions" }, [
    ...(canExport() ? [element("button", { class: "button-small", type: "button", text: "Export current CSV", onClick: () => downloadExport("placements") })] : []),
    ...(canManagePeople() ? [element("button", { class: "button-small", type: "button", text: "Import CSV", onClick: openImportForm })] : []),
    ...(canManagePeople() ? [element("button", { class: "button-small", type: "button", text: "Reference data", onClick: openReferenceDataManager })] : []),
    ...(canManagePeople() ? [element("button", { class: "button-small", type: "button", text: "New placement", onClick: openPlacementForm })] : []),
  ]);
  const content = element("section", {}, [
    viewHeader("02 / Placement register", "Every placement, in context.", "Search and page through the register, then open a record for its evidence and next decision.", actions.childElementCount ? actions : null),
    element("section", { class: "workspace-card" }),
  ]);
  const card = content.querySelector(".workspace-card");
  const search = element("input", { type: "search", value: state.placementQuery, placeholder: "Search student, host or tutor", attrs: { "aria-label": "Search placements" } });
  let searchTimer = null;
  search.addEventListener("input", () => {
    state.placementQuery = search.value;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(async () => {
      const expectedQuery = state.placementQuery;
      card.setAttribute("aria-busy", "true");
      try {
        await loadPlacements();
        if (state.placementQuery === expectedQuery) renderPlacementList(card);
      } catch (error) {
        flash(error.message, "error");
      } finally {
        card.removeAttribute("aria-busy");
      }
    }, 250);
  });
  const tabs = element("div", { class: "filter-tabs", attrs: { "aria-label": "Placement status filter" } });
  ["all", "active", "review", "planned", "complete", "cancelled"].forEach((status) => {
    const tab = element("button", { type: "button", text: status === "all" ? "All" : titleCase(status), attrs: { "aria-pressed": String(state.placementStatus === status) } });
    tab.addEventListener("click", async () => {
      state.placementStatus = status;
      tabs.querySelectorAll("button").forEach((button) => button.setAttribute("aria-pressed", String(button === tab)));
      card.setAttribute("aria-busy", "true");
      try {
        await loadPlacements();
        renderPlacementList(card);
      } catch (error) {
        flash(error.message, "error");
      } finally {
        card.removeAttribute("aria-busy");
      }
    });
    tabs.append(tab);
  });
  card.append(element("div", { class: "card-toolbar" }, [element("label", { class: "search-field" }, [search]), tabs]));
  renderPlacementList(card);
  return content;
}

function renderPlacementList(card) {
  card.querySelectorAll(".data-table, .empty-panel, .load-more-row").forEach((node) => node.remove());
  card.append(state.placements.length
    ? placementTable(state.placements)
    : emptyPanel("No placements match this view.", "Try a different status or search term."));
  if (state.placementsNextCursor) {
    const loadMore = element("button", { class: "button-small", type: "button", text: "Load more placements" });
    loadMore.addEventListener("click", async () => {
      loadMore.disabled = true;
      try {
        await loadPlacements({ append: true });
        renderPlacementList(card);
      } catch (error) {
        flash(error.message, "error");
        loadMore.disabled = false;
      }
    });
    card.append(element("div", { class: "card-body load-more-row" }, [loadMore]));
  }
}

function placementTable(rows, { concise = false } = {}) {
  const headers = concise ? ["Placement", "Status", "Progress", ""] : ["Placement", "Host", "Status", "Progress", "Documents", ""];
  const table = element("table", { class: "data-table" });
  const thead = element("thead");
  const headerRow = element("tr");
  headers.forEach((value) => headerRow.append(element("th", { scope: "col", text: value })));
  thead.append(headerRow);
  const body = element("tbody");
  rows.forEach((placement) => {
    const row = element("tr");
    row.append(
      element("td", { dataset: { label: "Placement" } }, [element("strong", { text: placement.studentName }), element("small", { text: `${placement.cohortName || "No cohort"} · ${formatDate(placement.startDate)}–${formatDate(placement.endDate)}` })]),
    );
    if (!concise) row.append(element("td", { dataset: { label: "Host" } }, [element("strong", { text: placement.hostName }), element("small", { text: placement.schoolTutorName })]));
    row.append(element("td", { dataset: { label: "Status" } }, [element("span", { class: statusClass(placement.status), text: titleCase(placement.status) })]));
    row.append(element("td", { class: "progress-cell", dataset: { label: "Progress" } }, [progressBar(placement)]));
    if (!concise) row.append(element("td", { dataset: { label: "Documents" }, text: placement.documentGaps ? `${placement.documentGaps} gap${placement.documentGaps === 1 ? "" : "s"}` : "Ready" }));
    row.append(element("td", { class: "list-actions" }, [
      element("button", { class: "row-button", type: "button", text: "Open placement", onClick: () => openPlacement(placement.id) }),
    ]));
    body.append(row);
  });
  table.append(thead, body);
  return table;
}

function progressBar(placement) {
  const value = percentage(placement);
  return element("div", {}, [
    element("div", { class: "progress-line" }, [element("span", { text: `${placement.loggedHours} / ${placement.targetHours} h` }), element("b", { text: `${value}%` })]),
    element("progress", { class: "placement-progress", max: 100, value, attrs: { "aria-label": `${value}% of placement target logged` } }),
  ]);
}

function emptyPanel(title, detail) {
  return element("div", { class: "empty-panel" }, [element("strong", { text: title }), element("span", { text: detail })]);
}

async function openPlacement(id) {
  try {
    state.selectedPlacement = await request(`/placements/${encodeURIComponent(id)}`);
    state.view = "placements";
    renderWorkspace();
    document.querySelector(".view-header h1")?.focus?.();
  } catch (error) { flash(error.message, "error"); }
}

function renderPlacementDetail() {
  const placement = state.selectedPlacement;
  const frozen = isFrozenPlacement(placement);
  const back = element("button", { class: "button-small", type: "button", text: "← All placements", onClick: () => { state.selectedPlacement = null; renderWorkspace(); document.querySelector(".view-header h1")?.focus(); } });
  const mayTransition = canManagePlacement()
    && placementTransitions(placement.status).length
    && (placement.status !== "complete" || isSchoolAdmin());
  const statusAction = mayTransition
    ? element("button", { class: "button-small", type: "button", text: placement.status === "complete" ? "Reopen placement" : "Update status", onClick: () => openStatusForm(placement) })
    : null;
  const structureAction = canManagePlacement() && !frozen
    ? element("button", { class: "button-small", type: "button", text: "Edit placement", onClick: () => openPlacementEditForm(placement) })
    : null;
  const actions = element("div", { class: "topbar-actions" }, [back, structureAction, statusAction]);
  const sections = element("div", { class: "activity-columns" }, [
    activitySection("Time entries", placement.timeEntries, (entry) => [
      element("strong", { text: `${entry.hours} hours · ${titleCase(entry.verificationStatus)}` }),
      element("small", { text: `${formatDate(entry.entryDate)} · ${entry.description || "No description"}` }),
      ...(entry.canEdit ? [timeEntryEditButton(placement, entry)] : []),
      ...(!frozen && canReviewEvidence() && entry.verificationStatus === "pending" ? [
        entryReviewButton(placement, entry, "verified"),
        entryReviewButton(placement, entry, "rejected"),
      ] : []),
    ], !frozen && canWrite() ? () => openTimeEntryForm(placement) : null),
    activitySection("Check-ins", placement.checkIns, (checkIn) => [
      element("strong", { text: `${titleCase(checkIn.channel)}${checkIn.voided ? " · Voided" : ""}` }),
      element("small", { text: `${formatDateTime(checkIn.occurredAt)} · ${checkIn.summary}` }),
      ...(checkIn.nextAction ? [element("small", { text: `Next action: ${checkIn.nextAction}` })] : []),
      ...(checkIn.voided && checkIn.voidReason ? [element("small", { text: `Void reason: ${checkIn.voidReason}` })] : []),
      ...(checkIn.canEdit ? [checkInEditButton(placement, checkIn)] : []),
      ...(checkIn.canVoid ? [checkInVoidButton(placement, checkIn)] : []),
    ], !frozen && canWrite() ? () => openCheckInForm(placement) : null),
    activitySection("Documents", placement.documents, (document) => [
      element("strong", { text: `${document.title}${document.superseded ? " · Superseded" : ""}` }),
      element("small", {
        text: `${document.requirementLabel ?? titleCase(document.kind)} · ${titleCase(document.status)}`,
      }),
      ...(document.dueDate ? [element("small", { text: `Due ${formatDate(document.dueDate)}` })] : []),
      ...(document.reference ? [element("small", { text: `Reference: ${document.reference}` })] : []),
      ...(document.supersedeReasonCode ? [element("small", { text: `Superseded: ${titleCase(document.supersedeReasonCode)}` })] : []),
      ...(document.canEdit ? [documentEditButton(placement, document)] : []),
      ...(document.canArchive ? [documentArchiveButton(placement, document)] : []),
      ...(document.canSupersede ? [documentSupersedeButton(placement, document)] : []),
    ], !frozen && canWrite() ? () => openDocumentForm(placement) : null),
  ]);
  return element("section", {}, [
    viewHeader("Placement record", placement.studentName, `${placement.hostName} · ${placement.schoolTutorName}`, actions),
    element("section", { class: "workspace-card detail-panel" }, [
      element("div", { class: "detail-main" }, [
        element("span", { class: statusClass(placement.status), text: titleCase(placement.status) }),
        element("h2", { text: `${placement.loggedHours} of ${placement.targetHours} hours logged` }),
        element("p", { class: "notice", text: `${placement.readiness.verifiedHours} verified hours count toward completion readiness.` }),
        element("p", { text: placement.notes || "No placement note has been recorded." }),
        ...(frozen ? [element("p", { class: "notice", text: placement.status === "complete" ? "This completed record is locked. A school administrator may reopen it for a coded correction." : "This cancelled record is read-only. It may only be returned to planned status." })] : []),
        readinessCard(placement.readiness),
        sections,
      ]),
      element("aside", { class: "detail-side" }, [
        element("h3", { text: "Placement facts" }),
        factsList([
          ["Student", placement.studentName],
          ["Student email", placement.studentEmail ? element("a", { href: `mailto:${placement.studentEmail}`, text: placement.studentEmail }) : "Not recorded"],
          ["Host", placement.hostName],
          ["Host contact", placement.hostContactName || "Not recorded"],
          ["Host email", placement.hostContactEmail ? element("a", { href: `mailto:${placement.hostContactEmail}`, text: placement.hostContactEmail }) : "Not recorded"],
          ["Host phone", placement.hostContactPhone ? element("a", { href: `tel:${placement.hostContactPhone}`, text: placement.hostContactPhone }) : "Not recorded"],
          ["Host address", placement.hostAddress || "Not recorded"],
          ["School tutor", placement.schoolTutorName],
          ["Programme", `${placement.programmeName} · ${placement.programmeCode} · v${placement.programmeVersion}`],
          ["Host tutor", placement.hostTutorName || "Not recorded"],
          ["Host tutor email", placement.hostTutorEmail ? element("a", { href: `mailto:${placement.hostTutorEmail}`, text: placement.hostTutorEmail }) : "Not recorded"],
          ["Dates", `${formatDate(placement.startDate)} – ${formatDate(placement.endDate)}`],
          ["Reference", placement.studentExternalRef || "Not recorded"],
        ]),
      ]),
    ]),
  ]);
}

function factsList(items) {
  const list = element("dl");
  items.forEach(([label, value]) => {
    const detail = element("dd");
    if (value instanceof Node) detail.append(value);
    else detail.textContent = value;
    list.append(element("div", {}, [element("dt", { text: label }), detail]));
  });
  return list;
}

function readinessCard(readiness) {
  const blockers = readiness.blockers.length ? readiness.blockers.map((blocker) => element("li", { text: blocker.message })) : [element("li", { text: "Hours, check-in and close-out documents are ready." })];
  return element("section", { class: `readiness ${readiness.ready ? "is-ready" : ""}` }, [
    element("div", {}, [
      element("h3", { text: `Completion readiness · ${readiness.programmeCode} v${readiness.programmeVersion}` }),
      element("span", { class: statusClass(readiness.ready ? "verified" : "review"), text: readiness.ready ? "Ready" : "Needs attention" }),
    ]),
    element("p", {
      text: `${readiness.completedCheckIns} of ${readiness.minimumCheckIns} required check-ins recorded.`,
    }),
    element("ul", {}, blockers),
  ]);
}

function activitySection(title, entries, renderEntry, create = null) {
  const section = element("section", {}, [element("h3", { text: title })]);
  if (create) {
    const singular = { "Time entries": "time entry", "Check-ins": "check-in", Documents: "document" }[title] ?? title.toLowerCase();
    const add = element("button", { class: "row-button", type: "button", text: `Add ${singular}` });
    add.addEventListener("click", create);
    section.querySelector("h3").append(text(" "), add);
  }
  if (!entries.length) section.append(element("p", { class: "notice", text: "No records yet." }));
  const records = element("div", { class: "activity-records" });
  let expanded = false;
  const renderRecords = () => {
    const visible = entries.slice(0, expanded ? entries.length : 5);
    records.replaceChildren(...visible.map((entry) => {
      const item = element("div", { class: "activity-item" });
      item.append(...renderEntry(entry));
      return item;
    }));
  };
  renderRecords();
  section.append(records);
  if (entries.length > 5) {
    const summary = element("p", { class: "activity-summary", text: `Showing 5 of ${entries.length}.` });
    const toggle = element("button", { class: "row-button", type: "button", text: "Show all" });
    toggle.addEventListener("click", () => {
      expanded = !expanded;
      summary.textContent = expanded ? `Showing all ${entries.length}.` : `Showing 5 of ${entries.length}.`;
      toggle.textContent = expanded ? "Collapse" : "Show all";
      renderRecords();
    });
    section.append(summary, toggle);
  }
  return section;
}

function entryReviewButton(placement, entry, verificationStatus) {
  const label = verificationStatus === "verified" ? "Verify" : "Reject";
  const button = element("button", { class: "row-button", type: "button", text: label });
  button.addEventListener("click", async () => {
    try {
      await request(`/placements/${placement.id}/time-entries/${entry.id}`, {
        method: "PATCH",
        body: { verificationStatus, revision: entry.revision },
      });
      flash(`Time entry ${verificationStatus}.`);
      await openPlacement(placement.id);
      await refreshCore();
    } catch (error) {
      flash(error.message, "error");
    }
  });
  return button;
}

function toDateTimeLocal(value) {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function timeEntryEditButton(placement, entry) {
  const button = element("button", { class: "row-button", type: "button", text: "Edit" });
  button.addEventListener("click", () => openTimeEntryEditForm(placement, entry));
  return button;
}

function openTimeEntryEditForm(placement, entry) {
  const entryDate = simpleInput("date", entry.entryDate, { required: true });
  const hours = simpleInput("number", String(entry.hours), { required: true });
  hours.min = "0.25";
  hours.max = "24";
  hours.step = "0.25";
  const description = element("textarea", { required: true, value: entry.description });
  const fields = [
    { label: "Entry date", input: entryDate },
    { label: "Hours", input: hours },
    { label: "Description", input: description, full: true },
  ];
  let verificationStatus = null;
  if (canReviewEvidence()) {
    verificationStatus = selectInput([["pending", "Pending"], ["verified", "Verified"], ["rejected", "Rejected"]], entry.verificationStatus, "Select review status");
    fields.push({ label: "Review status", input: verificationStatus });
  }
  const form = formWithSubmit(fields, "Save time entry", async () => {
    await request(`/placements/${placement.id}/time-entries/${entry.id}`, {
      method: "PATCH",
      body: {
        revision: entry.revision,
        entryDate: entryDate.value,
        hours: Number(hours.value),
        description: description.value.trim(),
        ...(verificationStatus ? { verificationStatus: verificationStatus.value } : {}),
      },
    });
    await refreshCore();
    await openPlacement(placement.id);
    flash("Time entry updated.");
    close();
  });
  const { close } = openModal("Edit time entry", "Correct the operational record. Every change remains visible in the audit trail.", form);
}

function checkInEditButton(placement, checkIn) {
  const button = element("button", { class: "row-button", type: "button", text: "Edit" });
  button.addEventListener("click", () => openCheckInEditForm(placement, checkIn));
  return button;
}

function openCheckInEditForm(placement, checkIn) {
  const occurredAt = simpleInput("datetime-local", toDateTimeLocal(checkIn.occurredAt), { required: true });
  const channel = selectInput([["in_person", "In person"], ["phone", "Phone"], ["email", "Email"], ["video", "Video"], ["other", "Other"]], checkIn.channel, "Select channel");
  const summary = element("textarea", { required: true, value: checkIn.summary });
  const nextAction = element("textarea", { value: checkIn.nextAction ?? "" });
  const form = formWithSubmit([
    { label: "When", input: occurredAt },
    { label: "Channel", input: channel },
    { label: "Summary", input: summary, full: true },
    { label: "Next action", input: nextAction, full: true },
  ], "Save check-in", async () => {
    await request(`/placements/${placement.id}/check-ins/${checkIn.id}`, {
      method: "PATCH",
      body: {
        revision: checkIn.revision,
        occurredAt: new Date(occurredAt.value).toISOString(),
        channel: channel.value,
        summary: summary.value.trim(),
        nextAction: nextAction.value.trim(),
      },
    });
    await refreshCore();
    await openPlacement(placement.id);
    flash("Check-in updated.");
    close();
  });
  const { close } = openModal("Edit check-in", "Correct the contact record without losing its history.", form);
}

function checkInVoidButton(placement, checkIn) {
  const button = element("button", { class: "row-button danger", type: "button", text: "Void" });
  button.addEventListener("click", () => openCheckInVoidForm(placement, checkIn));
  return button;
}

function openCheckInVoidForm(placement, checkIn) {
  const reason = element("textarea", { required: true });
  reason.minLength = 10;
  reason.maxLength = 500;
  const form = formWithSubmit([{ label: "Reason for voiding", input: reason, full: true }], "Void check-in", async () => {
    await request(`/placements/${placement.id}/check-ins/${checkIn.id}`, {
      method: "PATCH",
      body: { revision: checkIn.revision, voided: true, voidReason: reason.value.trim() },
    });
    await refreshCore();
    await openPlacement(placement.id);
    flash("Check-in voided.");
    close();
  });
  const { close } = openModal("Void check-in", "The record stays visible, clearly marked as void, with your operational reason.", form);
}

function renderStudents() {
  const action = listViewActions("students", canManagePeople() ? ["New student", openStudentForm] : null);
  return entityListView("03 / Student register", "Students", "Search and page through student records in your permitted scope.", state.students, action, [
    ["Student", (item) => [item.firstName, item.lastName].join(" "), (item) => item.externalRef || item.email || "No reference"],
    ["Cohort", (item) => item.cohortName || "Unassigned"],
    ["Status", (item) => `${item.active ? "Active" : "Inactive"}${isSchoolAdmin() && item.retentionHold ? " · Retention hold" : ""}`],
  ], canManagePeople() ? openStudentEditForm : null, {
    query: state.studentQuery,
    active: state.studentActive,
    placeholder: "Search name, reference, email or cohort",
    searchLabel: "Search students",
    setQuery: (value) => { state.studentQuery = value; },
    setActive: (value) => { state.studentActive = value; },
    reload: () => loadStudents(),
    loadMore: () => loadStudents({ append: true }),
    getItems: () => state.students,
    getNextCursor: () => state.studentsNextCursor,
  });
}

function renderHosts() {
  const action = listViewActions("hosts", canManagePeople() ? ["New host", openHostForm] : null);
  return entityListView("04 / Host directory", "Hosts", "Search and page through organisations in your permitted scope.", state.hosts, action, [
    ["Host", (item) => item.name, (item) => item.sector || "No sector"],
    ["Contact", (item) => item.contactName || "Not recorded", (item) => item.contactEmail || item.contactPhone || ""],
    ["Status", (item) => item.active ? "Active" : "Inactive"],
  ], canManagePeople() ? openHostEditForm : null, {
    query: state.hostQuery,
    active: state.hostActive,
    placeholder: "Search organisation, sector or contact",
    searchLabel: "Search hosts",
    setQuery: (value) => { state.hostQuery = value; },
    setActive: (value) => { state.hostActive = value; },
    reload: () => loadHosts(),
    loadMore: () => loadHosts({ append: true }),
    getItems: () => state.hosts,
    getNextCursor: () => state.hostsNextCursor,
  });
}

function listViewActions(resource, createAction) {
  const actions = element("div", { class: "topbar-actions" });
  if (canExport()) actions.append(element("button", { class: "button-small", type: "button", text: "Export current CSV", onClick: () => downloadExport(resource) }));
  if (createAction) actions.append(element("button", { class: "button-small", type: "button", text: createAction[0], onClick: createAction[1] }));
  return actions.childElementCount ? actions : null;
}

function entityListView(eyebrow, title, description, items, action, columns, edit = null, options = null) {
  const card = element("section", { class: "workspace-card" });
  const buildTable = (currentItems) => {
    const table = element("table", { class: "data-table" });
    const head = element("thead");
    const heading = element("tr");
    columns.forEach(([label]) => heading.append(element("th", { scope: "col", text: label })));
    if (edit) heading.append(element("th", { scope: "col", text: "" }));
    head.append(heading);
    const body = element("tbody");
    currentItems.forEach((item) => {
      const row = element("tr");
      columns.forEach(([label, value, detail]) => {
        const main = value(item);
        const cell = element("td", { dataset: { label } }, [element("strong", { text: main })]);
        if (detail?.(item)) cell.append(element("small", { text: detail(item) }));
        row.append(cell);
      });
      if (edit) row.append(element("td", { class: "list-actions" }, [element("button", { class: "row-button", type: "button", text: "Edit", onClick: () => edit(item) })]));
      body.append(row);
    });
    table.append(head, body);
    return table;
  };
  const renderData = () => {
    card.querySelectorAll(".data-table, .empty-panel, .load-more-row").forEach((node) => node.remove());
    const currentItems = options?.getItems?.() ?? items;
    card.append(currentItems.length
      ? buildTable(currentItems)
      : emptyPanel(`No ${title.toLowerCase()} match this view.`, "Adjust the search or status filter."));
    if (options?.getNextCursor?.()) {
      const loadMore = element("button", { class: "button-small", type: "button", text: `Load more ${title.toLowerCase()}` });
      loadMore.addEventListener("click", async () => {
        loadMore.disabled = true;
        card.setAttribute("aria-busy", "true");
        try {
          await options.loadMore();
          renderData();
        } catch (error) {
          flash(error.message, "error");
          loadMore.disabled = false;
        } finally {
          card.removeAttribute("aria-busy");
        }
      });
      card.append(element("div", { class: "card-body load-more-row" }, [loadMore]));
    }
  };

  if (options) {
    const search = element("input", { type: "search", value: options.query, placeholder: options.placeholder, attrs: { "aria-label": options.searchLabel } });
    const active = element("select", { attrs: { "aria-label": `${title} status filter` } }, [
      element("option", { value: "all", text: "All records", selected: options.active === "all" }),
      element("option", { value: "true", text: "Active", selected: options.active === "true" }),
      element("option", { value: "false", text: "Inactive", selected: options.active === "false" }),
    ]);
    let searchTimer = null;
    search.addEventListener("input", () => {
      options.setQuery(search.value);
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(async () => {
        card.setAttribute("aria-busy", "true");
        try {
          await options.reload();
          renderData();
        } catch (error) {
          flash(error.message, "error");
        } finally {
          card.removeAttribute("aria-busy");
        }
      }, 250);
    });
    active.addEventListener("change", async () => {
      options.setActive(active.value);
      card.setAttribute("aria-busy", "true");
      try {
        await options.reload();
        renderData();
      } catch (error) {
        flash(error.message, "error");
      } finally {
        card.removeAttribute("aria-busy");
      }
    });
    card.append(element("div", { class: "card-toolbar" }, [
      element("label", { class: "search-field" }, [search]),
      field("Record status", active),
    ]));
  }
  renderData();
  return element("section", {}, [viewHeader(eyebrow, title, description, action), card]);
}

function renderAudit() {
  if (!canAudit()) return renderOverview();
  const action = simpleInput("search", state.auditFilters.action, { placeholder: "e.g. placement.updated" });
  const fromDate = simpleInput("date", state.auditFilters.fromDate);
  const toDate = simpleInput("date", state.auditFilters.toDate);
  const filterFields = [field("Action contains", action), field("From", fromDate), field("To", toDate)];
  let actor = null;
  if (state.users.length) {
    actor = selectInput([["", "All actors"], ...state.users.map((user) => [user.id, `${user.displayName} · ${user.email}`])], state.auditFilters.actorId, "All actors");
    filterFields.splice(1, 0, field("Actor", actor));
  }
  const filterForm = element("form", { class: "audit-filters" }, filterFields);
  const applyButton = element("button", { class: "button-small", type: "submit", text: "Apply filters" });
  const resetButton = element("button", { class: "row-button", type: "button", text: "Reset" });
  resetButton.addEventListener("click", async () => {
    state.auditFilters = { action: "", actorId: "", fromDate: "", toDate: "" };
    await loadAudit();
    renderWorkspace();
  });
  filterForm.append(element("div", { class: "form-actions audit-filter-actions" }, [applyButton, resetButton]));
  filterForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    applyButton.disabled = true;
    state.auditFilters = {
      action: action.value.trim(),
      actorId: actor?.value ?? "",
      fromDate: fromDate.value,
      toDate: toDate.value,
    };
    try {
      await loadAudit();
      renderWorkspace();
    } catch (error) {
      flash(error.message, "error");
      applyButton.disabled = false;
    }
  });

  const list = element("section", { class: "workspace-card" }, [
    element("div", { class: "card-title" }, [
      element("div", {}, [element("h2", { text: "Audit events" }), element("p", { text: "Filter the school-scoped record. Credentials and session values are never included." })]),
      element("button", { class: "button-small", type: "button", text: "Export filtered CSV", onClick: downloadAuditExport }),
    ]),
    element("div", { class: "card-body" }, [filterForm]),
  ]);
  const rows = element("div", { class: "audit-list" });
  state.audit.forEach((event) => {
    const metadata = Object.keys(event.metadata).length
      ? Object.entries(event.metadata).map(([key, value]) => `${key}: ${typeof value === "object" && value !== null ? JSON.stringify(value) : value}`).join(" · ")
      : "No additional metadata";
    rows.append(element("article", { class: "audit-row" }, [
      element("div", {}, [element("strong", { text: titleCase(event.action) }), element("small", { text: `${event.entityType}${event.entityId ? ` · ${event.entityId}` : ""}` })]),
      element("div", {}, [element("strong", { text: event.actorName }), element("small", { text: "Actor" })]),
      element("code", { text: metadata }),
      element("time", { text: formatDateTime(event.createdAt), dateTime: event.createdAt }),
    ]));
  });
  list.append(state.audit.length ? rows : emptyPanel("No audit events match these filters.", "Adjust the filters or wait for a new operational action."));
  if (state.auditNextCursor) {
    const loadMore = element("button", { class: "button-small load-more", type: "button", text: "Load more events" });
    loadMore.addEventListener("click", async () => {
      loadMore.disabled = true;
      try {
        await loadAudit({ append: true });
        renderWorkspace();
      } catch (error) {
        flash(error.message, "error");
        loadMore.disabled = false;
      }
    });
    list.append(element("div", { class: "card-body load-more-row" }, [loadMore]));
  }
  return element("section", {}, [viewHeader("05 / Audit trail", "Changes leave a trace.", "Search, review and export the operational record without changing it."), list]);
}

function renderSettings() {
  if (!canManageBranding()) return renderOverview();
  const form = brandingForm();
  const userRows = element("div", { class: "user-list" });
  state.users.forEach((user) => userRows.append(element("div", { class: "user-row" }, [
    element("div", {}, [element("strong", { text: user.displayName }), element("small", { text: `${user.email} · ${titleCase(user.role)} · ${user.active ? "Active" : "Inactive"}` })]),
    element("div", { class: "list-actions" }, [
      element("small", { text: user.lastLoginAt ? `Last sign-in ${formatDateTime(user.lastLoginAt)}` : "No sign-in recorded" }),
      element("button", { class: "row-button", type: "button", text: "Edit", onClick: () => openUserEditForm(user) }),
      element("button", { class: "row-button", type: "button", text: "Reset password", onClick: () => openPasswordResetForm(user) }),
    ]),
  ])));
  return element("section", {}, [
    viewHeader("07 / School settings", "Make the workspace your own.", "Branding, access and retention controls apply to this self-hosted installation."),
    element("div", { class: "settings-grid" }, [
      element("section", { class: "workspace-card" }, [
        element("div", { class: "card-title" }, [element("h2", { text: "Runtime branding" }), element("p", { text: "Use colours with enough contrast for your staff. The API rejects unreadable primary and surface colours." })]),
        element("div", { class: "card-body" }, [form, logoManager()]),
      ]),
      element("section", { class: "workspace-card" }, [
        element("div", { class: "card-title" }, [element("h2", { text: "Users" }), element("p", { text: "Accounts and access scope for this school installation." })]),
        element("div", { class: "card-body" }, [element("div", { class: "list-actions" }, [element("button", { class: "button-small", type: "button", text: "New user", onClick: () => openUserCreateForm() })]), userRows]),
      ]),
      retentionManager(),
    ]),
  ]);
}

function programmeRequirementsText(requirements) {
  return requirements
    .map((requirement) => (
      `${requirement.code} | ${requirement.label} | ${requirement.acceptedStatuses.join(", ")}`
    ))
    .join("\n");
}

function parseProgrammeRequirements(value) {
  const allowedStatuses = new Set(["draft", "ready", "signed", "archived"]);
  const codes = new Set();
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .map((line, index) => {
      const [rawCode, rawLabel, rawStatuses, ...extra] = line.split("|");
      const code = rawCode?.trim() ?? "";
      const label = rawLabel?.trim() ?? "";
      const acceptedStatuses = (rawStatuses ?? "")
        .split(",")
        .map((status) => status.trim().toLowerCase())
        .filter(Boolean);
      if (
        extra.length
        || !/^[a-z][a-z0-9_]{1,39}$/.test(code)
        || !label
        || !acceptedStatuses.length
        || acceptedStatuses.some((status) => !allowedStatuses.has(status))
        || new Set(acceptedStatuses).size !== acceptedStatuses.length
        || codes.has(code)
      ) {
        throw new Error(
          `Requirement line ${index + 1} must be: code | label | draft, ready, signed or archived.`,
        );
      }
      codes.add(code);
      return { code, label, acceptedStatuses };
    });
}

function renderProgrammes() {
  if (!canManageProgrammes()) return renderOverview();
  const create = element("button", {
    class: "button-small",
    type: "button",
    text: "New programme",
    onClick: openProgrammeCreateForm,
  });
  const list = element("section", { class: "workspace-card programme-list" });
  if (!state.programmes.length) {
    list.append(emptyPanel(
      "No programmes are configured.",
      "Create the first version before opening placements.",
    ));
  }
  state.programmes.forEach((programme) => {
    const version = programme.currentVersion;
    const requirements = version.requirements.length
      ? version.requirements.map((item) => item.label).join(" · ")
      : "No document requirements";
    list.append(element("article", { class: "programme-row" }, [
      element("div", {}, [
        element("p", { class: "eyebrow", text: `${programme.code} / VERSION ${version.version}` }),
        element("h2", { text: programme.name }),
        element("p", { text: programme.description || "No programme note has been recorded." }),
        element("small", {
          text: `${version.defaultTargetHours} default hours · ${version.minimumCheckIns} minimum check-ins · ${requirements}`,
        }),
      ]),
      element("div", { class: "list-actions" }, [
        element("span", {
          class: statusClass(programme.active ? "verified" : "cancelled"),
          text: programme.active ? "Active" : "Inactive",
        }),
        element("button", {
          class: "row-button",
          type: "button",
          text: "Version history",
          onClick: () => openProgrammeHistory(programme),
        }),
        element("button", {
          class: "row-button",
          type: "button",
          text: "Edit",
          onClick: () => openProgrammeEditForm(programme),
        }),
        element("button", {
          class: "row-button",
          type: "button",
          text: "Publish version",
          onClick: () => openProgrammePublishForm(programme),
        }),
      ]),
    ]));
  });
  return element("section", {}, [
    viewHeader(
      "06 / Programme policies",
      "Rules that stay with the placement.",
      "Publish immutable versions for target hours, check-ins and required evidence. Existing placements keep the version they started with.",
      create,
    ),
    list,
  ]);
}

async function openProgrammeHistory(programme) {
  const result = await request(`/programmes/${programme.id}/versions`);
  const list = element("section", { class: "programme-history" });
  result.items.forEach((version) => {
    const evidence = version.requirements.length
      ? version.requirements.map((requirement) => (
          `${requirement.label} (${requirement.acceptedStatuses.join(", ")})`
        )).join(" · ")
      : "No document requirements";
    list.append(element("article", { class: "programme-history-row" }, [
      element("div", { class: "programme-history-heading" }, [
        element("p", { class: "eyebrow", text: `VERSION ${version.version}` }),
        element("time", {
          text: formatDateTime(version.publishedAt),
          attrs: { datetime: version.publishedAt },
        }),
      ]),
      element("p", {
        text: `${version.defaultTargetHours} default hours · ${version.minimumCheckIns} minimum check-ins`,
      }),
      element("small", { text: evidence }),
    ]));
  });
  openModal(
    `${programme.name} · version history`,
    "Every published version is immutable and remains available for placements that already use it.",
    list,
  );
}

function programmeVersionFields(version = null) {
  const targetHours = simpleInput(
    "number",
    String(version?.defaultTargetHours ?? 160),
    { required: true },
  );
  targetHours.min = "1";
  targetHours.max = "2000";
  targetHours.step = "0.5";
  const minimumCheckIns = simpleInput(
    "number",
    String(version?.minimumCheckIns ?? 1),
    { required: true },
  );
  minimumCheckIns.min = "0";
  minimumCheckIns.max = "100";
  minimumCheckIns.step = "1";
  const requirements = element("textarea", {
    value: programmeRequirementsText(version?.requirements ?? [
      { code: "training_agreement", label: "Signed training agreement", acceptedStatuses: ["signed", "archived"] },
      { code: "attendance_log", label: "Signed attendance log", acceptedStatuses: ["signed", "archived"] },
      { code: "evaluation", label: "Completed evaluation", acceptedStatuses: ["ready", "signed", "archived"] },
    ]),
    required: true,
  });
  requirements.placeholder = "training_agreement | Signed training agreement | signed, archived";
  return { targetHours, minimumCheckIns, requirements };
}

function openProgrammeCreateForm() {
  const code = simpleInput("text", "", { required: true });
  code.placeholder = "TECH_PLACEMENT";
  const name = simpleInput("text", "", { required: true });
  const description = element("textarea");
  const version = programmeVersionFields();
  const form = formWithSubmit([
    { label: "Programme code", input: code },
    { label: "Programme name", input: name },
    { label: "Default target hours", input: version.targetHours },
    { label: "Minimum check-ins", input: version.minimumCheckIns },
    { label: "Operational description", input: description, full: true },
    { label: "Requirements: code | label | accepted statuses", input: version.requirements, full: true },
  ], "Create programme", async () => {
    await request("/programmes", {
      method: "POST",
      body: {
        code: code.value.trim().toUpperCase(),
        name: name.value.trim(),
        description: description.value.trim(),
        defaultTargetHours: Number(version.targetHours.value),
        minimumCheckIns: Number(version.minimumCheckIns.value),
        requirements: parseProgrammeRequirements(version.requirements.value),
      },
    });
    await refreshCore();
    flash("Programme version 1 published.");
    close();
    renderWorkspace();
  });
  const { close } = openModal(
    "New programme",
    "The first version is published immediately. Later rule changes create a new immutable version.",
    form,
  );
}

function openProgrammeEditForm(programme) {
  const code = simpleInput("text", programme.code, { required: true });
  code.disabled = true;
  const name = simpleInput("text", programme.name, { required: true });
  const description = element("textarea", { value: programme.description });
  const active = element("input", { type: "checkbox", checked: programme.active });
  const form = formWithSubmit([
    { label: "Programme code", input: code },
    { label: "Programme name", input: name },
    { label: "Active for new placements", input: active },
    { label: "Operational description", input: description, full: true },
  ], "Save programme", async () => {
    await request(`/programmes/${programme.id}`, {
      method: "PATCH",
      body: {
        revision: programme.revision,
        name: name.value.trim(),
        description: description.value.trim(),
        active: active.checked,
      },
    });
    await refreshCore();
    flash("Programme details updated.");
    close();
    renderWorkspace();
  });
  const { close } = openModal(
    "Edit programme",
    "Metadata and availability may change. Published rules remain immutable.",
    form,
  );
}

function openProgrammePublishForm(programme) {
  const version = programmeVersionFields(programme.currentVersion);
  const form = formWithSubmit([
    { label: "Default target hours", input: version.targetHours },
    { label: "Minimum check-ins", input: version.minimumCheckIns },
    { label: "Requirements: code | label | accepted statuses", input: version.requirements, full: true },
  ], `Publish version ${programme.currentVersion.version + 1}`, async () => {
    await request(`/programmes/${programme.id}/versions`, {
      method: "POST",
      body: {
        revision: programme.revision,
        defaultTargetHours: Number(version.targetHours.value),
        minimumCheckIns: Number(version.minimumCheckIns.value),
        requirements: parseProgrammeRequirements(version.requirements.value),
      },
    });
    await refreshCore();
    flash(`Programme version ${programme.currentVersion.version + 1} published.`);
    close();
    renderWorkspace();
  });
  const { close } = openModal(
    `Publish ${programme.name}`,
    "New placements may use this version. Existing placements retain their original policy and audit context.",
    form,
  );
}

function logoManager() {
  const file = element("input", { type: "file", accept: "image/png" });
  const upload = element("button", { class: "button-small", type: "button", text: "Upload PNG logo" });
  const remove = element("button", { class: "button-small", type: "button", text: "Remove logo", disabled: !state.branding.hasLogo });
  const reconcileConflict = async (error) => {
    if (![409, 428].includes(error.status)) return false;
    state.branding = await request("/public/branding");
    applyBranding(state.branding);
    refreshBrandingStylesheet();
    renderWorkspace();
    flash("Branding changed in another session. The latest logo settings are now loaded.", "error");
    return true;
  };
  upload.addEventListener("click", async () => {
    const selected = file.files?.[0];
    if (!selected) { flash("Choose a PNG logo first.", "error"); return; }
    if (selected.type !== "image/png" || selected.size > 256 * 1024) {
      flash("The logo must be a PNG no larger than 256 KB.", "error"); return;
    }
    upload.disabled = true;
    try {
      await request("/branding/logo", {
        method: "PUT",
        headers: { "Content-Type": "image/png", "If-Match": `"${state.branding.revision}"` },
        body: selected,
      });
      state.branding = await request("/public/branding");
      applyBranding(state.branding);
      refreshBrandingStylesheet();
      flash("Runtime logo uploaded.");
      renderWorkspace();
    } catch (error) {
      if (!(await reconcileConflict(error))) flash(error.message, "error");
    } finally {
      upload.disabled = false;
    }
  });
  remove.addEventListener("click", async () => {
    if (!window.confirm("Remove the runtime logo? The default VECTOR mark will be used.")) return;
    remove.disabled = true;
    try {
      await request("/branding/logo", {
        method: "DELETE",
        headers: { "If-Match": `"${state.branding.revision}"` },
        body: {},
      });
      state.branding = await request("/public/branding");
      applyBranding(state.branding);
      refreshBrandingStylesheet();
      flash("Runtime logo removed.");
      renderWorkspace();
    } catch (error) {
      if (!(await reconcileConflict(error))) {
        flash(error.message, "error");
        remove.disabled = false;
      }
    }
  });
  return element("div", { class: "notice" }, [
    element("strong", { text: state.branding.hasLogo ? "A runtime PNG logo is active." : "The default VECTOR mark is active." }),
    text(" Upload a PNG logo up to 256 KB. "), file, text(" "), upload, text(" "), remove,
  ]);
}

function retentionManager() {
  return element("section", { class: "workspace-card" }, [
    element("div", { class: "card-title" }, [
      element("div", {}, [
        element("h2", { text: "Retention maintenance" }),
        element("p", { text: "Preview an exact batch before permanently erasing expired inactive records. Students on retention hold are excluded." }),
      ]),
      element("button", { class: "button-small", type: "button", text: "Review retention", onClick: openRetentionForm }),
    ]),
    element("div", { class: "card-body" }, [
      element("p", { class: "notice", text: "Execution requires a fresh preview fingerprint and the exact confirmation phrase. Large sets are processed in bounded batches." }),
    ]),
  ]);
}

function openRetentionForm() {
  const beforeDate = simpleInput("date", "", { required: true });
  const confirmation = simpleInput("text", "");
  confirmation.placeholder = "ERASE EXPIRED RECORDS";
  const results = element("div", { class: "retention-results", attrs: { "aria-live": "polite" } });
  const previewButton = element("button", { class: "button-submit", type: "submit", text: "Preview eligible batch" });
  const executeButton = element("button", { class: "button-cancel danger", type: "button", text: "Execute approved batch", disabled: true });
  const form = element("form", { class: "form-grid" }, [
    field("Erase records before", beforeDate),
    field("Confirmation phrase", confirmation),
    element("div", { class: "form-actions full" }, [executeButton, previewButton]),
    results,
  ]);
  results.classList.add("full");
  let preview = null;

  const showResult = (result, executed) => {
    results.replaceChildren();
    const summary = executed
      ? `${result.deletedPlacements} placements and ${result.deletedStudents} students erased. ${result.held} held records excluded.`
      : `${result.candidates} candidates in this batch. ${result.held} held records excluded.`;
    results.append(element("p", { class: "notice", text: summary }));
    if (result.cleanupPending) {
      results.append(element("p", { class: "notice error", text: "File cleanup is still pending. Check maintenance logs and retry the cleanup job before considering this run complete." }));
    }
    if (result.hasMore) {
      results.append(element("p", { class: "notice", text: "More eligible records remain. Complete this batch, then run a new preview before executing the next one." }));
    }
    if (result.preview?.length) {
      const rows = element("div", { class: "user-list retention-preview" });
      result.preview.forEach((item) => rows.append(element("div", { class: "user-row" }, [
        element("div", {}, [
          element("strong", { text: item.externalRef || item.id }),
          element("small", { text: `${item.placementCount} placements · last end ${item.lastPlacementEnd ? formatDate(item.lastPlacementEnd) : "not recorded"} · updated ${formatDateTime(item.updatedAt)}` }),
        ]),
      ])));
      results.append(rows);
    }
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    previewButton.disabled = true;
    executeButton.disabled = true;
    try {
      preview = await request("/maintenance/retention", {
        method: "POST",
        body: { beforeDate: beforeDate.value, dryRun: true, confirm: "" },
      });
      confirmation.value = "";
      executeButton.disabled = preview.candidates === 0;
      showResult(preview, false);
    } catch (error) {
      preview = null;
      flash(error.message, "error");
    } finally {
      previewButton.disabled = false;
    }
  });

  executeButton.addEventListener("click", async () => {
    if (!preview?.fingerprint) return;
    if (confirmation.value !== "ERASE EXPIRED RECORDS") {
      flash("Type ERASE EXPIRED RECORDS exactly before execution.", "error");
      confirmation.focus();
      return;
    }
    executeButton.disabled = true;
    previewButton.disabled = true;
    try {
      const executed = await request("/maintenance/retention", {
        method: "POST",
        body: { beforeDate: beforeDate.value, dryRun: false, confirm: "ERASE EXPIRED RECORDS", fingerprint: preview.fingerprint },
      });
      preview = null;
      confirmation.value = "";
      showResult(executed, true);
      await refreshCore();
      flash("Retention batch completed.");
    } catch (error) {
      preview = null;
      results.replaceChildren(element("p", { class: "notice error", text: "The approved batch is no longer current. Run a new preview before trying again." }));
      flash(error.message, "error");
    } finally {
      previewButton.disabled = false;
    }
  });

  const { close } = openModal("Retention maintenance", "Preview the exact eligible batch, review every candidate, then execute only with an unchanged fingerprint.", form);
  void close;
}

function userRoleInputs(user = null) {
  const role = selectInput([["school_admin", "School administrator"], ["coordinator", "Coordinator"], ["tutor", "Tutor"], ["viewer", "Viewer"]], user?.role ?? "viewer", "Select role");
  const scope = selectInput([["school", "School-wide"], ["assigned", "Assigned placements"]], user?.dataScope ?? "school", "Select scope");
  const synchroniseScope = () => {
    const tutor = role.value === "tutor";
    scope.value = tutor ? "assigned" : "school";
    scope.disabled = !tutor;
  };
  role.addEventListener("change", synchroniseScope);
  synchroniseScope();
  return { role, scope };
}

function openUserCreateForm() {
  const email = simpleInput("email", "", { required: true });
  const displayName = simpleInput("text", "", { required: true });
  const password = simpleInput("password", "", { required: true }); password.minLength = 14;
  const { role, scope } = userRoleInputs();
  const form = formWithSubmit([
    { label: "Email", input: email }, { label: "Display name", input: displayName }, { label: "Role", input: role }, { label: "Data scope", input: scope }, { label: "Temporary password", input: password, full: true },
  ], "Create user", async () => {
    await request("/users", { method: "POST", body: { email: email.value.trim(), displayName: displayName.value.trim(), password: password.value, role: role.value, dataScope: scope.value } });
    await refreshCore(); flash("User created. Share the temporary password through an approved channel."); close(); renderWorkspace();
  });
  const { close } = openModal("New user", "Create an account with the minimum role and scope required. Passwords are never displayed after this step.", form);
}

function openUserEditForm(user) {
  const displayName = simpleInput("text", user.displayName, { required: true });
  const { role, scope } = userRoleInputs(user);
  const active = element("input", { type: "checkbox", checked: user.active });
  const form = formWithSubmit([
    { label: "Display name", input: displayName }, { label: "Role", input: role }, { label: "Data scope", input: scope }, { label: "Active account", input: active },
  ], "Save user", async () => {
    try {
      const result = await request(`/users/${user.id}`, {
        method: "PATCH",
        body: { revision: user.revision, displayName: displayName.value.trim(), role: role.value, dataScope: scope.value, active: active.checked },
      });
      user.revision = result.revision;
      await refreshCore();
      flash("User updated.");
      close();
      renderWorkspace();
    } catch (error) {
      if (error.status === 409) {
        await refreshCore();
        close();
        renderWorkspace();
        error.message = "This account changed in another session. The user list has been refreshed; review it before trying again.";
      }
      throw error;
    }
  });
  const { close } = openModal("Edit user", `${user.email} cannot be changed here. Deactivation ends access without deleting the audit trail.`, form);
}

function openPasswordResetForm(user) {
  const password = simpleInput("password", "", { required: true });
  password.minLength = 14;
  const form = formWithSubmit([{ label: "New temporary password", input: password, full: true }], "Reset password", async () => {
    try {
      const result = await request(`/users/${user.id}/reset-password`, {
        method: "POST",
        body: { revision: user.revision, password: password.value },
      });
      user.revision = result.revision;
      await refreshCore();
      flash("Password reset. The user must replace this temporary password at the next sign-in.");
      close();
      renderWorkspace();
    } catch (error) {
      if (error.status === 409) {
        await refreshCore();
        close();
        renderWorkspace();
        error.message = "This account changed in another session. The user list has been refreshed; review it before resetting the password.";
      }
      throw error;
    }
  });
  const { close } = openModal("Reset password", `Set a temporary password for ${user.displayName}. Send it through an approved channel; it will not be shown again.`, form);
}

function openChangePasswordForm() {
  const currentPassword = simpleInput("password", "", { required: true });
  const newPassword = simpleInput("password", "", { required: true });
  const confirmPassword = simpleInput("password", "", { required: true });
  newPassword.minLength = 14;
  confirmPassword.minLength = 14;
  const form = formWithSubmit([
    { label: "Current password", input: currentPassword, full: true },
    { label: "New password", input: newPassword, full: true },
    { label: "Confirm new password", input: confirmPassword, full: true },
  ], "Change password", async () => {
    if (newPassword.value !== confirmPassword.value) {
      throw new Error("The new password confirmation does not match.");
    }
    await request("/auth/change-password", {
      method: "POST",
      body: { currentPassword: currentPassword.value, newPassword: newPassword.value },
    });
    resetCoverageSessionState();
    state.session = null;
    close();
    loginScreen();
    flash("Password changed. Sign in with the new password.");
  });
  const { close } = openModal("Change password", "Changing your password ends every active session for this account.", form);
}

function brandingForm() {
  const branding = state.branding;
  const form = element("form", { class: "form-grid" });
  const inputs = {
    schoolName: simpleInput("text", branding.schoolName, { required: true }),
    shortName: simpleInput("text", branding.shortName, { required: true }),
    productName: simpleInput("text", branding.productName, { required: true }),
    timeZone: simpleInput("text", branding.timeZone, { required: true }),
    primaryColor: simpleInput("text", branding.primaryColor, { required: true }),
    accentColor: simpleInput("text", branding.accentColor, { required: true }),
    surfaceColor: simpleInput("text", branding.surfaceColor, { required: true }),
    supportEmail: simpleInput("email", branding.supportEmail),
    contactText: simpleInput("text", branding.contactText, { required: true }),
    footerText: simpleInput("text", branding.footerText, { required: true }),
  };
  inputs.timeZone.placeholder = "Europe/Zurich";
  [
    ["School name", "schoolName"], ["Short name", "shortName"], ["Product name", "productName"],
    ["IANA time zone", "timeZone"], ["Primary colour", "primaryColor"], ["Accent colour", "accentColor"],
    ["Surface colour", "surfaceColor"], ["Support email", "supportEmail"],
    ["Contact text", "contactText", true], ["Footer text", "footerText", true],
  ].forEach(([label, name, full]) => {
    const item = field(label, inputs[name]);
    if (full) item.classList.add("full");
    form.append(item);
  });
  form.append(element("div", { class: "form-actions full" }, [element("button", { class: "button-submit", type: "submit", text: "Save branding" })]));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      state.branding = await request("/branding", {
        method: "PATCH",
        body: {
          revision: branding.revision,
          ...Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value.trim()])),
        },
      });
      applyBranding(state.branding);
      refreshBrandingStylesheet();
      flash("Branding saved.");
      renderWorkspace();
    } catch (error) {
      if (error.status === 409) {
        state.branding = await request("/public/branding");
        applyBranding(state.branding);
        refreshBrandingStylesheet();
        renderWorkspace();
        flash("Branding changed in another session. The latest values are now loaded.", "error");
      } else {
        flash(error.message, "error");
        button.disabled = false;
      }
    }
  });
  return form;
}

function field(label, input) {
  const labelTarget = input.labelTarget ?? input;
  const id = labelTarget.id || `field-${crypto.randomUUID()}`;
  labelTarget.id = id;
  return element("div", { class: "field" }, [element("label", { htmlFor: id, text: label }), input]);
}

function simpleInput(type, value = "", { required = false } = {}) {
  return element("input", { type, value, required });
}

function openModal(title, description, form) {
  const titleId = `modal-title-${crypto.randomUUID()}`;
  const descriptionId = `modal-description-${crypto.randomUUID()}`;
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const modal = element("div", {
    class: "modal",
    attrs: { role: "dialog", "aria-modal": "true", "aria-labelledby": titleId, "aria-describedby": descriptionId },
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    modal.removeEventListener("keydown", handleKeydown);
    modal.remove();
    app.inert = false;
    document.body.classList.remove("modal-open");
    opener?.focus();
  };
  const closeButton = element("button", {
    class: "modal-close",
    type: "button",
    text: "×",
    attrs: { "aria-label": "Close dialog" },
    onClick: close,
  });
  const card = element("section", { class: "modal-card" }, [
    element("header", { class: "modal-header" }, [
      element("div", {}, [
        element("h2", { id: titleId, text: title }),
        element("p", { id: descriptionId, text: description }),
      ]),
      closeButton,
    ]),
    form,
  ]);
  modal.append(card);
  function focusableElements() {
    return [...modal.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')]
      .filter((node) => !node.hidden && node.getAttribute("aria-hidden") !== "true");
  }
  function handleKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = focusableElements();
    if (!focusable.length) { event.preventDefault(); card.focus(); return; }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  modal.addEventListener("keydown", handleKeydown);
  modal.addEventListener("click", (event) => { if (event.target === modal) close(); });
  app.inert = true;
  document.body.classList.add("modal-open");
  document.body.append(modal);
  (form.querySelector("input, select, textarea, button:not([disabled])") ?? closeButton).focus();
  return { close, modal };
}

function formWithSubmit(fields, submitLabel, onSubmit) {
  const form = element("form", { class: "form-grid" });
  fields.forEach(({ label, input, full = false }) => { const item = field(label, input); if (full) item.classList.add("full"); form.append(item); });
  form.append(element("div", { class: "form-actions full" }, [element("button", { class: "button-submit", type: "submit", text: submitLabel })]));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button[type=submit]"); button.disabled = true;
    try { await onSubmit(); } catch (error) { flash(error.message, "error"); button.disabled = false; }
  });
  return form;
}

function selectInput(items, selected = "", emptyLabel = "Not assigned") {
  const select = element("select");
  select.append(element("option", { value: "", text: emptyLabel }));
  items.forEach(([value, label]) => select.append(element("option", { value, text: label, selected: value === selected })));
  return select;
}

function lookupControl(resource, { initial = null, required = false, placeholder = "Search" } = {}) {
  const search = simpleInput("search", "", { placeholder });
  search.autocomplete = "off";
  const select = element("select", { required, attrs: { "aria-label": `${placeholder} results` } });
  const hint = element("small", { class: "lookup-hint", text: "Type to refine the active records shown below." });
  const control = element("div", { class: "lookup-control" }, [search, select, hint]);
  control.labelTarget = search;
  Object.defineProperty(control, "value", { get: () => select.value });
  let sequence = 0;
  let timer = null;

  const populate = (items, nextCursor) => {
    const selectedValue = select.value || initial?.id || "";
    const selectedLabel = select.selectedOptions[0]?.textContent || initial?.label || "Current selection";
    const options = [...items];
    if (selectedValue && !options.some((item) => item.id === selectedValue)) {
      options.unshift({ id: selectedValue, label: selectedLabel, secondary: initial?.secondary ?? "" });
    }
    select.replaceChildren(element("option", { value: "", text: required ? "Select a record" : "Not assigned" }));
    options.forEach((item) => select.append(element("option", {
      value: item.id,
      text: item.secondary ? `${item.label} · ${item.secondary}` : item.label,
      selected: item.id === selectedValue,
    })));
    if (selectedValue) select.value = selectedValue;
    hint.textContent = nextCursor
      ? "More matches exist. Refine the search to narrow the list."
      : `${items.length} active match${items.length === 1 ? "" : "es"}.`;
  };

  const load = async () => {
    const current = ++sequence;
    search.setAttribute("aria-busy", "true");
    try {
      const result = await request(`/lookups/${resource}?${pageQueryParams({ limit: 20, query: search.value.trim() })}`);
      if (current === sequence) populate(result.items, result.nextCursor);
    } catch (error) {
      if (current === sequence) {
        hint.textContent = error.message;
        hint.classList.add("error");
      }
    } finally {
      if (current === sequence) search.removeAttribute("aria-busy");
    }
  };
  populate(initial ? [initial] : [], null);
  search.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(load, 220);
  });
  window.setTimeout(load, 0);
  return control;
}

function openStudentForm() {
  const cohort = lookupControl("cohorts", { placeholder: "Search cohort" });
  const firstName = simpleInput("text", "", { required: true });
  const lastName = simpleInput("text", "", { required: true });
  const externalRef = simpleInput("text");
  const email = simpleInput("email");
  const form = formWithSubmit([
    { label: "First name", input: firstName },
    { label: "Last name", input: lastName },
    { label: "External reference", input: externalRef },
    { label: "Email", input: email },
    { label: "Cohort", input: cohort, full: true },
  ], "Create student", async () => {
    await request("/students", {
      method: "POST",
      body: { firstName: firstName.value.trim(), lastName: lastName.value.trim(), externalRef: externalRef.value.trim(), email: email.value.trim(), cohortId: cohort.value || null },
    });
    await refreshCore();
    flash("Student created.");
    close();
  });
  const { close } = openModal("New student", "Create a school-scoped student record and search active cohorts when assigning it.", form);
}

function openHostForm() {
  const name = simpleInput("text", "", { required: true }), sector = simpleInput("text"), contactName = simpleInput("text"), contactEmail = simpleInput("email"), contactPhone = simpleInput("text"), address = element("textarea");
  const form = formWithSubmit([
    { label: "Organisation name", input: name }, { label: "Sector", input: sector }, { label: "Contact name", input: contactName }, { label: "Contact email", input: contactEmail }, { label: "Contact phone", input: contactPhone }, { label: "Address", input: address, full: true },
  ], "Create host", async () => {
    await request("/hosts", { method: "POST", body: { name: name.value.trim(), sector: sector.value.trim(), contactName: contactName.value.trim(), contactEmail: contactEmail.value.trim(), contactPhone: contactPhone.value.trim(), address: address.value.trim() } });
    await refreshCore(); flash("Host created."); close();
  });
  const { close } = openModal("New host", "Create a school-scoped host organisation.", form);
}

function openStudentEditForm(student) {
  const cohort = lookupControl("cohorts", {
    placeholder: "Search cohort",
    initial: student.cohortId ? { id: student.cohortId, label: student.cohortName || "Current cohort", secondary: "Current assignment" } : null,
  });
  const firstName = simpleInput("text", student.firstName, { required: true });
  const lastName = simpleInput("text", student.lastName, { required: true });
  const externalRef = simpleInput("text", student.externalRef ?? "");
  const email = simpleInput("email", student.email ?? "");
  const active = element("input", { type: "checkbox", checked: student.active });
  const fields = [
    { label: "First name", input: firstName },
    { label: "Last name", input: lastName },
    { label: "External reference", input: externalRef },
    { label: "Email", input: email },
    { label: "Cohort", input: cohort },
    { label: "Active record", input: active },
  ];
  let retentionHold = null;
  if (isSchoolAdmin()) {
    retentionHold = element("input", { type: "checkbox", checked: student.retentionHold });
    fields.push({ label: "Legal/retention hold — exclude from automated retention", input: retentionHold, full: true });
  }
  const form = formWithSubmit(fields, "Save student", async () => {
    await request(`/students/${student.id}`, {
      method: "PATCH",
      body: {
        revision: student.revision,
        cohortId: cohort.value || null,
        firstName: firstName.value.trim(),
        lastName: lastName.value.trim(),
        externalRef: externalRef.value.trim(),
        email: email.value.trim(),
        active: active.checked,
        ...(retentionHold ? { retentionHold: retentionHold.checked } : {}),
      },
    });
    await refreshCore();
    flash("Student updated.");
    close();
    renderWorkspace();
  });
  const { close } = openModal("Edit student", "Changes use the latest revision. Search active cohorts without loading the full register; retention holds preserve eligible inactive records.", form);
}

function openHostEditForm(host) {
  const name = simpleInput("text", host.name, { required: true });
  const sector = simpleInput("text", host.sector ?? "");
  const contactName = simpleInput("text", host.contactName ?? "");
  const contactEmail = simpleInput("email", host.contactEmail ?? "");
  const contactPhone = simpleInput("text", host.contactPhone ?? "");
  const address = element("textarea", { value: host.address ?? "" });
  const active = element("input", { type: "checkbox", checked: host.active });
  const form = formWithSubmit([
    { label: "Organisation name", input: name }, { label: "Sector", input: sector }, { label: "Contact name", input: contactName }, { label: "Contact email", input: contactEmail }, { label: "Contact phone", input: contactPhone }, { label: "Active record", input: active }, { label: "Address", input: address, full: true },
  ], "Save host", async () => {
    await request(`/hosts/${host.id}`, { method: "PATCH", body: { revision: host.revision, name: name.value.trim(), sector: sector.value.trim(), contactName: contactName.value.trim(), contactEmail: contactEmail.value.trim(), contactPhone: contactPhone.value.trim(), address: address.value.trim(), active: active.checked } });
    await refreshCore(); flash("Host updated."); close(); renderWorkspace();
  });
  const { close } = openModal("Edit host", "Changes are checked against the latest record revision. Refresh if somebody else saved first.", form);
}

function openPlacementForm(defaults = {}, options = {}) {
  const student = lookupControl("students", {
    required: true,
    placeholder: "Search student",
    initial: defaults.student ?? null,
  });
  const host = lookupControl("hosts", { required: true, placeholder: "Search host" });
  const period = lookupControl("periods", {
    placeholder: "Search placement period",
    initial: defaults.period ?? null,
  });
  const tutor = lookupControl("tutors", { placeholder: "Search school tutor" });
  const activeProgrammes = state.programmes.filter((item) => item.active);
  const initialProgramme = activeProgrammes[0] ?? null;
  const programme = selectInput(
    activeProgrammes.map((item) => [
      item.currentVersion.id,
      `${item.name} · ${item.code} · v${item.currentVersion.version}`,
    ]),
    initialProgramme?.currentVersion.id ?? "",
    "Select programme",
  );
  programme.required = true;
  const startDate = simpleInput("date", defaults.startDate ?? "", { required: true });
  const endDate = simpleInput("date", defaults.endDate ?? "", { required: true });
  const targetHours = simpleInput(
    "number",
    initialProgramme ? String(initialProgramme.currentVersion.defaultTargetHours) : "",
    { required: true },
  );
  targetHours.min = "1";
  targetHours.max = "2000";
  targetHours.step = "0.5";
  const hostTutorName = simpleInput("text");
  const hostTutorEmail = simpleInput("email");
  const notes = element("textarea");
  programme.addEventListener("change", () => {
    const selected = activeProgrammes.find(
      (item) => item.currentVersion.id === programme.value,
    );
    if (selected) targetHours.value = String(selected.currentVersion.defaultTargetHours);
  });
  const form = formWithSubmit([
    { label: "Student", input: student },
    { label: "Host", input: host },
    { label: "Programme policy", input: programme, full: true },
    { label: "Period", input: period },
    { label: "School tutor", input: tutor },
    { label: "Start date", input: startDate },
    { label: "End date", input: endDate },
    { label: "Target hours", input: targetHours },
    { label: "Host tutor", input: hostTutorName },
    { label: "Host tutor email", input: hostTutorEmail },
    { label: "Operational notes", input: notes, full: true },
  ], "Create placement", async () => {
    const created = await request("/placements", {
      method: "POST",
      body: {
        studentId: student.value,
        hostId: host.value,
        periodId: period.value || null,
        schoolTutorId: tutor.value || null,
        programmeVersionId: programme.value,
        startDate: startDate.value,
        endDate: endDate.value,
        targetHours: Number(targetHours.value),
        hostTutorName: hostTutorName.value.trim(),
        hostTutorEmail: hostTutorEmail.value.trim(),
        notes: notes.value.trim(),
      },
    });
    let refreshError = null;
    try {
      await refreshCore();
    } catch (error) {
      refreshError = error;
    }
    let callbackError = null;
    if (typeof options.onCreated === "function") {
      try {
        await options.onCreated(created);
      } catch (error) {
        callbackError = error;
      }
    }
    state.selectedPlacement = null;
    state.view = options.returnView ?? "placements";
    if (refreshError && state.view === "coverage") {
      resetCoverageState(
        "The placement was created, but Coverage could not be refreshed. Retry the coverage refresh; do not create the placement again.",
      );
    }
    close();
    flash("Placement created.");
    if (state.session?.authenticated) {
      renderWorkspace();
      document.querySelector(".view-header h1")?.focus();
    }
    if (refreshError) {
      flash(
        state.view === "coverage"
          ? "Placement created, but Coverage needs a refresh. Use Retry coverage refresh."
          : "Placement created, but current workspace data could not refresh. Reload before continuing.",
        "error",
      );
    } else if (callbackError) {
      flash("Placement created, but the follow-up action could not complete.", "error");
    }
  });
  const { close } = openModal(
    "New placement",
    "Assign the programme policy first. Its published version determines default hours, check-ins and required evidence for this placement.",
    form,
  );
}

function openPlacementEditForm(placement) {
  const student = lookupControl("students", {
    required: true,
    placeholder: "Search student",
    initial: { id: placement.studentId, label: placement.studentName, secondary: placement.cohortName },
  });
  const host = lookupControl("hosts", {
    required: true,
    placeholder: "Search host",
    initial: { id: placement.hostId, label: placement.hostName, secondary: "Current host" },
  });
  const currentPeriod = state.reference.periods.find((item) => item.id === placement.periodId);
  const period = lookupControl("periods", {
    placeholder: "Search placement period",
    initial: placement.periodId ? { id: placement.periodId, label: currentPeriod?.name ?? "Current period", secondary: currentPeriod ? `${currentPeriod.startDate} – ${currentPeriod.endDate}` : "" } : null,
  });
  const tutor = lookupControl("tutors", {
    placeholder: "Search school tutor",
    initial: placement.schoolTutorId ? { id: placement.schoolTutorId, label: placement.schoolTutorName, secondary: "Current tutor" } : null,
  });
  const availableProgrammes = state.programmes.filter((item) => (
    item.active || item.currentVersion.id === placement.programmeVersionId
  ));
  const programmeOptions = availableProgrammes.map((item) => [
    item.currentVersion.id,
    `${item.name} · ${item.code} · v${item.currentVersion.version}`,
  ]);
  if (!programmeOptions.some(([id]) => id === placement.programmeVersionId)) {
    programmeOptions.unshift([
      placement.programmeVersionId,
      `${placement.programmeName} · ${placement.programmeCode} · v${placement.programmeVersion} · current placement`,
    ]);
  }
  const programme = selectInput(
    programmeOptions,
    placement.programmeVersionId,
    "Select programme",
  );
  programme.required = true;
  const startDate = simpleInput("date", placement.startDate, { required: true });
  const endDate = simpleInput("date", placement.endDate, { required: true });
  const targetHours = simpleInput("number", String(placement.targetHours), { required: true });
  targetHours.min = "1";
  targetHours.max = "2000";
  targetHours.step = "0.5";
  const hostTutorName = simpleInput("text", placement.hostTutorName ?? "");
  const hostTutorEmail = simpleInput("email", placement.hostTutorEmail ?? "");
  const notes = element("textarea", { value: placement.notes ?? "" });
  const fields = [
    { label: "Student", input: student },
    { label: "Host", input: host },
    { label: "Programme policy", input: programme, full: true },
    { label: "Period", input: period },
    { label: "School tutor", input: tutor },
    { label: "Start date", input: startDate },
    { label: "End date", input: endDate },
    { label: "Target hours", input: targetHours },
    { label: "Host tutor", input: hostTutorName },
    { label: "Host tutor email", input: hostTutorEmail },
    { label: "Operational notes", input: notes, full: true },
  ];
  const form = formWithSubmit(fields, "Save placement", async () => {
    const changes = {};
    if (student.value !== placement.studentId) changes.studentId = student.value;
    if (host.value !== placement.hostId) changes.hostId = host.value;
    if ((period.value || null) !== (placement.periodId ?? null)) changes.periodId = period.value || null;
    if ((tutor.value || null) !== (placement.schoolTutorId ?? null)) changes.schoolTutorId = tutor.value || null;
    if (programme.value !== placement.programmeVersionId) changes.programmeVersionId = programme.value;
    if (startDate.value !== placement.startDate) changes.startDate = startDate.value;
    if (endDate.value !== placement.endDate) changes.endDate = endDate.value;
    if (Number(targetHours.value) !== Number(placement.targetHours)) changes.targetHours = Number(targetHours.value);
    if (hostTutorName.value.trim() !== (placement.hostTutorName ?? "")) changes.hostTutorName = hostTutorName.value.trim();
    if (hostTutorEmail.value.trim() !== (placement.hostTutorEmail ?? "")) changes.hostTutorEmail = hostTutorEmail.value.trim();
    if (notes.value.trim() !== (placement.notes ?? "")) changes.notes = notes.value.trim();
    if (!Object.keys(changes).length) {
      flash("No placement changes to save.");
      close();
      return;
    }
    try {
      await request(`/placements/${placement.id}`, {
        method: "PATCH",
        body: { revision: placement.revision, ...changes },
      });
      await refreshCore();
      await openPlacement(placement.id);
      flash("Placement updated.");
      close();
    } catch (error) {
      if (error.status === 409) {
        await refreshCore();
        await openPlacement(placement.id);
        close();
        error.message = "This placement changed in another session. Its latest version is now open; review it before trying again.";
      }
      throw error;
    }
  });
  const { close } = openModal(
    "Edit placement",
    "Changing programme policy is allowed only before time, check-ins or evidence have been recorded. Published versions remain available for historical records.",
    form,
  );
}

function openCohortForm(returnToManager = false) {
  const name = simpleInput("text", "", { required: true });
  const academicYear = simpleInput("text", "", { required: true });
  const track = simpleInput("text");
  const tutor = lookupControl("tutors", { placeholder: "Search tutor" });
  const form = formWithSubmit([
    { label: "Cohort name", input: name },
    { label: "Academic year", input: academicYear },
    { label: "Track", input: track },
    { label: "Tutor", input: tutor },
  ], "Create cohort", async () => {
    await request("/cohorts", { method: "POST", body: { name: name.value.trim(), academicYear: academicYear.value.trim(), track: track.value.trim(), tutorUserId: tutor.value || null } });
    await refreshCore();
    flash("Cohort created.");
    close();
    if (returnToManager) openReferenceDataManager();
  });
  const { close } = openModal("New cohort", "Create a cohort and search the active tutor directory for its assignment.", form);
}

function openPeriodForm(returnToManager = false) {
  const name = simpleInput("text", "", { required: true });
  const startDate = simpleInput("date", "", { required: true });
  const endDate = simpleInput("date", "", { required: true });
  const form = formWithSubmit([
    { label: "Period name", input: name },
    { label: "Start date", input: startDate },
    { label: "End date", input: endDate },
  ], "Create period", async () => {
    await request("/periods", { method: "POST", body: { name: name.value.trim(), startDate: startDate.value, endDate: endDate.value } });
    await refreshCore();
    flash("Period created.");
    close();
    if (returnToManager) openReferenceDataManager();
  });
  const { close } = openModal("New period", "Create a placement period with a bounded date range.", form);
}

function openReferenceDataManager() {
  const content = element("div", { class: "reference-manager" });
  let close = () => {};

  const buildSection = (resource, title, description, createAction, renderItem) => {
    const section = element("section", { class: "reference-section" });
    const headingActions = [];
    if (createAction) {
      headingActions.push(element("button", { class: "button-small", type: "button", text: createAction[0], onClick: () => { close(); createAction[1](true); } }));
    }
    section.append(element("div", { class: "card-title" }, [
      element("div", {}, [element("h3", { text: title }), element("p", { text: description })]),
      ...headingActions,
    ]));

    const search = simpleInput("search", state.referenceQuery[resource], { placeholder: `Search ${title.toLowerCase()}` });
    const searchForm = element("form", { class: "reference-search" }, [
      field(`Search ${title.toLowerCase()}`, search),
      element("button", { class: "row-button", type: "submit", text: "Search" }),
    ]);
    if (state.referenceQuery[resource]) {
      const reset = element("button", { class: "row-button", type: "button", text: "Reset" });
      reset.addEventListener("click", async () => {
        state.referenceQuery[resource] = "";
        await loadReferenceResource(resource);
        close();
        openReferenceDataManager();
      });
      searchForm.append(reset);
    }
    searchForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      state.referenceQuery[resource] = search.value.trim();
      await loadReferenceResource(resource);
      close();
      openReferenceDataManager();
    });
    section.append(searchForm);

    const rows = element("div", { class: "user-list" });
    state.reference[resource].forEach((item) => rows.append(renderItem(item)));
    section.append(state.reference[resource].length ? rows : emptyPanel(`No ${title.toLowerCase()} match this search.`, "Adjust the search or create a new record."));
    if (state.referenceNextCursor[resource]) {
      const loadMore = element("button", { class: "row-button", type: "button", text: `Load more ${title.toLowerCase()}` });
      loadMore.addEventListener("click", async () => {
        loadMore.disabled = true;
        await loadReferenceResource(resource, { append: true });
        close();
        openReferenceDataManager();
      });
      section.append(element("div", { class: "load-more-row" }, [loadMore]));
    }
    return section;
  };

  const cohortSection = buildSection("cohorts", "Cohorts", "Keep past cohorts available while deactivating them for new assignments.", ["New cohort", openCohortForm], (cohort) => {
    const tutorName = state.reference.tutors.find((item) => item.id === cohort.tutorUserId)?.displayName ?? "Unassigned";
    return element("div", { class: "user-row" }, [
      element("div", {}, [
        element("strong", { text: cohort.name }),
        element("small", { text: `${cohort.academicYear}${cohort.track ? ` · ${cohort.track}` : ""} · ${tutorName} · ${cohort.active ? "Active" : "Inactive"}` }),
      ]),
      element("button", { class: "row-button", type: "button", text: "Edit", onClick: () => { close(); openCohortEditForm(cohort); } }),
    ]);
  });
  const periodSection = buildSection("periods", "Placement periods", "Bound new placements to a school-defined date range.", ["New period", openPeriodForm], (period) => element("div", { class: "user-row" }, [
    element("div", {}, [
      element("strong", { text: period.name }),
      element("small", { text: `${formatDate(period.startDate)} – ${formatDate(period.endDate)} · ${period.active ? "Active" : "Inactive"}` }),
    ]),
    element("button", { class: "row-button", type: "button", text: "Edit", onClick: () => { close(); openPeriodEditForm(period); } }),
  ]));
  const tutorSection = buildSection("tutors", "Tutors", "Read-only assignment directory. Manage tutor accounts in School settings.", null, (tutor) => element("div", { class: "user-row" }, [
    element("div", {}, [
      element("strong", { text: tutor.displayName }),
      element("small", { text: tutor.active ? "Active tutor account" : "Inactive tutor account" }),
    ]),
  ]));
  content.append(cohortSection, periodSection, tutorSection);
  ({ close } = openModal("Cohorts, periods & tutors", "Search and page through bounded reference lists without removing their history.", content));
}

function openCohortEditForm(cohort) {
  const name = simpleInput("text", cohort.name, { required: true });
  const academicYear = simpleInput("text", cohort.academicYear, { required: true });
  const track = simpleInput("text", cohort.track ?? "");
  const currentTutor = state.reference.tutors.find((item) => item.id === cohort.tutorUserId);
  const tutor = lookupControl("tutors", {
    placeholder: "Search tutor",
    initial: cohort.tutorUserId ? { id: cohort.tutorUserId, label: currentTutor?.displayName ?? "Current tutor", secondary: "Current assignment" } : null,
  });
  const active = element("input", { type: "checkbox", checked: cohort.active });
  const form = formWithSubmit([
    { label: "Cohort name", input: name },
    { label: "Academic year", input: academicYear },
    { label: "Track", input: track },
    { label: "Tutor", input: tutor },
    { label: "Available for new assignments", input: active, full: true },
  ], "Save cohort", async () => {
    try {
      await request(`/cohorts/${cohort.id}`, {
        method: "PATCH",
        body: { revision: cohort.revision, name: name.value.trim(), academicYear: academicYear.value.trim(), track: track.value.trim(), tutorUserId: tutor.value || null, active: active.checked },
      });
      await refreshCore();
      flash("Cohort updated.");
      close();
      openReferenceDataManager();
    } catch (error) {
      if (error.status === 409) {
        await refreshCore();
        close();
        openReferenceDataManager();
        error.message = "This cohort changed in another session. Reference data has been refreshed.";
      }
      throw error;
    }
  });
  const { close } = openModal("Edit cohort", "Deactivate a cohort to remove it from new assignments while preserving existing records.", form);
}

function openPeriodEditForm(period) {
  const name = simpleInput("text", period.name, { required: true });
  const startDate = simpleInput("date", period.startDate, { required: true });
  const endDate = simpleInput("date", period.endDate, { required: true });
  const active = element("input", { type: "checkbox", checked: period.active });
  const form = formWithSubmit([
    { label: "Period name", input: name },
    { label: "Start date", input: startDate },
    { label: "End date", input: endDate },
    { label: "Available for new placements", input: active, full: true },
  ], "Save period", async () => {
    try {
      await request(`/periods/${period.id}`, {
        method: "PATCH",
        body: { revision: period.revision, name: name.value.trim(), startDate: startDate.value, endDate: endDate.value, active: active.checked },
      });
      await refreshCore();
      flash("Period updated.");
      close();
      openReferenceDataManager();
    } catch (error) {
      if (error.status === 409) {
        await refreshCore();
        close();
        openReferenceDataManager();
        error.message = "This period changed in another session. Reference data has been refreshed.";
      }
      throw error;
    }
  });
  const { close } = openModal("Edit placement period", "Deactivate a period to keep it out of new placements without deleting history.", form);
}

async function downloadImportTemplate(resource) {
  try {
    const response = await fetch(`${API}/import/${encodeURIComponent(resource)}/template`, {
      headers: { Accept: "text/csv" },
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error?.message || "The CSV template could not be downloaded.");
    }
    const filename = response.headers.get("content-disposition")?.match(/filename="?([^";]+)"?/i)?.[1] || `vector-${resource}-import-template.csv`;
    const url = URL.createObjectURL(await response.blob());
    const link = element("a", { href: url, download: filename });
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    flash(`${titleCase(resource)} CSV template downloaded.`);
  } catch (error) {
    flash(error.message, "error");
  }
}

function openImportForm() {
  const resource = selectInput([["students", "Students"], ["hosts", "Hosts"], ["placements", "Placements"]], "students", "Select CSV type");
  const file = element("input", { type: "file", accept: ".csv,text/csv", required: true });
  const result = element("p", { class: "notice", hidden: true, attrs: { role: "status" } });
  const form = element("form", { class: "form-grid" }, [
    field("Record type", resource), field("CSV file", file), result,
  ]);
  result.classList.add("full");
  const template = element("button", { class: "button-cancel", type: "button", text: "Download template" });
  const dryRun = element("button", { class: "button-submit", type: "submit", text: "Check CSV" });
  const commit = element("button", { class: "button-cancel", type: "button", text: "Import checked CSV", disabled: true });
  template.addEventListener("click", async () => {
    template.disabled = true;
    await downloadImportTemplate(resource.value);
    template.disabled = false;
  });
  form.append(element("div", { class: "form-actions full" }, [template, commit, dryRun]));
  let checked = null;
  const run = async (commitImport) => {
    const chosen = file.files?.[0];
    if (!chosen) { flash("Choose a CSV file first.", "error"); return; }
    const csv = await chosen.text();
    const response = await request(`/import/${resource.value}?dryRun=${commitImport ? "false" : "true"}`, {
      method: "POST",
      headers: { "Content-Type": "text/csv" },
      body: csv,
    });
    checked = response;
    result.hidden = false;
    result.classList.toggle("error", response.rejected > 0);
    const errors = response.errors.slice(0, 3).map((item) => `row ${item.row}, ${item.field}: ${item.code}`).join("; ");
    result.textContent = response.rejected
      ? `${response.accepted} valid, ${response.rejected} rejected. ${errors}`
      : `${response.accepted} rows are valid${commitImport ? " and were imported" : ". Review and import when ready."}`;
    commit.disabled = commitImport || response.accepted === 0 || response.rejected > 0;
    if (commitImport) { await refreshCore(); flash(`${response.accepted} ${resource.value} imported.`); close(); }
  };
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    dryRun.disabled = true;
    try { await run(false); } catch (error) { showImportFailure(error); } finally { dryRun.disabled = false; }
  });
  const resetCheck = () => { checked = null; commit.disabled = true; result.hidden = true; };
  resource.addEventListener("change", resetCheck);
  file.addEventListener("change", resetCheck);
  commit.addEventListener("click", async () => {
    if (!checked || checked.rejected > 0) return;
    commit.disabled = true;
    try { await run(true); } catch (error) { showImportFailure(error); }
  });
  const { close } = openModal("Import CSV", "VECTOR checks the complete file first. It imports only after a clean dry run; no partial rows are written.", form);

  function showImportFailure(error) {
    checked = null;
    commit.disabled = true;
    result.hidden = false;
    result.classList.add("error");
    const rows = error.details?.errors;
    const details = Array.isArray(rows) && rows.length
      ? rows.slice(0, 6).map((item) => `row ${item.row}, ${item.field}: ${item.code}`).join("; ")
      : error.message;
    result.textContent = `CSV check failed. ${details}`;
    flash(error.message, "error");
  }
}

function openStatusForm(placement) {
  const allowed = placementTransitions(placement.status);
  if (!allowed.length || (placement.status === "complete" && !isSchoolAdmin())) {
    flash("This placement has no available status transition for your role.", "error");
    return;
  }
  const reopening = placement.status === "complete";
  const status = reopening
    ? null
    : selectInput(allowed.map((item) => [item, titleCase(item)]), allowed[0], "Select status");
  const notes = reopening ? null : element("textarea", { value: placement.notes });
  const reason = reopening ? selectInput([
    ["premature_completion", "Completed too early"],
    ["incorrect_evidence", "Incorrect evidence"],
    ["administrative_correction", "Administrative correction"],
  ], "administrative_correction", "Select correction reason") : null;
  const fields = reopening
    ? [{ label: "Correction reason", input: reason, full: true }]
    : [{ label: "New status", input: status }, { label: "Operational notes", input: notes, full: true }];
  const form = formWithSubmit(fields, reopening ? "Reopen for review" : "Save status", async () => {
    try {
      await request(`/placements/${placement.id}`, {
        method: "PATCH",
        body: reopening
          ? { revision: placement.revision, status: "review", reopenReasonCode: reason.value }
          : { revision: placement.revision, status: status.value, notes: notes.value.trim() },
      });
      await refreshCore();
      await openPlacement(placement.id);
      flash(reopening ? "Placement reopened in review." : "Placement updated.");
      close();
    } catch (error) {
      if (error.status === 409) {
        await refreshCore();
        await openPlacement(placement.id);
        close();
        error.message = "This placement changed in another session. The latest record is now open.";
      }
      throw error;
    }
  });
  const { close } = openModal(
    reopening ? "Reopen completed placement" : "Update placement",
    reopening ? "Choose the governed correction reason. The placement returns to review and the reopening is audited." : "Completion is blocked until the readiness checklist is satisfied.",
    form,
  );
}

function openTimeEntryForm(placement) {
  const entryDate = simpleInput("date", "", { required: true }), hours = simpleInput("number", "", { required: true }), description = element("textarea"); hours.min = "0.25"; hours.max = "24"; hours.step = "0.25";
  const form = formWithSubmit([{ label: "Entry date", input: entryDate }, { label: "Hours", input: hours }, { label: "Description", input: description, full: true }], "Add time entry", async () => {
    await request(`/placements/${placement.id}/time-entries`, { method: "POST", body: { entryDate: entryDate.value, hours: Number(hours.value), description: description.value.trim() } });
    await refreshCore(); await openPlacement(placement.id); flash("Time entry added."); close();
  });
  const { close } = openModal("Add time entry", "Tutors submit entries for verification; coordinators and administrators may verify them.", form);
}

function openCheckInForm(placement) {
  const occurredAt = simpleInput("datetime-local", "", { required: true }), channel = selectInput([["in_person", "In person"], ["phone", "Phone"], ["email", "Email"], ["video", "Video"], ["other", "Other"]], "in_person", "Select channel"), summary = element("textarea", { required: true }), nextAction = element("textarea");
  const form = formWithSubmit([{ label: "When", input: occurredAt }, { label: "Channel", input: channel }, { label: "Summary", input: summary, full: true }, { label: "Next action", input: nextAction, full: true }], "Add check-in", async () => {
    const date = new Date(occurredAt.value);
    await request(`/placements/${placement.id}/check-ins`, { method: "POST", body: { occurredAt: date.toISOString(), channel: channel.value, summary: summary.value.trim(), nextAction: nextAction.value.trim() } });
    await refreshCore(); await openPlacement(placement.id); flash("Check-in recorded."); close();
  });
  const { close } = openModal("Add check-in", "Record the contact and its next operational action.", form);
}

function openDocumentForm(placement) {
  const kind = selectInput([["training_agreement", "Training agreement"], ["attendance_log", "Attendance log"], ["evaluation", "Evaluation"], ["completion_certificate", "Completion certificate"], ["other", "Other"]], "training_agreement", "Select document type");
  const title = simpleInput("text", "", { required: true });
  const availableStatuses = state.session.user.role === "tutor"
    ? [["missing", "Missing"], ["draft", "Draft"], ["ready", "Ready"]]
    : [["missing", "Missing"], ["draft", "Draft"], ["ready", "Ready"], ["signed", "Signed"]];
  const status = selectInput(availableStatuses, "draft", "Select status");
  const reference = simpleInput("text");
  const dueDate = simpleInput("date");
  const form = formWithSubmit([
    { label: "Document type", input: kind },
    { label: "Title", input: title },
    { label: "Status", input: status },
    { label: "Due date", input: dueDate },
    { label: "Reference", input: reference, full: true },
  ], "Add document", async () => {
    await request(`/placements/${placement.id}/documents`, {
      method: "POST",
      body: { kind: kind.value, title: title.value.trim(), status: status.value, dueDate: dueDate.value || null, reference: reference.value.trim() },
    });
    await refreshCore();
    await openPlacement(placement.id);
    flash("Document recorded.");
    close();
  });
  const { close } = openModal("Add document", "Track the document state and its external reference. Files remain in your approved document store.", form);
}

function documentEditButton(placement, document) {
  const button = element("button", { class: "row-button", type: "button", text: "Edit" });
  button.addEventListener("click", () => openDocumentEditForm(placement, document));
  return button;
}

function openDocumentEditForm(placement, documentRecord) {
  if (!documentRecord.canEdit) {
    flash("This document is read-only for your role or its current state.", "error");
    return;
  }
  const kind = selectInput([["training_agreement", "Training agreement"], ["attendance_log", "Attendance log"], ["evaluation", "Evaluation"], ["completion_certificate", "Completion certificate"], ["other", "Other"]], documentRecord.kind, "Select document type");
  const title = simpleInput("text", documentRecord.title, { required: true });
  if (documentRecord.requirementId) {
    kind.disabled = true;
    title.disabled = true;
  }
  const allowedStatuses = state.session.user.role === "tutor"
    ? [["missing", "Missing"], ["draft", "Draft"], ["ready", "Ready"]]
    : [["missing", "Missing"], ["draft", "Draft"], ["ready", "Ready"], ["signed", "Signed"]];
  const status = selectInput(allowedStatuses, documentRecord.status, "Select status");
  const reference = simpleInput("text", documentRecord.reference ?? "");
  const dueDate = simpleInput("date", documentRecord.dueDate ?? "");
  const form = formWithSubmit([
    { label: "Document type", input: kind },
    { label: "Title", input: title },
    { label: "Status", input: status },
    { label: "Due date", input: dueDate },
    { label: "Reference", input: reference, full: true },
  ], "Save document", async () => {
    await request(`/placements/${placement.id}/documents/${documentRecord.id}`, {
      method: "PATCH",
      body: {
        revision: documentRecord.revision,
        ...(documentRecord.requirementId ? {} : {
          kind: kind.value,
          title: title.value.trim(),
        }),
        status: status.value,
        dueDate: dueDate.value || null,
        reference: reference.value.trim(),
      },
    });
    await refreshCore();
    await openPlacement(placement.id);
    flash("Document updated.");
    close();
  });
  const { close } = openModal(
    "Edit document",
    documentRecord.requirementId
      ? "This evidence item comes from the placement programme. Its type and title stay fixed while status, due date and external reference may change."
      : "Correct the document record or move it through its review states.",
    form,
  );
}

function documentArchiveButton(placement, documentRecord) {
  const button = element("button", { class: "row-button", type: "button", text: "Archive" });
  button.addEventListener("click", () => openDocumentArchiveForm(placement, documentRecord));
  return button;
}

function openDocumentArchiveForm(placement, documentRecord) {
  const form = formWithSubmit([], "Archive signed document", async () => {
    await request(`/placements/${placement.id}/documents/${documentRecord.id}`, {
      method: "PATCH",
      body: { revision: documentRecord.revision, status: "archived" },
    });
    await refreshCore();
    await openPlacement(placement.id);
    flash("Document archived.");
    close();
  });
  const { close } = openModal("Archive document", `${documentRecord.title} will remain in the record and become read-only.`, form);
}

function documentSupersedeButton(placement, documentRecord) {
  const button = element("button", { class: "row-button", type: "button", text: "Supersede" });
  button.addEventListener("click", () => openDocumentSupersedeForm(placement, documentRecord));
  return button;
}

function openDocumentSupersedeForm(placement, documentRecord) {
  const reasonCode = selectInput([
    ["incorrect_evidence", "Incorrect evidence"],
    ["replacement_received", "Replacement received"],
    ["administrative_correction", "Administrative correction"],
  ], "replacement_received", "Select reason");
  const title = simpleInput("text", `${documentRecord.title} replacement`, { required: true });
  const status = selectInput([["missing", "Missing"], ["draft", "Draft"], ["ready", "Ready"]], "draft", "Select initial status");
  const dueDate = simpleInput("date", documentRecord.dueDate ?? "");
  const reference = simpleInput("text", "");
  const form = formWithSubmit([
    { label: "Reason", input: reasonCode },
    { label: "Replacement title", input: title },
    { label: "Initial status", input: status },
    { label: "Due date", input: dueDate },
    { label: "Reference", input: reference, full: true },
  ], "Create replacement", async () => {
    await request(`/placements/${placement.id}/documents/${documentRecord.id}/supersede`, {
      method: "POST",
      body: {
        revision: documentRecord.revision,
        reasonCode: reasonCode.value,
        title: title.value.trim(),
        status: status.value,
        dueDate: dueDate.value || null,
        reference: reference.value.trim(),
      },
    });
    await refreshCore();
    await openPlacement(placement.id);
    flash("Replacement document created. The signed record is marked as superseded.");
    close();
  });
  const { close } = openModal("Supersede signed document", "Keep the signed evidence immutable and create a linked replacement record.", form);
}

async function refreshCore() {
  await loadWorkspaceData();
}

async function boot() {
  if (!await apiAvailable()) { unavailableScreen(); return; }
  try {
    state.branding = await request("/public/branding");
    applyBranding(state.branding);
    state.session = await request("/session");
    if (!state.session.authenticated) { loginScreen(); return; }
    if (state.session.user?.mustChangePassword) { forcedPasswordScreen(); return; }
    await loadWorkspaceData();
    renderWorkspace();
  } catch (error) {
    app.className = "app-unavailable";
    app.replaceChildren(element("section", { class: "unavailable-card" }, [
      element("h1", { text: "The workspace could not start." }),
      element("p", { text: error.message }),
      element("a", { class: "button button-primary", href: "../", text: "Back to product page" }),
    ]));
  }
}

boot();
