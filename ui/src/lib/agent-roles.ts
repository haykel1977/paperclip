import {
  AGENT_ROLE_LABELS,
  normalizeAgentRoleValue,
  type AgentRole,
} from "@paperclipai/shared";

export function normalizeAgentRole(value: string | null | undefined): AgentRole | null {
  return normalizeAgentRoleValue(value);
}

export function agentRoleLabel(value: string | null | undefined): string {
  const normalized = normalizeAgentRole(value);
  if (normalized === "engineer") return "Developer";
  if (normalized) return AGENT_ROLE_LABELS[normalized];
  return String(value ?? "").trim() || "Unknown";
}

export function agentRoleMatches(value: string | null | undefined, expected: AgentRole): boolean {
  return normalizeAgentRole(value) === expected;
}
