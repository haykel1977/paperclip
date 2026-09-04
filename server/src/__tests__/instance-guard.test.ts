import { describe, expect, it } from "vitest";
import {
  applyNonCanonicalInstanceDefaults,
  SECONDARY_EMBEDDED_PG_PORT,
  SECONDARY_HTTP_PORT,
} from "../instance-guard-defaults.js";

describe("applyNonCanonicalInstanceDefaults", () => {
  it("does not remap an explicit PAPERCLIP_EMBEDDED_PG_PORT", () => {
    const env: NodeJS.ProcessEnv = {
      PAPERCLIP_EMBEDDED_PG_PORT: "54340",
      PORT: "3300",
      PAPERCLIP_HOME: "/tmp/paperclip-explicit",
    };

    const result = applyNonCanonicalInstanceDefaults(env);

    expect(result.applied).toBe(true);
    expect(result.defaults).toEqual({});
    expect(env.PAPERCLIP_EMBEDDED_PG_PORT).toBe("54340");
    expect(env.PORT).toBe("3300");
    expect(env.PAPERCLIP_HOME).toBe("/tmp/paperclip-explicit");
  });

  it("defaults only unset values for a non-canonical instance", () => {
    const env: NodeJS.ProcessEnv = {};
    const result = applyNonCanonicalInstanceDefaults(env, { homedir: "/tmp/alice" });

    expect(result.applied).toBe(true);
    expect(env.PORT).toBe(SECONDARY_HTTP_PORT);
    expect(env.PAPERCLIP_EMBEDDED_PG_PORT).toBe(SECONDARY_EMBEDDED_PG_PORT);
    expect(env.PAPERCLIP_HOME).toBe("/tmp/alice/.paperclip-dyad");
  });

  it("leaves canonical instances untouched even when ports are unset", () => {
    const env: NodeJS.ProcessEnv = { PAPERCLIP_INSTANCE: "canonical" };
    const result = applyNonCanonicalInstanceDefaults(env);

    expect(result.applied).toBe(false);
    expect(env.PORT).toBeUndefined();
    expect(env.PAPERCLIP_EMBEDDED_PG_PORT).toBeUndefined();
    expect(env.PAPERCLIP_HOME).toBeUndefined();
  });
});
