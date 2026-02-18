// Workspace configuration

export interface WorkspaceConfig {
  root: string;
  name: string;
  writeAllowlist: string[]; // Glob patterns
}

// Hardcoded configuration for v1
// Future: load from workspace-config.json
export const WORKSPACES: Record<string, WorkspaceConfig> = {
  ios: {
    root: '/Users/etienneb/git/zillow/ZillowMap',
    name: 'iOS (ZillowMap)',
    writeAllowlist: [
      'Modules/**/*.swift',
      'Tests/**/*.swift',
      'Apps/**/*.swift',
      'Examples/**/*.swift',
    ],
  },
};

export function getWorkspaceConfig(name: string): WorkspaceConfig {
  const config = WORKSPACES[name];
  if (!config) {
    throw new Error(`Unknown workspace: ${name}. Available: ${Object.keys(WORKSPACES).join(', ')}`);
  }
  return config;
}
