const SETTINGS_KEY = "capswitch.settings";

const KEY_OPTIONS = [
  { label: "Shift", value: "Shift" },
  { label: "Control", value: "Control" },
  { label: "Alt", value: "Alt" },
  { label: "Meta", value: "Meta" },
  { label: "Tab", value: "Tab" },
  { label: "Escape", value: "Escape" },
  { label: "Enter", value: "Enter" },
  { label: "Space", value: "Space" },
  { label: "Backspace", value: "Backspace" },
  { label: "Delete", value: "Delete" },
  { label: "Home", value: "Home" },
  { label: "End", value: "End" },
  { label: "Page Up", value: "PageUp" },
  { label: "Page Down", value: "PageDown" },
  { label: "Arrow Up", value: "ArrowUp" },
  { label: "Arrow Down", value: "ArrowDown" },
  { label: "Arrow Left", value: "ArrowLeft" },
  { label: "Arrow Right", value: "ArrowRight" },
  ...Array.from({ length: 12 }, (_, i) => {
    const key = `F${i + 1}`;
    return { label: key, value: key };
  }),
  ...Array.from({ length: 26 }, (_, i) => {
    const key = String.fromCharCode(65 + i);
    return { label: key, value: key };
  }),
  ...Array.from({ length: 10 }, (_, i) => {
    const key = String(i);
    return { label: key, value: key };
  }),
];

const elements = {
  enabledToggle: document.getElementById("enabledToggle"),
  shortKey: document.getElementById("shortKey"),
  longKey: document.getElementById("longKey"),
  doubleKey: document.getElementById("doubleKey"),
  thresholdMs: document.getElementById("thresholdMs"),
  doubleTapMs: document.getElementById("doubleTapMs"),
  triggerOnOther: document.getElementById("triggerOnOther"),
  consumeCaps: document.getElementById("consumeCaps"),
  applyButton: document.getElementById("applyButton"),
  resetButton: document.getElementById("resetButton"),
  status: document.getElementById("status"),
  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText"),
};

function getDefaults() {
  if (window.capsSwitch && typeof window.capsSwitch.getDefaults === "function") {
    return window.capsSwitch.getDefaults();
  }
  return {
    enabled: true,
    shortKey: "Shift",
    longKey: "Control",
    doubleKey: "Escape",
    thresholdMs: 220,
    doubleTapMs: 240,
    triggerLongOnOtherKey: true,
    consumeCapsLock: true,
  };
}

function normalizeSettings(input) {
  const defaults = getDefaults();
  const next = { ...defaults, ...(input || {}) };

  return {
    enabled: Boolean(next.enabled),
    shortKey: typeof next.shortKey === "string" ? next.shortKey : defaults.shortKey,
    longKey: typeof next.longKey === "string" ? next.longKey : defaults.longKey,
    doubleKey: typeof next.doubleKey === "string" ? next.doubleKey : defaults.doubleKey,
    thresholdMs: clampNumber(next.thresholdMs, 80, 1000, defaults.thresholdMs),
    doubleTapMs: clampNumber(next.doubleTapMs, 120, 600, defaults.doubleTapMs),
    triggerLongOnOtherKey: next.triggerLongOnOtherKey !== false,
    consumeCapsLock: next.consumeCapsLock !== false,
  };
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function populateSelect(select, selectedValue) {
  select.innerHTML = "";
  KEY_OPTIONS.forEach((optionItem) => {
    const option = document.createElement("option");
    option.value = optionItem.value;
    option.textContent = optionItem.label;
    option.selected = optionItem.value === selectedValue;
    select.appendChild(option);
  });
}

function updateForm(settings) {
  elements.enabledToggle.checked = settings.enabled;
  elements.thresholdMs.value = settings.thresholdMs;
  elements.doubleTapMs.value = settings.doubleTapMs;
  elements.triggerOnOther.checked = settings.triggerLongOnOtherKey;
  elements.consumeCaps.checked = settings.consumeCapsLock;
  populateSelect(elements.shortKey, settings.shortKey);
  populateSelect(elements.longKey, settings.longKey);
  populateSelect(elements.doubleKey, settings.doubleKey);
}

function readForm() {
  return normalizeSettings({
    enabled: elements.enabledToggle.checked,
    shortKey: elements.shortKey.value,
    longKey: elements.longKey.value,
    doubleKey: elements.doubleKey.value,
    thresholdMs: elements.thresholdMs.value,
    doubleTapMs: elements.doubleTapMs.value,
    triggerLongOnOtherKey: elements.triggerOnOther.checked,
    consumeCapsLock: elements.consumeCaps.checked,
  });
}

function setStatus({ running, lastError }) {
  elements.status.classList.remove("ok", "error");
  if (lastError) {
    elements.status.classList.add("error");
    elements.statusText.textContent = `启动失败：${lastError}`;
    return;
  }
  if (running) {
    elements.status.classList.add("ok");
    elements.statusText.textContent = "映射已启用，正在监听 CapsLock";
  } else {
    elements.statusText.textContent = "映射已关闭";
  }
}

async function applySettings(settings) {
  if (window.ztools && window.ztools.dbStorage) {
    window.ztools.dbStorage.setItem(SETTINGS_KEY, settings);
  }
  if (window.capsSwitch && typeof window.capsSwitch.applySettings === "function") {
    const status = await window.capsSwitch.applySettings(settings);
    setStatus(status);
    return;
  }

  if (window.ztools && typeof window.ztools.sendToParent === "function") {
    window.ztools.sendToParent("capswitch:apply", settings);
  }

  setStatus({ running: settings.enabled, lastError: null });
}

function loadSettings() {
  if (window.ztools && window.ztools.dbStorage) {
    const saved = window.ztools.dbStorage.getItem(SETTINGS_KEY);
    return normalizeSettings(saved);
  }
  return normalizeSettings();
}

elements.applyButton.addEventListener("click", async () => {
  elements.applyButton.disabled = true;
  const settings = readForm();
  await applySettings(settings);
  elements.applyButton.disabled = false;
});

elements.resetButton.addEventListener("click", async () => {
  const defaults = normalizeSettings(getDefaults());
  updateForm(defaults);
  await applySettings(defaults);
});

window.addEventListener("DOMContentLoaded", async () => {
  const settings = loadSettings();
  updateForm(settings);
  await applySettings(settings);
});
