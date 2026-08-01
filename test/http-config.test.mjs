import assert from "node:assert/strict";
import { createServer, get as httpGet } from "node:http";
import { connect } from "node:net";
import test from "node:test";
import {
  closeHttpServer,
  configureHttpServer,
  once,
} from "../server/http.mjs";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function stalledRequest(baseUrl, requestBytes) {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const socket = connect(Number(url.port), url.hostname);
    let response = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.once("close", () => resolve({
      elapsedMs: Date.now() - startedAt,
      response,
    }));
    socket.once("connect", () => socket.write(requestBytes));
  });
}

test("HTTP server configuration applies bounded production transport limits", () => {
  const server = {};
  assert.equal(configureHttpServer(server, {
    requestTimeoutMs: 30_000,
    headersTimeoutMs: 10_000,
    keepAliveTimeoutMs: 5_000,
    maxRequestsPerSocket: 1_000,
  }), server);
  assert.deepEqual(server, {
    requestTimeout: 30_000,
    headersTimeout: 10_000,
    connectionsCheckingInterval: 1_000,
    keepAliveTimeout: 5_000,
    maxRequestsPerSocket: 1_000,
    maxHeadersCount: 0,
  });
});

test("resource closer runs once across overlapping shutdown and server-error paths", () => {
  let closed = 0;
  const close = once(() => {
    closed += 1;
    return "closed";
  });
  assert.equal(close(), "closed");
  assert.equal(close(), undefined);
  assert.equal(close(), undefined);
  assert.equal(closed, 1);
});

test("overlapping shutdown calls share one drain, listener close and asynchronous cleanup", async () => {
  let closeCallback;
  let drains = 0;
  let applicationCloses = 0;
  const cleanup = Promise.withResolvers();
  const server = {
    close(callback) {
      closeCallback = callback;
    },
    closeIdleConnections() {},
    closeAllConnections() {},
  };
  const first = closeHttpServer(server, {
    beginDrain: () => {
      drains += 1;
    },
    closeApplication: async () => {
      applicationCloses += 1;
      await cleanup.promise;
    },
    graceMs: 1_000,
  });
  const second = closeHttpServer(server, {
    beginDrain: () => {
      throw new Error("a duplicate shutdown must not install another drain");
    },
    closeApplication: () => {
      throw new Error("a duplicate shutdown must not close state again");
    },
    graceMs: 1,
  });

  assert.equal(first, second);
  assert.equal(drains, 1);
  closeCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(applicationCloses, 1);
  cleanup.resolve();
  assert.deepEqual(await first, { forced: false });
  assert.deepEqual(await second, { forced: false });
});

test("transport returns 408 for stalled headers and incomplete request bodies", async () => {
  const server = configureHttpServer(createServer((request, response) => {
    request.resume();
    request.once("end", () => response.end("ok"));
  }), {
    requestTimeoutMs: 150,
    headersTimeoutMs: 100,
    keepAliveTimeoutMs: 1_000,
    maxRequestsPerSocket: 10,
  });
  const baseUrl = await listen(server);
  try {
    for (const requestBytes of [
      "GET / HTTP/1.1\r\nHost: 127.0.0.1",
      "POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\nx",
    ]) {
      const result = await stalledRequest(baseUrl, requestBytes);
      assert.match(result.response, /^HTTP\/1\.1 408 Request Timeout/);
      assert.ok(
        result.elapsedMs < 1_500,
        `Stalled request exceeded the bounded timeout window: ${result.elapsedMs} ms.`,
      );
    }
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("graceful shutdown drains an in-flight response before closing application state", async () => {
  let completeResponse;
  let closed = 0;
  const responseStarted = Promise.withResolvers();
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("download-start:");
    completeResponse = () => response.end("download-complete");
    responseStarted.resolve();
  });
  const baseUrl = await listen(server);
  const response = await fetch(baseUrl);
  const body = response.text();
  await responseStarted.promise;

  const shutdown = closeHttpServer(server, {
    closeApplication: () => {
      closed += 1;
    },
    graceMs: 1_000,
  });
  completeResponse();

  assert.equal(await body, "download-start:download-complete");
  assert.deepEqual(await shutdown, { forced: false });
  assert.equal(closed, 1);
});

test("shutdown force-closes a stalled streaming response at the grace boundary", async () => {
  let closed = 0;
  let forced = 0;
  const responseStarted = Promise.withResolvers();
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.write("partial-download");
  });
  const baseUrl = await listen(server);
  const request = httpGet(baseUrl);
  const response = await new Promise((resolve, reject) => {
    request.once("error", reject);
    request.once("response", resolve);
  });
  response.once("data", () => responseStarted.resolve());
  response.resume();
  await responseStarted.promise;
  const connectionClosed = new Promise((resolve) => {
    response.once("aborted", resolve);
    response.once("close", resolve);
    response.once("error", resolve);
  });

  const result = await closeHttpServer(server, {
    closeApplication: () => {
      closed += 1;
    },
    graceMs: 50,
    onForce: () => {
      forced += 1;
    },
  });

  await connectionClosed;
  assert.deepEqual(result, { forced: true });
  assert.equal(forced, 1);
  assert.equal(closed, 1);
});

test("forced shutdown observes an absolute bound even without a server close callback", async () => {
  let forcedConnections = 0;
  let closed = 0;
  const server = {
    close() {},
    closeIdleConnections() {},
    closeAllConnections() {
      forcedConnections += 1;
    },
  };
  const startedAt = Date.now();
  const result = await closeHttpServer(server, {
    closeApplication: () => {
      closed += 1;
    },
    graceMs: 25,
  });

  assert.deepEqual(result, { forced: true });
  assert.equal(forcedConnections, 1);
  assert.equal(closed, 1);
  assert.ok(Date.now() - startedAt < 1_000, "forced shutdown exceeded its absolute bound");
});

test("shutdown contains force-observer failures until application state is closed", async () => {
  let closeCallback;
  let closed = 0;
  const server = {
    close(callback) {
      closeCallback = callback;
    },
    closeIdleConnections() {},
    closeAllConnections() {
      closeCallback();
    },
  };

  await assert.rejects(
    closeHttpServer(server, {
      closeApplication: () => {
        closed += 1;
      },
      graceMs: 10,
      onForce: () => {
        throw new Error("shutdown observer failed");
      },
    }),
    /shutdown observer failed/,
  );
  assert.equal(closed, 1);
});

test("shutdown closes application state when the force-close primitive fails", async () => {
  let closed = 0;
  const server = {
    close() {},
    closeIdleConnections() {},
    closeAllConnections() {
      throw new Error("force close failed");
    },
  };

  await assert.rejects(
    closeHttpServer(server, {
      closeApplication: () => {
        closed += 1;
      },
      graceMs: 10,
    }),
    /force close failed/,
  );
  assert.equal(closed, 1);
});

test("shutdown closes application state when the server refuses its close request", async () => {
  let closed = 0;
  const server = {
    close() {
      throw new Error("server close failed");
    },
    closeIdleConnections() {},
    closeAllConnections() {},
  };

  await assert.rejects(
    closeHttpServer(server, {
      closeApplication: () => {
        closed += 1;
      },
      graceMs: 100,
    }),
    /server close failed/,
  );
  assert.equal(closed, 1);
});

test("shutdown surfaces an application close failure after transport drain", async () => {
  const server = {
    close(callback) {
      callback();
    },
    closeIdleConnections() {},
    closeAllConnections() {},
  };

  await assert.rejects(
    closeHttpServer(server, {
      closeApplication: () => {
        throw new Error("SQLite close failed");
      },
      graceMs: 100,
    }),
    /SQLite close failed/,
  );
});

test("shutdown contains periodic idle-close failures through the force boundary", async () => {
  let closeCallback;
  let closed = 0;
  let idleCloseCalls = 0;
  const server = {
    close(callback) {
      closeCallback = callback;
    },
    closeIdleConnections() {
      idleCloseCalls += 1;
      if (idleCloseCalls > 1) throw new Error("idle close failed");
    },
    closeAllConnections() {
      closeCallback();
    },
  };

  await assert.rejects(
    closeHttpServer(server, {
      closeApplication: () => {
        closed += 1;
      },
      graceMs: 30,
    }),
    /idle close failed/,
  );
  assert.equal(idleCloseCalls, 2);
  assert.equal(closed, 1);
});

test("an initial idle-close failure preserves the force deadline and application cleanup", async () => {
  let closeCallback;
  let forced = 0;
  let closed = 0;
  const server = {
    close(callback) {
      closeCallback = callback;
    },
    closeIdleConnections() {
      throw new Error("initial idle close failed");
    },
    closeAllConnections() {
      forced += 1;
      closeCallback();
    },
  };

  await assert.rejects(
    closeHttpServer(server, {
      closeApplication: () => {
        closed += 1;
      },
      graceMs: 20,
    }),
    /initial idle close failed/,
  );
  assert.equal(forced, 1);
  assert.equal(closed, 1);
});
