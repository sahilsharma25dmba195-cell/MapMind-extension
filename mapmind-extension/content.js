(function () {
  if (globalThis.__MAPMIND_IMPORTER_CONTENT_READY__) {
    return;
  }

  globalThis.__MAPMIND_IMPORTER_CONTENT_READY__ = true;

  const REQUEST_ACTION = "mapmind:extract-page-content";
  const RESPONSE_ACTION = "mapmind:page-content";
  const MAX_TEXT_LENGTH = 8000;
  const MIN_CONTENT_LENGTH = 500;
  const MIN_SENTENCE_COUNT = 8;
  const SHORT_SENTENCE_LENGTH = 40;
  const SHORT_SENTENCE_RATIO = 0.6;

  function createExtractionError(code, message) {
    return { code, message };
  }

  function getSourceSelectorHint() {
    if (document.querySelector("article")) {
      return "article";
    }

    if (document.querySelector("main")) {
      return "main";
    }

    return "readability";
  }

  function normalizeExtractedText(rawText) {
    return String(rawText || "")
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .split("\n")
      .map((line) => line.trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function getSentenceStats(text) {
    const segments = String(text || "")
      .split(/[.!?\n\u061f\u06d4\u0964\u3002]+/u)
      .map((segment) => segment.trim())
      .filter(Boolean);

    if (segments.length === 0) {
      return {
        count: 0,
        shortRatio: 1
      };
    }

    const shortCount = segments.filter((segment) => segment.length < SHORT_SENTENCE_LENGTH).length;

    return {
      count: segments.length,
      shortRatio: shortCount / segments.length
    };
  }

  function validateQuality(text) {
    if (text.length < MIN_CONTENT_LENGTH) {
      throw createExtractionError(
        "low_quality_content",
        "This page does not contain enough readable article text to extract notes."
      );
    }

    const sentenceStats = getSentenceStats(text);

    if (
      sentenceStats.count >= MIN_SENTENCE_COUNT &&
      sentenceStats.shortRatio >= SHORT_SENTENCE_RATIO
    ) {
      throw createExtractionError(
        "unsupported_page",
        "This page looks more like navigation, search results, or short snippets than a readable article."
      );
    }
  }

  function extractWithReadability() {
    if (typeof Readability !== "function") {
      throw createExtractionError(
        "unsupported_page",
        "Article extraction is not available on this page."
      );
    }

    const clonedDocument = document.cloneNode(true);
    const reader = new Readability(clonedDocument, {
      charThreshold: MIN_CONTENT_LENGTH
    });
    const article = reader.parse();

    if (!article || !article.textContent) {
      throw createExtractionError(
        "unsupported_page",
        "This page could not be turned into a readable article."
      );
    }

    return article;
  }

  function extractPageContent() {
    const article = extractWithReadability();
    const normalizedText = normalizeExtractedText(article.textContent);

    validateQuality(normalizedText);

    const wasTruncated = normalizedText.length > MAX_TEXT_LENGTH;
    const text = wasTruncated ? normalizedText.slice(0, MAX_TEXT_LENGTH).trimEnd() : normalizedText;

    return {
      title: String(article.title || document.title || location.hostname || "Untitled page").trim(),
      text,
      sourceSelector: getSourceSelectorHint(),
      charCount: normalizedText.length,
      wasTruncated
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.action !== REQUEST_ACTION) {
      return;
    }

    try {
      const payload = extractPageContent();
      chrome.runtime.sendMessage({
        action: RESPONSE_ACTION,
        requestId: message.requestId,
        payload
      });
      sendResponse({ ok: true });
    } catch (error) {
      const normalizedError =
        error && typeof error === "object" && "code" in error
          ? error
          : createExtractionError(
              "generic_error",
              error instanceof Error ? error.message : "Failed to extract page content"
            );

      chrome.runtime.sendMessage({
        action: RESPONSE_ACTION,
        requestId: message.requestId,
        error: normalizedError
      });
      sendResponse({ ok: false });
    }
  });
})();
