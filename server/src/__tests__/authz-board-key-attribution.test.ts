import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { getActorInfo } from "../routes/authz.js";

function req(actor: Request["actor"]): Request {
  return { actor } as unknown as Request;
}

describe("getActorInfo board-key attribution", () => {
  // Two board API keys minted under the same account produce the same actorId,
  // so before this field an action taken with one key was indistinguishable from
  // an action taken with the other. Carrying the key id is what makes a board
  // mutation attributable to the client that made it.
  it("carries the board key id for a board actor", () => {
    const info = getActorInfo(
      req({ type: "board", userId: "user-1", keyId: "key-autopilot", source: "board_key" }),
    );
    expect(info.actorType).toBe("user");
    expect(info.actorId).toBe("user-1");
    expect(info.boardKeyId).toBe("key-autopilot");
  });

  it("distinguishes two keys of the SAME user", () => {
    const a = getActorInfo(req({ type: "board", userId: "user-1", keyId: "key-a", source: "board_key" }));
    const b = getActorInfo(req({ type: "board", userId: "user-1", keyId: "key-b", source: "board_key" }));
    expect(a.actorId).toBe(b.actorId);
    expect(a.boardKeyId).not.toBe(b.boardKeyId);
  });

  it("is null for a board session that carries no key (local implicit / cookie session)", () => {
    expect(
      getActorInfo(req({ type: "board", userId: "user-1", source: "local_implicit" })).boardKeyId,
    ).toBeNull();
    expect(
      getActorInfo(req({ type: "board", userId: "user-1", source: "session" })).boardKeyId,
    ).toBeNull();
  });

  it("is null for an agent actor, whose own key already identifies it", () => {
    const info = getActorInfo(
      req({ type: "agent", agentId: "agent-1", runId: "run-1", keyId: "agent-key", source: "agent_key" }),
    );
    expect(info.actorType).toBe("agent");
    expect(info.actorId).toBe("agent-1");
    // Present and null rather than absent: the return type stays uniform, so a caller
    // can pass actor.boardKeyId without narrowing on actorType first.
    expect(info.boardKeyId).toBeNull();
  });

  it("never reports an agent key as a board key", () => {
    const info = getActorInfo(
      req({ type: "agent", agentId: "agent-1", keyId: "agent-key-42", source: "agent_key" }),
    );
    expect(info.boardKeyId).not.toBe("agent-key-42");
  });

  it("throws for an unauthenticated request", () => {
    expect(() => getActorInfo(req({ type: "none" }))).toThrow();
  });
});
