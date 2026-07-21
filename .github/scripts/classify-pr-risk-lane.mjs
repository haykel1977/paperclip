#!/usr/bin/env node
/**
 * classify-pr-risk-lane.mjs
 * Deterministic, fail-closed PR risk-lane classifier for development/test
 * autonomy. It reads PR metadata plus the local git diff and assigns one of
 * three lanes:
 *
 *   GREEN  — bounded low-risk diff, known actor, valid inputs, fresh head SHA,
 *            and all required evidence green. Only GREEN is auto-merge eligible.
 *   ORANGE — plausibly safe but needs extra human evidence (broader scope or
 *            size). Never auto-merges by default.
 *   RED    — touches a sacred/high-blast-radius surface, exceeds reviewability
 *            limits, or trips any fail-closed condition. Requires a human.
 *
 * Fail-closed by construction: missing/invalid inputs, contradictory labels, a
 * stale PR head SHA, neutral/skipped/missing required evidence, or an unknown
 * actor all resolve to RED. When in doubt, the classifier picks the most
 * restrictive lane.
 *
 * This module only inspects metadata and `git diff` numstat; it never executes
 * PR code. The CLI is meant to run from the base-branch context (e.g. under
 * pull_request_target) so untrusted PR code is never run with a privileged
 * token.
 *
 * Export: classifyPrRiskLane({ title, labels, files, author, headSha,
 *   expectedHeadSha, evidence, requiredEvidence }) → { lane, autoMergeEligible,
 *   reasons }
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MAX_CHANGED_LINES,
  MAX_CHANGED_FILES,
  HARD_BLOCK_LABELS,
  isOpaqueTitle,
} from './check-pr-governance.mjs';

export const LANES = Object.freeze({ GREEN: 'GREEN', ORANGE: 'ORANGE', RED: 'RED' });

// GREEN is intentionally narrow: a bounded diff a reviewer can hold in their
// head. Anything larger but still non-sacred lands in ORANGE.
export const MAX_GREEN_CHANGED_LINES = 200;
export const MAX_GREEN_CHANGED_FILES = 10;

// Baseline automated evidence that must be green before a PR can be GREEN. These
// mirror the required branch-protection checks. Neutral/skipped/missing here is
// fail-closed (RED), never treated as a pass.
export const DEFAULT_REQUIRED_EVIDENCE = Object.freeze(['verify', 'gitleaks']);
const PASSING_EVIDENCE_CONCLUSIONS = new Set(['success']);

// Actors permitted to reach an autonomous (GREEN) lane. An unknown actor is
// fail-closed to RED — GREEN autonomy is only for recognized identities; humans
// and unknown bots still get a human-reviewed lane.
export const KNOWN_ACTORS = new Set([
  'commitperclip[bot]',
  'github-actions[bot]',
  'paperclipai[bot]',
  'dependabot[bot]',
]);

// Explicit lane-hint labels. More than one distinct hint is contradictory.
export const LANE_HINT_LABELS = Object.freeze({
  'risk:green': LANES.GREEN,
  'risk:orange': LANES.ORANGE,
  'risk:red': LANES.RED,
});

// Auto-merge opt-in label. Combined with any hard-block label it is a
// contradiction (asking to auto-merge something explicitly gated).
export const AUTOMERGE_LABEL = 'automerge';

// RED path matchers. Each entry documents the sacred/high-blast-radius surface
// it guards. Any active (non-removed) changed file matching any matcher is RED.
export const RED_PATH_MATCHERS = Object.freeze([
  // .github/** — workflows, actions, governance config, issue/PR templates.
  { label: 'CI/workflow or .github governance', re: /^\.github\// },
  // CODEOWNERS anywhere it is honored by GitHub.
  { label: 'CODEOWNERS', re: /(^|\/)CODEOWNERS$/ },
  // Governance / checker code (the gate must not silently rewrite itself).
  { label: 'governance/checker code', re: /(^|\/)scripts\/check-[^/]+\.mjs$/ },
  { label: 'governance/checker code', re: /(^|\/)scripts\/(release-package-map|run-quality-gates)[^/]*\.mjs$/ },
  // Auth / authz surfaces.
  { label: 'auth/authz', re: /(^|\/)(auth|authz|authn|authorization|authentication)[^/]*\.(ts|tsx|js|mjs|cjs)$/i },
  { label: 'auth/authz', re: /(^|\/)(auth|authz)\// },
  { label: 'auth/authz', re: /workspace-command-authz\.ts$/ },
  // Secrets / credential material.
  { label: 'secrets', re: /(^|\/)\.env(\.[^/]+)?$/ },
  { label: 'secrets', re: /(^|\/)\.gitleaks\.toml$/ },
  { label: 'secrets', re: /(secret|secrets|credential|credentials)[^/]*\.(ts|tsx|js|mjs|cjs|json|ya?ml)$/i },
  // Migrations / schema.
  { label: 'migrations/schema', re: /(^|\/)migrations?\// },
  { label: 'migrations/schema', re: /(^|\/)schema\// },
  { label: 'migrations/schema', re: /\.sql$/i },
  { label: 'migrations/schema', re: /(^|\/)drizzle\.config\.[^/]+$/ },
  // Infrastructure / release / production.
  { label: 'infrastructure/release/production', re: /(^|\/)Dockerfile[^/]*$/ },
  { label: 'infrastructure/release/production', re: /(^|\/)docker\// },
  { label: 'infrastructure/release/production', re: /(^|\/)releases?\// },
  { label: 'infrastructure/release/production', re: /(^|\/)scripts\/release[^/]*\.(sh|mjs|js|ts)$/ },
  { label: 'infrastructure/release/production', re: /\.(tf|tfvars)$/i },
  { label: 'infrastructure/release/production', re: /(^|\/)(k8s|kubernetes|helm|terraform|deploy)\// },
  // Dependency manifests / lockfiles.
  { label: 'dependency manifest/lockfile', re: /(^|\/)package\.json$/ },
  { label: 'dependency manifest/lockfile', re: /(^|\/)pnpm-lock\.yaml$/ },
  { label: 'dependency manifest/lockfile', re: /(^|\/)pnpm-workspace\.yaml$/ },
  { label: 'dependency manifest/lockfile', re: /(^|\/)\.npmrc$/ },
  { label: 'dependency manifest/lockfile', re: /(^|\/)(package-lock\.json|yarn\.lock)$/ },
  { label: 'dependency manifest/lockfile', re: /(^|\/)pnpmfile\.(c|m)?js$/ },
]);

const SHA_RE = /^[0-9a-f]{40}$/i;

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

export function matchRedPaths(files) {
  const hits = [];
  for (const file of activeFiles(files)) {
    const path = normalizePath(file.filename);
    for (const matcher of RED_PATH_MATCHERS) {
      if (matcher.re.test(path)) {
        hits.push({ file: path, label: matcher.label });
        break;
      }
    }
  }
  return hits;
}

/**
 * Reduce raw evidence into pass/neutral/missing buckets against the required
 * set. Anything that is not an explicit `success` for a required signal is
 * fail-closed.
 */
export function evaluateEvidence(evidence, requiredEvidence = DEFAULT_REQUIRED_EVIDENCE) {
  const byName = new Map();
  for (const item of Array.isArray(evidence) ? evidence : []) {
    const name = String(item?.name ?? '').trim();
    if (!name) continue;
    // Neutral/skipped/null all normalize to a non-passing string so they can
    // never be mistaken for success.
    const conclusion = String(item?.conclusion ?? 'missing').trim().toLowerCase() || 'missing';
    byName.set(name, conclusion);
  }

  const missing = [];
  const notPassing = [];
  for (const name of requiredEvidence) {
    if (!byName.has(name)) {
      missing.push(name);
      continue;
    }
    if (!PASSING_EVIDENCE_CONCLUSIONS.has(byName.get(name))) {
      notPassing.push({ name, conclusion: byName.get(name) });
    }
  }
  return { missing, notPassing, allPassing: missing.length === 0 && notPassing.length === 0 };
}

export function classifyPrRiskLane({
  title = '',
  labels = [],
  files = [],
  author = '',
  headSha = '',
  expectedHeadSha = '',
  evidence = [],
  requiredEvidence = DEFAULT_REQUIRED_EVIDENCE,
} = {}) {
  const redReasons = [];
  const orangeReasons = [];

  const labelSet = new Set((labels ?? []).map(normalizeLabel).filter(Boolean));

  // ── Fail-closed input validation ─────────────────────────────────────────
  if (!Array.isArray(files)) {
    return red(['Invalid input: `files` must be an array. Failing closed.']);
  }
  if (isOpaqueTitle(title)) {
    redReasons.push('PR title is missing or opaque. A reviewable title is required; failing closed.');
  }
  if (files.length === 0) {
    redReasons.push('PR has no changed files. Empty/undeterminable diffs fail closed.');
  }

  // ── Unknown actor is fail-closed ─────────────────────────────────────────
  const normalizedAuthor = String(author ?? '').trim();
  if (!KNOWN_ACTORS.has(normalizedAuthor)) {
    redReasons.push(
      `Actor \`${normalizedAuthor || 'unknown'}\` is not a recognized autonomy identity. ` +
      `GREEN autonomy is limited to: ${[...KNOWN_ACTORS].map(a => `\`${a}\``).join(', ')}.`
    );
  }

  // ── Hard-block labels ────────────────────────────────────────────────────
  const hardBlockLabels = [...labelSet].filter(label => HARD_BLOCK_LABELS.has(label));
  if (hardBlockLabels.length > 0) {
    redReasons.push(
      `Hard-block label(s) present: ${hardBlockLabels.map(l => `\`${l}\``).join(', ')}.`
    );
  }

  // ── Contradictory labels ─────────────────────────────────────────────────
  const laneHints = [...labelSet]
    .filter(label => label in LANE_HINT_LABELS)
    .map(label => LANE_HINT_LABELS[label]);
  const distinctHints = new Set(laneHints);
  if (distinctHints.size > 1) {
    redReasons.push(
      `Contradictory risk-lane labels present: ${[...distinctHints].join(', ')}. Failing closed.`
    );
  }
  if (labelSet.has(AUTOMERGE_LABEL) && hardBlockLabels.length > 0) {
    redReasons.push(
      `Contradictory labels: \`${AUTOMERGE_LABEL}\` requested alongside hard-block label(s) ` +
      `${hardBlockLabels.map(l => `\`${l}\``).join(', ')}. Failing closed.`
    );
  }

  // ── Stale head SHA ───────────────────────────────────────────────────────
  const expected = String(expectedHeadSha ?? '').trim();
  const actual = String(headSha ?? '').trim();
  if (expected) {
    if (!SHA_RE.test(expected) || !SHA_RE.test(actual)) {
      redReasons.push('Head SHA could not be validated (missing or malformed). Failing closed.');
    } else if (expected.toLowerCase() !== actual.toLowerCase()) {
      redReasons.push(
        `Stale PR head SHA: evaluated \`${expected}\` but current head is \`${actual}\`. Failing closed.`
      );
    }
  }

  // ── Required evidence ────────────────────────────────────────────────────
  const evidenceResult = evaluateEvidence(evidence, requiredEvidence);
  if (evidenceResult.missing.length > 0) {
    redReasons.push(
      `Missing required evidence: ${evidenceResult.missing.map(n => `\`${n}\``).join(', ')}. Failing closed.`
    );
  }
  if (evidenceResult.notPassing.length > 0) {
    redReasons.push(
      'Required evidence is neutral/skipped/failing, not green: ' +
      evidenceResult.notPassing.map(e => `\`${e.name}\`=${e.conclusion}`).join(', ') +
      '. Failing closed.'
    );
  }

  // ── RED path surfaces ────────────────────────────────────────────────────
  const redPathHits = matchRedPaths(files);
  if (redPathHits.length > 0) {
    const grouped = [...new Set(redPathHits.map(hit => hit.label))];
    redReasons.push(
      `Touches sacred/high-blast-radius surface(s) (${grouped.join(', ')}): ` +
      redPathHits.slice(0, 5).map(hit => `\`${hit.file}\``).join(', ') +
      (redPathHits.length > 5 ? `, … (+${redPathHits.length - 5})` : '') + '.'
    );
  }

  // ── Diff size ────────────────────────────────────────────────────────────
  const fileCount = files.length;
  const changedLines = files.reduce((sum, file) => sum + changedLineCount(file), 0);
  if (fileCount > MAX_CHANGED_FILES || changedLines > MAX_CHANGED_LINES) {
    redReasons.push(
      `Excessive diff size: ${fileCount} files / ${changedLines} lines exceeds the ` +
      `${MAX_CHANGED_FILES}-file / ${MAX_CHANGED_LINES}-line reviewability limit.`
    );
  }

  if (redReasons.length > 0 || distinctHints.has(LANES.RED)) {
    if (distinctHints.has(LANES.RED) && redReasons.length === 0) {
      redReasons.push('Explicit `risk:red` label present.');
    }
    return red(redReasons);
  }

  // ── ORANGE: safe surface but wants extra human evidence ──────────────────
  if (fileCount > MAX_GREEN_CHANGED_FILES || changedLines > MAX_GREEN_CHANGED_LINES) {
    orangeReasons.push(
      `Diff (${fileCount} files / ${changedLines} lines) is larger than the GREEN bound ` +
      `(${MAX_GREEN_CHANGED_FILES} files / ${MAX_GREEN_CHANGED_LINES} lines); needs extra human evidence.`
    );
  }
  if (distinctHints.has(LANES.ORANGE)) {
    orangeReasons.push('Explicit `risk:orange` label present.');
  }

  if (orangeReasons.length > 0) {
    return { lane: LANES.ORANGE, autoMergeEligible: false, reasons: orangeReasons };
  }

  return {
    lane: LANES.GREEN,
    autoMergeEligible: true,
    reasons: ['Bounded low-risk diff by a known actor with green required evidence.'],
  };
}

function red(reasons) {
  return { lane: LANES.RED, autoMergeEligible: false, reasons };
}

// ── CLI plumbing (mirrors check-pr-governance.mjs) ──────────────────────────

function parseEventLabels(pr) {
  return (pr?.labels ?? []).map(label => typeof label === 'string' ? label : label?.name).filter(Boolean);
}

function parseGitNumstat(baseSha, headSha) {
  if (!SHA_RE.test(baseSha) || !SHA_RE.test(headSha)) {
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
  if (process.env.PR_FILES) return JSON.parse(process.env.PR_FILES);
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
    const result = classifyPrRiskLane({
      title: process.env.PR_TITLE ?? pr.title ?? '',
      labels: process.env.PR_LABELS ? process.env.PR_LABELS.split(',') : parseEventLabels(pr),
      files: loadFilesFromEnvOrGit(event),
      author: process.env.PR_AUTHOR ?? pr.user?.login ?? '',
      headSha: process.env.HEAD_SHA ?? pr.head?.sha ?? '',
      expectedHeadSha: process.env.EXPECTED_HEAD_SHA ?? '',
      evidence: process.env.PR_EVIDENCE ? JSON.parse(process.env.PR_EVIDENCE) : [],
      requiredEvidence: process.env.REQUIRED_EVIDENCE
        ? process.env.REQUIRED_EVIDENCE.split(',').map(s => s.trim()).filter(Boolean)
        : DEFAULT_REQUIRED_EVIDENCE,
    });

    console.log(JSON.stringify(result, null, 2));
    // Only GREEN is a "clean" exit for autonomy; ORANGE/RED are non-zero so a
    // caller that treats exit code as an auto-merge gate fails closed.
    process.exit(result.lane === LANES.GREEN ? 0 : 1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
