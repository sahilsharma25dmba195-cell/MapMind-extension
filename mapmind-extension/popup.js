const STORAGE_KEY = "openai_api_key";
const PROVIDER_STORAGE_KEY = "ai_provider";
const REQUEST_LOCKS_KEY = "mapmind_request_locks";
const PENDING_IMPORT_KEY = "mapmind_pending_import";
const REQUEST_LOCK_TTL_MS = 90000;
const VERSION = "1.0.0";
const REQUEST_ACTION = "mapmind:extract-page-content";
const RESPONSE_ACTION = "mapmind:page-content";
const IMPORT_BASE_URL = "https://mapmind.online/?import=true";

const PROVIDERS = {
  openai: {
    label: "OpenAI",
    placeholder: "sk-...",
    setupLabel: "Enter your OpenAI API key",
    settingsLabel: "OpenAI API key",
    helperText: "Get your key at platform.openai.com - requires credits",
    linkLabel: "Get your API key at platform.openai.com",
    linkUrl: "https://platform.openai.com/api-keys",
    dashboardUrl: "https://platform.openai.com/settings/organization/billing/overview",
    validate: (apiKey) => apiKey.startsWith("sk-")
  },
  groq: {
    label: "Groq",
    placeholder: "gsk_...",
    setupLabel: "Enter your Groq API key",
    settingsLabel: "Groq API key",
    helperText: "Get your free key at console.groq.com - no payment needed",
    linkLabel: "Get your API key at console.groq.com",
    linkUrl: "https://console.groq.com/keys",
    dashboardUrl: "https://console.groq.com/keys",
    validate: (apiKey) => apiKey.startsWith("gsk_")
  },
  perplexity: {
    label: "Perplexity",
    placeholder: "pplx-...",
    setupLabel: "Enter your Perplexity API key",
    settingsLabel: "Perplexity API key",
    helperText: "Get your key at perplexity.ai/settings/api - requires credits",
    linkLabel: "Get your API key at perplexity.ai/settings/api",
    linkUrl: "https://perplexity.ai/settings/api",
    dashboardUrl: "https://perplexity.ai/settings/api",
    validate: (apiKey) => apiKey.startsWith("pplx-")
  },
  gemini: {
    label: "Google Gemini",
    placeholder: "AIza...",
    setupLabel: "Enter your Google Gemini API key",
    settingsLabel: "Google Gemini API key",
    helperText: "Get your free key at aistudio.google.com - no payment needed",
    linkLabel: "Get your API key at aistudio.google.com",
    linkUrl: "https://aistudio.google.com/app/apikey",
    dashboardUrl: "https://aistudio.google.com/app/apikey",
    validate: (apiKey) => apiKey.startsWith("AIza")
  }
};

const inFlightRequests = new Map();
const state = {
  instanceId: `popup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  apiKey: "",
  provider: "openai",
  activeTabId: null,
  currentPageTitle: "Current page",
  currentPageText: "",
  currentPageMetadata: createEmptyPageMetadata(),
  lastImportUrl: "",
  lastImportTabId: null,
  loadingTimerId: null,
  lastNonSettingsState: "ready",
  errorAction: null,
  errorRetryLabel: "Try again",
  showRetryAction: true
};

const elements = {};

document.addEventListener("DOMContentLoaded", initializePopup);

function createEmptyPageMetadata() {
  return {
    sourceSelector: "",
    charCount: 0,
    wasTruncated: false
  };
}

async function initializePopup() {
  cacheElements();
  bindEvents();
  elements.versionText.textContent = `Extension version ${VERSION}`;
  setRequestButtonsBusy(false);

  try {
    const result = await storageGet([STORAGE_KEY, PROVIDER_STORAGE_KEY]);
    state.apiKey = String(result[STORAGE_KEY] || "").trim();
    state.provider = getProviderKey(result[PROVIDER_STORAGE_KEY]);
    syncProviderInputs();
    syncApiInputs();
    updateProviderUI();

    if (!state.apiKey) {
      showState("setup");
      return;
    }

    await initializeReadyView();
  } catch (error) {
    showErrorState(error || "Failed to load extension settings");
  }
}

function cacheElements() {
  elements.setupState = document.getElementById("setupState");
  elements.readyState = document.getElementById("readyState");
  elements.loadingState = document.getElementById("loadingState");
  elements.successState = document.getElementById("successState");
  elements.errorState = document.getElementById("errorState");
  elements.settingsState = document.getElementById("settingsState");
  elements.settingsToggle = document.getElementById("settingsToggle");
  elements.setupProvider = document.getElementById("setupProvider");
  elements.settingsProvider = document.getElementById("settingsProvider");
  elements.setupProviderHelper = document.getElementById("setupProviderHelper");
  elements.settingsProviderHelper = document.getElementById("settingsProviderHelper");
  elements.setupProviderLink = document.getElementById("setupProviderLink");
  elements.setupApiKey = document.getElementById("setupApiKey");
  elements.settingsApiKey = document.getElementById("settingsApiKey");
  elements.setupApiKeyLabel = document.getElementById("setupApiKeyLabel");
  elements.settingsApiKeyLabel = document.getElementById("settingsApiKeyLabel");
  elements.setupSaveButton = document.getElementById("setupSaveButton");
  elements.settingsSaveButton = document.getElementById("settingsSaveButton");
  elements.settingsBackButton = document.getElementById("settingsBackButton");
  elements.pageTitle = document.getElementById("pageTitle");
  elements.extractButton = document.getElementById("extractButton");
  elements.loadingTitle = document.getElementById("loadingTitle");
  elements.successSubtext = document.getElementById("successSubtext");
  elements.errorMessage = document.getElementById("errorMessage");
  elements.retryButton = document.getElementById("retryButton");
  elements.errorActionButton = document.getElementById("errorActionButton");
  elements.openImportButton = document.getElementById("openImportButton");
  elements.extractAnotherButton = document.getElementById("extractAnotherButton");
  elements.versionText = document.querySelector(".version-text");
}

function bindEvents() {
  elements.setupSaveButton.addEventListener("click", handleInitialKeySave);
  elements.settingsSaveButton.addEventListener("click", handleSettingsKeySave);
  elements.settingsBackButton.addEventListener("click", () => showState(state.lastNonSettingsState || "ready"));
  elements.extractButton.addEventListener("click", handleExtractAndImport);
  elements.retryButton.addEventListener("click", handleExtractAndImport);
  elements.errorActionButton.addEventListener("click", handleErrorAction);
  elements.settingsToggle.addEventListener("click", openSettings);
  elements.openImportButton.addEventListener("click", focusImportTab);
  elements.setupProvider.addEventListener("change", handleProviderSelectionChange);
  elements.settingsProvider.addEventListener("change", handleProviderSelectionChange);
  elements.extractAnotherButton.addEventListener("click", async () => {
    try {
      await initializeReadyView();
    } catch (error) {
      showErrorState(error || "Unable to refresh this page");
    }
  });
  elements.setupApiKey.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      handleInitialKeySave();
    }
  });
  elements.settingsApiKey.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      handleSettingsKeySave();
    }
  });
}

async function initializeReadyView() {
  clearLoadingTimer();
  state.lastImportUrl = "";
  state.lastImportTabId = null;
  state.currentPageText = "";
  state.currentPageMetadata = createEmptyPageMetadata();

  const activeTab = await queryActiveTab();
  state.activeTabId = activeTab.id;
  state.currentPageTitle = truncateText(activeTab.title || "Current page", 60);
  elements.pageTitle.textContent = state.currentPageTitle;
  showState("ready");

  try {
    const pageData = await requestPageContent(state.activeTabId);
    applyPageData(pageData, activeTab.title || "Current page");
  } catch (error) {
    if (!isNonBlockingExtractionError(error)) {
      throw error;
    }
  }
}

function applyPageData(pageData, fallbackTitle) {
  state.currentPageTitle = truncateText(pageData.title || fallbackTitle || "Current page", 60);
  state.currentPageText = pageData.text;
  state.currentPageMetadata = {
    sourceSelector: String(pageData.sourceSelector || "").trim(),
    charCount: Number(pageData.charCount) || 0,
    wasTruncated: Boolean(pageData.wasTruncated)
  };
  elements.pageTitle.textContent = state.currentPageTitle;
}

function isNonBlockingExtractionError(error) {
  const normalizedError = normalizeError(error);
  return normalizedError.code === "low_quality_content" || normalizedError.code === "unsupported_page";
}

async function handleInitialKeySave() {
  try {
    const apiKey = elements.setupApiKey.value.trim();
    const provider = getProviderKey(elements.setupProvider.value);
    if (!isValidApiKey(apiKey, provider)) {
      showErrorState({
        code: "invalid_api_key",
        message: getInvalidKeyMessage(provider)
      });
      return;
    }

    await saveSettings(apiKey, provider);
    await initializeReadyView();
  } catch (error) {
    showErrorState(error || "Failed to save your API key");
  }
}

async function handleSettingsKeySave() {
  try {
    const apiKey = elements.settingsApiKey.value.trim();
    const provider = getProviderKey(elements.settingsProvider.value);
    if (!isValidApiKey(apiKey, provider)) {
      showErrorState({
        code: "invalid_api_key",
        message: getInvalidKeyMessage(provider)
      });
      return;
    }

    await saveSettings(apiKey, provider);
    await initializeReadyView();
  } catch (error) {
    showErrorState(error || "Failed to update your API key");
  }
}

async function handleExtractAndImport() {
  const tabId = state.activeTabId;

  if (!state.apiKey) {
    showState("setup");
    return;
  }

  if (typeof tabId !== "number") {
    showErrorState("No active tab found");
    return;
  }

  if (inFlightRequests.has(tabId)) {
    showErrorState({ code: "request_in_progress" });
    return;
  }

  let requestLock = null;
  inFlightRequests.set(tabId, "pending");
  setRequestButtonsBusy(true);

  try {
    requestLock = await acquireRequestLock(tabId);
    if (!requestLock) {
      showErrorState({ code: "request_in_progress" });
      return;
    }

    inFlightRequests.set(tabId, requestLock.token);
    showLoadingState();

    const pageData = await requestPageContent(tabId);
    applyPageData(pageData, state.currentPageTitle);

    if (!state.currentPageText) {
      throw {
        code: "low_quality_content",
        message: "This page does not contain enough readable article text to extract notes."
      };
    }

    const response = await runtimeSendMessage({
      action: "convertToNotes",
      text: state.currentPageText,
      apiKey: state.apiKey,
      provider: state.provider,
      pageMetadata: state.currentPageMetadata
    });

    if (!response?.success) {
      showErrorState(response?.error || "Failed to convert article");
      return;
    }

    const notes = Array.isArray(response.notes) ? response.notes : [];
    const importPayload = JSON.stringify(notes);

    await storageSet({
      [PENDING_IMPORT_KEY]: importPayload
    });

    await runtimeSendMessage({ action: "openMapMindImport" });

    state.lastImportUrl = IMPORT_BASE_URL;
    state.lastImportTabId = null;
    showSuccessState(notes.length);
  } catch (error) {
    showErrorState(error || "Something went wrong");
  } finally {
    inFlightRequests.delete(tabId);
    setRequestButtonsBusy(false);
    await releaseRequestLock(requestLock);
  }
}

async function handleErrorAction() {
  if (!state.errorAction) {
    return;
  }

  if (state.errorAction.type === "settings") {
    openSettings();
    return;
  }

  if (state.errorAction.type === "external" && state.errorAction.url) {
    try {
      await createTab(state.errorAction.url, true);
    } catch (error) {
      showErrorState(error || "Unable to open the requested page");
    }
  }
}

async function focusImportTab() {
  if (state.lastImportTabId) {
    try {
      await updateTab(state.lastImportTabId, { active: true });
      window.close();
      return;
    } catch (error) {
      state.lastImportTabId = null;
    }
  }

  if (state.lastImportUrl) {
    try {
      await createTab(state.lastImportUrl, true);
      window.close();
    } catch (error) {
      showErrorState(error || "Unable to open the MapMind import page");
    }
  }
}

async function saveSettings(apiKey, provider) {
  await storageSet({
    [STORAGE_KEY]: apiKey,
    [PROVIDER_STORAGE_KEY]: provider
  });
  state.apiKey = apiKey;
  state.provider = provider;
  syncApiInputs();
  syncProviderInputs();
  updateProviderUI();
}

function syncApiInputs() {
  elements.setupApiKey.value = state.apiKey;
  elements.settingsApiKey.value = state.apiKey;
}

function syncProviderInputs() {
  elements.setupProvider.value = state.provider;
  elements.settingsProvider.value = state.provider;
}

function updateProviderUI() {
  const provider = getProviderConfig(state.provider);
  elements.setupApiKey.placeholder = provider.placeholder;
  elements.settingsApiKey.placeholder = provider.placeholder;
  elements.setupApiKeyLabel.textContent = provider.setupLabel;
  elements.settingsApiKeyLabel.textContent = provider.settingsLabel;
  elements.setupProviderHelper.textContent = provider.helperText;
  elements.settingsProviderHelper.textContent = provider.helperText;
  elements.setupProviderLink.href = provider.linkUrl;
  elements.setupProviderLink.textContent = provider.linkLabel;
}

function handleProviderSelectionChange(event) {
  state.provider = getProviderKey(event.target.value);
  syncProviderInputs();
  updateProviderUI();
}

function openSettings() {
  state.lastNonSettingsState = getVisibleStateName();
  syncProviderInputs();
  syncApiInputs();
  updateProviderUI();
  showState("settings");
  elements.settingsApiKey.focus();
  elements.settingsApiKey.select();
}

function showLoadingState() {
  showState("loading");
  elements.loadingTitle.textContent = "Extracting article...";
  clearLoadingTimer();
  state.loadingTimerId = window.setTimeout(() => {
    if (getVisibleStateName() === "loading") {
      elements.loadingTitle.textContent = "Converting to notes...";
    }
  }, 2000);
}

function showSuccessState(noteCount) {
  const label = noteCount === 1 ? "note" : "notes";
  clearLoadingTimer();
  state.errorAction = null;
  state.errorRetryLabel = "Try again";
  state.showRetryAction = true;
  elements.successSubtext.textContent = `${noteCount} ${label} extracted from this article`;
  showState("success");
}

function showErrorState(errorInput) {
  clearLoadingTimer();
  const error = normalizeError(errorInput);
  const presentation = getErrorPresentation(error);
  state.errorAction = presentation.action;
  state.errorRetryLabel = presentation.retryLabel;
  state.showRetryAction = presentation.showRetryAction;
  elements.errorMessage.textContent = presentation.message;
  renderErrorStateControls();
  showState("error");
}

function showState(stateName) {
  const mapping = {
    setup: elements.setupState,
    ready: elements.readyState,
    loading: elements.loadingState,
    success: elements.successState,
    error: elements.errorState,
    settings: elements.settingsState
  };

  Object.values(mapping).forEach((element) => element.classList.add("hidden"));
  mapping[stateName].classList.remove("hidden");

  const showSettingsToggle = stateName === "ready";
  elements.settingsToggle.classList.toggle("hidden", !showSettingsToggle);

  if (stateName !== "settings") {
    state.lastNonSettingsState = stateName;
  }
}

function getVisibleStateName() {
  const states = [
    ["setup", elements.setupState],
    ["ready", elements.readyState],
    ["loading", elements.loadingState],
    ["success", elements.successState],
    ["error", elements.errorState],
    ["settings", elements.settingsState]
  ];

  for (const [name, element] of states) {
    if (!element.classList.contains("hidden")) {
      return name;
    }
  }

  return "ready";
}

function clearLoadingTimer() {
  if (state.loadingTimerId) {
    window.clearTimeout(state.loadingTimerId);
    state.loadingTimerId = null;
  }
}

function renderErrorStateControls() {
  elements.retryButton.textContent = state.errorRetryLabel;
  elements.retryButton.classList.toggle("hidden", !state.showRetryAction);

  if (!state.errorAction) {
    elements.errorActionButton.classList.add("hidden");
    elements.errorActionButton.textContent = "";
    return;
  }

  elements.errorActionButton.textContent = state.errorAction.label;
  elements.errorActionButton.classList.remove("hidden");
}

function setRequestButtonsBusy(isBusy) {
  elements.extractButton.disabled = isBusy;
  elements.retryButton.disabled = isBusy;
  elements.extractAnotherButton.disabled = isBusy;
}

function normalizeError(errorInput) {
  if (errorInput && typeof errorInput === "object" && !Array.isArray(errorInput)) {
    const code = String(errorInput.code || "generic_error");
    const message =
      typeof errorInput.message === "string" && errorInput.message.trim()
        ? errorInput.message.trim()
        : "Something went wrong";
    return { code, message };
  }

  return {
    code: "generic_error",
    message: String(errorInput || "Something went wrong")
  };
}

function getErrorPresentation(error) {
  const provider = getProviderConfig(state.provider);

  switch (error.code) {
    case "invalid_api_key":
      return {
        message: `Invalid ${provider.label} API key - please check your key in settings`,
        showRetryAction: false,
        retryLabel: "Try again",
        action: {
          type: "settings",
          label: "Check your API key"
        }
      };
    case "insufficient_quota":
      return {
        message: `${provider.label} quota reached - add credits or wait for quota to reset, then try again`,
        showRetryAction: false,
        retryLabel: "Try again",
        action: {
          type: "external",
          label: `Open ${provider.label} dashboard`,
          url: provider.dashboardUrl
        }
      };
    case "rate_limited":
      return {
        message: `${provider.label} rate limit reached - please wait a moment and try again`,
        showRetryAction: true,
        retryLabel: "Try again",
        action: null
      };
    case "server_error":
      return {
        message: `${provider.label} server error - please try again in a few seconds`,
        showRetryAction: true,
        retryLabel: "Try again",
        action: null
      };
    case "invalid_json":
      return {
        message: "The AI response was not valid JSON - please try again",
        showRetryAction: true,
        retryLabel: "Try again",
        action: null
      };
    case "invalid_note_schema":
      return {
        message: "The AI returned notes in the wrong format. Try again to regenerate them.",
        showRetryAction: true,
        retryLabel: "Try again",
        action: null
      };
    case "low_quality_content":
      return {
        message: "This page does not contain enough readable article text to extract notes.",
        showRetryAction: true,
        retryLabel: "Try again",
        action: null
      };
    case "unsupported_page":
      return {
        message: "This page looks more like navigation, search results, or short snippets than a readable article.",
        showRetryAction: true,
        retryLabel: "Try another page",
        action: null
      };
    case "request_timeout":
      return {
        message: `${provider.label} took too long to respond - please try again`,
        showRetryAction: true,
        retryLabel: "Try again",
        action: null
      };
    case "request_in_progress":
      return {
        message: "An import is already running for this tab. Wait for it to finish, then try again.",
        showRetryAction: false,
        retryLabel: "Try again",
        action: null
      };
    default:
      return {
        message: error.message || "Something went wrong",
        showRetryAction: true,
        retryLabel: "Try again",
        action: null
      };
  }
}

function isValidApiKey(apiKey, provider) {
  return getProviderConfig(provider).validate(apiKey);
}

function getProviderKey(value) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, value) ? value : "openai";
}

function getProviderConfig(provider) {
  return PROVIDERS[getProviderKey(provider)];
}

function getInvalidKeyMessage(provider) {
  const providerConfig = getProviderConfig(provider);
  const prefix = providerConfig.placeholder.replace("...", "");
  return `Please enter a valid ${providerConfig.label} API key starting with ${prefix}`;
}

function truncateText(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1).trimEnd()}...`;
}

async function requestPageContent(tabId) {
  if (!tabId) {
    throw new Error("No active tab found");
  }

  try {
    await executeScript(tabId);
  } catch (error) {
    throw new Error("This page cannot be accessed by the extension. Open a regular webpage and try again.");
  }

  const requestId = `mapmind-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("Timed out while extracting article content from this page"));
    }, 5000);

    function cleanup() {
      window.clearTimeout(timeoutId);
      chrome.runtime.onMessage.removeListener(onMessage);
    }

    function onMessage(message, sender) {
      if (!message || message.action !== RESPONSE_ACTION || message.requestId !== requestId) {
        return;
      }

      if (sender?.tab?.id !== tabId) {
        return;
      }

      cleanup();

      if (message.error) {
        reject(message.error);
        return;
      }

      resolve({
        title: String(message.payload?.title || "").trim(),
        text: String(message.payload?.text || "").trim(),
        sourceSelector: String(message.payload?.sourceSelector || "").trim(),
        charCount: Number(message.payload?.charCount) || 0,
        wasTruncated: Boolean(message.payload?.wasTruncated)
      });
    }

    chrome.runtime.onMessage.addListener(onMessage);
    chrome.tabs.sendMessage(tabId, { action: REQUEST_ACTION, requestId }, () => {
      const runtimeError = chrome.runtime.lastError;
      if (!runtimeError) {
        return;
      }

      cleanup();
      reject(new Error("Unable to read this page. Refresh the tab and try again."));
    });
  });
}

async function acquireRequestLock(tabId) {
  const locks = await readRequestLocks();
  const currentLock = locks[String(tabId)];

  if (currentLock) {
    return null;
  }

  const lock = {
    token: `${state.instanceId}-${tabId}-${Date.now()}`,
    createdAt: Date.now()
  };

  const nextLocks = {
    ...locks,
    [String(tabId)]: lock
  };

  await storageSet({ [REQUEST_LOCKS_KEY]: nextLocks });

  const confirmedLocks = await readRequestLocks();
  return confirmedLocks[String(tabId)]?.token === lock.token
    ? { tabId, token: lock.token }
    : null;
}

async function releaseRequestLock(lock) {
  if (!lock) {
    return;
  }

  const locks = await readRequestLocks();
  if (locks[String(lock.tabId)]?.token !== lock.token) {
    return;
  }

  delete locks[String(lock.tabId)];
  await storageSet({ [REQUEST_LOCKS_KEY]: locks });
}

async function readRequestLocks() {
  const result = await storageGet([REQUEST_LOCKS_KEY]);
  const rawLocks =
    result[REQUEST_LOCKS_KEY] && typeof result[REQUEST_LOCKS_KEY] === "object"
      ? result[REQUEST_LOCKS_KEY]
      : {};
  const now = Date.now();
  const activeLocks = {};

  Object.entries(rawLocks).forEach(([tabId, lockValue]) => {
    const createdAt = Number(lockValue?.createdAt);
    if (Number.isFinite(createdAt) && now - createdAt < REQUEST_LOCK_TTL_MS) {
      activeLocks[tabId] = lockValue;
    }
  });

  return activeLocks;
}

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve(result);
    });
  });
}

function storageSet(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve();
    });
  });
}

function queryActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      const activeTab = tabs[0];
      if (!activeTab || typeof activeTab.id !== "number") {
        reject(new Error("No active tab found"));
        return;
      }

      resolve(activeTab);
    });
  });
}

function executeScript(tabId) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        files: ["vendor/Readability.js", "content.js"]
      },
      () => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }

        resolve();
      }
    );
  });
}

function runtimeSendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve(response);
    });
  });
}

function createTab(url, active) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url, active }, (tab) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve(tab);
    });
  });
}

function updateTab(tabId, updateProperties) {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, updateProperties, (tab) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve(tab);
    });
  });
}
