/**
 * MV3 service worker: one WebSocket to the local bridge, badge + notifications.
 * No DOM APIs. All UI text updates go through chrome.action / notifications / storage.
 */

import { BADGE_MAP, DEFAULT_SETTINGS, DEFAULT_STATUS, NOTIFY_STATES } from './defaults.js';

const HEARTBEAT_MS = 20_000;
const MAX_BACKOFF_MS = 30_000;
const ALARM_NAME = 'traffic-light-reconnect';
const ALARM_PERIOD_MINUTES = 1;
const BADGE_BLINK_MS = 800;
const WAITING_DIM = '#7F1D1D';
const WORKING_DIM = '#854D0E';

let socket = null;
let heartbeatTimer = null;
let badgeBlinkTimer = null;
let badgeBlinkOn = true;
let reconnectAttempt = 0;
let reconnectTimer = null;
let connecting = false;
let settings = { ...DEFAULT_SETTINGS };
let currentStatus = { ...DEFAULT_STATUS };
let instances = [];
let connectionState = 'disconnected';
let lastNotifiedKey = null;
let suppressNotifications = true;
let badgeState = 'offline';

function log(...args) {
  console.info('[traffic-light]', ...args);
}

function warn(...args) {
  console.warn('[traffic-light]', ...args);
}

async function loadState() {
  const stored = await chrome.storage.local.get({
    settings: DEFAULT_SETTINGS,
    currentStatus: DEFAULT_STATUS,
    instances: [],
    connectionState: 'disconnected',
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    lastNotifiedKey: null,
  });

  settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  currentStatus = stored.currentStatus || { ...DEFAULT_STATUS };
  instances = Array.isArray(stored.instances) ? stored.instances : [];
  connectionState = stored.connectionState || 'disconnected';
  lastNotifiedKey = stored.lastNotifiedKey || null;
}

async function persist(partial) {
  await chrome.storage.local.set(partial);
}

async function setConnectionState(state) {
  connectionState = state;
  const patch = { connectionState: state };
  if (state === 'connected') {
    patch.lastConnectedAt = new Date().toISOString();
  }
  if (state === 'disconnected' || state === 'reconnecting') {
    if (state === 'disconnected') {
      patch.lastDisconnectedAt = new Date().toISOString();
    }
  }
  await persist(patch);
}

function wsUrl() {
  return settings.bridgeWsUrl || DEFAULT_SETTINGS.bridgeWsUrl;
}

function stopBadgeBlink() {
  if (badgeBlinkTimer !== null) {
    clearInterval(badgeBlinkTimer);
    badgeBlinkTimer = null;
  }
  badgeBlinkOn = true;
}

function startBadgeBlink(state) {
  stopBadgeBlink();
  const bright = BADGE_MAP[state]?.color;
  const dim = state === 'waiting' || state === 'error' ? WAITING_DIM : WORKING_DIM;
  const textOn = BADGE_MAP[state]?.text || '';
  if (!bright) {
    return;
  }

  badgeBlinkTimer = setInterval(() => {
    if (badgeState !== state) {
      stopBadgeBlink();
      return;
    }
    badgeBlinkOn = !badgeBlinkOn;
    chrome.action.setBadgeBackgroundColor({
      color: badgeBlinkOn ? bright : dim,
    });
    chrome.action.setBadgeText({ text: badgeBlinkOn ? textOn : ' ' });
  }, BADGE_BLINK_MS);
}

function applyBadge(status, instanceList = instances) {
  const state = status?.state || 'offline';
  badgeState = state;
  const badge = BADGE_MAP[state] || BADGE_MAP.offline;
  const projects = (instanceList || [])
    .map((item) => item.project)
    .filter(Boolean)
    .slice(0, 4);
  const titleParts = [`Cursor: ${state}`];
  if (instanceList?.length > 1) {
    titleParts.push(`${instanceList.length} projects`);
  }
  if (projects.length > 0) {
    titleParts.push(projects.join(', '));
  } else if (status?.message) {
    titleParts.push(status.message);
  }

  chrome.action.setBadgeText({ text: badge.text });
  chrome.action.setBadgeBackgroundColor({ color: badge.color });
  chrome.action.setTitle({ title: titleParts.join(' — ') });

  if (state === 'waiting' || state === 'working' || state === 'error') {
    startBadgeBlink(state);
  } else {
    stopBadgeBlink();
  }
}

function notificationConfig(state) {
  if (state === 'waiting') {
    return {
      title: 'Cursor pending approval',
      message: currentStatus.message || 'Approve or deny the pending action.',
    };
  }
  if (state === 'completed') {
    return {
      title: 'Cursor task completed',
      message: currentStatus.message || 'The agent finished the current task.',
    };
  }
  if (state === 'error') {
    return {
      title: 'Cursor needs you',
      message: currentStatus.message || 'The agent is waiting for your reply or review.',
    };
  }
  return null;
}

async function maybeNotify(previousState, status) {
  if (suppressNotifications) {
    return;
  }
  if (!settings.notificationsEnabled) {
    return;
  }

  const state = status.state;
  if (!NOTIFY_STATES.has(state)) {
    return;
  }
  if (previousState === state) {
    return;
  }
  if (state === 'waiting' && !settings.waitingNotifications) {
    return;
  }
  if (state === 'completed' && !settings.completionNotifications) {
    return;
  }
  if (state === 'error' && !settings.errorNotifications) {
    return;
  }

  const key = `${state}:${status.sequence ?? ''}:${status.message ?? ''}`;
  if (key === lastNotifiedKey) {
    return;
  }

  const config = notificationConfig(state);
  if (!config) {
    return;
  }

  lastNotifiedKey = key;
  await persist({ lastNotifiedKey: key });

  try {
    await chrome.notifications.create(`traffic-light-${state}-${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: config.title,
      message: config.message.slice(0, 180),
      priority: 1,
    });
  } catch (error) {
    warn('notification failed', error?.message || error);
  }
}

async function handleStatusPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return;
  }

  const previousState = currentStatus?.state;
  currentStatus = payload;
  applyBadge(currentStatus, instances);
  await persist({ currentStatus });
  await maybeNotify(previousState, currentStatus);
}

async function handleInstancesPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return;
  }
  instances = Array.isArray(payload.instances) ? payload.instances : [];
  const aggregate = payload.aggregateState || currentStatus.state;
  if (aggregate && aggregate !== currentStatus.state) {
    // Keep details from latest status, but badge color follows the busiest instance.
    applyBadge({ ...currentStatus, state: aggregate }, instances);
  } else {
    applyBadge(currentStatus, instances);
  }
  await persist({ instances, aggregateState: aggregate });
}

function stopHeartbeat() {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(
          JSON.stringify({
            type: 'ping',
            timestamp: new Date().toISOString(),
          }),
        );
      } catch (error) {
        warn('heartbeat send failed', error?.message || error);
      }
    }
  }, HEARTBEAT_MS);
}

function clearReconnectTimer() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(reason) {
  if (!settings.reconnectAutomatically) {
    log('auto-reconnect disabled; skipping after', reason);
    return;
  }
  if (reconnectTimer !== null || connecting) {
    return;
  }
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** reconnectAttempt);
  reconnectAttempt += 1;
  void setConnectionState('reconnecting');
  log(`reconnect in ${delay}ms (${reason}), attempt=${reconnectAttempt}`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect('scheduled');
  }, delay);
}

function closeSocket(reason) {
  stopHeartbeat();
  clearReconnectTimer();
  if (!socket) {
    return;
  }
  const current = socket;
  socket = null;
  try {
    current.close(1000, reason || 'close');
  } catch {
    // ignore
  }
}

function connect(reason = 'manual') {
  if (connecting) {
    log('connect skipped; already connecting', reason);
    return;
  }
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
  ) {
    log('connect skipped; socket already active', reason);
    return;
  }

  const url = wsUrl();
  connecting = true;
  log('connecting', url, reason);

  let next;
  try {
    next = new WebSocket(url);
  } catch (error) {
    connecting = false;
    warn('WebSocket constructor failed', error?.message || error);
    void setConnectionState('disconnected');
    scheduleReconnect('constructor-error');
    return;
  }

  socket = next;

  next.addEventListener('open', () => {
    if (socket !== next) {
      return;
    }
    connecting = false;
    reconnectAttempt = 0;
    suppressNotifications = false;
    log('connected');
    void setConnectionState('connected');
    startHeartbeat();
  });

  next.addEventListener('message', (event) => {
    if (socket !== next) {
      return;
    }
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      warn('ignored non-JSON websocket message');
      return;
    }
    if (!message || typeof message !== 'object') {
      return;
    }
    if (message.type === 'status') {
      void handleStatusPayload(message.payload);
    }
    if (message.type === 'instances') {
      void handleInstancesPayload(message.payload);
    }
  });

  next.addEventListener('close', (event) => {
    if (socket !== next) {
      return;
    }
    connecting = false;
    stopHeartbeat();
    socket = null;
    log('disconnected', event.code, event.reason || '');
    void setConnectionState('disconnected');

    const offlineStatus = {
      ...currentStatus,
      state: 'offline',
      message: currentStatus.message || 'Bridge disconnected',
      source: currentStatus.source || 'extension',
    };
    currentStatus = offlineStatus;
    applyBadge(offlineStatus);
    void persist({ currentStatus: offlineStatus });
    scheduleReconnect('close');
  });

  next.addEventListener('error', () => {
    warn('websocket error');
  });
}

async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    await chrome.alarms.create(ALARM_NAME, {
      periodInMinutes: ALARM_PERIOD_MINUTES,
    });
  }
}

async function configureSidePanel() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    log('side panel opens on toolbar click');
  } catch (error) {
    warn('side panel setup failed', error?.message || error);
  }
}

async function bootstrap(reason) {
  await loadState();
  await configureSidePanel();
  applyBadge(currentStatus);
  await ensureAlarm();
  connect(reason);
}

chrome.runtime.onInstalled.addListener(() => {
  suppressNotifications = true;
  void bootstrap('onInstalled');
});

chrome.runtime.onStartup.addListener(() => {
  suppressNotifications = true;
  void bootstrap('onStartup');
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) {
    return;
  }
  if (!settings.reconnectAutomatically) {
    return;
  }
  if (socket && socket.readyState === WebSocket.OPEN) {
    return;
  }
  log('alarm reconnect tick');
  connect('alarm');
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') {
    return;
  }
  if (changes.settings) {
    settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
    log('settings updated; reconnecting');
    closeSocket('settings-changed');
    reconnectAttempt = 0;
    connect('settings-changed');
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'reconnect') {
    reconnectAttempt = 0;
    closeSocket('popup-reconnect');
    connect('popup-reconnect');
    sendResponse({ ok: true, connectionState });
    return true;
  }
  if (message?.type === 'getState') {
    sendResponse({
      currentStatus,
      connectionState,
      settings,
    });
    return true;
  }
  if (message?.type === 'testConnection') {
    const httpUrl = (message.httpUrl || settings.bridgeHttpUrl || '').replace(/\/$/, '');
    fetch(`${httpUrl}/health`, { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        sendResponse({
          ok: response.ok,
          status: response.status,
          body,
        });
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error?.message || 'fetch failed',
        });
      });
    return true;
  }
  return false;
});

void bootstrap('worker-start');
