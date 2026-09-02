const WS_URL = `ws://${location.hostname || '127.0.0.1'}:${location.port || '3210'}/ws`;
const HEARTBEAT_MS = 20_000;
const MAX_BACKOFF_MS = 10_000;

const els = {
  connection: document.getElementById('connection-badge'),
  circle: document.getElementById('status-circle'),
  state: document.getElementById('status-state'),
  message: document.getElementById('status-message'),
  project: document.getElementById('meta-project'),
  task: document.getElementById('meta-task'),
  source: document.getElementById('meta-source'),
  event: document.getElementById('meta-event'),
  sequence: document.getElementById('meta-sequence'),
  updated: document.getElementById('meta-updated'),
  clients: document.getElementById('meta-clients'),
  history: document.getElementById('history-list'),
  instances: document.getElementById('instances-list'),
  instancesSummary: document.getElementById('instances-summary'),
  toast: document.getElementById('toast'),
  messageInput: document.getElementById('field-message'),
  projectInput: document.getElementById('field-project'),
  taskInput: document.getElementById('field-task'),
  resetBtn: document.getElementById('btn-reset'),
};

let socket = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let intentionallyClosed = false;
let toastTimer = null;

function setConnectionState(state) {
  els.connection.classList.remove('connected', 'reconnecting', 'disconnected');
  els.connection.classList.add(state);
  const labels = {
    connected: 'Connected',
    reconnecting: 'Reconnecting',
    disconnected: 'Disconnected',
  };
  els.connection.textContent = labels[state] ?? state;
}

function showToast(message, isError = false) {
  els.toast.hidden = false;
  els.toast.textContent = message;
  els.toast.classList.toggle('error', isError);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2800);
}

function dash(value) {
  if (value === null || value === undefined || value === '') {
    return '—';
  }
  return String(value);
}

function formatUpdated(iso) {
  if (!iso) {
    return '—';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString();
}

function renderStatus(status) {
  if (!status || typeof status !== 'object') {
    return;
  }

  const state = status.state || 'offline';
  els.circle.className = `status-circle state-${state}`;
  els.state.textContent = state;
  els.message.textContent = status.message || '—';
  els.project.textContent = dash(status.project);
  els.task.textContent = dash(status.task);
  els.source.textContent = dash(status.source);
  els.event.textContent = dash(status.event);
  els.sequence.textContent = dash(status.sequence);
  els.updated.textContent = formatUpdated(status.updatedAt);
}

function renderHistory(history) {
  els.history.replaceChildren();
  for (const item of history) {
    const li = document.createElement('li');

    const stateEl = document.createElement('span');
    stateEl.className = `history-state state-${item.state}`;
    stateEl.textContent = item.state;

    const messageEl = document.createElement('span');
    messageEl.className = 'history-message';
    messageEl.textContent = item.message || '(no message)';

    const metaEl = document.createElement('span');
    metaEl.className = 'history-meta';
    metaEl.textContent = `#${item.sequence} · ${formatUpdated(item.updatedAt)}`;

    li.append(stateEl, messageEl, metaEl);
    els.history.append(li);
  }
}

function renderInstances(instances) {
  if (!els.instances) {
    return;
  }
  const list = Array.isArray(instances) ? instances : [];
  els.instances.replaceChildren();
  if (els.instancesSummary) {
    els.instancesSummary.textContent =
      list.length === 0
        ? '0 detected'
        : `${list.length} project${list.length === 1 ? '' : 's'} detected`;
  }
  for (const item of list) {
    const li = document.createElement('li');
    li.className = 'instance-row';

    const stateEl = document.createElement('span');
    stateEl.className = `history-state state-${item.state}`;
    stateEl.textContent = item.state;

    const messageEl = document.createElement('span');
    messageEl.className = 'history-message';
    messageEl.textContent = `${item.project || 'Unknown'}${item.task ? ` · ${item.task}` : ''}`;

    const metaEl = document.createElement('span');
    metaEl.className = 'history-meta';
    metaEl.textContent = item.workspaceRoot || formatUpdated(item.updatedAt);

    li.append(stateEl, messageEl, metaEl);
    els.instances.append(li);
  }
}

async function refreshHealthAndHistory() {
  try {
    const [healthRes, historyRes, instancesRes] = await Promise.all([
      fetch('/health', { cache: 'no-store' }),
      fetch('/api/history', { cache: 'no-store' }),
      fetch('/api/instances', { cache: 'no-store' }),
    ]);

    if (healthRes.ok) {
      const health = await healthRes.json();
      els.clients.textContent = dash(health.webSocketClients);
      if (health.currentStatus) {
        renderStatus(health.currentStatus);
      }
      if (Array.isArray(health.instances)) {
        renderInstances(health.instances);
      }
    }

    if (historyRes.ok) {
      const data = await historyRes.json();
      renderHistory(data.history ?? []);
    }

    if (instancesRes.ok) {
      const data = await instancesRes.json();
      renderInstances(data.instances ?? []);
    }
  } catch {
    // Keep UI usable while reconnecting.
  }
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
      socket.send(
        JSON.stringify({
          type: 'ping',
          timestamp: new Date().toISOString(),
        }),
      );
    }
  }, HEARTBEAT_MS);
}

function scheduleReconnect() {
  if (intentionallyClosed) {
    return;
  }
  if (reconnectTimer !== null) {
    return;
  }

  setConnectionState('reconnecting');
  const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** reconnectAttempt);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, delay);
}

function connectWebSocket() {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  intentionallyClosed = false;
  setConnectionState(reconnectAttempt > 0 ? 'reconnecting' : 'disconnected');

  const next = new WebSocket(WS_URL);
  socket = next;

  next.addEventListener('open', () => {
    if (socket !== next) {
      return;
    }
    reconnectAttempt = 0;
    setConnectionState('connected');
    startHeartbeat();
    void refreshHealthAndHistory();
  });

  next.addEventListener('message', (event) => {
    if (socket !== next) {
      return;
    }
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.type === 'status' && message.payload) {
      renderStatus(message.payload);
      void refreshHealthAndHistory();
    }
    if (message.type === 'instances' && message.payload) {
      renderInstances(message.payload.instances ?? []);
    }
  });

  next.addEventListener('close', () => {
    if (socket !== next) {
      return;
    }
    stopHeartbeat();
    socket = null;
    setConnectionState('disconnected');
    scheduleReconnect();
  });

  next.addEventListener('error', () => {
    // close handler performs reconnect
  });
}

async function postStatus(state) {
  const payload = {
    state,
    message: els.messageInput.value.trim(),
    project: els.projectInput.value.trim(),
    task: els.taskInput.value.trim(),
    source: 'debug-ui',
    event: 'manualControl',
  };

  try {
    const response = await fetch('/api/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) {
      showToast(data?.error?.message || 'Failed to update status', true);
      return;
    }
    showToast(data.deduped ? 'Duplicate ignored (deduped)' : `Set ${state}`);
  } catch {
    showToast('Bridge unreachable', true);
  }
}

async function resetStatus() {
  try {
    const response = await fetch('/api/reset', { method: 'POST' });
    const data = await response.json();
    if (!response.ok) {
      showToast(data?.error?.message || 'Reset failed', true);
      return;
    }
    showToast('Reset to idle');
  } catch {
    showToast('Bridge unreachable', true);
  }
}

document.querySelectorAll('button[data-state]').forEach((button) => {
  button.addEventListener('click', () => {
    void postStatus(button.dataset.state);
  });
});

els.resetBtn.addEventListener('click', () => {
  void resetStatus();
});

void refreshHealthAndHistory();
connectWebSocket();
