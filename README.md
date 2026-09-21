# MoodlIA Sync MCP

`moodlia-sync-mcp` is an MCP coordinator for one-way course-content synchronization between Moodle sites. Each endpoint may use Moodle Core web services, the MoodlIA plugin, or both. Provider selection is capability-based and is frozen into every approved action.

It requires Node.js 22.13 or later because its durable state store uses the
built-in SQLite API without experimental process flags.

The coordinator does not send Moodle tokens or binary files through MCP tool arguments or results. Profiles reference environment variables, and an allowlist restricts profile pairs, course IDs, and effects.

## Status

The current preview synchronizes verified course metadata, hidden target-course creation, sections through MoodlIA, groups and grouping membership, Pages/Labels/URLs on creation, file resources and folders on creation, Books with chapter files, selected assignment definitions and new rubrics, and new Workshop grading forms. Existing unsupported authoring changes and unsafe transformations are reported before writing. It does not use Moodle backup files.

## Configuration

Create `.moodle-profiles.json`:

```json
{
  "schema_version": 1,
  "profiles": {
    "source": {
      "url": "https://source.example.edu",
      "backend": "auto",
      "credentials": {
        "core": { "token_env": "SOURCE_CORE_TOKEN" },
        "moodlia": { "token_env": "SOURCE_MOODLIA_TOKEN" }
      }
    },
    "target": {
      "url": "https://target.example.edu",
      "backend": "auto",
      "credentials": {
        "core": { "token_env": "TARGET_CORE_TOKEN" },
        "moodlia": { "token_env": "TARGET_MOODLIA_TOKEN" }
      }
    }
  }
}
```

Create `.moodle-sync-policy.json`:

```json
{
  "schema_version": 1,
  "allowed_profiles": ["source", "target"],
  "allowed_pairs": [
    {
      "source": "source",
      "target": "target",
      "source_courses": [42],
      "target_courses": [81],
      "target_categories": [7],
      "effects": ["content.read", "content.write"]
    }
  ]
}
```

Set `MOODLIA_SYNC_CONFIG`, `MOODLIA_SYNC_POLICY`, and optionally `MOODLIA_SYNC_STATE`. Start the stdio server with `npx moodlia-sync-mcp`.

For Streamable HTTP, set a random `MOODLIA_SYNC_BEARER_TOKEN` of at least 32 bytes and run `npx moodlia-sync-mcp-http`. It binds to `127.0.0.1:3333` by default. Put a TLS-authenticated reverse proxy in front of it for remote clients, set `MOODLIA_SYNC_ALLOWED_HOSTS`, and never expose the plain HTTP listener directly. The bearer token authenticates the client to the coordinator; Moodle tokens remain separate downstream credentials.

## Approval boundary

`sync_plan_course` is read-only. `sync_apply_plan` accepts only a plan that was approved outside MCP and stored in the same SQLite state database:

```powershell
moodlia course sync `
  --approve-plan ".moodle-sync\plans\PLAN_ID.json" `
  --state ".moodle-sync\coordinator.sqlite" `
  --yes
```

Approval is bound to the complete plan digest, expires with the plan, and is consumed before execution. A model-provided boolean is never treated as human authorization.

## MCP tools

- `sync_list_profiles`
- `sync_discover_capabilities`
- `sync_plan_course`
- `sync_apply_plan`
- `sync_get_job`
- `sync_cancel_job`
- `sync_resume_job`
- `sync_verify_course`
- `sync_get_conflicts`
- `sync_resolve_conflict`
- `sync_get_history`

Jobs, action attempts, approvals, mappings, baselines, and leases are durable in SQLite. On restart, in-flight jobs become `interrupted` and must be reconciled and explicitly re-approved before resume. Timeout outcomes are marked `unknown_outcome`, not retried blindly.

All documentation, schemas, source identifiers, and source comments are in English.
