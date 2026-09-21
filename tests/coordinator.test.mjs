import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { contentDigest } from 'moodle-core-cli/sync';
import { loadCoordinatorPolicy, SyncCoordinator } from '../server/coordinator.mjs';
import { createMcpServer } from '../server/mcp-server.mjs';
import { createAuthenticatedMcpApp, tokenMatches } from '../server/http.mjs';

test('policy loader requires explicit profiles and pairs', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'moodlia-sync-policy-'));
  const policyPath = path.join(directory, 'policy.json');
  try {
    await fs.writeFile(policyPath, JSON.stringify({
      schema_version: 1,
      allowed_profiles: ['source', 'target'],
      allowed_pairs: []
    }));
    assert.deepEqual(loadCoordinatorPolicy(policyPath).allowed_profiles, ['source', 'target']);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('pair policy binds both course IDs and effects', () => {
  const coordinator = Object.create(SyncCoordinator.prototype);
  coordinator.policy = {
    allowed_profiles: ['source', 'target'],
    allowed_pairs: [{
      source: 'source', target: 'target', source_courses: [1], target_courses: [2], effects: ['content.read']
    }]
  };
  assert.equal(coordinator.pairPolicy('source', 'target', 1, 2, 'content.read').source, 'source');
  assert.throws(() => coordinator.pairPolicy('source', 'target', 1, 2, 'content.write'), /not authorized/);
  assert.throws(() => coordinator.pairPolicy('source', 'target', 9, 2, 'content.read'), /not authorized/);
  coordinator.policy.allowed_pairs[0].target_categories = [4];
  assert.equal(coordinator.pairPolicy('source', 'target', 1, null, 'content.read', 4).target, 'target');
  assert.throws(() => coordinator.pairPolicy('source', 'target', 1, null, 'content.read', 5), /not authorized/);
});

test('coordinator restart marks durable in-flight jobs as interrupted', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'moodlia-sync-restart-'));
  const configPath = path.join(directory, 'profiles.json');
  const policyPath = path.join(directory, 'policy.json');
  const statePath = path.join(directory, 'state.sqlite');
  try {
    await fs.writeFile(configPath, JSON.stringify({
      schema_version: 1,
      profiles: {
        source: { url: 'https://source.example', backend: 'core', credentials: { core: { token_env: 'SOURCE_TOKEN' } } },
        target: { url: 'https://target.example', backend: 'core', credentials: { core: { token_env: 'TARGET_TOKEN' } } }
      }
    }));
    await fs.writeFile(policyPath, JSON.stringify({
      schema_version: 1,
      allowed_profiles: ['source', 'target'],
      allowed_pairs: []
    }));
    const options = {
      configPath, policyPath, statePath,
      environment: { SOURCE_TOKEN: 'source-secret', TARGET_TOKEN: 'target-secret' }
    };
    const first = new SyncCoordinator(options);
    first.store.saveJob({
      schema_version: 1, job_id: 'job-running', plan_id: 'plan-1', status: 'running',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), results: []
    });
    await first.close();
    const restarted = new SyncCoordinator(options);
    assert.equal(restarted.getJob('job-running').status, 'interrupted');
    assert.equal(restarted.getJob('job-running').error.code, 'coordinator_restarted');
    await restarted.close();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('MCP apply consumes an exact external approval before execution', async () => {
  const unsignedPlan = {
    schema_version: 2,
    plan_id: 'plan-1',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    source: { site: { profile: 'source' }, course_id: 1 },
    target: { site: { profile: 'target' }, course_id: 2 }
  };
  const plan = { ...unsignedPlan, digest: contentDigest(unsignedPlan) };
  const approvals = new Map([['plan-1', {
    plan_id: 'plan-1', digest: plan.digest, expires_at: plan.expires_at, consumed_at: null
  }]]);
  const coordinator = Object.create(SyncCoordinator.prototype);
  coordinator.store = {
    getPlan: () => plan,
    consumeApprovalAndSaveJob(id, digest, job) {
      const approval = approvals.get(id);
      if (!approval || approval.digest !== digest || approval.consumed_at) return false;
      approvals.set(id, { ...approval, consumed_at: new Date().toISOString() });
      this.job = job;
      return true;
    }
  };
  coordinator.pairPolicy = () => ({});
  coordinator.adapter = (name) => ({ name });
  coordinator.engine = { async apply({ jobId }) { return { status: 'succeeded', job_id: jobId }; } };
  const result = await coordinator.applyPlan({ plan_id: 'plan-1', plan_digest: plan.digest });
  assert.equal(result.status, 'succeeded');
  assert.ok(approvals.get('plan-1').consumed_at);
  await assert.rejects(
    () => coordinator.applyPlan({ plan_id: 'plan-1', plan_digest: plan.digest }),
    /no unconsumed external approval/
  );
});

test('coordinator exposes only policy-authorized plan conflicts', () => {
  const coordinator = Object.create(SyncCoordinator.prototype);
  coordinator.store = {
    getPlan: () => ({
      source: { site: { profile: 'source' }, course_id: 1 },
      target: { site: { profile: 'target' }, course_id: 2 },
      conflicts: [{ field: 'summary' }],
      divergences: [{ field: 'fullname' }]
    })
  };
  coordinator.pairPolicy = () => ({});
  assert.deepEqual(coordinator.getConflicts('plan-1'), {
    plan_id: 'plan-1',
    conflicts: [{ field: 'summary' }],
    divergences: [{ field: 'fullname' }]
  });
});

test('course planning preserves advanced actions from the shared engine', async () => {
  const coordinator = Object.create(SyncCoordinator.prototype);
  coordinator.pairPolicy = () => ({});
  coordinator.adapter = (name) => ({ profile: name });
  const advancedAction = {
    action_id: 'grade-action',
    kind: 'grade_item.update',
    module_source_key: 'module:20',
    fields: { grade_pass: 50 }
  };
  coordinator.engine = {
    async plan(input) {
      assert.equal(input.sourceAdapter.profile, 'source');
      assert.equal(input.targetAdapter.profile, 'target');
      return { schema_version: 2, actions: [advancedAction] };
    }
  };

  const plan = await coordinator.planCourse({
    source_profile: 'source', source_course_id: 1,
    target_profile: 'target', target_course_id: 2
  });
  assert.deepEqual(plan.actions, [advancedAction]);
});

test('MCP schemas expose the complete durable synchronization lifecycle', async () => {
  const coordinator = { listProfiles: () => [] };
  const server = createMcpServer(coordinator);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      'sync_apply_plan', 'sync_cancel_job', 'sync_discover_capabilities', 'sync_get_conflicts',
      'sync_get_history', 'sync_get_job', 'sync_get_plan', 'sync_list_profiles', 'sync_plan_course',
      'sync_resolve_conflict', 'sync_resume_job', 'sync_verify_course'
    ]);
    const result = await client.callTool({ name: 'sync_list_profiles', arguments: {} });
    assert.deepEqual(result.structuredContent, { profiles: [] });
  } finally {
    await client.close();
    await server.close();
  }
});

test('packaged executables show help without configuration or credentials', () => {
  for (const entrypoint of ['stdio.mjs', 'http.mjs']) {
    const result = spawnSync(process.execPath, [path.resolve('server', entrypoint), '--help'], {
      encoding: 'utf8',
      env: {}
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: moodlia-sync-mcp/);
    assert.doesNotMatch(result.stderr, /MOODLIA_SYNC_CONFIG is required/);
  }
});

test('plan retrieval is policy-scoped and paginated', () => {
  const coordinator = Object.create(SyncCoordinator.prototype);
  coordinator.policy = {
    allowed_profiles: ['source', 'target'],
    allowed_pairs: [{
      source: 'source', target: 'target', source_courses: [1], target_courses: [2], effects: ['content.read']
    }]
  };
  coordinator.store = {
    getPlan() {
      return {
        schema_version: 2,
        plan_id: 'plan-1',
        digest: 'digest',
        source: { site: { profile: 'source' }, course_id: 1 },
        target: { site: { profile: 'target' }, course_id: 2 },
        actions: [{ action_id: 'a' }, { action_id: 'b' }, { action_id: 'c' }],
        unsupported: [{ reason: 'gap' }]
      };
    }
  };

  const page = coordinator.getPlan({ plan_id: 'plan-1', cursor: 1, limit: 1 });
  assert.deepEqual(page.items, [{ action_id: 'b' }]);
  assert.equal(page.next_cursor, 2);
  assert.equal(page.total, 3);
  const gaps = coordinator.getPlan({ plan_id: 'plan-1', section: 'unsupported' });
  assert.equal(gaps.items[0].reason, 'gap');
  assert.throws(() => coordinator.getPlan({ plan_id: 'plan-1', limit: 101 }), /1 to 100/);
});

test('HTTP transport protects MCP routes and leaves health credential-free', async () => {
  const bearerToken = 'test-token-with-at-least-thirty-two-bytes';
  assert.equal(tokenMatches(`Bearer ${bearerToken}`, bearerToken), true);
  assert.equal(tokenMatches('Bearer incorrect', bearerToken), false);
  const { app } = createAuthenticatedMcpApp({ coordinator: {}, bearerToken });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });
    const unauthorized = await fetch(`${baseUrl}/mcp`, { method: 'POST' });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get('www-authenticate'), 'Bearer');
    const invalidSession = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 })
    });
    assert.equal(invalidSession.status, 400);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
