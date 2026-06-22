import { useState, useEffect, useMemo } from "react";
import { Link, useNavigate, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi, type OrgNode } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
import { queryKeys } from "../lib/queryKeys";
import { AgentStatusBadge, AgentStatusCapsule } from "../components/StatusBadge";
import { AgentActionButtons } from "../components/AgentActionButtons";
import { MembershipAction } from "../components/MembershipAction";
import { EntityRow } from "../components/EntityRow";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { relativeTime, cn, agentRouteRef, agentUrl } from "../lib/utils";
import { agentRoleLabel, agentRoleMatches } from "../lib/agent-roles";
import { PageTabBar } from "../components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ClipboardList,
  Code2,
  GitBranch,
  GitPullRequestArrow,
  List,
  Plus,
  ShieldCheck,
  Sparkles,
  TestTube2,
} from "lucide-react";
import { type Agent, type AgentRole } from "@paperclipai/shared";
import {
  resourceMembershipState,
  useResourceMembershipMutation,
  useResourceMemberships,
} from "../hooks/useResourceMemberships";

import { getAdapterLabel } from "../adapters/adapter-display-registry";

type FilterTab = "all" | "active" | "paused" | "error";

// Terminated agents are hidden like archived companies. Agents waiting for
// approval remain visible on the All tab so new developer hires do not look lost.
const HIDDEN_AGENT_STATUSES = new Set(["terminated"]);

function matchesFilter(status: string, tab: FilterTab): boolean {
  if (tab === "all") return true;
  if (tab === "active") return status === "active" || status === "running" || status === "idle";
  if (tab === "paused") return status === "paused";
  if (tab === "error") return status === "error";
  return true;
}

function filterAgents(agents: Agent[], tab: FilterTab): Agent[] {
  return agents
    .filter((a) => !HIDDEN_AGENT_STATUSES.has(a.status) && matchesFilter(a.status, tab))
    .sort((a, b) => a.name.localeCompare(b.name));
}

type AcceleratorLane = {
  id: string;
  role: AgentRole;
  label: string;
  createName: string;
  createTitle: string;
  objective: string;
  output: string;
  promptLine: string;
  Icon: typeof Sparkles;
};

const ACCELERATOR_LANES: AcceleratorLane[] = [
  {
    id: "triage",
    role: "issue_triage",
    label: "Issue Triage",
    createName: "Issue Triage Agent",
    createTitle: "Issue intake and prioritization",
    objective: "Classer le bug, isoler le périmètre et identifier les fichiers suspects.",
    output: "Résumé, sévérité, hypothèses et questions bloquantes.",
    promptLine: "Commence par résumer l'issue, qualifier son impact et proposer le périmètre de recherche minimal.",
    Icon: ClipboardList,
  },
  {
    id: "planner",
    role: "planner",
    label: "Planner",
    createName: "Planning Agent",
    createTitle: "Implementation planner",
    objective: "Transformer l'issue en plan court, séquencé et vérifiable.",
    output: "Plan d'attaque, risques et ordre d'exécution.",
    promptLine: "Produit un plan en étapes courtes, sans refactor hors-scope, avec critères de validation.",
    Icon: GitBranch,
  },
  {
    id: "coder",
    role: "engineer",
    label: "Developer",
    createName: "Developer Agent",
    createTitle: "Focused implementation",
    objective: "Appliquer le patch le plus petit possible en respectant le style existant.",
    output: "Diff ciblé et notes d'implémentation.",
    promptLine: "Implémente uniquement le correctif demandé, de façon chirurgicale, sans changements opportunistes.",
    Icon: Code2,
  },
  {
    id: "reviewer",
    role: "code_reviewer",
    label: "Code Reviewer",
    createName: "Code Review Agent",
    createTitle: "Patch review and risk detection",
    objective: "Relire le patch, repérer les régressions et les problèmes de maintenabilité.",
    output: "Checklist de revue, risques et demandes de correction.",
    promptLine: "Relis le patch comme reviewer strict: bugs, sécurité, types, accessibilité et régressions potentielles.",
    Icon: GitPullRequestArrow,
  },
  {
    id: "tester",
    role: "qa",
    label: "QA Tester",
    createName: "QA Agent",
    createTitle: "Regression testing",
    objective: "Définir les vérifications et tests nécessaires pour fermer l'issue.",
    output: "Scénarios de test, cas limites et commande de validation interne.",
    promptLine: "Déduis les scénarios de test essentiels, les cas limites et les signaux attendus après correction.",
    Icon: TestTube2,
  },
  {
    id: "security",
    role: "security",
    label: "Security",
    createName: "Security Review Agent",
    createTitle: "Secure code review",
    objective: "Contrôler les risques OWASP, secrets, accès et validation des entrées.",
    output: "Points de sécurité à vérifier avant merge.",
    promptLine: "Vérifie que le correctif n'introduit pas de XSS, injection, fuite de secret ou contournement d'accès.",
    Icon: ShieldCheck,
  },
];

function agentMatchesLane(agent: Agent, lane: AcceleratorLane): boolean {
  return agentRoleMatches(agent.role, lane.role) && !HIDDEN_AGENT_STATUSES.has(agent.status);
}

function createAgentPresetHref(lane: AcceleratorLane): string {
  const params = new URLSearchParams({
    role: lane.role,
    name: lane.createName,
    title: lane.createTitle,
  });
  return `/agents/new?${params.toString()}`;
}

function getConfiguredModel(agent: Agent): string | null {
  const value = agent.adapterConfig?.model;
  if (typeof value !== "string") return null;
  const model = value.trim();

  return model.length > 0 ? model : null;
}

function filterOrgTree(nodes: OrgNode[], tab: FilterTab): OrgNode[] {
  return nodes
    .reduce<OrgNode[]>((acc, node) => {
      const filteredReports = filterOrgTree(node.reports, tab);
      // Hidden agents (terminated / pending_approval) never render as a row, but
      // any visible reports are promoted so the tree doesn't lose live agents.
      if (HIDDEN_AGENT_STATUSES.has(node.status)) {
        acc.push(...filteredReports);
        return acc;
      }
      if (matchesFilter(node.status, tab) || filteredReports.length > 0) {
        acc.push({ ...node, reports: filteredReports });
      }
      return acc;
    }, [])
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function Agents() {
  const { selectedCompanyId } = useCompany();
  const { openNewAgent } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const location = useLocation();
  const { isMobile } = useSidebar();
  const pathSegment = location.pathname.split("/").pop() ?? "all";
  const tab: FilterTab = (pathSegment === "all" || pathSegment === "active" || pathSegment === "paused" || pathSegment === "error") ? pathSegment : "all";
  const [view, setView] = useState<"list" | "org">("org");
  const forceListView = isMobile;
  const effectiveView: "list" | "org" = forceListView ? "list" : view;

  const { data: agents, isLoading, error } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: orgTree } = useQuery({
    queryKey: queryKeys.org(selectedCompanyId!),
    queryFn: () => agentsApi.org(selectedCompanyId!),
    enabled: !!selectedCompanyId && effectiveView === "org",
  });

  const { data: runs } = useQuery({
    queryKey: [...queryKeys.liveRuns(selectedCompanyId!), "agents-page"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });
  const membershipsQuery = useResourceMemberships(selectedCompanyId);
  const membershipMutation = useResourceMembershipMutation(selectedCompanyId);

  // Map agentId -> first live run + live run count
  const liveRunByAgent = useMemo(() => {
    const map = new Map<string, { runId: string; liveCount: number }>();
    for (const r of runs ?? []) {
      if (r.status !== "running" && r.status !== "queued") continue;
      const existing = map.get(r.agentId);
      if (existing) {
        existing.liveCount += 1;
        continue;
      }
      map.set(r.agentId, { runId: r.id, liveCount: 1 });
    }
    return map;
  }, [runs]);

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Agents" }]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Bot} message="Select a company to view agents." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const filtered = filterAgents(agents ?? [], tab);
  const filteredOrg = filterOrgTree(orgTree ?? [], tab);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={tab} onValueChange={(v) => navigate(`/agents/${v}`)}>
          <PageTabBar
            items={[
              { value: "all", label: "All" },
              { value: "active", label: "Active" },
              { value: "paused", label: "Paused" },
              { value: "error", label: "Error" },
            ]}
            value={tab}
            onValueChange={(v) => navigate(`/agents/${v}`)}
          />
        </Tabs>
        <div className="flex items-center gap-2">
          {/* View toggle */}
          {!forceListView && (
            <div className="flex items-center border border-border">
              <button
                className={cn(
                  "p-1.5 transition-colors",
                  effectiveView === "list" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
                )}
                onClick={() => setView("list")}
              >
                <List className="h-3.5 w-3.5" />
              </button>
              <button
                className={cn(
                  "p-1.5 transition-colors",
                  effectiveView === "org" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
                )}
                onClick={() => setView("org")}
              >
                <GitBranch className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <Button size="sm" variant="outline" onClick={openNewAgent}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            New Agent
          </Button>
        </div>
      </div>

      <IssueAccelerationSquad agents={agents ?? []} />

      {filtered.length > 0 && (
        <p className="text-xs text-muted-foreground">{filtered.length} agent{filtered.length !== 1 ? "s" : ""}</p>
      )}

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {agents && agents.length === 0 && (
        <EmptyState
          icon={Bot}
          message="Create your first agent to get started."
          action="New Agent"
          onAction={openNewAgent}
        />
      )}

      {/* List view */}
      {effectiveView === "list" && filtered.length > 0 && (
        <div className="border border-border">
          {filtered.map((agent) => {
            const hasInvalidOrgChain = agent.orgChainHealth?.status === "invalid_org_chain";
            return (
              <EntityRow
                key={agent.id}
                title={agent.name}
                // Fixed (truncating) title width so the `meta` group starts at a
                // constant x on every row — that's what makes the model + timestamp
                // columns line up vertically (PAP-86). Agent names vary in width, so
                // a content-sized title (`min-w-[7rem]`) shifted meta's start per row.
                titleClassName="w-56"
                subtitle={`${agentRoleLabel(agent.role)}${agent.title ? ` - ${agent.title}` : ""}`}
                to={agentUrl(agent)}
                className={cn(
                  "group",
                  agent.pausedAt && tab !== "paused" ? "opacity-50" : "",
                  resourceMembershipState(membershipsQuery.data, "agent", agent.id) === "left" ? "text-foreground/55" : "",
                )}
                leading={hasInvalidOrgChain ? (
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-500" aria-label="Invalid reporting chain" />
                ) : (
                  <AgentStatusCapsule status={agent.status} />
                )}
                meta={
                  <div className="hidden xl:flex items-center gap-3">
                    <AgentMetaColumns agent={agent} />
                  </div>
                }
                trailing={
                  <div className="flex items-center gap-3">
                    <span className="sm:hidden">
                      {liveRunByAgent.has(agent.id) ? (
                        <LiveRunIndicator
                          agentRef={agentRouteRef(agent)}
                          runId={liveRunByAgent.get(agent.id)!.runId}
                          liveCount={liveRunByAgent.get(agent.id)!.liveCount}
                        />
                      ) : (
                        <AgentStatusBadge status={agent.status} />
                      )}
                    </span>
                    <div className="hidden sm:flex items-center gap-3">
                      {liveRunByAgent.has(agent.id) && (
                        <LiveRunIndicator
                          agentRef={agentRouteRef(agent)}
                          runId={liveRunByAgent.get(agent.id)!.runId}
                          liveCount={liveRunByAgent.get(agent.id)!.liveCount}
                        />
                      )}
                      <span className="w-20 flex justify-end">
                        <AgentStatusBadge status={agent.status} />
                      </span>
                    </div>
                    {/* Row actions mirror the agent detail page; stop the click
                        from bubbling to the row link so buttons don't navigate. */}
                    <div
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                    >
                      <AgentActionButtons
                        agent={agent}
                        companyId={selectedCompanyId}
                        runLabel="Run Heartbeat"
                        showStatus={false}
                      />
                    </div>
                    <MembershipAction
                      state={resourceMembershipState(membershipsQuery.data, "agent", agent.id)}
                      pending={
                        membershipMutation.isPending &&
                        membershipMutation.variables?.resourceType === "agent" &&
                        membershipMutation.variables.resourceId === agent.id
                      }
                      pendingState={
                        membershipMutation.isPending &&
                        membershipMutation.variables?.resourceType === "agent" &&
                        membershipMutation.variables.resourceId === agent.id
                          ? membershipMutation.variables.state
                          : null
                      }
                      resourceName={agent.name}
                      onJoin={() => membershipMutation.mutate({
                        resourceType: "agent",
                        resourceId: agent.id,
                        resourceName: agent.name,
                        state: "joined",
                      })}
                      onLeave={() => membershipMutation.mutate({
                        resourceType: "agent",
                        resourceId: agent.id,
                        resourceName: agent.name,
                        state: "left",
                      })}
                    />
                  </div>
                }
              />
            );
          })}
        </div>
      )}

      {effectiveView === "list" && agents && agents.length > 0 && filtered.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No agents match the selected filter.
        </p>
      )}

      {/* Org chart view */}
      {effectiveView === "org" && filteredOrg.length > 0 && (
        <div className="border border-border py-1">
          {filteredOrg.map((node) => (
            <OrgTreeNode
              key={node.id}
              node={node}
              depth={0}
              agentMap={agentMap}
              liveRunByAgent={liveRunByAgent}
              tab={tab}
              memberships={membershipsQuery.data}
              membershipMutation={membershipMutation}
            />
          ))}
        </div>
      )}

      {effectiveView === "org" && orgTree && orgTree.length > 0 && filteredOrg.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No agents match the selected filter.
        </p>
      )}

      {effectiveView === "org" && orgTree && orgTree.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No organizational hierarchy defined.
        </p>
      )}
    </div>
  );
}

function IssueAccelerationSquad({ agents }: { agents: Agent[] }) {
  const [selectedLaneIds, setSelectedLaneIds] = useState<string[]>([
    "triage",
    "planner",
    "coder",
    "reviewer",
    "tester",
  ]);
  const [issueDraft, setIssueDraft] = useState("");
  const [generatedIssue, setGeneratedIssue] = useState<string | null>(null);

  const selectedLanes = useMemo(
    () => ACCELERATOR_LANES.filter((lane) => selectedLaneIds.includes(lane.id)),
    [selectedLaneIds],
  );

  const handoffPrompt = useMemo(() => {
    if (!generatedIssue) return null;
    const roleInstructions = selectedLanes
      .map((lane, index) => `${index + 1}. ${lane.label}: ${lane.promptLine}`)
      .join("\n");
    return [
      "Use only configured sovereign agent models for this workflow.",
      "Issue to resolve:",
      generatedIssue,
      "",
      "Multi-agent handoff:",
      roleInstructions,
      "",
      "Keep the patch focused, explain verification, and stop if a system boundary requires more information.",
    ].join("\n");
  }, [generatedIssue, selectedLanes]);

  const toggleLane = (laneId: string) => {
    setSelectedLaneIds((current) => {
      if (current.includes(laneId)) {
        return current.filter((id) => id !== laneId);
      }
      return [...current, laneId];
    });
  };

  const generatePlan = () => {
    const trimmed = issueDraft.trim();
    if (!trimmed || selectedLanes.length === 0) return;
    setGeneratedIssue(trimmed);
  };

  const resetPlan = () => {
    setIssueDraft("");
    setGeneratedIssue(null);
  };

  return (
    <section className="border border-border bg-card/40">
      <div className="border-b border-border px-4 py-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold">Issue acceleration squad</h2>
            </div>
            <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
              Compose une équipe d'agents spécialisés pour analyser, coder, reviewer et tester les corrections d'issues plus vite.
            </p>
          </div>
          <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border px-2 py-1 text-[11px] text-muted-foreground">
            <CheckCircle2 className="h-3 w-3 text-emerald-500" />
            Sovereign models only
          </span>
        </div>
      </div>

      <div className="space-y-4 p-4">
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {ACCELERATOR_LANES.map((lane) => {
            const enabled = selectedLaneIds.includes(lane.id);
            const matches = agents.filter((agent) => agentMatchesLane(agent, lane));
            const Icon = lane.Icon;
            return (
              <div
                key={lane.id}
                className={cn(
                  "flex h-full flex-col gap-2 border p-3 text-left transition-colors",
                  enabled
                    ? "border-primary/50 bg-primary/5"
                    : "border-border bg-background hover:bg-accent/30",
                )}
              >
                <button
                  type="button"
                  className="flex flex-1 flex-col gap-2 text-left"
                  onClick={() => toggleLane(lane.id)}
                  aria-pressed={enabled}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate text-sm font-medium">{lane.label}</span>
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {matches.length > 0
                        ? matches.some((agent) => agent.status !== "pending_approval")
                          ? `${matches.length} ready`
                          : "pending approval"
                        : "missing"}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground">{lane.objective}</span>
                </button>
                {matches.length === 0 ? (
                  <Link
                    to={createAgentPresetHref(lane)}
                    className="mt-auto text-xs font-medium text-primary hover:underline"
                  >
                    Create {lane.label.toLowerCase()} agent
                  </Link>
                ) : (
                  <span className="mt-auto truncate text-[11px] text-muted-foreground">
                    {matches[0].status === "pending_approval" ? "Awaiting approval" : "Lead"}: {matches[0].name}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="space-y-2">
            <label htmlFor="issue-acceleration-draft" className="text-xs font-medium">

              Issue or bug to accelerate
            </label>
            <Textarea
              id="issue-acceleration-draft"
              value={issueDraft}
              onChange={(event) => setIssueDraft(event.target.value)}
              placeholder="Paste the issue summary, failing behavior, logs, or acceptance criteria..."
              className="min-h-28 resize-y"
            />
          </div>
          <div className="flex flex-col justify-between gap-3 border border-border bg-background p-3">
            <div>
              <p className="text-xs font-medium">Selected workflow</p>
              <ol className="mt-2 space-y-1 text-xs text-muted-foreground">
                {selectedLanes.length > 0 ? selectedLanes.map((lane) => (
                  <li key={lane.id}>{lane.label} · {lane.output}</li>
                )) : (
                  <li>Select at least one agent role.</li>
                )}
              </ol>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                className="flex-1"
                disabled={!issueDraft.trim() || selectedLanes.length === 0}
                onClick={generatePlan}
              >
                Generate plan
              </Button>
              <Button size="sm" variant="outline" onClick={resetPlan}>
                Clear
              </Button>
            </div>
          </div>
        </div>

        {generatedIssue && handoffPrompt ? (
          <div className="grid gap-3 border border-border bg-background p-3 lg:grid-cols-[18rem_minmax(0,1fr)]">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Structured plan</p>
              <ol className="mt-3 space-y-2 text-sm">
                {selectedLanes.map((lane, index) => {
                  const matches = agents.filter((agent) => agentMatchesLane(agent, lane));
                  return (
                    <li key={lane.id} className="flex gap-2">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
                        {index + 1}
                      </span>
                      <span>
                        <span className="font-medium">{lane.label}</span>
                        <span className="block text-xs text-muted-foreground">
                          {matches[0]?.name ?? "Create a matching agent first"} · {lane.output}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Draft handoff prompt</p>
              <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap border border-border bg-muted/30 p-3 text-xs leading-relaxed text-foreground">
                {handoffPrompt}
              </pre>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function OrgTreeNode({
  node,
  depth,
  agentMap,
  liveRunByAgent,
  tab,
  memberships,
  membershipMutation,
}: {
  node: OrgNode;
  depth: number;
  agentMap: Map<string, Agent>;
  liveRunByAgent: Map<string, { runId: string; liveCount: number }>;
  tab: FilterTab;
  memberships: ReturnType<typeof useResourceMemberships>["data"];
  membershipMutation: ReturnType<typeof useResourceMembershipMutation>;

}) {
  const agent = agentMap.get(node.id);
  const hasInvalidOrgChain = Boolean(agent && agent.orgChainHealth?.status === "invalid_org_chain");
  const membershipState = resourceMembershipState(memberships, "agent", node.id);
  const pending = membershipMutation.isPending &&
    membershipMutation.variables?.resourceType === "agent" &&
    membershipMutation.variables.resourceId === node.id;

  return (
    <div style={{ paddingLeft: depth * 24 }}>
      <Link
        to={agent ? agentUrl(agent) : `/agents/${node.id}`}
        className={cn(
          "group flex items-center gap-3 px-3 py-2 hover:bg-accent/30 transition-colors w-full text-left no-underline text-inherit",
          agent?.pausedAt && tab !== "paused" && "opacity-50",
          membershipState === "left" && "text-foreground/55",
        )}
      >
        {hasInvalidOrgChain ? (
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-label="Invalid reporting chain" />
        ) : (
          <AgentStatusCapsule status={node.status} />
        )}
        <div className="flex-1 min-w-[7rem]">
          <span className="text-sm font-medium">{node.name}</span>
          <span className="text-xs text-muted-foreground ml-2">
            {agentRoleLabel(node.role)}
            {agent?.title ? ` - ${agent.title}` : ""}
          </span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="sm:hidden">
            {liveRunByAgent.has(node.id) ? (
              <LiveRunIndicator
                agentRef={agent ? agentRouteRef(agent) : node.id}
                runId={liveRunByAgent.get(node.id)!.runId}
                liveCount={liveRunByAgent.get(node.id)!.liveCount}
              />
            ) : (
              <AgentStatusBadge status={node.status} />
            )}
          </span>
          <div className="hidden sm:flex items-center gap-3">
            {liveRunByAgent.has(node.id) && (
              <LiveRunIndicator
                agentRef={agent ? agentRouteRef(agent) : node.id}
                runId={liveRunByAgent.get(node.id)!.runId}
                liveCount={liveRunByAgent.get(node.id)!.liveCount}
              />
            )}
            {agent && (
              <div className="hidden xl:flex items-center gap-3">
                <AgentMetaColumns agent={agent} />
              </div>
            )}
            <span className="w-20 flex justify-end">
              <AgentStatusBadge status={node.status} />
            </span>
          </div>
          <MembershipAction
            state={membershipState}
            pending={pending}
            pendingState={pending ? membershipMutation.variables?.state : null}
            resourceName={node.name}
            onJoin={() => membershipMutation.mutate({
              resourceType: "agent",
              resourceId: node.id,
              resourceName: node.name,
              state: "joined",
            })}
            onLeave={() => membershipMutation.mutate({
              resourceType: "agent",
              resourceId: node.id,
              resourceName: node.name,
              state: "left",
            })}
          />
        </div>
      </Link>
      {node.reports && node.reports.length > 0 && (
        <div className="border-l border-border/50 ml-4">
          {node.reports.map((child) => (
            <OrgTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              agentMap={agentMap}
              liveRunByAgent={liveRunByAgent}
              tab={tab}
              memberships={memberships}
              membershipMutation={membershipMutation}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Provider/model + heartbeat columns shared by the list and org views. The
 * model and adapter label share one fixed-width cell, each line truncating with
 * an ellipsis so a long model id can never overlap the heartbeat column. The
 * heartbeat is single-line (`whitespace-nowrap`) and wide enough for a full
 * date like "Apr 30, 2026".
 */
function AgentMetaColumns({ agent }: { agent: Agent }) {
  const model = getConfiguredModel(agent);
  const adapterLabel = getAdapterLabel(agent.adapterType);
  return (
    <>
      <div className="w-44 min-w-0 leading-tight">
        <div
          className="truncate font-mono text-xs text-muted-foreground"
          title={model ?? undefined}
        >
          {model ?? "—"}
        </div>
        <div className="truncate font-mono text-[11px] text-muted-foreground/70" title={adapterLabel}>
          {adapterLabel}
        </div>
      </div>
      <span className="w-24 whitespace-nowrap text-right text-xs text-muted-foreground">
        {agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt) : "—"}
      </span>
    </>
  );
}

function LiveRunIndicator({
  agentRef,
  runId,
  liveCount,
}: {
  agentRef: string;
  runId: string;
  liveCount: number;
}) {
  return (
    <Link
      to={`/agents/${agentRef}/runs/${runId}`}
      className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-blue-500/10 hover:bg-blue-500/20 transition-colors no-underline"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="relative flex h-2 w-2">
        <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
      </span>
      <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400">
        Live{liveCount > 1 ? ` (${liveCount})` : ""}
      </span>
    </Link>
  );
}
