const REQUEST_TIMEOUT_MS = 30000;
const RETRY_DELAYS_MS = [800, 1600];
const PENDING_IMPORT_KEY = "mapmind_pending_import";
const MAPMIND_IMPORT_URL = "https://mapmind.online/?import=true";
const VALID_REGIONS = [
  "Global",
  "North America",
  "South America",
  "Rest of Europe",
  "Asia",
  "Africa",
  "Middle East",
  "Russia",
  "United Kingdom",
  "Australia Oceania",
  "European Union"
];
const REGION_ALIASES = {
  "australia & oceania": "Australia Oceania",
  "australia and oceania": "Australia Oceania"
};
const PROVIDERS = {
  openai: {
    label: "OpenAI",
    mode: "chat",
    url: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o",
    validate: (apiKey) => apiKey.startsWith("sk-")
  },
  groq: {
    label: "Groq",
    mode: "chat",
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: "llama-3.3-70b-versatile",
    validate: (apiKey) => apiKey.startsWith("gsk_")
  },
  perplexity: {
    label: "Perplexity",
    mode: "chat",
    url: "https://api.perplexity.ai/chat/completions",
    model: "llama-3.1-sonar-large-128k-online",
    validate: (apiKey) => apiKey.startsWith("pplx-")
  },
  gemini: {
    label: "Google Gemini",
    mode: "gemini",
    url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent",
    validate: (apiKey) => apiKey.startsWith("AIza")
  }
};
const SYSTEM_PROMPT = `You are an avid reader who goes through the pasted text or the link provided and you act as You are a geographic knowledge assistant helping organize information into a structured note-taking app called MapMind.

The user will give you article/newsletter text extracted from a webpage. Your job is to:
PROCESS:
1. Extract ALL distinct stories/topics (max 15).
2. Per note: Title (<=10 words, factual). Content (50-60% depth: 5-8+ sentences/2-3 paras; facts/context/implications; plain text).
3. Geo-tag per rules below.
4. Tags: 2-4 lowercase (geopolitics, economy, finance, markets, war, politics, trade, energy, technology, science, health, environment, diplomacy, military, sanctions, elections, inflation, investing, stock-market, crypto, space, food, corporate, earnings, demographics, gen-z). Reuse; minimal/new if needed.

SCHEMA (EXACT-one per note):
[
  {
    "title": "India Inflation Surges",
    "content": "Detailed summary...",
    "region": "Asia",
    "country": "India",
    "tags": ["economy", "inflation"]
  },
  {
    "title": "US-China Trade Escalation",
    "content": "Detailed...",
    "region": "Global",
    "countries": ["United States", "China"],
    "tags": ["trade", "geopolitics"]
  },
  {
    "title": "Gen Z Global Spending Trends",
    "content": "Detailed...",
    "region": "Global",
    "tags": ["demographics", "gen-z"]
  }
]

RULES (DECISION TREE-no exceptions):
- 1 country central: region = its region (Asia/etc.), "country": "India".
- 2-3 countries interacting (trade/war/deal): region = "Global", "countries": ["US", "China"] (key players only).
- 4+ countries/global abstract (Gen Z, pandemics, markets): region = "Global", OMIT country/countries.
- Region/policy only (EU summit): region = "European Union", OMIT country/countries.
- Multi-region: Global + countries if specific.
- NEVER "country" + "countries"; NEVER force countries on abstracts.
- Region: EXACT-Global, North America, South America, Europe, European Union, Africa, Middle East, Asia, Russia, United Kingdom, Australia Oceania. Single best-fit.

OUTPUT: ONLY valid JSON array. No intro/text/markdown. [ ... ]

Max 15 notes.`;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) {
    return;
  }

  if (message.action === "convertToNotes") {
    convertToNotes(message)
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({
          success: false,
          error: normalizeCaughtError(error, "Failed to convert article")
        })
      );

    return true;
  }

  if (message.action === "openMapMindImport") {
    console.log("openMapMindImport received, creating tab...");
    chrome.tabs.create({ url: MAPMIND_IMPORT_URL, active: true }, (tab) => {
      const createError = chrome.runtime.lastError;
      if (createError) {
        console.error("MapMind tab open failed:", createError.message);
        return;
      }

      const tabId = tab?.id;
      if (typeof tabId !== "number") {
        console.error("MapMind tab open failed: missing tab id");
        return;
      }
      console.log("Tab created, tabId:", tabId);

      const injectPendingImport = () => {
        console.log("Tab complete, reading from storage...");
        chrome.storage.local.get(PENDING_IMPORT_KEY, (result) => {
          const getError = chrome.runtime.lastError;
          if (getError) {
            console.error("Pending import read failed:", getError.message);
            return;
          }

          console.log("Storage data found:", !!result[PENDING_IMPORT_KEY]);
          if (!result[PENDING_IMPORT_KEY]) {
            return;
          }

          const data = result[PENDING_IMPORT_KEY];
          chrome.scripting.executeScript(
            {
              target: { tabId },
              func: (jsonData) => {
                sessionStorage.setItem("mapmind_pending_import", jsonData);
              },
              args: [data]
            },
            () => {
              const injectionError = chrome.runtime.lastError;
              if (injectionError) {
                console.log("Injection failed:", injectionError.message);
                console.error("Injection failed:", injectionError.message);
              } else {
                console.log("sessionStorage injection successful");
                chrome.storage.local.remove(PENDING_IMPORT_KEY, () => {
                  const removeError = chrome.runtime.lastError;
                  if (removeError) {
                    console.error("Pending import cleanup failed:", removeError.message);
                  }
                });
              }
            }
          );
        });
      };

      const listener = (updatedTabId, changeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          injectPendingImport();
        }
      };

      chrome.tabs.onUpdated.addListener(listener);

      if (tab.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        injectPendingImport();
      }
    });

    sendResponse({ ok: true });
    return true;
  }

  return;
});

async function convertToNotes(message) {
  const text = String(message.text || "").trim();
  const apiKey = String(message.apiKey || "").trim();
  const providerKey = getProviderKey(message.provider);
  const provider = PROVIDERS[providerKey];
  const metadata = normalizePageMetadata(message.pageMetadata);

  if (!provider.validate(apiKey)) {
    return {
      success: false,
      error: createError("invalid_api_key", `Invalid ${provider.label} API key - please check your key in settings`)
    };
  }

  if (!text) {
    return {
      success: false,
      error: createError("generic_error", "No readable article text was found on this page")
    };
  }

  return requestNotesWithRetry(text, apiKey, providerKey, metadata);
}

function normalizePageMetadata(value) {
  if (!value || typeof value !== "object") {
    return {
      charCount: 0,
      sourceSelector: "",
      wasTruncated: false
    };
  }

  return {
    charCount: Number(value.charCount) || 0,
    sourceSelector: String(value.sourceSelector || "").trim(),
    wasTruncated: Boolean(value.wasTruncated)
  };
}

function normalizeCaughtError(error, fallbackMessage) {
  if (error && typeof error === "object" && "code" in error) {
    return stripRetryMetadata(error);
  }

  if (error instanceof Error) {
    return createError("generic_error", error.message || fallbackMessage);
  }

  return createError("generic_error", String(error || fallbackMessage));
}

async function readJsonSafely(response) {
  try {
    return await response.json();
  } catch (error) {
    return null;
  }
}

function parseNotes(rawContent) {
  const cleanedContent = rawContent
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let parsed;

  try {
    parsed = JSON.parse(cleanedContent);
  } catch (error) {
    throw createError("invalid_json", "Response was not valid JSON - please try again");
  }

  if (!Array.isArray(parsed)) {
    throw createError("invalid_json", "Response was not valid JSON - please try again");
  }

  return parsed;
}

function validateAndNormalizeNotes(notesArray) {
  if (!Array.isArray(notesArray) || notesArray.length < 1 || notesArray.length > 50) {
    throw createError(
      "invalid_note_schema",
      "The AI returned notes in the wrong format - please try again"
    );
  }

  return notesArray.map((note) => {
    if (!note || typeof note !== "object" || Array.isArray(note)) {
      throw createError(
        "invalid_note_schema",
        "The AI returned notes in the wrong format - please try again"
      );
    }

    const title = normalizeRequiredString(note.title, "title", 3);
    const content = normalizeRequiredString(note.content ?? note.text ?? note.summary, "content", 20);
    const region = normalizeRegion(note.region);
    const hasCountry =
      typeof note.country === "string" && note.country.trim().length > 0;
    const hasCountries = Array.isArray(note.countries) && note.countries.length > 0;

    if (hasCountry && hasCountries) {
      throw createError(
        "invalid_note_schema",
        "The AI returned notes in the wrong format - please try again"
      );
    }

    if (!hasCountry && !hasCountries && region !== "Global" && region !== "European Union") {
      throw createError(
        "invalid_note_schema",
        "The AI returned notes in the wrong format - please try again"
      );
    }

    const normalizedNote = {
      title,
      content,
      region,
      tags: normalizeTags(note.tags)
    };

    if (hasCountry) {
      normalizedNote.country = normalizeRequiredString(note.country, "country", 2);
    }

    if (hasCountries) {
      const countries = note.countries
        .map((country) => normalizeRequiredString(country, "countries", 2))
        .filter(Boolean);

      if (countries.length === 0) {
        throw createError(
          "invalid_note_schema",
          "The AI returned notes in the wrong format - please try again"
        );
      }

      const uniqueCountries = Array.from(new Set(countries));

      if (uniqueCountries.length === 1 && !normalizedNote.country) {
        normalizedNote.country = uniqueCountries[0];
      } else if (uniqueCountries.length > 1) {
        normalizedNote.countries = uniqueCountries;
      }
    }

    return normalizedNote;
  });
}

function normalizeRequiredString(value, fieldName, minLength) {
  if (typeof value !== "string") {
    throw createError(
      "invalid_note_schema",
      `The AI returned an invalid ${fieldName} field - please try again`
    );
  }

  const normalizedValue = value.replace(/\s+/g, " ").trim();

  if (normalizedValue.length < minLength) {
    throw createError(
      "invalid_note_schema",
      `The AI returned an invalid ${fieldName} field - please try again`
    );
  }

  return normalizedValue;
}

function normalizeRegion(value) {
  const normalizedValue = normalizeRequiredString(value, "region", 2);
  const aliasValue = REGION_ALIASES[normalizedValue.toLowerCase()] || normalizedValue;

  if (!VALID_REGIONS.includes(aliasValue)) {
    throw createError(
      "invalid_note_schema",
      "The AI returned an unsupported region - please try again"
    );
  }

  return aliasValue;
}

function normalizeTags(value) {
  const rawTags = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];

  const normalizedTags = rawTags
    .map((tag) => String(tag || "").trim().toLowerCase())
    .filter(Boolean);

  if (normalizedTags.length === 0) {
    throw createError(
      "invalid_note_schema",
      "The AI returned notes without valid tags - please try again"
    );
  }

  return Array.from(new Set(normalizedTags));
}

async function requestNotesWithRetry(text, apiKey, providerKey, metadata) {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    const result = await requestNotesOnce(text, apiKey, providerKey, metadata);

    if (result.success) {
      return result;
    }

    if (!result.error?.retryable || attempt === RETRY_DELAYS_MS.length) {
      return {
        success: false,
        error: stripRetryMetadata(result.error)
      };
    }

    await delay(RETRY_DELAYS_MS[attempt]);
  }

  return {
    success: false,
    error: createError("generic_error", "Failed to convert article - please try again")
  };
}

async function requestNotesOnce(text, apiKey, providerKey, metadata) {
  const provider = PROVIDERS[providerKey];
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;

  try {
    response = await fetch(provider.mode === "gemini" ? buildGeminiUrl(apiKey) : provider.url, {
      method: "POST",
      headers: buildHeaders(apiKey, providerKey),
      body: JSON.stringify(buildRequestBody(text, providerKey, metadata)),
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timeoutId);

    if (error?.name === "AbortError") {
      return {
        success: false,
        error: createError(
          "request_timeout",
          `${provider.label} took too long to respond - please try again`
        )
      };
    }

    return {
      success: false,
      error: createError("generic_error", "Network error - check your connection and try again")
    };
  }

  clearTimeout(timeoutId);

  if (!response.ok) {
    const errorBody = await readJsonSafely(response);
    return {
      success: false,
      error: classifyApiError(response.status, errorBody, providerKey)
    };
  }

  const data = await readJsonSafely(response);

  if (!data) {
    return {
      success: false,
      error: createError(
        "generic_error",
        `${provider.label} returned an invalid response - please try again`
      )
    };
  }

  const content = extractResponseText(data, providerKey);

  if (typeof content !== "string" || !content.trim()) {
    return {
      success: false,
      error: createError("generic_error", `${provider.label} returned an empty response - please try again`)
    };
  }

  try {
    const notes = validateAndNormalizeNotes(parseNotes(content));
    return {
      success: true,
      notes
    };
  } catch (error) {
    return {
      success: false,
      error: normalizeCaughtError(error, "Response was not valid JSON - please try again")
    };
  }
}

function classifyApiError(status, errorBody, providerKey) {
  const provider = PROVIDERS[providerKey];
  const apiError = errorBody?.error || errorBody || {};
  const errorCode = String(apiError.code || "").toLowerCase();
  const errorType = String(apiError.type || apiError.status || "").toLowerCase();
  const errorMessage = String(apiError.message || "").toLowerCase();
  const quotaSignals = [errorCode, errorType, errorMessage];
  const hasQuotaSignal = quotaSignals.some(
    (value) =>
      value.includes("insufficient_quota") ||
      value.includes("quota") ||
      value.includes("billing") ||
      value.includes("credit") ||
      value.includes("usage limit") ||
      value.includes("resource exhausted")
  );
  const invalidKeySignals = [errorCode, errorType, errorMessage];
  const hasInvalidKeySignal = invalidKeySignals.some(
    (value) =>
      value.includes("invalid api key") ||
      value.includes("api key not valid") ||
      value.includes("authentication") ||
      value.includes("unauthorized") ||
      value.includes("forbidden") ||
      value.includes("permission denied")
  );

  if (status === 401 || ((status === 400 || status === 403) && hasInvalidKeySignal)) {
    return createError(
      "invalid_api_key",
      `Invalid ${provider.label} API key - please check your key in settings`
    );
  }

  if (status === 429 && hasQuotaSignal) {
    return createError(
      "insufficient_quota",
      `${provider.label} quota reached - add credits or wait for quota to reset, then try again`
    );
  }

  if (status === 429) {
    return createError(
      "rate_limited",
      `${provider.label} rate limit reached - please wait a moment and try again`,
      true
    );
  }

  if (status >= 500) {
    return createError(
      "server_error",
      `${provider.label} server error - please try again in a few seconds`,
      true
    );
  }

  return createError("generic_error", apiError.message || "Failed to convert article - please try again");
}

function createError(code, message, retryable = false) {
  return { code, message, retryable };
}

function stripRetryMetadata(error) {
  return {
    code: String(error?.code || "generic_error"),
    message: String(error?.message || "Something went wrong")
  };
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getProviderKey(value) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, value) ? value : "openai";
}

function buildHeaders(apiKey, providerKey) {
  if (providerKey === "gemini") {
    return {
      "Content-Type": "application/json"
    };
  }

  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`
  };
}

function buildUserContent(text, metadata) {
  const lines = [String(text || "").trim()];

  if (metadata.wasTruncated) {
    lines.push("NOTE: Source text truncated at 8000 chars. Focus on first half.");
  }

  return lines.filter(Boolean).join("\n\n");
}

function buildRequestBody(text, providerKey, metadata) {
  const userContent = buildUserContent(text, metadata);

  if (providerKey === "gemini") {
    return {
      system_instruction: {
        parts: [
          {
            text: SYSTEM_PROMPT
          }
        ]
      },
      contents: [
        {
          role: "user",
          parts: [
            {
              text: userContent
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 4000
      }
    };
  }

  return {
    model: PROVIDERS[providerKey].model,
    max_tokens: 4000,
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content: SYSTEM_PROMPT
      },
      {
        role: "user",
        content: userContent
      }
    ]
  };
}

function buildGeminiUrl(apiKey) {
  return `${PROVIDERS.gemini.url}?key=${encodeURIComponent(apiKey)}`;
}

function extractResponseText(data, providerKey) {
  if (providerKey === "gemini") {
    return data?.candidates?.[0]?.content?.parts?.[0]?.text;
  }

  return data?.choices?.[0]?.message?.content;
}
