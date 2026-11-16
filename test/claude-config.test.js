'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  matchMcpServerName,
  readUserMcpServers,
  readProjectMcpServers,
  readPluginMcpServers,
  readFollowUpHookCommands,
} = require('../plugins/loupe/skills/review/scripts/claude-config');

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data));
}

function makeFixtureHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-config-'));
  const projectPath = path.join(home, 'code', 'app');
  const pluginPath = path.join(home, 'plugin-cache', 'acme');
  const projectPluginPath = path.join(home, 'plugin-cache', 'project-only');

  writeJson(path.join(home, '.claude.json'), {
    mcpServers: { 'issue-tracker': { command: 'x', env: { TOKEN: 'not-read' } } },
    projects: { [projectPath]: { mcpServers: { 'local-db': {} } } },
  });
  writeJson(path.join(projectPath, '.mcp.json'), { mcpServers: { 'shared-docs': {} } });
  writeJson(path.join(home, '.claude', 'settings.json'), {
    enabledPlugins: { 'acme@market': true, 'project-only@market': true, 'disabled@market': false },
    hooks: {
      PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'npx prettier --write' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'npm test' }] }],
    },
  });
  writeJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), {
    plugins: {
      'acme@market': [{ scope: 'user', installPath: pluginPath }],
      'project-only@market': [{ scope: 'project', projectPath, installPath: projectPluginPath }],
    },
  });
  writeJson(path.join(pluginPath, '.mcp.json'), { 'acme-cards': {} });
  writeJson(path.join(pluginPath, 'hooks', 'hooks.json'), {
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'run-lint.sh' }] }] },
  });
  writeJson(path.join(projectPluginPath, '.claude-plugin', 'plugin.json'), { mcpServers: { search: {} } });
  writeJson(path.join(projectPath, '.claude', 'settings.json'), {
    hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'dotnet test' }] }] },
  });

  return { home, projectPath };
}

test('matchMcpServerName keeps underscores in plugin server names', () => {
  const servers = ['plugin', 'plugin_acme_acme-cards'];
  assert.equal(matchMcpServerName('mcp__plugin_acme_acme-cards__show_board', servers), 'plugin_acme_acme-cards');
});

test('matchMcpServerName prefers the longest configured name', () => {
  assert.equal(matchMcpServerName('mcp__docs__extra__search', ['docs', 'docs__extra']), 'docs__extra');
});

test('matchMcpServerName normalizes characters Claude Code replaces', () => {
  assert.equal(matchMcpServerName('mcp__my_server__query', ['my.server']), 'my.server');
});

test('matchMcpServerName ignores unconfigured and non-MCP tools', () => {
  assert.equal(matchMcpServerName('mcp__other__query', ['docs']), null);
  assert.equal(matchMcpServerName('Bash', ['docs']), null);
  assert.equal(matchMcpServerName(undefined, ['docs']), null);
});

test('reads user, project and plugin MCP server names', () => {
  const { home, projectPath } = makeFixtureHome();
  assert.deepEqual(readUserMcpServers(home), ['issue-tracker']);
  assert.deepEqual(readProjectMcpServers(projectPath, home).sort(), ['local-db', 'shared-docs']);
  assert.deepEqual(readPluginMcpServers(null, home), ['plugin_acme_acme-cards']);
  assert.deepEqual(readPluginMcpServers(projectPath, home), ['plugin_project-only_search']);
});

test('missing config files read as no servers', () => {
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-empty-'));
  assert.deepEqual(readUserMcpServers(emptyHome), []);
  assert.deepEqual(readProjectMcpServers(path.join(emptyHome, 'nowhere'), emptyHome), []);
  assert.deepEqual(readPluginMcpServers(null, emptyHome), []);
  assert.deepEqual(readFollowUpHookCommands([], emptyHome), []);
});

test('reads follow-up hook commands and skips PreToolUse hooks', () => {
  const { home, projectPath } = makeFixtureHome();
  const commands = readFollowUpHookCommands([projectPath], home).sort();
  assert.deepEqual(commands, ['dotnet test', 'npx prettier --write', 'run-lint.sh']);
});
