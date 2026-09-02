/** Shared defaults for popup, options, and service worker. */

export const DEFAULT_SETTINGS = Object.freeze({
  language: 'en',
  theme: 'dark',
  notificationsEnabled: true,
  completionNotifications: true,
  waitingNotifications: true,
  errorNotifications: true,
  bridgeHttpUrl: 'http://127.0.0.1:3210',
  bridgeWsUrl: 'ws://127.0.0.1:3210/ws',
  reconnectAutomatically: true,
});

export const DEFAULT_STATUS = Object.freeze({
  state: 'offline',
  message: 'Waiting for bridge',
  project: '',
  task: '',
  conversationId: null,
  event: null,
  source: 'extension',
  sequence: 0,
  updatedAt: null,
});

export const BADGE_MAP = Object.freeze({
  offline: { text: 'X', color: '#6B7280' },
  idle: { text: '', color: '#64748B' },
  working: { text: '...', color: '#F5C518' },
  waiting: { text: '!', color: '#FF3B3B' },
  completed: { text: 'OK', color: '#22C55E' },
  error: { text: '!', color: '#FF3B3B' },
});

export const NOTIFY_STATES = new Set(['waiting', 'completed', 'error']);
