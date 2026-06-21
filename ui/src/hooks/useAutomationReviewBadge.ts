import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { approvalsApi } from "../api/approvals";
import { dashboardApi } from "../api/dashboard";
import { computeAutomationReadiness } from "../lib/automation-readiness";
import { queryKeys } from "../lib/queryKeys";

export function useAutomationReviewBadge(companyId: string | null | undefined) {
  const { data: summary } = useQuery({
    queryKey: companyId ? queryKeys.dashboard(companyId) : ["dashboard", "automation-badge", "none"],
    queryFn: () => dashboardApi.summary(companyId!),
    enabled: !!companyId,
  });

  const { data: agents } = useQuery({
    queryKey: companyId ? queryKeys.agents.list(companyId) : ["agents", "automation-badge", "none"],
    queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId,
  });

  const { data: pendingApprovals } = useQuery({
    queryKey: companyId ? queryKeys.approvals.list(companyId, "pending") : ["approvals", "automation-badge", "none"],
    queryFn: () => approvalsApi.list(companyId!, "pending"),
    enabled: !!companyId,
  });

  return useMemo(() => {
    if (!summary || !agents || !pendingApprovals) {
      return { count: 0, needsReview: false };
    }

    const readiness = computeAutomationReadiness({
      summary,
      agentCount: agents.length,
      pendingApprovalCount: pendingApprovals.length,
    });

    return {
      count: readiness.totalHumanQueue,
      needsReview: readiness.totalHumanQueue > 0,
    };
  }, [agents, pendingApprovals, summary]);
}
