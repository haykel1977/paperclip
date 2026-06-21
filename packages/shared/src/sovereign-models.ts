export interface AgentModelLike {
  id: string;
  label?: string | null;
}

const SOVEREIGN_MODEL_MARKERS = ["sovereign", "souverain"];

export function isSovereignAgentModelValue(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.includes("qwen")) return true;
  return SOVEREIGN_MODEL_MARKERS.some((marker) => normalized.includes(marker));
}

export function isSovereignAgentModel(model: AgentModelLike): boolean {
  return isSovereignAgentModelValue(model.id) || isSovereignAgentModelValue(model.label ?? "");
}

export function filterSovereignAgentModels<T extends AgentModelLike>(models: T[]): T[] {
  return models.filter(isSovereignAgentModel);
}
