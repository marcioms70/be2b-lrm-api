import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { query } from "./db.js";
import { encryptToken, decryptToken } from "./tokenCrypto.js";

const DEFAULT_SCOPES = [
  "ads_management",
  "ads_read",
  "business_management",
  "pages_show_list",
  "pages_read_engagement",
  "instagram_basic"
];

let tablesReady = false;

function ok(res, data = {}) {
  return res.json({ success: true, ...data });
}

function fail(res, status, message, details = null) {
  return res.status(status).json({
    success: false,
    message,
    details: process.env.NODE_ENV === "production" ? undefined : details
  });
}

function getOrganizationId(req) {
  return (
    req.header("x-organization-id") ||
    req.query.organization_id ||
    req.body?.organization_id ||
    null
  );
}

function graphVersion() {
  return process.env.META_GRAPH_API_VERSION || "v21.0";
}

function graphBaseUrl() {
  return `https://graph.facebook.com/${graphVersion()}`;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} não configurada.`);
  return value;
}

function stateSecret() {
  return process.env.META_APP_SECRET || process.env.META_ENCRYPTION_KEY || "";
}

function getScopes() {
  return (process.env.META_SCOPES || DEFAULT_SCOPES.join(","))
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function getFrontendRedirectUrl(success, queryParams = {}) {
  const frontendUrl = process.env.FRONTEND_URL || process.env.APP_FRONTEND_URL;
  if (!frontendUrl) return null;

  const url = new URL(frontendUrl.replace(/\/$/, "") + "/settings");
  url.searchParams.set("tab", "integrations");
  url.searchParams.set("meta_ads", success ? "connected" : "error");

  for (const [key, value] of Object.entries(queryParams)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  return url.toString();
}

function wantsJson(req) {
  return req.query.format === "json" || req.query.mode === "json" || req.get("accept")?.includes("application/json");
}

function signState(payload) {
  const secret = stateSecret();
  if (!secret) throw new Error("META_APP_SECRET ou META_ENCRYPTION_KEY é obrigatório para gerar state OAuth.");

  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verifyState(state) {
  const secret = stateSecret();
  if (!secret) throw new Error("META_APP_SECRET ou META_ENCRYPTION_KEY é obrigatório para validar state OAuth.");

  const [encoded, signature] = String(state || "").split(".");
  if (!encoded || !signature) throw new Error("State OAuth inválido.");

  const expected = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  const receivedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (receivedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)) {
    throw new Error("Assinatura do state OAuth inválida.");
  }

  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (!payload.organization_id || !payload.ts || Date.now() - Number(payload.ts) > 30 * 60 * 1000) {
    throw new Error("State OAuth expirado ou incompleto.");
  }

  return payload;
}

async function ensureMetaAdsTables() {
  if (tablesReady) return;

  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const migrationPath = path.resolve(dirname, "../migrations/007_meta_ads_integration.sql");
  const sql = fs.readFileSync(migrationPath, "utf8");
  await query(sql);
  tablesReady = true;
}

function sanitizeConnection(connection) {
  if (!connection) return null;

  return {
    id: connection.id,
    organization_id: connection.organization_id,
    meta_user_id: connection.meta_user_id,
    business_id: connection.business_id,
    business_name: connection.business_name,
    ad_account_id: connection.ad_account_id,
    ad_account_name: connection.ad_account_name,
    page_id: connection.page_id,
    page_name: connection.page_name,
    instagram_actor_id: connection.instagram_actor_id,
    instagram_username: connection.instagram_username,
    token_type: connection.token_type,
    token_expires_at: connection.token_expires_at,
    scopes: connection.scopes || [],
    status: connection.status,
    last_error: connection.last_error,
    connected_at: connection.connected_at,
    created_at: connection.created_at,
    updated_at: connection.updated_at,
    has_access_token: Boolean(connection.access_token_encrypted)
  };
}

async function getConnection(organizationId) {
  await ensureMetaAdsTables();
  const result = await query(
    `select * from public.meta_ads_connections where organization_id = $1 limit 1`,
    [organizationId]
  );
  return result.rows[0] || null;
}

async function upsertConnection(organizationId, data) {
  await ensureMetaAdsTables();

  const result = await query(
    `
    insert into public.meta_ads_connections (
      organization_id,
      meta_user_id,
      business_id,
      business_name,
      ad_account_id,
      ad_account_name,
      page_id,
      page_name,
      instagram_actor_id,
      instagram_username,
      access_token_encrypted,
      token_type,
      token_expires_at,
      scopes,
      status,
      last_error,
      connected_at,
      updated_at
    ) values (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now()
    )
    on conflict (organization_id) do update set
      meta_user_id = excluded.meta_user_id,
      business_id = excluded.business_id,
      business_name = excluded.business_name,
      ad_account_id = excluded.ad_account_id,
      ad_account_name = excluded.ad_account_name,
      page_id = excluded.page_id,
      page_name = excluded.page_name,
      instagram_actor_id = excluded.instagram_actor_id,
      instagram_username = excluded.instagram_username,
      access_token_encrypted = coalesce(excluded.access_token_encrypted, public.meta_ads_connections.access_token_encrypted),
      token_type = coalesce(excluded.token_type, public.meta_ads_connections.token_type),
      token_expires_at = coalesce(excluded.token_expires_at, public.meta_ads_connections.token_expires_at),
      scopes = coalesce(excluded.scopes, public.meta_ads_connections.scopes),
      status = excluded.status,
      last_error = excluded.last_error,
      connected_at = coalesce(excluded.connected_at, public.meta_ads_connections.connected_at, now()),
      updated_at = now()
    returning *
    `,
    [
      organizationId,
      data.meta_user_id || null,
      data.business_id || null,
      data.business_name || null,
      data.ad_account_id || null,
      data.ad_account_name || null,
      data.page_id || null,
      data.page_name || null,
      data.instagram_actor_id || null,
      data.instagram_username || null,
      data.access_token_encrypted || null,
      data.token_type || null,
      data.token_expires_at || null,
      data.scopes || null,
      data.status || "connected",
      data.last_error || null,
      data.connected_at || new Date()
    ]
  );

  return result.rows[0];
}

async function updateConnectionStatus(organizationId, status, lastError = null) {
  await ensureMetaAdsTables();
  const result = await query(
    `
    update public.meta_ads_connections
    set status = $2, last_error = $3, updated_at = now()
    where organization_id = $1
    returning *
    `,
    [organizationId, status, lastError]
  );
  return result.rows[0] || null;
}

async function graphGet(pathname, accessToken, params = {}) {
  const url = new URL(`${graphBaseUrl()}${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message || `Erro Meta Graph API: HTTP ${response.status}`);
  }
  return body;
}

async function graphToken(params) {
  const url = new URL(`${graphBaseUrl()}/oauth/access_token`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message || `Erro ao trocar token Meta: HTTP ${response.status}`);
  }
  return body;
}

async function safeGraphGet(pathname, accessToken, params = {}) {
  try {
    return await graphGet(pathname, accessToken, params);
  } catch (error) {
    console.error(`Meta Graph ignorado em ${pathname}:`, error.message);
    return null;
  }
}

function firstData(response) {
  return Array.isArray(response?.data) ? response.data[0] : null;
}

function tokenExpiration(tokenResponse) {
  if (!tokenResponse?.expires_in) return null;
  return new Date(Date.now() + Number(tokenResponse.expires_in) * 1000);
}

async function handleStatus(req, res) {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");

    const connection = await getConnection(organizationId);
    const sanitized = sanitizeConnection(connection);

    return ok(res, {
      data: {
        connected: sanitized?.status === "connected",
        status: sanitized?.status || "pending",
        connection: sanitized
      }
    });
  } catch (error) {
    return fail(res, 500, "Não foi possível consultar o status Meta Ads.", error.message);
  }
}

async function handleOauthStart(req, res) {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");

    const appId = requiredEnv("META_APP_ID");
    requiredEnv("META_APP_SECRET");
    const redirectUri = requiredEnv("META_REDIRECT_URI");

    const state = signState({
      organization_id: organizationId,
      ts: Date.now(),
      nonce: crypto.randomBytes(16).toString("hex")
    });

    const url = new URL(`https://www.facebook.com/${graphVersion()}/dialog/oauth`);
    url.searchParams.set("client_id", appId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", getScopes().join(","));

    if (wantsJson(req)) {
      return ok(res, { data: { authorization_url: url.toString(), redirect_url: url.toString() } });
    }

    return res.redirect(302, url.toString());
  } catch (error) {
    return fail(res, 500, "Não foi possível iniciar a conexão Meta Ads.", error.message);
  }
}

async function handleOauthCallback(req, res) {
  try {
    if (req.query.error) {
      throw new Error(req.query.error_description || req.query.error || "OAuth Meta cancelado.");
    }

    const code = req.query.code;
    if (!code) return fail(res, 400, "code OAuth é obrigatório.");

    const state = verifyState(req.query.state);
    const appId = requiredEnv("META_APP_ID");
    const appSecret = requiredEnv("META_APP_SECRET");
    const redirectUri = requiredEnv("META_REDIRECT_URI");

    const shortToken = await graphToken({
      client_id: appId,
      client_secret: appSecret,
      redirect_uri: redirectUri,
      code
    });

    let finalToken = shortToken;
    try {
      finalToken = await graphToken({
        grant_type: "fb_exchange_token",
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: shortToken.access_token
      });
    } catch (exchangeError) {
      console.error("Não foi possível trocar por long-lived token:", exchangeError.message);
    }

    const accessToken = finalToken.access_token || shortToken.access_token;
    if (!accessToken) throw new Error("A Meta não retornou access_token.");

    const me = await safeGraphGet("/me", accessToken, { fields: "id,name" });
    const businesses = await safeGraphGet("/me/businesses", accessToken, { fields: "id,name", limit: 25 });
    const adAccounts = await safeGraphGet("/me/adaccounts", accessToken, { fields: "id,name,account_id,account_status", limit: 25 });
    const pages = await safeGraphGet("/me/accounts", accessToken, { fields: "id,name,instagram_business_account{id,username}", limit: 25 });

    const business = firstData(businesses);
    const adAccount = firstData(adAccounts);
    const page = firstData(pages);
    const instagram = page?.instagram_business_account || null;

    const connection = await upsertConnection(state.organization_id, {
      meta_user_id: me?.id || null,
      business_id: business?.id || null,
      business_name: business?.name || null,
      ad_account_id: adAccount?.id || (adAccount?.account_id ? `act_${adAccount.account_id}` : null),
      ad_account_name: adAccount?.name || null,
      page_id: page?.id || null,
      page_name: page?.name || null,
      instagram_actor_id: instagram?.id || null,
      instagram_username: instagram?.username || null,
      access_token_encrypted: encryptToken(accessToken),
      token_type: finalToken.token_type || shortToken.token_type || "bearer",
      token_expires_at: tokenExpiration(finalToken) || tokenExpiration(shortToken),
      scopes: getScopes(),
      status: "connected",
      last_error: null,
      connected_at: new Date()
    });

    const redirectUrl = getFrontendRedirectUrl(true, { organization_id: state.organization_id });
    if (redirectUrl) return res.redirect(302, redirectUrl);

    return ok(res, { data: { connection: sanitizeConnection(connection) } });
  } catch (error) {
    const redirectUrl = getFrontendRedirectUrl(false, { message: error.message });
    if (redirectUrl) return res.redirect(302, redirectUrl);
    return fail(res, 500, "Não foi possível concluir a conexão Meta Ads.", error.message);
  }
}

async function handleManualConnect(req, res) {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");

    const existing = await getConnection(organizationId);
    const accessTokenEncrypted = req.body.access_token
      ? encryptToken(req.body.access_token)
      : existing?.access_token_encrypted || null;

    const connection = await upsertConnection(organizationId, {
      meta_user_id: req.body.meta_user_id || existing?.meta_user_id || null,
      business_id: req.body.business_id || existing?.business_id || null,
      business_name: req.body.business_name || existing?.business_name || null,
      ad_account_id: req.body.ad_account_id || existing?.ad_account_id || null,
      ad_account_name: req.body.ad_account_name || existing?.ad_account_name || null,
      page_id: req.body.page_id || existing?.page_id || null,
      page_name: req.body.page_name || existing?.page_name || null,
      instagram_actor_id: req.body.instagram_actor_id || existing?.instagram_actor_id || null,
      instagram_username: req.body.instagram_username || existing?.instagram_username || null,
      access_token_encrypted: accessTokenEncrypted,
      token_type: req.body.access_token ? "bearer" : existing?.token_type || null,
      token_expires_at: req.body.token_expires_at || existing?.token_expires_at || null,
      scopes: req.body.scopes || existing?.scopes || null,
      status: req.body.status || "connected",
      last_error: null,
      connected_at: existing?.connected_at || new Date()
    });

    return ok(res, { data: { connection: sanitizeConnection(connection) } });
  } catch (error) {
    return fail(res, 500, "Não foi possível salvar a conexão Meta Ads.", error.message);
  }
}

async function handleDisconnect(req, res) {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");

    const connection = await updateConnectionStatus(organizationId, "disconnected", null);
    return ok(res, { data: { connection: sanitizeConnection(connection), disconnected: true } });
  } catch (error) {
    return fail(res, 500, "Não foi possível desconectar Meta Ads.", error.message);
  }
}

async function handleTestConnection(req, res) {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");

    const connection = await getConnection(organizationId);
    if (!connection) return fail(res, 404, "Conexão Meta Ads não encontrada.");
    if (!connection.access_token_encrypted) {
      const updated = await updateConnectionStatus(organizationId, "needs_reconnect", "Conexão sem access_token.");
      return fail(res, 400, "Conexão Meta Ads sem access_token. Reconecte a conta Meta.", sanitizeConnection(updated));
    }

    const token = decryptToken(connection.access_token_encrypted);
    const me = await graphGet("/me", token, { fields: "id,name" });
    const updated = await updateConnectionStatus(organizationId, "connected", null);

    return ok(res, {
      data: {
        status: "connected",
        message: "Conexão Meta Ads validada com sucesso.",
        meta_user: me,
        connection: sanitizeConnection(updated)
      }
    });
  } catch (error) {
    const organizationId = getOrganizationId(req);
    if (organizationId) {
      await updateConnectionStatus(organizationId, "needs_reconnect", error.message).catch(() => null);
    }
    return fail(res, 500, "Não foi possível testar a conexão Meta Ads.", error.message);
  }
}

function missingConfig(connection) {
  const missing = [];
  if (!connection) return ["connection"];
  if (connection.status !== "connected") missing.push("status_connected");
  if (!connection.business_id) missing.push("business_id");
  if (!connection.ad_account_id) missing.push("ad_account_id");
  if (!connection.page_id) missing.push("page_id");
  if (!connection.instagram_actor_id) missing.push("instagram_actor_id");
  if (!connection.access_token_encrypted) missing.push("access_token");
  return missing;
}

async function handleConfigOptions(req, res) {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");

    const connection = await getConnection(organizationId);
    const sanitized = sanitizeConnection(connection);
    const missing = missingConfig(connection);

    return ok(res, {
      data: {
        connection_status: sanitized?.status || "pending",
        business: sanitized?.business_id ? { id: sanitized.business_id, name: sanitized.business_name } : null,
        ad_account: sanitized?.ad_account_id ? { id: sanitized.ad_account_id, name: sanitized.ad_account_name } : null,
        page: sanitized?.page_id ? { id: sanitized.page_id, name: sanitized.page_name } : null,
        instagram: sanitized?.instagram_actor_id ? { id: sanitized.instagram_actor_id, username: sanitized.instagram_username } : null,
        can_publish: missing.length === 0,
        missing,
        connection: sanitized
      }
    });
  } catch (error) {
    return fail(res, 500, "Não foi possível carregar opções Meta Ads.", error.message);
  }
}

async function getCampaign(organizationId, campaignId) {
  const result = await query(
    `select * from public.paid_traffic_campaigns where id = $1 and organization_id = $2 limit 1`,
    [campaignId, organizationId]
  );
  return result.rows[0] || null;
}

function validateCampaignForMeta(campaign) {
  const missing = [];
  const warnings = [];

  if (!campaign.name) missing.push("name");
  if (!campaign.tracking_code) missing.push("tracking_code");
  if (!campaign.daily_budget && !campaign.total_budget) warnings.push("budget");
  if (!campaign.ad_primary_text) warnings.push("ad_primary_text");
  if (!campaign.cta) warnings.push("cta");

  return { missing, warnings };
}

async function handlePublishCampaign(req, res) {
  try {
    await ensureMetaAdsTables();

    const organizationId = getOrganizationId(req);
    const campaignId = req.body.campaign_id || req.query.campaign_id;

    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");
    if (!campaignId) return fail(res, 400, "campaign_id é obrigatório.");

    const campaign = await getCampaign(organizationId, campaignId);
    if (!campaign) return fail(res, 404, "Campanha não encontrada.");

    const connection = await getConnection(organizationId);
    if (!connection || connection.status !== "connected") {
      return fail(res, 400, "Conecte uma conta Meta Ads antes de publicar no Instagram.");
    }

    if (!connection.ad_account_id) {
      return fail(res, 400, "Complete a conexão Meta Ads informando a Conta de Anúncios.");
    }

    if (!connection.page_id && !connection.instagram_actor_id) {
      return fail(res, 400, "Complete a conexão Meta Ads informando Página Facebook ou Conta Instagram profissional.");
    }

    const campaignValidation = validateCampaignForMeta(campaign);
    if (campaignValidation.missing.length > 0) {
      return fail(res, 400, "Campanha incompleta para publicação no Instagram.", {
        missing: campaignValidation.missing
      });
    }

    const readyForMetaPublish = missingConfig(connection).length === 0;
    const requestPayload = {
      organization_id: organizationId,
      campaign_id: campaignId,
      connection_id: connection.id,
      campaign_tracking_code: campaign.tracking_code,
      link_url: `https://api.be2b.tech/r/${campaign.tracking_code}`,
      validation: {
        missing: campaignValidation.missing,
        warnings: campaignValidation.warnings,
        ready_for_meta_publish: readyForMetaPublish,
        missing_connection_config: missingConfig(connection)
      }
    };

    const job = await query(
      `
      insert into public.meta_ads_publish_jobs (
        organization_id,
        campaign_id,
        connection_id,
        status,
        request_payload,
        started_at,
        finished_at,
        response_payload
      ) values ($1, $2, $3, 'pending', $4::jsonb, now(), now(), $5::jsonb)
      returning *
      `,
      [
        organizationId,
        campaignId,
        connection.id,
        JSON.stringify(requestPayload),
        JSON.stringify({ message: "Preparado para Fase 7B. Publicação real ainda não executada." })
      ]
    );

    const publication = await query(
      `
      insert into public.meta_ads_campaign_publications (
        organization_id,
        campaign_id,
        connection_id,
        publish_job_id,
        status,
        raw_response,
        updated_at
      ) values ($1, $2, $3, $4, 'draft', $5::jsonb, now())
      on conflict (organization_id, campaign_id) do update set
        connection_id = excluded.connection_id,
        publish_job_id = excluded.publish_job_id,
        status = 'draft',
        raw_response = excluded.raw_response,
        last_error = null,
        updated_at = now()
      returning *
      `,
      [
        organizationId,
        campaignId,
        connection.id,
        job.rows[0].id,
        JSON.stringify({ phase: "7A", ready_for_meta_publish: readyForMetaPublish })
      ]
    );

    return ok(res, {
      message: "Campanha validada e preparada para publicação. Publicação real na Meta Ads será executada na Fase 7B.",
      data: {
        campaign_id: campaignId,
        publish_job_id: job.rows[0].id,
        publication_id: publication.rows[0].id,
        publication_status: publication.rows[0].status,
        ready_for_meta_publish: readyForMetaPublish,
        missing_connection_config: missingConfig(connection),
        warnings: campaignValidation.warnings,
        link_url: requestPayload.link_url
      }
    });
  } catch (error) {
    return fail(res, 500, "Não foi possível preparar a publicação Meta Ads.", error.message);
  }
}

function registerMetaAdsRoutes(app) {
  if (app.__be2bMetaAdsRegistered) return;
  app.__be2bMetaAdsRegistered = true;

  const stackBefore = app._router?.stack?.length || 0;

  app.get("/api/meta-ads/status", handleStatus);
  app.get("/api/meta-ads/oauth/start", handleOauthStart);
  app.get("/api/meta-ads/oauth/callback", handleOauthCallback);
  app.post("/api/meta-ads/connect/manual", handleManualConnect);
  app.post("/api/meta-ads/disconnect", handleDisconnect);
  app.post("/api/meta-ads/test-connection", handleTestConnection);
  app.post("/api/meta-ads/publish-campaign", handlePublishCampaign);
  app.get("/api/meta-ads/config-options", handleConfigOptions);

  const stack = app._router?.stack;
  if (!stack || stack.length <= stackBefore) return;

  const previousLayers = stack.slice(0, stackBefore);
  const addedLayers = stack.slice(stackBefore);
  const fallbackIndex = Math.max(previousLayers.length - 1, 0);

  stack.splice(
    0,
    stack.length,
    ...previousLayers.slice(0, fallbackIndex),
    ...addedLayers,
    ...previousLayers.slice(fallbackIndex)
  );
}

if (!express.application.__be2bMetaAdsPatched) {
  express.application.__be2bMetaAdsPatched = true;
  const originalListen = express.application.listen;

  express.application.listen = function patchedListen(...args) {
    registerMetaAdsRoutes(this);
    return originalListen.apply(this, args);
  };
}
