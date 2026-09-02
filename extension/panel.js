import { DEFAULT_SETTINGS, DEFAULT_STATUS } from './defaults.js';
import { stateLabel, t } from './i18n.js';

const els = {
  connection: document.getElementById('connection'),
  reconnect: document.getElementById('btn-reconnect'),
  settings: document.getElementById('btn-settings'),
  instancesList: document.getElementById('instances-list'),
  instancesEmpty: document.getElementById('instances-empty'),
};

/** @type {object | null} */
let latestStatus = null;
/** @type {string} */
let language = DEFAULT_SETTINGS.language;
/** @type {string} */
let theme = DEFAULT_SETTINGS.theme;
/** @type {string} */
let connectionState = 'disconnected';
let tickTimer = null;

function applyTheme(nextTheme) {
  theme = nextTheme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

function applyStaticI18n() {
  document.documentElement.lang = language;
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    const key = node.getAttribute('data-i18n');
    if (key) {
      node.textContent = t(language, key);
    }
  });
}

function formatDurationMs(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rem = seconds % 60;
    return rem > 0 ? `${minutes}m ${rem}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Elapsed time for the whole prompt run (not per tool/action).
 * Active: live from startedAt. Finished: frozen start→updatedAt.
 */
function formatPromptElapsed(item, now = Date.now()) {
  const startIso = item.startedAt || item.updatedAt;
  if (!startIso) {
    return '—';
  }
  const startMs = Date.parse(startIso);
  if (Number.isNaN(startMs)) {
    return '—';
  }

  const active = item.state === 'working' || item.state === 'waiting' || item.state === 'error';
  let endMs = now;
  if (!active && item.updatedAt) {
    const finishedMs = Date.parse(item.updatedAt);
    if (!Number.isNaN(finishedMs)) {
      endMs = finishedMs;
    }
  }

  return formatDurationMs(endMs - startMs);
}

function renderConnection(state = connectionState) {
  connectionState = state || 'disconnected';
  els.connection.classList.remove('connected', 'reconnecting', 'disconnected');
  els.connection.classList.add(connectionState);
  const key =
    connectionState === 'connected'
      ? 'connected'
      : connectionState === 'reconnecting'
        ? 'reconnecting'
        : 'disconnected';
  els.connection.textContent = t(language, key);
}

function createTrafficLight(state) {
  const housing = document.createElement('div');
  housing.className = 'traffic-light';
  housing.setAttribute('aria-hidden', 'true');

  const top = document.createElement('span');
  top.className = 'lamp red';
  const mid = document.createElement('span');
  mid.className = 'lamp yellow';
  const bottom = document.createElement('span');
  bottom.className = 'lamp green';

  if (state === 'waiting' || state === 'error') {
    top.classList.add('on', 'blink');
  } else if (state === 'working') {
    mid.classList.add('on', 'blink');
  } else if (state === 'completed') {
    bottom.classList.add('on');
  }

  housing.append(top, mid, bottom);
  return housing;
}

function buildCards(instances, fallbackStatus) {
  const list = Array.isArray(instances) ? [...instances] : [];

  if (
    list.length === 0 &&
    fallbackStatus &&
    (fallbackStatus.project || fallbackStatus.workspaceRoot || fallbackStatus.state !== 'offline')
  ) {
    list.push({
      project: fallbackStatus.project || 'Cursor',
      workspaceRoot: fallbackStatus.workspaceRoot || null,
      state: fallbackStatus.state || 'idle',
      message: fallbackStatus.message || '',
      task: fallbackStatus.task || '',
      updatedAt: fallbackStatus.updatedAt,
      startedAt: fallbackStatus.startedAt || fallbackStatus.updatedAt || null,
      tabIndex: fallbackStatus.tabIndex || 1,
    });
  }

  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const item of list) {
    const key = item.workspaceRoot || item.project || item.id || '';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const item of list) {
    const key = item.workspaceRoot || item.project || item.id || '';
    item._tabCount = counts.get(key) || 1;
  }

  return list;
}

function renderInstances(instances, fallbackStatus = latestStatus) {
  if (!els.instancesList) {
    return;
  }

  const list = buildCards(instances, fallbackStatus);
  els.instancesList.replaceChildren();

  if (els.instancesEmpty) {
    els.instancesEmpty.hidden = list.length > 0;
  }

  const now = Date.now();
  for (const item of list) {
    const state = item.state || 'offline';
    const li = document.createElement('li');
    li.className = `project-card state-${state}`;

    const copy = document.createElement('div');
    copy.className = 'project-copy';

    const name = document.createElement('p');
    name.className = 'project-name';
    name.textContent = item.project || t(language, 'projectFallback');

    const status = document.createElement('p');
    status.className = `project-status state-${state}`;
    status.textContent = stateLabel(language, state);

    copy.append(name);

    const tabCount = Number(item._tabCount) || 0;
    const tabIndex = Number(item.tabIndex) || 0;
    if (tabCount > 1 && (item.tabName || tabIndex > 0)) {
      const tab = document.createElement('p');
      tab.className = 'project-tab';
      tab.textContent = item.tabName || t(language, 'tabLabel', { n: String(tabIndex || '?') });
      copy.append(tab);
    }

    copy.append(status);

    const meta = document.createElement('div');
    meta.className = 'project-meta';

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = t(language, 'activeFor');

    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.dataset.startedAt = item.startedAt || item.updatedAt || '';
    chip.dataset.updatedAt = item.updatedAt || '';
    chip.dataset.active =
      state === 'working' || state === 'waiting' || state === 'error' ? '1' : '0';
    chip.textContent = formatPromptElapsed(item, now);

    meta.append(label, chip);
    li.append(createTrafficLight(state), copy, meta);
    els.instancesList.append(li);
  }
}

function tickActiveClocks() {
  const now = Date.now();
  document.querySelectorAll('.project-meta .chip[data-started-at]').forEach((chip) => {
    chip.textContent = formatPromptElapsed(
      {
        startedAt: chip.dataset.startedAt,
        updatedAt: chip.dataset.updatedAt,
        state: chip.dataset.active === '1' ? 'working' : 'completed',
      },
      now,
    );
  });
}

function ensureTicker() {
  if (tickTimer !== null) {
    return;
  }
  tickTimer = setInterval(tickActiveClocks, 1000);
}

function refreshUi(instances) {
  applyTheme(theme);
  applyStaticI18n();
  renderConnection(connectionState);
  renderInstances(instances, latestStatus);
}

async function load() {
  const stored = await chrome.storage.local.get({
    currentStatus: DEFAULT_STATUS,
    connectionState: 'disconnected',
    settings: DEFAULT_SETTINGS,
    instances: [],
  });
  latestStatus = stored.currentStatus;
  connectionState = stored.connectionState || 'disconnected';
  language = stored.settings?.language || DEFAULT_SETTINGS.language;
  theme = stored.settings?.theme || DEFAULT_SETTINGS.theme;
  refreshUi(stored.instances);
  ensureTicker();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') {
    return;
  }
  if (changes.connectionState) {
    connectionState = changes.connectionState.newValue;
  }
  if (changes.currentStatus) {
    latestStatus = changes.currentStatus.newValue;
  }
  if (changes.settings?.newValue) {
    language = changes.settings.newValue.language || DEFAULT_SETTINGS.language;
    theme = changes.settings.newValue.theme || DEFAULT_SETTINGS.theme;
    applyTheme(theme);
  }
  if (changes.instances || changes.currentStatus || changes.connectionState || changes.settings) {
    chrome.storage.local.get({ instances: [] }, (stored) => {
      refreshUi(changes.instances ? changes.instances.newValue : stored.instances);
    });
  }
});

els.reconnect.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'reconnect' }, () => {
    void load();
  });
});

els.settings.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

void load();
