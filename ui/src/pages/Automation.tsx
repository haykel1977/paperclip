import { useEffect, useMemo } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  CircleDot,
  ClipboardCheck,
  DollarSign,
  History,
  PlayCircle,
  ShieldCheck,
  Sparkles,
  UserCheck,
  Zap,
} from "lucide-react";
import { agentsApi } from "../api/agents";
import { approvalsApi } from "../api/approvals";
import { dashboardApi } from "../api/dashboard";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import {
  computeAutomationReadiness,
  type AutomationCheckState,

  type AutopilotInterventionKind,
} from "../lib/automation-readiness";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";

const interventionIconByKind: Record<AutopilotInterventionKind, typeof Bot> = {
  approval_decisions: UserCheck,
  budget_incidents: DollarSign,
  blocked_tasks: CircleDot,
  agent_errors: AlertTriangle,
  agent_setup: Bot,
};

function stateLabel(state: AutomationCheckState) {
  if (state === "ready") return "Operational";
  if (state === "attention") return "Human attention";
  return "Setup required";
}

function stateClassName(state: AutomationCheckState) {
  if (state === "ready") return "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (state === "attention") return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return "border-border bg-muted text-muted-foreground";
}

export function Automation() {
  const { selectedCompanyId, companies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Automation" }]);
  }, [setBreadcrumbs]);

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.dashboard(selectedCompanyId) : ["dashboard", "automation", "none"],
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: blockedTriageSummary, isLoading: blockedSummaryLoading } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.issues.blockedTriageSummary(selectedCompanyId)
      : ["issues", "automation", "blocked-summary", "none"],
    queryFn: () => issuesApi.blockedTriageSummary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents, isLoading: agentsLoading } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.agents.list(selectedCompanyId) : ["agents", "automation", "none"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: pendingApprovals, isLoading: approvalsLoading } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.approvals.list(selectedCompanyId, "pending") : ["approvals", "automation", "none"],
    queryFn: () => approvalsApi.list(selectedCompanyId!, "pending"),
    enabled: !!selectedCompanyId,
  });

  const { data: liveRuns, isLoading: liveRunsLoading } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.liveRuns(selectedCompanyId) : ["live-runs", "automation", "none"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!, { limit: 25 }),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });

  const loading = summaryLoading || blockedSummaryLoading || agentsLoading || approvalsLoading || liveRunsLoading;

  const automation = useMemo(() => computeAutomationReadiness({
    summary,
    agentCount: agents?.length ?? 0,
    pendingApprovalCount: pendingApprovals?.length,
    liveRunCount: liveRuns?.length ?? 0,
    blockedOperatorAttentionCount: blockedTriageSummary?.operatorAttentionCount,
  }), [
    agents?.length,
    blockedTriageSummary?.operatorAttentionCount,
    liveRuns?.length,
    pendingApprovals?.length,
    summary,
  ]);

  if (!selectedCompanyId) {
    return companies.length === 0 ? (
      <EmptyState icon={Bot} message="Create a company and first agent before enabling autonomous operations." />
    ) : (
      <EmptyState icon={Bot} message="Select a company to view autonomous operations." />
    );
  }

  if (loading || !automation) {
    return <PageSkeleton variant="dashboard" />;
  }

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="border-b border-border bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.16),transparent_34%),linear-gradient(135deg,rgba(59,130,246,0.12),transparent_42%)] p-5 sm:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-3xl space-y-3">
              <Badge variant="outline" className="gap-1.5 bg-background/70">
                <Sparkles className="h-3 w-3" />
                Autonomous operations
              </Badge>
              <div>
                <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Automation control center</h1>
                <p className="mt-2 text-sm text-muted-foreground sm:text-base">
                  Everything needed for agent-led execution is grouped here: workforce readiness, live runs, automatic validation, and transparent human review when it is genuinely required.
                </p>
              </div>
            </div>
            <div className="rounded-xl border border-border bg-background/80 p-4 shadow-sm lg:min-w-72">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Readiness</p>
              <div className="mt-2 flex items-end gap-2">
                <span className="text-4xl font-semibold tabular-nums">{automation.score}%</span>
                <span className="pb-1 text-sm text-muted-foreground">operational</span>
              </div>
              <p className="mt-2 text-sm font-medium">{automation.mode}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Human work is never hidden; it is shown as approvals, blockers, budget incidents, or agent errors.
              </p>
            </div>
          </div>
        </div>

        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard icon={Bot} label="Agents" value={automation.agentCount} detail={`${automation.runningAgents} running`} />
          <StatCard icon={PlayCircle} label="Live runs" value={automation.liveRunCount} detail="Refreshed every 10s" />
          <StatCard icon={CircleDot} label="Open tasks" value={automation.openTaskCount} detail={`${automation.blockedTaskCount} blocked`} />
          <StatCard icon={UserCheck} label="Human queue" value={automation.totalHumanQueue} detail="Visible review only" />
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2">
            <span className={cn(
              "rounded-lg p-2",
              automation.interventionItems.length === 0
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
                : "bg-amber-500/10 text-amber-600 dark:text-amber-300",
            )}>
              {automation.interventionItems.length === 0 ? <CheckCircle2 className="h-4 w-4" /> : <UserCheck className="h-4 w-4" />}
            </span>
            <div>
              <h2 className="font-semibold">Human review queue</h2>
              <p className="text-xs text-muted-foreground">Visible, explicit, and actionable.</p>
            </div>
          </div>

          {automation.interventionItems.length === 0 ? (
            <p className="mt-4 rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">
              No human intervention is pending. Autopilot can continue without hidden manual work.
            </p>
          ) : (
            <div className="mt-4 grid gap-2">
              {automation.interventionItems.map((item) => {
                const Icon = interventionIconByKind[item.kind];
                return (
                  <Link
                    key={item.label}
                    to={item.href}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background p-3 text-inherit no-underline transition-colors hover:border-primary/40 hover:bg-accent/30"
                  >
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <Icon className="h-4 w-4 text-muted-foreground" />
                      {item.label}
                    </span>
                    <Badge variant="outline">{item.count}</Badge>
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2">
            <span className="rounded-lg bg-primary/10 p-2 text-primary">
              <ClipboardCheck className="h-4 w-4" />
            </span>
            <div>
              <h2 className="font-semibold">Operational pipeline</h2>
              <p className="text-xs text-muted-foreground">The standard path from request to validated delivery.</p>
            </div>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <PipelineStep title="1. Assign" body="Tasks enter the queue and are picked up by configured agents." />
            <PipelineStep title="2. Execute" body="Live runs show active autonomous work and output progress." />
            <PipelineStep title="3. Validate" body="Tests, policy checks, budgets, and permissions gate risky changes." />
            <PipelineStep title="4. Escalate only if needed" body="Humans are asked only for approvals, blockers, incidents, or agent errors." />
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        {automation.checks.map((check) => (
          <Link
            key={check.title}
            to={check.href}
            className="group rounded-xl border border-border bg-card p-4 text-inherit no-underline transition-colors hover:border-primary/40 hover:bg-accent/30"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <span className={cn("mt-0.5 rounded-full border p-2", stateClassName(check.state))}>
                  {check.state === "ready" ? (
                    <CheckCircle2 className="h-4 w-4" />
                  ) : check.state === "attention" ? (
                    <AlertTriangle className="h-4 w-4" />
                  ) : (
                    <Zap className="h-4 w-4" />
                  )}
                </span>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-semibold">{check.title}</h2>
                    <Badge variant="outline" className={stateClassName(check.state)}>{stateLabel(check.state)}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{check.description}</p>
                </div>
              </div>
              <span className="shrink-0 text-xs font-medium text-primary opacity-80 group-hover:opacity-100">{check.action}</span>
            </div>
          </Link>
        ))}
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <OperationalPillar
          icon={Bot}
          title="Agents write and execute"
          body="Agents are the default execution path for tasks. Live runs and task state show whether work is currently moving without a human operator."
          href="/agents/all"
          action="Open agents"
        />
        <OperationalPillar
          icon={ShieldCheck}
          title="Automation is guarded"
          body="Policy checks, permissions, budgets, and approvals keep autonomy safe instead of pretending risky work is invisible."
          href="/approvals"
          action="Open approvals"
        />
        <OperationalPillar
          icon={History}
          title="Humans stay explicit"
          body="When a person is required, the UI says so through the human queue and audit trail. Nothing is presented as automatic when it is not."
          href="/activity"
          action="Open activity"
        />
      </section>

      <section className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-semibold">Fast path to 100% operational</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Clear the visible human queue, keep at least one healthy agent enabled, and let validation gates run before delivery.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm"><Link to="/agents/new">Add agent</Link></Button>
            <Button asChild variant="outline" size="sm"><Link to="/issues">Open tasks</Link></Button>
            <Button asChild size="sm"><Link to="/dashboard/live">Watch live</Link></Button>
          </div>
        </div>
      </section>
    </div>
  );
}

function PipelineStep({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{body}</p>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, detail }: {
  icon: typeof Bot;
  label: string;
  value: number;
  detail: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-background p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function OperationalPillar({ icon: Icon, title, body, href, action }: {
  icon: typeof Bot;
  title: string;
  body: string;
  href: string;
  action: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <span className="rounded-lg bg-primary/10 p-2 text-primary">
          <Icon className="h-4 w-4" />
        </span>
        <h2 className="font-semibold">{title}</h2>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">{body}</p>
      <Link to={href} className="mt-3 inline-flex text-sm font-medium text-primary underline-offset-4 hover:underline">
        {action}
      </Link>
    </div>
  );
}
