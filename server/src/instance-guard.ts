// Garde double-lanceur (2026-07-29).
//
// Deux lanceurs concurrents ont plusieurs fois teleescope cette instance :
// PG embarque tue au boot (data dir partage), port HTTP vole (le canonique
// tournait sans bind, URL publique en 502). Ce module force des DEFAUTS
// SECONDAIRES pour tout lanceur non identifie comme canonique : seul le
// LaunchAgent officiel (dev.kantum.paperclip-server) exporte
// PAPERCLIP_INSTANCE=canonical et garde 3100 / ~/.paperclip / PG 54329.
//
// Importe en PREMIER par index.ts : les mutations d'env doivent preceder
// toute lecture de config.
import os from "node:os";
import path from "node:path";

if (process.env.PAPERCLIP_INSTANCE !== "canonical") {
  if (!process.env.PORT) process.env.PORT = "3200";
  if (!process.env.PAPERCLIP_HOME) {
    process.env.PAPERCLIP_HOME = path.join(os.homedir(), ".paperclip-dyad");
  }
  if (!process.env.PAPERCLIP_EMBEDDED_PG_PORT) {
    process.env.PAPERCLIP_EMBEDDED_PG_PORT = "54330";
  }
  console.warn(
    "[paperclip] PAPERCLIP_INSTANCE!=canonical -> defauts secondaires " +
      `(PORT=${process.env.PORT}, HOME=${process.env.PAPERCLIP_HOME}, PG=${process.env.PAPERCLIP_EMBEDDED_PG_PORT}). ` +
      "Instance primaire : exporter PAPERCLIP_INSTANCE=canonical.",
  );
}
