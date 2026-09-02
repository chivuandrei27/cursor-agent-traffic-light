#!/usr/bin/env node

import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startBridge } from '../bridge/server.mjs';

function fail(message) {
  console.error(`[acceptance] FAIL: ${message}`);
  process.exitCode = 1;
}

async function waitForStatus(ws, expectedState, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for WebSocket state ${expectedState}`));
    }, timeoutMs);

    function onMessage(raw) {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (message?.type === 'status' && message.payload?.state === expectedState) {
        cleanup();
        resolve(message.payload);
      }
    }

    function cleanup() {
      clearTimeout(timer);
      ws.off('message', onMessage);
    }

    ws.on('message', onMessage);
  });
}

async function main() {
  console.log('[acceptance] starting bridge on random port');
  const bridge = await startBridge({ port: 0 });
  const base = `http://${bridge.host}:${bridge.port}`;
  const wsUrl = `ws://${bridge.host}:${bridge.port}/ws`;

  try {
    const healthRes = await fetch(`${base}/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.status, 'ok');
    assert.equal(health.currentStatus.state, 'idle');
    console.log('[acceptance] 1-3 health/idle ok');

    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    console.log('[acceptance] 4 websocket connected');

    async function post(state, message) {
      const response = await fetch(`${base}/api/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state, message, source: 'acceptance' }),
      });
      assert.equal(response.status, 200);
      return response.json();
    }

    const workingWait = waitForStatus(ws, 'working');
    await post('working', 'Acceptance working');
    await workingWait;
    console.log('[acceptance] 5-6 working ok');

    await new Promise((r) => setTimeout(r, 520));
    const waitingWait = waitForStatus(ws, 'waiting');
    await post('waiting', 'Acceptance waiting');
    await waitingWait;
    console.log('[acceptance] 7-8 waiting ok');

    await new Promise((r) => setTimeout(r, 520));
    const completedWait = waitForStatus(ws, 'completed');
    await post('completed', 'Acceptance completed');
    await completedWait;
    console.log('[acceptance] 9-10 completed ok');

    await new Promise((r) => setTimeout(r, 520));
    const errorWait = waitForStatus(ws, 'error');
    await post('error', 'Acceptance error');
    await errorWait;
    console.log('[acceptance] 11-12 error ok');

    const historyRes = await fetch(`${base}/api/history`);
    const historyBody = await historyRes.json();
    assert.ok(Array.isArray(historyBody.history));
    assert.ok(historyBody.history.length >= 4);
    console.log('[acceptance] 13 history ok');

    const dup = await post('error', 'Acceptance error');
    assert.equal(dup.deduped, true);
    console.log('[acceptance] 14 duplicate ok');

    const invalid = await fetch(`${base}/api/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'offline' }),
    });
    assert.equal(invalid.status, 400);
    console.log('[acceptance] 15 invalid state ok');

    const oversized = 'x'.repeat(70 * 1024);
    const big = await fetch(`${base}/api/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: `{"state":"idle","message":"${oversized}"}`,
    });
    assert.equal(big.status, 413);
    console.log('[acceptance] 16 oversized body ok');

    ws.close();
    await bridge.close();
    console.log('[acceptance] 17 shutdown ok');
    console.log('[acceptance] PASS');
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    try {
      await bridge.close();
    } catch {
      // ignore
    }
  }
}

await main();
if (process.exitCode) {
  process.exit(process.exitCode);
}
