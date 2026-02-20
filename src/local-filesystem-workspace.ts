// Local filesystem implementation of Workspace interface

import { promises as fs } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Workspace, FileEntry, SearchResult, TestResult, BuildResult, BatchCheckResult, BatchEditResult, ReadOptions, ReadResult, ListOptions, EditOptions, SearchOptions } from './workspace.js';

/** Internal-only type for single-file edit results (not part of the Workspace interface). */
interface EditResult {
  success: boolean;
  linesChanged?: number;
  occurrences?: number;
  preview?: {
    before: string;
    after: string;
    lineNumber?: number;
  };
  error?: string;
}
import type { WorkspaceConfig } from './config.js';

const execFileAsync = promisify(execFile);

/** Per-language syntax checker configuration */
interface LanguageChecker {
  readonly command: string;
  readonly args: readonly string[];
  readonly installHint: string;
  /** If true, multiple files can be passed in one invocation to resolve cross-file references */
  readonly multiFile: boolean;
}

const LANGUAGE_CHECKERS: Record<string, LanguageChecker> = {
  swift: {
    command: 'swiftc',
    args: ['-typecheck'],
    installHint: 'Install Xcode Command Line Tools.',
    multiFile: true, // swiftc compiles all files as one module — resolves cross-file refs
  },
  typescript: {
    command: 'npx',
    args: ['tsc', '--noEmit', '--pretty', '--allowJs', '--checkJs', 'false', '--skipLibCheck'],
    installHint: 'Install TypeScript: npm install -D typescript.',
    multiFile: true, // tsc resolves imports across files
  },
  python: {
    command: 'python3',
    args: ['-m', 'py_compile'],
    installHint: 'Install Python 3.',
    multiFile: false, // py_compile is single-file only
  },
  go: {
    command: 'go',
    args: ['vet'],
    installHint: 'Install Go: https://go.dev/dl/',
    multiFile: true, // go vet works on packages (multiple files)
  },
  kotlin: {
    command: 'kotlinc',
    args: ['-script'],
    installHint: 'Install Kotlin compiler: https://kotlinlang.org/docs/command-line.html',
    multiFile: false,
  },
  rust: {
    command: 'rustc',
    args: ['--edition', '2021', '--crate-type', 'lib', '--emit', 'metadata', '-o', '/dev/null'],
    installHint: 'Install Rust: https://rustup.rs/',
    multiFile: false, // rustc single-file; use cargo check for multi-file
  },
};

export class LocalFilesystemWorkspace implements Workspace {
  constructor(private readonly config: WorkspaceConfig) {}

  private static readonly DEFAULT_LINE_LIMIT = 500;

  async read(relativePath: string, options?: ReadOptions): Promise<ReadResult> {
    const { offset, limit } = options ?? {};
    const fullPath = this.resolvePath(relativePath);
    
    try {
      // Check file size first (prevent reading huge files)
      const stats = await fs.stat(fullPath);
      const maxSizeBytes = 5 * 1024 * 1024; // 5MB limit
      
      if (stats.size > maxSizeBytes) {
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
        throw new Error(
          `File too large: ${sizeMB}MB (max 5MB). Use offset/limit to read specific sections, ` +
          `or use workspace_search to find specific content.`
        );
      }
      
      const rawContent = await fs.readFile(fullPath, 'utf-8');
      const allLines = rawContent.split('\n');
      const totalLines = allLines.length;

      // Compute the line range to return (1-indexed)
      const startLine = offset ?? 1;
      const effectiveLimit = limit ?? LocalFilesystemWorkspace.DEFAULT_LINE_LIMIT;
      const startIdx = startLine - 1;
      const endIdx = Math.min(startIdx + effectiveLimit, totalLines);
      const endLine = endIdx;
      const truncated = endIdx < totalLines && limit === undefined;

      const sliced = allLines.slice(startIdx, endIdx);
      const content = sliced
        .map((line, i) => `${(startIdx + i + 1).toString().padStart(4)}→${line}`)
        .join('\n');

      return { content, totalLines, startLine, endLine, truncated };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read ${relativePath}: ${msg}`);
    }
  }

  async write(relativePath: string, content: string): Promise<void> {
    // Validate against allowlist
    if (!this.isPathAllowed(relativePath)) {
      throw new Error(
        `Write not allowed: ${relativePath} does not match any allowlist pattern. ` +
        `Allowed patterns: ${this.config.writeAllowlist.join(', ')}`
      );
    }

    const fullPath = this.resolvePath(relativePath);
    
    // Stateless safety check: if file exists and is non-empty, warn (but allow)
    // The agent should use edit for existing files, write for new files
    try {
      const existing = await fs.readFile(fullPath, 'utf-8');
      if (existing.trim().length > 0) {
        console.error(`[MCP] WARNING: Overwriting existing file ${relativePath} (${existing.split('\n').length} lines). Consider using workspace_edit for surgical changes.`);
      }
    } catch (error: any) {
      // File doesn't exist - new file, no warning needed
      if (error.code !== 'ENOENT') {
        throw error; // Some other error
      }
    }
    
    // Ensure directory exists
    const dir = path.dirname(fullPath);
    await fs.mkdir(dir, { recursive: true });

    try {
      await fs.writeFile(fullPath, content, 'utf-8');
      console.error(`[MCP] Wrote to ${this.config.name}: ${relativePath}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to write ${relativePath}: ${msg}`);
    }
  }

  async edit(
    relativePaths: string | string[],
    oldString: string,
    newString: string,
    options?: EditOptions
  ): Promise<BatchEditResult> {
    const { replaceAll = false, useRegex = false } = options ?? {};
    // Normalize input to array
    const paths = Array.isArray(relativePaths) ? relativePaths : [relativePaths];
    const results: Array<{
      file: string;
      success: boolean;
      linesChanged?: number;
      occurrences?: number;
      preview?: { before: string; after: string; lineNumber?: number };
      error?: string;
    }> = [];

    // Process all files
    for (const file of paths) {
      const result = await this.editSingleFile(file, oldString, newString, replaceAll, useRegex);
      results.push({ file, ...result });
    }

    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    return {
      totalFiles: paths.length,
      succeeded,
      failed,
      results,
    };
  }

  /**
   * Edit a single file (internal helper).
   */
  private async editSingleFile(
    relativePath: string,
    oldString: string,
    newString: string,
    replaceAll: boolean = false,
    useRegex: boolean = false
  ): Promise<EditResult> {
    // Validate against allowlist
    if (!this.isPathAllowed(relativePath)) {
      return {
        success: false,
        error: `Edit not allowed: ${relativePath} does not match any allowlist pattern. ` +
          `Allowed patterns: ${this.config.writeAllowlist.join(', ')}`,
      };
    }

    const fullPath = this.resolvePath(relativePath);

    try {
      // Stateless safety: always read fresh from disk to verify old string exists
      const content = await fs.readFile(fullPath, 'utf-8');
      
      // Build the pattern (regex or literal)
      let pattern: RegExp;
      try {
        if (useRegex) {
          // User provided regex - use as-is with global flag if replaceAll
          pattern = new RegExp(oldString, replaceAll ? 'g' : '');
        } else {
          // Literal string - escape special chars
          pattern = new RegExp(this.escapeRegex(oldString), replaceAll ? 'g' : '');
        }
      } catch (error: any) {
        return {
          success: false,
          error: `Invalid regex pattern: ${error.message}`,
        };
      }
      
      // Check if pattern matches (always use global flag for counting)
      const countPattern = new RegExp(pattern.source, 'g');
      const matches = content.match(countPattern);
      
      if (!matches || matches.length === 0) {
        return {
          success: false,
          error: useRegex 
            ? `Regex pattern not found in file: ${oldString}`
            : `String not found in file: ${oldString.substring(0, 100)}${oldString.length > 100 ? '...' : ''}`,
        };
      }

      // Check uniqueness if not replaceAll
      const occurrences = matches.length;
      if (!replaceAll && occurrences > 1) {
        return {
          success: false,
          error: `Pattern appears ${occurrences} times in file (must be unique). Use replaceAll=true to replace all occurrences.`,
        };
      }

      // Perform replacement
      const newContent = content.replace(pattern, newString);

      const linesChanged = newContent.split('\n').length - content.split('\n').length;

      // Generate preview (context around the first change)
      const preview = this.generateEditPreview(content, newContent, oldString, newString);

      await fs.writeFile(fullPath, newContent, 'utf-8');
      console.error(`[MCP] Edited ${this.config.name}: ${relativePath} (${occurrences} occurrence(s))`);

      return {
        success: true,
        linesChanged,
        occurrences,
        preview,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Failed to edit ${relativePath}: ${msg}`,
      };
    }
  }

  async list(options?: ListOptions): Promise<FileEntry[]> {
    const { path: relativePath = '', recursive = false, maxDepth } = options ?? {};
    const fullPath = this.resolvePath(relativePath);
    
    if (!recursive) {
      return this.listDirectory(fullPath, relativePath, 0);
    }
    
    return this.listRecursive(fullPath, relativePath, 0, maxDepth ?? Infinity);
  }

  private async listDirectory(fullPath: string, relativePath: string, depth: number): Promise<FileEntry[]> {
    try {
      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      const result: FileEntry[] = [];
      
      for (const entry of entries) {
        const entryPath = path.join(fullPath, entry.name);
        const entryRelativePath = path.join(relativePath, entry.name);
        
        let stats;
        try {
          stats = await fs.stat(entryPath);
        } catch {
          continue; // Skip broken symlinks, permission issues
        }
        
        result.push({
          name: entry.name,
          path: entryRelativePath,
          type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file',
          size: entry.isFile() ? stats.size : undefined,
          modified: stats.mtime,
          depth,
        });
      }
      
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to list ${relativePath}: ${msg}`);
    }
  }

  private async listRecursive(
    fullPath: string,
    relativePath: string,
    depth: number,
    maxDepth: number
  ): Promise<FileEntry[]> {
    if (depth > maxDepth) {
      return [];
    }

    const entries = await this.listDirectory(fullPath, relativePath, depth);
    const result: FileEntry[] = [...entries];

    // Recursively list subdirectories
    for (const entry of entries) {
      if (entry.type === 'directory') {
        const subPath = path.join(fullPath, entry.name);
        const subRelative = entry.path;
        const subEntries = await this.listRecursive(subPath, subRelative, depth + 1, maxDepth);
        result.push(...subEntries);
      }
    }

    return result;
  }

  async search(pattern: string, options?: SearchOptions): Promise<SearchResult[]> {
    const {
      path: searchPath,
      glob,
      outputMode = 'content',
      contextLines,
      caseInsensitive = false,
      limit,
      offset,
    } = options ?? {};

    try {
      // Use --json for structured output — eliminates all regex parsing fragility
      const args: string[] = ['--json'];

      if (caseInsensitive) args.push('-i');
      if (contextLines !== undefined && outputMode === 'content') {
        args.push('-C', String(contextLines));
      }
      if (glob) args.push('--glob', glob);

      const searchRoot = searchPath
        ? this.resolvePath(searchPath)
        : this.config.root;

      args.push('--', pattern, searchRoot);

      const { stdout } = await execFileAsync('rg', args, { maxBuffer: 10 * 1024 * 1024 });
      return this.parseJsonSearchOutput(stdout, outputMode, offset, limit);
    } catch (error: any) {
      // rg exits with code 1 when no matches found
      if (error?.code === 1) {
        return [];
      }
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Search failed: ${msg}`);
    }
  }

  /**
   * Parse rg --json (JSONL) output into SearchResult[].
   * Handles all output modes uniformly from the same structured data.
   *
   * rg JSON line types: "begin" (file start), "match", "context", "end" (file stats), "summary".
   * We consume "match", "context", and "end" — the rest are ignored.
   */
  private parseJsonSearchOutput(
    stdout: string,
    outputMode: 'content' | 'files' | 'count',
    offset?: number,
    limit?: number,
  ): SearchResult[] {
    const jsonLines = stdout.trim().split('\n').filter(l => l.length > 0);

    // Phase 1: collect structured match data from JSONL
    // Each match has: file, line, content, contextBefore[], contextAfter[]
    interface RawMatch {
      file: string;
      line: number;
      content: string;
      contextBefore: string[];
      contextAfter: string[];
    }

    const matches: RawMatch[] = [];
    // Per-file match counts for count mode
    const fileCounts = new Map<string, number>();
    // Files with matches for files mode
    const filesWithMatches = new Set<string>();
    // Context accumulator: context lines before the next match
    let pendingContext: string[] = [];

    for (const jsonLine of jsonLines) {
      let parsed: any;
      try {
        parsed = JSON.parse(jsonLine);
      } catch {
        continue; // skip malformed lines
      }

      if (parsed.type === 'match') {
        const filePath = path.relative(this.config.root, parsed.data.path.text);
        const lineNumber: number = parsed.data.line_number;
        const lineText: string = (parsed.data.lines.text ?? '').replace(/\n$/, '');

        // Attach pending context as contextBefore, reset accumulator
        const match: RawMatch = {
          file: filePath,
          line: lineNumber,
          content: lineText.trim(),
          contextBefore: pendingContext,
          contextAfter: [],
        };

        // Attach contextAfter to the previous match if it exists
        // (context lines between two matches belong to both)
        if (matches.length > 0) {
          const prev = matches[matches.length - 1];
          prev.contextAfter = [...pendingContext];
        }

        pendingContext = [];
        matches.push(match);
        filesWithMatches.add(filePath);
        fileCounts.set(filePath, (fileCounts.get(filePath) ?? 0) + 1);
      } else if (parsed.type === 'context') {
        const lineText: string = (parsed.data.lines.text ?? '').replace(/\n$/, '');
        pendingContext.push(lineText);
      } else if (parsed.type === 'end' || parsed.type === 'begin') {
        // File boundary — flush pending context as contextAfter for last match
        if (pendingContext.length > 0 && matches.length > 0) {
          const prev = matches[matches.length - 1];
          if (prev.contextAfter.length === 0) {
            prev.contextAfter = pendingContext;
          }
        }
        pendingContext = [];
      }
    }

    // Flush any trailing context
    if (pendingContext.length > 0 && matches.length > 0) {
      const prev = matches[matches.length - 1];
      if (prev.contextAfter.length === 0) {
        prev.contextAfter = pendingContext;
      }
    }

    // Phase 2: convert to the requested output mode with pagination
    const startIdx = offset ?? 0;

    if (outputMode === 'files') {
      const files = Array.from(filesWithMatches);
      const endIdx = limit !== undefined ? startIdx + limit : files.length;
      return files.slice(startIdx, endIdx).map(
        (file): SearchResult => ({ mode: 'files', file })
      );
    }

    if (outputMode === 'count') {
      const entries = Array.from(fileCounts.entries());
      const endIdx = limit !== undefined ? startIdx + limit : entries.length;
      return entries.slice(startIdx, endIdx).map(
        ([file, count]): SearchResult => ({ mode: 'count', file, count })
      );
    }

    // Content mode
    const endIdx = limit !== undefined ? startIdx + limit : matches.length;
    return matches.slice(startIdx, endIdx).map(
      (m): SearchResult => ({
        mode: 'content',
        file: m.file,
        line: m.line,
        content: m.content,
        contextBefore: m.contextBefore.length > 0 ? m.contextBefore : undefined,
        contextAfter: m.contextAfter.length > 0 ? m.contextAfter : undefined,
      })
    );
  }

  async check(relativePaths: string | string[]): Promise<BatchCheckResult> {
    // Normalize input to array
    const paths = Array.isArray(relativePaths) ? relativePaths : [relativePaths];
    const results: Array<{ file: string; language: string; success: boolean; errors?: string[] }> = [];

    // Group files by detected language
    const byLanguage = new Map<string, string[]>();
    const unsupported: string[] = [];

    for (const file of paths) {
      const language = this.detectLanguage(file);
      if (!language) {
        unsupported.push(file);
        continue;
      }
      const group = byLanguage.get(language) ?? [];
      group.push(file);
      byLanguage.set(language, group);
    }

    // Handle unsupported files
    for (const file of unsupported) {
      results.push({
        file,
        language: 'unknown',
        success: false,
        errors: [`Unsupported file type: ${path.extname(file) || '(no extension)'}`],
      });
    }

    // Process each language group
    for (const [language, files] of byLanguage) {
      const checker = LANGUAGE_CHECKERS[language];

      if (!await this.isCommandAvailable(checker.command)) {
        // Tool unavailable — mark all files in this group
        for (const file of files) {
          results.push({
            file,
            language,
            success: false,
            errors: [`${checker.command} not found in PATH. ${checker.installHint}`],
          });
        }
        continue;
      }

      if (checker.multiFile && files.length > 1) {
        // Multi-file compilation: pass all files in one invocation.
        // This resolves cross-file references (e.g., swiftc compiles as one module).
        const fullPaths = files.map(f => this.resolvePath(f));
        const groupResults = await this.runMultiFileCheck(checker, fullPaths, files, language);
        results.push(...groupResults);
      } else {
        // Single-file or non-multi-file language: process individually with concurrency limit
        const concurrency = 4;
        for (let i = 0; i < files.length; i += concurrency) {
          const batch = files.slice(i, i + concurrency);
          const batchResults = await Promise.all(
            batch.map(async (file) => {
              const result = await this.checkSingleFile(file, language, checker);
              return {
                file,
                language,
                success: result.success,
                errors: result.errors,
              };
            })
          );
          results.push(...batchResults);
        }
      }
    }

    const passed = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    return {
      totalFiles: paths.length,
      passed,
      failed,
      results,
    };
  }

  /**
   * Check a single file (internal helper called by check() for non-multi-file languages).
   */
  private async checkSingleFile(
    relativePath: string,
    language: string,
    checker: LanguageChecker
  ): Promise<{ success: boolean; errors?: string[] }> {
    const fullPath = this.resolvePath(relativePath);

    try {
      await execFileAsync(checker.command, [...checker.args, fullPath], {
        cwd: this.config.root,
        maxBuffer: 5 * 1024 * 1024,
      });
      return { success: true };
    } catch (error: any) {
      const output = error.stdout || error.stderr || error.message || '';
      const errors = output
        .split('\n')
        .filter((line: string) => line.includes('error') || line.includes('Error'))
        .map((line: string) => line.trim())
        .filter((line: string) => line.length > 0);

      return {
        success: false,
        errors: errors.length > 0 ? errors : [output.trim()],
      };
    }
  }

  /**
   * Run a multi-file check invocation.
   * All files are passed to a single compiler invocation so cross-file references resolve.
   * Parses errors to attribute them back to individual files.
   */
  private async runMultiFileCheck(
    checker: LanguageChecker,
    fullPaths: string[],
    relativePaths: string[],
    language: string,
  ): Promise<Array<{ file: string; language: string; success: boolean; errors?: string[] }>> {
    try {
      await execFileAsync(checker.command, [...checker.args, ...fullPaths], {
        cwd: this.config.root,
        maxBuffer: 10 * 1024 * 1024,
      });
      // All passed
      return relativePaths.map(file => ({ file, language, success: true }));
    } catch (error: any) {
      const output = error.stdout || error.stderr || error.message || '';
      const errorLines = output
        .split('\n')
        .filter((line: string) => line.includes('error') || line.includes('Error'))
        .map((line: string) => line.trim())
        .filter((line: string) => line.length > 0);

      // Attribute errors to specific files where possible
      const fileErrors = new Map<string, string[]>();
      const unattributed: string[] = [];

      for (const errorLine of errorLines) {
        let attributed = false;
        for (let i = 0; i < relativePaths.length; i++) {
          // Compiler errors typically include the filename in the error line
          const basename = path.basename(relativePaths[i]);
          if (errorLine.includes(basename) || errorLine.includes(fullPaths[i])) {
            const existing = fileErrors.get(relativePaths[i]) ?? [];
            existing.push(errorLine);
            fileErrors.set(relativePaths[i], existing);
            attributed = true;
            break;
          }
        }
        if (!attributed) {
          unattributed.push(errorLine);
        }
      }

      return relativePaths.map(file => {
        const errors = fileErrors.get(file);
        if (errors && errors.length > 0) {
          return { file, language, success: false, errors };
        }
        if (fileErrors.size === 0 && unattributed.length > 0) {
          // Can't attribute — assign all errors to all files
          return { file, language, success: false, errors: unattributed };
        }
        // No errors attributed to this file — it passed
        return { file, language, success: true };
      });
    }
  }

  private detectLanguage(filePath: string): string | null {
    const ext = path.extname(filePath).toLowerCase();
    const mapping: Record<string, string> = {
      '.swift': 'swift',
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.py': 'python',
      '.go': 'go',
      '.kt': 'kotlin',
      '.kts': 'kotlin',
      '.rs': 'rust',
    };
    return mapping[ext] ?? null;
  }

  async runTests(testTarget?: string): Promise<TestResult> {
    const { command, args } = await this.buildTestCommand(testTarget);
    console.error(`[MCP] Running tests via: ${command} ${args.join(' ')}`);
    
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        cwd: this.config.root,
        maxBuffer: 5 * 1024 * 1024,
      });

      const output = stdout + stderr;
      
      // Parse test output (works for both swift test and xcodebuild)
      const passedMatch = output.match(/(\d+) tests? passed/i) || output.match(/Test Suite.*passed.*\((\d+)/);
      const failedMatch = output.match(/(\d+) tests? failed/i) || output.match(/Test Suite.*failed.*\((\d+)/);
      
      const passed = passedMatch ? parseInt(passedMatch[1], 10) : 0;
      const failed = failedMatch ? parseInt(failedMatch[1], 10) : 0;

      return {
        success: failed === 0,
        passed,
        failed,
        skipped: 0,
        output,
      };
    } catch (error: any) {
      const output = error.stdout || error.stderr || error.message || '';
      return {
        success: false,
        passed: 0,
        failed: 1,
        skipped: 0,
        output,
      };
    }
  }

  async build(buildTarget?: string): Promise<BuildResult> {
    const { command, args } = await this.buildBuildCommand(buildTarget);
    console.error(`[MCP] Building via: ${command} ${args.join(' ')}`);
    
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        cwd: this.config.root,
        maxBuffer: 10 * 1024 * 1024,
      });

      return {
        success: true,
        output: `[build system: ${command}]\n${stdout}${stderr}`,
      };
    } catch (error: any) {
      const output = error.stdout || error.stderr || error.message || '';
      const errors = output
        .split('\n')
        .filter((line: string) => line.includes('error:'))
        .map((line: string) => line.trim());

      return {
        success: false,
        errors: errors.length > 0
          ? [`[build system: ${command}]`, ...errors]
          : [`[build system: ${command}]`, output.trim()],
      };
    }
  }

  private async buildTestCommand(testTarget?: string): Promise<{ command: string; args: string[] }> {
    const buildSystem = await this.resolveAvailableBuildSystem();

    switch (buildSystem) {
      case 'tuist':
        return testTarget
          ? { command: 'xcodebuild', args: ['test', '-scheme', testTarget, '-destination', 'platform=iOS Simulator,name=iPhone 15'] }
          : { command: 'tuist', args: ['test'] };
      case 'xcodebuild':
        return testTarget
          ? { command: 'xcodebuild', args: ['test', '-scheme', testTarget, '-destination', 'platform=iOS Simulator,name=iPhone 15'] }
          : { command: 'xcodebuild', args: ['test'] };
      case 'spm':
        return testTarget
          ? { command: 'swift', args: ['test', '--filter', testTarget] }
          : { command: 'swift', args: ['test'] };
    }
  }

  private async buildBuildCommand(buildTarget?: string): Promise<{ command: string; args: string[] }> {
    const buildSystem = await this.resolveAvailableBuildSystem();

    switch (buildSystem) {
      case 'tuist':
        return buildTarget
          ? { command: 'tuist', args: ['build', buildTarget] }
          : { command: 'tuist', args: ['build'] };
      case 'xcodebuild':
        return buildTarget
          ? { command: 'xcodebuild', args: ['-scheme', buildTarget, 'build'] }
          : { command: 'xcodebuild', args: ['build'] };
      case 'spm':
        return buildTarget
          ? { command: 'swift', args: ['build', '--product', buildTarget] }
          : { command: 'swift', args: ['build'] };
    }
  }

  private async isCommandAvailable(command: string): Promise<boolean> {
    try {
      await execFileAsync('which', [command]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve the build system to use, with a fallback chain.
   *
   * Detection order: Tuist.swift → Package.swift → .xcworkspace/.xcodeproj
   * But the detected tool must actually be installed. Falls back gracefully:
   *   tuist (if Tuist.swift + tuist CLI available)
   *   → xcodebuild (if .xcworkspace/.xcodeproj exists or Tuist project without tuist CLI)
   *   → swift build (SPM fallback)
   *
   * Tuist projects generate .xcworkspace files, so xcodebuild is a valid fallback
   * when the tuist CLI isn't installed.
   */
  private async resolveAvailableBuildSystem(): Promise<'tuist' | 'xcodebuild' | 'spm'> {
    const projectType = await this.detectProjectType();

    switch (projectType) {
      case 'tuist':
        // Tuist detected, but is the CLI installed?
        if (await this.isCommandAvailable('tuist')) return 'tuist';
        // Fall through to xcodebuild — Tuist projects generate .xcworkspace
        if (await this.isCommandAvailable('xcodebuild')) return 'xcodebuild';
        // Last resort
        return 'spm';

      case 'xcode':
        if (await this.isCommandAvailable('xcodebuild')) return 'xcodebuild';
        return 'spm';

      case 'spm':
        return 'spm';
    }
  }

  /** Detect project type from filesystem markers (does NOT check tool availability) */
  private async detectProjectType(): Promise<'spm' | 'tuist' | 'xcode'> {
    // Check Tuist first (Tuist projects also have .xcworkspace but should prefer tuist)
    try {
      await fs.access(path.join(this.config.root, 'Tuist.swift'));
      return 'tuist';
    } catch {}

    // Check SPM
    try {
      await fs.access(path.join(this.config.root, 'Package.swift'));
      return 'spm';
    } catch {}

    // Check for Xcode project files (.xcworkspace or .xcodeproj)
    try {
      const entries = await fs.readdir(this.config.root);
      const hasXcodeProject = entries.some(
        e => e.endsWith('.xcworkspace') || e.endsWith('.xcodeproj')
      );
      if (hasXcodeProject) return 'xcode';
    } catch {}

    return 'spm';
  }

  private resolvePath(relativePath: string): string {
    // Normalize common "root" inputs that agents naturally try.
    // "/", "", and "." all mean "workspace root". Without this, "/" resolves
    // to the filesystem root and fails the traversal check — a bad DX trap.
    const normalized = (relativePath === '/' || relativePath === '') ? '.' : relativePath;

    // Strip leading slash from relative-looking paths (e.g., "/Modules" → "Modules").
    // An agent might prefix with "/" thinking it means "from workspace root".
    const cleaned = normalized.startsWith('/') && !normalized.startsWith('//')
      ? normalized.slice(1)
      : normalized;

    const resolved = path.resolve(this.config.root, cleaned);
    const rootWithSep = this.config.root.endsWith(path.sep)
      ? this.config.root
      : this.config.root + path.sep;

    if (resolved !== this.config.root && !resolved.startsWith(rootWithSep)) {
      throw new Error(
        `Path escapes workspace root: "${relativePath}". ` +
        `Paths must be relative to the workspace root (e.g., "Modules/MyModule" or "." for root).`
      );
    }

    return resolved;
  }

  private isPathAllowed(relativePath: string): boolean {
    // Use Node's native path.matchesGlob for reliable, battle-tested glob matching.
    // This is a security boundary (write allowlist), so we avoid hand-rolled implementations.
    return this.config.writeAllowlist.some(
      (pattern) => path.matchesGlob(relativePath, pattern)
    );
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private generateEditPreview(
    original: string,
    edited: string,
    oldString: string,
    newString: string,
    contextLines: number = 3
  ): { before: string; after: string; lineNumber?: number } {
    // Find the first occurrence of oldString to show in preview
    const index = original.indexOf(oldString);
    if (index === -1) {
      return { before: '', after: '' };
    }

    // Find line number of the change
    const beforeChange = original.substring(0, index);
    const lineNumber = beforeChange.split('\n').length;

    // Get lines around the change
    const originalLines = original.split('\n');
    const editedLines = edited.split('\n');

    const startLine = Math.max(0, lineNumber - contextLines - 1);
    const endLine = Math.min(originalLines.length, lineNumber + contextLines + 2);

    const beforeLines = originalLines.slice(startLine, endLine);
    const afterLines = editedLines.slice(startLine, Math.min(editedLines.length, startLine + beforeLines.length + 10));

    // Format with line numbers
    const formatLines = (lines: string[], start: number) =>
      lines.map((line, i) => `${(start + i + 1).toString().padStart(4)}: ${line}`).join('\n');

    return {
      before: formatLines(beforeLines, startLine),
      after: formatLines(afterLines, startLine),
      lineNumber,
    };
  }
}
