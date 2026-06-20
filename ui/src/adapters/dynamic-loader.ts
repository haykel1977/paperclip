/**
 * Dynamic UI parser loading for external adapters — sandboxed execution.
 *
 * When the Paperclip UI encounters an adapter type that doesn't have a
 * built-in parser (e.g., an external adapter loaded via the plugin system),
 * it fetches the parser JS from `/api/adapters/:type/ui-parser.js` and
 * executes it **inside a dedicated Web Worker** so it cannot access the
 * board UI's same-origin state (cookies, localStorage, DOM, authenticated
 * fetch, etc.).
 *
 * The worker communicates via a narrow postMessage protocol:
 *   Main → Worker:  { type: "init", source }
 *   Worker → Main:  { type: "ready" } | { type: "error", message }
 *   Main → Worker:  { type: "parse", id, line, ts }
 *   Worker → Main:  { type: "result", id, entries }
 *
 * Because the parse call is async (cross-thread postMessage), but the
 * existing `parseStdoutLine` contract is synchronous, we cache completed
 * worker results and ask the adapter registry to recompute transcripts when
 * a new result arrives.
 *
 * **Synchronous fast-path**: After init, parse requests are sent to the
 * worker which responds asynchronously.  The `parseStdoutLine` wrapper
 * returns cached results synchronously on the next transcript recomputation.
 * In practice this adds ~1 frame of latency which is imperceptible.
 *
 * Security: see `sandboxed-parser-worker.ts` for the full lockdown.
 */

import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import type { StdoutLineParser, StdoutParserFactory } from "./types";
import { createSandboxedWorker } from "./sandboxed-parser-worker";
import type { SandboxRequest, SandboxResponse } from "./sandboxed-parser-worker";

// ── Types ───────────────────────────────────────────────────────────────────

interface DynamicParserModule {
  parseStdoutLine: StdoutLineParser;
  createStdoutParser?: StdoutParserFactory;
}

interface PendingParseRequest {
  resolve: (entries: TranscriptEntry[]) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface SandboxedParser {
  worker: Worker;
  ready: boolean;
  nextId: number;
  pendingResolves: Map<number, PendingParseRequest>;
}

// ── State ───────────────────────────────────────────────────────────────────

/** Cache of fully initialised sandboxed parsers by adapter type. */
const sandboxedParsers = new Map<string, SandboxedParser>();

/** Cache of the public DynamicParserModule wrappers. */
const dynamicParserCache = new Map<string, DynamicParserModule>();

/** Track which types we've already attempted to load (to avoid repeat 404s). */
const failedLoads = new Set<string>();

/** In-flight init promises so concurrent callers share the same load. */
const loadPromises = new Map<string, Promise<DynamicParserModule | null>>();

let resultNotifier: (() => void) | null = null;

export function setDynamicParserResultNotifier(fn: (() => void) | null): void {
  resultNotifier = fn;
}

// ── Internal helpers ────────────────────────────────────────────────────────

function sendToWorker(sandbox: SandboxedParser, msg: SandboxRequest): void {
  sandbox.worker.postMessage(msg);
}

function nextRequestId(sandbox: SandboxedParser): number {
  return sandbox.nextId++;
}

function lineCacheKey(line: string, ts: string): string {
  return `${ts}\u0000${line}`;
}

function notifyResultReady(): void {
  resultNotifier?.();
}

const MAX_PARSER_SOURCE_LENGTH = 1_000_000;
const PARSER_WORKER_INIT_TIMEOUT_MS = 5_000;
const PARSER_WORKER_PARSE_TIMEOUT_MS = 1_000;
const MAX_PENDING_PARSE_REQUESTS = 200;
const MAX_PARSE_CACHE_ENTRIES = 1_000;
const MAX_WORKER_LINE_LENGTH = 100_000;
const MAX_WORKER_ENTRIES_PER_LINE = 50;
const MAX_WORKER_STRING_LENGTH = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readWorkerString(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  return value.length > MAX_WORKER_STRING_LENGTH ? value.slice(0, MAX_WORKER_STRING_LENGTH) : value;
}

function readWorkerBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readWorkerNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sanitizeWorkerEntry(value: unknown): TranscriptEntry | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  const ts = readWorkerString(value.ts);
  switch (value.kind) {
    case "assistant":
    case "thinking": {
      return {
        kind: value.kind,
        ts,
        text: readWorkerString(value.text),
        ...(typeof value.delta === "boolean" ? { delta: value.delta } : {}),
      };
    }
    case "user":
    case "stderr":
    case "system":
    case "stdout": {
      return { kind: value.kind, ts, text: readWorkerString(value.text) };
    }
    case "tool_call": {
      return {
        kind: "tool_call",
        ts,
        name: readWorkerString(value.name),
        input: value.input,
        ...(typeof value.toolUseId === "string" ? { toolUseId: readWorkerString(value.toolUseId) } : {}),
      };
    }
    case "tool_result": {
      return {
        kind: "tool_result",
        ts,
        toolUseId: readWorkerString(value.toolUseId),
        ...(typeof value.toolName === "string" ? { toolName: readWorkerString(value.toolName) } : {}),
        content: readWorkerString(value.content),
        isError: readWorkerBoolean(value.isError),
      };
    }
    case "init": {
      return {
        kind: "init",
        ts,
        model: readWorkerString(value.model),
        sessionId: readWorkerString(value.sessionId),
      };
    }
    case "result": {
      const errors = Array.isArray(value.errors)
        ? value.errors.slice(0, MAX_WORKER_ENTRIES_PER_LINE).map((entry) => readWorkerString(entry))
        : [];
      return {
        kind: "result",
        ts,
        text: readWorkerString(value.text),
        inputTokens: readWorkerNumber(value.inputTokens),
        outputTokens: readWorkerNumber(value.outputTokens),
        cachedTokens: readWorkerNumber(value.cachedTokens),
        costUsd: readWorkerNumber(value.costUsd),
        subtype: readWorkerString(value.subtype),
        isError: readWorkerBoolean(value.isError),
        errors,
      };
    }
    case "diff": {
      const changeType = value.changeType;
      if (
        changeType !== "add" &&
        changeType !== "remove" &&
        changeType !== "context" &&
        changeType !== "hunk" &&
        changeType !== "file_header" &&
        changeType !== "truncation"
      ) {
        return null;
      }
      return { kind: "diff", ts, changeType, text: readWorkerString(value.text) };
    }
    default:
      return null;
  }
}

function sanitizeWorkerEntries(entries: unknown): TranscriptEntry[] {
  if (!Array.isArray(entries)) return [];
  const sanitized: TranscriptEntry[] = [];
  for (const entry of entries.slice(0, MAX_WORKER_ENTRIES_PER_LINE)) {
    const next = sanitizeWorkerEntry(entry);
    if (next) sanitized.push(next);
  }
  return sanitized;
}

/**
 * Parse a single line synchronously by delegating to the worker.
 * Returns a Promise that resolves with the TranscriptEntry[] from the worker.
 */
function parseLineAsync(sandbox: SandboxedParser, line: string, ts: string): Promise<TranscriptEntry[]> {
  if (line.length > MAX_WORKER_LINE_LENGTH || sandbox.pendingResolves.size >= MAX_PENDING_PARSE_REQUESTS) {
    return Promise.resolve([]);
  }

  return new Promise((resolve) => {
    const id = nextRequestId(sandbox);
    const timeout = setTimeout(() => {
      sandbox.pendingResolves.delete(id);
      resolve([]);
    }, PARSER_WORKER_PARSE_TIMEOUT_MS);

    sandbox.pendingResolves.set(id, { resolve, timeout });
    sendToWorker(sandbox, { type: "parse", id, line, ts });
  });
}

function drainPendingRequests(sandbox: SandboxedParser): void {
  for (const pending of sandbox.pendingResolves.values()) {
    clearTimeout(pending.timeout);
    pending.resolve([]);
  }
  sandbox.pendingResolves.clear();
}

/**
 * Create a sandboxed worker, send the parser source, and wait for init.
 */
function initSandboxedWorker(source: string): Promise<SandboxedParser> {
  return new Promise((resolve, reject) => {
    const worker = createSandboxedWorker();
    const sandbox: SandboxedParser = {
      worker,
      ready: false,
      nextId: 1,
      pendingResolves: new Map(),
    };

    const timeout = setTimeout(() => {
      drainPendingRequests(sandbox);
      worker.terminate();
      reject(new Error("Parser worker init timed out"));
    }, PARSER_WORKER_INIT_TIMEOUT_MS);

    worker.onmessage = (e: MessageEvent<SandboxResponse>) => {
      const msg = e.data;

      if (msg.type === "ready") {
        clearTimeout(timeout);
        sandbox.ready = true;

        // Switch to the steady-state message handler.
        worker.onmessage = (ev: MessageEvent<SandboxResponse>) => {
          const resp = ev.data;
          if (resp.type === "result") {
            const pending = sandbox.pendingResolves.get(resp.id);
            if (pending) {
              sandbox.pendingResolves.delete(resp.id);
              clearTimeout(pending.timeout);
              pending.resolve(sanitizeWorkerEntries(resp.entries));
            }
          } else if (resp.type === "error") {
            console.error("[adapter-ui-loader] Worker reported error:", resp.message);
            drainPendingRequests(sandbox);
          }

        };

        resolve(sandbox);
        return;
      }

      if (msg.type === "error") {
        clearTimeout(timeout);
        drainPendingRequests(sandbox);
        worker.terminate();
        reject(new Error(msg.message));
        return;
      }
    };

    worker.onerror = (ev) => {
      clearTimeout(timeout);
      drainPendingRequests(sandbox);
      worker.terminate();
      reject(new Error(`Worker error: ${ev.message}`));
    };

    // Send the parser source to the worker for evaluation.
    sendToWorker(sandbox, { type: "init", source });
  });
}

/**
 * Build a DynamicParserModule that delegates all calls to the sandboxed worker.
 *
 * The parseStdoutLine wrapper is **synchronous** to match the existing contract.
 * Cache misses send a parse request to the worker and return `[]`; when the
 * worker responds, the registry notification path recomputes transcripts and
 * this wrapper returns the cached result synchronously.
 *
 * In practice, because the existing codebase already handles the "bridge"
 * pattern where parseStdoutLine returns [] until the dynamic parser loads,
 * the same UX applies here: the first render may show raw lines, and a
 * subsequent render shows the parsed entries.
 */
function buildParserModule(sandbox: SandboxedParser): DynamicParserModule {
  const parseCache = new Map<string, TranscriptEntry[]>();
  const pendingParseKeys = new Set<string>();

  function rememberParseResult(key: string, entries: TranscriptEntry[]): void {
    parseCache.set(key, entries);
    if (parseCache.size > MAX_PARSE_CACHE_ENTRIES) {
      const oldestKey = parseCache.keys().next().value as string | undefined;
      if (oldestKey !== undefined) parseCache.delete(oldestKey);
    }

  }

  const parseStdoutLine: StdoutLineParser = (line: string, ts: string) => {
    const key = lineCacheKey(line, ts);
    const cached = parseCache.get(key);
    if (cached) return cached.slice();

    if (!pendingParseKeys.has(key)) {
      pendingParseKeys.add(key);
      parseLineAsync(sandbox, line, ts).then((entries) => {
        pendingParseKeys.delete(key);
        rememberParseResult(key, entries);
        notifyResultReady();
      });
    }

    return [];
  };

  return { parseStdoutLine };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Dynamically load a UI parser for an adapter type from the server API,
 * executing it inside a sandboxed Web Worker.
 *
 * @returns A DynamicParserModule, or null if unavailable.
 */
export async function loadDynamicParser(adapterType: string): Promise<DynamicParserModule | null> {
  // Return cached parser if already loaded.
  const cached = dynamicParserCache.get(adapterType);
  if (cached) return cached;

  // Don't retry types that previously failed.
  if (failedLoads.has(adapterType)) return null;

  // Coalesce concurrent loads.
  const inflight = loadPromises.get(adapterType);
  if (inflight) return inflight;

  const loadPromise = (async (): Promise<DynamicParserModule | null> => {
    try {
      const response = await fetch(`/api/adapters/${encodeURIComponent(adapterType)}/ui-parser.js`);
      if (!response.ok) {
        failedLoads.add(adapterType);
        return null;
      }

      const source = await response.text();
      if (source.length > MAX_PARSER_SOURCE_LENGTH) {
        throw new Error(`UI parser source exceeds ${MAX_PARSER_SOURCE_LENGTH} bytes`);
      }

      // Initialise the sandboxed worker with the parser source.
      const sandbox = await initSandboxedWorker(source);

      sandboxedParsers.set(adapterType, sandbox);

      const parserModule = buildParserModule(sandbox);
      dynamicParserCache.set(adapterType, parserModule);

      console.info(`[adapter-ui-loader] Loaded sandboxed UI parser for "${adapterType}"`);
      return parserModule;
    } catch (err) {
      console.warn(`[adapter-ui-loader] Failed to load UI parser for "${adapterType}":`, err);
      failedLoads.add(adapterType);
      return null;
    } finally {
      loadPromises.delete(adapterType);
    }
  })();

  loadPromises.set(adapterType, loadPromise);
  return loadPromise;
}

/**
 * Invalidate a cached dynamic parser, removing it from both the parser cache
 * and the failed-loads set so that the next load attempt will try again.
 * Also terminates the sandboxed worker if one exists.
 */
export function invalidateDynamicParser(adapterType: string): boolean {
  const wasCached = dynamicParserCache.has(adapterType);
  dynamicParserCache.delete(adapterType);
  failedLoads.delete(adapterType);
  loadPromises.delete(adapterType);

  // Terminate the worker to free resources.
  const sandbox = sandboxedParsers.get(adapterType);
  if (sandbox) {
    drainPendingRequests(sandbox);
    sandbox.worker.terminate();
    sandboxedParsers.delete(adapterType);
  }

  if (wasCached) {
    console.info(`[adapter-ui-loader] Invalidated sandboxed UI parser for "${adapterType}"`);
  }
  return wasCached;
}
