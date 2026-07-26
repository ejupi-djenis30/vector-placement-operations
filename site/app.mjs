const status = document.querySelector("[data-api-status]");
const workspaceLinks = document.querySelectorAll("[data-workspace-link]");

async function detectInstallation() {
  try {
    const response = await fetch("api/health/live", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    const body = response.ok ? await response.json() : null;
    if (body?.status === "ok") {
      status.textContent = "This installation is online. Sign in with an account created by its administrator.";
      return;
    }
  } catch {
    // A GitHub Pages product presentation deliberately has no application API.
  }

  status.textContent = "You are viewing the public product page. Run VECTOR self-hosted to sign in and use the workspace.";
  workspaceLinks.forEach((link) => {
    link.setAttribute("href", "#self-host");
    link.setAttribute("aria-label", "Read the self-hosting setup path");
  });
}

detectInstallation();
