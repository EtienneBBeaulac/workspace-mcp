// Workspace abstraction for multi-repo filesystem access

// --- Options interfaces ---

export interface ReadOptions {
  offset?: number;
  limit?: number;
}

export interface ReadResult {
  content: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
}

export interface ListOptions {
  path?: string;
  recursive?: boolean;
  maxDepth?: number;
}

export interface EditOptions {
  replaceAll?: boolean;
  useRegex?: boolean;
}

export interface SearchOptions {
  path?: string;
  glob?: string;
  outputMode?: 'content' | 'files' | 'count';
  contextLines?: number;
  caseInsensitive?: boolean;
  limit?: number;
  offset?: number;
}

export interface Workspace {
  /** Read a file from the workspace. Returns line-numbered content with metadata (total lines, range). */
  read(relativePath: string, options?: ReadOptions): Promise<ReadResult>;

  /** Write a file to the workspace. Respects write allowlist. */
  write(relativePath: string, content: string): Promise<void>;

  /** Edit one or more files via search and replace. Same operation applied to all files. */
  edit(relativePaths: string | string[], oldString: string, newString: string, options?: EditOptions): Promise<BatchEditResult>;

  /** List directory contents with metadata. Supports recursive tree listing. */
  list(options?: ListOptions): Promise<FileEntry[]>;

  /** Search for pattern in workspace files using ripgrep. */
  search(pattern: string, options?: SearchOptions): Promise<SearchResult[]>;

  /** Syntax-check source files. Auto-detects language. Multi-file compilation for cross-file refs. */
  check(relativePaths: string | string[]): Promise<BatchCheckResult>;

  /** Run tests. Auto-detects build system (Tuist -> xcodebuild -> swift test). */
  runTests(testTarget?: string): Promise<TestResult>;

  /** Build the workspace. Auto-detects build system. */
  build(buildTarget?: string): Promise<BuildResult>;
}

export interface FileEntry {
  name: string;
  path: string;  // Relative path from list root
  type: 'file' | 'directory' | 'symlink';
  size?: number;
  modified?: Date;
  depth?: number;  // For recursive listings
}

/** Discriminated union for search results based on output mode */
export type SearchResult =
  | ContentSearchResult
  | FileSearchResult
  | CountSearchResult;

export interface ContentSearchResult {
  mode: 'content';
  file: string;
  line: number;
  content: string;
  contextBefore?: string[];
  contextAfter?: string[];
}

export interface FileSearchResult {
  mode: 'files';
  file: string;
}

export interface CountSearchResult {
  mode: 'count';
  file: string;
  count: number;
}

export interface TestResult {
  success: boolean;
  passed: number;
  failed: number;
  skipped: number;
  failures?: Array<{
    test: string;
    error: string;
  }>;
  output?: string;
}

export type BuildResult =
  | { success: true; output: string }
  | { success: false; errors: string[] }
  | { success: false; unavailable: true; reason: string };

/** Batch result returned by check() for both single and multiple files. */
export interface BatchCheckResult {
  totalFiles: number;
  passed: number;
  failed: number;
  results: Array<{
    file: string;
    language: string;
    success: boolean;
    errors?: string[];
  }>;
}

export interface BatchEditResult {
  totalFiles: number;
  succeeded: number;
  failed: number;
  results: Array<{
    file: string;
    success: boolean;
    linesChanged?: number;
    occurrences?: number;
    preview?: {
      before: string;
      after: string;
      lineNumber?: number;
    };
    error?: string;
  }>;
}
