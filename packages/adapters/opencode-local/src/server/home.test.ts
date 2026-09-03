import path from "node:path";
import { describe, expect, it } from "vitest";
import { isForeignDarwinHomePath, resolveOpenCodeHomeDir } from "./home.js";

describe("OpenCode home resolution", () => {
  it("treats /Users paths as foreign on Linux", () => {
    expect(isForeignDarwinHomePath("/Users/quantum", "linux")).toBe(true);
    expect(isForeignDarwinHomePath("/Users", "linux")).toBe(true);
    expect(isForeignDarwinHomePath("/home/quantum", "linux")).toBe(false);
    expect(isForeignDarwinHomePath("/Users/quantum", "darwin")).toBe(false);
  });

  it("skips a Darwin HOME overlay and uses the Linux home instead", () => {
    const home = resolveOpenCodeHomeDir({
      envHome: "/Users/quantum",
      osHomedir: "/home/quantum",
      userInfoHomedir: "/Users/quantum",
      tmpdir: "/tmp/paperclip-opencode",
      platform: "linux",
    });
    expect(home).toBe(path.resolve("/home/quantum"));
  });

  it("falls back to tmpdir when every candidate is a Darwin /Users path on Linux", () => {
    const home = resolveOpenCodeHomeDir({
      envHome: "/Users/quantum",
      osHomedir: "/Users/quantum",
      userInfoHomedir: "/Users/quantum",
      tmpdir: "/tmp/paperclip-opencode-home",
      platform: "linux",
    });
    expect(home).toBe("/tmp/paperclip-opencode-home");
  });

  it("prefers passwd home over a parent process HOME like /root", () => {
    const home = resolveOpenCodeHomeDir({
      envHome: "/root",
      osHomedir: "/root",
      userInfoHomedir: "/home/quantum",
      platform: "linux",
    });
    expect(home).toBe(path.resolve("/home/quantum"));
  });

  it("honors an explicit adapter HOME before passwd when candidates are provided", () => {
    const home = resolveOpenCodeHomeDir({
      candidates: ["/opt/opencode-home", "/home/quantum", "/root"],
      platform: "linux",
    });
    expect(home).toBe(path.resolve("/opt/opencode-home"));
  });

  it("skips a Darwin adapter HOME and uses passwd home next", () => {
    const home = resolveOpenCodeHomeDir({
      candidates: ["/Users/quantum", "/home/quantum", "/root"],
      platform: "linux",
    });
    expect(home).toBe(path.resolve("/home/quantum"));
  });
});
