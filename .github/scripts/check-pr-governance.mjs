#!/usr/bin/env node
/**
 * check-pr-governance.mjs
 * Enforces non-negotiable PR governance rails using PR metadata and the local
 * git diff. This is intentionally fail-closed: labels such as do-not-merge or
 * prod-gate-required must be machine-enforced, not treated as advisory text.
 *
 * Export: checkPrGovernance({ title, labels, files, author }) → { passed, failures }
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MAX_CHANGED_LINES = 2_000;
export const MAX_CHANGED_FILES = 50;

export const BULK_EXCEPTION_LABELS = new Set([
  'bulk-data-approved',
  'mechanical-change-approved',
]);

export const HARD_BLOCK_LABELS = new Set([
  'do-not-merge',
  'human-merge-only',
  'human-gate-required',
  'prod-gate-required',
  'sacred-path-required',
  'sacred-path-review-required',
]);

const ALLOWED_AGENT_AUTHORS = new Set([
  // Dedicated autonomous delivery App (id 4384863) for this repo's witness PRs.
  'solidus-paperclip-delivery[bot]',
  'commitperclip[bot]',
  'github-actions[bot]',
  'paperclipai[bot]',
]);

function normalizeLabel(label) {
  return String(label ?? '').trim().toLowerCase();
}

function normalizePath(path) {
  return String(path ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function changedLineCount(file) {
  const additions = Number.isFinite(file.additions) ? file.additions : 0;
  const deletions = Number.isFinite(file.deletions) ? file.deletions : 0;
  const changes = Number.isFinite(file.changes) ? file.changes : additions + deletions;
  return changes || additions + deletions;
}

function activeFiles(files) {
  return files.filter(file => file.status !== 'removed');
}

export function isOpaqueTitle(title) {
  const value = String(title ?? '').trim();
  if (!value) return true;

  const lower = value.toLowerCase();
  return (
    /^auto commit\s+\d{8,}$/.test(lower) ||
    /^(wip|work in progress|update|updates|changes|misc|stuff|fix|feat|auto commit)$/.test(lower)
  );
}

export function isRawMemoryFile(file) {
  if (file.status === 'removed') return false;

  const path = normalizePath(file.filename).toLowerCase();
  const parts = path.split('/').filter(Boolean);

  for (let i = 0; i < parts.length - 1; i += 1) {
    if (
      ['memory', 'memories', 'agent-memory', 'ai-memory'].includes(parts[i]) &&
      ['raw', 'dump', 'dumps'].includes(parts[i + 1])
    ) {
      return true;
    }
  }

  if (/(^|\/)(memory|agent-memory|ai-memory)[-_]?(raw|dump)s?\.(json|jsonl|ndjson)$/i.test(path)) {
    return true;
  }

  if (/\.(json|jsonl|ndjson)$/i.test(path) && parts.some(part => ['memory', 'memories', 'agent-memory', 'ai-memory'].includes(part))) {
    return changedLineCount(file) > MAX_CHANGED_LINES;
  }

  return false;
}

export function isAckProofFile(file) {
  if (file.status === 'removed') return false;
  const path = normalizePath(file.filename).toLowerCase();
  return /(^|\/)[^/]+\.ack$/.test(path) || path.includes('/.ack/');
}

function labelsFromInput(labels) {
  return new Set((labels ?? []).map(normalizeLabel).filter(Boolean));
}

function formatFiles(files, limit = 5) {
  const names = files.slice(0, limit).map(file => `\`${file.filename}\``);
  const suffix = files.length > limit ? `, … (+${files.length - limit})` : '';
  return `${names.join(', ')}${suffix}`;
}

export function checkPrGovernance({ title = '', labels = [], files = [], author = '' } = {}) {
  const labelSet = labelsFromInput(labels);
  const failures = [];

  const hardBlockLabels = [...labelSet].filter(label => HARD_BLOCK_LABELS.has(label));
  if (hardBlockLabels.length > 0) {
    failures.push(
      `Blocking label(s) present: ${hardBlockLabels.map(label => `\`${label}\``).join(', ')}. ` +
      'These labels are fail-closed and must not be bypassed by auto-merge.'
    );
  }

  if (isOpaqueTitle(title)) {
    failures.push(
      'PR title is empty or opaque. Use a reviewable title such as `fix(scope): explain the root cause` instead of `auto commit <epoch>`, `update`, or `changes`.'
    );
  }

  if (!files.length) {
    failures.push('PR has no changed files. Empty PRs are blocked instead of entering the auto-merge lane.');
  }

  const fileCount = files.length;
  const changedLines = files.reduce((sum, file) => sum + changedLineCount(file), 0);
  const hasBulkException = [...labelSet].some(label => BULK_EXCEPTION_LABELS.has(label));

  if (!hasBulkException && fileCount > MAX_CHANGED_FILES) {
    failures.push(
      `PR touches ${fileCount} files, above the ${MAX_CHANGED_FILES}-file reviewability limit. ` +
      'Split it, or have trusted automation add `mechanical-change-approved`/`bulk-data-approved` for deterministic generated changes.'
    );
  }

  if (!hasBulkException && changedLines > MAX_CHANGED_LINES) {
    failures.push(
      `PR changes ${changedLines} lines, above the ${MAX_CHANGED_LINES}-line reviewability limit. ` +
      'Split it, or have trusted automation add `mechanical-change-approved`/`bulk-data-approved` for deterministic generated changes.'
    );
  }

  const rawMemoryFiles = activeFiles(files).filter(isRawMemoryFile);
  if (rawMemoryFiles.length > 0) {
    failures.push(
      `Raw agent memory/dump files are not allowed in git: ${formatFiles(rawMemoryFiles)}. ` +
      'Store raw memory as CI artifacts or datastore blobs and commit only manifests, hashes, and summaries.'
    );
  }

  const ackFiles = activeFiles(files).filter(isAckProofFile);
  if (ackFiles.length > 0) {
    failures.push(
      `Auto-committed .ack proof files are not valid maker-checker evidence: ${formatFiles(ackFiles)}. ` +
      'Approvals must be external review events, not files committed by the actor being reviewed.'
    );
  }

  if (labelSet.has('agent-pr') && !ALLOWED_AGENT_AUTHORS.has(author)) {
    failures.push(
      `Agent PR is authored by \`${author || 'unknown'}\`, not a dedicated bot identity. ` +
      `Allowed identities: ${[...ALLOWED_AGENT_AUTHORS].map(login => `\`${login}\``).join(', ')}.`
    );
  }

  return { passed: failures.length === 0, failures };
}

function parseEventLabels(pr) {
  return (pr?.labels ?? []).map(label => typeof label === 'string' ? label : label.name).filter(Boolean);
}

function parseGitNumstat(baseSha, headSha) {
  if (!/^[0-9a-f]{40}$/i.test(baseSha) || !/^[0-9a-f]{40}$/i.test(headSha)) {
    throw new Error('BASE_SHA and HEAD_SHA must be 40-character git SHAs.');
  }

  const range = `${baseSha}...${headSha}`;
  const statusOutput = execFileSync('git', ['diff', '--name-status', '--find-renames', range], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const statusByPath = new Map();
  for (const line of statusOutput.split('\n')) {
    if (!line.trim()) continue;
    const columns = line.split('\t');
    const code = columns[0] ?? '';
    const filename = columns[columns.length - 1];
    statusByPath.set(filename, code.startsWith('D') ? 'removed' : 'modified');
  }

  const output = execFileSync('git', ['diff', '--numstat', '--find-renames', range], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const files = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const columns = line.split('\t');
    if (columns.length < 3) continue;

    const additions = Number.parseInt(columns[0], 10);
    const deletions = Number.parseInt(columns[1], 10);
    const filename = columns[columns.length - 1];
    const safeAdditions = Number.isFinite(additions) ? additions : 0;
    const safeDeletions = Number.isFinite(deletions) ? deletions : 0;
    files.push({
      filename,
      additions: safeAdditions,
      deletions: safeDeletions,
      changes: safeAdditions + safeDeletions,
      status: statusByPath.get(filename) ?? 'modified',
    });
  }
  return files;
}

function loadFilesFromEnvOrGit(event) {
  if (process.env.PR_FILES) {
    return JSON.parse(process.env.PR_FILES);
  }

  const baseSha = process.env.BASE_SHA ?? event?.pull_request?.base?.sha ?? '';
  const headSha = process.env.HEAD_SHA ?? event?.pull_request?.head?.sha ?? '';
  return parseGitNumstat(baseSha, headSha);
}

function loadEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return {};
  return JSON.parse(readFileSync(eventPath, 'utf8'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const event = loadEvent();
    const pr = event.pull_request ?? {};
    const result = checkPrGovernance({
      title: process.env.PR_TITLE ?? pr.title ?? '',
      labels: process.env.PR_LABELS ? process.env.PR_LABELS.split(',') : parseEventLabels(pr),
      files: loadFilesFromEnvOrGit(event),
      author: process.env.PR_AUTHOR ?? pr.user?.login ?? '',
    });

    console.log(JSON.stringify(result, null, 2));
    process.exit(result.passed ? 0 : 1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
