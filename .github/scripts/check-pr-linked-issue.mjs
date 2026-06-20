#!/usr/bin/env node
/**
 * check-pr-linked-issue.mjs
 * Checks that a PR body either closes an existing issue or inlines an
 * issue-template-shaped description. Bare `#123` / `Refs #123` references are
 * intentionally not enough because they leave resolved backlog items open.
 * Respects conventional commit prefixes — skips check for
 * docs/chore/build/ci/style/test/revert prefixed PRs.
 *
 * Exports:
 *   checkLinkedIssue(prBody, prTitle) → { passed, failures }
 *   hasInlineIssueDescription(prBody) → boolean
 */
import { fileURLToPath } from 'node:url';

const PAPERCLIP_ISSUE_URL_PATTERN = String.raw`https:\/\/github\.com\/paperclipai\/paperclip\/issues\/\d+`;
const PAPERCLIP_ISSUE_URL_BOUNDARY_PATTERN = String.raw`(?=$|[\s),:;!?]|[.](?![\w-]))`;

const CLOSING_ISSUE_PATTERNS = [
  /(?:fixes|closes|resolves)\s+#\d+/i,
  new RegExp(
    String.raw`(?:fixes|closes|resolves)\s+${PAPERCLIP_ISSUE_URL_PATTERN}${PAPERCLIP_ISSUE_URL_BOUNDARY_PATTERN}`,
    'i',
  ),
];

const ISSUE_REFERENCE_PATTERNS = [
  /(?:refs|references|see)\s+#\d+/i,
  new RegExp(
    String.raw`(?:^|[\s(])${PAPERCLIP_ISSUE_URL_PATTERN}${PAPERCLIP_ISSUE_URL_BOUNDARY_PATTERN}`,
    'i',
  ),
  /(?<!\w)#\d+/,
];

// Prefixes where neither a linked issue nor an inline description is required
const SKIP_ISSUE_PREFIXES = ['docs', 'chore', 'build', 'ci', 'style', 'test', 'revert'];

// Minimum number of template fields the PR body must match to count as an
// inline issue description.
const INLINE_DESCRIPTION_MIN_FIELDS = 3;

// Per-template field labels. Each field is an array of accepted variants; the
// field counts as "present" if any variant appears as a markdown heading
// (`## Label`) or as a bolded/plain label on its own line (`**Label**` /
// `Label:`). Matching is case-insensitive.
const TEMPLATE_FIELDS = {
  bug: [
    ['What happened', 'What happened?'],
    ['Expected behavior', 'Expected behaviour'],
    ['Steps to reproduce', 'Reproduction steps', 'Repro steps'],
    ['Paperclip version', 'Paperclip version or commit', 'Version or commit', 'Version/commit'],
    ['Deployment mode'],
  ],
  feature: [
    ['Problem or motivation', 'Problem', 'Motivation'],
    ['Proposed solution', 'Solution'],
    ['Alternatives considered', 'Alternatives'],
    ['Roadmap alignment', 'Roadmap'],
  ],
  adapter: [
    ['Agent or provider', 'Agent', 'Provider', 'Adapter'],
    ["Why this adapter is useful", "Why it's useful", 'Why useful', 'Use case'],
    ['How the agent is invoked', 'How it is invoked', "How it's invoked", 'Invocation'],
  ],
};

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countMatchedFields(body, fieldSet) {
  let matched = 0;
  for (const variants of fieldSet) {
    const hasMatch = variants.some(label => {
      const esc = escapeRegExp(label);
      // Accept markdown headings or bolded/plain labels on their own line.
      // Examples: "## What happened?", "**Expected behavior**", "Problem:".
      const pattern = new RegExp(
        `^\\s*(?:#{1,6}\\s+|\\*\\*\\s*|__\\s*)?${esc}(?:\\s*[:?])?(?:\\s*\\*\\*|\\s*__)?\\s*$`,
        'im'
      );
      return pattern.test(body);
    });
    if (hasMatch) matched += 1;
  }
  return matched;
}

export function hasInlineIssueDescription(body) {
  if (!body || !body.trim()) return false;
  for (const fieldSet of Object.values(TEMPLATE_FIELDS)) {
    if (countMatchedFields(body, fieldSet) >= INLINE_DESCRIPTION_MIN_FIELDS) {
      return true;
    }
  }
  return false;
}

function parsePrefix(title) {
  if (!title) return null;
  const match = title.match(/^([a-z]+)(?:\([^)]*\))?:/);
  return match ? match[1].toLowerCase() : null;
}

export function checkLinkedIssue(body, prTitle = '') {
  const prefix = parsePrefix(prTitle);

  if (prefix && SKIP_ISSUE_PREFIXES.includes(prefix)) {
    return { passed: true, failures: [] };
  }

  if (!body || !body.trim()) {
    return { passed: false, failures: ['PR body is empty — please fill out the PR template'] };
  }

  const closingLinked = CLOSING_ISSUE_PATTERNS.some(p => p.test(body));
  const onlyReferenced = !closingLinked && ISSUE_REFERENCE_PATTERNS.some(p => p.test(body));
  const inlined = hasInlineIssueDescription(body);
  const passed = closingLinked || inlined;

  return {
    passed,
    failures: passed ? [] : [
      onlyReferenced
        ? 'Issue reference found, but it will not close backlog automatically — use `Fixes #NNN`, `Closes #NNN`, or `Resolves #NNN` when this PR resolves an existing issue, or include an inline issue-template description when it intentionally has no closing issue.'
        : 'No closing issue link or inline issue description found — either tag an existing issue ' +
          'with `Fixes #NNN` / `Closes #NNN` / `Resolves #NNN`, or describe the underlying issue ' +
          'inline in the PR body following one of our issue templates ' +
          '(https://github.com/paperclipai/paperclip/tree/master/.github/ISSUE_TEMPLATE). ' +
          'See CONTRIBUTING.md → "Link Issues or Describe Them In-PR".',
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const body = process.env.PR_BODY ?? '';
  const title = process.env.PR_TITLE ?? '';
  const result = checkLinkedIssue(body, title);
  console.log(JSON.stringify(result));
  process.exit(result.passed ? 0 : 1);
}
