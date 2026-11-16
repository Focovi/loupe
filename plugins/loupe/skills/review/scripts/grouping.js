'use strict';

/**
 * Project derivation for Loupe's grouping step (Full Spec §1.1).
 *
 * Turns a session's working directory into a suggested project, on any
 * folder layout and any OS:
 *
 *   1. The git repository the cwd belongs to. Linked worktrees resolve to
 *      their main repository, so a bare + worktree layout (<Repo>/.bare
 *      with <Repo>/main and <Repo>/<feature>) or a normal repo with extra
 *      worktrees groups as one project.
 *   2. A configured project root (projectRoots in ~/.loupe/config.json,
 *      default ~/Developer): the first folder below the root. This covers
 *      sessions whose folder no longer exists, such as a removed worktree.
 *   3. The cwd's own folder.
 *
 * Nothing is suggested for the home folder, a drive root, a folder that
 * holds a project root, or a temp folder: a scratch repo in /tmp is not a
 * project, and grouping by a broad folder would swallow every session
 * under it.
 *
 * Paths are handled in the style they were recorded in (a transcript from
 * Windows has C:\ paths), not the style of the machine running Loupe.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const WINDOWS_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\)/;
const WORKTREE_GITDIR_PATTERN = /[\\/]worktrees[\\/][^\\/]+[\\/]*$/;
const GITDIR_LINE_PATTERN = /^gitdir:\s*(.+?)\s*$/m;
const DEFAULT_PROJECT_ROOT_NAMES = ['Developer'];
// macOS records temp paths under /private; os.tmpdir() covers Windows
// (%TEMP%) and anything TMPDIR points at.
const UNIX_TEMP_DIRS = ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/var/folders', '/private/var/folders'];

function pathApiFor(somePath) {
  return WINDOWS_PATH_PATTERN.test(somePath) ? path.win32 : path.posix;
}

function expandHome(somePath, homeDir) {
  return somePath.replace(/^~(?=$|[\\/])/, homeDir);
}

// Windows paths compare case-insensitively and with either separator.
function comparablePath(somePath, pathApi) {
  const normalized = pathApi.normalize(somePath);
  return pathApi === path.win32 ? normalized.toLowerCase() : normalized;
}

/** True when child is parent itself or somewhere below it. */
function isSameOrInside(child, parent) {
  if (!child || !parent) return false;
  const pathApi = pathApiFor(child);
  if (pathApiFor(parent) !== pathApi) return false;
  const relative = pathApi.relative(comparablePath(parent, pathApi), comparablePath(child, pathApi));
  if (relative === '') return true;
  return relative.split(pathApi.sep)[0] !== '..' && !pathApi.isAbsolute(relative);
}

function defaultProjectRoots(homeDir) {
  return DEFAULT_PROJECT_ROOT_NAMES.map((name) => pathApiFor(homeDir).join(homeDir, name));
}

function defaultTempDirs() {
  return [os.tmpdir(), ...UNIX_TEMP_DIRS];
}

const realFileSystem = {
  stat(filePath) {
    try {
      const stats = fs.statSync(filePath);
      return { isDirectory: stats.isDirectory(), isFile: stats.isFile() };
    } catch (err) {
      return null;
    }
  },
  readText(filePath) {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      return null;
    }
  },
};

/**
 * Walks up from cwd to the nearest .git entry and returns
 * { projectName, repoPath }, or null when cwd is not in a repository
 * (or no longer exists).
 */
function findGitProject(cwd, fileSystem = realFileSystem) {
  const pathApi = pathApiFor(cwd);
  let dir = pathApi.normalize(cwd);
  for (;;) {
    const gitEntry = fileSystem.stat(pathApi.join(dir, '.git'));
    if (gitEntry && gitEntry.isDirectory) return { projectName: pathApi.basename(dir), repoPath: dir, projectId: dir };
    if (gitEntry && gitEntry.isFile) return projectFromGitFile(dir, fileSystem, pathApi);
    const parent = pathApi.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// A .git file points somewhere else: a linked worktree points at
// <commonDir>/worktrees/<name>; a bare + worktree layout's top folder
// points at ./.bare; a submodule points into the parent's .git/modules.
function projectFromGitFile(dir, fileSystem, pathApi) {
  const match = (fileSystem.readText(pathApi.join(dir, '.git')) || '').match(GITDIR_LINE_PATTERN);
  const gitDir = match ? pathApi.resolve(dir, match[1]) : null;
  const worktreeMatch = gitDir ? gitDir.match(WORKTREE_GITDIR_PATTERN) : null;
  if (!worktreeMatch) return { projectName: pathApi.basename(dir), repoPath: dir, projectId: dir };

  const commonDir = gitDir.slice(0, worktreeMatch.index);
  const commonName = pathApi.basename(commonDir);
  // <Repo>/.git or <Repo>/.bare: the project is <Repo>, and every
  // worktree inside it shares that one path.
  if (commonName.startsWith('.')) {
    const projectRoot = pathApi.dirname(commonDir);
    const repoPath = isSameOrInside(dir, projectRoot) ? projectRoot : dir;
    return { projectName: pathApi.basename(projectRoot), repoPath, projectId: projectRoot };
  }
  // A bare repo such as app.git with worktrees anywhere: name the project
  // after the repo, keep each worktree as its own path.
  return { projectName: commonName.replace(/\.git$/i, ''), repoPath: dir, projectId: commonDir };
}

function projectUnderRoots(cwd, roots) {
  const pathApi = pathApiFor(cwd);
  for (const root of roots) {
    if (!isSameOrInside(cwd, root)) continue;
    // Count segments instead of slicing the relative path, so the project
    // name keeps its recorded case on case-insensitive Windows paths.
    const rootSegmentCount = splitSegments(root, pathApi).length;
    const projectName = splitSegments(cwd, pathApi)[rootSegmentCount];
    if (!projectName) continue;
    return { projectName, repoPath: pathApi.join(pathApi.normalize(root), projectName) };
  }
  return null;
}

function splitSegments(somePath, pathApi) {
  return pathApi.normalize(somePath).split(pathApi.sep).filter(Boolean);
}

function isTooBroadToGroup(dir, homeDir, projectRoots) {
  const pathApi = pathApiFor(dir);
  const normalized = pathApi.normalize(dir);
  if (pathApi.dirname(normalized) === normalized) return true;
  return [homeDir, ...projectRoots].some((broadDir) => isSameOrInside(broadDir, normalized));
}

/**
 * Suggests { projectName, repoPath } for a session's cwd, or null when
 * the cwd is missing or too broad (home folder, drive root) to group by.
 */
function suggestProjectForPath(cwd, { homeDir, roots, tempDirs = defaultTempDirs(), fileSystem = realFileSystem } = {}) {
  if (!cwd || !homeDir) return null;
  const pathApi = pathApiFor(cwd);
  if (pathApi === path.posix && !cwd.startsWith('/')) return null;
  if (tempDirs.some((tempDir) => isSameOrInside(cwd, tempDir))) return null;

  const projectRoots = (roots && roots.length ? roots : defaultProjectRoots(homeDir)).map((root) => expandHome(root, homeDir));
  const rootProject = projectUnderRoots(cwd, projectRoots);
  const gitProject = findGitProject(cwd, fileSystem);

  // A repo that contains a whole project root (a dotfiles repo at ~, say)
  // is not a project; the folder under the root is.
  const gitProjectIsUsable = gitProject
    && !isTooBroadToGroup(gitProject.repoPath, homeDir, projectRoots)
    && (!rootProject || isSameOrInside(gitProject.repoPath, rootProject.repoPath));
  if (gitProjectIsUsable) return gitProject;
  if (rootProject) return rootProject;
  if (isTooBroadToGroup(cwd, homeDir, projectRoots)) return null;
  const ownFolder = pathApi.normalize(cwd);
  return { projectName: pathApi.basename(ownFolder), repoPath: ownFolder };
}

/**
 * Builds a groups.json-shaped object: { projectName: [repoPath, ...] }.
 * Two different projects with the same folder name (two "app" repos) get
 * distinct names instead of being merged.
 */
function suggestGroups(cwds, options) {
  const groups = {};
  const nameByProjectId = new Map();
  const projectIdByName = new Map();
  for (const cwd of new Set(cwds.filter(Boolean))) {
    const suggestion = suggestProjectForPath(cwd, options);
    if (!suggestion) continue;
    const projectId = suggestion.projectId || suggestion.repoPath;
    if (!nameByProjectId.has(projectId)) {
      const name = uniqueProjectName(suggestion, projectIdByName);
      nameByProjectId.set(projectId, name);
      projectIdByName.set(name, projectId);
    }
    const name = nameByProjectId.get(projectId);
    const repoPaths = groups[name] || (groups[name] = []);
    if (!repoPaths.includes(suggestion.repoPath)) repoPaths.push(suggestion.repoPath);
  }
  return groups;
}

/**
 * Adds projects for the cwds no existing group covers, so projects started
 * after groups.json was written get grouped too. Existing groups, including
 * hand edits, are never changed. Returns { groups, addedNames }.
 */
function addMissingGroups(existingGroups, cwds, options) {
  const covered = (cwd) => Object.values(existingGroups)
    .some((repoPaths) => repoPaths.some((repoPath) => isSameOrInside(cwd, expandHome(repoPath, options.homeDir))));
  const suggested = suggestGroups(cwds.filter((cwd) => cwd && !covered(cwd)), options);

  const groups = { ...existingGroups };
  const addedNames = [];
  for (const [projectName, repoPaths] of Object.entries(suggested)) {
    const name = nameNotIn(groups, projectName, repoPaths[0]);
    groups[name] = repoPaths;
    addedNames.push(name);
  }
  return { groups, addedNames };
}

function nameNotIn(groups, projectName, repoPath) {
  const taken = new Map(Object.keys(groups).map((name) => [name, name]));
  return uniqueProjectName({ projectName, repoPath }, taken);
}

function uniqueProjectName({ projectName, repoPath }, projectIdByName) {
  if (!projectIdByName.has(projectName)) return projectName;
  const pathApi = pathApiFor(repoPath);
  const withParent = `${projectName} (${pathApi.basename(pathApi.dirname(repoPath))})`;
  if (!projectIdByName.has(withParent)) return withParent;
  let suffix = 2;
  while (projectIdByName.has(`${withParent} ${suffix}`)) suffix += 1;
  return `${withParent} ${suffix}`;
}

module.exports = {
  suggestProjectForPath,
  suggestGroups,
  addMissingGroups,
  findGitProject,
  isSameOrInside,
  expandHome,
  pathApiFor,
};
