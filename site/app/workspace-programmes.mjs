import { formatDateTime } from "./core.mjs";
import {
  parseProgrammeRequirements,
  programmeRequirementsText,
} from "./workspace-domain.mjs";

export function createProgrammeFeature({
  element,
  state,
  request,
  flash,
  refreshCore,
  renderWorkspace,
  renderOverview,
  viewHeader,
  emptyPanel,
  statusClass,
  canManageProgrammes,
  openModal,
  formWithSubmit,
  simpleInput,
}) {
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
          element("p", {
            class: "eyebrow",
            text: `${programme.code} / VERSION ${version.version}`,
          }),
          element("h2", { text: programme.name }),
          element("p", {
            text: programme.description || "No programme note has been recorded.",
          }),
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
    try {
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
    } catch (error) {
      flash(error.message, "error");
    }
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
        {
          code: "training_agreement",
          label: "Signed training agreement",
          acceptedStatuses: ["signed", "archived"],
        },
        {
          code: "attendance_log",
          label: "Signed attendance log",
          acceptedStatuses: ["signed", "archived"],
        },
        {
          code: "evaluation",
          label: "Completed evaluation",
          acceptedStatuses: ["ready", "signed", "archived"],
        },
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
      {
        label: "Requirements: code | label | accepted statuses",
        input: version.requirements,
        full: true,
      },
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
      {
        label: "Requirements: code | label | accepted statuses",
        input: version.requirements,
        full: true,
      },
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

  return { renderProgrammes };
}
