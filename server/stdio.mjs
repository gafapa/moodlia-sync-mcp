#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createSyncCoordinator } from './coordinator.mjs';
import { createMcpServer } from './mcp-server.mjs';

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new TypeError(`${name} is required.`);
  return value;
}

function printHelp() {
  process.stdout.write(`Usage: moodlia-sync-mcp\n\nEnvironment:\n  MOODLIA_SYNC_CONFIG   Profile configuration JSON path (required)\n  MOODLIA_SYNC_POLICY   Coordinator policy JSON path (required)\n  MOODLIA_SYNC_STATE    SQLite state path (default: .moodle-sync/coordinator.sqlite)\n`);
}

if (process.argv.slice(2).some((argument) => argument === '--help' || argument === '-h')) {
  printHelp();
  process.exit(0);
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
