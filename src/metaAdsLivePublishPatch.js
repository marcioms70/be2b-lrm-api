import express from "express";
import { query } from "./db.js";
import { decryptToken } from "./tokenCrypto.js";

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
  return req.header("x-organization-id") || req.query.organization_id || req.body?.organization_id || null;
}

function graphVersion() {
  return process.env.META_GRAPH_API_VERSION || "v21.0";
}

function graphBaseUrl() {
  return `https://graph.facebook.com/${graphVersion()}`;
}

function buildTrackingLink(campaign) {
  const publicBaseUrl = process.env.PUBLIC_API_BASE_URL || "https://api.be2b.tech";
  return `${publicBaseUrl.replace(/\/$/, "")}/r/${campaign.tracking_code}`;
}

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function budgetToCents(campaign) {
  const daily = toNumber(campaign.daily_budget, 0);
  const total = toNumber(campaign.total_budget, 0);
  const value = daily > 0 ? daily : total > 0 ? Math.max(total / 7, 10) : 10;
  return Math.max(Math.round(value * 100), 500);
}

function normalizeStatus(req) {
  return req.body?.activate === true || req.body?.status === "ACTIVE" ? "ACTIVE" : "PAUSED";
}

function normalizeCta(cta) {
  const value = String(cta || "").trim().toUpperCase();
  const map = {
    SAIBA_MAIS: "LEARN_MORE",
    LEARN_MORE: "LEARN_MORE",
    ENVIAR_MENSAGEM: "MESSAGE_PAGE",
    MESSAGE_PAGE: "MESSAGE_PAGE",
    CONTATO: "CONTACT_US",
    CONTACT_US: "CONTACT_US",
    CADASTRE_SE: "SIGN_UP",
    SIGN_UP: "SIGN_UP"
  };
  return map[value] || "LEARN_MORE";
}

async function graphPost(pathname, accessToken, payload = {}) {
  const url = new URL(`${graphBaseUrl()}${pathname}`);
  url.searchParams.set("access_token", accessToken);

  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "object") form.set(key, JSON.stringify(value));
    else form.set(key, String(value));
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message || `Erro Meta Graph API: HTTP ${response.status}`);
  }
  return body;
}

async function getCampaign(organizationId, campaignId) {
  const result = await query(
    `select * from public.paid_traffic_campaigns where id = $1 and organization_id = $2 limit 1`,
    [campaignId, organizationId]
  );
  return result.rows[0] || null;
}

async function getConnection(organizationId) {
  const result = await query(
    `select * from public.meta_ads_connections where organization_id = $1 and status = 'connected' limit 1`,
    [organizationId]
  );
  return result.rows[0] || null;
}

function validateReady(campaign, connection) {
  const missing = [];
  if (!campaign) missing.push("campaign");
  if (!connection) missing.push("connection");
  if (campaign && !campaign.name) missing.push("campaign.name");
  if (campaign && !campaign.tracking_code) missing.push("campaign.tracking_code");
  if (campaign && !campaign.ad_primary_text) missing.push("campaign.ad_primary_text");
  if (connection && !connection.ad_account_id) missing.push("connection.ad_account_id");
  if (connection && !connection.page_id) missing.push("connection.page_id");
  if (connection && !connection.access_token_encrypted) missing.push("connection.access_token");
  return missing;
}

function buildTargeting(campaign) {
  const countries = [String(campaign.country || "BR").toUpperCase()];
  return {
    geo_locations: { countries },
    age_min: Number(campaign.min_age) || 18,
    age_max: Number(campaign.max_age) || 65
  };
}

async function createMetaObjects({ campaign, connection, accessToken, status }) {
  const linkUrl = buildTrackingLink(campaign);
  const baseName = campaign.name || `Campanha ${campaign.tracking_code}`;
  const adAccountPath = `/${connection.ad_account_id}`;

  const metaCampaign = await graphPost(`${adAccountPath}/campaigns`, accessToken, {
    name: baseName,
    objective: "OUTCOME_TRAFFIC",
    status,
    special_ad_categories: []
  });

  const adSet = await graphPost(`${adAccountPath}/adsets`, accessToken, {
    name: `${baseName} - Conjunto`,
    campaign_id: metaCampaign.id,
    daily_budget: budgetToCents(campaign),
    billing_event: "IMPRESSIONS",
    optimization_goal: "LINK_CLICKS",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    destination_type: "WEBSITE",
    targeting: buildTargeting(campaign),
    status
  });

  const creative = await graphPost(`${adAccountPath}/adcreatives`, accessToken, {
    name: `${baseName} - Criativo`,
    object_story_spec: {
      page_id: connection.page_id,
      instagram_actor_id: connection.instagram_actor_id || undefined,
      link_data: {
        link: linkUrl,
        message: campaign.ad_primary_text,
        name: campaign.ad_title || baseName,
        call_to_action: {
          type: normalizeCta(campaign.cta),
          value: { link: linkUrl }
        }
      }
    }
  });

  const ad = await graphPost(`${adAccountPath}/ads`, accessToken, {
    name: `${baseName} - Anúncio`,
    adset_id: adSet.id,
    creative: { creative_id: creative.id },
    status
  });

  return {
    link_url: linkUrl,
    meta_campaign_id: metaCampaign.id,
    meta_adset_id: adSet.id,
    meta_creative_id: creative.id,
    meta_ad_id: ad.id,
    requested_status: status,
    meta: {
      campaign: metaCampaign,
      adset: adSet,
      creative,
      ad
    }
  };
}

async function handleLivePublish(req, res) {
  let jobId = null;
  let organizationId = null;
  let campaignId = null;

  try {
    organizationId = getOrganizationId(req);
    campaignId = req.body?.campaign_id || req.query.campaign_id;

    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");
    if (!campaignId) return fail(res, 400, "campaign_id é obrigatório.");

    const campaign = await getCampaign(organizationId, campaignId);
    const connection = await getConnection(organizationId);
    const missing = validateReady(campaign, connection);

    if (missing.length > 0) {
      return fail(res, 400, "Configuração incompleta para publicar na Meta Ads.", { missing });
    }

    const job = await query(
      `
      insert into public.meta_ads_publish_jobs (
        organization_id, campaign_id, connection_id, status, request_payload, started_at
      ) values ($1, $2, $3, 'running', $4::jsonb, now())
      returning *
      `,
      [organizationId, campaignId, connection.id, JSON.stringify({ mode: "live", activate: req.body?.activate === true })]
    );
    jobId = job.rows[0].id;

    await query(
      `
      insert into public.meta_ads_campaign_publications (
        organization_id, campaign_id, connection_id, publish_job_id, status, raw_response, updated_at
      ) values ($1, $2, $3, $4, 'publishing', $5::jsonb, now())
      on conflict (organization_id, campaign_id) do update set
        connection_id = excluded.connection_id,
        publish_job_id = excluded.publish_job_id,
        status = 'publishing',
        last_error = null,
        raw_response = excluded.raw_response,
        updated_at = now()
      `,
      [organizationId, campaignId, connection.id, jobId, JSON.stringify({ mode: "live", started_at: new Date().toISOString() })]
    );

    const accessToken = decryptToken(connection.access_token_encrypted);
    const status = normalizeStatus(req);
    const result = await createMetaObjects({ campaign, connection, accessToken, status });
    const publicationStatus = status === "ACTIVE" ? "published" : "paused";

    await query(
      `
      update public.meta_ads_publish_jobs
      set status = 'success', response_payload = $1::jsonb, finished_at = now(), updated_at = now()
      where id = $2
      `,
      [JSON.stringify(result), jobId]
    );

    const publication = await query(
      `
      update public.meta_ads_campaign_publications
      set
        meta_campaign_id = $1,
        meta_adset_id = $2,
        meta_creative_id = $3,
        meta_ad_id = $4,
        status = $5,
        published_at = coalesce(published_at, now()),
        raw_response = $6::jsonb,
        last_error = null,
        updated_at = now()
      where organization_id = $7 and campaign_id = $8
      returning *
      `,
      [
        result.meta_campaign_id,
        result.meta_adset_id,
        result.meta_creative_id,
        result.meta_ad_id,
        publicationStatus,
        JSON.stringify(result),
        organizationId,
        campaignId
      ]
    );

    return ok(res, {
      message: status === "ACTIVE"
        ? "Campanha publicada na Meta Ads com status ACTIVE."
        : "Campanha criada na Meta Ads em PAUSED, sem ativar gasto.",
      data: {
        campaign_id: campaignId,
        publish_job_id: jobId,
        publication_id: publication.rows[0]?.id || null,
        publication_status: publicationStatus,
        link_url: result.link_url,
        meta_campaign_id: result.meta_campaign_id,
        meta_adset_id: result.meta_adset_id,
        meta_creative_id: result.meta_creative_id,
        meta_ad_id: result.meta_ad_id,
        requested_status: status
      }
    });
  } catch (error) {
    if (jobId) {
      await query(
        `update public.meta_ads_publish_jobs set status = 'error', error_message = $1, finished_at = now(), updated_at = now() where id = $2`,
        [error.message, jobId]
      ).catch(() => null);
    }

    if (organizationId && campaignId) {
      await query(
        `
        update public.meta_ads_campaign_publications
        set status = 'failed', last_error = $1, updated_at = now()
        where organization_id = $2 and campaign_id = $3
        `,
        [error.message, organizationId, campaignId]
      ).catch(() => null);
    }

    return fail(res, 500, "Não foi possível publicar a campanha real na Meta Ads.", error.message);
  }
}

function registerMetaAdsLiveRoutes(app) {
  if (app.__be2bMetaAdsLiveRegistered) return;
  app.__be2bMetaAdsLiveRegistered = true;

  const stackBefore = app._router?.stack?.length || 0;
  app.post("/api/meta-ads/publish-campaign-live", handleLivePublish);

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

if (!express.application.__be2bMetaAdsLivePatched) {
  express.application.__be2bMetaAdsLivePatched = true;
  const originalListen = express.application.listen;

  express.application.listen = function patchedListen(...args) {
    registerMetaAdsLiveRoutes(this);
    return originalListen.apply(this, args);
  };
}
