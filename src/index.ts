#!/usr/bin/env node

// Multi-Workspace MCP Server
// Enables Firebender agents to access multiple repository workspaces from a single session

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z, ZodError } from 'zod';
import { LocalFilesystemWorkspace } from './local-filesystem-workspace.js';
import { WORKSPACES } from './config.js';
import type { Workspace } from './workspace.js';

class WorkspaceMCPServer {
  private readonly server: Server;
  private readonly workspaces: Map<string, Workspace>;

  /** Dynamic description helper — includes configured workspace names so the agent knows what's available */
  private workspaceDescription(): string {
    const names = Array.from(this.workspaces.keys());
    return names.length > 0
      ? `Workspace name. Available: ${names.map(n => `"${n}"`).join(', ')}`
      : 'Workspace name (none configured — create a workspace-config.json)';
  }

  constructor() {
    this.workspaces = new Map();
    
    // Initialize workspaces from config
    for (const [name, config] of Object.entries(WORKSPACES)) {
      this.workspaces.set(name, new LocalFilesystemWorkspace(config));
    }

    this.server = new Server(
      {
        name: '@exaudeus/workspace-mcp',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'workspace_read',
          description: 'Read a file from a workspace. Returns up to 500 lines by default (use offset/limit to paginate). Response includes line numbers and metadata (totalLines, range, truncated).',
          inputSchema: {
            type: 'object',
            properties: {
              workspace: {
                type: 'string',
                description: this.workspaceDescription(),
                enum: Array.from(this.workspaces.keys()),
              },
              path: {
                type: 'string',
                description: 'File path relative to workspace root (e.g., "Modules/MyModule/File.swift")',
              },
              offset: {
                type: 'number',
                description: 'Optional: Start from line N (1-indexed). Returns plain text when used.',
              },
              limit: {
                type: 'number',
                description: 'Optional: Read N lines. Returns plain text when used.',
              },
            },
            required: ['workspace', 'path'],
          },
        },
        {
          name: 'workspace_write',
          description: 'Write a file to a workspace. Only writes to paths matching the workspace write allowlist (defined in workspace-config.json). Logs all writes.',
          inputSchema: {
            type: 'object',
            properties: {
              workspace: {
                type: 'string',
                description: this.workspaceDescription(),
                enum: Array.from(this.workspaces.keys()),
              },
              path: {
                type: 'string',
                description: 'File path relative to workspace root',
              },
              content: {
                type: 'string',
                description: 'File contents to write',
              },
            },
            required: ['workspace', 'path', 'content'],
          },
        },
        {
          name: 'workspace_edit',
          description: 'Edit one or more files in a workspace using search and replace. Same find/replace operation applied to all specified files. The oldString must be unique per file unless replaceAll is true. Respects write allowlist. When useRegex=true, newString supports regex backreferences ($1, $2, etc.).',
          inputSchema: {
            type: 'object',
            properties: {
              workspace: {
                type: 'string',
                description: this.workspaceDescription(),
                enum: Array.from(this.workspaces.keys()),
              },
              paths: {
                oneOf: [
                  { type: 'string' },
                  { type: 'array', items: { type: 'string' } },
                ],
                description: 'Single file path or array of file paths relative to workspace root',
              },
              oldString: {
                type: 'string',
                description: 'String to find and replace (must be unique in each file unless replaceAll=true)',
              },
              newString: {
                type: 'string',
                description: 'Replacement string. When useRegex=true, supports $1/$2 backreferences for capture groups.',
              },
              replaceAll: {
                type: 'boolean',
                description: 'Replace all occurrences in each file (default: false, requires uniqueness)',
                default: false,
              },
              useRegex: {
                type: 'boolean',
                description: 'Treat oldString as a regex pattern (default: false). Enables $1/$2 backreferences in newString.',
                default: false,
              },
            },
            required: ['workspace', 'paths', 'oldString', 'newString'],
          },
        },
        {
          name: 'workspace_list',
          description: 'List directory contents with metadata (type, size, modified date). Supports recursive tree listing.',
          inputSchema: {
            type: 'object',
            properties: {
              workspace: {
                type: 'string',
                description: this.workspaceDescription(),
                enum: Array.from(this.workspaces.keys()),
              },
              path: {
                type: 'string',
                description: 'Directory path relative to workspace root. Omit or use "." to list the root.',
                default: '',
              },
              recursive: {
                type: 'boolean',
                description: 'List subdirectories recursively (default: false)',
                default: false,
              },
              maxDepth: {
                type: 'number',
                description: 'Maximum depth for recursive listing (default: unlimited)',
              },
            },
            required: ['workspace'],
          },
        },
        {
          name: 'workspace_search',
          description: 'Search for text/regex using ripgrep with output modes, context lines, case-insensitive option, and pagination. When using contextLines, results include contextBefore/contextAfter arrays.',
          inputSchema: {
            type: 'object',
            properties: {
              workspace: {
                type: 'string',
                description: this.workspaceDescription(),
                enum: Array.from(this.workspaces.keys()),
              },
              pattern: {
                type: 'string',
                description: 'Search pattern (regex or text)',
              },
              path: {
                type: 'string',
                description: 'Optional path relative to workspace root to scope the search. Can be a directory (e.g., "Modules/Messaging/Sources") or a single file (e.g., "Modules/.../File.swift").',
              },
              glob: {
                type: 'string',
                description: 'Optional glob pattern to filter files by name/extension (e.g., "**/*.swift")',
              },
              outputMode: {
                type: 'string',
                enum: ['content', 'files', 'count'],
                description: 'content: show matches with line numbers, files: paths only, count: match counts',
                default: 'content',
              },
              contextLines: {
                type: 'number',
                description: 'Show N lines before/after each match (content mode only)',
              },
              caseInsensitive: {
                type: 'boolean',
                description: 'Case-insensitive search (default: false)',
                default: false,
              },
              limit: {
                type: 'number',
                description: 'Maximum number of results',
              },
              offset: {
                type: 'number',
                description: 'Skip first N results',
              },
            },
            required: ['workspace', 'pattern'],
          },
        },

      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'workspace_read': {
            const { workspace, path: filePath, ...readOptions } = z
              .object({
                workspace: z.string(),
                path: z.string(),
                offset: z.number().optional(),
                limit: z.number().optional(),
              })
              .parse(args);

            const ws = this.getWorkspace(workspace);
            const result = await ws.read(filePath, readOptions);

            const header = result.truncated
              ? `[${filePath}] Lines ${result.startLine}-${result.endLine} of ${result.totalLines} (truncated — use offset/limit to read more)`
              : `[${filePath}] Lines ${result.startLine}-${result.endLine} of ${result.totalLines}`;

            return {
              content: [
                {
                  type: 'text',
                  text: `${header}\n${result.content}`,
                },
              ],
            };
          }

          case 'workspace_write': {
            const { workspace, path: filePath, content } = z
              .object({
                workspace: z.string(),
                path: z.string(),
                content: z.string(),
              })
              .parse(args);

            const ws = this.getWorkspace(workspace);
            await ws.write(filePath, content);

            return {
              content: [
                {
                  type: 'text',
                  text: `Successfully wrote to ${workspace}:${filePath}`,
                },
              ],
            };
          }

          case 'workspace_edit': {
            const { workspace, paths, oldString, newString, ...editOptions } = z
              .object({
                workspace: z.string(),
                paths: z.union([z.string(), z.array(z.string())]),
                oldString: z.string(),
                newString: z.string(),
                replaceAll: z.boolean().optional().default(false),
                useRegex: z.boolean().optional().default(false),
              })
              .parse(args);

            const ws = this.getWorkspace(workspace);
            const result = await ws.edit(paths, oldString, newString, editOptions);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'workspace_list': {
            const { workspace, ...listOptions } = z
              .object({
                workspace: z.string(),
                path: z.string().optional(),
                recursive: z.boolean().optional(),
                maxDepth: z.number().optional(),
              })
              .parse(args);

            const ws = this.getWorkspace(workspace);
            const entries = await ws.list(listOptions);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(entries, null, 2),
                },
              ],
            };
          }

          case 'workspace_search': {
            const { workspace, pattern, ...searchOptions } = z
              .object({
                workspace: z.string(),
                pattern: z.string(),
                path: z.string().optional(),
                glob: z.string().optional(),
                outputMode: z.enum(['content', 'files', 'count']).optional(),
                contextLines: z.number().optional(),
                caseInsensitive: z.boolean().optional(),
                limit: z.number().optional(),
                offset: z.number().optional(),
              })
              .parse(args);

            const ws = this.getWorkspace(workspace);
            const results = await ws.search(pattern, searchOptions);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      pattern,
                      ...searchOptions,
                      matchCount: results.length,
                      matches: results,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        const errorMessage = error instanceof ZodError
          ? this.formatZodError(error, name, args)
          : error instanceof Error ? error.message : String(error);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: errorMessage }, null, 2),
            },
          ],
          isError: true,
        };
      }
    });
  }

  private getWorkspace(name: string): Workspace {
    const ws = this.workspaces.get(name);
    if (!ws) {
      throw new Error(`Unknown workspace: ${name}. Available: ${Array.from(this.workspaces.keys()).join(', ')}`);
    }
    return ws;
  }

  /** Format Zod validation errors into actionable messages for the agent. */
  private formatZodError(error: ZodError, toolName: string, args: Record<string, unknown> | undefined): string {
    const provided = args ? Object.keys(args) : [];
    const issues = error.issues.map(issue => {
      const field = issue.path.join('.');
      return `  - "${field}": ${issue.message} (expected ${issue.code === 'invalid_type' ? (issue as any).expected : issue.code})`;
    });

    const workspaceNames = Array.from(this.workspaces.keys());
    const parts = [
      `Invalid parameters for ${toolName}.`,
      `Issues:\n${issues.join('\n')}`,
      provided.length > 0
        ? `You provided: ${provided.map(k => `"${k}"`).join(', ')}`
        : 'No parameters provided.',
      workspaceNames.length > 0
        ? `Available workspaces: ${workspaceNames.map(n => `"${n}"`).join(', ')}`
        : '',
    ];

    return parts.filter(Boolean).join('\n');
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    console.error('[MCP] Workspace MCP Server ready');
    console.error(`[MCP] Available workspaces: ${Array.from(this.workspaces.keys()).join(', ')}`);
  }
}

// Main entry point
async function main(): Promise<void> {
  try {
    const server = new WorkspaceMCPServer();
    await server.start();

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.error('[MCP] Shutting down...');
      process.exit(0);
    });
  } catch (error) {
    console.error('[MCP] Failed to start server:', error);
    process.exit(1);
  }
}

main().catch(console.error);
