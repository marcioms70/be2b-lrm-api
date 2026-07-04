import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { query } from "./db.js";

dotenv.config();

const app = express();

const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

app.use(
  cors({
    origin: CORS_ORIGIN === "*" ? "*" : CORS_ORIGIN.split(",").map((o) => o.trim())
  })
);

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

async function addHistory({
  campaignId,
  organizationId,
  eventType,
  description,
  metadata = {},
  createdBy = null
}) {
  try {
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
  } catch (error) {
    console.error("Erro ao gravar histórico:", error.message);
  }
}

/* =========================================================
   HEALTH
========================================================= */

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

    return ok(res, {
      data: result.rows
    });
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

    return ok(res, {
      data: result.rows[0]
    });
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

    const trackingCode = body.tracking_code || generateTrackingCode();

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
        $1,$2,$3,$4,$5,
        coalesce($6, 'rascunho'),
        $7,$8,$9,$10,$11,$12,$13,$14,
        $15,$16,$17,$18,$19,$20,$21,$22,$23,
        $24,$25,$26,$27,$28,$29,
        $30,$31,$32,$33,$34,
        $35,$36,$37,$38,$39,
        coalesce($40, false),
        $41,$42,$43,$44,$45,$46,$47,$48,$49,$50
      )
      returning *
      `,
      [
        organizationId,
        body.name,
        body.product_service || null,
        body.objective,
        body.platform,
        body.status || "rascunho",
        body.start_date || null,
        body.end_date || null,
        body.budget_type || null,
        body.daily_budget || null,
        body.total_budget || null,
        body.current_balance || null,
        body.min_balance_alert || null,
        body.budget_notes || null,
        body.target_audience || null,
        body.min_age || null,
        body.max_age || null,
        body.gender || null,
        body.interests || null,
        body.segment || null,
        body.job_role || null,
        body.company_type || null,
        body.intent_level || null,
        body.country || null,
        body.state || null,
        body.city || null,
        body.radius_km || null,
        body.included_regions || null,
        body.excluded_regions || null,
        body.ad_title || null,
        body.ad_primary_text || null,
        body.ad_short_call || null,
        body.cta || null,
        body.creative_notes || null,
        body.agent_id || null,
        body.whatsapp_instance_id || null,
        body.whatsapp_destination || null,
        body.initial_bdr_message || null,
        body.initial_lead_temperature || null,
        body.send_to_crm_when_qualified || false,
        trackingCode,
        body.whatsapp_prefilled_message || null,
        body.whatsapp_tracking_url || null,
        body.landing_page_url || null,
        body.utm_source || null,
        body.utm_medium || null,
        body.utm_campaign || null,
        body.utm_content || null,
        body.utm_term || null,
        body.created_by || null
      ]
    );

    await addHistory({
      campaignId: result.rows[0].id,
      organizationId,
      eventType: "created",
      description: "Campanha criada pela API.",
      createdBy: body.created_by || null
    });

    return ok(res, {
      data: result.rows[0]
    });
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

    const allowedFields = [
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
      "utm_term"
    ];

    const updates = [];
    const values = [];
    let index = 1;

    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        updates.push(`${field} = $${index}`);
        values.push(body[field]);
        index++;
      }
    }

    if (updates.length === 0) {
      return fail(res, 400, "Nenhum campo válido enviado para atualização.");
    }

    values.push(id);
    values.push(organizationId);

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
      metadata: {
        fields: Object.keys(body)
      }
    });

    return ok(res, {
      data: result.rows[0]
    });
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

    return ok(res, {
      data: result.rows[0]
    });
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
      metadata: {
        status: "arquivada"
      }
    });

    return ok(res, {
      data: result.rows[0]
    });
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
      metadata: {
        tracking_code: trackingCode
      }
    });

    return ok(res, {
      data: result.rows[0]
    });
  } catch (error) {
    return fail(res, 500, "Não foi possível regenerar o código de rastreamento.", error.message);
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

    return ok(res, {
      data: result.rows[0]
    });
  } catch (error) {
    return fail(res, 500, "Não foi possível carregar o funil da campanha.", error.message);
  }
});

/* =========================================================
   ROTAS TEMPORÁRIAS PARA NÃO QUEBRAR O FRONTEND
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

app.get("/api/paid-traffic/campaigns/:campaignId/metrics", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    const { campaignId } = req.params;

    if (!organizationId) {
      return fail(res, 400, "organization_id é obrigatório.");
    }

    const result = await query(
      `
      select *
      from public.paid_traffic_metrics
      where campaign_id = $1
        and organization_id = $2
      order by report_date desc
      `,
      [campaignId, organizationId]
    );

    return ok(res, { data: result.rows });
  } catch (error) {
    return fail(res, 500, "Não foi possível carregar as métricas.", error.message);
  }
});

app.get("/api/paid-traffic/campaigns/:campaignId/history", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    const { campaignId } = req.params;

    if (!organizationId) {
      return fail(res, 400, "organization_id é obrigatório.");
    }

    const result = await query(
      `
      select *
      from public.paid_traffic_history
      where campaign_id = $1
        and organization_id = $2
      order by created_at desc
      `,
      [campaignId, organizationId]
    );

    return ok(res, { data: result.rows });
  } catch (error) {
    return fail(res, 500, "Não foi possível carregar o histórico.", error.message);
  }
});

app.get("/api/bdr/agents", async (req, res) => {
  return ok(res, {
    data: []
  });
});

app.get("/api/bdr/whatsapp-instances", async (req, res) => {
  return ok(res, {
    data: []
  });
});

/* =========================================================
   FALLBACK
========================================================= */

app.use((req, res) => {
  return fail(res, 404, "Endpoint não encontrado.");
});

app.listen(PORT, () => {
  console.log(`Be2B LRM API rodando na porta ${PORT}`);
});
