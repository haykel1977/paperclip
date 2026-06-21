import { describe, expect, it } from "vitest";
import {
  collectAgentAdapterWorkspaceCommandPaths,
  collectExecutionWorkspaceCommandPaths,
  collectIssueWorkspaceCommandPaths,
  collectProjectExecutionWorkspaceCommandPaths,
  collectProjectWorkspaceCommandPaths,
} from "../routes/workspace-command-authz.js";

describe("workspace command authorization path collection", () => {
  it("collects adapter config workspace runtime commands", () => {
    expect(
      collectAgentAdapterWorkspaceCommandPaths({
        workspaceStrategy: {
          type: "git_worktree",
          provisionCommand: "pnpm install",
        },
        workspaceRuntime: {
          services: [{ name: "web", command: "pnpm dev" }],
        },
      }),
    ).toEqual([
      "adapterConfig.workspaceStrategy.provisionCommand",
      "adapterConfig.workspaceRuntime.services[0].command",
    ]);
  });

  it("collects project policy workspace runtime commands", () => {
    expect(
      collectProjectExecutionWorkspaceCommandPaths({
        workspaceStrategy: {
          type: "git_worktree",
          provisionCommand: "pnpm install",
        },
        workspaceRuntime: {
          services: [{ name: "web", command: "pnpm dev" }],
          jobs: [{ name: "migrate", command: "pnpm db:migrate" }],
        },
      }),
    ).toEqual([
      "executionWorkspacePolicy.workspaceStrategy.provisionCommand",
      "executionWorkspacePolicy.workspaceRuntime.services[0].command",
      "executionWorkspacePolicy.workspaceRuntime.jobs[0].command",
    ]);
  });

  it("collects project workspace runtime command mutations", () => {
    expect(
      collectProjectWorkspaceCommandPaths({
        cleanupCommand: "pnpm cleanup",
        runtimeConfig: {
          workspaceRuntime: {
            commands: [
              { id: "web", kind: "service", command: "pnpm dev" },
              { id: "lint", kind: "job" },
            ],
          },
        },
      }),
    ).toEqual([
      "cleanupCommand",
      "runtimeConfig.workspaceRuntime.commands[0].command",
    ]);
  });

  it("collects issue workspace runtime and assignee adapter runtime command mutations", () => {
    expect(
      collectIssueWorkspaceCommandPaths({
        executionWorkspaceSettings: {
          workspaceRuntime: {
            services: [{ name: "preview", command: "pnpm preview" }],
          },
        },
        assigneeAdapterOverrides: {
          adapterConfig: {
            workspaceRuntime: {
              jobs: [{ name: "seed", command: "pnpm db:seed" }],
            },
          },
        },
      }),
    ).toEqual([
      "executionWorkspaceSettings.workspaceRuntime.services[0].command",
      "assigneeAdapterOverrides.adapterConfig.workspaceRuntime.jobs[0].command",
    ]);
  });

  it("collects execution workspace metadata runtime commands", () => {
    expect(
      collectExecutionWorkspaceCommandPaths({
        metadata: {
          config: {
            workspaceRuntime: {
              jobs: [{ name: "seed", command: "pnpm db:seed" }],
            },
          },
        },
      }),
    ).toEqual([
      "metadata.config.workspaceRuntime.jobs[0].command",
    ]);
  });
});
