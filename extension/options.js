import { DEFAULT_SETTINGS } from './defaults.js';
import { t } from './i18n.js';

const fields = {
  language: document.getElementById('language'),
  theme: document.getElementById('theme'),
  bridgeHttpUrl: document.getElementById('bridgeHttpUrl'),
  bridgeWsUrl: document.getElementById('bridgeWsUrl'),
  reconnectAutomatically: document.getElementById('reconnectAutomatically'),
};

const statusEl = document.getElementById('status');
const form = document.getElementById('settings-form');

let language = DEFAULT_SETTINGS.language;
let theme = DEFAULT_SETTINGS.theme;

function applyTheme(nextTheme) {
  theme = nextTheme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

function applyI18n() {
  document.documentElement.lang = language;
  document.title = t(language, 'optionsTitle');
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    const key = node.getAttribute('data-i18n');
    if (key) {
      node.textContent = t(language, key);
    }
  });
}

function setStatus(message, kind = '') {
  statusEl.textContent = message;
  statusEl.classList.remove('ok', 'error');
  if (kind) {
    statusEl.classList.add(kind);
  }
}

function readForm() {
  return {
    ...DEFAULT_SETTINGS,
    language: fields.language.value || 'en',
    theme: fields.theme.value === 'light' ? 'light' : 'dark',
    bridgeHttpUrl: fields.bridgeHttpUrl.value.trim(),
    bridgeWsUrl: fields.bridgeWsUrl.value.trim(),
    reconnectAutomatically: fields.reconnectAutomatically.checked,
  };
}

function writeForm(settings) {
  const value = { ...DEFAULT_SETTINGS, ...settings };
  fields.language.value = value.language || 'en';
  fields.theme.value = value.theme === 'light' ? 'light' : 'dark';
  fields.bridgeHttpUrl.value = value.bridgeHttpUrl;
  fields.bridgeWsUrl.value = value.bridgeWsUrl;
  fields.reconnectAutomatically.checked = Boolean(value.reconnectAutomatically);
  language = value.language || 'en';
  applyTheme(value.theme);
  applyI18n();
}

function validateUrls(settings) {
  let http;
  let ws;
  try {
    http = new URL(settings.bridgeHttpUrl);
  } catch {
    throw new Error(t(language, 'invalidHttpUrl'));
  }
  try {
    ws = new URL(settings.bridgeWsUrl);
  } catch {
    throw new Error(t(language, 'invalidWsUrl'));
  }

  if (http.protocol !== 'http:' && http.protocol !== 'https:') {
    throw new Error(t(language, 'httpProtocol'));
  }
  if (ws.protocol !== 'ws:' && ws.protocol !== 'wss:') {
    throw new Error(t(language, 'wsProtocol'));
  }
  if (http.hostname !== '127.0.0.1' && http.hostname !== 'localhost') {
    throw new Error(t(language, 'httpHost'));
  }
  if (ws.hostname !== '127.0.0.1' && ws.hostname !== 'localhost') {
    throw new Error(t(language, 'wsHost'));
  }
}

async function load() {
  const stored = await chrome.storage.local.get({ settings: DEFAULT_SETTINGS });
  writeForm(stored.settings);
}

fields.language.addEventListener('change', () => {
  language = fields.language.value || 'en';
  applyI18n();
});

fields.theme.addEventListener('change', async () => {
  const nextTheme = fields.theme.value === 'light' ? 'light' : 'dark';
  applyTheme(nextTheme);
  const stored = await chrome.storage.local.get({ settings: DEFAULT_SETTINGS });
  await chrome.storage.local.set({
    settings: {
      ...DEFAULT_SETTINGS,
      ...stored.settings,
      theme: nextTheme,
    },
  });
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const settings = readForm();
  language = settings.language;
  try {
    validateUrls(settings);
  } catch (error) {
    setStatus(error.message, 'error');
    return;
  }
  await chrome.storage.local.set({ settings });
  applyTheme(settings.theme);
  applyI18n();
  setStatus(t(language, 'saved'), 'ok');
});

document.getElementById('btn-defaults').addEventListener('click', async () => {
  writeForm(DEFAULT_SETTINGS);
  await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS } });
  setStatus(t(language, 'defaultsRestored'), 'ok');
});

document.getElementById('btn-test').addEventListener('click', () => {
  const settings = readForm();
  language = settings.language;
  try {
    validateUrls(settings);
  } catch (error) {
    setStatus(error.message, 'error');
    return;
  }

  setStatus(t(language, 'testing'));
  chrome.runtime.sendMessage(
    { type: 'testConnection', httpUrl: settings.bridgeHttpUrl },
    (response) => {
      if (chrome.runtime.lastError) {
        setStatus(chrome.runtime.lastError.message, 'error');
        return;
      }
      if (response?.ok) {
        setStatus(t(language, 'connectedHttp', { status: response.status }), 'ok');
      } else {
        setStatus(
          response?.error || t(language, 'failedHttp', { status: response?.status || '?' }),
          'error',
        );
      }
    },
  );
});

void load();
