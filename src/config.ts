// Workspace configuration
// Supports external workspace-config.json for portability, falls back to defaults

import { readFileSync } from 'fs';
import path from 'path';

export interface WorkspaceConfig {
  root: string;
  name: string;
  writeAllowlist: string[]; // Glob patterns
}

interface ExternalConfig {
  workspaces: Record<string, WorkspaceConfig>;
}

// No hardcoded defaults — all workspaces must be defined in workspace-config.json.
// This avoids leaking personal paths and ensures the config is explicitly provided.

function resolveRoot(root: string): string {
  // Support $HOME and ~ expansion for portability
  return root
    .replace(/^\$HOME\b/, process.env.HOME ?? '')
    .replace(/^~/, process.env.HOME ?? '');
}

function loadWorkspaces(): Record<string, WorkspaceConfig> {
  const configPath = path.resolve(
    new URL('.', import.meta.url).pathname,
    '..',
    'workspace-config.json'
  );

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const external: ExternalConfig = JSON.parse(raw);

    if (!external.workspaces || typeof external.workspaces !== 'object') {
      console.error(`[MCP] Invalid workspace-config.json: missing "workspaces" object.`);
      return {};
    }

    // Resolve root paths and validate required fields
    const resolved: Record<string, WorkspaceConfig> = {};
    for (const [key, config] of Object.entries(external.workspaces)) {
      if (!config.root || !config.name || !Array.isArray(config.writeAllowlist)) {
        console.error(`[MCP] Skipping workspace "${key}": missing required fields (root, name, writeAllowlist).`);
        continue;
      }
      resolved[key] = {
        ...config,
        root: resolveRoot(config.root),
      };
    }

    if (Object.keys(resolved).length === 0) {
      console.error(`[MCP] No valid workspaces found in workspace-config.json.`);
      return {};
    }

    console.error(`[MCP] Loaded ${Object.keys(resolved).length} workspace(s) from workspace-config.json`);
    return resolved;
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      console.error(
        `[MCP] No workspace-config.json found. Create one in the repo root to define workspaces. ` +
        `See README.md for the expected format.`
      );
      return {};
    }
    console.error(`[MCP] Failed to parse workspace-config.json: ${error.message}.`);
    return {};
  }
}

export const WORKSPACES: Record<string, WorkspaceConfig> = loadWorkspaces();
