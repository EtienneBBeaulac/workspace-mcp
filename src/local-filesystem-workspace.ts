// Local filesystem implementation of Workspace interface

import { promises as fs } from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { Workspace, FileEntry, SearchResult, SwiftCheckResult, TestResult, BuildResult, EditResult, BatchSwiftCheckResult } from './workspace.js';
import type { WorkspaceConfig } from './config.js';

const execAsync = promisify(exec);

export class LocalFilesystemWorkspace implements Workspace {
  constructor(private readonly config: WorkspaceConfig) {}

  async read(relativePath: string, offset?: number, limit?: number): Promise<string> {
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
      
      const content = await fs.readFile(fullPath, 'utf-8');
      const lines = content.split('\n');

      // If offset/limit specified, return paginated plain text
      if (offset !== undefined || limit !== undefined) {
        const start = (offset ?? 1) - 1; // Convert 1-indexed to 0-indexed
        const end = limit !== undefined ? start + limit : lines.length;
        return lines.slice(start, end).join('\n');
      }

      // Otherwise return with line numbers (cat -n format)
      return lines
        .map((line, i) => `${(i + 1).toString().padStart(4)}→${line}`)
        .join('\n');
    } catch (error) {
      throw new Error(`Failed to read ${relativePath}: ${error}`);
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
      throw new Error(`Failed to write ${relativePath}: ${error}`);
    }
  }

  async edit(
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
      return {
        success: false,
        error: `Failed to edit ${relativePath}: ${error}`,
      };
    }
  }

  async list(relativePath: string = '', recursive: boolean = false, maxDepth?: number): Promise<FileEntry[]> {
    const fullPath = this.resolvePath(relativePath);
    
    if (!recursive) {
      // Non-recursive: original behavior
      return this.listDirectory(fullPath, relativePath, 0);
    }
    
    // Recursive listing
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
      throw new Error(`Failed to list ${relativePath}: ${error}`);
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

  async search(
    pattern: string,
    glob?: string,
    outputMode: 'content' | 'files' | 'count' = 'content',
    contextLines?: number,
    caseInsensitive: boolean = false,
    limit?: number,
    offset?: number
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    
    try {
      const globArg = glob ? `--glob "${glob}"` : '';
      const contextArg = contextLines !== undefined ? `-C ${contextLines}` : '';
      const caseArg = caseInsensitive ? '-i' : '';
      
      let cmd: string;
      if (outputMode === 'files') {
        cmd = `rg --files-with-matches ${caseArg} ${globArg} "${pattern}" "${this.config.root}" 2>/dev/null`;
      } else if (outputMode === 'count') {
        cmd = `rg --count ${caseArg} ${globArg} "${pattern}" "${this.config.root}" 2>/dev/null`;
      } else {
        cmd = `rg --line-number --no-heading ${caseArg} ${contextArg} ${globArg} "${pattern}" "${this.config.root}" 2>/dev/null`;
      }
      
      const { stdout } = await execAsync(cmd, { maxBuffer: 10 * 1024 * 1024 });
      const lines = stdout.trim().split('\n').filter(l => l.length > 0);
      
      const startIdx = offset ?? 0;
      const endIdx = limit !== undefined ? startIdx + limit : lines.length;
      const paginatedLines = lines.slice(startIdx, endIdx);
      
      for (const line of paginatedLines) {
        if (outputMode === 'files') {
          const relativePath = path.relative(this.config.root, line);
          results.push({ file: relativePath, line: 0, content: '' });
        } else if (outputMode === 'count') {
          const match = line.match(/^(.+?):(\d+)$/);
          if (match) {
            const [, filePath, count] = match;
            results.push({
              file: path.relative(this.config.root, filePath),
              line: parseInt(count, 10),
              content: '',
            });
          }
        } else {
          const match = line.match(/^(.+?):(\d+):(.+)$/);
          if (match) {
            const [, filePath, lineNum, content] = match;
            results.push({
              file: path.relative(this.config.root, filePath),
              line: parseInt(lineNum, 10),
              content: content.trim(),
            });
          }
        }
      }
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code !== 1) {
        throw new Error(`Search failed: ${error}`);
      }
    }
    return results;
  }

  async checkSwift(relativePath: string): Promise<SwiftCheckResult> {
    const fullPath = this.resolvePath(relativePath);

    try {
      // Check if swiftc is available
      await execAsync('which swiftc');
    } catch {
      return {
        success: false,
        unavailable: true,
        reason: 'swiftc not found in PATH. Install Xcode Command Line Tools.',
      };
    }

    try {
      const { stdout, stderr } = await execAsync(`swiftc -typecheck "${fullPath}" 2>&1`);
      
      // swiftc returns 0 on success
      return { success: true };
    } catch (error: any) {
      // Parse error output
      const output = error.stdout || error.stderr || error.message || '';
      const errors = output
        .split('\n')
        .filter((line: string) => line.includes('error:'))
        .map((line: string) => line.trim());

      return {
        success: false,
        errors: errors.length > 0 ? errors : [output.trim()],
      };
    }
  }

  async batchCheckSwift(relativePaths: string[]): Promise<BatchSwiftCheckResult> {
    try {
      await execAsync('which swiftc');
    } catch {
      return {
        totalFiles: relativePaths.length,
        passed: 0,
        failed: 0,
        results: relativePaths.map(file => ({
          file,
          success: false,
          errors: ['swiftc not found in PATH. Install Xcode Command Line Tools.'],
        })),
      };
    }

    const results = await Promise.all(
      relativePaths.map(async (file) => {
        const result = await this.checkSwift(file);
        return {
          file,
          success: result.success,
          errors: 'errors' in result ? result.errors : undefined,
        };
      })
    );

    const passed = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    return {
      totalFiles: relativePaths.length,
      passed,
      failed,
      results,
    };
  }

  async runTests(testTarget?: string): Promise<TestResult> {
    // Auto-detect build system
    const buildSystem = await this.detectBuildSystem();
    
    try {
      let cmd: string;
      
      if (buildSystem === 'tuist') {
        // Tuist uses xcodebuild
        cmd = testTarget
          ? `xcodebuild test -scheme ${testTarget} -destination 'platform=iOS Simulator,name=iPhone 15'`
          : `tuist test`;
      } else if (buildSystem === 'xcode') {
        // Direct xcodebuild
        cmd = testTarget
          ? `xcodebuild test -scheme ${testTarget}`
          : `xcodebuild test`;
      } else {
        // SPM
        cmd = testTarget
          ? `swift test --filter ${testTarget}`
          : `swift test`;
      }
      
      const { stdout, stderr } = await execAsync(cmd, {
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
    // Auto-detect build system
    const buildSystem = await this.detectBuildSystem();
    
    try {
      let cmd: string;
      
      if (buildSystem === 'tuist') {
        cmd = buildTarget 
          ? `tuist build ${buildTarget}`
          : `tuist build`;
      } else if (buildSystem === 'xcode') {
        cmd = buildTarget
          ? `xcodebuild -scheme ${buildTarget} build`
          : `xcodebuild build`;
      } else {
        // SPM
        cmd = buildTarget
          ? `swift build --product ${buildTarget}`
          : `swift build`;
      }
      
      const { stdout, stderr } = await execAsync(cmd, {
        cwd: this.config.root,
        maxBuffer: 10 * 1024 * 1024,
      });

      return {
        success: true,
        output: stdout + stderr,
      };
    } catch (error: any) {
      const output = error.stdout || error.stderr || error.message || '';
      const errors = output
        .split('\n')
        .filter((line: string) => line.includes('error:'))
        .map((line: string) => line.trim());

      return {
        success: false,
        errors: errors.length > 0 ? errors : [output.trim()],
      };
    }
  }

  private async detectBuildSystem(): Promise<'spm' | 'tuist' | 'xcode'> {
    try {
      // Check for Tuist.swift
      await fs.access(path.join(this.config.root, 'Tuist.swift'));
      return 'tuist';
    } catch {}

    try {
      // Check for Package.swift (SPM)
      await fs.access(path.join(this.config.root, 'Package.swift'));
      return 'spm';
    } catch {}

    // Default to xcodebuild
    return 'xcode';
  }

  private resolvePath(relativePath: string): string {
    // Normalize and join with root
    const normalized = path.normalize(relativePath);
    
    // Prevent .. escapes
    if (normalized.includes('..')) {
      throw new Error(`Invalid path (contains ..): ${relativePath}`);
    }

    return path.join(this.config.root, normalized);
  }

  private isPathAllowed(relativePath: string): boolean {
    // Simple glob matching (supports ** and * wildcards)
    for (const pattern of this.config.writeAllowlist) {
      if (this.matchesGlob(relativePath, pattern)) {
        return true;
      }
    }
    return false;
  }

  private matchesGlob(filePath: string, pattern: string): boolean {
    // Convert glob pattern to regex
    // Replace ** with placeholder first to avoid collision with single *
    const regexPattern = pattern
      .replace(/\*\*/g, '__DOUBLESTAR__') // Placeholder for **
      .replace(/\*/g, '[^/]*') // * matches any non-slash
      .replace(/\?/g, '[^/]') // ? matches single char
      .replace(/__DOUBLESTAR__/g, '.*'); // ** matches any path including /

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(filePath);
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
