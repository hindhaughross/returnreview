(function () {
  const defaultConfig = {
    ENDPOINT: "https://api.openai.com/v1/chat/completions",
    KEY: "",
    MODEL: "gpt-4o-mini"
  };

  window.AI_CONFIG = Object.assign({}, defaultConfig, window.AI_CONFIG || {});
  const AI_CONFIG = window.AI_CONFIG;

  if (typeof globalThis !== "undefined") {
    globalThis.AI_CONFIG = AI_CONFIG;
  }
})();

const AI_CONFIG = window.AI_CONFIG;
