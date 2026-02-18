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
Read a file from a workspace.

```typescript
workspace_read(workspace: "ios", path: "Modules/Messaging/Sources/MessagingCoordinator/StreamState.swift")
```

### `workspace_write`
Write a file to a workspace (only to allowed paths).

```typescript
workspace_write(
  workspace: "ios",
  path: "Modules/Messaging/Sources/MessagingCoordinator/v2/KeyReducer.swift",
  content: "// Swift code here"
)
```

Allowed paths (iOS):
- `Modules/**/*.swift`
- `Tests/**/*.swift`
- `Apps/**/*.swift`
- `Examples/**/*.swift`

### `workspace_list`
List directory contents.

```typescript
workspace_list(workspace: "ios", path: "Modules/Messaging/Sources")
```

### `workspace_search`
Search for text/regex in workspace files using ripgrep.

```typescript
workspace_search(workspace: "ios", pattern: "FlowCoordinator", glob: "**/*.swift")
```

### `workspace_edit`
Edit a file using search and replace (like Firebender's edit tool, but for any workspace).

```typescript
workspace_edit(
  workspace: "ios",
  path: "Modules/.../MyFile.swift",
  oldString: "func oldName()",
  newString: "func newName()",
  replaceAll: false  // true to replace all occurrences
)
```

### `workspace_check_swift`
Validate Swift syntax using `swiftc -typecheck`. Gracefully fails if Swift toolchain unavailable.

```typescript
workspace_check_swift(workspace: "ios", path: "Modules/.../MyFile.swift")
```

### `workspace_run_tests`
Run Swift tests using `swift test` (for SPM projects). Note: Tuist/Xcode projects need xcodebuild.

```typescript
workspace_run_tests(workspace: "ios", testTarget: "MessagingTests")
```

### `workspace_build`
Build Swift module using `swift build` (for SPM projects).

```typescript
workspace_build(workspace: "ios", buildTarget: "MessagingCoordinator")
```

## Configuration

### Available Workspaces

Currently configured (see `src/config.ts`):
- **ios**: `/Users/etienneb/git/zillow/ZillowMap` (ZillowMap iOS repo)

### Firebender Registration

Added to `~/.firebender/firebender.json`:

```json
{
  "mcpServers": {
    "workspace": {
      "command": "node",
      "args": ["/Users/etienneb/git/zillow/mcp/packages/workspace-mcp/dist/index.js"]
    }
  }
}
```

## Usage Pattern

1. Agent reads Android Kotlin file: `read_file("libraries/illuminate/flow-coordinator/v2/KeyReducer.kt")`
2. Agent reads iOS conventions: `workspace_read("ios", "Modules/Messaging/Sources/MessagingCoordinator/SubjectCoordinator.swift")`
3. Agent references Rosetta mapping: (read `.firebender/rosetta-kotlin-swift.md` in Android workspace)
4. Agent generates Swift equivalent
5. Agent validates: `workspace_check_swift("ios", "Modules/.../KeyReducer.swift")`
6. Agent writes: `workspace_write("ios", "Modules/.../KeyReducer.swift", content)`

All in one session, no context loss.

## Companion Files

- **Rosetta rules**: `.firebender/rosetta-kotlin-swift.md` in Android workspace — idiom mapping reference
- **Design doc**: `ideas/cross-platform-agent-bridge-design-thinking.md` — full design thinking process

## Development

```bash
# Install dependencies (from monorepo root)
npm install

# Build
cd packages/workspace-mcp
npm run build

# Run in dev mode
npm run dev

# Test the server (starts and listens on stdio)
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
- **Write allowlist**: Only allows writes to Swift files in Modules/Tests/Apps/Examples
- **Path validation**: Prevents `..` escapes
- **Audit logging**: All write/edit operations logged to stderr
- **Graceful degradation**: Swift validation is optional (works without Xcode toolchain)

## Future Enhancements (v2)

- Configurable workspace roots via `workspace-config.json`
- Git operations (`workspace_git`)
- Additional workspaces (backend repos, etc.)
- Auto-context loading (inject `.firebender/platform-context.md` on first access)
