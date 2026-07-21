// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileBottomNav } from "./MobileBottomNav";

const mockOpenNewIssue = vi.hoisted(() => vi.fn());
const mockAutomationBadge = vi.hoisted(() => ({
  count: 0,
  needsReview: false,
}));
const mockInboxBadge = vi.hoisted(() => ({
  inbox: 0,
  failedRuns: 0,
}));
let currentPathname = "/dashboard";

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: currentPathname }),
  NavLink: ({
    to,
    className,
    children,
  }: {
    to: string;
    className?: string | ((state: { isActive: boolean }) => string);
    children?: React.ReactNode | ((state: { isActive: boolean }) => React.ReactNode);
  }) => {
    const isActive = currentPathname === to;
    const resolvedClassName = typeof className === "function" ? className({ isActive }) : className;
    const resolvedChildren = typeof children === "function" ? children({ isActive }) : children;

    return (
      <a href={to} className={resolvedClassName}>
        {resolvedChildren}
      </a>
    );
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openNewIssue: mockOpenNewIssue }),
}));

vi.mock("../hooks/useAutomationReviewBadge", () => ({
  useAutomationReviewBadge: () => mockAutomationBadge,
}));

vi.mock("../hooks/useInboxBadge", () => ({
  useInboxBadge: () => mockInboxBadge,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("MobileBottomNav", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    currentPathname = "/dashboard";
    mockAutomationBadge.count = 0;
    mockAutomationBadge.needsReview = false;
    mockInboxBadge.inbox = 0;
    mockInboxBadge.failedRuns = 0;
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

  function renderNav() {
    root = createRoot(container);
    act(() => {
      root!.render(<MobileBottomNav visible />);
    });
  }

  it("uses the danger badge style when automation needs human review", () => {
    mockAutomationBadge.count = 7;
    mockAutomationBadge.needsReview = true;

    renderNav();

    // Find the leaf span (no child elements) whose text is "7" — this is the
    // badge pill itself, not the outer "relative" wrapper span.
    const badge = Array.from(container.querySelectorAll("span")).find(
      (element) => element.children.length === 0 && element.textContent === "7",
    );
    expect(badge?.className).toContain("bg-red-600/90");
    expect(badge?.className).toContain("text-red-50");
  });

  it("uses the default badge style when automation has a non-review count", () => {
    mockAutomationBadge.count = 3;
    mockAutomationBadge.needsReview = false;

    renderNav();

    const badge = Array.from(container.querySelectorAll("span")).find(
      (element) => element.children.length === 0 && element.textContent === "3",
    );
    expect(badge?.className).toContain("bg-primary");
    expect(badge?.className).toContain("text-primary-foreground");
  });

  it("uses the danger badge style when inbox failed runs are present", () => {
    mockInboxBadge.inbox = 5;
    mockInboxBadge.failedRuns = 2;

    renderNav();

    const badge = Array.from(container.querySelectorAll("span")).find(
      (element) => element.children.length === 0 && element.textContent === "5",
    );
    expect(badge?.className).toContain("bg-red-600/90");
    expect(badge?.className).toContain("text-red-50");
  });

  it("caps large mobile badge counts at 99+", () => {
    mockAutomationBadge.count = 125;
    mockAutomationBadge.needsReview = true;

    renderNav();

    expect(container.textContent).toContain("99+");
    expect(container.textContent).not.toContain("125");
  });
});
