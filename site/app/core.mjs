export function createElementFactory(document) {
  function element(tag, options = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(options)) {
      if (value === undefined || value === null) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === "dataset") Object.assign(node.dataset, value);
      else if (key === "attrs") {
        Object.entries(value).forEach(([name, attribute]) => node.setAttribute(name, attribute));
      } else {
        node[key] = value;
      }
    }
    node.append(...children.filter(Boolean));
    return node;
  }

  return {
    element,
    text: (value) => document.createTextNode(value ?? ""),
  };
}

export function initials(name = "") {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || "V";
}

export function titleCase(value = "") {
  return String(value)
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatDate(value, locale = undefined) {
  if (!value) return "—";
  const text = String(value);
  const calendarDate = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const date = new Date(calendarDate ? `${text}T00:00:00Z` : text);
  if (Number.isNaN(date.getTime())) return text;
  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(calendarDate ? { timeZone: "UTC" } : {}),
  }).format(date);
}

export function formatDateTime(value, locale = undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function placementPercentage({ loggedHours, targetHours }) {
  const logged = Number(loggedHours);
  const target = Number(targetHours);
  if (!Number.isFinite(logged) || !Number.isFinite(target) || target <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((logged / target) * 100)));
}

export function pageQueryParams({
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

function safeFallbackFilename(fallback) {
  const value = String(fallback ?? "vector-download").trim();
  return value && !/[/\\\u0000-\u001f\u007f]/.test(value)
    ? value.slice(0, 180)
    : "vector-download";
}

export function downloadFilename(contentDisposition, fallback) {
  const safeFallback = safeFallbackFilename(fallback);
  if (!contentDisposition) return safeFallback;

  const encoded = contentDisposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  const basic = contentDisposition.match(/filename\s*=\s*(?:"([^"]+)"|([^;]+))/i);
  let candidate = encoded ?? basic?.[1] ?? basic?.[2];
  if (!candidate) return safeFallback;

  candidate = candidate.trim();
  if (encoded) {
    try {
      candidate = decodeURIComponent(candidate);
    } catch {
      return safeFallback;
    }
  }
  candidate = candidate.split(/[/\\]/).at(-1)?.trim() ?? "";
  candidate = candidate.replace(/[\u0000-\u001f\u007f]/g, "");
  if (!candidate || candidate === "." || candidate === "..") return safeFallback;
  return candidate.slice(0, 180);
}
