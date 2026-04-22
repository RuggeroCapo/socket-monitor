'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');

const DEFAULT_SCENARIO = [
  {
    delayMs: 0,
    event: 'newItem',
    item: {
      asin: 'MOCK-ASIN-001',
      queue: 'AFA',
      title: 'Mock Espresso Cups',
      item_value: 19.99,
      currency: 'EUR',
    },
  },
  {
    delayMs: 1500,
    event: 'newItem',
    item: {
      asin: 'MOCK-ASIN-002',
      queue: 'RFY',
      title: 'Mock Office Lamp',
      item_value: 42.5,
      currency: 'EUR',
    },
  },
  {
    delayMs: 1500,
    event: 'newETV',
    item: {
      asin: 'MOCK-ASIN-001',
      etv: 17.49,
      currency: 'EUR',
    },
  },
  {
    delayMs: 1500,
    event: 'newItem',
    item: {
      asin: 'MOCK-ASIN-003',
      queue: 'AI',
      title: 'Mock Travel Bottle',
      item_value: 12,
      currency: 'EUR',
    },
  },
];

const host = process.env.MOCK_SOCKET_HOST || '0.0.0.0';
const port = parseInteger(process.env.MOCK_SOCKET_PORT, 3101);
const socketPath = normalizeSocketPath(process.env.MOCK_SOCKET_PATH || '/socket.io/');
const pingIntervalMs = parseInteger(process.env.MOCK_SOCKET_PING_INTERVAL_MS, 25_000);
const pingTimeoutMs = parseInteger(process.env.MOCK_SOCKET_PING_TIMEOUT_MS, 20_000);
const autoplay = parseBoolean(process.env.MOCK_SOCKET_AUTOPLAY, true);
const loopScenario = parseBoolean(process.env.MOCK_SOCKET_LOOP, true);
const scenarioFile = process.env.MOCK_SOCKET_SCENARIO_FILE
  || path.join(__dirname, 'scenarios', 'default.json');

const clients = new Map();
const scenario = loadScenario(scenarioFile);

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return writeJson(res, 200, {
      ok: true,
      connected_clients: countConnectedClients(),
      autoplay,
      loop_scenario: loopScenario,
      scenario_steps: scenario.length,
    });
  }

  if (req.method === 'POST' && url.pathname === '/emit') {
    void readJsonBody(req)
      .then((body) => {
        const frame = buildEventFrame(body);
        const delivered = broadcastFrame(frame, body.event || 'raw');
        writeJson(res, 200, {
          ok: true,
          delivered,
          frame,
        });
      })
      .catch((err) => {
        writeJson(res, 400, {
          ok: false,
          error: err.message,
        });
      });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    return writeJson(res, 200, {
      ok: true,
      socket_path: socketPath,
      health: '/health',
      emit: {
        method: 'POST',
        path: '/emit',
        body: {
          event: 'newItem',
          item: {
            asin: 'MOCK-ASIN-999',
            queue: 'AFA',
            title: 'Manual test item',
            item_value: 9.99,
            currency: 'EUR',
          },
        },
      },
    });
  }

  res.writeHead(404);
  res.end('not found');
});

server.on('upgrade', (req, socket, head) => {
  if (!isWebSocketUpgrade(req)) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (!matchesSocketPath(url.pathname, socketPath)) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const websocketKey = req.headers['sec-websocket-key'];
  if (!websocketKey || Array.isArray(websocketKey)) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const acceptKey = crypto
    .createHash('sha1')
    .update(`${websocketKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');

  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '\r\n',
    ].join('\r\n'),
  );

  const connection = new MockSocketConnection(socket, {
    scenario,
    autoplay,
    loopScenario,
    pingIntervalMs,
    pingTimeoutMs,
  });
  clients.set(connection.id, connection);
  connection.start(head);
});

server.listen(port, host, () => {
  console.log(
    `[mock-socket] listening on http://${host}:${port} and ws://${host}:${port}${socketPath}`,
  );
  console.log(
    `[mock-socket] autoplay=${autoplay} loop=${loopScenario} scenario=${scenarioFile}`,
  );
});

function countConnectedClients() {
  let count = 0;
  for (const client of clients.values()) {
    if (client.namespaceConnected) {
      count += 1;
    }
  }
  return count;
}

function broadcastFrame(frame, label) {
  let delivered = 0;
  for (const client of clients.values()) {
    if (!client.namespaceConnected) {
      continue;
    }
    client.sendText(frame);
    delivered += 1;
  }
  console.log(`[mock-socket] broadcast ${label} -> ${delivered} client(s)`);
  return delivered;
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value, fallback) {
  if (value == null || value === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function normalizeSocketPath(value) {
  if (!value) {
    return '/socket.io/';
  }
  const withLeadingSlash = value.startsWith('/') ? value : `/${value}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
}

function matchesSocketPath(actualPath, expectedPath) {
  return actualPath === expectedPath || `${actualPath}/` === expectedPath;
}

function isWebSocketUpgrade(req) {
  const upgrade = req.headers.upgrade;
  return typeof upgrade === 'string' && upgrade.toLowerCase() === 'websocket';
}

function writeJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error(`invalid JSON: ${err.message}`));
      }
    });
    req.on('error', (err) => {
      reject(err);
    });
  });
}

function loadScenario(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error('scenario file must contain a JSON array');
    }
    return parsed.map(normalizeScenarioStep);
  } catch (err) {
    console.warn(`[mock-socket] could not load scenario ${filePath}: ${err.message}`);
    return DEFAULT_SCENARIO.map(normalizeScenarioStep);
  }
}

function normalizeScenarioStep(step) {
  if (!step || typeof step !== 'object') {
    throw new Error('scenario steps must be objects');
  }
  const delayMs = Math.max(0, Number(step.delayMs) || 0);
  const event = typeof step.event === 'string' ? step.event.trim() : '';
  if (!event) {
    throw new Error('scenario steps require an event');
  }
  return {
    delayMs,
    event,
    item: isPlainObject(step.item) ? step.item : undefined,
    payload: isPlainObject(step.payload) ? step.payload : undefined,
    rawFrame: typeof step.rawFrame === 'string' ? step.rawFrame : undefined,
  };
}

function buildEventFrame(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('request body must be a JSON object');
  }
  if (typeof input.rawFrame === 'string' && input.rawFrame.trim()) {
    return input.rawFrame;
  }

  const event = typeof input.event === 'string' ? input.event.trim() : '';
  if (!event) {
    throw new Error('event is required');
  }

  const payload = buildEventPayload(input);
  return `42${JSON.stringify([event, payload])}`;
}

function buildEventPayload(input) {
  if (isPlainObject(input.payload)) {
    return structuredClone(input.payload);
  }
  if (isPlainObject(input.item)) {
    return {
      item: withDynamicTimestamps(input.item),
    };
  }
  return {};
}

function withDynamicTimestamps(value) {
  const clone = structuredClone(value);
  if (isPlainObject(clone) && !clone.date_added && !clone.date && !clone.created_at) {
    clone.date_added = new Date().toISOString();
  }
  return clone;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function encodeFrame(opcode, payloadBuffer) {
  const payload = payloadBuffer || Buffer.alloc(0);
  let header;

  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length < 65_536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  return Buffer.concat([header, payload]);
}

function tryDecodeFrame(buffer) {
  if (buffer.length < 2) {
    return null;
  }

  const firstByte = buffer[0];
  const secondByte = buffer[1];
  const fin = (firstByte & 0x80) === 0x80;
  const opcode = firstByte & 0x0f;
  const masked = (secondByte & 0x80) === 0x80;
  let payloadLength = secondByte & 0x7f;
  let offset = 2;

  if (payloadLength === 126) {
    if (buffer.length < 4) {
      return null;
    }
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buffer.length < 10) {
      return null;
    }
    const asBigInt = buffer.readBigUInt64BE(2);
    if (asBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('frame too large');
    }
    payloadLength = Number(asBigInt);
    offset = 10;
  }

  let maskingKey = null;
  if (masked) {
    if (buffer.length < offset + 4) {
      return null;
    }
    maskingKey = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + payloadLength) {
    return null;
  }

  const payloadSlice = buffer.subarray(offset, offset + payloadLength);
  const payload = Buffer.allocUnsafe(payloadLength);
  for (let index = 0; index < payloadSlice.length; index += 1) {
    payload[index] = masked
      ? payloadSlice[index] ^ maskingKey[index % 4]
      : payloadSlice[index];
  }

  return {
    frame: {
      fin,
      opcode,
      payload,
    },
    remaining: buffer.subarray(offset + payloadLength),
  };
}

class MockSocketConnection {
  constructor(socket, options) {
    this.id = crypto.randomUUID();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.namespaceConnected = false;
    this.closed = false;
    this.awaitingPongSince = null;
    this.pingTimer = null;
    this.scenarioTimer = null;
    this.scenarioIndex = 0;
    this.options = options;
  }

  start(head) {
    console.log(`[mock-socket] client connected ${this.id}`);

    this.socket.on('data', (chunk) => {
      this.consumeBuffer(chunk);
    });

    this.socket.on('close', () => {
      this.cleanup('socket closed');
    });

    this.socket.on('end', () => {
      this.cleanup('socket ended');
    });

    this.socket.on('error', (err) => {
      console.warn(`[mock-socket] client error ${this.id}: ${err.message}`);
      this.cleanup('socket error');
    });

    this.sendText(
      `0${JSON.stringify({
        sid: this.id,
        upgrades: [],
        pingInterval: this.options.pingIntervalMs,
        pingTimeout: this.options.pingTimeoutMs,
        maxPayload: 1_000_000,
      })}`,
    );

    if (head && head.length > 0) {
      this.consumeBuffer(head);
    }
  }

  consumeBuffer(chunk) {
    if (this.closed) {
      return;
    }

    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length > 0) {
      const decoded = tryDecodeFrame(this.buffer);
      if (!decoded) {
        return;
      }
      this.buffer = decoded.remaining;
      this.handleFrame(decoded.frame);
    }
  }

  handleFrame(frame) {
    if (!frame.fin) {
      this.close(1003, 'fragmented frames not supported');
      return;
    }

    if (frame.opcode === 0x8) {
      this.close(1000, 'client closed');
      return;
    }

    if (frame.opcode === 0x9) {
      this.socket.write(encodeFrame(0x0a, frame.payload));
      return;
    }

    if (frame.opcode === 0x0a) {
      return;
    }

    if (frame.opcode !== 0x1) {
      return;
    }

    const message = frame.payload.toString('utf8');

    if (message === '3') {
      this.awaitingPongSince = null;
      return;
    }

    if (message === '40' || message.startsWith('40')) {
      this.namespaceConnected = true;
      this.sendText('40{"sid":"mock-socket"}');
      this.startHeartbeat();
      this.startScenarioIfNeeded();
      return;
    }
  }

  startHeartbeat() {
    if (this.pingTimer) {
      return;
    }

    this.pingTimer = setInterval(() => {
      if (this.closed) {
        return;
      }

      if (
        this.awaitingPongSince !== null
        && Date.now() - this.awaitingPongSince > this.options.pingTimeoutMs
      ) {
        console.warn(`[mock-socket] client ${this.id} did not answer ping in time`);
        this.close(1001, 'ping timeout');
        return;
      }

      this.awaitingPongSince = Date.now();
      this.sendText('2');
    }, this.options.pingIntervalMs);
  }

  startScenarioIfNeeded() {
    if (!this.options.autoplay || this.scenarioTimer) {
      return;
    }
    this.scenarioIndex = 0;
    this.scheduleNextScenarioStep();
  }

  scheduleNextScenarioStep() {
    if (this.closed || !this.namespaceConnected) {
      return;
    }

    if (this.scenarioIndex >= this.options.scenario.length) {
      if (!this.options.loopScenario) {
        this.scenarioTimer = null;
        return;
      }
      this.scenarioIndex = 0;
    }

    const step = this.options.scenario[this.scenarioIndex];
    this.scenarioTimer = setTimeout(() => {
      this.scenarioTimer = null;
      if (this.closed || !this.namespaceConnected) {
        return;
      }

      const frame = step.rawFrame || buildEventFrame(step);
      this.sendText(frame);
      console.log(`[mock-socket] scenario step ${step.event} -> ${this.id}`);
      this.scenarioIndex += 1;
      this.scheduleNextScenarioStep();
    }, step.delayMs);
  }

  sendText(text) {
    if (this.closed) {
      return;
    }
    this.socket.write(encodeFrame(0x1, Buffer.from(text)));
  }

  close(code, reason) {
    if (this.closed) {
      return;
    }

    const reasonBuffer = Buffer.from(reason || '');
    const payload = Buffer.allocUnsafe(2 + reasonBuffer.length);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);

    try {
      this.socket.write(encodeFrame(0x8, payload));
    } catch {
      // Ignore close write failures.
    }

    this.socket.end();
    this.cleanup(reason || 'closed');
  }

  cleanup(reason) {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.namespaceConnected = false;
    this.awaitingPongSince = null;

    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    if (this.scenarioTimer) {
      clearTimeout(this.scenarioTimer);
      this.scenarioTimer = null;
    }

    clients.delete(this.id);
    console.log(`[mock-socket] client disconnected ${this.id}: ${reason}`);
  }
}
