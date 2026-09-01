type ActivityRecord = {
  id: string;
  title: string;
  detail: string;
  timestamp: number;
  kind: "setup" | "review";
};

type SetupState = { version: string; folder: string };

const SETUP_KEY = "nutcx-web-setup-v1";
const ACTIVITY_KEY = "nutcx-web-activity-v1";

const setupForm = document.querySelector<HTMLFormElement>("[data-setup-form]");
const versionSelect = document.querySelector<HTMLSelectElement>("[data-android-version]");
const folderSelect = document.querySelector<HTMLSelectElement>("[data-folder-status]");
const setupResult = document.querySelector<HTMLElement>("[data-setup-result]");
const resultTitle = document.querySelector<HTMLElement>("[data-result-title]");
const resultDescription = document.querySelector<HTMLElement>("[data-result-description]");
const resultRequirements = document.querySelector<HTMLUListElement>("[data-result-requirements]");
const activityList = document.querySelector<HTMLElement>("[data-activity-list]");
const activityEmpty = document.querySelector<HTMLElement>("[data-activity-empty]");

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch { return fallback; }
}

function writeJson(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Local storage can be unavailable. */ }
}

function addActivity(title: string, detail: string, kind: ActivityRecord["kind"]) {
  const records = readJson<ActivityRecord[]>(ACTIVITY_KEY, []);
  records.unshift({ id: crypto.randomUUID?.() ?? String(Date.now()), title, detail, timestamp: Date.now(), kind });
  writeJson(ACTIVITY_KEY, records.slice(0, 8));
  renderActivity();
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function renderActivity() {
  if (!activityList || !activityEmpty) return;
  const records = readJson<ActivityRecord[]>(ACTIVITY_KEY, []);
  activityList.replaceChildren();
  activityEmpty.hidden = records.length > 0;
  activityList.hidden = records.length === 0;

  records.forEach((record) => {
    const item = document.createElement("article");
    item.className = "activity-item";
    const icon = document.createElement("span");
    icon.className = "activity-item__icon";
    icon.textContent = record.kind === "setup" ? "✓" : "•";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = record.title;
    const detail = document.createElement("small");
    detail.textContent = record.detail;
    copy.append(title, detail);
    const time = document.createElement("time");
    time.dateTime = new Date(record.timestamp).toISOString();
    time.textContent = formatTime(record.timestamp);
    item.append(icon, copy, time);
    activityList.append(item);
  });
}

function recommendation(version: string, folder: string) {
  if (version === "8-10") {
    return folder === "yes"
      ? { title: "Start with Folder access", detail: "Use Android’s folder picker for the selected package. Direct storage remains an alternative on Android 10 and earlier.", requirements: ["Select the target package first", "Choose the matching Android/data folder", "Allow the folder grant to be remembered"] }
      : { title: "Use Direct storage", detail: "The legacy storage route is intended for Android 10 and earlier when the folder picker cannot be used.", requirements: ["Allow legacy read and write storage access", "Confirm the target package", "Review the selected resource before applying"] };
  }
  if (folder === "yes") {
    return { title: "Start with Folder access", detail: "Use the guided Android folder picker first. Move to ADB only if Android blocks the selected package folder.", requirements: ["Select the target package", "Choose its Android/data folder", "Tap “Use this folder” and approve the grant"] };
  }
  return {
    title: "Use advanced Wireless ADB",
    detail: "Android is blocking direct folder selection, so NutCracker Tools needs a verified local ADB connection before file access can continue.",
    requirements: ["Enable Developer options and Wireless debugging", "Keep the device on Wi-Fi", ...(version === "13+" ? ["Allow notifications for pairing-code input"] : []), "Use a fresh six-digit pairing code"],
  };
}

setupForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const version = versionSelect?.value ?? "";
  const folder = folderSelect?.value ?? "";
  if (!version || !folder || !setupResult || !resultTitle || !resultDescription || !resultRequirements) return;
  const result = recommendation(version, folder);
  resultTitle.textContent = result.title;
  resultDescription.textContent = result.detail;
  resultRequirements.replaceChildren(...result.requirements.map((text) => {
    const item = document.createElement("li");
    item.textContent = text;
    return item;
  }));
  setupResult.classList.add("is-visible");
  writeJson(SETUP_KEY, { version, folder } satisfies SetupState);
  addActivity("Setup route reviewed", result.title, "setup");
});

document.querySelector<HTMLButtonElement>("[data-reset-setup]")?.addEventListener("click", () => {
  setupForm?.reset();
  setupResult?.classList.remove("is-visible");
  try { localStorage.removeItem(SETUP_KEY); } catch { /* Storage can be unavailable. */ }
});

const savedSetup = readJson<SetupState>(SETUP_KEY, { version: "", folder: "" });
if (versionSelect) versionSelect.value = savedSetup.version;
if (folderSelect) folderSelect.value = savedSetup.folder;

document.querySelector<HTMLButtonElement>("[data-clear-activity]")?.addEventListener("click", () => {
  try { localStorage.removeItem(ACTIVITY_KEY); } catch { /* Storage can be unavailable. */ }
  renderActivity();
  window.nutcxToast?.("Local activity cleared");
});

document.querySelectorAll<HTMLButtonElement>("[data-review-tool]").forEach((button) => {
  button.addEventListener("click", () => {
    const tool = button.dataset.reviewTool ?? "Tool";
    addActivity("Tool reviewed", tool, "review");
    window.nutcxToast?.(`${tool} marked as reviewed`);
  });
});

const toolSearch = document.querySelector<HTMLInputElement>("[data-tool-search]");
const toolCards = Array.from(document.querySelectorAll<HTMLElement>("[data-tool-card]"));
const toolEmpty = document.querySelector<HTMLElement>("[data-tool-empty]");
const filterButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-tool-filter]"));
let activeFilter = "all";

function filterTools() {
  const query = toolSearch?.value.trim().toLowerCase() ?? "";
  let visible = 0;
  toolCards.forEach((card) => {
    const matchesText = !query || (card.dataset.toolSearchText ?? "").includes(query);
    const matchesCategory = activeFilter === "all" || card.dataset.toolCategory === activeFilter;
    card.hidden = !(matchesText && matchesCategory);
    if (!card.hidden) visible += 1;
  });
  toolEmpty?.classList.toggle("is-visible", visible === 0);
}

toolSearch?.addEventListener("input", filterTools);
filterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    activeFilter = button.dataset.toolFilter ?? "all";
    filterButtons.forEach((candidate) => {
      const active = candidate === button;
      candidate.classList.toggle("is-active", active);
      candidate.setAttribute("aria-pressed", String(active));
    });
    filterTools();
  });
});

document.querySelector<HTMLButtonElement>("[data-clear-dashboard-data]")?.addEventListener("click", () => {
  try {
    [SETUP_KEY, ACTIVITY_KEY, "nutcx-theme"].forEach((key) => localStorage.removeItem(key));
  } catch { /* Storage can be unavailable. */ }
  setupForm?.reset();
  setupResult?.classList.remove("is-visible");
  renderActivity();
  window.nutcxToast?.("Website preferences erased");
});

renderActivity();
