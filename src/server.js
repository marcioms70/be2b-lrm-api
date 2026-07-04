import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { pool, query } from "./db.js";

dotenv.config();

const app = express();

const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

app.use(
  cors({
    origin: CORS_ORIGIN === "*" ? "*" : CORS_ORIGIN.split(",").map((o) => o.trim()),
    allowedHeaders: ["Content-Type", "Authorization", "x-organization-id"],
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"]
  })
);

app.use(express.json({ limit: "5mb" }));

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

function generateTrackingCode() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `TP-${y}${m}${d}-${random}`;
}

function toNullable(value) {
  return value === undefined || value === "" ? null : value;
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function calcMetricRates({ amount_spent, leads, impressions, clicks }) {
  const spent = toNumber(amount_spent);
  const totalLeads = toNumber(leads);
  const totalImpressions = toNumber(impressions);
  const totalClicks = toNumber(clicks);
  return {
    cpl: totalLeads > 0 ? spent / totalLeads : null,
    ctr: totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : null,
    cpc: totalClicks > 0 ? spent / totalClicks : null
  };
}

function pickPayload(body, allowedFields, overrides = {}) {
  const payload = { ...body, ...overrides };
  const fields = allowedFields.filter((field) => Object.prototype.hasOwnProperty.call(payload, field));
  const values = fields.map((field) => toNullable(payload[field]));
  return { fields, values };
}

async function insertReturning(tableName, allowedFields, body, overrides = {}) {
  const { fields, values } = pickPayload(body, allowedFields, overrides);
  if (fields.length === 0) throw new Error("Nenhum campo para inserir.");
  const columns = fields.join(", ");
  const placeholders = fields.map((_, i) => `$${i + 1}`).join(", ");
  const result = await query(
    `insert into public.${tableName} (${columns}) values (${placeholders}) returning *`,
    values
  );
  return result.rows[0];
}

function buildUpdate(body, allowedFields) {
  const updates = [];
  const values = [];
  let index = 1;
  for (const field of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      updates.push(`${field} = $${index}`);
      values.push(toNullable(body[field]));
      index++;
    }
  }
  return { updates, values, index };
}

async function addHistory({ campaignId, organizationId, eventType, description, metadata = {}, createdBy = null }) {
  try {
    await query(
      `
      insert into public.paid_traffic_history (
        campaign_id, organization_id, event_type, description, metadata, created_by
      ) values ($1, $2, $3, $4, $5::jsonb, $6)
      `,
      [campaignId, organizationId, eventType, description, JSON.stringify(metadata), createdBy]
    );
  } catch (error) {
    console.error("Erro ao gravar histórico:", error.message);
  }
}

async function tableExists(tableName) {
  const result = await query("select to_regclass($1) as table_name", [`public.${tableName}`]);
  return Boolean(result.rows[0]?.table_name);
}

const campaignFields = [
  "organization_id",
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

const campaignUpdatableFields = campaignFields.filter((f) => !["organization_id", "created_by"].includes(f));

const mediaFields = [
  "campaign_id",
  "organization_id",
  "file_name",
  "file_url",
  "thumbnail_url",
  "mime_type",
  "size_bytes",
  "storage_key",
  "media_type",
  "is_primary"
];
const mediaUpdatableFields = mediaFields.filter((f) => !["campaign_id", "organization_id"].includes(f));

const leadFields = [
  "organization_id",
  "campaign_id",
  "lead_id",
  "name",
  "phone",
  "email",
  "company",
  "source_platform",
  "source_channel",
  "source_url",
  "tracking_code",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "status",
  "temperature",
  "first_contact_at",
  "last_interaction_at",
  "qualified_at",
  "sent_to_crm_at",
  "notes"
];
const leadUpdatableFields = leadFields.filter((f) => !["organization_id", "campaign_id"].includes(f));

const metricFields = [
  "organization_id",
  "campaign_id",
  "report_date",
  "impressions",
  "clicks",
  "leads",
  "amount_spent",
  "remaining_balance",
  "cpl",
  "ctr",
  "cpc",
  "notes",
  "recommendation"
];
const metricUpdatableFields = metricFields.filter((f) => !["organization_id", "campaign_id"].includes(f));

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
   DASHBOARD / LISTAS ORGANIZACIONAIS
========================================================= */
app.get("/api/paid-traffic/org/metrics", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");
    const result = await query(
      `select * from public.paid_traffic_metrics where organization_id = $1 order by report_date desc, created_at desc`,
      [organizationId]
    );
    return ok(res, { data: result.rows });
  } catch (error) {
    return fail(res, 500, "Não foi possível carregar métricas da organização.", error.message);
  }
});

app.get("/api/paid-traffic/org/leads", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");
    const result = await query(
      `select * from public.paid_traffic_leads where organization_id = $1 order by created_at desc`,
      [organizationId]
    );
    return ok(res, { data: result.rows });
  } catch (error) {
    return fail(res, 500, "Não foi possível carregar leads da organização.", error.message);
  }
});

app.get("/api/paid-traffic/metrics", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");
    const result = await query(
      `select * from public.paid_traffic_metrics where organization_id = $1 order by report_date desc, created_at desc`,
      [organizationId]
    );
    return ok(res, { data: result.rows });
  } catch (error) {
    return fail(res, 500, "Não foi possível carregar métricas da organização.", error.message);
  }
});

app.get("/api/paid-traffic/leads", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");
    const result = await query(
      `select * from public.paid_traffic_leads where organization_id = $1 order by created_at desc`,
      [organizationId]
    );
    return ok(res, { data: result.rows });
  } catch (error) {
    return fail(res, 500, "Não foi possível carregar leads da organização.", error.message);
  }
});

/* =========================================================
   CAMPANHAS
========================================================= */
app.get("/api/paid-traffic/campaigns", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");

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

app.post("/api/paid-traffic/campaigns", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");
    if (!req.body.name || !req.body.objective || !req.body.platform) {
      return fail(res, 400, "Nome, objetivo e plataforma são obrigatórios.");
    }

    const data = await insertReturning(
      "paid_traffic_campaigns",
      campaignFields,
      req.body,
      {
        organization_id: organizationId,
        status: req.body.status || "rascunho",
        tracking_code: req.body.tracking_code || generateTrackingCode(),
        send_to_crm_when_qualified: Boolean(req.body.send_to_crm_when_qualified)
      }
    );

    await addHistory({
      campaignId: data.id,
      organizationId,
      eventType: "created",
      description: "Campanha criada pela API.",
      createdBy: req.body.created_by || null
    });

    return ok(res, { data });
  } catch (error) {
    if (error.code === "23505") return fail(res, 409, "Já existe uma campanha com esse código de rastreamento.", error.message);
    return fail(res, 500, "Não foi possível criar a campanha.", error.message);
  }
});

app.get("/api/paid-traffic/campaigns/:id", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");

    const result = await query(
      `select * from public.paid_traffic_campaigns where id = $1 and organization_id = $2 limit 1`,
      [req.params.id, organizationId]
    );
    if (result.rowCount === 0) return fail(res, 404, "Campanha não encontrada.");
    return ok(res, { data: result.rows[0] });
  } catch (error) {
    return fail(res, 500, "Não foi possível carregar a campanha.", error.message);
  }
});

app.patch("/api/paid-traffic/campaigns/:id", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");

    const { updates, values, index } = buildUpdate(req.body, campaignUpdatableFields);
    if (updates.length === 0) return fail(res, 400, "Nenhum campo válido enviado para atualização.");
    values.push(req.params.id, organizationId);

    const result = await query(
      `update public.paid_traffic_campaigns set ${updates.join(", ")} where id = $${index} and organization_id = $${index + 1} returning *`,
      values
    );
    if (result.rowCount === 0) return fail(res, 404, "Campanha não encontrada.");

    await addHistory({
      campaignId: req.params.id,
      organizationId,
      eventType: "campaign_updated",
      description: "Campanha atualizada pela API.",
      metadata: { fields: Object.keys(req.body) }
    });

    return ok(res, { data: result.rows[0] });
  } catch (error) {
    return fail(res, 500, "Não foi possível atualizar a campanha.", error.message);
  }
});

app.post("/api/paid-traffic/campaigns/:id/status", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    const status = req.body.status;
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");
    if (!status) return fail(res, 400, "Status é obrigatório.");

    const result = await query(
      `update public.paid_traffic_campaigns set status = $1 where id = $2 and organization_id = $3 returning *`,
      [status, req.params.id, organizationId]
    );
    if (result.rowCount === 0) return fail(res, 404, "Campanha não encontrada.");

    await addHistory({
      campaignId: req.params.id,
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
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");

    const result = await query(
      `update public.paid_traffic_campaigns set status = 'arquivada' where id = $1 and organization_id = $2 returning *`,
      [req.params.id, organizationId]
    );
    if (result.rowCount === 0) return fail(res, 404, "Campanha não encontrada.");

    await addHistory({
      campaignId: req.params.id,
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
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");
    const trackingCode = generateTrackingCode();

    const result = await query(
      `update public.paid_traffic_campaigns set tracking_code = $1 where id = $2 and organization_id = $3 returning *`,
      [trackingCode, req.params.id, organizationId]
    );
    if (result.rowCount === 0) return fail(res, 404, "Campanha não encontrada.");

    await addHistory({
      campaignId: req.params.id,
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
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");

    const original = await query(
      `select * from public.paid_traffic_campaigns where id = $1 and organization_id = $2 limit 1`,
      [req.params.id, organizationId]
    );
    if (original.rowCount === 0) return fail(res, 404, "Campanha original não encontrada.");

    const c = original.rows[0];
    const data = await insertReturning(
      "paid_traffic_campaigns",
      campaignFields,
      c,
      {
        id: undefined,
        organization_id: organizationId,
        name: `${c.name} - Cópia`,
        status: "rascunho",
        tracking_code: generateTrackingCode()
      }
    );

    await addHistory({
      campaignId: data.id,
      organizationId,
      eventType: "created",
      description: "Campanha duplicada pela API.",
      metadata: { original_campaign_id: req.params.id }
    });

    return ok(res, { data });
  } catch (error) {
    return fail(res, 500, "Não foi possível duplicar a campanha.", error.message);
  }
});

app.get("/api/paid-traffic/campaigns/:id/funnel", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");

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
      where campaign_id = $1 and organization_id = $2
      `,
      [req.params.id, organizationId]
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
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");

    const result = await query(
      `select * from public.paid_traffic_media where campaign_id = $1 and organization_id = $2 order by is_primary desc, created_at desc`,
      [req.params.campaignId, organizationId]
    );
    return ok(res, { data: result.rows });
  } catch (error) {
    return fail(res, 500, "Não foi possível carregar as mídias.", error.message);
  }
});

app.post("/api/paid-traffic/media", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");
    if (!req.body.campaign_id || !req.body.file_name || !req.body.file_url) {
      return fail(res, 400, "campaign_id, file_name e file_url são obrigatórios.");
    }

    const data = await insertReturning("paid_traffic_media", mediaFields, req.body, {
      organization_id: organizationId,
      media_type: req.body.media_type || "other",
      is_primary: Boolean(req.body.is_primary)
    });

    await addHistory({
      campaignId: req.body.campaign_id,
      organizationId,
      eventType: "media_uploaded",
      description: `Mídia ${req.body.file_name} vinculada à campanha.`,
      metadata: { file_url: req.body.file_url }
    });

    return ok(res, { data });
  } catch (error) {
    return fail(res, 500, "Não foi possível salvar os metadados da mídia.", error.message);
  }
});

app.patch("/api/paid-traffic/media/:id", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");

    const { updates, values, index } = buildUpdate(req.body, mediaUpdatableFields);
    if (updates.length === 0) return fail(res, 400, "Nenhum campo válido enviado.");
    values.push(req.params.id, organizationId);

    const result = await query(
      `update public.paid_traffic_media set ${updates.join(", ")} where id = $${index} and organization_id = $${index + 1} returning *`,
      values
    );
    if (result.rowCount === 0) return fail(res, 404, "Mídia não encontrada.");
    return ok(res, { data: result.rows[0] });
  } catch (error) {
    return fail(res, 500, "Não foi possível atualizar a mídia.", error.message);
  }
});

app.delete("/api/paid-traffic/media/:id", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");

    const result = await query(
      `delete from public.paid_traffic_media where id = $1 and organization_id = $2 returning *`,
      [req.params.id, organizationId]
    );
    if (result.rowCount === 0) return fail(res, 404, "Mídia não encontrada.");

    await addHistory({
      campaignId: result.rows[0].campaign_id,
      organizationId,
      eventType: "media_removed",
      description: `Mídia ${result.rows[0].file_name} removida da campanha.`,
      metadata: { media_id: req.params.id }
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
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");

    await client.query("begin");
    const media = await client.query(
      `select * from public.paid_traffic_media where id = $1 and organization_id = $2 limit 1`,
      [req.params.id, organizationId]
    );
    if (media.rowCount === 0) {
      await client.query("rollback");
      return fail(res, 404, "Mídia não encontrada.");
    }
    await client.query(
      `update public.paid_traffic_media set is_primary = false where campaign_id = $1 and organization_id = $2`,
      [media.rows[0].campaign_id, organizationId]
    );
    const result = await client.query(
      `update public.paid_traffic_media set is_primary = true where id = $1 and organization_id = $2 returning *`,
      [req.params.id, organizationId]
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
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");
    const result = await query(
      `select * from public.paid_traffic_leads where campaign_id = $1 and organization_id = $2 order by created_at desc`,
      [req.params.campaignId, organizationId]
    );
    return ok(res, { data: result.rows });
  } catch (error) {
    return fail(res, 500, "Não foi possível carregar os leads.", error.message);
  }
});

app.post("/api/paid-traffic/leads", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");
    if (!req.body.campaign_id || !req.body.phone) return fail(res, 400, "campaign_id e phone são obrigatórios.");

    const data = await insertReturning("paid_traffic_leads", leadFields, req.body, {
      organization_id: organizationId,
      status: req.body.status || "novo",
      temperature: req.body.temperature || "frio"
    });

    await addHistory({
      campaignId: req.body.campaign_id,
      organizationId,
      eventType: "lead_added",
      description: `Lead ${req.body.name || req.body.phone} adicionado à campanha.`,
      metadata: { phone: req.body.phone }
    });

    return ok(res, { data });
  } catch (error) {
    return fail(res, 500, "Não foi possível criar o lead.", error.message);
  }
});

app.patch("/api/paid-traffic/leads/:id", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");

    const { updates, values, index } = buildUpdate(req.body, leadUpdatableFields);
    if (updates.length === 0) return fail(res, 400, "Nenhum campo válido enviado.");
    values.push(req.params.id, organizationId);

    const result = await query(
      `update public.paid_traffic_leads set ${updates.join(", ")} where id = $${index} and organization_id = $${index + 1} returning *`,
      values
    );
    if (result.rowCount === 0) return fail(res, 404, "Lead não encontrado.");

    await addHistory({
      campaignId: result.rows[0].campaign_id,
      organizationId,
      eventType: "lead_status_changed",
      description: `Lead ${result.rows[0].name || result.rows[0].phone} atualizado.`,
      metadata: { fields: Object.keys(req.body) }
    });

    return ok(res, { data: result.rows[0] });
  } catch (error) {
    return fail(res, 500, "Não foi possível atualizar o lead.", error.message);
  }
});

app.post("/api/paid-traffic/leads/:id/qualify", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");
    const result = await query(
      `update public.paid_traffic_leads set status = 'qualificado', temperature = case when temperature = 'frio' then 'morno' else temperature end, qualified_at = coalesce(qualified_at, now()), last_interaction_at = now() where id = $1 and organization_id = $2 returning *`,
      [req.params.id, organizationId]
    );
    if (result.rowCount === 0) return fail(res, 404, "Lead não encontrado.");
    await addHistory({ campaignId: result.rows[0].campaign_id, organizationId, eventType: "lead_status_changed", description: `Lead ${result.rows[0].name || result.rows[0].phone} marcado como qualificado.` });
    return ok(res, { data: result.rows[0] });
  } catch (error) {
    return fail(res, 500, "Não foi possível qualificar o lead.", error.message);
  }
});

app.post("/api/paid-traffic/leads/:id/mark-hot", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");
    const result = await query(
      `update public.paid_traffic_leads set status = 'quente', temperature = 'quente', qualified_at = coalesce(qualified_at, now()), last_interaction_at = now() where id = $1 and organization_id = $2 returning *`,
      [req.params.id, organizationId]
    );
    if (result.rowCount === 0) return fail(res, 404, "Lead não encontrado.");
    await addHistory({ campaignId: result.rows[0].campaign_id, organizationId, eventType: "lead_marked_hot", description: `Lead ${result.rows[0].name || result.rows[0].phone} marcado como quente.` });
    return ok(res, { data: result.rows[0] });
  } catch (error) {
    return fail(res, 500, "Não foi possível marcar o lead como quente.", error.message);
  }
});

app.post("/api/paid-traffic/leads/:id/send-to-crm", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");
    const result = await query(
      `update public.paid_traffic_leads set status = 'enviado_crm', sent_to_crm_at = coalesce(sent_to_crm_at, now()), last_interaction_at = now() where id = $1 and organization_id = $2 returning *`,
      [req.params.id, organizationId]
    );
    if (result.rowCount === 0) return fail(res, 404, "Lead não encontrado.");
    await addHistory({ campaignId: result.rows[0].campaign_id, organizationId, eventType: "lead_sent_to_crm", description: `Lead ${result.rows[0].name || result.rows[0].phone} enviado ao CRM.` });
    return ok(res, { data: result.rows[0] });
  } catch (error) {
    return fail(res, 500, "Não foi possível enviar o lead ao CRM.", error.message);
  }
});

app.post("/api/paid-traffic/leads/:id/notes", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    const note = req.body.note || req.body.notes;
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");
    if (!note) return fail(res, 400, "Nota é obrigatória.");

    const result = await query(
      `update public.paid_traffic_leads set notes = trim(coalesce(notes, '') || E'\n' || $1), last_interaction_at = now() where id = $2 and organization_id = $3 returning *`,
      [`[${new Date().toISOString()}] ${note}`, req.params.id, organizationId]
    );
    if (result.rowCount === 0) return fail(res, 404, "Lead não encontrado.");
    await addHistory({ campaignId: result.rows[0].campaign_id, organizationId, eventType: "lead_note_added", description: `Nota adicionada ao lead ${result.rows[0].name || result.rows[0].phone}.` });
    return ok(res, { data: result.rows[0] });
  } catch (error) {
    return fail(res, 500, "Não foi possível adicionar a observação.", error.message);
  }
});

/* =========================================================
   MÉTRICAS
========================================================= */
app.get("/api/paid-traffic/campaigns/:campaignId/metrics", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");
    const result = await query(
      `select * from public.paid_traffic_metrics where campaign_id = $1 and organization_id = $2 order by report_date desc, created_at desc`,
      [req.params.campaignId, organizationId]
    );
    return ok(res, { data: result.rows });
  } catch (error) {
    return fail(res, 500, "Não foi possível carregar as métricas.", error.message);
  }
});

app.post("/api/paid-traffic/metrics", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");
    if (!req.body.campaign_id || !req.body.report_date) return fail(res, 400, "campaign_id e report_date são obrigatórios.");

    const rates = calcMetricRates(req.body);
    const data = await insertReturning("paid_traffic_metrics", metricFields, req.body, {
      organization_id: organizationId,
      impressions: req.body.impressions || 0,
      clicks: req.body.clicks || 0,
      leads: req.body.leads || 0,
      amount_spent: req.body.amount_spent || 0,
      cpl: req.body.cpl ?? rates.cpl,
      ctr: req.body.ctr ?? rates.ctr,
      cpc: req.body.cpc ?? rates.cpc
    });

    await addHistory({
      campaignId: req.body.campaign_id,
      organizationId,
      eventType: "metric_added",
      description: `Métrica adicionada para ${req.body.report_date}.`,
      metadata: { metric_id: data.id }
    });

    return ok(res, { data });
  } catch (error) {
    return fail(res, 500, "Não foi possível criar a métrica.", error.message);
  }
});

app.patch("/api/paid-traffic/metrics/:id", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");

    const current = await query(`select * from public.paid_traffic_metrics where id = $1 and organization_id = $2`, [req.params.id, organizationId]);
    if (current.rowCount === 0) return fail(res, 404, "Métrica não encontrada.");

    const merged = { ...current.rows[0], ...req.body };
    const rates = calcMetricRates(merged);
    const body = { ...req.body };
    if (["amount_spent", "leads", "impressions", "clicks"].some((field) => Object.prototype.hasOwnProperty.call(req.body, field))) {
      body.cpl = req.body.cpl ?? rates.cpl;
      body.ctr = req.body.ctr ?? rates.ctr;
      body.cpc = req.body.cpc ?? rates.cpc;
    }

    const { updates, values, index } = buildUpdate(body, metricUpdatableFields);
    if (updates.length === 0) return fail(res, 400, "Nenhum campo válido enviado.");
    values.push(req.params.id, organizationId);
    const result = await query(
      `update public.paid_traffic_metrics set ${updates.join(", ")} where id = $${index} and organization_id = $${index + 1} returning *`,
      values
    );
    return ok(res, { data: result.rows[0] });
  } catch (error) {
    return fail(res, 500, "Não foi possível atualizar a métrica.", error.message);
  }
});

app.delete("/api/paid-traffic/metrics/:id", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");
    const result = await query(
      `delete from public.paid_traffic_metrics where id = $1 and organization_id = $2 returning *`,
      [req.params.id, organizationId]
    );
    if (result.rowCount === 0) return fail(res, 404, "Métrica não encontrada.");
    await addHistory({ campaignId: result.rows[0].campaign_id, organizationId, eventType: "metric_removed", description: `Métrica de ${result.rows[0].report_date} removida.` });
    return ok(res, { data: result.rows[0] });
  } catch (error) {
    return fail(res, 500, "Não foi possível remover a métrica.", error.message);
  }
});

/* =========================================================
   HISTÓRICO
========================================================= */
app.get("/api/paid-traffic/campaigns/:campaignId/history", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");
    const result = await query(
      `select * from public.paid_traffic_history where campaign_id = $1 and organization_id = $2 order by created_at desc`,
      [req.params.campaignId, organizationId]
    );
    return ok(res, { data: result.rows });
  } catch (error) {
    return fail(res, 500, "Não foi possível carregar o histórico.", error.message);
  }
});

app.post("/api/paid-traffic/history", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");
    if (!req.body.campaign_id || !req.body.event_type || !req.body.description) {
      return fail(res, 400, "campaign_id, event_type e description são obrigatórios.");
    }
    const data = await insertReturning(
      "paid_traffic_history",
      ["campaign_id", "organization_id", "event_type", "description", "metadata", "created_by"],
      req.body,
      { organization_id: organizationId, metadata: req.body.metadata || {} }
    );
    return ok(res, { data });
  } catch (error) {
    return fail(res, 500, "Não foi possível criar evento de histórico.", error.message);
  }
});

/* =========================================================
   BDR / INSTÂNCIAS
========================================================= */
app.get("/api/bdr/agents", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return ok(res, { data: [] });

    if (await tableExists("organization_bdr_flows")) {
      const result = await query(
        `select id, name, flow_name, status from public.organization_bdr_flows where organization_id = $1 order by name nulls last, flow_name nulls last`,
        [organizationId]
      );
      return ok(res, { data: result.rows });
    }

    return ok(res, { data: [] });
  } catch (error) {
    return ok(res, { data: [] });
  }
});

app.get("/api/bdr/whatsapp-instances", async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return ok(res, { data: [] });

    if (await tableExists("whatsapp_instances")) {
      const result = await query(
        `select * from public.whatsapp_instances where organization_id = $1 order by created_at desc`,
        [organizationId]
      );
      return ok(res, { data: result.rows });
    }

    if (await tableExists("organization_bdr_flows")) {
      const result = await query(
        `select distinct whatsapp_instance_id as id, whatsapp_instance_id as name from public.organization_bdr_flows where organization_id = $1 and whatsapp_instance_id is not null order by whatsapp_instance_id`,
        [organizationId]
      );
      return ok(res, { data: result.rows });
    }

    return ok(res, { data: [] });
  } catch (error) {
    return ok(res, { data: [] });
  }
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
