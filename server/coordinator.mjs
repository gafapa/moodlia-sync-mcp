import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createAdaptiveSiteAdapter } from 'moodlia/adaptive';
import { loadContractFromFile } from 'moodlia';
import { describeProfile, loadProfiles, resolveProfile } from 'moodle-core-cli/profiles';
import { createCourseSyncEngine, SqliteSyncStateStore, validateSyncPlan } from 'moodle-core-cli/sync';

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object.`);
  return value;
}

function loadJson(filePath, name) {
  return assertObject(JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8').replace(/^\uFEFF/, '')), name);
}

function defaultContractPath() {
  return fileURLToPath(import.meta.resolve('moodlia/contract'));
}

export function loadCoordinatorPolicy(policyPath) {
  const policy = loadJson(policyPath, 'coordinator policy');
  if (policy.schema_version !== 1 || !Array.isArray(policy.allowed_profiles) || !Array.isArray(policy.allowed_pairs)) {
    throw new TypeError('Coordinator policy must use schema version 1 and define allowed_profiles and allowed_pairs.');
  }
  return policy;
}

export class SyncCoordinator {
  constructor({ configPath, policyPath, statePath, contractPath = defaultContractPath(), environment = process.env }) {
    this.profiles = loadProfiles(configPath);
    this.policy = loadCoordinatorPolicy(policyPath);
    this.environment = environment;
    this.contract = loadContractFromFile(contractPath);
    fs.mkdirSync(path.dirname(path.resolve(statePath)), { recursive: true, mode: 0o700 });
    this.store = new SqliteSyncStateStore(statePath);
    this.engine = createCourseSyncEngine({ stateStore: this.store });
    this.workers = new Map();
    for (const job of this.store.listJobs()) {
      if (!['queued', 'running', 'cancel_requested'].includes(job.status)) continue;
      job.status = 'interrupted';
      job.updated_at = new Date().toISOString();
      job.error = { code: 'coordinator_restarted', message: 'The coordinator stopped before this job completed.' };
      this.store.saveJob(job);
    }
  }

  assertProfileAllowed(name) {
    if (!this.policy.allowed_profiles.includes(name)) throw new TypeError(`Profile ${name} is not authorized for this coordinator.`);
  }

  pairPolicy(sourceProfile, targetProfile, sourceCourseId, targetCourseId, effect, targetCategoryId = null) {
    this.assertProfileAllowed(sourceProfile);
    this.assertProfileAllowed(targetProfile);
    const pair = this.policy.allowed_pairs.find((entry) =>
      entry.source === sourceProfile
      && entry.target === targetProfile
      && (entry.source_courses === '*' || entry.source_courses?.includes(sourceCourseId))
      && (targetCourseId === null
        ? (entry.target_categories === '*' || entry.target_categories?.includes(targetCategoryId))
        : (entry.target_courses === '*' || entry.target_courses?.includes(targetCourseId))));
    if (!pair || !pair.effects?.includes(effect)) {
      throw new TypeError('The requested profile pair, course IDs, or effect is not authorized.');
    }
    return pair;
  }

  profile(name) {
    this.assertProfileAllowed(name);
    return resolveProfile(this.profiles, name, this.environment);
  }

  adapter(name, allowWrite = false) {
    return createAdaptiveSiteAdapter({
      profile: this.profile(name),
      moodliaContract: this.contract,
      allowWrite
    });
  }

  listProfiles() {
    return this.policy.allowed_profiles.map((name) => describeProfile(this.profiles.get(name)));
  }

  async discoverCapabilities({ profile, course_id }) {
    const adapter = this.adapter(profile);
    return {
      profile: describeProfile(this.profiles.get(profile)),
      discovery: await adapter.discoverSite(),
      capabilities: await adapter.syncCapabilities({ courseId: course_id })
    };
  }

  async planCourse({
    source_profile, source_course_id, target_profile, target_course_id,
    create_target_category_id, target_shortname, unsupported_policy, conflict_policy
  }) {
    const createsTarget = create_target_category_id !== undefined;
    if ((target_course_id !== undefined) === createsTarget) {
      throw new TypeError('Provide exactly one target_course_id or create_target_category_id.');
    }
    if (createsTarget && !String(target_shortname ?? '').trim()) {
      throw new TypeError('target_shortname is required when creating a target course.');
    }
    const targetCourseId = target_course_id ?? null;
    this.pairPolicy(
      source_profile, target_profile, source_course_id, targetCourseId, 'content.read',
      create_target_category_id ?? null
    );
    return this.engine.plan({
      sourceAdapter: this.adapter(source_profile),
      targetAdapter: this.adapter(target_profile),
      sourceCourseId: source_course_id,
      targetCourseId,
      targetCreation: createsTarget ? {
        category_id: create_target_category_id,
        shortname: String(target_shortname)
      } : null,
      policies: { unsupported: unsupported_policy ?? 'error', conflict: conflict_policy ?? 'abort' }
    });
  }

  authorizePlan(plan_id, plan_digest) {
    const plan = this.store.getPlan(plan_id);
    if (!plan) throw new TypeError(`Unknown sync plan: ${plan_id}.`);
    validateSyncPlan(plan);
    this.pairPolicy(
      plan.source.site.profile,
      plan.target.site.profile,
      plan.source.course_id,
      plan.target.course_id,
      'content.write',
      plan.target.creation?.category_id ?? null
    );
    return plan;
  }

  claimApprovedJob(plan, planDigest, job) {
    if (!this.store.consumeApprovalAndSaveJob(plan.plan_id, planDigest, job)) {
      throw new TypeError('This exact plan has no unconsumed external approval or it has expired.');
    }
    return job;
  }

  trackWorker(jobId, promise) {
    this.workers.set(jobId, promise);
    promise.finally(() => this.workers.delete(jobId)).catch(() => {});
    return promise;
  }

  async applyPlan({ plan_id, plan_digest }) {
    const plan = this.authorizePlan(plan_id, plan_digest);
    const job = this.claimApprovedJob(plan, plan_digest, {
      schema_version: 1,
      job_id: randomUUID(),
      plan_id,
      status: 'queued',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      results: []
    });
    return this.engine.apply({
      planId: plan_id,
      planDigest: plan_digest,
      sourceAdapter: this.adapter(plan.source.site.profile),
      targetAdapter: this.adapter(plan.target.site.profile, true),
      jobId: job.job_id
    });
  }

  startPlan({ plan_id, plan_digest }) {
    const plan = this.authorizePlan(plan_id, plan_digest);
    const job = {
      schema_version: 1,
      job_id: randomUUID(),
      plan_id,
      status: 'queued',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      results: []
    };
    this.claimApprovedJob(plan, plan_digest, job);
    setImmediate(() => {
      const worker = this.engine.apply({
        planId: plan_id,
        planDigest: plan_digest,
        sourceAdapter: this.adapter(plan.source.site.profile),
        targetAdapter: this.adapter(plan.target.site.profile, true),
        jobId: job.job_id
      }).catch((error) => {
        const current = this.store.getJob(job.job_id) ?? job;
        if (['failed', 'partially_applied', 'verification_failed', 'unknown_outcome', 'cancelled'].includes(current.status)) return;
        current.status = 'failed';
        current.error = { name: error.name, code: error.code, message: error.message };
        current.updated_at = new Date().toISOString();
        this.store.saveJob(current);
      });
      this.trackWorker(job.job_id, worker);
    });
    return job;
  }

  getJob(jobId) {
    const job = this.store.getJob(jobId);
    if (!job) throw new TypeError(`Unknown sync job: ${jobId}.`);
    return job;
  }

  requestCancellation(jobId) {
    const job = this.getJob(jobId);
    if (!['queued', 'running'].includes(job.status)) return job;
    job.status = 'cancel_requested';
    job.updated_at = new Date().toISOString();
    this.store.saveJob(job);
    return job;
  }

  resumeJob({ job_id, plan_digest }) {
    const existingJob = this.getJob(job_id);
    if (!['failed', 'partially_applied', 'verification_failed', 'unknown_outcome', 'cancelled', 'interrupted'].includes(existingJob.status)) {
      throw new TypeError('Only an interrupted or failed job can be resumed.');
    }
    const plan = this.authorizePlan(existingJob.plan_id, plan_digest);
    existingJob.status = 'queued';
    existingJob.updated_at = new Date().toISOString();
    this.claimApprovedJob(plan, plan_digest, existingJob);
    setImmediate(() => {
      const worker = this.engine.apply({
        planId: plan.plan_id,
        planDigest: plan_digest,
        sourceAdapter: this.adapter(plan.source.site.profile),
        targetAdapter: this.adapter(plan.target.site.profile, true),
        resumeJobId: job_id
      }).catch((error) => {
        const current = this.store.getJob(job_id) ?? existingJob;
        if (['failed', 'partially_applied', 'verification_failed', 'unknown_outcome', 'cancelled'].includes(current.status)) return;
        current.status = current.results?.length > 0 ? 'partially_applied' : 'failed';
        current.error = { name: error.name, code: error.code, message: error.message };
        current.updated_at = new Date().toISOString();
        this.store.saveJob(current);
      });
      this.trackWorker(job_id, worker);
    });
    return existingJob;
  }

  listHistory() {
    return this.store.listJobs();
  }

  getConflicts(planId) {
    const plan = this.store.getPlan(planId);
    if (!plan) throw new TypeError(`Unknown sync plan: ${planId}.`);
    this.pairPolicy(
      plan.source.site.profile,
      plan.target.site.profile,
      plan.source.course_id,
      plan.target.course_id,
      'content.read',
      plan.target.creation?.category_id ?? null
    );
    return { plan_id: planId, conflicts: plan.conflicts ?? [], divergences: plan.divergences ?? [] };
  }

  async resolveConflicts({ plan_id: planId, resolution }) {
    if (!['source-wins', 'target-wins'].includes(resolution)) {
      throw new TypeError('resolution must be source-wins or target-wins.');
    }
    const plan = this.store.getPlan(planId);
    if (!plan) throw new TypeError(`Unknown sync plan: ${planId}.`);
    const binding = this.store.getBinding(plan.binding_id);
    const targetCourseId = binding?.target?.course_id ?? plan.target.course_id;
    this.pairPolicy(
      plan.source.site.profile,
      plan.target.site.profile,
      plan.source.course_id,
      targetCourseId,
      'content.read',
      plan.target.creation?.category_id ?? null
    );
    return this.engine.plan({
      sourceAdapter: this.adapter(plan.source.site.profile),
      targetAdapter: this.adapter(plan.target.site.profile),
      sourceCourseId: plan.source.course_id,
      targetCourseId,
      targetCreation: targetCourseId ? null : plan.target.creation,
      policies: { unsupported: plan.policies.unsupported, conflict: resolution }
    });
  }

  async verifyCourse({ plan_id: planId, job_id: jobId }) {
    const plan = this.store.getPlan(planId);
    if (!plan) throw new TypeError(`Unknown sync plan: ${planId}.`);
    const binding = this.store.getBinding(plan.binding_id);
    const targetCourseId = binding?.target?.course_id ?? plan.target.course_id;
    this.pairPolicy(
      plan.source.site.profile,
      plan.target.site.profile,
      plan.source.course_id,
      targetCourseId,
      'content.read',
      plan.target.creation?.category_id ?? null
    );
    return this.engine.verify({
      planId,
      jobId,
      targetAdapter: this.adapter(plan.target.site.profile)
    });
  }

  async close() {
    for (const jobId of this.workers.keys()) this.requestCancellation(jobId);
    await Promise.allSettled([...this.workers.values()]);
    this.store.close();
  }
}

export function createSyncCoordinator(options) {
  return new SyncCoordinator(options);
}
