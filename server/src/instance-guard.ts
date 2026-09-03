// Garde double-lanceur (2026-07-29).
//
// Deux lanceurs concurrents ont plusieurs fois telescope cette instance :
// PG embarque tue au boot (data dir partage), port HTTP vole (le canonique
// tournait sans bind, URL publique en 502). Ce module force des DEFAUTS
// SECONDAIRES pour tout lanceur non identifie comme canonique : seul le
// LaunchAgent officiel (dev.kantum.paperclip-server) exporte
// PAPERCLIP_INSTANCE=canonical et garde 3100 / ~/.paperclip / PG 54329.
//
// Importe en PREMIER par index.ts : les mutations d'env doivent preceder
// toute lecture de config.
//
// Verified 2026-09-03: this does NOT remap an already-set
// PAPERCLIP_EMBEDDED_PG_PORT. It only fills the port when unset. On hosts
// where something else (e.g. socat) already owns 54330, operators must set
// PAPERCLIP_EMBEDDED_PG_PORT explicitly or export PAPERCLIP_INSTANCE=canonical.
import { applyNonCanonicalInstanceDefaults } from "./instance-guard-defaults.js";

export {
  applyNonCanonicalInstanceDefaults,
  CANONICAL_INSTANCE_VALUE,
  SECONDARY_EMBEDDED_PG_PORT,
  SECONDARY_HTTP_PORT,
} from "./instance-guard-defaults.js";

const applied = applyNonCanonicalInstanceDefaults(process.env);
if (applied.applied) {
  console.warn(
    "[paperclip] PAPERCLIP_INSTANCE!=canonical -> defauts secondaires " +
      `(PORT=${process.env.PORT}, HOME=${process.env.PAPERCLIP_HOME}, PG=${process.env.PAPERCLIP_EMBEDDED_PG_PORT}). ` +
      "Instance primaire : exporter PAPERCLIP_INSTANCE=canonical. " +
      "Si 54330 est deja pris (socat, autre instance), definir PAPERCLIP_EMBEDDED_PG_PORT explicitement.",
  );
}
