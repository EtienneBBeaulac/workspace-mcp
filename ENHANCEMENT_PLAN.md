# Workspace MCP Enhancement Plan: Match Firebender's Built-in Tool UX

## Current State

Our workspace MCP tools work, but they return plain text. Firebender's built-in tools have superior UX with line numbers, pagination, and context.

## Firebender's Tool Patterns (Reverse-Engineered)

### READ Tool
```
Format: Line-numbered output
  1→line content here
  2→another line
  3→etc

Features:
- offset: Start from line N (1-indexed)
- limit: Read N lines
- Line numbers for navigation (can reference "line 42" in edits)
```

### EDIT Tool
```
Safety: Must read file first
Uniqueness: old_string must appear exactly once (unless replace_all)
Validation: Preserves indentation exactly
Output: Success message only (no preview currently, but we added that!)
```

### SEARCH (Grep) Tool
```
Output modes:
- content: Shows matching lines with line numbers (default)
  file.swift:42: matching line content
- files_with_matches: Just file paths
- count: Match counts per file

Context:
- -A N: Show N lines after match
- -B N: Show N lines before match  
- -C N: Show N lines before AND after

Pagination:
- head_limit: First N results
- offset: Skip first N results
```

## Enhancements to Implement

### 1. read_crossproject: Add Line Numbers + Pagination

**Current**:
```typescript
read_crossproject("ios", "path/to/file.swift")
// Returns: plain text content
```

**Enhanced**:
```typescript
read_crossproject("ios", "path/to/file.swift")
// Returns: 
//   1→import Foundation
//   2→
//   3→class MyClass {
// ...

read_crossproject("ios", "path/to/file.swift", offset: 50, limit: 20)
// Returns: lines 50-69 (plain text for editing)
```

**Implementation**: 
- Default: prepend line numbers (1-indexed, "  N→content")
- With offset/limit: return plain text (for editing)
- Match Firebender's cat -n format exactly

### 2. search_crossproject: Add Output Modes + Context + Pagination

**Current**:
```typescript
search_crossproject("ios", "pattern", "**/*.swift")
// Returns: [{file, line, content}, ...]
```

**Enhanced**:
```typescript
// Content mode (default) with line numbers
search_crossproject("ios", "FlowCoordinator", glob: "**/*.swift", outputMode: "content")
// Returns:
// KeyReducer.swift:42: func reduce(state: KeyState<Data>...
// KeyReducer.swift:100: // FlowCoordinator v2 reducer

// Files only mode
search_crossproject("ios", "FlowCoordinator", glob: "**/*.swift", outputMode: "files")
// Returns: [KeyReducer.swift, KeyCoordinator.swift, ...]

// Count mode  
search_crossproject("ios", "FlowCoordinator", outputMode: "count")
// Returns: [{file: "KeyReducer.swift", count: 15}, ...]

// With context lines
search_crossproject("ios", "func reduce", contextLines: 3)
// Returns 3 lines before + match + 3 lines after

// With pagination
search_crossproject("ios", "import", limit: 50, offset: 0)
// First 50 matches, skip 0
```

**Implementation**:
- Use ripgrep flags: `--files-with-matches`, `--count`, `-C N`
- Parse output based on mode
- Add limit/offset slicing

### 3. edit_crossproject: Add Read-First Validation + Better Preview

**Current**:
```typescript
edit_crossproject("ios", "path", "old", "new")
// Returns: {success: true, occurrences: 1, preview: {...}}
```

**Enhanced**:
```typescript
edit_crossproject("ios", "path", "old", "new")
// REQUIRES prior read_crossproject("ios", "path") call
// Returns:
// {
//   success: true,
//   occurrences: 1,
//   preview: {
//     before: "
//       39: func oldFunction() {
//       40:     return value
//       41: }
//       42:
//     ",
//     after: "
//       39: func newFunction() {
//       40:     return value  
//       41: }
//       42:
//     ",
//     lineNumber: 39
//   }
// }
```

**Implementation**:
- Track which files have been read (in-memory cache per session)
- Reject edits to un-read files (safety, like Firebender)
- Enhanced preview with line numbers
- Show more context (currently 3 lines, could be configurable)

### 4. write_crossproject: Add Read-First Requirement for Existing Files

**Current**:
```typescript
write_crossproject("ios", "ExistingFile.swift", content)
// Overwrites without check (dangerous)
```

**Enhanced**:
```typescript
// New file: works as-is
write_crossproject("ios", "NewFile.swift", content) → ✅

// Existing file: requires read first
write_crossproject("ios", "ExistingFile.swift", content) → ❌ Error: "Must read file before overwriting"

// After reading:
read_crossproject("ios", "ExistingFile.swift")
write_crossproject("ios", "ExistingFile.swift", content) → ✅
```

**Implementation**:
- Check if file exists
- If exists and not in read cache, reject
- If new file or read cache hit, allow

## Implementation Priority

**v0.4.0 (High Value)**:
1. ✅ Read with line numbers (navigation)
2. ✅ Read pagination (offset/limit)
3. ✅ Edit preview enhancement (diff-style with line numbers)
4. ✅ Search output modes (files/count)
5. ✅ Search context lines (-C flag)

**v0.5.0 (Safety)**:
6. Read-first validation for edit
7. Read-first validation for write (existing files)
8. Session-scoped read cache

**v0.6.0 (Nice-to-Have)**:
9. Search pagination (limit/offset)
10. Configurable context lines in edit preview

## Why This Matters

**Consistency**: Tools feel like Firebender's native tools (same UX patterns)

**Navigation**: Line numbers let agents reference "line 42" in conversations

**Safety**: Read-first validation prevents accidental overwrites

**Performance**: Pagination prevents massive responses that timeout

**Debuggability**: Context lines show what's around edits/matches

## Example Usage (After Enhancement)

**Read with line numbers**:
```
read_crossproject("ios", "KeyReducer.swift")
→ Shows file with line numbers for navigation

read_crossproject("ios", "KeyReducer.swift", offset: 100, limit: 50)  
→ Shows lines 100-149 (plain, ready to edit)
```

**Search flexibly**:
```
search_crossproject("ios", "TODO", outputMode: "files")
→ Which files have TODOs?

search_crossproject("ios", "func reduce", outputMode: "count")
→ How many times is reduce mentioned per file?

search_crossproject("ios", "async func", contextLines: 5, limit: 10)
→ First 10 matches with 5 lines before/after each
```

**Edit safely**:
```
read_crossproject("ios", "MyFile.swift")  // Required first
edit_crossproject("ios", "MyFile.swift", "old", "new")
→ Preview shows:
  Before:
    39: old function
    40: body
  After:
    39: new function
    40: body
```

This makes the workspace MCP feel like a **native extension of Firebender's tool suite**.
