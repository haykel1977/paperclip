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
