// Workspace abstraction for multi-repo filesystem access

export interface Workspace {
  /**
   * Read a file from the workspace.
   * @param relativePath Path relative to workspace root
   * @param offset Optional line number to start from (1-indexed)
   * @param limit Optional number of lines to read
   * @returns File contents (with line numbers if no offset/limit, plain text otherwise)
   * @throws Error if file not found or not readable
   */
  read(relativePath: string, offset?: number, limit?: number): Promise<string>;

  /**
   * Write a file to the workspace.
   * @param relativePath Path relative to workspace root
   * @param content File contents
   * @throws Error if path is not allowed or write fails
   */
  write(relativePath: string, content: string): Promise<void>;

  /**
   * Edit a file in the workspace (search and replace).
   * @param relativePath Path relative to workspace root
   * @param oldString String or regex pattern to find (must be unique unless replaceAll)
   * @param newString String to replace with
   * @param replaceAll Whether to replace all occurrences (default: false)
   * @param useRegex Treat oldString as regex pattern (default: false)
   * @returns Edit result (success/failure with line info)
   * @throws Error if oldString not found, not unique, or path not allowed
   */
  edit(
    relativePath: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
    useRegex?: boolean
  ): Promise<EditResult>;

  /**
   * List directory contents with metadata.
   * @param relativePath Path relative to workspace root (defaults to root)
   * @param recursive List subdirectories recursively (default: false)
   * @param maxDepth Maximum depth for recursive listing (default: unlimited)
   * @returns Array of file/directory entries with metadata
   * @throws Error if directory not found
   */
  list(relativePath?: string, recursive?: boolean, maxDepth?: number): Promise<FileEntry[]>;

  /**
   * Search for pattern in workspace files.
   * @param pattern Regex pattern or text to search for
   * @param glob Optional glob pattern to filter files (e.g., "**\/*.swift")
   * @param outputMode Output mode: 'content' (with line numbers), 'files' (paths only), 'count'
   * @param contextLines Number of lines to show before/after match (for content mode)
   * @param caseInsensitive Case-insensitive search (default: false)
   * @param limit Maximum number of results
   * @param offset Skip first N results
   * @returns Array of matches or file paths depending on mode
   */
  search(
    pattern: string,
    glob?: string,
    outputMode?: 'content' | 'files' | 'count',
    contextLines?: number,
    caseInsensitive?: boolean,
    limit?: number,
    offset?: number
  ): Promise<SearchResult[]>;

  /**
   * Check Swift syntax for a file.
   * @param relativePath Path to Swift file
   * @returns Validation result (errors or success)
   */
  checkSwift(relativePath: string): Promise<SwiftCheckResult>;

  /**
   * Batch validate multiple Swift files.
   * @param relativePaths Array of Swift file paths
   * @returns Validation results for each file
   */
  batchCheckSwift(relativePaths: string[]): Promise<BatchSwiftCheckResult>;

  /**
   * Run Swift tests in the workspace.
   * @param testTarget Optional test target (e.g., "MessagingTests")
   * @returns Test results (pass/fail counts, failures)
   */
  runTests(testTarget?: string): Promise<TestResult>;

  /**
   * Build the Swift module.
   * @param buildTarget Optional build target/scheme
   * @returns Build result (success/failure with errors)
   */
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

export interface SearchResult {
  file: string;
  line: number;
  content: string;
  contextBefore?: string[];
  contextAfter?: string[];
}

export type SwiftCheckResult =
  | { success: true }
  | { success: false; errors: string[] }
  | { success: false; unavailable: true; reason: string };

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

export interface EditResult {
  success: boolean;
  linesChanged?: number;
  occurrences?: number;
  preview?: {
    before: string;  // 3 lines before + changed line(s) + 3 lines after (original)
    after: string;   // 3 lines before + changed line(s) + 3 lines after (new)
    lineNumber?: number;  // Starting line number of the change
  };
  error?: string;
}

export interface BatchSwiftCheckResult {
  totalFiles: number;
  passed: number;
  failed: number;
  results: Array<{
    file: string;
    success: boolean;
    errors?: string[];
  }>;
}
