#!/usr/bin/env node
/**
 * check-pr-template.mjs
 * Checks that a PR body contains all required sections from the PR template.
 * Export: checkTemplate(prBody: string) → { passed: boolean, failures: string[] }
 */
import { fileURLToPath } from 'node:url';

const REQUIRED_SECTIONS = [
  { heading: '## Thinking Path', minSentences: 3 },
  { heading: '## What Changed', minSentences: 1 },
  { heading: '## Verification', minSentences: 1 },
  { heading: '## PR Readiness Gate', minSentences: 1 },
  { heading: '## Risks', minSentences: 1 },
  { heading: '## Model Used', minSentences: 1 },
];

const MODEL_PLACEHOLDERS = [
  'provider, model id',
  'your model',
  '<model>',
];

const PR_READINESS_FIELDS = [
  'Diff scope',
  'Template status',
  'Verification evidence',
  'CI status',
];

const DISALLOWED_CI_STATUS_CLAIMS = [
  {
    pattern: /\bcodeql\b/i,
    label: 'CodeQL',
  },
  {
    pattern: /\bdraft(?:\s|-)*pr\s+guard\b/i,
    label: 'draft PR guard',
  },
  {
    pattern: /\b(green|passed|passing|success(?:ful)?|verified|all\s+checks\s+(?:are\s+)?green)\b/i,
    label: 'unverified green CI',
  },
];

function extractSectionContent(body, heading) {

  const idx = body.indexOf(heading);
  if (idx === -1) return null;
  const after = body.slice(idx + heading.length);
  const nextHeading = after.search(/\n## /);
  return (nextHeading === -1 ? after : after.slice(0, nextHeading)).trim();
}

function countSentences(text) {
  // Split on terminal punctuation, bullet/quote line starts (`-`, `*`, `>`), or
  // blank lines so non-prose Thinking Paths (bullet lists, blockquotes) are
  // counted by item rather than as a single sentence.
  return text.split(/[.!?]+\s+|\n\s*[-*>]+\s+|\n{2,}/).filter(s => s.trim().length > 5).length;
}

function readReadinessField(content, field) {
  const normalizedField = field.toLowerCase();
  for (const line of content.split('\n')) {
    const trimmed = line.trim().replace(/^[-*]\s*/, '');
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue;
    const key = trimmed.slice(0, colonIndex).trim().toLowerCase();
    if (key === normalizedField) return trimmed.slice(colonIndex + 1).trim();
  }
  return '';
}

function isPlaceholderReadinessValue(value) {
  return !value || /^[-_—–]+$/.test(value) || /^todo$/i.test(value) || /^tbd$/i.test(value);
}

function isPlaceholderSectionContent(content) {
  const withoutComments = content.replace(/<!--[^]*?-->/g, '').trim();
  if (!withoutComments) return true;
  const lines = withoutComments.split('\n').map(line => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.every(line => /^[-*]>?\s*[-_—–]*$/.test(line) || /^\[[ xX]\]$/.test(line));
}

export function checkTemplate(body) {

  const failures = [];

  if (!body || !body.trim()) {
    for (const { heading } of REQUIRED_SECTIONS) {
      failures.push(`Missing section: **${heading}**`);
    }
    return { passed: false, failures };
  }

  for (const { heading, minSentences } of REQUIRED_SECTIONS) {
    const content = extractSectionContent(body, heading);

    if (content === null) {
      failures.push(`Missing section: **${heading}**`);
      continue;
    }

    if (!content || content === '_No response_' || /^<!--/.test(content) || isPlaceholderSectionContent(content)) {
      failures.push(`Empty section: **${heading}**`);
      continue;
    }

    if (heading === '## Thinking Path') {

      const n = countSentences(content);
      if (n < minSentences) {
        failures.push(
          `**Thinking Path** needs more detail (${n} sentence${n === 1 ? '' : 's'} — aim for 3+)`
        );
      }
    }

    if (heading === '## PR Readiness Gate') {
      for (const field of PR_READINESS_FIELDS) {
        const value = readReadinessField(content, field);
        if (isPlaceholderReadinessValue(value)) {
          failures.push(`**PR Readiness Gate** missing value for ${field}`);
        }
      }

      const ciStatus = readReadinessField(content, 'CI status');
      for (const claim of DISALLOWED_CI_STATUS_CLAIMS) {
        if (claim.pattern.test(ciStatus)) {
          failures.push(
            claim.label === 'unverified green CI'
              ? '**PR Readiness Gate** CI status must not self-certify green/passed checks. State that GitHub required checks are pending or cite the actual external blocker; GitHub check-runs are the source of truth.'
              : `**PR Readiness Gate** CI status mentions ${claim.label}, which is not a configured required PR check here — cite actual checks or state that CI is pending.`,
          );

        }
      }
    }

    if (heading === '## Model Used') {
      const lower = content.toLowerCase();
      if (MODEL_PLACEHOLDERS.some(p => lower.includes(p.toLowerCase()))) {
        failures.push(
          '**Model Used** contains placeholder text — please specify the actual model used (or "None — human-authored")'
        );
      }
    }
  }

  return { passed: failures.length === 0, failures };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const body = process.env.PR_BODY ?? '';
  const result = checkTemplate(body);
  console.log(JSON.stringify(result));
  process.exit(result.passed ? 0 : 1);
}
