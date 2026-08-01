export const MAX_HEADER_COUNT = 100;

const shutdowns = new WeakMap();

export function once(action) {
  let called = false;
  return (...args) => {
    if (called) return undefined;
    called = true;
    return action(...args);
  };
}

export function configureHttpServer(server, config) {
  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = config.headersTimeoutMs;
  server.connectionsCheckingInterval = Math.max(
    250,
    Math.min(1_000, Math.floor(config.headersTimeoutMs / 4)),
  );
  server.keepAliveTimeout = config.keepAliveTimeoutMs;
  server.maxRequestsPerSocket = config.maxRequestsPerSocket;
  // Node otherwise truncates the parsed and raw header lists without rejecting the
  // request. The application rejects the complete list above MAX_HEADER_COUNT,
  // while Node's independent header-byte limit still bounds parser memory.
  server.maxHeadersCount = 0;
  return server;
}

export function closeHttpServer(server, {
  beginDrain = () => {},
  closeApplication,
  graceMs,
  onForce = () => {},
} = {}) {
  const existingShutdown = shutdowns.get(server);
  if (existingShutdown) return existingShutdown;

  const shutdown = new Promise((resolve, reject) => {
    let forced = false;
    let drainError = null;
    let forceError = null;
    let idleCloseError = null;
    try {
      beginDrain();
    } catch (error) {
      drainError = error;
    }
    const forceClose = setTimeout(() => {
      forced = true;
      try {
        onForce();
      } catch (error) {
        forceError = error;
      }
      try {
        server.closeAllConnections();
      } catch (error) {
        forceError ??= error;
      }
      // Do not depend on a server implementation invoking its close callback
      // after force-closing sockets. The grace deadline is an absolute bound.
      finish(forceError);
    }, graceMs);
    forceClose.unref();
    const closeNewlyIdleConnections = setInterval(
      () => {
        if (idleCloseError) return;
        try {
          server.closeIdleConnections();
        } catch (error) {
          idleCloseError = error;
        }
      },
      Math.max(10, Math.min(250, Math.floor(graceMs / 4))),
    );
    closeNewlyIdleConnections.unref();

    const finish = once((serverError = null) => {
      clearTimeout(forceClose);
      clearInterval(closeNewlyIdleConnections);
      let closeResult;
      try {
        closeResult = closeApplication();
      } catch (error) {
        const failure = serverError ?? error ?? forceError ?? idleCloseError ?? drainError;
        reject(failure);
        return;
      }
      Promise.resolve(closeResult).then(
        () => {
          const failure = serverError ?? forceError ?? idleCloseError ?? drainError;
          if (failure) reject(failure);
          else resolve({ forced });
        },
        (closeError) => reject(
          serverError ?? closeError ?? forceError ?? idleCloseError ?? drainError,
        ),
      );
    });

    try {
      server.close(finish);
    } catch (error) {
      finish(error);
      return;
    }
    try {
      server.closeIdleConnections();
    } catch (error) {
      idleCloseError = error;
    }
  });
  shutdowns.set(server, shutdown);
  return shutdown;
}
