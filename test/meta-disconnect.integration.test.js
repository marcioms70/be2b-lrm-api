/**
 * "Desconectar" apaga de verdade o token e a escolha gravada (Postgres REAL; só roda com TEST_DATABASE_URL):
 *   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/lrm_test npm test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL;
const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
let query, disconnectConnection;

before(async () => {
  if (skip) return;
  process.env.DATABASE_URL = DB_URL; process.env.META_ENCRYPTION_KEY = "chave-de-teste"; process.env.NODE_ENV = "test";
  ({ query } = await import("../src/db.js"));
  for (const f of ["007_meta_ads_integration.sql", "013_meta_ads_selection.sql"]) await query(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  ({ disconnectConnection } = await import("../src/metaAdsPatch.js"));
  await query(`delete from public.meta_ads_connections where organization_id in ($1,$2)`, [ORG, OTHER]);
});
after(async () => {
  if (skip) return;
  await query(`delete from public.meta_ads_connections where organization_id in ($1,$2)`, [ORG, OTHER]);
  (await import("../src/db.js")).pool.end();
});

const seed = (org) => query(
  `insert into public.meta_ads_connections (organization_id, meta_user_id, business_id, business_name, ad_account_id, ad_account_name, page_id, page_name,
     instagram_actor_id, instagram_username, access_token_encrypted, token_type, token_expires_at, scopes, status, connected_at, selection_confirmed_at)
   values ($1,'u1','1610491439097515','Be2B Tecnologia','act_3639337402278','Marcio Mendes','p1','Pg','ig1','igu','TOKEN-CIFRADO','bearer', now() + interval '60 days', '{ads_management}', 'connected', now(), now())`, [org]);

test("desconectar apaga token e a escolha gravada (nada de Be2B 'sobrando'), mas mantém a linha da empresa", { skip }, async () => {
  await seed(ORG); await seed(OTHER);
  const row = await disconnectConnection(ORG);
  assert.equal(row.status, "disconnected");
  for (const k of ["access_token_encrypted", "token_type", "token_expires_at", "scopes", "meta_user_id", "business_id", "business_name", "ad_account_id", "ad_account_name",
    "page_id", "page_name", "instagram_actor_id", "instagram_username", "selection_confirmed_at", "connected_at", "last_error"]) assert.equal(row[k], null, k);
  assert.equal(row.organization_id, ORG);
});

test("desconectar uma empresa NÃO mexe nas outras", { skip }, async () => {
  const other = (await query(`select * from public.meta_ads_connections where organization_id = $1`, [OTHER])).rows[0];
  assert.equal(other.status, "connected"); assert.equal(other.ad_account_id, "act_3639337402278"); assert.equal(other.access_token_encrypted, "TOKEN-CIFRADO");
});

test("desconectar empresa sem conexão devolve null (sem erro)", { skip }, async () => {
  assert.equal(await disconnectConnection("cccccccc-cccc-4ccc-8ccc-cccccccccccc"), null);
});

test("migração 014: limpa conexões JÁ desconectadas (token e conta antigos) e não mexe nas conectadas nem nas já limpas", { skip }, async () => {
  const OLD = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
  await query(`delete from public.meta_ads_connections where organization_id in ($1,$2)`, [OLD, ORG]);
  await seed(OLD); await query(`update public.meta_ads_connections set status = 'disconnected' where organization_id = $1`, [OLD]);   // como o botão antigo deixava
  await seed(ORG);                                                                                                                 // conectada: não pode ser tocada
  const sql = readFileSync(new URL("../migrations/014_meta_ads_purge_disconnected.sql", import.meta.url), "utf8");
  await query(sql); await query(sql);   // idempotente
  const old = (await query(`select * from public.meta_ads_connections where organization_id = $1`, [OLD])).rows[0];
  assert.equal(old.status, "disconnected");
  for (const k of ["access_token_encrypted", "business_id", "business_name", "ad_account_id", "ad_account_name", "page_id", "instagram_actor_id", "meta_user_id", "connected_at", "token_expires_at", "scopes"]) assert.equal(old[k], null, k);
  const live = (await query(`select * from public.meta_ads_connections where organization_id = $1`, [ORG])).rows[0];
  assert.equal(live.status, "connected"); assert.equal(live.ad_account_id, "act_3639337402278"); assert.equal(live.access_token_encrypted, "TOKEN-CIFRADO");
  await query(`delete from public.meta_ads_connections where organization_id = $1`, [OLD]);
});
