'use strict';

/**
 * Reads the parts of a developer's Claude Code configuration that the
 * category C (hooks) and D (MCPs) detectors need: which MCP servers are
 * configured at user, project and plugin level, and which hook commands
 * already run automatically.
 *
 * Only names and hook command strings are returned. Server definitions
 * carry env vars and headers that can hold secrets, so those are never
 * read past the key level.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Claude Code replaces characters outside this set when it builds tool
// names (mcp__<server>__<tool>), so configured names must be normalized the
// same way before they can be matched against transcript tool calls.
const MCP_NAME_UNSAFE_CHARS = /[^a-zA-Z0-9_-]/g;
const MCP_TOOL_PREFIX = 'mcp__';
const MCP_NAME_SEPARATOR = '__';
const PLUGIN_SERVER_PREFIX = 'plugin';
// Only hooks that fire after work happens can replace a "now run the
// tests" request. A PreToolUse hook that mentions tests does not.
const FOLLOW_UP_HOOK_EVENTS = new Set(['PostToolUse', 'Stop', 'SubagentStop']);
const PROJECT_SETTINGS_FILES = ['settings.json', 'settings.local.json'];

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function serverNamesFrom(mcpServers) {
  return mcpServers && typeof mcpServers === 'object' ? Object.keys(mcpServers) : [];
}

function sanitizeMcpServerName(name) {
  return name.replace(MCP_NAME_UNSAFE_CHARS, '_');
}

/**
 * Returns the configured server name a tool call belongs to, or null.
 * Server names may themselves contain "__" or "_" (plugin servers are
 * named plugin_<plugin>_<server>), so splitting the tool name is
 * ambiguous; prefix-matching against the known names with the longest
 * match winning is not.
 */
function matchMcpServerName(toolName, serverNames) {
  if (typeof toolName !== 'string' || !toolName.startsWith(MCP_TOOL_PREFIX)) return null;
  let bestMatch = null;
  for (const serverName of serverNames) {
    const prefix = MCP_TOOL_PREFIX + sanitizeMcpServerName(serverName) + MCP_NAME_SEPARATOR;
    if (toolName.startsWith(prefix) && (!bestMatch || serverName.length > bestMatch.length)) {
      bestMatch = serverName;
    }
  }
  return bestMatch;
}

function claudeJsonPath(homeDir) {
  return path.join(homeDir, '.claude.json');
}

function userSettingsPath(homeDir) {
  return path.join(homeDir, '.claude', 'settings.json');
}

function readUserMcpServers(homeDir = os.homedir()) {
  const claudeJson = readJsonSafe(claudeJsonPath(homeDir), {});
  return serverNamesFrom(claudeJson.mcpServers);
}

function readProjectMcpServers(projectPath, homeDir = os.homedir()) {
  if (!projectPath) return [];
  const fromMcpJson = serverNamesFrom(readJsonSafe(path.join(projectPath, '.mcp.json'), {}).mcpServers);
  const claudeJson = readJsonSafe(claudeJsonPath(homeDir), {});
  const projectEntry = claudeJson.projects && claudeJson.projects[projectPath];
  const fromClaudeJson = serverNamesFrom(projectEntry && projectEntry.mcpServers);
  return [...new Set([...fromMcpJson, ...fromClaudeJson])];
}

// Enabled plugins resolved to their install folders. With no projectPath
// this returns user-wide installs; with one, only installs bound to that
// project, so callers never count a user-wide plugin twice.
function findEnabledPluginInstalls(homeDir, projectPath) {
  const enabledPlugins = readJsonSafe(userSettingsPath(homeDir), {}).enabledPlugins || {};
  const installed = readJsonSafe(path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json'), {}).plugins || {};
  const installs = [];
  for (const [pluginKey, isEnabled] of Object.entries(enabledPlugins)) {
    if (!isEnabled) continue;
    for (const entry of installed[pluginKey] || []) {
      if (!entry || typeof entry.installPath !== 'string') continue;
      if ((entry.projectPath || null) !== (projectPath || null)) continue;
      installs.push({ pluginName: pluginKey.split('@')[0], installPath: entry.installPath });
    }
  }
  return installs;
}

function readPluginManifest(installPath) {
  return readJsonSafe(path.join(installPath, '.claude-plugin', 'plugin.json'), {});
}

function readPluginServerNames(installPath) {
  const mcpJson = readJsonSafe(path.join(installPath, '.mcp.json'), {});
  // A plugin's .mcp.json may wrap servers in mcpServers or list them flat.
  const fromMcpJson = mcpJson.mcpServers ? serverNamesFrom(mcpJson.mcpServers) : serverNamesFrom(mcpJson);
  const manifestServers = readPluginManifest(installPath).mcpServers;
  const fromManifest = typeof manifestServers === 'string'
    ? serverNamesFrom(readJsonSafe(path.join(installPath, manifestServers), {}).mcpServers)
    : serverNamesFrom(manifestServers);
  return [...new Set([...fromMcpJson, ...fromManifest])];
}

function readPluginMcpServers(projectPath = null, homeDir = os.homedir()) {
  const names = [];
  for (const { pluginName, installPath } of findEnabledPluginInstalls(homeDir, projectPath)) {
    for (const serverName of readPluginServerNames(installPath)) {
      names.push([PLUGIN_SERVER_PREFIX, pluginName, serverName].join('_'));
    }
  }
  return [...new Set(names)];
}

function followUpHookCommandsFrom(hooksConfig) {
  if (!hooksConfig || typeof hooksConfig !== 'object') return [];
  const commands = [];
  for (const [eventName, matchers] of Object.entries(hooksConfig)) {
    if (!FOLLOW_UP_HOOK_EVENTS.has(eventName) || !Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      for (const hook of (matcher && matcher.hooks) || []) {
        if (hook && typeof hook.command === 'string') commands.push(hook.command);
      }
    }
  }
  return commands;
}

function readPluginHookCommands(installPath) {
  const hooksFile = readJsonSafe(path.join(installPath, 'hooks', 'hooks.json'), {});
  const manifestHooks = readPluginManifest(installPath).hooks;
  return [
    ...followUpHookCommandsFrom(hooksFile.hooks),
    ...(manifestHooks && typeof manifestHooks === 'object' ? followUpHookCommandsFrom(manifestHooks) : []),
  ];
}

/**
 * Hook commands that already run after edits or at the end of a turn, from
 * user settings, each project folder's .claude/settings(.local).json, and
 * enabled plugins.
 */
function readFollowUpHookCommands(projectPaths = [], homeDir = os.homedir()) {
  const commands = [...followUpHookCommandsFrom(readJsonSafe(userSettingsPath(homeDir), {}).hooks)];
  for (const projectPath of projectPaths) {
    for (const fileName of PROJECT_SETTINGS_FILES) {
      commands.push(...followUpHookCommandsFrom(readJsonSafe(path.join(projectPath, '.claude', fileName), {}).hooks));
    }
  }
  const pluginInstallPaths = new Set();
  for (const projectPath of [null, ...projectPaths]) {
    for (const { installPath } of findEnabledPluginInstalls(homeDir, projectPath)) pluginInstallPaths.add(installPath);
  }
  for (const installPath of pluginInstallPaths) commands.push(...readPluginHookCommands(installPath));
  return [...new Set(commands)];
}

module.exports = {
  matchMcpServerName,
  sanitizeMcpServerName,
  readUserMcpServers,
  readProjectMcpServers,
  readPluginMcpServers,
  readFollowUpHookCommands,
};
