import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, createApiClient } from "../site/app/api-client.mjs";
import {
  downloadFilename,
  formatDate,
  pageQueryParams,
  placementPercentage,
  titleCase,
} from "../site/app/core.mjs";

test("workspace core formats bounded values and stable collection queries", () => {
  assert.equal(titleCase("school_admin"), "School Admin");
  assert.equal(formatDate("2026-07-30", "en-GB"), "30 Jul 2026");
  assert.equal(formatDate("not-a-date"), "not-a-date");
  assert.equal(placementPercentage({ loggedHours: 18, targetHours: 24 }), 75);
  assert.equal(placementPercentage({ loggedHours: -2, targetHours: 24 }), 0);
  assert.equal(placementPercentage({ loggedHours: 4, targetHours: 0 }), 0);
  assert.equal(
    pageQueryParams({
      limit: 25,
      query: "Mira Vale",
      status: "active",
      cursor: "opaque",
    }),
    "limit=25&query=Mira+Vale&cursor=opaque&status=active",
  );
});

test("calendar dates remain the same day in extreme positive time zones", () => {
  const previousTimeZone = process.env.TZ;
  try {
    process.env.TZ = "Pacific/Kiritimati";
    assert.equal(formatDate("2026-12-31", "en-GB"), "31 Dec 2026");
  } finally {
    if (previousTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimeZone;
  }
});

test("download filenames accept reviewed response values without path or control injection", () => {
  assert.equal(
    downloadFilename("attachment; filename*=UTF-8''vector%20placements.csv", "fallback.csv"),
    "vector placements.csv",
  );
  assert.equal(
    downloadFilename('attachment; filename="..\\\\private\\\\audit.csv"', "fallback.csv"),
    "audit.csv",
  );
  assert.equal(
    downloadFilename('attachment; filename="..\\\\private\\\\line\r\nbreak.csv"', "fallback.csv"),
    "linebreak.csv",
  );
  assert.equal(
    downloadFilename("attachment; filename*=UTF-8''%E0%A4%A", "fallback.csv"),
    "fallback.csv",
  );
  assert.equal(downloadFilename(null, "students.csv"), "students.csv");
});

test("API client serializes JSON, applies CSRF and leaves caller options unchanged", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const body = { name: "Northstar Studio" };
  const options = { method: "POST", body };
  const client = createApiClient({
    basePath: "/api",
    fetchImpl,
    getCsrfToken: () => "csrf-token",
  });

  assert.deepEqual(await client.request("/hosts", options), { ok: true });
  assert.equal(captured.url, "/api/hosts");
  assert.equal(captured.options.body, JSON.stringify(body));
  assert.equal(captured.options.headers.get("content-type"), "application/json");
  assert.equal(captured.options.headers.get("x-csrf-token"), "csrf-token");
  assert.equal(captured.options.credentials, "same-origin");
  assert.equal(captured.options.redirect, "error");
  assert.deepEqual(options.body, body);
});

test("API client rejects paths that can escape or alter its same-origin base before fetch", async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  for (const basePath of [
    "//evil.example",
    "/api/",
    "/api?mode=unsafe",
    "/api#fragment",
    "/api\\escape",
    "/api/../escape",
    "/api/%2e%2e/escape",
    " /api",
  ]) {
    assert.throws(
      () => createApiClient({ basePath, fetchImpl }),
      /API basePath/,
      basePath,
    );
  }
  assert.equal(fetchCalls, 0);

  const client = createApiClient({
    basePath: "/vector-placement-operations/api",
    fetchImpl,
  });
  for (const path of [
    "//evil.example",
    "/../escape",
    "/%2e%2e/escape",
    "/hosts/./edit",
    "/hosts\\escape",
    "/hosts#fragment",
    "/hosts?query=safe#fragment",
    " /hosts",
  ]) {
    await assert.rejects(client.request(path), /API request path/, path);
  }
  assert.equal(fetchCalls, 0);

  assert.deepEqual(await client.request("/health/live?probe=1"), { ok: true });
  assert.equal(fetchCalls, 1);
});

test("API client preserves server error metadata and expires authenticated sessions once", async () => {
  let expired = 0;
  const client = createApiClient({
    basePath: "/api",
    fetchImpl: async () => new Response(JSON.stringify({
      error: {
        code: "authentication_required",
        message: "Sign in again.",
        requestId: "request-123",
      },
    }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "retry-after": "7",
      },
    }),
    isAuthenticated: () => true,
    onAuthenticationRequired: () => {
      expired += 1;
    },
  });

  await assert.rejects(
    client.request("/dashboard"),
    (error) => {
      assert(error instanceof ApiError);
      assert.equal(error.code, "authentication_required");
      assert.equal(error.status, 401);
      assert.equal(error.requestId, "request-123");
      assert.equal(error.retryAfterSeconds, 7);
      return true;
    },
  );
  assert.equal(expired, 1);
});

test("API client bounds attacker-controlled Retry-After values", async () => {
  const retryAfterValues = [
    "9999999999",
    "9".repeat(5_000),
    "Sat, 01 Jan 2100 00:00:00 GMT",
  ];
  const client = createApiClient({
    basePath: "/api",
    fetchImpl: async () => new Response(JSON.stringify({
      error: { code: "not_ready", message: "Try later." },
    }), {
      status: 503,
      headers: {
        "content-type": "application/json",
        "retry-after": retryAfterValues.shift(),
      },
    }),
  });

  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(
      client.request("/session"),
      (error) => error instanceof ApiError
        && error.retryAfterSeconds === 3_600
        && error.retryable,
    );
  }
});

test("API client rejects a successful response that is not valid JSON", async () => {
  const client = createApiClient({
    basePath: "/api",
    fetchImpl: async () => new Response("<html>proxy login page</html>", {
      status: 200,
      headers: {
        "content-type": "text/html",
        "x-request-id": "request-invalid-response",
      },
    }),
  });

  await assert.rejects(
    client.request("/dashboard"),
    (error) => error instanceof ApiError
      && error.code === "invalid_response"
      && error.status === 200
      && error.requestId === "request-invalid-response"
      && !error.retryable,
  );
});

test("API client rejects a successful download with an unexpected media type", async () => {
  const client = createApiClient({
    basePath: "/api",
    fetchImpl: async () => new Response("<html>proxy login page</html>", {
      status: 200,
      headers: {
        "content-type": "text/html",
        "x-request-id": "request-invalid-download",
      },
    }),
  });

  await assert.rejects(
    client.download("/export?resource=students"),
    (error) => error instanceof ApiError
      && error.code === "invalid_response"
      && error.status === 200
      && error.requestId === "request-invalid-download",
  );
});

test("API client converts a bounded wait into a retryable timeout", async () => {
  const client = createApiClient({
    basePath: "/api",
    timeoutMs: 5,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    }),
  });

  await assert.rejects(
    client.request("/health/live"),
    (error) => {
      assert(error instanceof ApiError);
      assert.equal(error.code, "request_timeout");
      assert.equal(error.retryable, true);
      assert.equal(error.status, 0);
      return true;
    },
  );
});

test("API client keeps the timeout active while a download body is streaming", async () => {
  const client = createApiClient({
    basePath: "/api",
    timeoutMs: 5,
    fetchImpl: async (_url, { signal }) => {
      let bodyController;
      const body = new ReadableStream({
        start(controller) {
          bodyController = controller;
          controller.enqueue(new TextEncoder().encode("student,host\n"));
        },
      });
      signal.addEventListener(
        "abort",
        () => bodyController.error(new DOMException("download timed out", "AbortError")),
        { once: true },
      );
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/csv" },
      });
    },
  });

  await assert.rejects(
    client.download("/export?resource=students"),
    (error) => error instanceof ApiError
      && error.code === "request_timeout"
      && error.retryable,
  );
});

test("API client propagates caller cancellation and releases its abort listener", async () => {
  const caller = new AbortController();
  const signal = caller.signal;
  let added = 0;
  let removed = 0;
  const addEventListener = signal.addEventListener.bind(signal);
  const removeEventListener = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...args) => {
    added += 1;
    return addEventListener(...args);
  };
  signal.removeEventListener = (...args) => {
    removed += 1;
    return removeEventListener(...args);
  };
  const client = createApiClient({
    basePath: "/api",
    fetchImpl: (_url, { signal: requestSignal }) => new Promise((_resolve, reject) => {
      requestSignal.addEventListener(
        "abort",
        () => reject(new DOMException("cancelled by caller", "AbortError")),
        { once: true },
      );
    }),
  });

  const pending = client.request("/placements", { signal });
  caller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(added, 1);
  assert.equal(removed, 1);
});

test("API client maps non-JSON download failures and can suppress session handling", async () => {
  let expired = 0;
  const responses = [
    new Response("gateway unavailable", { status: 502, headers: { "content-type": "text/plain" } }),
    new Response(JSON.stringify({
      error: { code: "authentication_required", message: "Sign in again." },
    }), { status: 401, headers: { "content-type": "application/json" } }),
  ];
  const client = createApiClient({
    basePath: "/api",
    fetchImpl: async () => responses.shift(),
    isAuthenticated: () => true,
    onAuthenticationRequired: () => {
      expired += 1;
    },
  });

  await assert.rejects(
    client.download("/export?resource=students", { headers: { Accept: "text/csv" } }),
    (error) => error instanceof ApiError
      && error.code === "request_failed"
      && error.status === 502
      && error.retryable,
  );
  await assert.rejects(
    client.request("/session", { handleAuthentication: false }),
    (error) => error instanceof ApiError && error.code === "authentication_required",
  );
  assert.equal(expired, 0);
});
