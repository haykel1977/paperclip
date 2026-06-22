import { AGENT_ROLE_LABELS, AGENT_ROLES, type AgentRole } from "@paperclipai/shared";

const DEVELOPER_ROLE_ALIASES = new Set([
  "engineer",
  "developer",
  "developper",
  "développeur",
]);

export function normalizeAgentRole(value: string | null | undefined): AgentRole | null {
  const role = String(value ?? "").trim().toLowerCase();
  if (!role) return null;
  if (DEVELOPER_ROLE_ALIASES.has(role)) return "engineer";
  if ((AGENT_ROLES as readonly string[]).includes(role)) return role as AgentRole;
  return null;
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
