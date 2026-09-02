export interface AgentModelLike {
  id: string;
  label?: string | null;
}

const SOVEREIGN_MODEL_MARKERS = new Set(["sovereign", "souverain"]);
const NEGATING_MODEL_MARKERS = new Set(["anti", "non", "not", "unsouverain"]);

function sovereignMarkerIndex(value: string): number {
  const tokens = value
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  return tokens.findIndex((token, index) =>
    SOVEREIGN_MODEL_MARKERS.has(token) && !NEGATING_MODEL_MARKERS.has(tokens[index - 1] ?? ""),
  );
}

export function isSovereignAgentModelValue(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return sovereignMarkerIndex(value) >= 0;
}

export function isSovereignAgentModel(model: AgentModelLike): boolean {
  return isSovereignAgentModelValue(model.id) || isSovereignAgentModelValue(model.label ?? "");
}

export function filterSovereignAgentModels<T extends AgentModelLike>(models: T[]): T[] {
  return models.filter(isSovereignAgentModel);
}

/**
 * Runtime toggle: when `PAPERCLIP_ALLOW_CLOUD_MODELS="1"` is set in the server
 * environment, every sovereign-only guard becomes a no-op. Default (unset or
 * anything other than the literal string "1") keeps the existing sovereign-only
 * behaviour bit-for-bit. See docs/agents/cloud-models.md.
 *
 * Any code path that previously called `isSovereignAgentModelValue` /
 * `isSovereignAgentModel` as a gatekeeper must consult this helper first so
 * write-time validation and runtime execution stay in sync.
 */
export function isCloudModelsAllowed(): boolean {
  return typeof process !== "undefined"
    && !!process.env
    && process.env.PAPERCLIP_ALLOW_CLOUD_MODELS === "1";
}
