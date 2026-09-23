# Changelog

## 0.1.2 - unreleased

- Deprecate this package in favour of the `moodlia-sync` CLI, which replaces
  every MCP tool and consumes approvals atomically. No functional changes.

## 0.1.1 - 2026-09-22

- Require `moodlia@^0.3.7` and `moodle-core-cli@^0.3.6`, the versions qualified
  end to end between disposable Moodle 4.5 and 5.3 sites, so fresh coordinator
  installations receive the SQLite lifecycle, resume routing, verification, and
  `@@PLUGINFILE@@` canonicalization fixes.

## 0.1.0 - 2026-09-21

- Initial public release of the local MCP coordinator for policy-bound
  cross-site synchronization.
