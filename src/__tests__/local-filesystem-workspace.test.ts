import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { LocalFilesystemWorkspace } from '../local-filesystem-workspace.js';
import type { WorkspaceConfig } from '../config.js';

// Helper to create a temp workspace for testing
async function createTempWorkspace(): Promise<{ config: WorkspaceConfig; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-mcp-test-'));
  const config: WorkspaceConfig = {
    root,
    name: 'test',
    writeAllowlist: ['src/**/*.swift', 'tests/**/*.swift'],
  };
  return {
    config,
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

describe('LocalFilesystemWorkspace', () => {
  // --- resolvePath (tested indirectly through read/write/list) ---

  describe('path traversal prevention', () => {
    let ws: LocalFilesystemWorkspace;
    let cleanup: () => Promise<void>;

    before(async () => {
      const temp = await createTempWorkspace();
      ws = new LocalFilesystemWorkspace(temp.config);
      cleanup = temp.cleanup;
    });

    after(async () => {
      await cleanup();
    });

    it('rejects paths with .. that escape root', async () => {
      await assert.rejects(
        () => ws.read('../../../etc/passwd'),
        (err: Error) => {
          assert.match(err.message, /Path escapes workspace root/);
          return true;
        }
      );
    });

    it('treats leading-slash paths as relative to workspace root', async () => {
      // "/etc/passwd" is normalized to "etc/passwd" relative to workspace root.
      // This is safe (stays inside workspace) but the file won't exist.
      await assert.rejects(
        () => ws.read('/etc/passwd'),
        (err: Error) => {
          // Should NOT escape — it's treated as workspace-relative
          assert.doesNotMatch(err.message, /Path escapes workspace root/);
          assert.match(err.message, /Failed to read/);
          return true;
        }
      );
    });

    it('rejects traversal disguised with leading slash', async () => {
      // "/../../../etc/passwd" strips to "../../../etc/passwd" which still escapes
      await assert.rejects(
        () => ws.read('/../../../etc/passwd'),
        (err: Error) => {
          assert.match(err.message, /Path escapes workspace root/);
          return true;
        }
      );
    });

    it('allows filenames with double dots (e.g., file..name.swift)', async () => {
      // This should NOT throw "path escapes workspace root"
      // It will throw "file not found" because the file doesn't exist, but that's fine
      await assert.rejects(
        () => ws.read('src/file..name.swift'),
        (err: Error) => {
          assert.match(err.message, /Failed to read/);
          // Should NOT contain "escapes workspace root"
          assert.doesNotMatch(err.message, /Path escapes workspace root/);
          return true;
        }
      );
    });
  });

  // --- read ---

  describe('read', () => {
    let ws: LocalFilesystemWorkspace;
    let root: string;
    let cleanup: () => Promise<void>;

    before(async () => {
      const temp = await createTempWorkspace();
      ws = new LocalFilesystemWorkspace(temp.config);
      root = temp.config.root;
      cleanup = temp.cleanup;

      // Create a test file
      await fs.mkdir(path.join(root, 'src'), { recursive: true });
      await fs.writeFile(
        path.join(root, 'src/example.swift'),
        'line1\nline2\nline3\nline4\nline5\n',
        'utf-8'
      );
    });

    after(async () => {
      await cleanup();
    });

    it('returns line-numbered content with metadata', async () => {
      const result = await ws.read('src/example.swift');
      assert.ok(result.content.includes('line1'));
      assert.ok(result.content.includes('line5'));
      assert.equal(result.totalLines, 6); // 5 lines + trailing newline
      assert.equal(result.startLine, 1);
      assert.equal(result.truncated, false);
    });

    it('returns paginated content with offset/limit', async () => {
      const result = await ws.read('src/example.swift', { offset: 2, limit: 2 });
      assert.ok(result.content.includes('line2'));
      assert.ok(result.content.includes('line3'));
      assert.ok(!result.content.includes('line1'));
      assert.equal(result.startLine, 2);
      assert.equal(result.endLine, 3); // offset 2 + limit 2 = lines 2-3
      assert.equal(result.truncated, false);
    });

    it('rejects files larger than 5MB', async () => {
      const bigFile = path.join(root, 'src/big.swift');
      // Create a file slightly over 5MB
      const bigContent = 'x'.repeat(6 * 1024 * 1024);
      await fs.writeFile(bigFile, bigContent, 'utf-8');

      await assert.rejects(
        () => ws.read('src/big.swift'),
        (err: Error) => {
          assert.match(err.message, /File too large/);
          return true;
        }
      );
    });

    it('throws for non-existent file', async () => {
      await assert.rejects(
        () => ws.read('src/nonexistent.swift'),
        (err: Error) => {
          assert.match(err.message, /Failed to read/);
          return true;
        }
      );
    });
  });

  // --- write ---

  describe('write', () => {
    let ws: LocalFilesystemWorkspace;
    let root: string;
    let cleanup: () => Promise<void>;

    before(async () => {
      const temp = await createTempWorkspace();
      ws = new LocalFilesystemWorkspace(temp.config);
      root = temp.config.root;
      cleanup = temp.cleanup;
    });

    after(async () => {
      await cleanup();
    });

    it('writes to allowed path', async () => {
      await ws.write('src/new.swift', 'hello swift');
      const written = await fs.readFile(path.join(root, 'src/new.swift'), 'utf-8');
      assert.equal(written, 'hello swift');
    });

    it('creates intermediate directories', async () => {
      await ws.write('src/deep/nested/file.swift', 'nested content');
      const written = await fs.readFile(path.join(root, 'src/deep/nested/file.swift'), 'utf-8');
      assert.equal(written, 'nested content');
    });

    it('rejects writes to paths not on allowlist', async () => {
      await assert.rejects(
        () => ws.write('forbidden/file.txt', 'nope'),
        (err: Error) => {
          assert.match(err.message, /Write not allowed/);
          return true;
        }
      );
    });
  });

  // --- edit ---

  describe('edit', () => {
    let ws: LocalFilesystemWorkspace;
    let root: string;
    let cleanup: () => Promise<void>;

    before(async () => {
      const temp = await createTempWorkspace();
      ws = new LocalFilesystemWorkspace(temp.config);
      root = temp.config.root;
      cleanup = temp.cleanup;
    });

    after(async () => {
      await cleanup();
    });

    it('replaces unique string successfully', async () => {
      await fs.mkdir(path.join(root, 'src'), { recursive: true });
      await fs.writeFile(path.join(root, 'src/edit.swift'), 'func oldName() {}\n', 'utf-8');

      const result = await ws.edit('src/edit.swift', 'func oldName()', 'func newName()');
      assert.equal(result.totalFiles, 1);
      assert.equal(result.succeeded, 1);
      assert.equal(result.results[0].success, true);
      assert.equal(result.results[0].occurrences, 1);

      const content = await fs.readFile(path.join(root, 'src/edit.swift'), 'utf-8');
      assert.ok(content.includes('func newName()'));
    });

    it('fails when string not found', async () => {
      await fs.writeFile(path.join(root, 'src/edit2.swift'), 'hello world\n', 'utf-8');

      const result = await ws.edit('src/edit2.swift', 'nonexistent', 'replacement');
      assert.equal(result.succeeded, 0);
      assert.equal(result.failed, 1);
      assert.equal(result.results[0].success, false);
      assert.match(result.results[0].error ?? '', /not found/);
    });

    it('fails when string is not unique and replaceAll is false', async () => {
      await fs.writeFile(path.join(root, 'src/edit3.swift'), 'foo bar foo baz foo\n', 'utf-8');

      const result = await ws.edit('src/edit3.swift', 'foo', 'qux');
      assert.equal(result.succeeded, 0);
      assert.equal(result.failed, 1);
      assert.equal(result.results[0].success, false);
      assert.match(result.results[0].error ?? '', /3 times/);
    });

    it('replaces all occurrences with replaceAll=true', async () => {
      await fs.writeFile(path.join(root, 'src/edit4.swift'), 'foo bar foo baz foo\n', 'utf-8');

      const result = await ws.edit('src/edit4.swift', 'foo', 'qux', { replaceAll: true });
      assert.equal(result.succeeded, 1);
      assert.equal(result.results[0].success, true);
      assert.equal(result.results[0].occurrences, 3);

      const content = await fs.readFile(path.join(root, 'src/edit4.swift'), 'utf-8');
      assert.ok(!content.includes('foo'));
      assert.ok(content.includes('qux'));
    });

    it('supports regex with useRegex=true', async () => {
      await fs.writeFile(path.join(root, 'src/edit5.swift'), 'func test123() {}\n', 'utf-8');

      const result = await ws.edit('src/edit5.swift', 'func \\w+\\(\\)', 'func replaced()', { useRegex: true });
      assert.equal(result.succeeded, 1);
      assert.equal(result.results[0].success, true);

      const content = await fs.readFile(path.join(root, 'src/edit5.swift'), 'utf-8');
      assert.ok(content.includes('func replaced()'));
    });

    it('rejects edits to paths not on allowlist', async () => {
      const result = await ws.edit('forbidden/file.txt', 'old', 'new');
      assert.equal(result.succeeded, 0);
      assert.equal(result.failed, 1);
      assert.equal(result.results[0].success, false);
      assert.match(result.results[0].error ?? '', /Edit not allowed/);
    });

    it('applies same edit to multiple files (bulk edit)', async () => {
      await fs.writeFile(path.join(root, 'src/a.swift'), 'let oldValue = 42\n', 'utf-8');
      await fs.writeFile(path.join(root, 'src/b.swift'), 'var oldValue = "test"\n', 'utf-8');
      await fs.writeFile(path.join(root, 'src/c.swift'), 'func foo() { return oldValue }\n', 'utf-8');

      const result = await ws.edit(
        ['src/a.swift', 'src/b.swift', 'src/c.swift'],
        'oldValue',
        'newValue',
      );

      assert.equal(result.totalFiles, 3);
      assert.equal(result.succeeded, 3, `Expected 3 succeeded, got ${result.succeeded}. Results: ${JSON.stringify(result.results)}`);
      assert.equal(result.failed, 0);

      // Verify all files were edited
      const aContent = await fs.readFile(path.join(root, 'src/a.swift'), 'utf-8');
      const bContent = await fs.readFile(path.join(root, 'src/b.swift'), 'utf-8');
      const cContent = await fs.readFile(path.join(root, 'src/c.swift'), 'utf-8');
      assert.ok(aContent.includes('newValue'));
      assert.ok(bContent.includes('newValue'));
      assert.ok(cContent.includes('newValue'));
    });

    it('bulk edit reports per-file success/failure', async () => {
      await fs.writeFile(path.join(root, 'src/exists.swift'), 'foo bar\n', 'utf-8');
      await fs.writeFile(path.join(root, 'src/missing.swift'), 'baz qux\n', 'utf-8');

      const result = await ws.edit(
        ['src/exists.swift', 'src/missing.swift'],
        'foo',  // only in exists.swift
        'replaced',
      );

      assert.equal(result.totalFiles, 2);
      assert.equal(result.succeeded, 1);  // exists.swift succeeds
      assert.equal(result.failed, 1);     // missing.swift fails (foo not found)

      const successFile = result.results.find(r => r.file === 'src/exists.swift');
      const failFile = result.results.find(r => r.file === 'src/missing.swift');

      assert.equal(successFile?.success, true);
      assert.equal(failFile?.success, false);
      assert.match(failFile?.error ?? '', /not found/);
    });
  });

  // --- list ---

  describe('list', () => {
    let ws: LocalFilesystemWorkspace;
    let root: string;
    let cleanup: () => Promise<void>;

    before(async () => {
      const temp = await createTempWorkspace();
      ws = new LocalFilesystemWorkspace(temp.config);
      root = temp.config.root;
      cleanup = temp.cleanup;

      // Create directory structure
      await fs.mkdir(path.join(root, 'src/nested'), { recursive: true });
      await fs.writeFile(path.join(root, 'src/a.swift'), 'a', 'utf-8');
      await fs.writeFile(path.join(root, 'src/nested/b.swift'), 'b', 'utf-8');
    });

    after(async () => {
      await cleanup();
    });

    it('lists directory contents non-recursively', async () => {
      const entries = await ws.list({ path: 'src' });
      const names = entries.map(e => e.name);
      assert.ok(names.includes('a.swift'));
      assert.ok(names.includes('nested'));
      // Should not include nested/b.swift at top level
      assert.ok(!names.includes('b.swift'));
    });

    it('accepts "/" as workspace root (common agent input)', async () => {
      const entries = await ws.list({ path: '/' });
      const names = entries.map(e => e.name);
      assert.ok(names.includes('src'), 'Should list workspace root when given "/"');
    });

    it('accepts "" as workspace root', async () => {
      const entries = await ws.list({ path: '' });
      const names = entries.map(e => e.name);
      assert.ok(names.includes('src'), 'Should list workspace root when given ""');
    });

    it('treats "/src" as "src" (leading slash normalization)', async () => {
      const entries = await ws.list({ path: '/src' });
      const names = entries.map(e => e.name);
      assert.ok(names.includes('a.swift'), 'Should list src/ contents when given "/src"');
    });

    it('lists directory contents recursively', async () => {
      const entries = await ws.list({ path: 'src', recursive: true });
      const paths = entries.map(e => e.path);
      assert.ok(paths.some(p => p.includes('a.swift')));
      assert.ok(paths.some(p => p.includes('b.swift')));
    });

    it('respects maxDepth', async () => {
      const entries = await ws.list({ path: 'src', recursive: true, maxDepth: 0 });
      const names = entries.map(e => e.name);
      assert.ok(names.includes('a.swift'));
      assert.ok(names.includes('nested'));
      // depth 0 = only the listed directory, not children of nested
      assert.ok(!names.includes('b.swift'));
    });
  });

  // --- glob matching ---

  describe('isPathAllowed (via write)', () => {
    let ws: LocalFilesystemWorkspace;
    let cleanup: () => Promise<void>;

    before(async () => {
      const temp = await createTempWorkspace();
      // allowlist: ['src/**/*.swift', 'tests/**/*.swift']
      ws = new LocalFilesystemWorkspace(temp.config);
      cleanup = temp.cleanup;
    });

    after(async () => {
      await cleanup();
    });

    it('allows matching paths', async () => {
      // Should succeed (writes to allowed path)
      await ws.write('src/foo.swift', 'ok');
      await ws.write('src/deep/bar.swift', 'ok');
      await ws.write('tests/MyTest.swift', 'ok');
    });

    it('rejects non-matching extensions', async () => {
      await assert.rejects(() => ws.write('src/file.txt', 'nope'), /Write not allowed/);
    });

    it('rejects non-matching directories', async () => {
      await assert.rejects(() => ws.write('other/file.swift', 'nope'), /Write not allowed/);
    });
  });

  // --- escapeRegex ---

  describe('edit with special regex chars in literal mode', () => {
    let ws: LocalFilesystemWorkspace;
    let root: string;
    let cleanup: () => Promise<void>;

    before(async () => {
      const temp = await createTempWorkspace();
      ws = new LocalFilesystemWorkspace(temp.config);
      root = temp.config.root;
      cleanup = temp.cleanup;
    });

    after(async () => {
      await cleanup();
    });

    it('escapes regex special characters in literal mode', async () => {
      await fs.mkdir(path.join(root, 'src'), { recursive: true });
      await fs.writeFile(
        path.join(root, 'src/special.swift'),
        'let pattern = "foo.*bar"\n',
        'utf-8'
      );

      const result = await ws.edit('src/special.swift', 'foo.*bar', 'baz');
      assert.equal(result.succeeded, 1);
      assert.equal(result.results[0].success, true);

      const content = await fs.readFile(path.join(root, 'src/special.swift'), 'utf-8');
      assert.ok(content.includes('baz'));
      assert.ok(!content.includes('foo.*bar'));
    });
  });

  // --- error message formatting ---

  describe('error messages', () => {
    let ws: LocalFilesystemWorkspace;
    let root: string;
    let cleanup: () => Promise<void>;

    before(async () => {
      const temp = await createTempWorkspace();
      ws = new LocalFilesystemWorkspace(temp.config);
      root = temp.config.root;
      cleanup = temp.cleanup;
    });

    after(async () => {
      await cleanup();
    });

    it('produces readable error messages (not [object Object])', async () => {
      await assert.rejects(
        () => ws.read('src/nonexistent.swift'),
        (err: Error) => {
          assert.doesNotMatch(err.message, /\[object Object\]/);
          assert.match(err.message, /Failed to read/);
          assert.match(err.message, /no such file|ENOENT/i);
          return true;
        }
      );
    });

    it('truncates large files and reports metadata', async () => {
      const manyLines = Array.from({ length: 600 }, (_, i) => `line${i + 1}`).join('\n');
      await fs.mkdir(path.join(root, 'src'), { recursive: true });
      await fs.writeFile(path.join(root, 'src/large.swift'), manyLines, 'utf-8');

      const result = await ws.read('src/large.swift');
      assert.equal(result.totalLines, 600);
      assert.equal(result.startLine, 1);
      assert.equal(result.endLine, 500);
      assert.equal(result.truncated, true);
      assert.ok(result.content.includes('line1'));
      assert.ok(!result.content.includes('line501'));
    });
  });

  // --- search (requires rg) ---

  describe('search', () => {
    let ws: LocalFilesystemWorkspace;
    let root: string;
    let cleanup: () => Promise<void>;

    before(async () => {
      const temp = await createTempWorkspace();
      ws = new LocalFilesystemWorkspace(temp.config);
      root = temp.config.root;
      cleanup = temp.cleanup;

      // Create files with searchable content
      await fs.mkdir(path.join(root, 'src'), { recursive: true });
      await fs.writeFile(
        path.join(root, 'src/search-target.swift'),
        [
          'import Foundation',
          '',
          'class SearchExample {',
          '  func findMe() {',
          '    print("hello")',
          '  }',
          '',
          '  func findMeAlso() {',
          '    print("world")',
          '  }',
          '}',
        ].join('\n'),
        'utf-8'
      );
    });

    after(async () => {
      await cleanup();
    });

    it('finds content matches without context', async () => {
      const results = await ws.search('findMe', { outputMode: 'content' });
      assert.ok(results.length >= 1, `Expected at least 1 match, got ${results.length}`);
      assert.equal(results[0].mode, 'content');
      if (results[0].mode === 'content') {
        assert.ok(results[0].content.includes('findMe'));
        assert.ok(results[0].file.includes('search-target.swift'));
        assert.ok(results[0].line > 0);
      }
    });

    it('finds content matches with context lines', async () => {
      const results = await ws.search('findMe', { outputMode: 'content', contextLines: 1 });
      assert.ok(results.length >= 1, 'Expected at least 1 match');
      if (results[0].mode === 'content') {
        const hasContext = results[0].contextBefore !== undefined || results[0].contextAfter !== undefined;
        assert.ok(hasContext, 'Expected context lines to be present');
      }
    });

    it('returns file paths in files mode', async () => {
      const results = await ws.search('findMe', { outputMode: 'files' });
      assert.ok(results.length >= 1);
      assert.equal(results[0].mode, 'files');
      if (results[0].mode === 'files') {
        assert.ok(results[0].file.includes('search-target.swift'));
      }
    });

    it('returns counts in count mode', async () => {
      const results = await ws.search('findMe', { outputMode: 'count' });
      assert.ok(results.length >= 1);
      assert.equal(results[0].mode, 'count');
      if (results[0].mode === 'count') {
        assert.ok(results[0].count >= 1, `Expected count >= 1, got ${results[0].count}`);
        assert.ok(results[0].file.includes('search-target.swift'));
      }
    });

    it('returns empty array for no matches', async () => {
      const results = await ws.search('xyzNonexistentPattern123');
      assert.equal(results.length, 0);
    });

    it('respects glob filter', async () => {
      const results = await ws.search('findMe', { glob: '**/*.txt', outputMode: 'files' });
      // No .txt files exist, so should find nothing
      assert.equal(results.length, 0);
    });

    it('scopes search to subdirectory with path parameter', async () => {
      // Create a file outside the src directory
      await fs.mkdir(path.join(root, 'other'), { recursive: true });
      await fs.writeFile(
        path.join(root, 'other/decoy.swift'),
        'func findMe() {}\n',
        'utf-8'
      );

      // Search scoped to 'src' should only find src/search-target.swift
      const results = await ws.search('findMe', { path: 'src', outputMode: 'files' });
      assert.ok(results.length >= 1);
      for (const r of results) {
        if (r.mode === 'files') {
          assert.ok(!r.file.includes('other/'), `Expected no results from other/, got ${r.file}`);
        }
      }

      // Search scoped to 'other' should only find other/decoy.swift
      const otherResults = await ws.search('findMe', { path: 'other', outputMode: 'files' });
      assert.ok(otherResults.length >= 1);
      for (const r of otherResults) {
        if (r.mode === 'files') {
          assert.ok(r.file.includes('decoy.swift'), `Expected decoy.swift, got ${r.file}`);
        }
      }
    });

    it('scopes search to a specific file via path parameter', async () => {
      // Content mode: single-file search must still include filename in results
      const contentResults = await ws.search('findMe', { path: 'src/search-target.swift', outputMode: 'content' });
      assert.ok(contentResults.length >= 1, `Expected matches in single-file content search, got ${contentResults.length}`);
      if (contentResults[0].mode === 'content') {
        assert.ok(contentResults[0].file.includes('search-target.swift'));
        assert.ok(contentResults[0].line > 0);
      }

      // Files mode
      const fileResults = await ws.search('findMe', { path: 'src/search-target.swift', outputMode: 'files' });
      assert.ok(fileResults.length >= 1, `Expected matches in single-file files search, got ${fileResults.length}`);

      // Count mode
      const countResults = await ws.search('findMe', { path: 'src/search-target.swift', outputMode: 'count' });
      assert.ok(countResults.length >= 1, `Expected matches in single-file count search, got ${countResults.length}`);
      if (countResults[0].mode === 'count') {
        assert.ok(countResults[0].count >= 1);
      }
    });

    it('returns correct line numbers for content matches', async () => {
      // 'findMe' appears on lines 4 and 8 in search-target.swift
      const results = await ws.search('findMe', { path: 'src/search-target.swift', outputMode: 'content' });
      assert.equal(results.length, 2, `Expected exactly 2 matches, got ${results.length}`);
      if (results[0].mode === 'content' && results[1].mode === 'content') {
        assert.equal(results[0].line, 4); // func findMe()
        assert.equal(results[1].line, 8); // func findMeAlso()
      }
    });

    it('returns exact count in count mode', async () => {
      const results = await ws.search('findMe', { path: 'src/search-target.swift', outputMode: 'count' });
      assert.equal(results.length, 1);
      if (results[0].mode === 'count') {
        assert.equal(results[0].count, 2); // findMe appears on 2 lines
      }
    });

    it('paginates content results with limit', async () => {
      const results = await ws.search('findMe', { outputMode: 'content', limit: 1 });
      assert.equal(results.length, 1, 'Limit=1 should return exactly 1 result');
    });

    it('paginates content results with offset', async () => {
      const all = await ws.search('findMe', { outputMode: 'content' });
      const skipped = await ws.search('findMe', { outputMode: 'content', offset: 1 });
      assert.equal(skipped.length, all.length - 1, 'Offset=1 should skip first result');
      if (all[1]?.mode === 'content' && skipped[0]?.mode === 'content') {
        assert.equal(skipped[0].line, all[1].line);
      }
    });

    it('paginates content results with offset and limit', async () => {
      const results = await ws.search('findMe', { outputMode: 'content', offset: 1, limit: 1 });
      assert.equal(results.length, 1);
      if (results[0].mode === 'content') {
        assert.equal(results[0].line, 8); // second match = findMeAlso on line 8
      }
    });

    it('supports case-insensitive search', async () => {
      const sensitive = await ws.search('FINDME', { outputMode: 'content' });
      assert.equal(sensitive.length, 0, 'Case-sensitive should find nothing');

      const insensitive = await ws.search('FINDME', { outputMode: 'content', caseInsensitive: true });
      assert.ok(insensitive.length >= 1, 'Case-insensitive should find matches');
    });

    it('returns relative file paths (not absolute)', async () => {
      const results = await ws.search('findMe', { outputMode: 'files' });
      for (const r of results) {
        if (r.mode === 'files') {
          assert.ok(!r.file.startsWith('/'), `Expected relative path, got absolute: ${r.file}`);
        }
      }

      const contentResults = await ws.search('findMe', { outputMode: 'content' });
      for (const r of contentResults) {
        if (r.mode === 'content') {
          assert.ok(!r.file.startsWith('/'), `Expected relative path, got absolute: ${r.file}`);
        }
      }
    });

    it('handles context lines with single-file path', async () => {
      const results = await ws.search('findMe', {
        path: 'src/search-target.swift',
        outputMode: 'content',
        contextLines: 1,
      });
      assert.ok(results.length >= 1, 'Should find matches with context in single file');
      if (results[0].mode === 'content') {
        const hasContext = results[0].contextBefore !== undefined || results[0].contextAfter !== undefined;
        assert.ok(hasContext, 'Should include context lines for single-file search');
      }
    });

    it('combines path and glob filters', async () => {
      // Create files in a subdirectory with different extensions
      await fs.mkdir(path.join(root, 'mixed'), { recursive: true });
      await fs.writeFile(path.join(root, 'mixed/code.swift'), 'findMe swift\n', 'utf-8');
      await fs.writeFile(path.join(root, 'mixed/code.txt'), 'findMe text\n', 'utf-8');

      // Search with path + glob should intersect both filters
      const results = await ws.search('findMe', { path: 'mixed', glob: '**/*.swift', outputMode: 'files' });
      assert.equal(results.length, 1);
      if (results[0].mode === 'files') {
        assert.ok(results[0].file.includes('code.swift'));
      }
    });

    it('returns error for nonexistent search path', async () => {
      await assert.rejects(
        () => ws.search('anything', { path: 'nonexistent/directory' }),
        (err: Error) => {
          assert.match(err.message, /Search failed/);
          return true;
        }
      );
    });

    it('handles files with hyphens in path', async () => {
      await fs.mkdir(path.join(root, 'my-module'), { recursive: true });
      await fs.writeFile(path.join(root, 'my-module/my-file.swift'), 'findMe here\n', 'utf-8');

      const results = await ws.search('findMe', { path: 'my-module', outputMode: 'content' });
      assert.ok(results.length >= 1, 'Should find match in hyphenated path');
      if (results[0].mode === 'content') {
        assert.ok(results[0].file.includes('my-module/my-file.swift'), `Got file: ${results[0].file}`);
        assert.equal(results[0].line, 1);
      }
    });
  });

  // --- regex backreference in edit ---

  describe('edit with regex backreferences', () => {
    let ws: LocalFilesystemWorkspace;
    let root: string;
    let cleanup: () => Promise<void>;

    before(async () => {
      const temp = await createTempWorkspace();
      ws = new LocalFilesystemWorkspace(temp.config);
      root = temp.config.root;
      cleanup = temp.cleanup;
    });

    after(async () => {
      await cleanup();
    });

    it('supports $1 backreferences with useRegex=true', async () => {
      await fs.mkdir(path.join(root, 'src'), { recursive: true });
      await fs.writeFile(
        path.join(root, 'src/backref.swift'),
        'func myFunc(param: String) {}\n',
        'utf-8'
      );

      // Capture group around the function name, replace preserving it
      const result = await ws.edit(
        'src/backref.swift',
        'func (\\w+)\\(param: String\\)',
        'func $1(param: Int)',
        { useRegex: true }
      );
      assert.equal(result.succeeded, 1);
      assert.equal(result.results[0].success, true);

      const content = await fs.readFile(path.join(root, 'src/backref.swift'), 'utf-8');
      assert.ok(content.includes('func myFunc(param: Int)'), `Got: ${content}`);
    });
  });

});
