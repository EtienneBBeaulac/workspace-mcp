# Multi-Workspace MCP Server

Enables Firebender agents to read/write files in multiple repository workspaces from a single session.

## Problem Solved

AI coding agents are normally confined to a single workspace. When developing cross-platform features (e.g., FlowCoordinator on both Android/Kotlin and iOS/Swift), the agent loses all context when switching platforms. This MCP server gives the agent simultaneous access to both repositories, enabling:

- Port features from Kotlin to Swift (or vice versa) without context loss
- Read iOS code to learn conventions while working in Android Studio
- Generate Swift files directly in the iOS repo
- Validate Swift syntax before writing

## Tools Provided

### `workspace_read`
Read a file from a workspace. Returns up to 500 lines by default with line numbers and metadata (`totalLines`, `startLine`, `endLine`, `truncated`). Use `offset`/`limit` to paginate.

```typescript
workspace_read(workspace: "ios", path: "Modules/Messaging/Sources/MessagingCoordinator/StreamState.swift")
workspace_read(workspace: "ios", path: "Modules/.../LargeFile.swift", offset: 100, limit: 50)
```

### `workspace_write`
Write a file to a workspace. Only writes to paths matching the workspace write allowlist (defined in `workspace-config.json`).

```typescript
workspace_write(
  workspace: "ios",
  path: "Modules/Messaging/Sources/MessagingCoordinator/v2/KeyReducer.swift",
  content: "// Swift code here"
)
```

### `workspace_list`
List directory contents with metadata (type, size, modified date). Supports recursive tree listing.

```typescript
workspace_list(workspace: "ios", path: "Modules/Messaging/Sources")
workspace_list(workspace: "ios", path: "Modules", recursive: true, maxDepth: 2)
```

### `workspace_search`
Search for text/regex in workspace files using ripgrep. Supports output modes (`content`, `files`, `count`), context lines, path scoping (directory or file), and pagination.

```typescript
workspace_search(workspace: "ios", pattern: "FlowCoordinator", glob: "**/*.swift")
workspace_search(workspace: "ios", pattern: "class.*Coordinator", path: "Modules/Messaging", outputMode: "files")
```

### `workspace_edit`
Edit one or more files using search and replace. Supports regex with backreferences.

```typescript
// Single file
workspace_edit(
  workspace: "ios",
  paths: "Modules/.../MyFile.swift",
  oldString: "func oldName()",
  newString: "func newName()",
)

// Multiple files (same replacement applied to all)
workspace_edit(
  workspace: "ios",
  paths: ["FileA.swift", "FileB.swift", "FileC.swift"],
  oldString: "oldValue",
  newString: "newValue",
  replaceAll: true,
)

// Regex with backreferences
workspace_edit(
  workspace: "ios",
  paths: "Modules/.../MyFile.swift",
  oldString: "func (\\w+)\\(param: String\\)",
  newString: "func $1(param: Int)",
  useRegex: true,
)
```

### `workspace_check`
Syntax-check source files. Auto-detects language from file extension (Swift, TypeScript, Python, Go, Kotlin, Rust). When checking multiple files of the same language, compiles them together to resolve cross-file references.

```typescript
workspace_check(workspace: "ios", paths: "Modules/.../MyFile.swift")
workspace_check(workspace: "ios", paths: ["Modules/.../FileA.swift", "Modules/.../FileB.swift"])
```

### `workspace_run_tests`
Run tests in the workspace. Auto-detects build system (Tuist -> xcodebuild -> swift test).

```typescript
workspace_run_tests(workspace: "ios", testTarget: "MessagingTests")
```

### `workspace_build`
Build the workspace. Auto-detects build system (Tuist -> xcodebuild -> swift build).

```typescript
workspace_build(workspace: "ios", buildTarget: "MessagingCoordinator")
```

## Configuration

Create a `workspace-config.json` in the repo root (see `workspace-config.example.json`):

```json
{
  "workspaces": {
    "ios": {
      "root": "$HOME/git/zillow/ZillowMap",
      "name": "iOS (ZillowMap)",
      "writeAllowlist": [
        "Modules/**/*.swift",
        "Tests/**/*.swift",
        "Apps/**/*.swift",
        "Examples/**/*.swift"
      ]
    }
  }
}
```

Supports `$HOME` and `~` expansion in `root` paths. There are no hardcoded defaults — all workspaces must be defined in this file. If missing, the server starts with zero workspaces and logs instructions.

### Firebender Registration

Added to `~/.firebender/firebender.json`:

```json
{
  "mcpServers": {
    "workspace": {
      "command": "node",
      "args": ["<path-to-workspace-mcp>/dist/index.js"]
    }
  }
}
```

## Usage Pattern

1. Agent reads Android Kotlin file: `read_file("libraries/illuminate/flow-coordinator/v2/KeyReducer.kt")`
2. Agent reads iOS conventions: `workspace_read("ios", "Modules/Messaging/Sources/MessagingCoordinator/SubjectCoordinator.swift")`
3. Agent references Rosetta mapping: (read `.firebender/rosetta-kotlin-swift.md` in Android workspace)
4. Agent generates Swift equivalent
5. Agent validates: `workspace_check("ios", "Modules/.../KeyReducer.swift")`
6. Agent writes: `workspace_write("ios", "Modules/.../KeyReducer.swift", content)`

All in one session, no context loss.

## Companion Projects

- **Memory MCP**: [`memory-mcp`](../memory-mcp) — persistent codebase knowledge for AI agents (separate repo)
- **Rosetta rules**: `.firebender/rosetta-kotlin-swift.md` in Android workspace — idiom mapping reference

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run in dev mode
npm run dev

# Run tests
npm test
```

## Safety Features

### Stateless Safety Model
The MCP uses **stateless validation** instead of session tracking - no brittle state to manage:

**Edit Safety**:
- Verifies old string exists before editing (reads file fresh every time)
- Enforces uniqueness (unless replaceAll=true)
- Fails fast with clear errors if string not found or not unique
- No need to "read first" - the verification IS the safety check

**Write Safety**:
- Warns when overwriting existing files (logged to stderr)
- Agent can still overwrite if intentional (not blocked)
- Allowlist enforced for all writes

**Why Stateless?**
- No session state = no brittleness across restarts/reconnects
- Always reads fresh from disk (catches external changes)
- Works across multiple agents/sessions
- Self-documenting (failures explain what's wrong)

### Other Safety Features
- **Write allowlist**: Only allows writes to paths matching the configured allowlist patterns
- **Path validation**: Resolved paths are verified to stay within workspace root (prevents directory traversal)
- **Shell injection prevention**: All external commands use `execFile` with argument arrays (no shell interpolation)
- **Audit logging**: All write/edit operations logged to stderr
- **Graceful degradation**: Syntax checking is optional (works without language toolchains)

## Future Enhancements

- Git operations (`workspace_git`)
- Additional workspaces (backend repos, etc.)
- Auto-context loading (inject `.firebender/platform-context.md` on first access)
