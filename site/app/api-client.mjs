const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RETRY_AFTER_SECONDS = 3_600;
const NETWORK_MESSAGE = "VECTOR could not reach the server. Check the connection and try again.";
const TIMEOUT_MESSAGE = "The server took too long to respond. Try the action again.";
const INVALID_RESPONSE_MESSAGE =
  "VECTOR received a response it could not validate. Try again or contact the administrator.";
const PATH_VALIDATION_ORIGIN = "https://vector.invalid";

function canonicalPathname(value, label) {
  if (
    typeof value !== "string"
    || !value.startsWith("/")
    || value.startsWith("//")
    || value.includes("\\")
    || /[\u0000-\u0020\u007f]/.test(value)
  ) {
    throw new TypeError(`${label} must begin with exactly one slash and use a canonical path.`);
  }
  for (const segment of value.split("/")) {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new TypeError(`${label} must use valid URL encoding.`);
    }
    if (
      decoded === "."
      || decoded === ".."
      || decoded.includes("/")
      || decoded.includes("\\")
    ) {
      throw new TypeError(`${label} must not contain traversal or encoded separators.`);
    }
  }
  const url = new URL(value, PATH_VALIDATION_ORIGIN);
  if (
    url.origin !== PATH_VALIDATION_ORIGIN
    || url.search
    || url.hash
    || url.pathname !== value
  ) {
    throw new TypeError(`${label} must use a canonical same-origin pathname.`);
  }
  return value;
}

function apiBasePath(value) {
  if (
    typeof value !== "string"
    || value.endsWith("/")
    || value.includes("?")
    || value.includes("#")
  ) {
    throw new TypeError("API basePath must be a canonical absolute path without a trailing slash.");
  }
  return canonicalPathname(value, "API basePath");
}

function apiRequestPath(value, basePath) {
  if (typeof value !== "string" || value.includes("#") || value.includes("\\")) {
    throw new TypeError("API request paths must not contain fragments or backslashes.");
  }
  const queryIndex = value.indexOf("?");
  const pathname = queryIndex === -1 ? value : value.slice(0, queryIndex);
  canonicalPathname(pathname, "API request path");
  const target = new URL(`${basePath}${value}`, PATH_VALIDATION_ORIGIN);
  if (
    target.origin !== PATH_VALIDATION_ORIGIN
    || !target.pathname.startsWith(`${basePath}/`)
  ) {
    throw new TypeError("API request paths must remain inside the configured basePath.");
  }
  return value;
}

export class ApiError extends Error {
  constructor(message, {
    cause,
    code = "request_failed",
    details,
    requestId,
    retryAfterSeconds,
    retryable = false,
    status = 0,
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
    this.requestId = requestId;
    this.retryAfterSeconds = retryAfterSeconds;
    this.retryable = retryable;
    this.status = status;
  }
}

function positiveTimeout(value) {
  const timeout = Number(value ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 120_000) {
    throw new TypeError("Request timeout must be between 1 and 120000 milliseconds.");
  }
  return timeout;
}

function retryAfterSeconds(response) {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  if (/^\d+$/.test(value)) {
    if (value.length > 10) return MAX_RETRY_AFTER_SECONDS;
    const seconds = Number(value);
    return Number.isSafeInteger(seconds)
      ? Math.min(seconds, MAX_RETRY_AFTER_SECONDS)
      : MAX_RETRY_AFTER_SECONDS;
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(
    MAX_RETRY_AFTER_SECONDS,
    Math.max(0, Math.ceil((date - Date.now()) / 1_000)),
  );
}

function invalidResponse(response, cause) {
  return new ApiError(INVALID_RESPONSE_MESSAGE, {
    cause,
    code: "invalid_response",
    requestId: response.headers.get("x-request-id") ?? undefined,
    status: response.status,
  });
}

async function readPayload(response, { requireJson = false } = {}) {
  if (response.status === 204) return null;
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(body);
    } catch (cause) {
      throw invalidResponse(response, cause);
    }
  }
  if (requireJson) throw invalidResponse(response);
  return body;
}

function attachAbortSignal(callerSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(callerSignal.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    release() {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

function requestBodyAndHeaders(options, csrfToken) {
  const headers = new Headers(options.headers ?? {});
  headers.set("Accept", headers.get("Accept") ?? "application/json");
  const method = String(options.method ?? "GET").toUpperCase();
  let body = options.body;
  if (
    body !== undefined
    && body !== null
    && typeof body !== "string"
    && !(body instanceof Blob)
    && !(body instanceof FormData)
    && !(body instanceof URLSearchParams)
    && !(body instanceof ArrayBuffer)
    && !ArrayBuffer.isView(body)
  ) {
    headers.set("Content-Type", headers.get("Content-Type") ?? "application/json");
    body = JSON.stringify(body);
  }
  if (!SAFE_METHODS.has(method) && csrfToken) {
    headers.set("X-CSRF-Token", csrfToken);
  }
  return { body, headers, method };
}

export function createApiClient({
  basePath,
  fetchImpl = globalThis.fetch,
  getCsrfToken = () => null,
  isAuthenticated = () => false,
  onAuthenticationRequired = () => {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const safeBasePath = apiBasePath(basePath);
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");
  const defaultTimeout = positiveTimeout(timeoutMs);

  async function execute(path, options = {}, { mode }) {
    const safePath = apiRequestPath(path, safeBasePath);
    const timeout = positiveTimeout(options.timeoutMs ?? defaultTimeout);
    const { body, headers, method } = requestBodyAndHeaders(options, getCsrfToken());
    const abort = attachAbortSignal(options.signal, timeout);
    const {
      handleAuthentication: _handleAuthentication,
      timeoutMs: _timeoutMs,
      ...fetchOptions
    } = options;
    let response;
    try {
      response = await fetchImpl(`${safeBasePath}${safePath}`, {
        ...fetchOptions,
        body,
        headers,
        method,
        signal: abort.signal,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      });

      if (!response.ok) {
        const payload = await readPayload(response);
        const error = new ApiError(
          payload?.error?.message || "The request could not be completed.",
          {
            code: payload?.error?.code,
            details: payload?.error?.details,
            requestId: payload?.error?.requestId
              ?? response.headers.get("x-request-id")
              ?? undefined,
            retryAfterSeconds: retryAfterSeconds(response),
            retryable: response.status === 408 || response.status === 425
              || response.status === 429 || response.status >= 500,
            status: response.status,
          },
        );
        if (
          error.code === "authentication_required"
          && path !== "/auth/login"
          && options.handleAuthentication !== false
          && isAuthenticated()
        ) {
          onAuthenticationRequired(error);
        }
        throw error;
      }

      if (mode === "download") {
        const contentType = response.headers.get("content-type")
          ?.split(";", 1)[0]
          .trim()
          .toLowerCase();
        if (contentType !== "text/csv") {
          await response.arrayBuffer();
          throw invalidResponse(response);
        }
        return Object.freeze({
          blob: await response.blob(),
          headers: response.headers,
          status: response.status,
        });
      }
      return await readPayload(response, { requireJson: true });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (options.signal?.aborted) throw error;
      if (abort.timedOut()) {
        throw new ApiError(TIMEOUT_MESSAGE, {
          code: "request_timeout",
          retryable: true,
          cause: error,
        });
      }
      throw new ApiError(NETWORK_MESSAGE, {
        code: "network_error",
        retryable: true,
        cause: error,
      });
    } finally {
      abort.release();
    }
  }

  return Object.freeze({
    download(path, options) {
      return execute(path, options, { mode: "download" });
    },
    request(path, options) {
      return execute(path, options, { mode: "payload" });
    },
  });
}
