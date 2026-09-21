#!/usr/bin/env node
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createSyncCoordinator } from './coordinator.mjs';
import { createMcpServer } from './mcp-server.mjs';

function requiredEnvironment(environment, name) {
  const value = environment[name];
  if (!value) throw new TypeError(`${name} is required.`);
  return value;
}

export function tokenMatches(header, expected) {
  const supplied = Buffer.from(String(header ?? '').replace(/^Bearer\s+/i, ''));
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

export function createAuthenticatedMcpApp({ coordinator, bearerToken, host = '127.0.0.1', allowedHosts = [] }) {
  if (!coordinator) throw new TypeError('coordinator is required.');
  if (Buffer.byteLength(String(bearerToken ?? '')) < 32) {
    throw new TypeError('bearerToken must contain at least 32 bytes.');
  }
  const app = createMcpExpressApp({ host, ...(allowedHosts.length > 0 ? { allowedHosts } : {}) });
  const sessions = new Map();
  app.get('/health', (_request, response) => response.json({ status: 'ok' }));
  app.use('/mcp', (request, response, next) => {
    if (!tokenMatches(request.headers.authorization, bearerToken)) {
      response.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'unauthorized' });
      return;
    }
    next();
  });
  app.post('/mcp', async (request, response) => {
    try {
      const sessionId = request.headers['mcp-session-id'];
      let session = sessionId ? sessions.get(String(sessionId)) : null;
      if (!session && !sessionId && isInitializeRequest(request.body)) {
        const server = createMcpServer(coordinator);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => sessions.set(id, { server, transport })
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await server.connect(transport);
        session = { server, transport };
      }
      if (!session) {
        response.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Invalid MCP session.' }, id: null });
        return;
      }
      await session.transport.handleRequest(request, response, request.body);
    } catch {
      if (!response.headersSent) {
        response.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error.' }, id: null });
      }
    }
  });
  for (const method of ['get', 'delete']) {
    app[method]('/mcp', async (request, response) => {
      const session = sessions.get(String(request.headers['mcp-session-id'] ?? ''));
      if (!session) {
        response.status(400).send('Invalid MCP session.');
        return;
      }
      await session.transport.handleRequest(request, response);
    });
  }
  return { app, sessions };
}

export function startHttpServer(environment = process.env) {
  const host = environment.MOODLIA_SYNC_HOST ?? '127.0.0.1';
  const port = Number(environment.MOODLIA_SYNC_PORT ?? 3333);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('MOODLIA_SYNC_PORT is invalid.');
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)
    && environment.MOODLIA_SYNC_ALLOW_INSECURE_HTTP !== 'true') {
    throw new TypeError('Non-loopback HTTP requires explicit opt-in and a TLS reverse proxy.');
  }
  const bearerToken = requiredEnvironment(environment, 'MOODLIA_SYNC_BEARER_TOKEN');
  const coordinator = createSyncCoordinator({
    configPath: requiredEnvironment(environment, 'MOODLIA_SYNC_CONFIG'),
    policyPath: requiredEnvironment(environment, 'MOODLIA_SYNC_POLICY'),
    statePath: environment.MOODLIA_SYNC_STATE ?? '.moodle-sync/coordinator.sqlite',
    environment
  });
  const allowedHosts = (environment.MOODLIA_SYNC_ALLOWED_HOSTS ?? '')
    .split(',').map((value) => value.trim()).filter(Boolean);
  const { app, sessions } = createAuthenticatedMcpApp({ coordinator, bearerToken, host, allowedHosts });
  const httpServer = app.listen(port, host);
  return { coordinator, httpServer, sessions };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = startHttpServer();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      runtime.httpServer.close();
      await Promise.allSettled([...runtime.sessions.values()].map(({ server }) => server.close()));
      await runtime.coordinator.close();
      process.exit(0);
    });
  }
}
