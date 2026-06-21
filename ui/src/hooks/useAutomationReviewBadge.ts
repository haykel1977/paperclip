import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { dashboardApi } from "../api/dashboard";
import { computeAutomationReadiness } from "../lib/automation-readiness";
import { queryKeys } from "../lib/queryKeys";

export function useAutomationReviewBadge(companyId: string | null | undefined) {
  const { data: summary } = useQuery({
    queryKey: companyId ? queryKeys.dashboard(companyId) : ["dashboard", "automation-badge", "none"],
    queryFn: () => dashboardApi.summary(companyId!),
    enabled: !!companyId,
  });

  return useMemo(() => {
    if (!summary) {
      return { count: 0, needsReview: false };
    }

    const agentCount =
      summary.agents.active +
      summary.agents.running +
      summary.agents.paused +
      summary.agents.error;
    const readiness = computeAutomationReadiness({ summary, agentCount });

    return {
      count: readiness.totalHumanQueue,
      needsReview: readiness.totalHumanQueue > 0,
    };
  }, [summary]);
}
