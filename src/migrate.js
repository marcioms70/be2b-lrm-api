/**
 * Aplica (uma vez por processo) as migrações idempotentes usadas pelos módulos em runtime.
 * As migrações são `create ... if not exists` / `add column if not exists`: podem rodar
 * quantas vezes for preciso.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { query } from "./db.js";

const FILES = ["007_meta_ads_integration.sql", "008_meta_insights_sync.sql", "009_paid_traffic_rules.sql", "010_metrics_frequency.sql"];
let ready = null;

export function ensureSchema() {
  if (!ready) {
    ready = (async () => {
      const dir = path.dirname(fileURLToPath(import.meta.url));
      for (const file of FILES) await query(fs.readFileSync(path.resolve(dir, "../migrations", file), "utf8"));
    })().catch((err) => { ready = null; throw err; }); // falhou: tenta de novo na próxima chamada
  }
  return ready;
}
