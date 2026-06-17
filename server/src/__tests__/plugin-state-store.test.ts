import { describe, expect, it } from "vitest";
import {
  normalizePluginStateListFilter,
  normalizePluginStateScopeKey,
} from "../services/plugin-state-store.js";

describe("plugin state store scope validation", () => {
  it("normalizes valid exact state scope keys", () => {
    expect(normalizePluginStateScopeKey({
      scopeKind: "company",
      scopeId: "company-1",
      stateKey: "cursor",
    })).toEqual({
      scopeKind: "company",
      scopeId: "company-1",
      namespace: "default",
      stateKey: "cursor",
    });

    expect(normalizePluginStateScopeKey({
      scopeKind: "instance",
      namespace: "sync",
      stateKey: "cursor",
    })).toEqual({
      scopeKind: "instance",
      scopeId: null,
      namespace: "sync",
      stateKey: "cursor",
    });
  });

  it("rejects ambiguous or malformed exact state scope keys", () => {
    for (const input of [
      { scopeKind: "company", stateKey: "cursor" },
      { scopeKind: "instance", scopeId: "company-1", stateKey: "cursor" },
      { scopeKind: "company", scopeId: "company-1", stateKey: "__proto__" },
      { scopeKind: "company", scopeId: "company-1", namespace: "constructor", stateKey: "cursor" },
      { scopeKind: "company", scopeId: "", stateKey: "cursor" },
      { scopeKind: "company", scopeId: "company-1", stateKey: "" },
      { scopeKind: "company", scopeId: "company-1", stateKey: "bad\0key" },
      { scopeKind: "not-a-scope", scopeId: "company-1", stateKey: "cursor" },
    ]) {
      expect(() => normalizePluginStateScopeKey(input)).toThrow();
    }
  });

  it("allows broad list filters but rejects invalid filter identifiers", () => {
    expect(normalizePluginStateListFilter({ scopeKind: "company" })).toEqual({ scopeKind: "company" });
    expect(normalizePluginStateListFilter({ scopeId: "company-1" })).toEqual({ scopeId: "company-1" });

    expect(() => normalizePluginStateListFilter({ scopeKind: "instance", scopeId: "company-1" })).toThrow();
    expect(() => normalizePluginStateListFilter({ namespace: "prototype" })).toThrow();
    expect(() => normalizePluginStateListFilter({ scopeKind: "bogus" as never })).toThrow();
  });
});
