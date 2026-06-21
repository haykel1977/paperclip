// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardSummary } from "@paperclipai/shared";
import { useAutomationReviewBadge } from "./useAutomationReviewBadge";

const { dashboardSummaryMock } = vi.hoisted(() => ({
  dashboardSummaryMock: vi.fn(),
}));

vi.mock("../api/dashboard", () => ({
  dashboardApi: { summary: dashboardSummaryMock },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeSummary(overrides: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    companyId: "company-1",
    agents: {
      active: 0,
      running: 0,
      paused: 0,
      error: 0,
      ...overrides.agents,
    },
    tasks: {
      open: 0,
      inProgress: 0,
      blocked: 0,
      done: 0,
      ...overrides.tasks,
    },
    costs: {
      monthSpendCents: 0,
      monthBudgetCents: 0,
      monthUtilizationPercent: 0,
      ...overrides.costs,
    },
    pendingApprovals: overrides.pendingApprovals ?? 0,
    budgets: {
      activeIncidents: 0,
      pendingApprovals: 0,
      pausedAgents: 0,
      pausedProjects: 0,
      ...overrides.budgets,
    },
    runActivity: overrides.runActivity ?? [],
  };
}

function Harness({ companyId }: { companyId: string | null | undefined }) {
  const badge = useAutomationReviewBadge(companyId);
  return <div data-testid="automation-badge">{badge.count}:{String(badge.needsReview)}</div>;
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await Promise.resolve();
      });
    }
  }
  throw lastError;
}

function renderHarness(companyId: string | null | undefined, container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Harness companyId={companyId} />
      </QueryClientProvider>,
    );
  });

  return { root, queryClient };
}

describe("useAutomationReviewBadge", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    dashboardSummaryMock.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount();
      });
    }
    container.remove();
  });

  it("returns zero while disabled without calling the dashboard API", () => {
    const rendered = renderHarness(null, container);
    root = rendered.root;

    expect(container.textContent).toBe("0:false");
    expect(dashboardSummaryMock).not.toHaveBeenCalled();
  });

  it("derives the human review count from the dashboard summary", async () => {
    dashboardSummaryMock.mockResolvedValue(makeSummary({
      agents: { active: 1, error: 2 },
      tasks: { blocked: 3 },
      pendingApprovals: 4,
      budgets: { activeIncidents: 1, pendingApprovals: 5 },
    }));

    const rendered = renderHarness("company-1", container);
    root = rendered.root;

    await waitForAssertion(() => {
      expect(container.textContent).toBe("15:true");
    });
    expect(dashboardSummaryMock).toHaveBeenCalledWith("company-1");
  });

  it("reports setup review when no agents are enabled", async () => {
    dashboardSummaryMock.mockResolvedValue(makeSummary());

    const rendered = renderHarness("company-1", container);
    root = rendered.root;

    await waitForAssertion(() => {
      expect(container.textContent).toBe("1:true");
    });
  });
});
