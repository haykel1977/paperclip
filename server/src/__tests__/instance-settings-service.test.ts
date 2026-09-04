import { describe, expect, it } from "vitest";
import { normalizeExperimentalSettings } from "../services/instance-settings.js";

describe("instance settings service", () => {
  it("defaults enableIsolatedWorkspaces on for empty experimental settings", () => {
    expect(normalizeExperimentalSettings({})).toMatchObject({
      enableIsolatedWorkspaces: true,
    });
    expect(normalizeExperimentalSettings({ enableIsolatedWorkspaces: false })).toMatchObject({
      enableIsolatedWorkspaces: false,
    });
    expect(normalizeExperimentalSettings({ enableIsolatedWorkspaces: true })).toMatchObject({
      enableIsolatedWorkspaces: true,
    });
  });

  it("ignores retired experimental flags without resetting current settings", () => {
    expect(normalizeExperimentalSettings({
      enableEnvironments: true,
      enableIsolatedWorkspaces: true,
      enableIssuePlanDecompositions: true,
      enableCloudSync: true,
      autoRestartDevServerWhenIdle: true,
      enableIssueGraphLivenessAutoRecovery: true,
      issueGraphLivenessAutoRecoveryLookbackHours: 48,
      enableNewestFirstIssueThread: true,
    })).toEqual({
      enableEnvironments: true,
      enableIsolatedWorkspaces: true,
      enableStreamlinedLeftNavigation: false,
      enableIssuePlanDecompositions: true,
      enableCloudSync: true,
      autoRestartDevServerWhenIdle: true,
      enableIssueGraphLivenessAutoRecovery: true,
      issueGraphLivenessAutoRecoveryLookbackHours: 48,
    });
  });
});
