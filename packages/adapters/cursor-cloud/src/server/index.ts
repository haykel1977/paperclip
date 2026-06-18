export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { sessionCodec } from "./session.js";

import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "repoUrl",
        label: "Repository URL",
        type: "text",
        required: true,
        hint: "Git repository URL Cursor should open for this agent.",
      },
      {
        key: "repoStartingRef",
        label: "Starting ref",
        type: "text",
        hint: "Optional branch, tag, or SHA Cursor should start from.",
      },
      {
        key: "repoPullRequestUrl",
        label: "Pull request URL",
        type: "text",
        hint: "Optional PR URL when attaching the agent to an existing review branch.",
      },
      {
        key: "runtimeEnvType",
        label: "Cursor runtime",
        type: "select",
        default: "cloud",
        options: [
          { value: "cloud", label: "Cursor hosted" },
          { value: "pool", label: "Self-hosted pool" },
          { value: "machine", label: "Named machine" },
        ],
        hint: "Choose where Cursor should execute the remote agent.",
      },
      {
        key: "runtimeEnvName",
        label: "Runtime name",
        type: "text",
        hint: "Optional pool or machine name when targeting a non-default runtime.",
      },
      {
        key: "workOnCurrentBranch",
        label: "Work on current branch",
        type: "toggle",
        default: false,
        hint: "Leave off for isolated feature-branch work. Enable only when attaching the agent to an existing review branch.",
      },
      {
        key: "autoCreatePR",
        label: "Auto-create PR",
        type: "toggle",
        default: false,
        hint: "Allow Cursor to open a pull request when the work is review-ready.",
      },
      {
        key: "skipReviewerRequest",
        label: "Skip reviewer request",
        type: "toggle",
        default: false,
        hint: "Suppress reviewer requests on auto-created pull requests.",
      },

    ],
  };
}
