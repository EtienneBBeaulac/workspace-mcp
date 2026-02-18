#!/usr/bin/env node

// Multi-Workspace MCP Server
// Enables Firebender agents to access multiple repository workspaces from a single session

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { LocalFilesystemWorkspace } from './local-filesystem-workspace.js';
import { getWorkspaceConfig, WORKSPACES } from './config.js';
import type { Workspace } from './workspace.js';

class WorkspaceMCPServer {
  private readonly server: Server;
  private readonly workspaces: Map<string, Workspace>;

  constructor() {
    this.workspaces = new Map();
    
    // Initialize workspaces from config
    for (const [name, config] of Object.entries(WORKSPACES)) {
      this.workspaces.set(name, new LocalFilesystemWorkspace(config));
    }

    this.server = new Server(
      {
        name: '@zillow/workspace-mcp',
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
          description: 'Read a file from a workspace with optional pagination. Returns line-numbered content by default (cat -n format). With offset/limit, returns plain text for editing.',
          inputSchema: {
            type: 'object',
            properties: {
              workspace: {
                type: 'string',
                description: 'Workspace name (e.g., "ios")',
                enum: Array.from(this.workspaces.keys()),
              },
              path: {
                type: 'string',
                description: 'File path relative to workspace root',
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
          description: 'Write a file to a workspace (e.g., iOS repo). Only writes to allowed paths (*.swift in Modules/Tests/Apps/Examples). Logs all writes.',
          inputSchema: {
            type: 'object',
            properties: {
              workspace: {
                type: 'string',
                description: 'Workspace name (e.g., "ios")',
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
          description: 'Edit a file in a workspace using search and replace. The oldString must be unique in the file unless replaceAll is true. Respects write allowlist.',
          inputSchema: {
            type: 'object',
            properties: {
              workspace: {
                type: 'string',
                description: 'Workspace name (e.g., "ios")',
                enum: Array.from(this.workspaces.keys()),
              },
              path: {
                type: 'string',
                description: 'File path relative to workspace root',
              },
              oldString: {
                type: 'string',
                description: 'String to find and replace (must be unique unless replaceAll=true)',
              },
              newString: {
                type: 'string',
                description: 'String to replace with',
              },
              replaceAll: {
                type: 'boolean',
                description: 'Replace all occurrences (default: false, requires uniqueness)',
                default: false,
              },
            },
            required: ['workspace', 'path', 'oldString', 'newString'],
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
                description: 'Workspace name (e.g., "ios")',
                enum: Array.from(this.workspaces.keys()),
              },
              path: {
                type: 'string',
                description: 'Directory path relative to workspace root (empty string for root)',
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
          description: 'Search for text/regex using ripgrep with output modes, context lines, case-insensitive option, and pagination.',
          inputSchema: {
            type: 'object',
            properties: {
              workspace: {
                type: 'string',
                description: 'Workspace name (e.g., "ios")',
                enum: Array.from(this.workspaces.keys()),
              },
              pattern: {
                type: 'string',
                description: 'Search pattern (regex or text)',
              },
              glob: {
                type: 'string',
                description: 'Optional glob pattern to filter files (e.g., "**/*.swift")',
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
        {
          name: 'workspace_check_swift',
          description: 'Validate Swift file syntax using swiftc -typecheck. Requires Xcode Command Line Tools. Gracefully fails if swiftc unavailable.',
          inputSchema: {
            type: 'object',
            properties: {
              workspace: {
                type: 'string',
                description: 'Workspace name (e.g., "ios")',
                enum: Array.from(this.workspaces.keys()),
              },
              path: {
                type: 'string',
                description: 'Swift file path relative to workspace root',
              },
            },
            required: ['workspace', 'path'],
          },
        },
        {
          name: 'workspace_run_tests',
          description: 'Run Swift tests in the workspace using swift test. Returns pass/fail counts and failure details.',
          inputSchema: {
            type: 'object',
            properties: {
              workspace: {
                type: 'string',
                description: 'Workspace name (e.g., "ios")',
                enum: Array.from(this.workspaces.keys()),
              },
              testTarget: {
                type: 'string',
                description: 'Optional test target/filter (e.g., "MessagingTests")',
              },
            },
            required: ['workspace'],
          },
        },
        {
          name: 'workspace_build',
          description: 'Build the Swift module using swift build. Returns build success/failure with errors.',
          inputSchema: {
            type: 'object',
            properties: {
              workspace: {
                type: 'string',
                description: 'Workspace name (e.g., "ios")',
                enum: Array.from(this.workspaces.keys()),
              },
              buildTarget: {
                type: 'string',
                description: 'Optional build target/scheme',
              },
            },
            required: ['workspace'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'workspace_read': {
            const { workspace, path: filePath, offset, limit } = z
              .object({
                workspace: z.string(),
                path: z.string(),
                offset: z.number().optional(),
                limit: z.number().optional(),
              })
              .parse(args);

            const ws = this.getWorkspace(workspace);
            const content = await ws.read(filePath, offset, limit);

            return {
              content: [
                {
                  type: 'text',
                  text: content,
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
            const { workspace, path: filePath, oldString, newString, replaceAll, useRegex } = z
              .object({
                workspace: z.string(),
                path: z.string(),
                oldString: z.string(),
                newString: z.string(),
                replaceAll: z.boolean().optional().default(false),
                useRegex: z.boolean().optional().default(false),
              })
              .parse(args);

            const ws = this.getWorkspace(workspace);
            const result = await ws.edit(filePath, oldString, newString, replaceAll, useRegex);

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
            const { workspace, path: dirPath = '', recursive, maxDepth } = z
              .object({
                workspace: z.string(),
                path: z.string().optional().default(''),
                recursive: z.boolean().optional().default(false),
                maxDepth: z.number().optional(),
              })
              .parse(args);

            const ws = this.getWorkspace(workspace);
            const entries = await ws.list(dirPath, recursive, maxDepth);

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
            const { workspace, pattern, glob, outputMode, contextLines, caseInsensitive, limit, offset } = z
              .object({
                workspace: z.string(),
                pattern: z.string(),
                glob: z.string().optional(),
                outputMode: z.enum(['content', 'files', 'count']).optional().default('content'),
                contextLines: z.number().optional(),
                caseInsensitive: z.boolean().optional().default(false),
                limit: z.number().optional(),
                offset: z.number().optional(),
              })
              .parse(args);

            const ws = this.getWorkspace(workspace);
            const results = await ws.search(pattern, glob, outputMode, contextLines, caseInsensitive, limit, offset);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      pattern,
                      glob,
                      outputMode,
                      caseInsensitive,
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

          case 'workspace_check_swift': {
            const { workspace, path: filePath } = z
              .object({
                workspace: z.string(),
                path: z.string(),
              })
              .parse(args);

            const ws = this.getWorkspace(workspace);
            const result = await ws.checkSwift(filePath);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'workspace_run_tests': {
            const { workspace, testTarget } = z
              .object({
                workspace: z.string(),
                testTarget: z.string().optional(),
              })
              .parse(args);

            const ws = this.getWorkspace(workspace);
            const result = await ws.runTests(testTarget);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'workspace_build': {
            const { workspace, buildTarget } = z
              .object({
                workspace: z.string(),
                buildTarget: z.string().optional(),
              })
              .parse(args);

            const ws = this.getWorkspace(workspace);
            const result = await ws.build(buildTarget);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        // Structured error response
        const errorMessage = error instanceof Error ? error.message : String(error);
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
