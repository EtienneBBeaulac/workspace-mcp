# Workspace MCP Roadmap

## Current Status (v0.1.0)

✅ Multi-workspace filesystem access (read/write/list/search)
✅ Write safety (allowlist, path validation)
✅ Swift syntax validation
✅ iOS workspace configured
✅ Production-ready and tested

## Path 2: Full Pipeline Features

### Git Operations
- `git_crossproject(workspace, command)` - Execute git commands in workspace
- `branch_crossproject(workspace, name)` - Create new branch
- `commit_crossproject(workspace, message, files)` - Commit changes
- `push_crossproject(workspace, branch)` - Push to remote
- `create_mr_crossproject(workspace, title, body)` - Create GitLab MR

**Value**: Enable complete code delivery workflow without leaving Firebender session

### Porting State Tracker
- `port_status_crossproject()` - View porting progress
- `mark_ported_crossproject(android_file, ios_file, status)` - Track completion
- Persistent `.porting-state.json` in Android workspace
- Resume across sessions

**Value**: Structure for large multi-day porting efforts (30+ files)

### WorkRail Integration
- Phased porting workflow with checkpoints
- Phase 1: Types/models → Phase 2: Pure functions → Phase 3: Effects → Phase 4: Runtime/actors → Phase 5: Tests
- Each phase has verification gates

**Value**: Systematic approach with built-in quality gates

### Auto-Context Loading
- On first `read_crossproject` for a workspace, check for `.firebender/platform-context.md`
- If exists, inject as additional context in response
- Agent gets iOS conventions automatically without explicit read

**Value**: Zero-friction platform awareness

### Module Structure Helper
- `describe_modules_crossproject(workspace)` - Return module structure (Tuist/SPM/Gradle)
- `suggest_location_crossproject(workspace, file_type, purpose)` - Recommend where new files should go
- Understands Tuist, Swift Package Manager, Gradle module conventions

**Value**: Prevents "wrote to wrong module" errors

## Path 2.5: Smart Auto-Converter (Optional Performance Enhancement)

### Auto-Port Tool
- `auto_convert_crossproject(workspace, sourceFile, targetPath, sourceLang, targetLang)` 
- Parses Kotlin AST (or regex-based for MVP)
- Applies mechanical translations (sealed → enum, data class → struct, etc.)
- Inserts `// TODO: [AGENT]` markers for ambiguous cases (concurrency model, file organization)
- Returns 80% correct Swift with TODOs
- Agent reviews, resolves TODOs, writes final version

**Value**: 2-3x faster for large batch ports (100+ files). Agent focuses on high-value decisions, not boilerplate.

**Complexity**: Medium-High (requires AST parsing or robust regex patterns)

**When to build**: When you have another large system (50+ files) to port and current approach is too slow.

**Current approach already works great**: 47 files in 2 hours with parallel subagents. Auto-converter would take 1-2 days to build reliably. Build it only if batch porting becomes frequent.

### Translation Quality Analyzer
- `analyze_translation_crossproject(androidFile, iosFile)`
- Compares ported Swift against Kotlin source
- Reports: structural differences, missing cases, type mismatches
- Helps verify subagent translations are complete

**Value**: Quality assurance for auto-converted or subagent-generated code

## Path 3: Generalization Features

### Configurable Workspaces
- Move from hardcoded WORKSPACES to `workspace-config.json`
- Support any number of workspaces (Android variants, backend repos, etc.)
- Schema: `{ "workspaces": [{ "name": "ios", "root": "/path", "allowlist": [...] }] }`

**Value**: One tool for all cross-repo work, not just Android↔iOS

### Bidirectional Setup
- Add Android workspace configuration
- Support Xcode → Android Studio direction (iOS-first development)
- Symmetric Rosetta rules (Swift→Kotlin mappings)

**Value**: Works from either direction, serves both teams

### Team Distribution
- Shareable config files
- Setup script for new team members
- Documentation for onboarding

**Value**: Other engineers can use the same workflow

### Additional Workspace Types
- GitLabWorkspace (API-based, no local clone needed)
- RemoteWorkspace (HTTP/SSH access)
- S3Workspace (read/write to S3-backed repos)

**Value**: Remote work, CI/CD integration, compliance archives

## Discovered: Subagent MCP Access Patterns

**Finding**: WorkRail executor subagents CAN access the workspace MCP tools, but the configuration may not propagate correctly in all cases.

**Observed behavior**:
- Test subagent: Successfully used `mcp_workspace_read_crossproject` directly ✅
- Port subagent: Tried to use workspace MCP but reported it wasn't accessible, fell back to `/tmp/` ❌

**Hypothesis**: Subagents may need explicit MCP re-initialization or the workspace config isn't inherited from parent session.

**Workarounds**:
1. **Two-tier approach**: Subagents generate in `/tmp/`, main agent copies to iOS via workspace MCP (safe, proven)
2. **Explicit config**: Pass workspace root paths as task parameters, have subagent construct file paths directly
3. **Investigation needed**: Test whether subagent MCP access is consistent or timing-dependent

**Recommendation for v0.2.0**: Add explicit subagent MCP configuration inheritance or make workspace roots injectable as task parameters.

## Future Features (Post-v1.0)

### Git Integration
- `git_status_crossproject`, `git_diff_crossproject`, `git_commit_crossproject`, `git_branch_crossproject`, `git_push_crossproject`
- **Value**: Complete workflow - port → commit → push → MR creation
- **Effort**: ~2 hours

### Dependency Analysis  
- `find_imports_crossproject`, `find_usages_crossproject`, `get_definition_crossproject`
- **Value**: Help agent understand cross-file dependencies before porting
- **Effort**: ~3 hours (could use LSP)

### Xcode/Tuist Integration
- `xcodebuild_crossproject(action, scheme)`, `tuist_crossproject(command)`, `add_to_project_crossproject`
- **Value**: Full iOS build/test workflow (currently limited to SPM)
- **Effort**: ~2 hours

### Batch Operations
- `batch_edit_crossproject`, `batch_validate_crossproject`, `copy_structure_crossproject`
- **Value**: Apply same edit to multiple files at once
- **Effort**: ~1 hour

### Smart Context Injection
- Auto-include `.firebender/platform-context.md` on first iOS read
- Auto-include test helper patterns when reading test files
- **Value**: Reduce explicit context loading
- **Effort**: ~30 minutes

### Module Structure Helper
- `describe_module_crossproject`, `suggest_location_crossproject`, `validate_module_crossproject`
- **Value**: Guide agent to correct file locations
- **Effort**: ~2 hours

### Translation Memory
- Cache successful Kotlin→Swift patterns
- Suggest translations based on past success
- **Value**: Faster, more consistent over time
- **Effort**: ~3 hours

### Diff & Comparison
- `diff_crossproject(file1, file2)`, `compare_ports_crossproject`, `verify_equivalence_crossproject`
- **Value**: Verify ports are behaviorally equivalent
- **Effort**: ~2 hours

### Porting Session State
- `port_status_crossproject`, `mark_ported_crossproject`, persistent `.porting-state.json`
- **Value**: Resume multi-day ports across sessions
- **Effort**: ~1 hour

## Priority Recommendations

**Immediate** (v0.2.0):
- Auto-context loading (low effort, high value)
- Configurable workspaces via JSON (unblocks team distribution)

**Short-term** (v0.3.0):
- Git operations (enables full self-service workflow)
- Porting state tracker (needed for complex 30+ file ports)

**Long-term** (v1.0.0):
- WorkRail integration (once patterns stabilize)
- Module structure helpers (once Tuist/SPM needs are understood)
- Additional workspace types (only if use cases emerge)

## Implementation Notes

All enhancements should preserve the v0.1.0 invariants:
- No writes outside allowlist (safety-critical)
- Path validation (prevent escapes)
- Graceful degradation (optional capabilities like Swift validation)
- Structured error handling (no silent failures)
- MCP response size <1MB (performance)
