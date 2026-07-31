#!/usr/bin/env node
/**
 * github-governance-carveout.mjs
 *
 * A narrow, fail-closed carve-out that would let a bounded `.github/**` change
 * reach the autonomous (GREEN) lane, which `RED_PATH_MATCHERS` otherwise makes
 * impossible for every path under `.github/`.
 *
 * ── Why this ships in SHADOW mode ────────────────────────────────────────────
 * A carve-out for `.github/**` is a carve-out for the code that judges the
 * carve-out. Granting it requires an identity the PR cannot influence — an
 * EXTERNAL checker App whose id is pinned somewhere the PR cannot edit. This
 * repository has no such immutable configuration: every candidate location
 * (`.github/paperclip-checker.config.json`, this file, any committed JSON) is
 * itself inside the diff the carve-out would exempt, so a PR could ship the
 * carve-out and its own judge in one commit. Repository variables/secrets are
 * the only PR-immutable surface, and none is defined.
 *
 * So the validation framework is implemented in full and wired into the live
 * automerge path, but `resolveMode()` returns `shadow` unless the operator sets
 * the repository variables listed in `REQUIRED_BOOTSTRAP_SETTINGS`. In shadow
 * mode `eligible` is ALWAYS false: `.github/**` stays RED exactly as it is
 * today. `wouldBeEligible` reports what the enforcing decision *would* have
 * been, so the rules can be observed against real PRs before anyone arms them.
 *
 * ── What the carve-out requires (all of them, fail-closed) ───────────────────
 *   1. An external judge App id, pinned in a PR-immutable repository variable,
 *      distinct from the PR author's identity.
 *   2. An exact head-SHA match against the independently-captured event SHA.
 *   3. Every changed path inside a bounded `.github/**` allowlist.
 *   4. No path on the JUDGE surface — the carve-out cannot amend its own judge,
 *      including this file.
 *   5. Bounded file count and changed-line count.
 *   6. No workflow permission broadening (added `*: write`, `write-all`, or a
 *      deleted `permissions:` block, which silently reverts to the permissive
 *      default).
 *   7. No secrets, self-hosted runner, or branch-protection mutation.
 *
 * Pure module: no network, no filesystem, no child processes.
 */

import { KNOWN_ACTORS } from './classify-pr-risk-lane.mjs';

/** The RED_PATH_MATCHERS label this carve-out would waive — and nothing else. */
export const GOVERNANCE_RED_LABEL = 'CI/workflow or .github governance';

export const MODES = Object.freeze({ SHADOW: 'shadow', ENFORCE: 'enforce' });

export const CARVEOUT_MODE_ENV = 'PAPERCLIP_GITHUB_CARVEOUT_MODE';
export const CARVEOUT_JUDGE_APP_ID_ENV = 'PAPERCLIP_GITHUB_CARVEOUT_JUDGE_APP_ID';
export const CARVEOUT_JUDGE_APP_SLUG_ENV = 'PAPERCLIP_GITHUB_CARVEOUT_JUDGE_APP_SLUG';

/**
 * Bootstrap settings an operator must create before the carve-out can leave
 * shadow mode. Repository *variables* (not secrets) are used deliberately: they
 * are readable in logs for auditability, and — critically — a pull request
 * cannot change them, which is the immutability the judge identity needs.
 */
export const REQUIRED_BOOTSTRAP_SETTINGS = Object.freeze([
  Object.freeze({
    kind: 'repository variable',
    name: CARVEOUT_JUDGE_APP_ID_ENV,
    example: '4372695',
    why: 'Numeric App id of the EXTERNAL checker that judges the carve-out. Must not be the delivery App that authors witness PRs, and must not be github-actions.',
  }),
  Object.freeze({
    kind: 'repository variable',
    name: CARVEOUT_JUDGE_APP_SLUG_ENV,
    example: 'solidus-paperclip-checker',
    why: 'Bot slug of the same external checker, cross-checked against the id so a mismatched pair fails closed.',
  }),
  Object.freeze({
    kind: 'repository variable',
    name: CARVEOUT_MODE_ENV,
    example: 'enforce',
    why: 'Explicit opt-in. Any value other than the exact string "enforce" keeps the carve-out in shadow mode.',
  }),
]);

/** App ids that may never act as the judge. */
export const FORBIDDEN_JUDGE_APP_IDS = Object.freeze(new Set([
  15368,   // github-actions — the ambient runner identity, not an external judge
  4384863, // solidus-paperclip-delivery — authors the witness PRs it would judge
  3718661, // commitperclip — runs the workflow that consults the carve-out
]));

export const MAX_CARVEOUT_CHANGED_FILES = 5;
export const MAX_CARVEOUT_CHANGED_LINES = 120;

/**
 * The only paths a carve-out PR may touch. Anything outside `.github/**`, and
 * anything inside it that is not one of these shapes, fails closed.
 */
export const CARVEOUT_ALLOWED_PATHS = Object.freeze([
  /^\.github\/workflows\/[^/]+\.ya?ml$/,
  /^\.github\/scripts\/[^/]+\.(mjs|sh)$/,
  /^\.github\/scripts\/tests\/[^/]+\.test\.mjs$/,
  /^\.github\/ISSUE_TEMPLATE\/[^/]+\.(ya?ml|md)$/,
  /^\.github\/PULL_REQUEST_TEMPLATE\.md$/,
  /^\.github\/dependabot\.ya?ml$/,
  /^\.github\/[^/]+\.md$/,
]);

/**
 * Basenames of the modules that constitute the JUDGE: the code and config that
 * decide whether a PR may merge autonomously. A carve-out PR may not touch any
 * of them, nor their tests (weakening the judge's tests weakens the judge).
 * `github-governance-carveout` is in the list on purpose — this file cannot
 * exempt a change to itself.
 */
export const JUDGE_MODULE_BASENAMES = Object.freeze(new Set([
  'github-governance-carveout',
  'paperclip-checker',
  'required-checks',
  'classify-pr-risk-lane',
  'enable-agent-automerge',
  'check-branch-protection',
  'check-pr-governance',
  'check-pr-security',
  'get-bot-token',
  'paperclip-delivery-token',
  'run-quality-gates',
]));

/** Judge surfaces identified by full path rather than basename. */
export const JUDGE_PATH_MATCHERS = Object.freeze([
  /^\.github\/paperclip-checker\.config\.json$/,
  /^\.github\/workflows\/paperclip-checker\.ya?ml$/,
  /^\.github\/workflows\/commitperclip-review\.ya?ml$/,
  /(^|\/)CODEOWNERS$/,
  // Anything that mints, stores, or names credentials.
  /(^|\/)[^/]*(token|secret|credential)[^/]*\.(mjs|js|cjs|sh|json|ya?ml)$/i,
]);

/** GITHUB_TOKEN permission scopes. An added `<scope>: write` is broadening. */
export const WORKFLOW_PERMISSION_SCOPES = Object.freeze([
  'actions', 'attestations', 'checks', 'contents', 'deployments', 'discussions',
  'id-token', 'issues', 'models', 'packages', 'pages', 'pull-requests',
  'repository-projects', 'security-events', 'statuses',
]);

const PERMISSION_WRITE_RE = new RegExp(
  `^\\+\\s*(${WORKFLOW_PERMISSION_SCOPES.join('|')})\\s*:\\s*write\\s*$`,
);
const PERMISSION_WRITE_ALL_RE = /^\+\s*permissions\s*:\s*write-all\s*$/;
const PERMISSIONS_KEY_RE = /^([+-])\s*permissions\s*:\s*$/;

/** Added-line patterns that escalate privilege regardless of `permissions:`. */
export const ESCALATION_LINE_MATCHERS = Object.freeze([
  { label: 'pull_request_target trigger', re: /^\+\s*pull_request_target\s*:/ },
  { label: 'self-hosted runner', re: /^\+.*\bruns-on\s*:.*\bself-hosted\b/ },
  { label: 'branch-protection mutation', re: /^\+.*branches\/[^\s]*\/protection/ },
  { label: 'repository settings mutation', re: /^\+.*--method\s+(PUT|PATCH|DELETE)\b/ },
  { label: 'direct merge', re: /^\+.*\bgh\s+pr\s+merge\b/ },
  { label: 'admin merge bypass', re: /^\+.*--admin\b/ },
  { label: 'force push', re: /^\+.*git\s+push\b.*--force/ },
  { label: 'new secret reference', re: /^\+.*\bsecrets\.[A-Za-z0-9_]+/ },
  { label: 'unpinned action reference', re: /^\+\s*uses\s*:\s*[^@\s]+@(?![0-9a-f]{40}\b)\S+/ },
]);

const SHA_RE = /^[0-9a-f]{40}$/i;

function normalizePath(path) {
  return String(path ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function pathsOf(file) {
  return [file?.filename, file?.previous_filename].filter(Boolean).map(normalizePath);
}

function basenameStem(path) {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.replace(/\.(test|spec)\.mjs$/, '').replace(/\.[^.]+$/, '');
}

export function isJudgeSurface(path) {
  const normalized = normalizePath(path);
  if (JUDGE_PATH_MATCHERS.some(re => re.test(normalized))) return true;
  return JUDGE_MODULE_BASENAMES.has(basenameStem(normalized));
}

export function isAllowedCarveoutPath(path) {
  const normalized = normalizePath(path);
  return CARVEOUT_ALLOWED_PATHS.some(re => re.test(normalized));
}

function changedLineCount(file) {
  const additions = Number.isFinite(file?.additions) ? file.additions : 0;
  const deletions = Number.isFinite(file?.deletions) ? file.deletions : 0;
  const changes = Number.isFinite(file?.changes) ? file.changes : additions + deletions;
  return changes || additions + deletions;
}

/**
 * Scan unified-diff patches for privilege broadening.
 *
 * A workflow file with no `patch` is a finding, not a pass: GitHub omits the
 * patch for very large or binary diffs, and "we could not look" must never read
 * as "we looked and it was clean".
 */
export function detectPermissionBroadening(files) {
  const findings = [];
  for (const file of Array.isArray(files) ? files : []) {
    const path = normalizePath(file?.filename);
    const isWorkflow = /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path);
    const patch = typeof file?.patch === 'string' ? file.patch : '';

    if (!patch) {
      if (file?.status === 'removed' && isWorkflow) {
        findings.push({ file: path, label: 'workflow deleted' });
        continue;
      }
      findings.push({ file: path, label: 'diff unavailable (cannot verify permissions)' });
      continue;
    }

    let addedPermissionsKey = false;
    let removedPermissionsKey = false;
    for (const line of patch.split('\n')) {
      if (PERMISSION_WRITE_ALL_RE.test(line)) {
        findings.push({ file: path, label: 'permissions: write-all' });
      }
      if (PERMISSION_WRITE_RE.test(line)) {
        findings.push({ file: path, label: `added write scope: ${line.trim().replace(/^\+\s*/, '')}` });
      }
      const keyMatch = line.match(PERMISSIONS_KEY_RE);
      if (keyMatch) {
        if (keyMatch[1] === '+') addedPermissionsKey = true;
        else removedPermissionsKey = true;
      }
      for (const matcher of ESCALATION_LINE_MATCHERS) {
        if (matcher.re.test(line)) findings.push({ file: path, label: matcher.label });
      }
    }

    // Deleting a `permissions:` block reverts the job to the repository default,
    // which may be read/write for every scope — broadening by omission.
    if (removedPermissionsKey && !addedPermissionsKey) {
      findings.push({ file: path, label: 'permissions block removed (reverts to repository default)' });
    }
  }
  return findings;
}

/**
 * Resolve the judge identity from a PR-immutable source. Returns null (never a
 * default) when it cannot be established, so the caller fails closed.
 */
export function resolveJudge(env = process.env) {
  const rawId = String(env[CARVEOUT_JUDGE_APP_ID_ENV] ?? '').trim();
  const slug = String(env[CARVEOUT_JUDGE_APP_SLUG_ENV] ?? '').trim();
  if (!rawId || !slug) return null;
  if (!/^[0-9]+$/.test(rawId)) return null;
  const appId = Number.parseInt(rawId, 10);
  if (!Number.isInteger(appId) || appId <= 0) return null;
  if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(slug)) return null;
  return { appId, slug };
}

export function resolveMode(env = process.env) {
  return String(env[CARVEOUT_MODE_ENV] ?? '').trim().toLowerCase() === MODES.ENFORCE
    ? MODES.ENFORCE
    : MODES.SHADOW;
}

/**
 * Evaluate the carve-out.
 *
 * @returns {{
 *   applicable: boolean, mode: string, shadow: boolean,
 *   eligible: boolean, wouldBeEligible: boolean,
 *   exemptRedPathLabels: string[], reasons: string[],
 *   requiredSettings: ReadonlyArray<object>,
 * }}
 *   `eligible` is the ONLY field a caller may act on, and it is false in shadow
 *   mode by construction. `exemptRedPathLabels` mirrors it: `[]` unless the
 *   carve-out actually granted the exemption.
 */
export function evaluateGithubGovernanceCarveout({
  pr,
  files = [],
  author = '',
  headSha = '',
  expectedHeadSha = '',
  env = process.env,
} = {}) {
  const mode = resolveMode(env);
  const shadow = mode !== MODES.ENFORCE;
  const deny = (reasons, applicable = true) => ({
    applicable,
    mode,
    shadow,
    eligible: false,
    wouldBeEligible: false,
    exemptRedPathLabels: [],
    reasons,
    requiredSettings: REQUIRED_BOOTSTRAP_SETTINGS,
  });

  if (!Array.isArray(files)) {
    return deny(['Invalid input: `files` must be an array. Failing closed.']);
  }
  const touchesGithub = files.some(file => pathsOf(file).some(p => p.startsWith('.github/')));
  if (!touchesGithub) {
    return deny(['No `.github/**` path in the diff; the governance carve-out does not apply.'], false);
  }

  const reasons = [];

  // 1. External judge identity, pinned outside the PR's reach.
  const judge = resolveJudge(env);
  if (!judge) {
    reasons.push(
      'No external judge identity is configured. The carve-out requires ' +
      `\`${CARVEOUT_JUDGE_APP_ID_ENV}\` and \`${CARVEOUT_JUDGE_APP_SLUG_ENV}\` to be set as ` +
      'repository variables (PR-immutable). Failing closed.',
    );
  } else if (FORBIDDEN_JUDGE_APP_IDS.has(judge.appId)) {
    reasons.push(
      `Judge App id ${judge.appId} is not external to this decision (it authors, runs, or is ` +
      'the ambient identity of the PRs it would judge). Failing closed.',
    );
  }

  // 2. Exact head SHA, from the independently-captured event payload.
  const expected = String(expectedHeadSha ?? '').trim();
  const actual = String(headSha ?? '').trim();
  if (!SHA_RE.test(expected) || !SHA_RE.test(actual)) {
    reasons.push('Head SHA is missing or malformed on one of the two independent sources. Failing closed.');
  } else if (expected.toLowerCase() !== actual.toLowerCase()) {
    reasons.push(`Head SHA mismatch: event captured \`${expected}\` but the PR head is \`${actual}\`. Failing closed.`);
  }

  // 3. Recognized autonomous actor.
  const rawAuthor = String(author ?? pr?.user?.login ?? '');
  if (!KNOWN_ACTORS.has(rawAuthor)) {
    reasons.push(`Actor \`${rawAuthor || 'unknown'}\` is not a recognized autonomy identity. Failing closed.`);
  }
  if (judge && rawAuthor && rawAuthor.replace(/\[bot\]$/, '') === judge.slug) {
    reasons.push(`The PR author \`${rawAuthor}\` IS the judge \`${judge.slug}\`; a judge may not clear its own PR.`);
  }

  // 4/5. Bounded paths, and never the judge's own surface.
  const outsideAllowlist = [];
  const judgeSurfaces = [];
  for (const file of files) {
    for (const path of pathsOf(file)) {
      if (isJudgeSurface(path)) judgeSurfaces.push(path);
      else if (!isAllowedCarveoutPath(path)) outsideAllowlist.push(path);
    }
  }
  if (judgeSurfaces.length > 0) {
    reasons.push(
      'Self-amendment: the diff modifies the judge itself ' +
      `(${[...new Set(judgeSurfaces)].map(p => `\`${p}\``).join(', ')}). ` +
      'The carve-out can never exempt a change to the code that grants it.',
    );
  }
  if (outsideAllowlist.length > 0) {
    reasons.push(
      'Path(s) outside the bounded carve-out allowlist: ' +
      `${[...new Set(outsideAllowlist)].slice(0, 5).map(p => `\`${p}\``).join(', ')}.`,
    );
  }

  // 6. Size bounds — tighter than the GREEN lane's, because this surface is
  // governance and a reviewer must be able to read the whole diff.
  const fileCount = files.length;
  const changedLines = files.reduce((sum, file) => sum + changedLineCount(file), 0);
  if (fileCount > MAX_CARVEOUT_CHANGED_FILES || changedLines > MAX_CARVEOUT_CHANGED_LINES) {
    reasons.push(
      `Diff exceeds the carve-out bound: ${fileCount} files / ${changedLines} lines > ` +
      `${MAX_CARVEOUT_CHANGED_FILES} files / ${MAX_CARVEOUT_CHANGED_LINES} lines.`,
    );
  }

  // 7. Privilege broadening / settings mutation.
  const broadening = detectPermissionBroadening(files);
  if (broadening.length > 0) {
    reasons.push(
      'Privilege broadening or settings mutation detected: ' +
      broadening.slice(0, 5).map(f => `\`${f.file}\` (${f.label})`).join(', ') +
      (broadening.length > 5 ? `, … (+${broadening.length - 5})` : '') + '.',
    );
  }

  const wouldBeEligible = reasons.length === 0;
  if (shadow) {
    return {
      applicable: true,
      mode,
      shadow: true,
      eligible: false,
      wouldBeEligible,
      exemptRedPathLabels: [],
      reasons: wouldBeEligible
        ? [`Shadow mode: all carve-out conditions passed, but \`${CARVEOUT_MODE_ENV}\` is not "enforce", so \`.github/**\` stays RED.`]
        : reasons,
      requiredSettings: REQUIRED_BOOTSTRAP_SETTINGS,
    };
  }

  if (!wouldBeEligible) return deny(reasons);

  return {
    applicable: true,
    mode,
    shadow: false,
    eligible: true,
    wouldBeEligible: true,
    exemptRedPathLabels: [GOVERNANCE_RED_LABEL],
    reasons: ['Bounded `.github/**` governance change cleared by the external judge carve-out.'],
    requiredSettings: REQUIRED_BOOTSTRAP_SETTINGS,
  };
}

/** One-line, log-friendly rendering for CI annotations. */
export function summarizeCarveout(result) {
  if (!result) return 'governance carve-out: not evaluated.';
  if (!result.applicable) return 'governance carve-out: not applicable (no `.github/**` path changed).';
  const verdict = result.eligible
    ? 'GRANTED'
    : `withheld (${result.shadow ? `shadow; would-be ${result.wouldBeEligible ? 'eligible' : 'ineligible'}` : 'ineligible'})`;
  return `governance carve-out: ${verdict} — ${result.reasons.join(' ')}`;
}
