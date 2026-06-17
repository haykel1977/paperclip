import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { plugins, pluginState } from "@paperclipai/db";
import {
  PLUGIN_STATE_SCOPE_KINDS,
  type PluginStateScopeKind,
  type SetPluginState,
  type ListPluginState,
} from "@paperclipai/shared";
import { badRequest, notFound } from "../errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default namespace used when the plugin does not specify one. */
const DEFAULT_NAMESPACE = "default";
const MAX_STATE_IDENTIFIER_LENGTH = 500;
const UNSAFE_STATE_IDENTIFIER_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isPluginStateScopeKind(value: unknown): value is PluginStateScopeKind {
  return typeof value === "string" && (PLUGIN_STATE_SCOPE_KINDS as readonly string[]).includes(value);
}

function normalizeStateIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw badRequest(`${label} must be a non-empty string`);
  }
  if (value.length > MAX_STATE_IDENTIFIER_LENGTH) {
    throw badRequest(`${label} must be at most ${MAX_STATE_IDENTIFIER_LENGTH} characters`);
  }
  if (value.includes("\0") || UNSAFE_STATE_IDENTIFIER_KEYS.has(value)) {
    throw badRequest(`${label} contains a reserved value`);
  }
  return value;
}

function normalizeOptionalStateIdentifier(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return normalizeStateIdentifier(value, label);
}

export function normalizePluginStateScopeKey(input: {
  scopeKind: unknown;
  scopeId?: unknown;
  namespace?: unknown;
  stateKey: unknown;
}) {
  if (!isPluginStateScopeKind(input.scopeKind)) {
    throw badRequest("Plugin state scopeKind is invalid");
  }
  const scopeId = normalizeOptionalStateIdentifier(input.scopeId, "scopeId") ?? null;
  if (input.scopeKind === "instance" && scopeId !== null) {
    throw badRequest("Plugin state instance scope cannot include scopeId");
  }
  if (input.scopeKind !== "instance" && scopeId === null) {
    throw badRequest("Plugin state scopeId is required for non-instance scopes");
  }
  return {
    scopeKind: input.scopeKind,
    scopeId,
    namespace: normalizeOptionalStateIdentifier(input.namespace, "namespace") ?? DEFAULT_NAMESPACE,
    stateKey: normalizeStateIdentifier(input.stateKey, "stateKey"),
  };
}

export function normalizePluginStateListFilter(filter: ListPluginState = {}): ListPluginState {
  const scopeKind = filter.scopeKind === undefined ? undefined : filter.scopeKind;
  if (scopeKind !== undefined && !isPluginStateScopeKind(scopeKind)) {
    throw badRequest("Plugin state scopeKind is invalid");
  }
  const scopeId = normalizeOptionalStateIdentifier(filter.scopeId, "scopeId");
  if (scopeKind === "instance" && scopeId !== undefined) {
    throw badRequest("Plugin state instance scope cannot include scopeId");
  }
  const namespace = normalizeOptionalStateIdentifier(filter.namespace, "namespace");
  return {
    ...(scopeKind !== undefined ? { scopeKind } : {}),
    ...(scopeId !== undefined ? { scopeId } : {}),
    ...(namespace !== undefined ? { namespace } : {}),
  };
}

/**
 * Build the WHERE clause conditions for a scoped state lookup.

 *
 * The five-part composite key is:
 *   `(pluginId, scopeKind, scopeId, namespace, stateKey)`
 *
 * `scopeId` may be null (for `instance` scope) or a non-empty string.
 */
function scopeConditions(
  pluginId: string,
  scopeKind: PluginStateScopeKind,
  scopeId: string | undefined | null,
  namespace: string,
  stateKey: string,
) {
  const conditions = [
    eq(pluginState.pluginId, pluginId),
    eq(pluginState.scopeKind, scopeKind),
    eq(pluginState.namespace, namespace),
    eq(pluginState.stateKey, stateKey),
  ];

  if (scopeId != null && scopeId !== "") {
    conditions.push(eq(pluginState.scopeId, scopeId));
  } else {
    conditions.push(isNull(pluginState.scopeId));
  }

  return and(...conditions);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Plugin State Store — scoped key-value persistence for plugin workers.
 *
 * Provides `get`, `set`, `delete`, and `list` operations over the
 * `plugin_state` table. Each plugin's data is strictly namespaced by
 * `pluginId` so plugins cannot read or write each other's state.
 *
 * This service implements the server-side backing for the `ctx.state` SDK
 * client exposed to plugin workers. The host is responsible for:
 * - enforcing `plugin.state.read` capability before calling `get` / `list`
 * - enforcing `plugin.state.write` capability before calling `set` / `delete`
 *
 * @see PLUGIN_SPEC.md §14 — SDK Surface (`ctx.state`)
 * @see PLUGIN_SPEC.md §15.1 — Capabilities: Plugin State
 * @see PLUGIN_SPEC.md §21.3 — `plugin_state` table
 */
export function pluginStateStore(db: Db) {
  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  async function assertPluginExists(pluginId: string): Promise<void> {
    const rows = await db
      .select({ id: plugins.id })
      .from(plugins)
      .where(eq(plugins.id, pluginId));
    if (rows.length === 0) {
      throw notFound(`Plugin not found: ${pluginId}`);
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    /**
     * Read a state value.
     *
     * Returns the stored JSON value, or `null` if no entry exists for the
     * given scope and key.
     *
     * Requires `plugin.state.read` capability (enforced by the caller).
     *
     * @param pluginId - UUID of the owning plugin
     * @param scopeKind - Granularity of the scope
     * @param scopeId - Identifier for the scoped entity (null for `instance` scope)
     * @param stateKey - The key to read
     * @param namespace - Sub-namespace (defaults to `"default"`)
     */
    get: async (
      pluginId: string,
      scopeKind: PluginStateScopeKind,
      stateKey: string,
      {
        scopeId,
        namespace,
      }: { scopeId?: string; namespace?: string } = {},
    ): Promise<unknown> => {
      const normalized = normalizePluginStateScopeKey({ scopeKind, scopeId, namespace, stateKey });
      const rows = await db
        .select()
        .from(pluginState)
        .where(scopeConditions(
          pluginId,
          normalized.scopeKind,
          normalized.scopeId,
          normalized.namespace,
          normalized.stateKey,
        ));

      return rows[0]?.valueJson ?? null;
    },

    /**
     * Write (create or replace) a state value.

     *
     * Uses an upsert so the caller does not need to check for prior existence.
     * On conflict (same composite key) the existing row's `value_json` and
     * `updated_at` are overwritten.
     *
     * Requires `plugin.state.write` capability (enforced by the caller).
     *
     * @param pluginId - UUID of the owning plugin
     * @param input - Scope key and value to store
     */
    set: async (pluginId: string, input: SetPluginState): Promise<void> => {
      const normalized = normalizePluginStateScopeKey(input);
      await assertPluginExists(pluginId);

      await db
        .insert(pluginState)
        .values({
          pluginId,
          scopeKind: normalized.scopeKind,
          scopeId: normalized.scopeId,
          namespace: normalized.namespace,
          stateKey: normalized.stateKey,
          valueJson: input.value,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            pluginState.pluginId,
            pluginState.scopeKind,
            pluginState.scopeId,
            pluginState.namespace,
            pluginState.stateKey,
          ],
          set: {
            valueJson: input.value,
            updatedAt: new Date(),
          },
        });
    },

    /**
     * Delete a state value.

     *
     * No-ops silently if the entry does not exist (idempotent by design).
     *
     * Requires `plugin.state.write` capability (enforced by the caller).
     *
     * @param pluginId - UUID of the owning plugin
     * @param scopeKind - Granularity of the scope
     * @param stateKey - The key to delete
     * @param scopeId - Identifier for the scoped entity (null for `instance` scope)
     * @param namespace - Sub-namespace (defaults to `"default"`)
     */
    delete: async (
      pluginId: string,
      scopeKind: PluginStateScopeKind,
      stateKey: string,
      {
        scopeId,
        namespace,
      }: { scopeId?: string; namespace?: string } = {},
    ): Promise<void> => {
      const normalized = normalizePluginStateScopeKey({ scopeKind, scopeId, namespace, stateKey });
      await db
        .delete(pluginState)
        .where(scopeConditions(
          pluginId,
          normalized.scopeKind,
          normalized.scopeId,
          normalized.namespace,
          normalized.stateKey,
        ));
    },

    /**
     * List all state entries for a plugin, optionally filtered by scope.

     *
     * Returns all matching rows as `PluginStateRecord`-shaped objects.
     * The `valueJson` field contains the stored value.
     *
     * Requires `plugin.state.read` capability (enforced by the caller).
     *
     * @param pluginId - UUID of the owning plugin
     * @param filter - Optional scope filters (scopeKind, scopeId, namespace)
     */
    list: async (pluginId: string, filter: ListPluginState = {}): Promise<typeof pluginState.$inferSelect[]> => {
      const normalized = normalizePluginStateListFilter(filter);
      const conditions = [eq(pluginState.pluginId, pluginId)];

      if (normalized.scopeKind !== undefined) {
        conditions.push(eq(pluginState.scopeKind, normalized.scopeKind));
      }
      if (normalized.scopeId !== undefined) {
        conditions.push(eq(pluginState.scopeId, normalized.scopeId));
      }
      if (normalized.namespace !== undefined) {
        conditions.push(eq(pluginState.namespace, normalized.namespace));
      }

      return db
        .select()
        .from(pluginState)
        .where(and(...conditions));
    },

    /**
     * Delete all state entries owned by a plugin.

     *
     * Called during plugin uninstall when `removeData = true`. Also useful
     * for resetting a plugin's state during testing.
     *
     * @param pluginId - UUID of the owning plugin
     */
    deleteAll: async (pluginId: string): Promise<void> => {
      await db
        .delete(pluginState)
        .where(eq(pluginState.pluginId, pluginId));
    },
  };
}

export type PluginStateStore = ReturnType<typeof pluginStateStore>;
