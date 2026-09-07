import { describe, expect, it } from "vitest";

import { WRAPPER_RESULT_SIGNATURE, isFabricatedWrapperResult } from "../wrapper-result.js";

describe("isFabricatedWrapperResult", () => {
  it("flags the hand-typed claim observed on QUA-1345", () => {
    expect(
      isFabricatedWrapperResult("[result=created pr_url=https://github.com/Beyn-SOLIDUS/quantum/pull/3268]"),
    ).toBe(true);
  });

  it("accepts the wrapper's own comment", () => {
    expect(
      isFabricatedWrapperResult(
        `result=created pr_url=https://github.com/Beyn-SOLIDUS/quantum/pull/3268 review_owner=human ${WRAPPER_RESULT_SIGNATURE}`,
      ),
    ).toBe(false);
  });

  it.each(["updated", "exists"])("flags a hand-typed result=%s", (disposition) => {
    expect(isFabricatedWrapperResult(`result=${disposition} pr_url=https://example.test/pull/1`)).toBe(true);
  });

  it("leaves result=blocked to the agent", () => {
    expect(isFabricatedWrapperResult("result=blocked reason=CF-020")).toBe(false);
  });

  it("does not flag prose that merely mentions the token", () => {
    expect(isFabricatedWrapperResult("The wrapper prints a result= line; I have not run it yet.")).toBe(false);
    expect(isFabricatedWrapperResult("my_result=created is a variable name")).toBe(false);
  });

  it("ignores empty and non-string bodies", () => {
    expect(isFabricatedWrapperResult("")).toBe(false);
    expect(isFabricatedWrapperResult(undefined)).toBe(false);
    expect(isFabricatedWrapperResult(null)).toBe(false);
    expect(isFabricatedWrapperResult(42)).toBe(false);
  });

  it("is case-insensitive on the disposition", () => {
    expect(isFabricatedWrapperResult("RESULT=CREATED pr_url=https://example.test/pull/2")).toBe(true);
  });
});
