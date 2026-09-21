#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createSyncCoordinator } from './coordinator.mjs';
import { createMcpServer } from './mcp-server.mjs';

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new TypeError(`${name} is required.`);
  return value;
}

const coordinator = createSyncCoordinator({
  configPath: requiredEnvironment('MOODLIA_SYNC_CONFIG'),
  policyPath: requiredEnvironment('MOODLIA_SYNC_POLICY'),
  statePath: process.env.MOODLIA_SYNC_STATE ?? '.moodle-sync/coordinator.sqlite'
});
const server = createMcpServer(coordinator);
await server.connect(new StdioServerTransport());

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await coordinator.close();
    await server.close();
    process.exit(0);
  });
}
