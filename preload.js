const { GlobalKeyboardListener } = require("node-global-key-listener");
const { ipcRenderer } = require("electron");

const SETTINGS_KEY = "capswitch.settings";
const DEFAULT_SETTINGS = {
  enabled: true,
  shortKey: "Shift",
  longKey: "Control",
  doubleKey: "Escape",
  thresholdMs: 220,
  doubleTapMs: 240,
  triggerLongOnOtherKey: true,
  consumeCapsLock: true,
};

const CAPS_KEY_NAME = "CAPS LOCK";
const INJECTION_WINDOW_MS = 120;
const SIMULATE_DEBOUNCE_MS = 80;
const STOP_EVENT = { stopPropagation: true, stopImmediatePropagation: true };

const state = {
  settings: { ...DEFAULT_SETTINGS },
  running: false,
  initialized: false,
  capsDown: false,
  longPressActive: false,
  longPressTimer: null,
  longPressModifier: null,
  listener: null,
  handler: null,
  lastError: null,
  injectedKeys: new Map(),
  forwardedKeys: new Set(),
  lastSimulatedAt: new Map(),
  lastSimulatedTap: new Map(),
  pendingTapTimer: null,
  pendingTapAt: 0,
  pendingTapArmed: false,
  doubleTapCandidate: false,
  settingsWindow: null,
};

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function normalizeKeyCode(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed : fallback;
}

function normalizeSettings(input = {}) {
  const next = { ...DEFAULT_SETTINGS, ...input };
  return {
    enabled: Boolean(next.enabled),
    shortKey: normalizeKeyCode(next.shortKey, DEFAULT_SETTINGS.shortKey),
    longKey: normalizeKeyCode(next.longKey, DEFAULT_SETTINGS.longKey),
    doubleKey: normalizeKeyCode(next.doubleKey, DEFAULT_SETTINGS.doubleKey),
    thresholdMs: clampNumber(next.thresholdMs, 80, 1000, DEFAULT_SETTINGS.thresholdMs),
    doubleTapMs: clampNumber(next.doubleTapMs, 120, 600, DEFAULT_SETTINGS.doubleTapMs),
    triggerLongOnOtherKey: next.triggerLongOnOtherKey !== false,
    consumeCapsLock: next.consumeCapsLock !== false,
  };
}

function getZtools() {
  if (typeof window === "undefined") return null;
  return window.ztools || null;
}

function isMac() {
  return process.platform === "darwin";
}

function normalizeEventName(value) {
  if (!value) return "";
  return String(value).trim().toUpperCase();
}

function getEventName(event) {
  if (!event) return "";
  if (event.name) return String(event.name);
  if (event.rawKey) {
    if (event.rawKey.name) return String(event.rawKey.name);
    if (event.rawKey._nameRaw) return String(event.rawKey._nameRaw);
  }
  if (event._raw) return String(event._raw);
  return "";
}

function getEventKeyId(event) {
  if (event && Number.isFinite(event.vKey)) {
    return `VK_${event.vKey}`;
  }
  if (event && Number.isFinite(event.scanCode)) {
    return `SC_${event.scanCode}`;
  }
  const nameUpper = normalizeEventName(getEventName(event));
  return nameUpper ? `NAME_${nameUpper}` : "UNKNOWN";
}

function isCapsEvent(event) {
  if (!event) return false;
  if (Number.isFinite(event.vKey) && event.vKey === 20) return true;
  if (Number.isFinite(event.scanCode) && event.scanCode === 58) return true;
  const nameUpper = normalizeEventName(getEventName(event));
  if (nameUpper === CAPS_KEY_NAME || nameUpper === "CAPSLOCK") return true;
  return nameUpper.includes("CAPS");
}

function resolveModifierKey(value) {
  switch (value) {
    case "Shift":
      return "shift";
    case "Control":
      return "ctrl";
    case "Alt":
      return "alt";
    case "Meta":
      return isMac() ? "command" : "super";
    default:
      return null;
  }
}

function resolveTapKey(value) {
  if (!value) return null;
  const fixed = String(value).trim();
  if (!fixed) return null;

  const map = {
    Shift: "shift",
    Control: "ctrl",
    Alt: "alt",
    Meta: isMac() ? "command" : "super",
    Tab: "tab",
    Escape: "escape",
    Enter: "enter",
    Space: "space",
    Backspace: "backspace",
    Delete: "delete",
    Home: "home",
    End: "end",
    PageUp: "pageup",
    PageDown: "pagedown",
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
  };

  if (map[fixed]) return map[fixed];
  if (/^F\d{1,2}$/.test(fixed)) return fixed.toLowerCase();
  if (/^[A-Z]$/.test(fixed)) return fixed.toLowerCase();
  if (/^\d$/.test(fixed)) return fixed;
  return fixed.toLowerCase();
}

function mapVKeyToTapKey(vKey) {
  if (!Number.isFinite(vKey)) return null;
  if (vKey >= 65 && vKey <= 90) return String.fromCharCode(vKey + 32);
  if (vKey >= 48 && vKey <= 57) return String.fromCharCode(vKey);
  if (vKey >= 112 && vKey <= 135) return `f${vKey - 111}`;

  const map = {
    9: "tab",
    13: "enter",
    27: "escape",
    32: "space",
    8: "backspace",
    46: "delete",
    36: "home",
    35: "end",
    33: "pageup",
    34: "pagedown",
    37: "left",
    38: "up",
    39: "right",
    40: "down",
  };

  return map[vKey] || null;
}

function mapTapKeyToVKey(tapKey) {
  if (!tapKey) return null;
  const key = String(tapKey).toLowerCase();
  if (/^[a-z]$/.test(key)) return key.toUpperCase().charCodeAt(0);
  if (/^\d$/.test(key)) return key.charCodeAt(0);
  if (/^f\d{1,2}$/.test(key)) return 111 + Number(key.slice(1));

  const map = {
    tab: 9,
    enter: 13,
    escape: 27,
    space: 32,
    backspace: 8,
    delete: 46,
    home: 36,
    end: 35,
    pageup: 33,
    pagedown: 34,
    left: 37,
    up: 38,
    right: 39,
    down: 40,
    shift: 16,
    ctrl: 17,
    alt: 18,
    command: 91,
    super: 91,
  };

  return map[key] ?? null;
}

function mapGlobalKeyToTapKey(name) {
  if (!name) return null;
  const upper = String(name).toUpperCase();
  const map = {
    SPACE: "space",
    TAB: "tab",
    RETURN: "enter",
    ESCAPE: "escape",
    BACKSPACE: "backspace",
    DELETE: "delete",
    HOME: "home",
    END: "end",
    "PAGE UP": "pageup",
    "PAGE DOWN": "pagedown",
    "UP ARROW": "up",
    "DOWN ARROW": "down",
    "LEFT ARROW": "left",
    "RIGHT ARROW": "right",
  };

  if (map[upper]) return map[upper];
  if (/^F\d{1,2}$/.test(upper)) return upper.toLowerCase();
  if (/^[A-Z]$/.test(upper)) return upper.toLowerCase();
  if (/^\d$/.test(upper)) return upper;
  return null;
}

function mapEventToTapKey(event) {
  const name = getEventName(event);
  const byName = mapGlobalKeyToTapKey(name);
  if (byName) return byName;
  if (Number.isFinite(event?.vKey)) return mapVKeyToTapKey(event.vKey);
  return null;
}

function collectModifiers(downMap) {
  if (!downMap) return [];
  const mods = new Set();

  if (downMap["LEFT SHIFT"] || downMap["RIGHT SHIFT"]) mods.add("shift");
  if (downMap["LEFT ALT"] || downMap["RIGHT ALT"]) mods.add("alt");
  if (downMap["LEFT META"] || downMap["RIGHT META"]) {
    mods.add(isMac() ? "command" : "super");
  }
  if (downMap["LEFT CTRL"] || downMap["RIGHT CTRL"]) mods.add("ctrl");

  return Array.from(mods);
}

function getInjectedNamesForTapKey(tapKey) {
  if (!tapKey) return [];
  const key = String(tapKey).toLowerCase();
  const map = {
    shift: ["LEFT SHIFT", "RIGHT SHIFT"],
    ctrl: ["LEFT CTRL", "RIGHT CTRL"],
    alt: ["LEFT ALT", "RIGHT ALT"],
    command: ["LEFT META", "RIGHT META"],
    super: ["LEFT META", "RIGHT META"],
    tab: ["TAB"],
    escape: ["ESCAPE"],
    enter: ["RETURN"],
    space: ["SPACE"],
    backspace: ["BACKSPACE"],
    delete: ["DELETE"],
    home: ["HOME"],
    end: ["END"],
    pageup: ["PAGE UP"],
    pagedown: ["PAGE DOWN"],
    up: ["UP ARROW"],
    down: ["DOWN ARROW"],
    left: ["LEFT ARROW"],
    right: ["RIGHT ARROW"],
  };

  if (map[key]) return map[key];
  if (/^f\d{1,2}$/.test(key)) return [key.toUpperCase()];
  if (/^[a-z]$/.test(key)) return [key.toUpperCase()];
  if (/^\d$/.test(key)) return [key];
  return [];
}

function getInjectedIdsFromEvent(event) {
  const ids = [];
  if (event && Number.isFinite(event.vKey)) {
    ids.push(`VK_${event.vKey}`);
  }
  if (event && Number.isFinite(event.scanCode)) {
    ids.push(`SC_${event.scanCode}`);
  }
  const nameUpper = normalizeEventName(getEventName(event));
  if (nameUpper) ids.push(`NAME_${nameUpper}`);
  return ids;
}

function getInjectedIdsForTapKey(tapKey) {
  const ids = [];
  const vKey = mapTapKeyToVKey(tapKey);
  if (Number.isFinite(vKey)) ids.push(`VK_${vKey}`);
  const names = getInjectedNamesForTapKey(tapKey);
  names.forEach((name) => {
    const upper = normalizeEventName(name);
    if (upper) ids.push(`NAME_${upper}`);
  });
  return ids;
}

function markInjectedForTapKey(tapKey) {
  if (!tapKey) return;
  const ids = getInjectedIdsForTapKey(tapKey);
  if (!ids.length) return;
  const timestamp = Date.now();
  ids.forEach((id) => state.injectedKeys.set(id, timestamp));
}

function isInjectedId(id) {
  const timestamp = state.injectedKeys.get(id);
  if (!timestamp) return false;
  if (Date.now() - timestamp > INJECTION_WINDOW_MS) {
    state.injectedKeys.delete(id);
    return false;
  }
  return true;
}

function isInjectedEvent(event) {
  const ids = getInjectedIdsFromEvent(event);
  if (ids.some((id) => isInjectedId(id))) return true;
  const tapKey = mapEventToTapKey(event);
  if (tapKey) {
    const lastTapAt = state.lastSimulatedTap.get(String(tapKey).toLowerCase()) || 0;
    if (Date.now() - lastTapAt <= INJECTION_WINDOW_MS) return true;
  }
  return false;
}

function simulateTap(key, modifiers) {
  const ztools = getZtools();
  if (!ztools || typeof ztools.simulateKeyboardTap !== "function") return false;
  state.lastSimulatedTap.set(String(key).toLowerCase(), Date.now());
  markInjectedForTapKey(key);
  try {
    ztools.simulateKeyboardTap(key, ...(modifiers || []));
    return true;
  } catch (error) {
    state.lastError = error;
    return false;
  }
}

function tapSettingKey(settingKey) {
  const tapKey = resolveTapKey(settingKey);
  if (!tapKey) return false;
  setTimeout(() => {
    simulateTap(tapKey, []);
  }, 0);
  return true;
}

function clearLongPressTimer() {
  if (state.longPressTimer) {
    clearTimeout(state.longPressTimer);
    state.longPressTimer = null;
  }
}

function resetHoldState() {
  clearLongPressTimer();
  state.capsDown = false;
  state.longPressActive = false;
  state.longPressModifier = null;
  state.forwardedKeys.clear();
  state.lastSimulatedAt.clear();
  state.lastSimulatedTap.clear();
  if (state.pendingTapTimer) {
    clearTimeout(state.pendingTapTimer);
    state.pendingTapTimer = null;
  }
  state.pendingTapAt = 0;
  state.pendingTapArmed = false;
  state.doubleTapCandidate = false;
  state.injectedKeys.clear();
}

function triggerLongPress() {
  if (state.longPressActive) return;
  state.longPressActive = true;
  clearLongPressTimer();
  if (state.pendingTapTimer) {
    clearTimeout(state.pendingTapTimer);
    state.pendingTapTimer = null;
  }
  state.pendingTapAt = 0;
  state.pendingTapArmed = false;
  state.doubleTapCandidate = false;
  state.longPressModifier = resolveModifierKey(state.settings.longKey);

  if (!state.longPressModifier) {
    tapSettingKey(state.settings.longKey);
  }
}

function handleCapsDown() {
  if (state.capsDown) return;
  state.capsDown = true;
  state.longPressActive = false;
  state.longPressModifier = null;
  const now = Date.now();
  if (state.pendingTapArmed && now - state.pendingTapAt <= state.settings.doubleTapMs) {
    state.doubleTapCandidate = true;
    if (state.pendingTapTimer) {
      clearTimeout(state.pendingTapTimer);
      state.pendingTapTimer = null;
    }
    state.pendingTapArmed = false;
    state.pendingTapAt = 0;
  } else {
    state.doubleTapCandidate = false;
  }
  clearLongPressTimer();
  state.longPressTimer = setTimeout(() => {
    if (state.capsDown && !state.longPressActive) {
      triggerLongPress();
    }
  }, state.settings.thresholdMs);
}

function handleCapsUp() {
  if (!state.capsDown) return;
  clearLongPressTimer();
  const wasLongPress = state.longPressActive;
  state.capsDown = false;
  state.longPressActive = false;
  state.longPressModifier = null;
  state.forwardedKeys.clear();
  state.lastSimulatedAt.clear();

  if (!wasLongPress) {
    if (state.doubleTapCandidate) {
      state.doubleTapCandidate = false;
      tapSettingKey(state.settings.doubleKey);
    } else {
      state.pendingTapArmed = true;
      state.pendingTapAt = Date.now();
      state.pendingTapTimer = setTimeout(() => {
        state.pendingTapArmed = false;
        state.pendingTapAt = 0;
        state.pendingTapTimer = null;
        tapSettingKey(state.settings.shortKey);
      }, state.settings.doubleTapMs);
    }
  }
}

function handleKeyEvent(event, downMap) {
  if (!state.settings.enabled) return false;
  const rawName = getEventName(event);
  const nameUpper = normalizeEventName(rawName);
  const keyId = getEventKeyId(event);

  if (isCapsEvent(event)) {
    if (event.state === "DOWN") handleCapsDown();
    if (event.state === "UP") handleCapsUp();
    return state.settings.consumeCapsLock ? STOP_EVENT : false;
  }

  if (isInjectedEvent(event)) return false;

  if (
    state.capsDown &&
    !state.longPressActive &&
    state.settings.triggerLongOnOtherKey &&
    event.state === "DOWN" &&
    (rawName || Number.isFinite(event?.vKey))
  ) {
    triggerLongPress();
  }

  if (state.longPressActive && state.longPressModifier) {
    if (event.state === "UP" && state.forwardedKeys.has(keyId)) {
      state.forwardedKeys.delete(keyId);
      return STOP_EVENT;
    }

    if (event.state === "DOWN") {
      if (state.forwardedKeys.has(keyId)) return STOP_EVENT;
      const tapKey = mapEventToTapKey(event);
      if (tapKey) {
        const lastSimulatedAt = state.lastSimulatedAt.get(keyId) || 0;
        if (Date.now() - lastSimulatedAt < SIMULATE_DEBOUNCE_MS) {
          return STOP_EVENT;
        }
        const modifiers = new Set([state.longPressModifier]);
        collectModifiers(downMap).forEach((mod) => modifiers.add(mod));
        setTimeout(() => {
          simulateTap(tapKey, Array.from(modifiers));
        }, 0);
        state.forwardedKeys.add(keyId);
        state.lastSimulatedAt.set(keyId, Date.now());
        return STOP_EVENT;
      }
    }
  }

  return false;
}

function ensureListener() {
  if (!state.listener) {
    state.listener = new GlobalKeyboardListener();
  }
}

function loadStoredSettings() {
  const ztools = getZtools();
  if (ztools && ztools.dbStorage) {
    const saved = ztools.dbStorage.getItem(SETTINGS_KEY);
    return normalizeSettings(saved);
  }
  return { ...DEFAULT_SETTINGS };
}

function saveStoredSettings(settings) {
  const ztools = getZtools();
  if (ztools && ztools.dbStorage) {
    ztools.dbStorage.setItem(SETTINGS_KEY, settings);
  }
}

function ensureInitialized() {
  if (state.initialized) return;
  state.settings = loadStoredSettings();
  state.initialized = true;
  if (state.settings.enabled) {
    start();
  }
}

async function start() {
  if (state.running) return getStatus();
  state.lastError = null;
  ensureListener();
  if (!state.handler) state.handler = handleKeyEvent;
  try {
    await state.listener.addListener(state.handler);
    state.running = true;
  } catch (error) {
    state.lastError = error;
    state.running = false;
  }
  return getStatus();
}

function stop() {
  if (state.listener && state.handler) {
    state.listener.removeListener(state.handler);
  }
  state.running = false;
  state.handler = null;
  resetHoldState();
  return getStatus();
}

async function applySettings(input) {
  state.settings = normalizeSettings(input);
  saveStoredSettings(state.settings);
  if (state.settings.enabled) {
    return start();
  }
  return stop();
}

function getStatus() {
  return {
    running: state.running,
    settings: { ...state.settings },
    lastError: state.lastError ? String(state.lastError) : null,
  };
}

function getDefaults() {
  return { ...DEFAULT_SETTINGS };
}

function setupLifecycle() {
  const ztools = getZtools();
  if (!ztools) return;
  if (typeof ztools.onPluginEnter === "function") {
    ztools.onPluginEnter(() => {
      ensureInitialized();
      if (state.settings.enabled) start();
    });
  }
  if (typeof ztools.onPluginOut === "function") {
    ztools.onPluginOut((processExit) => {
      if (processExit) stop();
    });
  }
}

function setupMessaging() {
  if (!ipcRenderer || typeof ipcRenderer.on !== "function") return;
  ipcRenderer.on("capswitch:apply", (_event, settings) => {
    applySettings(settings);
  });
}

function openSettingsWindow() {
  const ztools = getZtools();
  if (!ztools || typeof ztools.createBrowserWindow !== "function") return null;

  if (state.settingsWindow) {
    try {
      if (typeof state.settingsWindow.isDestroyed === "function") {
        if (!state.settingsWindow.isDestroyed()) {
          if (typeof state.settingsWindow.show === "function") {
            state.settingsWindow.show();
          }
          if (typeof state.settingsWindow.focus === "function") {
            state.settingsWindow.focus();
          }
          return state.settingsWindow;
        }
      }
    } catch (error) {
      state.settingsWindow = null;
    }
  }

  const win = ztools.createBrowserWindow("index.html", {
    width: 920,
    height: 680,
    minWidth: 720,
    minHeight: 520,
    resizable: true,
    minimizable: true,
    maximizable: true,
    backgroundColor: "#f6f1e7",
    title: "CapSwitch",
  });

  state.settingsWindow = win || null;

  if (win && typeof win.on === "function") {
    win.on("closed", () => {
      state.settingsWindow = null;
    });
  }

  return win;
}

function setupHeadlessExports() {
  window.exports = {
    capswitch: {
      mode: "none",
      args: {
        enter: async () => {
          ensureInitialized();
          if (state.settings.enabled) {
            await start();
          }
          openSettingsWindow();

          const ztools = getZtools();
          if (ztools && typeof ztools.outPlugin === "function") {
            ztools.outPlugin();
          }

          return getStatus();
        },
      },
    },
  };
}

window.capsSwitch = {
  applySettings,
  start,
  stop,
  getStatus,
  getDefaults,
};

setupLifecycle();
setupMessaging();
setupHeadlessExports();
ensureInitialized();
