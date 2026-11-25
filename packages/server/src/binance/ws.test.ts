import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';

import { ResilientStream } from './ws.js';

function startTestWsServer(opts: { sendPingOnConnect: boolean }): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on('connection', (ws) => {
      if (opts.sendPingOnConnect) {
        ws.ping();
      }
    });
    wss.on('listening', () => {
      const addr = wss.address();
      assert.ok(addr && typeof addr === 'object');
      resolve({
        url: `ws://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((res) => {
            for (const client of wss.clients) client.terminate();
            wss.close(() => res());
          }),
      });
    });
  });
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('waitFor timed out'));
      }
    }, 15);
  });
}

test('★ user-data idleSilenceExpected=true 且近期收到 WS ping 时，静默刷新走 idle-refresh 而不报错/不退避', async () => {
  const srv = await startTestWsServer({ sendPingOnConnect: true });
  const openReasons: string[] = [];
  const stream = new ResilientStream({
    name: 'user-data-test',
    url: () => srv.url,
    stalenessWindowMs: 120,
    idleSilenceExpected: true,
    watchdogIntervalMs: 30,
    onOpen: (reason) => {
      openReasons.push(reason);
    },
  });

  try {
    await stream.start();
    await waitFor(() => openReasons.length >= 2);
    assert.equal(openReasons[0], 'startup');
    assert.equal(openReasons[1], 'idle-refresh');
  } finally {
    await stream.stop();
    await srv.close();
  }
});

test('★ user-data idleSilenceExpected=true 但完全无 WS ping 心跳时，仍作为静默僵尸触发 watchdog-open-silent', async () => {
  const srv = await startTestWsServer({ sendPingOnConnect: false });
  const openReasons: string[] = [];
  const stream = new ResilientStream({
    name: 'user-data-zombie-test',
    url: () => srv.url,
    stalenessWindowMs: 120,
    idleSilenceExpected: true,
    watchdogIntervalMs: 30,
    onOpen: (reason) => {
      openReasons.push(reason);
    },
  });

  try {
    await stream.start();
    await waitFor(() => openReasons.length >= 2);
    assert.equal(openReasons[0], 'startup');
    assert.equal(openReasons[1], 'watchdog-open-silent');
  } finally {
    await stream.stop();
    await srv.close();
  }
});

test('★ 默认行情流（idleSilenceExpected 未开）即使收到 WS ping，无业务帧仍触发 watchdog-open-silent', async () => {
  const srv = await startTestWsServer({ sendPingOnConnect: true });
  const openReasons: string[] = [];
  const stream = new ResilientStream({
    name: 'market-data-test',
    url: () => srv.url,
    stalenessWindowMs: 120,
    watchdogIntervalMs: 30,
    onOpen: (reason) => {
      openReasons.push(reason);
    },
  });

  try {
    await stream.start();
    await waitFor(() => openReasons.length >= 2);
    assert.equal(openReasons[0], 'startup');
    assert.equal(openReasons[1], 'watchdog-open-silent');
  } finally {
    await stream.stop();
    await srv.close();
  }
});
