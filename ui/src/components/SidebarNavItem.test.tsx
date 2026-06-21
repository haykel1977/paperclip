// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Bot } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarNavItem } from "./SidebarNavItem";

const mockSetSidebarOpen = vi.hoisted(() => vi.fn());
const mockSidebarState = vi.hoisted(() => ({
  isMobile: false,
}));

vi.mock("@/lib/router", () => ({
  NavLink: ({
    to,
    children,
    className,
    onClick,
  }: {
    to: string;
    children: React.ReactNode;
    className?: string | ((state: { isActive: boolean }) => string);
    onClick?: () => void;
  }) => (
    <a
      href={to}
      className={typeof className === "function" ? className({ isActive: false }) : className}
      onClick={(event) => {
        event.preventDefault();
        onClick?.();
      }}
    >
      {children}
    </a>
  ),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: mockSidebarState.isMobile,
    setSidebarOpen: mockSetSidebarOpen,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("SidebarNavItem", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    mockSidebarState.isMobile = false;
    mockSetSidebarOpen.mockReset();
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

  function renderItem(props: Partial<React.ComponentProps<typeof SidebarNavItem>> = {}) {
    root = createRoot(container);
    act(() => {
      root!.render(
        <SidebarNavItem
          to="/automation"
          label="Automation"
          icon={Bot}
          {...props}
        />,
      );
    });
  }

  it("renders danger badge and alert dot for review-needed navigation items", () => {
    renderItem({ badge: 7, badgeTone: "danger", alert: true });

    const badge = Array.from(container.querySelectorAll("span"))
      .find((span) => span.textContent === "7");

    expect(container.querySelector("a")?.textContent).toContain("Automation");
    expect(badge?.className).toContain("bg-red-600/90");
    expect(badge?.className).toContain("text-red-50");
    expect(container.querySelector(".bg-red-500")).not.toBeNull();
  });

  it("renders the default badge tone without an alert dot", () => {
    renderItem({ badge: 3 });

    const badge = Array.from(container.querySelectorAll("span"))
      .find((span) => span.textContent === "3");

    expect(badge?.className).toContain("bg-primary");
    expect(badge?.className).toContain("text-primary-foreground");
    expect(container.querySelector(".bg-red-500")).toBeNull();
  });

  it("closes the sidebar on mobile navigation", () => {
    mockSidebarState.isMobile = true;
    renderItem();

    act(() => {
      container.querySelector("a")?.click();
    });

    expect(mockSetSidebarOpen).toHaveBeenCalledWith(false);
  });
});
