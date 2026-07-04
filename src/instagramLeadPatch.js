import express from "express";
import { query } from "./db.js";

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

function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")?.[0]?.trim() ||
    req.socket?.remoteAddress ||
    null
  );
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeTrackingCode(value) {
  return String(value || "").trim().toUpperCase();
}

function encodeMessage(message) {
  return encodeURIComponent(message || "");
}

function buildInstagramMessage(campaign) {
  return (
    campaign.whatsapp_prefilled_message ||
    `Olá, vi o anúncio no Instagram e quero saber mais. Código: ${campaign.tracking_code}`
  );
}

function buildWhatsappUrl(campaign) {
  if (campaign.whatsapp_tracking_url) return campaign.whatsapp_tracking_url;

  const destination = onlyDigits(campaign.whatsapp_destination);
  if (!destination) return null;

  const message = buildInstagramMessage(campaign);
  return `https://wa.me/${destination}?text=${encodeMessage(message)}`;
}

async function findCampaignByTrackingCode(trackingCode, organizationId = null) {
  const normalized = normalizeTrackingCode(trackingCode);
  if (!normalized) return null;

  const params = [normalized];
  let orgFilter = "";

  if (organizationId) {
    params.push(organizationId);
    orgFilter = ` and organization_id = $${params.length}`;
  }

  const result = await query(
    `
    select *
    from public.paid_traffic_campaigns
    where upper(tracking_code) = $1
      ${orgFilter}
    limit 1
    `,
    params
  );

  return result.rows[0] || null;
}

async function addHistory({ campaignId, organizationId, eventType, description, metadata = {} }) {
  try {
    await query(
      `
      insert into public.paid_traffic_history (
        campaign_id,
        organization_id,
        event_type,
        description,
        metadata
      ) values ($1, $2, $3, $4, $5::jsonb)
      `,
      [campaignId, organizationId, eventType, description, JSON.stringify(metadata)]
    );
  } catch (error) {
    console.error("Erro ao gravar histórico Instagram:", error.message);
  }
}

async function registerInstagramClick(req, campaign, whatsappUrl) {
  await addHistory({
    campaignId: campaign.id,
    organizationId: campaign.organization_id,
    eventType: "instagram_link_clicked",
    description: `Clique no link rastreável do Instagram: ${campaign.tracking_code}.`,
    metadata: {
      tracking_code: campaign.tracking_code,
      source_platform: "instagram",
      source_channel: "instagram_ads",
      whatsapp_url: whatsappUrl,
      referrer: req.get("referer") || null,
      user_agent: req.get("user-agent") || null,
      ip: getClientIp(req)
    }
  });
}

async function handleInstagramRedirect(req, res) {
  try {
    const trackingCode = req.params.trackingCode || req.query.tracking_code;
    const campaign = await findCampaignByTrackingCode(trackingCode);

    if (!campaign) {
      return fail(res, 404, "Campanha não encontrada para este código de rastreamento.");
    }

    const whatsappUrl = buildWhatsappUrl(campaign);
    if (!whatsappUrl) {
      return fail(res, 400, "Campanha sem WhatsApp de destino configurado.");
    }

    await registerInstagramClick(req, campaign, whatsappUrl);
    return res.redirect(302, whatsappUrl);
  } catch (error) {
    return fail(res, 500, "Não foi possível redirecionar para o WhatsApp.", error.message);
  }
}

async function handleInstagramResolve(req, res) {
  try {
    const trackingCode = req.params.trackingCode || req.query.tracking_code;
    const organizationId = req.header("x-organization-id") || req.query.organization_id || null;
    const campaign = await findCampaignByTrackingCode(trackingCode, organizationId);

    if (!campaign) {
      return fail(res, 404, "Campanha não encontrada para este código de rastreamento.");
    }

    return ok(res, {
      data: {
        campaign,
        tracking_code: campaign.tracking_code,
        whatsapp_url: buildWhatsappUrl(campaign),
        source_platform: "instagram",
        source_channel: "instagram_ads"
      }
    });
  } catch (error) {
    return fail(res, 500, "Não foi possível resolver a campanha.", error.message);
  }
}

async function handleInboundLead(req, res) {
  try {
    const body = req.body || {};
    const trackingCode = normalizeTrackingCode(body.tracking_code || body.trackingCode);
    const phone = onlyDigits(body.phone || body.telefone || body.from || body.remote_jid);
    const organizationId = body.organization_id || req.header("x-organization-id") || null;

    if (!trackingCode) return fail(res, 400, "tracking_code é obrigatório.");
    if (!phone) return fail(res, 400, "phone é obrigatório.");

    const campaign = await findCampaignByTrackingCode(trackingCode, organizationId);
    if (!campaign) return fail(res, 404, "Campanha não encontrada para este código de rastreamento.");

    const sourcePlatform = body.source_platform || "instagram";
    const sourceChannel = body.source_channel || "instagram_ads";
    const initialStatus = body.status || "novo";
    const initialTemperature = body.temperature || campaign.initial_lead_temperature || "frio";

    const existing = await query(
      `
      select *
      from public.paid_traffic_leads
      where campaign_id = $1
        and organization_id = $2
        and phone = $3
      order by created_at desc
      limit 1
      `,
      [campaign.id, campaign.organization_id, phone]
    );

    if (existing.rowCount > 0) {
      const current = existing.rows[0];
      const notesToAppend = body.message
        ? `\n[${new Date().toISOString()}] Nova interação Instagram/WhatsApp: ${body.message}`
        : "";

      const updated = await query(
        `
        update public.paid_traffic_leads
        set
          name = coalesce($1, name),
          email = coalesce($2, email),
          company = coalesce($3, company),
          source_platform = coalesce($4, source_platform),
          source_channel = coalesce($5, source_channel),
          source_url = coalesce($6, source_url),
          last_interaction_at = now(),
          notes = trim(coalesce(notes, '') || $7)
        where id = $8
          and organization_id = $9
        returning *
        `,
        [
          body.name || null,
          body.email || null,
          body.company || null,
          sourcePlatform,
          sourceChannel,
          body.source_url || body.referrer || null,
          notesToAppend,
          current.id,
          campaign.organization_id
        ]
      );

      await addHistory({
        campaignId: campaign.id,
        organizationId: campaign.organization_id,
        eventType: "instagram_lead_updated",
        description: `Lead ${updated.rows[0].name || phone} retornou pelo Instagram/WhatsApp.`,
        metadata: {
          lead_id: updated.rows[0].id,
          phone,
          tracking_code: trackingCode,
          source_platform: sourcePlatform,
          source_channel: sourceChannel
        }
      });

      return ok(res, { data: updated.rows[0], created: false });
    }

    const created = await query(
      `
      insert into public.paid_traffic_leads (
        organization_id,
        campaign_id,
        name,
        phone,
        email,
        company,
        source_platform,
        source_channel,
        source_url,
        tracking_code,
        utm_source,
        utm_medium,
        utm_campaign,
        utm_content,
        utm_term,
        status,
        temperature,
        first_contact_at,
        last_interaction_at,
        notes
      ) values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,$17,now(),now(),$18
      ) returning *
      `,
      [
        campaign.organization_id,
        campaign.id,
        body.name || null,
        phone,
        body.email || null,
        body.company || null,
        sourcePlatform,
        sourceChannel,
        body.source_url || body.referrer || null,
        trackingCode,
        body.utm_source || campaign.utm_source || "instagram",
        body.utm_medium || campaign.utm_medium || "paid_social",
        body.utm_campaign || campaign.utm_campaign || trackingCode,
        body.utm_content || campaign.utm_content || null,
        body.utm_term || campaign.utm_term || null,
        initialStatus,
        initialTemperature,
        body.message ? `[${new Date().toISOString()}] ${body.message}` : body.notes || null
      ]
    );

    await addHistory({
      campaignId: campaign.id,
      organizationId: campaign.organization_id,
      eventType: "instagram_lead_created",
      description: `Lead ${created.rows[0].name || phone} criado a partir do Instagram.`,
      metadata: {
        lead_id: created.rows[0].id,
        phone,
        tracking_code: trackingCode,
        source_platform: sourcePlatform,
        source_channel: sourceChannel
      }
    });

    return ok(res, { data: created.rows[0], created: true });
  } catch (error) {
    return fail(res, 500, "Não foi possível registrar o lead de entrada.", error.message);
  }
}

function registerInstagramLeadRoutes(app) {
  if (app.__be2bInstagramLeadRegistered) return;
  app.__be2bInstagramLeadRegistered = true;

  const stackBefore = app._router?.stack?.length || 0;

  app.get("/r/:trackingCode", handleInstagramRedirect);
  app.get("/api/paid-traffic/instagram/redirect/:trackingCode", handleInstagramRedirect);
  app.get("/api/paid-traffic/instagram/campaign/:trackingCode", handleInstagramResolve);
  app.post("/api/paid-traffic/inbound-lead", handleInboundLead);
  app.post("/api/paid-traffic/instagram/inbound-lead", handleInboundLead);
  app.post("/api/paid-traffic/instagram/whatsapp-message", handleInboundLead);

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

if (!express.application.__be2bInstagramLeadPatched) {
  express.application.__be2bInstagramLeadPatched = true;
  const originalListen = express.application.listen;

  express.application.listen = function patchedListen(...args) {
    registerInstagramLeadRoutes(this);
    return originalListen.apply(this, args);
  };
}
