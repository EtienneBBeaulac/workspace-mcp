# Implementation Plan: `run_crossproject` Tool

## Problem Statement
The workspace MCP abstracts filesystem paths for read/write/edit/search/list operations via `workspace: "ios"`, but agents fall back to hardcoded paths (`cd ~/git/zillow/ZillowMap && ...`) for command execution. This breaks the abstraction and requires the agent to know physical workspace paths.

## Acceptance Criteria
1. New `run_crossproject` tool executes shell commands with `cwd` set to the workspace root
2. Returns structured `RunResult` with `stdout`, `stderr`, `exitCode`
3. Default timeout of 60s, configurable via `timeout` parameter
4. Default max output buffer of 10MB, configurable via `maxBuffer` parameter
5. Supports shell features (pipes, redirects, `&&` chains)
6. Non-zero exit codes returned as data, not thrown as errors
7. All runs logged to stderr
8. `truncated` flag when output exceeds `maxBuffer`

## Non-Goals
- Interactive/stdin support
- Streaming output
- Special-purpose git/fastlane/gradle wrappers
- Persistent shell sessions
- Command allowlist/blocklist

## Applied User Rules
- **Declarative API**: Single `run(command, options?)` — no imperative command builders
- **Errors through return types**: Non-zero exit codes returned in `RunResult.exitCode`, not thrown. Only infrastructure failures (timeout, spawn failure) produce errors.
- **Pure short functions**: `run()` is a single-responsibility method
- **Document why not what**: Comments explain shell mode choice, not Node API usage

## Invariants
1. `cwd` always locked to `config.root`
2. Timeout prevents runaway processes
3. Output capped to prevent memory exhaustion
4. Logged to stderr like all write operations

## Selected Approach
**`exec` with shell** — `promisify(exec)(command, { cwd, timeout, maxBuffer })`

Node's `exec` is the idiomatic API for running shell command strings. The existing codebase uses `execFile` (no shell) for ripgrep, but `run_crossproject` intentionally needs shell interpretation for pipes/redirects.

**Runner-up**: `execFile('/bin/sh', ['-c', command])` — same behavior, less idiomatic.

## Implementation

### Slice 1: Interface + Implementation + Registration + Tests + Docs (single slice)

**`src/workspace.ts`** — add types and interface method:
```typescript
interface RunOptions {
  timeout?: number;   // ms, default 60_000
  maxBuffer?: number; // bytes, default 10MB
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}

// Add to Workspace interface:
run(command: string, options?: RunOptions): Promise<RunResult>;
```

**`src/local-filesystem-workspace.ts`** — implement `run()`:
- Import `exec` from `child_process`, promisify it
- Execute with `{ cwd: this.config.root, timeout, maxBuffer }`
- Catch exec errors: extract stdout/stderr/exitCode from error object (Node attaches these even on non-zero exit)
- Catch maxBuffer exceeded: set `truncated: true`, return partial output
- Log to stderr: `[MCP] Run in ${this.config.name}: ${command}`

**`src/index.ts`** — register `run_crossproject`:
- Tool schema with `workspace`, `command`, `timeout`, `maxBuffer` params
- Handler case: zod validate → `ws.run(command, options)` → JSON response

**`src/__tests__/local-filesystem-workspace.test.ts`** — add test suite:
- Runs simple command (`echo hello`)
- Returns stdout, stderr, exitCode
- Supports piped commands (`echo hello | tr a-z A-Z`)
- Returns non-zero exitCode without throwing
- Respects timeout (run `sleep 10` with 100ms timeout)
- Uses workspace root as cwd (`pwd` returns workspace root)

**`README.md`** — add `run_crossproject` section following existing tool doc pattern.

## Test Design
| Test | What it verifies |
|---|---|
| `runs simple command` | stdout capture, exitCode 0 |
| `captures stderr` | stderr capture from command that writes to stderr |
| `returns non-zero exit code` | exitCode propagation without throwing |
| `supports piped commands` | shell interpretation works |
| `uses workspace root as cwd` | cwd containment |
| `respects timeout` | timeout kills long-running process |
| `reports truncated output` | truncated flag when maxBuffer exceeded |

## Risk Register
| Risk | Likelihood | Mitigation |
|---|---|---|
| Destructive commands (`rm -rf`) | Low | Same trust model as IDE terminal; cwd containment |
| Output truncation silent | Medium | `truncated` field in RunResult |
| Platform-specific shell behavior | Low | macOS target; `/bin/sh` is universal on Unix |

## PR Strategy
Single PR — small, self-contained feature addition.

## Philosophy Alignment
- **Declarative API** → satisfied (single method, options object)
- **Errors through return types** → satisfied (exitCode in result, not thrown)
- **Composition over inheritance** → satisfied (implements Workspace interface)
- **Test behavior not implementation** → satisfied (tests check command output, not internals)
- **Pure short functions** → tension (exec is side-effectful by nature, but `run()` is the thinnest possible wrapper)
