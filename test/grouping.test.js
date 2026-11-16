'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  suggestProjectForPath,
  suggestGroups,
  addMissingGroups,
  isSameOrInside,
} = require('../plugins/loupe/skills/review/scripts/grouping');

const POSIX_HOME = '/Users/alex';
const WINDOWS_HOME = 'C:\\Users\\alex';
const NO_TEMP_DIRS = [];

/**
 * A fake file system: keys are paths, values are 'dir' for a .git folder
 * or a string for a .git file's contents. Everything else does not exist.
 */
function fakeFileSystem(entries) {
  return {
    stat(filePath) {
      if (!(filePath in entries)) return null;
      const isDirectory = entries[filePath] === 'dir';
      return { isDirectory, isFile: !isDirectory };
    },
    readText(filePath) {
      const value = entries[filePath];
      return typeof value === 'string' && value !== 'dir' ? value : null;
    },
  };
}

function suggest(cwd, entries, options = {}) {
  return suggestProjectForPath(cwd, {
    homeDir: POSIX_HOME,
    tempDirs: NO_TEMP_DIRS,
    fileSystem: fakeFileSystem(entries),
    ...options,
  });
}

test('normal repo: project is the git repository root', () => {
  const entries = { '/Users/alex/code/app/.git': 'dir' };
  assert.deepEqual(pick(suggest('/Users/alex/code/app/src/lib', entries)), {
    projectName: 'app',
    repoPath: '/Users/alex/code/app',
  });
});

test('bare + worktree layout: every worktree groups under the repo folder', () => {
  const entries = {
    '/Users/alex/Developer/example-repo/.git': 'gitdir: ./.bare\n',
    '/Users/alex/Developer/example-repo/main/.git': 'gitdir: /Users/alex/Developer/example-repo/.bare/worktrees/main\n',
    '/Users/alex/Developer/example-repo/fix-login/.git': 'gitdir: /Users/alex/Developer/example-repo/.bare/worktrees/fix-login\n',
  };
  const expected = { projectName: 'example-repo', repoPath: '/Users/alex/Developer/example-repo' };
  assert.deepEqual(pick(suggest('/Users/alex/Developer/example-repo/main', entries)), expected);
  assert.deepEqual(pick(suggest('/Users/alex/Developer/example-repo/fix-login/src', entries)), expected);
  assert.deepEqual(pick(suggest('/Users/alex/Developer/example-repo', entries)), expected);
  assert.deepEqual(pick(suggest('/Users/alex/Developer/example-repo/.bare', entries)), expected);
});

test('bare + worktree layout outside ~/Developer groups the same way', () => {
  const entries = {
    '/srv/work/acme/main/.git': 'gitdir: ../.bare/worktrees/main\n',
    '/srv/work/acme/feature-x/.git': 'gitdir: ../.bare/worktrees/feature-x\n',
  };
  const groups = suggestGroups(['/srv/work/acme/main', '/srv/work/acme/feature-x/api'], {
    homeDir: POSIX_HOME,
    tempDirs: NO_TEMP_DIRS,
    fileSystem: fakeFileSystem(entries),
  });
  assert.deepEqual(groups, { acme: ['/srv/work/acme'] });
});

test('linked worktree of a normal repo groups with the main checkout', () => {
  const entries = {
    '/Users/alex/code/app/.git': 'dir',
    '/Users/alex/code/app/wt-hotfix/.git': 'gitdir: /Users/alex/code/app/.git/worktrees/wt-hotfix\n',
  };
  assert.deepEqual(pick(suggest('/Users/alex/code/app/wt-hotfix', entries)), {
    projectName: 'app',
    repoPath: '/Users/alex/code/app',
  });
});

test('worktree of a bare repo named app.git keeps its own path under the repo name', () => {
  const entries = { '/Users/alex/code/app-feature/.git': 'gitdir: /Users/alex/code/app.git/worktrees/app-feature\n' };
  assert.deepEqual(pick(suggest('/Users/alex/code/app-feature', entries)), {
    projectName: 'app',
    repoPath: '/Users/alex/code/app-feature',
  });
});

test('submodule is its own project', () => {
  const entries = {
    '/Users/alex/code/app/.git': 'dir',
    '/Users/alex/code/app/vendor/lib/.git': 'gitdir: ../../.git/modules/vendor/lib\n',
  };
  assert.equal(suggest('/Users/alex/code/app/vendor/lib', entries).projectName, 'lib');
});

test('non-Developer folder without git falls back to the cwd itself', () => {
  assert.deepEqual(pick(suggest('/Users/alex/Documents/notes', {})), {
    projectName: 'notes',
    repoPath: '/Users/alex/Documents/notes',
  });
});

test('missing folder under ~/Developer falls back to the folder below the root', () => {
  assert.deepEqual(pick(suggest('/Users/alex/Developer/example-repo/removed-worktree', {})), {
    projectName: 'example-repo',
    repoPath: '/Users/alex/Developer/example-repo',
  });
});

test('configured project roots replace the default ~/Developer', () => {
  const options = { roots: ['~/src', '/opt/projects'] };
  assert.equal(suggest('/Users/alex/src/acme/web', {}, options).repoPath, '/Users/alex/src/acme');
  assert.equal(suggest('/opt/projects/widget/api', {}, options).projectName, 'widget');
});

test('home, project roots, drive roots and temp folders are never projects', () => {
  const homeRepo = { '/Users/alex/.git': 'dir' };
  assert.equal(suggest('/Users/alex', {}), null);
  assert.equal(suggest('/Users/alex/Developer', {}), null);
  assert.equal(suggest('/', {}), null);
  assert.equal(suggest('/tmp/scratch/repo', {}, { tempDirs: ['/tmp'] }), null);
  // A dotfiles repo at ~ must not swallow folders below it.
  assert.equal(suggest('/Users/alex/Documents/notes', homeRepo).repoPath, '/Users/alex/Documents/notes');
  assert.equal(suggest('/Users/alex/Developer/example-repo/main', homeRepo).repoPath, '/Users/alex/Developer/example-repo');
});

test('Windows paths: repo root, bare + worktree and fallbacks', () => {
  const entries = {
    'C:\\Users\\alex\\code\\app\\.git': 'dir',
    'D:\\work\\acme\\main\\.git': 'gitdir: D:/work/acme/.bare/worktrees/main\n',
  };
  const options = { homeDir: WINDOWS_HOME };
  assert.deepEqual(pick(suggest('C:\\Users\\alex\\code\\app\\src', entries, options)), {
    projectName: 'app',
    repoPath: 'C:\\Users\\alex\\code\\app',
  });
  assert.deepEqual(pick(suggest('D:\\work\\acme\\main', entries, options)), {
    projectName: 'acme',
    repoPath: 'D:\\work\\acme',
  });
  assert.deepEqual(pick(suggest('C:\\Users\\alex\\Developer\\example-repo\\gone', {}, options)), {
    projectName: 'example-repo',
    repoPath: 'C:\\Users\\alex\\Developer\\example-repo',
  });
  assert.equal(suggest('C:\\Users\\alex', {}, options), null);
  assert.equal(suggest('C:\\', {}, options), null);
  assert.equal(suggest('C:\\Users\\alex\\AppData\\Local\\Temp\\x', {}, { ...options, tempDirs: ['C:\\Users\\alex\\AppData\\Local\\Temp'] }), null);
});

test('Windows path comparison ignores case and separator style', () => {
  assert.ok(isSameOrInside('c:\\users\\alex\\code\\app\\src', 'C:\\Users\\alex\\code\\app'));
  assert.ok(isSameOrInside('C:/Users/alex/code/app', 'C:\\Users\\alex\\code\\app'));
  assert.ok(!isSameOrInside('C:\\Users\\alex\\code\\app-2', 'C:\\Users\\alex\\code\\app'));
  assert.ok(!isSameOrInside('/Users/alex/code/app', 'C:\\Users\\alex\\code\\app'));
});

test('posix path comparison matches the old prefix rule', () => {
  assert.ok(isSameOrInside('/Users/alex/code/app', '/Users/alex/code/app'));
  assert.ok(isSameOrInside('/Users/alex/code/app/src', '/Users/alex/code/app/'));
  assert.ok(!isSameOrInside('/Users/alex/code/app-2', '/Users/alex/code/app'));
  assert.ok(!isSameOrInside('/Users/alex/code', '/Users/alex/code/app'));
});

test('two different repos with the same folder name stay separate groups', () => {
  const entries = {
    '/Users/alex/code/app/.git': 'dir',
    '/Users/alex/clients/acme/app/.git': 'dir',
  };
  const groups = suggestGroups(['/Users/alex/code/app', '/Users/alex/clients/acme/app', '/Users/alex/code/app/src'], {
    homeDir: POSIX_HOME,
    tempDirs: NO_TEMP_DIRS,
    fileSystem: fakeFileSystem(entries),
  });
  assert.deepEqual(groups, {
    app: ['/Users/alex/code/app'],
    'app (acme)': ['/Users/alex/clients/acme/app'],
  });
});

test('real file system: a temp bare + worktree layout is detected', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-grouping-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'example-repo');
  fs.mkdirSync(path.join(repo, '.bare', 'worktrees', 'main'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'main', 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git'), 'gitdir: ./.bare\n');
  fs.writeFileSync(path.join(repo, 'main', '.git'), `gitdir: ${path.join(repo, '.bare', 'worktrees', 'main')}\n`);
  const suggestion = suggestProjectForPath(path.join(repo, 'main', 'src'), { homeDir: POSIX_HOME, tempDirs: NO_TEMP_DIRS });
  assert.deepEqual(pick(suggestion), { projectName: 'example-repo', repoPath: repo });
});

function pick(suggestion) {
  return suggestion && { projectName: suggestion.projectName, repoPath: suggestion.repoPath };
}

function addMissing(existing, cwds, entries = {}) {
  return addMissingGroups(existing, cwds, { homeDir: POSIX_HOME, tempDirs: NO_TEMP_DIRS, fileSystem: fakeFileSystem(entries) });
}

test('addMissingGroups adds a project no existing group covers', () => {
  const entries = { '/srv/work/acme/main/.git': 'gitdir: ../.bare/worktrees/main\n' };

  const { groups, addedNames } = addMissing({ shop: ['/srv/work/shop'] }, ['/srv/work/shop/src', '/srv/work/acme/main'], entries);

  assert.deepEqual(groups, { shop: ['/srv/work/shop'], acme: ['/srv/work/acme'] });
  assert.deepEqual(addedNames, ['acme']);
});

test('addMissingGroups leaves existing groups and their names alone', () => {
  const existing = { 'My App': ['~/Developer/app'] };

  const { groups, addedNames } = addMissing(existing, ['/Users/alex/Developer/app/main']);

  assert.deepEqual(groups, existing);
  assert.deepEqual(addedNames, []);
});

test('addMissingGroups groups a removed worktree under its project root', () => {
  const { groups } = addMissing({}, ['/Users/alex/Developer/app/.claude/worktrees/gone-123', '/Users/alex/Developer/app/main']);

  assert.deepEqual(groups, { app: ['/Users/alex/Developer/app'] });
});

test('addMissingGroups renames a new project whose name is already taken', () => {
  const { groups, addedNames } = addMissing({ app: ['/srv/old/app'] }, ['/Users/alex/Developer/app']);

  assert.deepEqual(addedNames, ['app (Developer)']);
  assert.deepEqual(groups['app (Developer)'], ['/Users/alex/Developer/app']);
});
