import "../server/index.mjs";

process.on("message", (signal) => {
  if (!["SIGINT", "SIGTERM"].includes(signal)) return;
  // Windows cannot deliver POSIX signals to a detached child portably. Emitting
  // the same process event exercises VECTOR's registered handler on every CI OS.
  process.emit(signal);
  process.disconnect();
});
