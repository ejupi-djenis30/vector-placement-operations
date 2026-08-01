function readPort(environment, name, fallback) {
  const raw = String(environment[name] ?? fallback);
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer TCP port.`);
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error(`${name} must be between 1024 and 65535.`);
  }
  return port;
}

export function resolveE2ePorts(environment = process.env) {
  const workspace = readPort(environment, "VECTOR_E2E_WORKSPACE_PORT", 4_173);
  const presentation = readPort(environment, "VECTOR_E2E_PRESENTATION_PORT", 4_174);
  if (workspace === presentation) {
    throw new Error("VECTOR E2E workspace and presentation ports must be different.");
  }
  return { presentation, workspace };
}
