import { FIXTURES } from "./fixtures.mjs";
import { STATUS, advanceStatus, filterPlacements, normalizePlacements, progress, summarize } from "./model.mjs";

const STORAGE_KEY = "vector-placement-demo";
const list = document.querySelector("[data-placement-list]");
const empty = document.querySelector("[data-empty]");
const search = document.querySelector("[data-search]");
const tabs = document.querySelector("[data-status-tabs]");
let activeStatus = "all";
let records = load();

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(saved) ? normalizePlacements(saved) : structuredClone(FIXTURES);
  } catch {
    return structuredClone(FIXTURES);
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // The in-memory demo remains usable when browser storage is unavailable.
  }
}

function createRecord(record) {
  const article = document.createElement("article");
  article.className = "placement-row";
  const identity = document.createElement("div");
  identity.className = "placement-identity";
  const initials = document.createElement("span");
  initials.textContent = record.student.split(" ").map((part) => part[0]).join("");
  initials.setAttribute("aria-hidden", "true");
  const title = document.createElement("div");
  const name = document.createElement("strong");
  name.textContent = record.student;
  const detail = document.createElement("small");
  detail.textContent = `${record.id} · ${record.track}`;
  title.append(name, detail);
  identity.append(initials, title);

  const host = document.createElement("div");
  host.className = "placement-copy";
  host.innerHTML = `<span>HOST</span><strong></strong><small></small>`;
  host.querySelector("strong").textContent = record.company;
  host.querySelector("small").textContent = `Supervisor: ${record.supervisor}`;

  const meter = document.createElement("div");
  meter.className = "placement-progress";
  const amount = progress(record);
  meter.innerHTML = `<span>HOURS <b></b></span><progress max="100"></progress><small></small>`;
  meter.querySelector("b").textContent = `${amount}%`;
  const bar = meter.querySelector("progress");
  bar.value = amount;
  bar.setAttribute("aria-label", `Hours logged for ${record.student}`);
  meter.querySelector("small").textContent = `${record.loggedHours} of ${record.targetHours} logged`;

  const action = document.createElement("button");
  action.type = "button";
  action.className = `status status-${STATUS[record.status].tone}`;
  action.textContent = STATUS[record.status].label;
  action.title = record.status === "complete" ? "Placement is complete" : "Advance to next milestone";
  action.setAttribute(
    "aria-label",
    record.status === "complete"
      ? `${record.student}: placement is complete`
      : `${record.student}: ${STATUS[record.status].label}. Advance to next milestone`,
  );
  action.disabled = record.status === "complete";
  action.addEventListener("click", () => {
    records = records.map((current) => current.id === record.id ? advanceStatus(current) : current);
    save();
    render();
  });

  article.append(identity, host, meter, action);
  return article;
}

function render() {
  const summary = summarize(records);
  Object.entries(summary).forEach(([key, value]) => {
    const target = document.querySelector(`[data-metric="${key}"]`);
    if (target) target.textContent = value;
  });
  const filtered = filterPlacements(records, { query: search.value, status: activeStatus });
  list.replaceChildren(...filtered.map(createRecord));
  empty.hidden = filtered.length !== 0;
}

search.addEventListener("input", render);
tabs.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-status]");
  if (!button) return;
  activeStatus = button.dataset.status;
  tabs.querySelectorAll("button").forEach((candidate) => candidate.setAttribute("aria-pressed", String(candidate === button)));
  render();
});
document.querySelector("[data-reset]").addEventListener("click", () => {
  records = structuredClone(FIXTURES);
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Reset still applies to the current session when browser storage is unavailable.
  }
  search.value = "";
  activeStatus = "all";
  tabs.querySelectorAll("button").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.status === "all")));
  render();
});
render();
