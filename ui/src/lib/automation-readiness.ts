export type AutomationCheckState = "ready" | "attention" | "setup";

export type AutopilotInterventionKind =
  | "approval_decisions"
  | "budget_incidents"
  | "blocked_tasks"
  | "agent_errors"
  | "agent_setup";

export interface AutomationReadinessSummary {
  agents?: {
    running?: number;
    paused?: number;
    error?: number;
  };
  tasks?: {
    open?: number;
    inProgress?: number;
    blocked?: number;
  };
  pendingApprovals?: number;
  budgets?: {
    pendingApprovals?: number;
    activeIncidents?: number;
  };
}

export interface AutomationCheck {
  title: string;
  description: string;
  state: AutomationCheckState;
  href: string;
  action: string;
}

export interface AutopilotInterventionItem {
  kind: AutopilotInterventionKind;
  label: string;
  count: number;
  href: string;
}

export interface AutomationReadiness {
  checks: AutomationCheck[];
  score: number;
  mode: "Setup required" | "Autopilot with visible human review" | "Autopilot operational";
  agentCount: number;
  runningAgents: number;
  liveRunCount: number;
  openTaskCount: number;
  blockedTaskCount: number;
  totalHumanQueue: number;
  interventionItems: AutopilotInterventionItem[];
}

export function computeAutomationReadiness(input: {
  summary?: AutomationReadinessSummary | null;
  agentCount?: number;
  pendingApprovalCount?: number;
  liveRunCount?: number;
}): AutomationReadiness {
  const summary = input.summary;
  const agentCount = input.agentCount ?? 0;
  const runningAgents = summary?.agents?.running ?? 0;
  const erroredAgents = summary?.agents?.error ?? 0;
  const pausedAgents = summary?.agents?.paused ?? 0;
  const liveRunCount = input.liveRunCount ?? 0;
  const openTaskCount = (summary?.tasks?.open ?? 0) + (summary?.tasks?.inProgress ?? 0);
  const blockedTaskCount = summary?.tasks?.blocked ?? 0;
  const pendingApprovalCount = input.pendingApprovalCount ?? summary?.pendingApprovals ?? 0;
  const budgetApprovalCount = summary?.budgets?.pendingApprovals ?? 0;
  const activeBudgetIncidents = summary?.budgets?.activeIncidents ?? 0;
  const setupRequiredCount = agentCount === 0 ? 1 : 0;
  const totalHumanQueue =
    pendingApprovalCount +
    budgetApprovalCount +
    activeBudgetIncidents +
    erroredAgents +
    blockedTaskCount +
    setupRequiredCount;

  const checks: AutomationCheck[] = [
    {
      title: "Agent workforce",
      description:
        agentCount > 0
          ? `${agentCount} agent${agentCount === 1 ? "" : "s"} available · ${runningAgents} running · ${pausedAgents} paused · ${erroredAgents} error${erroredAgents === 1 ? "" : "s"}`
          : "Create at least one agent so tasks can be executed automatically.",
      state: agentCount === 0 ? "setup" : erroredAgents > 0 ? "attention" : "ready",
      href: agentCount === 0 ? "/agents/new" : "/agents/all",
      action: agentCount === 0 ? "Create agent" : "Manage agents",
    },
    {
      title: "Autonomous execution",
      description:
        liveRunCount > 0
          ? `${liveRunCount} live run${liveRunCount === 1 ? "" : "s"} executing now.`
          : openTaskCount > 0
            ? `${openTaskCount} open task${openTaskCount === 1 ? "" : "s"} ready for agent pickup.`
            : "No open task is waiting; the system is idle and ready.",
      state: agentCount === 0 ? "setup" : "ready",
      href: liveRunCount > 0 ? "/dashboard/live" : "/issues",
      action: liveRunCount > 0 ? "Watch live runs" : "Open tasks",
    },
    {
      title: "Automatic validation gates",
      description: "CI policy checks, route authorization guards, tests, budget controls, and approval gates are surfaced before risky work proceeds.",
      state: "ready",
      href: "/activity",
      action: "Audit activity",
    },
    {
      title: "Human intervention queue",
      description:
        totalHumanQueue === 0
          ? "No hidden human work: approvals, budget incidents, blocked tasks, and agent errors are clear."
          : `${totalHumanQueue} item${totalHumanQueue === 1 ? "" : "s"} require visible human attention before full autonomy.`,
      state: totalHumanQueue === 0 ? "ready" : "attention",
      href: totalHumanQueue === 0 ? "/activity" : "/approvals",
      action: totalHumanQueue === 0 ? "View audit trail" : "Review queue",
    },
  ];

  const interventionItems: AutopilotInterventionItem[] = [
    {
      kind: "approval_decisions",
      label: "Approval decisions",
      count: pendingApprovalCount,
      href: "/approvals",
    },
    {
      kind: "budget_incidents",
      label: "Budget incidents",
      count: budgetApprovalCount + activeBudgetIncidents,
      href: "/costs",
    },
    {
      kind: "blocked_tasks",
      label: "Blocked tasks",
      count: blockedTaskCount,
      href: "/issues",
    },
    {
      kind: "agent_errors",
      label: "Agent errors",
      count: erroredAgents,
      href: "/agents/error",
    },
    {
      kind: "agent_setup",
      label: "Agent setup",
      count: setupRequiredCount,
      href: "/agents/new",
    },
  ].filter((item) => item.count > 0);

  const readyChecks = checks.filter((check) => check.state === "ready").length;
  const score = Math.round((readyChecks / checks.length) * 100);
  const mode = agentCount === 0
    ? "Setup required"
    : totalHumanQueue > 0
      ? "Autopilot with visible human review"
      : "Autopilot operational";

  return {
    checks,
    score,
    mode,
    agentCount,
    runningAgents,
    liveRunCount,
    openTaskCount,
    blockedTaskCount,
    totalHumanQueue,
    interventionItems,
  };
}
