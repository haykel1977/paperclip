import { describe, expect, it } from "vitest";

import { getWorkerBootstrapSource } from "./sandboxed-parser-worker";

describe("sandboxed parser worker bootstrap", () => {
  it("disables child worker and object URL escape hatches", () => {
    const source = getWorkerBootstrapSource();

    expect(source).toContain("self.Worker = _undefined");
    expect(source).toContain("self.SharedWorker = _undefined");
    expect(source).toContain("self.Blob = _undefined");
    expect(source).toContain("self.RTCPeerConnection = _undefined");
    expect(source).toContain("self.RTCDataChannel = _undefined");
    expect(source).toContain("self.MessageChannel = _undefined");
    expect(source).toContain("self.MessagePort = _undefined");
    expect(source).toContain('"createObjectURL"');
    expect(source).toContain('"revokeObjectURL"');
  });

  it("shadows direct message, network, import, and eval globals during parser evaluation", () => {
    const source = getWorkerBootstrapSource();

    expect(source).toContain('"postMessage", "close"');
    expect(source).toContain('"fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts"');
    expect(source).toContain('"Worker", "SharedWorker", "MessageChannel", "MessagePort", "eval", "Function"');
  });

  it("rejects dynamic import syntax before evaluating parser source", () => {
    const source = getWorkerBootstrapSource();

    expect(source).toContain("hasDynamicImport");
    expect(source).toContain("cannot use dynamic import()");
  });

  it("evaluates parser source in strict mode", () => {
    expect(getWorkerBootstrapSource()).toContain('\\"use strict\\";\\n{\\n" + source');
  });

  it("limits parser source and parse result size inside the worker", () => {
    const source = getWorkerBootstrapSource();

    expect(source).toContain("MAX_SOURCE_LENGTH");
    expect(source).toContain("Parser source exceeds maximum allowed size");
    expect(source).toContain("MAX_ENTRIES_PER_PARSE");
    expect(source).toContain("normalizeParserEntries");
  });

  it("does not include the unused parse_batch protocol branch", () => {
    expect(getWorkerBootstrapSource()).not.toContain("parse_batch");
  });

});
