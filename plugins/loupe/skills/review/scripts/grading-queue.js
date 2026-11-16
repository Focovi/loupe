'use strict';

/**
 * Builds the capped grading queue (SKILL.md step 3).
 *
 * Grading costs one `claude -p` call per cluster, so a run grades at most
 * DEFAULT_GRADING_SLOTS clusters. Ranking every cluster by reach alone let
 * one noisy category take every slot, so each category with candidates
 * first gets an equal share, filled with its widest-reach clusters. Slots
 * a category cannot use (it has fewer clusters than its share) go back
 * into a pool filled by reach across all categories.
 */

const DEFAULT_GRADING_SLOTS = 20;

function categoryLetterFromKey(categoryKey) {
  return categoryKey.charAt(0);
}

// Detectors that cap evidenceSessionIds report the full count separately,
// so reach prefers that; otherwise the widest of sessions and occurrences.
function clusterReach(cluster) {
  if (typeof cluster.evidenceSessionCount === 'number') return cluster.evidenceSessionCount;
  const sessionCount = Array.isArray(cluster.evidenceSessionIds) ? cluster.evidenceSessionIds.length : 0;
  return Math.max(sessionCount, cluster.occurrenceCount || 0);
}

function rankByReach(clusters) {
  return clusters
    .map((cluster, index) => ({ cluster, index, reach: clusterReach(cluster) }))
    .sort((a, b) => b.reach - a.reach || a.index - b.index);
}

function buildGradingQueue(candidates, totalSlots = DEFAULT_GRADING_SLOTS) {
  const categories = Object.entries(candidates || {})
    .filter(([, clusters]) => Array.isArray(clusters) && clusters.length > 0)
    .map(([key, clusters]) => ({ key, letter: categoryLetterFromKey(key), ranked: rankByReach(clusters) }));

  const perCategoryShare = categories.length > 0 ? Math.max(1, Math.floor(totalSlots / categories.length)) : 0;
  const picked = [];
  const leftovers = [];

  for (const category of categories) {
    category.ranked.forEach((entry, rank) => {
      const queueEntry = { categoryLetter: category.letter, reach: entry.reach, cluster: entry.cluster };
      (rank < perCategoryShare ? picked : leftovers).push(queueEntry);
    });
  }

  // With more categories than slots the equal share rounds up to 1 each,
  // so trim the guaranteed picks by reach before filling the pool.
  picked.sort((a, b) => b.reach - a.reach);
  const guaranteed = picked.slice(0, totalSlots);
  leftovers.push(...picked.slice(totalSlots));
  leftovers.sort((a, b) => b.reach - a.reach);
  const entries = [...guaranteed, ...leftovers.slice(0, Math.max(0, totalSlots - guaranteed.length))];

  const queuedByCategory = {};
  const skippedByCategory = {};
  for (const category of categories) {
    const queued = entries.filter((entry) => entry.categoryLetter === category.letter).length;
    queuedByCategory[category.letter] = queued;
    skippedByCategory[category.letter] = category.ranked.length - queued;
  }

  entries.sort((a, b) => a.categoryLetter.localeCompare(b.categoryLetter) || b.reach - a.reach);

  return {
    totalSlots,
    perCategoryShare,
    queued: entries.length,
    skipped: Object.values(skippedByCategory).reduce((sum, count) => sum + count, 0),
    queuedByCategory,
    skippedByCategory,
    entries: entries.map(({ categoryLetter, reach, cluster }) => ({ categoryLetter, reach, cluster })),
  };
}

module.exports = { DEFAULT_GRADING_SLOTS, clusterReach, buildGradingQueue };
