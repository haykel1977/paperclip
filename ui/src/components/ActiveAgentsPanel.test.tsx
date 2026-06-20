// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueRecoveryAction } from "@paperclipai/shared";
import { ActiveAgentsPanel } from "./ActiveAgentsPanel";

const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("./Identity", () => ({
  Identity: ({ name }: { name: string }) => <span>{name}</span>,
}));

vi.mock("./RunChatSurface", () => ({
  RunChatSurface: () => <div>Run output</div>,
}));

vi.mock("./transcript/useLiveRunTranscripts", () => ({
  useLiveRunTranscripts: () => ({
    transcriptByRun: new Map(),
    hasOutputForRun: () => false,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitForMicrotaskAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    await flushReact();
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function createRun(index: number) {
  return {
    id: `run-${index}`,
    status: "running",
    invocationSource: "assignment",
    triggerDetail: null,
    startedAt: "2026-04-24T12:00:00.000Z",
    finishedAt: null,
    createdAt: `2026-04-24T12:00:0${index}.000Z`,
    agentId: `agent-${index}`,
    agentName: `Agent ${index}`,
    adapterType: "codex_local",
    issueId: null,
  };
}

function createIssueRun(index: number, issueId: string) {
  return {
    ...createRun(index),
    issueId,
  };
}

function createIssue(id: string, identifier: string, title: string, activeRecoveryAction?: IssueRecoveryAction | null) {
  return {
    id,
    companyId: "company-1",
    identifier,
    title,
    description: null,
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    parentId: null,
    projectId: null,
    projectWorkspaceId: null,
    executionWorkspaceId: null,
    goalId: null,
    labels: [],
    blockedByIssueIds: [],
    blocksIssueIds: [],
    activeRecoveryAction: activeRecoveryAction ?? null,
    createdAt: "2026-04-24T12:00:00.000Z",
    updatedAt: "2026-04-24T12:00:00.000Z",
  };
}

function createRecoveryAction(overrides: Partial<IssueRecoveryAction> = {}): IssueRecoveryAction {
  return {
    id: "recovery-1",
    companyId: "company-1",
    sourceIssueId: "issue-1",
    recoveryIssueId: null,
    kind: "missing_disposition",
    status: "active",
    ownerType: "agent",
    ownerAgentId: "agent-1",
    ownerUserId: null,
    previousOwnerAgentId: "agent-1",
    returnOwnerAgentId: "agent-1",
    cause: "missing_disposition",
    fingerprint: "recovery-fingerprint",
    evidence: {},
    nextAction: "Choose and record a valid issue disposition.",
    wakePolicy: { type: "wake_owner" },
    monitorPolicy: null,
    attemptCount: 1,
    maxAttempts: null,
    timeoutAt: null,
    lastAttemptAt: "2026-04-24T12:00:00.000Z",
    outcome: null,
    resolutionNote: null,
    resolvedAt: null,
    createdAt: "2026-04-24T12:00:00.000Z",
    updatedAt: "2026-04-24T12:00:00.000Z",
    ...overrides,
  };
}

describe("ActiveAgentsPanel", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([1, 2, 3, 4, 5].map(createRun));
    mockIssuesApi.get.mockRejectedValue(new Error("Issue not found"));
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("links hidden active/recent runs to the full live dashboard", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ActiveAgentsPanel companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(mockHeartbeatsApi.liveRunsForCompany).toHaveBeenCalledWith("company-1", {
      minCount: 4,
      limit: undefined,
    });

    const moreLink = [...container.querySelectorAll("a")].find((anchor) =>
      anchor.textContent?.includes("more active/recent"),
    );
    expect(moreLink?.getAttribute("href")).toBe("/dashboard/live");

    await act(async () => {
      root.unmount();
    });
  });

  it("can request the full live dashboard page limit without a hidden-runs link", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ActiveAgentsPanel
            companyId="company-1"
            minRunCount={50}
            fetchLimit={50}
            cardLimit={50}
            queryScope="dashboard-live"
            showMoreLink={false}
          />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(mockHeartbeatsApi.liveRunsForCompany).toHaveBeenCalledWith("company-1", {
      minCount: 50,
      limit: 50,
    });
    expect(container.textContent).not.toContain("more active/recent");

    await act(async () => {
      root.unmount();
    });
  });

  it("loads exact visible run issues so task names render even when the issue list page would miss them", async () => {
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([
      createIssueRun(1, "65274215-0000-4000-8000-000000000000"),
    ]);
    mockIssuesApi.get.mockResolvedValue(createIssue(
      "65274215-0000-4000-8000-000000000000",
      "PAP-3562",
      "Phase 4B: Implement LLM Wiki distillation UI",
    ));

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ActiveAgentsPanel companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    await waitForMicrotaskAssertion(() => {
      expect(mockIssuesApi.get).toHaveBeenCalledWith("65274215-0000-4000-8000-000000000000");
      const issueLink = [...container.querySelectorAll("a")].find((anchor) =>
        anchor.textContent?.includes("Phase 4B"),
      );
      expect(issueLink?.textContent).toBe("PAP-3562 - Phase 4B: Implement LLM Wiki distillation UI");
      expect(issueLink?.getAttribute("href")).toBe("/issues/PAP-3562");
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("shows active recovery work as in progress on live run cards", async () => {
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([
      createIssueRun(1, "issue-1"),
    ]);
    mockIssuesApi.get.mockResolvedValue(createIssue(
      "issue-1",
      "PAP-4100",
      "Recover missing disposition",
      createRecoveryAction(),
    ));

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ActiveAgentsPanel companyId="company-1" />
        </QueryClientProvider>,
      );
    });

    await waitForMicrotaskAssertion(() => {
      const chip = container.querySelector("[data-testid='active-agent-run-recovery-indicator']");
      expect(chip?.getAttribute("data-recovery-state")).toBe("in_progress");
      expect(chip?.textContent).toContain("Recovery in progress");
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps finished run recovery actions marked as needed", async () => {
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([
      {
        ...createIssueRun(1, "issue-1"),
        status: "failed",
        finishedAt: "2026-04-24T12:05:00.000Z",
      },
    ]);
    mockIssuesApi.get.mockResolvedValue(createIssue(
      "issue-1",
      "PAP-4100",
      "Recover missing disposition",
      createRecoveryAction(),
    ));

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ActiveAgentsPanel companyId="company-1" />
        </QueryClientProvider>,
      );
    });

    await waitForMicrotaskAssertion(() => {
      const chip = container.querySelector("[data-testid='active-agent-run-recovery-indicator']");
      expect(chip?.getAttribute("data-recovery-state")).toBe("needed");
      expect(chip?.textContent).toContain("Recovery needed");
    });

    await act(async () => {
      root.unmount();
    });
  });
});
