import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, issues } from "@paperclipai/db";
import {
  readIssueStatusUpdate,
  statusToRestoreAfterUndeliveredRun,
} from "@paperclipai/adapter-utils/delivery-guard";
import { logActivity } from "./activity-log.js";
import { issueService } from "./issues.js";

/**
 * Puts an issue back to the status it had before this run moved it to
 * `done` or `in_review`. A not_delivered run must not close or hand off work.
 */
export async function revertUndeliveredIssueDisposition(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    runId: string;
    agentId: string;
    reason: string;
  },
): Promise<string | null> {
  const issue = await db
    .select({ id: issues.id, status: issues.status, identifier: issues.identifier })
    .from(issues)
    .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
    .then((rows) => rows[0] ?? null);
  if (!issue) return null;

  const rows = await db
    .select({ details: activityLog.details })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, input.companyId),
      eq(activityLog.runId, input.runId),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, input.issueId),
      eq(activityLog.action, "issue.updated"),
    ))
    .orderBy(asc(activityLog.createdAt));

  const updates = rows.flatMap((row) => {
    const update = readIssueStatusUpdate(row.details);
    return update ? [update] : [];
  });
  const restoreStatus = statusToRestoreAfterUndeliveredRun(issue.status, updates);
  if (!restoreStatus) return null;

  const issuesSvc = issueService(db);
  const updated = await issuesSvc.update(issue.id, { status: restoreStatus });
  if (!updated || updated.status !== restoreStatus) return null;

  await logActivity(db, {
    companyId: input.companyId,
    actorType: "system",
    actorId: "heartbeat",
    agentId: input.agentId,
    runId: input.runId,
    action: "issue.updated",
    entityType: "issue",
    entityId: issue.id,
    details: {
      identifier: issue.identifier,
      status: restoreStatus,
      source: "delivery_guard",
      errorCode: "not_delivered",
      reason: input.reason,
      _previous: { status: issue.status },
    },
  });

  await issuesSvc.addComment(
    issue.id,
    [
      "Harness rejected this run's disposition because delivery was not proven.",
      "",
      `\`not_delivered\` reason=\`${input.reason}\`.`,
      `Status restored to \`${restoreStatus}\`.`,
    ].join("\n"),
    { runId: input.runId },
    { authorType: "system" },
  );

  return restoreStatus;
}
