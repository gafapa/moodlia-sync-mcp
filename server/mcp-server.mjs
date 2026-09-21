import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

function jsonResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

export function createMcpServer(coordinator) {
  const server = new McpServer({ name: 'moodlia-sync', version: '0.1.0' });

  server.registerTool('sync_list_profiles', {
    description: 'List authorized Moodle profiles without returning credentials.', inputSchema: {}
  }, async () => jsonResult({ profiles: coordinator.listProfiles() }));
  server.registerTool('sync_discover_capabilities', {
    description: 'Discover live synchronization capabilities for an authorized profile.',
    inputSchema: { profile: z.string().min(1), course_id: z.number().int().positive().optional() }
  }, async (input) => jsonResult(await coordinator.discoverCapabilities(input)));
  server.registerTool('sync_plan_course', {
    description: 'Create an immutable read-only plan for one-way course synchronization.',
    inputSchema: {
      source_profile: z.string().min(1), source_course_id: z.number().int().positive(),
      target_profile: z.string().min(1), target_course_id: z.number().int().positive().optional(),
      create_target_category_id: z.number().int().positive().optional(),
      target_shortname: z.string().min(1).optional(),
      unsupported_policy: z.enum(['error', 'skip', 'degrade']).optional(),
      conflict_policy: z.enum(['abort', 'source-wins', 'target-wins', 'report']).optional()
    }
  }, async (input) => jsonResult(await coordinator.planCourse(input)));
  server.registerTool('sync_apply_plan', {
    description: 'Queue an externally approved immutable plan.',
    inputSchema: { plan_id: z.string().min(1), plan_digest: z.string().min(1) }
  }, async (input) => jsonResult(coordinator.startPlan(input)));
  server.registerTool('sync_get_plan', {
    description: 'Read one authorized immutable plan section with bounded pagination.',
    inputSchema: {
      plan_id: z.string().min(1),
      section: z.enum([
        'actions', 'conflicts', 'divergences', 'unsupported', 'skipped', 'unchanged', 'unknown'
      ]).optional(),
      cursor: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(100).optional()
    }
  }, async (input) => jsonResult(coordinator.getPlan(input)));
  server.registerTool('sync_get_job', {
    description: 'Read a synchronization job and its verification status.',
    inputSchema: { job_id: z.string().min(1) }
  }, async ({ job_id }) => jsonResult(coordinator.getJob(job_id)));
  server.registerTool('sync_cancel_job', {
    description: 'Request that a running coordinator stop scheduling new actions.',
    inputSchema: { job_id: z.string().min(1) }
  }, async ({ job_id }) => jsonResult(coordinator.requestCancellation(job_id)));
  server.registerTool('sync_resume_job', {
    description: 'Resume an interrupted job after reconciliation and exact external re-approval.',
    inputSchema: { job_id: z.string().min(1), plan_digest: z.string().min(1) }
  }, async (input) => jsonResult(coordinator.resumeJob(input)));
  server.registerTool('sync_get_conflicts', {
    description: 'Read conflicts and target-only divergences in an immutable plan.',
    inputSchema: { plan_id: z.string().min(1) }
  }, async ({ plan_id }) => jsonResult(coordinator.getConflicts(plan_id)));
  server.registerTool('sync_resolve_conflict', {
    description: 'Replan current conflicts with an explicit policy; no writes are performed.',
    inputSchema: { plan_id: z.string().min(1), resolution: z.enum(['source-wins', 'target-wins']) }
  }, async (input) => jsonResult(await coordinator.resolveConflicts(input)));
  server.registerTool('sync_verify_course', {
    description: 'Re-read and verify a synchronization job without performing content writes.',
    inputSchema: { plan_id: z.string().min(1), job_id: z.string().min(1).optional() }
  }, async (input) => jsonResult(await coordinator.verifyCourse(input)));
  server.registerTool('sync_get_history', {
    description: 'List durable jobs visible to this policy-scoped coordinator.', inputSchema: {}
  }, async () => jsonResult({ jobs: coordinator.listHistory() }));

  return server;
}
