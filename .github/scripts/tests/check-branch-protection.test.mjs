import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RECOMMENDED,
  evaluateProtection,
  formatReport,
} from '../check-branch-protection.mjs';

const fullyProtected = {
  required_pull_request_reviews: { required_approving_review_count: 1 },
  required_status_checks: { strict: true, contexts: ['verify'] },
  enforce_admins: { enabled: true },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
};

// ── evaluateProtection ─────────────────────────────────────────────────────────

test('evaluateProtection: null payload reports unprotected with all missing', () => {
  const result = evaluateProtection(null);
  assert.equal(result.protected, false);
  assert.equal(result.satisfied.length, 0);
  assert.equal(result.missing.length, RECOMMENDED.length);
});

test('evaluateProtection: fully protected branch has no missing settings', () => {
  const result = evaluateProtection(fullyProtected);
  assert.equal(result.protected, true);
  assert.equal(result.missing.length, 0);
  assert.equal(result.satisfied.length, RECOMMENDED.length);
});

test('evaluateProtection: detects missing approving review requirement', () => {
  const result = evaluateProtection({
    ...fullyProtected,
    required_pull_request_reviews: { required_approving_review_count: 0 },
  });
  assert.ok(result.missing.some((m) => m.includes('approving review')));
});

test('evaluateProtection: detects force pushes allowed', () => {
  const result = evaluateProtection({
    ...fullyProtected,
    allow_force_pushes: { enabled: true },
  });
  assert.ok(result.missing.some((m) => m.includes('force push')));
});

test('evaluateProtection: detects admins not enforced', () => {
  const result = evaluateProtection({
    ...fullyProtected,
    enforce_admins: { enabled: false },
  });
  assert.ok(result.missing.some((m) => m.includes('administrators')));
});

test('evaluateProtection: missing required_status_checks flagged', () => {
  const { required_status_checks, ...rest } = fullyProtected;
  const result = evaluateProtection(rest);
  assert.ok(result.missing.some((m) => m.includes('status checks')));
});

// ── formatReport ────────────────────────────────────────────────────────────────

test('formatReport: unprotected branch mentions no rule configured', () => {
  const report = formatReport('owner/repo', 'main', evaluateProtection(null));
  assert.match(report, /No branch protection rule is configured/);
  assert.match(report, /SECURITY-BRANCH-PROTECTION\.md/);
});

test('formatReport: fully protected branch reports all enabled', () => {
  const report = formatReport('owner/repo', 'main', evaluateProtection(fullyProtected));
  assert.match(report, /All recommended protections are enabled/);
  assert.ok(!report.includes('✗'));
});

test('formatReport: partial protection lists missing count', () => {
  const result = evaluateProtection({ ...fullyProtected, allow_deletions: { enabled: true } });
  const report = formatReport('owner/repo', 'main', result);
  assert.match(report, /1 recommended protection\(s\) missing/);
});
