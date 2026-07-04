import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { pool, query } from "./db.js";

dotenv.config();

const app = express();

const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

const corsOptions =
  CORS_ORIGIN === "*"
    ? { origin: "*" }
    : {
        origin: CORS_ORIGIN.split(",").map((origin) => origin.trim()),
        credentials: true
      };

app.use(cors(corsOptions));
app.use(express.json({ limit: "2mb" }));

function ok(res, data = {}) {
  return res.json({
    success: true,
    ...data
  });
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
    req.body.organization_id ||
    null
  );
}

function generateTrackingCode() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();

  return `TP-${y}${m}${d}-${random}`;
}

function safeNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function calcMetricRates({ amount_spent, leads, impressions, clicks }) {
  const spent = safeNumber(amount_spent);
  const totalLeads = safeNumber(leads);
  const totalImpressions = safeNumber(impressions);
  const totalClicks = safeNumber(clicks);

  return {
    cpl: totalLeads > 0 ? spent / totalLeads : null,
    ctr: totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : null,
    cpc: totalClicks > 0 ? spent / totalClicks : null
  };
}

async function addHistory({
  campaignId,
  organizationId,
  eventType,
  description,
  metadata = {},
  createdBy = null
}) {
  await query(
    `
    insert into public.paid_traffic_history (
      campaign_id,
      organization_id,
      event_type,
      description,
      metadata,
      created_by
    )
    values ($1, $2, $3, $4, $5::jsonb, $6)
    `,
    [
      campaignId,
      organizationId,
      eventType,
      description,
      JSON.stringify(metadata),
      createdBy
    ]
  );
}

const campaignFields = [
  "name",
  "product_service",
  "objective",
  "platform",
  "status",
  "start_date",
  "end_date",
  "budget_type",
  "daily_budget",
  "total_budget",
  "current_balance",
  "min_balance_alert",
  "budget_notes",
  "target_audience",
  "min_age",
  "max_age",
  "gender",
  "interests",
  "segment",
  "job_role",
  "company_type",
  "intent_level",
  "country",
  "state",
  "city",
  "radius_km",
  "included_regions",
  "excluded_regions",
  "ad_title",
  "ad_primary_text",
  "ad_short_call",
  "cta",
  "creative_notes",
  "agent_id",
  "whatsapp_instance_id",
  "whatsapp_destination",
  "initial_bdr_message",
  "initial_lead_temperature",
  "send_to_crm_when_qualified",
  "tracking_code",
  "whatsapp_prefilled_message",
  "whatsapp_tracking_url",
  "landing_page_url",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "created_by"
];

app.get("/health", async (req, res) => {
  try {
    const db = await query("select now() as now");

    return ok(res, {
      service: "be2b-lrm-api",
      status: "online",
      database: "connected",
      time: db.rows[0].now
    });
  } catch (error) {
    return fail(res, 500, "API online, mas sem conexão com o banco.", error.message);
  }
});

/* =========================================================
   CAMPANHAS
========================================================= */

app.get("/api/paid-traffic/campaigns", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);

    if (!organizationId) {
      return fail(res, 400, "organization_id é obrigatório.");
    }

    const result = await query(
      `
      select
        c.*,

        coalesce(l.total_leads, 0)::int as leads_count,
        coalesce(l.qualified_leads, 0)::int as qualified_count,
        coalesce(l.hot_leads, 0)::int as hot_count,
        coalesce(l.crm_leads, 0)::int as sent_crm_count,

        coalesce(m.total_spent, 0)::numeric as total_spent,
        coalesce(m.metric_leads, 0)::int as metric_leads,

        case
          when coalesce(m.metric_leads, 0) > 0
          then round((coalesce(m.total_spent, 0) / m.metric_leads)::numeric, 2)
          else null
        end as avg_cpl

      from public.paid_traffic_campaigns c

      left join (
        select
          campaign_id,
          count(*) as total_leads,
          count(*) filter (where status = 'qualificado') as qualified_leads,
          count(*) filter (where temperature = 'quente' or status = 'quente') as hot_leads,
          count(*) filter (where status = 'enviado_crm') as crm_leads
        from public.paid_traffic_leads
        where organization_id = $1
        group by campaign_id
      ) l on l.campaign_id = c.id

      left join (
        select
          campaign_id,
          sum(amount_spent) as total_spent,
          sum(leads) as metric_leads
        from public.paid_traffic_metrics
        where organization_id = $1
        group by campaign_id
      ) m on m.campaign_id = c.id

      where c.organization_id = $1
      order by c.created_at desc
      `,
      [organizationId]
    );

    return ok(res, { data: result.rows });
  } catch (error) {
    return fail(res, 500, "Não foi possível carregar as campanhas.", error.message);
  }
});

app.get("/api/paid-traffic/campaigns/:id", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    const { id } = req.params;

    if (!organizationId) {
      return fail(res, 400, "organization_id é obrigatório.");
    }

    const result = await query(
      `
      select *
      from public.paid_traffic_campaigns
      where id = $1
        and organization_id = $2
      limit 1
      `,
      [id, organizationId]
    );

    if (result.rowCount === 0) {
      return fail(res, 404, "Campanha não encontrada.");
    }

    return ok(res, { data: result.rows[0] });
  } catch (error) {
    return fail(res, 500, "Não foi possível carregar a campanha.", error.message);
  }
});

app.post("/api/paid-traffic/campaigns", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    const body = req.body;

    if (!organizationId) {
      return fail(res, 400, "organization_id é obrigatório.");
    }

    if (!body.name || !body.objective || !body.platform) {
      return fail(res, 400, "Nome, objetivo e plataforma são obrigatórios.");
    }

    const payload = {
      ...body,
      organization_id: organizationId,
      status: body.status || "rascunho",
      tracking_code: body.tracking_code || generateTrackingCode()
    };

    const insertFields = ["organization_id", ...campaignFields].filter(
      (field) => Object.prototype.hasOwnProperty.call(payload, field)
    );

    const columns = insertFields.join(", ");
    const placeholders = insertFields.map((_, index) => `$${index + 1}`).join(", ");
    const values = insertFields.map((field) => payload[field]);

    const result = await query(
      `
      insert into public.paid_traffic_campaigns (${columns})
      values (${placeholders})
      returning *
      `,
      values
    );

    await addHistory({
      campaignId: result.rows[0].id,
      organizationId,
      eventType: "created",
      description: "Campanha criada pela API.",
      createdBy: body.created_by || null
    });

    return ok(res, { data: result.rows[0] });
  } catch (error) {
    if (error.code === "23505") {
      return fail(res, 409, "Já existe uma campanha com esse código de rastreamento.", error.message);
    }

    return fail(res, 500, "Não foi possível criar a campanha.", error.message);
  }
});

app.patch("/api/paid-traffic/campaigns/:id", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    const { id } = req.params;
    const body = req.body;

    if (!organizationId) {
      return fail(res, 400, "organization_id é obrigatório.");
    }

    const updates = [];
    const values = [];
    let index = 1;

    for (const field of campaignFields) {
      if (field === "created_by") continue;

      if (Object.prototype.hasOwnProperty.call(body, field)) {
        updates.push(`${field} = $${index}`);
        values.push(body[field]);
        index++;
      }
    }

    if (updates.length === 0) {
      return fail(res, 400, "Nenhum campo válido enviado para atualização.");
    }

    values.push(id, organizationId);

    const result = await query(
      `
      update public.paid_traffic_campaigns
      set ${updates.join(", ")}
      where id = $${index}
        and organization_id = $${index + 1}
      returning *
      `,
      values
    );

    if (result.rowCount === 0) {
      return fail(res, 404, "Campanha não encontrada.");
    }

    await addHistory({
      campaignId: id,
      organizationId,
      eventType: "campaign_updated",
      description: "Campanha atualizada pela API.",
      metadata: { fields: Object.keys(body) }
    });

    return ok(res, { data: result.rows[0] });
  } catch (error) {
    return fail(res, 500, "Não foi possível atualizar a campanha.", error.message);
  }
});

app.post("/api/paid-traffic/campaigns/:id/status", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    const { id } = req.params;
    const { status } = req.body;

    if (!organizationId) {
      return fail(res, 400, "organization_id é obrigatório.");
    }

    if (!status) {
      return fail(res, 400, "Status é obrigatório.");
    }

    const result = await query(
      `
      update public.paid_traffic_campaigns
      set status = $1
      where id = $2
        and organization_id = $3
      returning *
      `,
      [status, id, organizationId]
    );

    if (result.rowCount === 0) {
      return fail(res, 404, "Campanha não encontrada.");
    }

    await addHistory({
      campaignId: id,
      organizationId,
      eventType: "status_change",
      description: `Status alterado para ${status}.`,
      metadata: { status }
    });

    return ok(res, { data: result.rows[0] });
  } catch (error) {
    return fail(res, 500, "Não foi possível alterar o status da campanha.", error.message);
  }
});

app.post("/api/paid-traffic/campaigns/:id/archive", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    const { id } = req.params;

    if (!organizationId) {
      return fail(res, 400, "organization_id é obrigatório.");
    }

    const result = await query(
      `
      update public.paid_traffic_campaigns
      set status = 'arquivada'
      where id = $1
        and organization_id = $2
      returning *
      `,
      [id, organizationId]
    );

    if (result.rowCount === 0) {
      return fail(res, 404, "Campanha não encontrada.");
    }

    await addHistory({
      campaignId: id,
      organizationId,
      eventType: "status_change",
      description: "Campanha arquivada pela API.",
      metadata: { status: "arquivada" }
    });

    return ok(res, { data: result.rows[0] });
  } catch (error) {
    return fail(res, 500, "Não foi possível arquivar a campanha.", error.message);
  }
});

app.post("/api/paid-traffic/campaigns/:id/regenerate-tracking-code", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    const { id } = req.params;
    const trackingCode = generateTrackingCode();

    if (!organizationId) {
      return fail(res, 400, "organization_id é obrigatório.");
    }

    const result = await query(
      `
      update public.paid_traffic_campaigns
      set tracking_code = $1
      where id = $2
        and organization_id = $3
      returning *
      `,
      [trackingCode, id, organizationId]
    );

    if (result.rowCount === 0) {
      return fail(res, 404, "Campanha não encontrada.");
    }

    await addHistory({
      campaignId: id,
      organizationId,
      eventType: "tracking_link_generated",
      description: `Novo código de rastreamento gerado: ${trackingCode}.`,
      metadata: { tracking_code: trackingCode }
    });

    return ok(res, { data: result.rows[0] });
  } catch (error) {
    return fail(res, 500, "Não foi possível regenerar o código de rastreamento.", error.message);
  }
});

app.post("/api/paid-traffic/campaigns/:id/duplicate", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    const { id } = req.params;

    if (!organizationId) {
      return fail(res, 400, "organization_id é obrigatório.");
    }

    const original = await query(
      `
      select *
      from public.paid_traffic_campaigns
      where id = $1
        and organization_id = $2
      limit 1
      `,
      [id, organizationId]
    );

    if (original.rowCount === 0) {
      return fail(res, 404, "Campanha original não encontrada.");
    }

    const c = original.rows[0];

    const result = await query(
      `
      insert into public.paid_traffic_campaigns (
        organization_id,
        name,
        product_service,
        objective,
        platform,
        status,
        start_date,
        end_date,
        budget_type,
        daily_budget,
        total_budget,
        current_balance,
        min_balance_alert,
        budget_notes,
        target_audience,
        min_age,
        max_age,
        gender,
        interests,
        segment,
        job_role,
        company_type,
        intent_level,
        country,
        state,
        city,
        radius_km,
        included_regions,
        excluded_regions,
        ad_title,
        ad_primary_text,
        ad_short_call,
        cta,
        creative_notes,
        agent_id,
        whatsapp_instance_id,
        whatsapp_destination,
        initial_bdr_message,
        initial_lead_temperature,
        send_to_crm_when_qualified,
        tracking_code,
        whatsapp_prefilled_message,
        whatsapp_tracking_url,
        landing_page_url,
        utm_source,
        utm_medium,
        utm_campaign,
        utm_content,
        utm_term,
        created_by
      )
      values (
        $1,$2,$3,$4,$5,'rascunho',
        $6,$7,$8,$9,$10,$11,$12,$13,
        $14,$15,$16,$17,$18,$19,$20,$21,$22,
        $23,$24,$25,$26,$27,$28,
        $29,$30,$31,$32,$33,
        $34,$35,$36,$37,$38,$39,
        $40,$41,$42,$43,$44,$45,$46,$47,$48,$49
      )
      returning *
      `,
      [
        organizationId,
        `${c.name} - Cópia`,
        c.product_service,
        c.objective,
        c.platform,
        c.start_date,
        c.end_date,
        c.budget_type,
        c.daily_budget,
        c.total_budget,
        c.current_balance,
        c.min_balance_alert,
        c.budget_notes,
        c.target_audience,
        c.min_age,
        c.max_age,
        c.gender,
        c.interests,
        c.segment,
        c.job_role,
        c.company_type,
        c.intent_level,
        c.country,
        c.state,
        c.city,
        c.radius_km,
        c.included_regions,
        c.excluded_regions,
        c.ad_title,
        c.ad_primary_text,
        c.ad_short_call,
        c.cta,
        c.creative_notes,
        c.agent_id,
        c.whatsapp_instance_id,
        c.whatsapp_destination,
        c.initial_bdr_message,
        c.initial_lead_temperature,
        c.send_to_crm_when_qualified,
        generateTrackingCode(),
        c.whatsapp_prefilled_message,
        c.whatsapp_tracking_url,
        c.landing_page_url,
        c.utm_source,
        c.utm_medium,
        c.utm_campaign,
        c.utm_content,
        c.utm_term,
        c.created_by
      ]
    );

    await addHistory({
      campaignId: result.rows[0].id,
      organizationId,
      eventType: "created",
      description: "Campanha duplicada pela API.",
      metadata: { original_campaign_id: id }
    });

    return ok(res, { data: result.rows[0] });
  } catch (error) {
    return fail(res, 500, "Não foi possível duplicar a campanha.", error.message);
  }
});

app.get("/api/paid-traffic/campaigns/:id/funnel", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    const { id } = req.params;

    if (!organizationId) {
      return fail(res, 400, "organization_id é obrigatório.");
    }

    const result = await query(
      `
      select
        count(*)::int as leads_gerados,
        count(*) filter (where status = 'em_atendimento')::int as em_atendimento,
        count(*) filter (where status = 'respondeu')::int as respondidos,
        count(*) filter (where status = 'qualificado')::int as qualificados,
        count(*) filter (where status = 'quente' or temperature = 'quente')::int as quentes,
        count(*) filter (where status = 'enviado_crm')::int as enviados_crm
      from public.paid_traffic_leads
      where campaign_id = $1
        and organization_id = $2
      `,
      [id, organizationId]
    );

    return ok(res, { data: result.rows[0] });
  } catch (error) {
    return fail(res, 500, "Não foi possível carregar o funil da campanha.", error.message);
  }
});

/* =========================================================
   MÍDIAS
========================================================= */

app.get("/api/paid-traffic/campaigns/:campaignId/media", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    const { campaignId } = req.params;

    if (!organizationId) {
      return fail(res, 400, "organization_id é obrigatório.");
    }

    const result = await query(
      `
      select *
      from public.paid_traffic_media
      where campaign_id = $1
        and organization_id = $2
      order by is_primary desc, created_at desc
      `,
      [campaignId, organizationId]
    );

    return ok(res, { data: result.rows });
  } catch (error) {
    return fail(res, 500, "Não foi possível carregar as mídias.", error.message);
  }
});

app.post("/api/paid-traffic/media", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    const body = req.body;

    if (!organizationId) {
      return fail(res, 400, "organization_id é obrigatório.");
    }

    if (!body.campaign_id || !body.file_name || !body.file_url) {
      return fail(res, 400, "campaign_id, file_name e file_url são obrigatórios.");
    }

    const result = await query(
      `
      insert into public.paid_traffic_media (
        campaign_id,
        organization_id,
        file_name,
        file_url,
        thumbnail_url,
        mime_type,
        size_bytes,
        storage_key,
        media_type,
        is_primary
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10,false))
      returning *
      `,
      [
        body.campaign_id,
        organizationId,
        body.file_name,
        body.file_url,
        body.thumbnail_url || null,
        body.mime_type || null,
        body.size_bytes || null,
        body.storage_key || null,
        body.media_type || "other",
        body.is_primary || false
      ]
    );

    await addHistory({
      campaignId: body.campaign_id,
      organizationId,
      eventType: "media_uploaded",
      description: `Mídia ${body.file_name} vinculada à campanha.`,
      metadata: { file_url: body.file_url }
    });

    return ok(res, { data: result.rows[0] });
  } catch (error) {
    return fail(res, 500, "Não foi possível salvar os metadados da mídia.", error.message);
  }
});

app.patch("/api/paid-traffic/media/:id", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    const { id } = req.params;
    const allowed = ["file_name", "file_url", "thumbnail_url", "mime_type", "size_bytes", "storage_key", "media_type", "is_primary"];

    if (!organizationId) {
      return fail(res, 400, "organization_id é obrigatório.");
    }

    const updates = [];
    const values = [];
    let index = 1;

    for (const field of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        updates.push(`${field} = $${index}`);
        values.push(req.body[field]);
        index++;
      }
    }

    if (updates.length === 0) {
      return fail(res, 400, "Nenhum campo válido enviado.");
    }

    values.push(id, organizationId);

    const result = await query(
      `
      update public.paid_traffic_media
      set ${updates.join(", ")}
      where id = $${index}
        and organization_id = $${index + 1}
      returning *
      `,
      values
    );

    if (result.rowCount === 0) {
      return fail(res, 404, "Mídia não encontrada.");
    }

    return ok(res, { data: result.rows[0] });
  } catch (error) {
    return fail(res, 500, "Não foi possível atualizar a mídia.", error.message);
  }
});

app.delete("/api/paid-traffic/media/:id", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    const { id } = req.params;

    if (!organizationId) {
      return fail(res, 400, "organization_id é obrigatório.");
    }

    const result = await query(
      `
      delete from public.paid_traffic_media
      where id = $1
        and organization_id = $2
      returning *
      `,
      [id, organizationId]
    );

    if (result.rowCount === 0) {
      return fail(res, 404, "Mídia não encontrada.");
    }

    await addHistory({
      campaignId: result.rows[0].campaign_id,
      organizationId,
      eventType: "media_removed",
      description: `Mídia ${result.rows[0].file_name} removida da campanha.`,
      metadata: { media_id: id }
    });

    return ok(res, { data: result.rows[0] });
  } catch (error) {
    return fail(res, 500, "Não foi possível remover a mídia.", error.message);
  }
});

app.post("/api/paid-traffic/media/:id/set-primary", async (req, res) => {
  const client = await pool.connect();

  try {
    const organizationId = getOrganizationId(req);
    const { id } = req.params;

    if (!organizationId) {
      return fail(res, 400, "organization_id é obrigatório.");
    }

    await client.query("begin");

    const media = await client.query(
      `
      select *
      from public.paid_traffic_media
      where id = $1
        and organization_id = $2
      limit 1
      `,
      [id, organizationId]
    );

    if (media.rowCount === 0) {
      await client.query("rollback");
      return fail(res, 404, "Mídia não encontrada.");
    }

    await client.query(
      `
      update public.paid_traffic_media
      set is_primary = false
      where campaign_id = $1
        and organization_id = $2
      `,
      [media.rows[0].campaign_id, organizationId]
    );

    const result = await client.query(
      `
      update public.paid_traffic_media
      set is_primary = true
      where id = $1
        and organization_id = $2
      returning *
      `,
      [id, organizationId]
    );

    await client.query("commit");

    return ok(res, { data: result.rows[0] });
  } catch (error) {
    await client.query("rollback");
    return fail(res, 500, "Não foi possível marcar a mídia como principal.", error.message);
  } finally {
    client.release();
  }
});

/* =========================================================
   LEADS
========================================================= */

app.get("/api/paid-traffic/campaigns/:campaignId/leads", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    const { campaignId } = req.params;

    if (!organizationId) {
      return fail(res, 400, "organization_id é obrigatório.");
    }

    const result = await query(
      `
      select *
      from public.paid_traffic_leads
      where campaign_id = $1
        and organization_id = $2
      order by created_at desc
      `,
      [campaignId, organizationId]
    );

    return ok(res, { data: result.rows });
  } catch (error) {
    return fail(res, 500, "Não foi possível carregar os leads.", error.message);
  }
});

app.get("/api/paid-traffic/leads", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);

    if (!organizationId) {
      return fail(res, 400, "organization_id é obrigatório.");
    }

    const result = await query(
      `
      select *
      from public.paid_traffic_leads
      where organization_id = $1
      order by created_at desc
      `,
      [organizationId]
    );

    return ok(res, { data: result.rows });
  } catch (error) {
    return fail(res, 500, "Não foi possível carregar os leads da organização.", error.message);
  }
});

app.post("/api/paid-traffic/leads", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    const body = req.body;

    if (!organizationId) {
      return fail(res, 400, "organization_id é obrigatório.");
    }

    if (!body.campaign_id || !body.phone) {
      return fail(res, 400, "campaign_id e phone são obrigatórios.");
    }

    const result = await query(
      `
      insert into public.paid_traffic_leads (
        organization_id,
        campaign_id,
        lead_id,
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
      )
      values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,
        coalesce($17,'novo'),
        coalesce($18,'frio'),
        $19,$20,$21
      )
      returning *
      `,
      [
        organizationId,
        body.campaign_id,
        body.lead_id || null,
        body.name || null,
        body.phone,
        body.email || null,
        body.company || null,
        body.source_platform || null,
        body.source_channel || null,
        body.source_url || null,
        body.tracking_code || null,
        body.utm_source || null,
        body.utm_medium || null,
        body.utm_campaign || null,
        body.utm_content || null,
        body.utm_term || null,
        body.status || "novo",
        body.temperature || "frio",
        body.first_contact_at || null,
        body.last_interaction_at || null,
        body.notes || null
      ]
    );

    await addHistory({
      campaignId: body.campaign_id,
      organizationId,
      eventType: "lead_added",
      description: `Lead ${body.name || body.phone} adicionado à campanha.`,
      metadata: { phone: body.phone }
    });

    return ok(res, { data: result.rows[0] });
  } catch (error) {
    return fail(res
