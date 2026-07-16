import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { pool, query } from "./db.js";

const UPLOAD_ROOT = process.env.UPLOAD_DIR || "/app/uploads";
const MAX_REMOTE_IMAGE_BYTES = 15 * 1024 * 1024;

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

function safeSegment(value, fallback = "sem-id") {
  return String(value || fallback)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120) || fallback;
}

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function publicFileUrl(storageKey) {
  const base = (process.env.MEDIA_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || "https://api.be2b.tech")
    .replace(/\/$/, "");
  return base.endsWith("/uploads") ? `${base}/${storageKey}` : `${base}/uploads/${storageKey}`;
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function hexColor(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? value : fallback;
}

function ctaLabel(value) {
  const labels = {
    SAIBA_MAIS: "SAIBA MAIS",
    LEARN_MORE: "SAIBA MAIS",
    ENVIAR_MENSAGEM: "ENVIAR MENSAGEM",
    MESSAGE_PAGE: "ENVIAR MENSAGEM",
    CONTATO: "FALE CONOSCO",
    CONTACT_US: "FALE CONOSCO",
    CADASTRE_SE: "CADASTRE-SE",
    SIGN_UP: "CADASTRE-SE"
  };
  const normalized = String(value || "SAIBA_MAIS").trim().toUpperCase();
  return labels[normalized] || normalized.replace(/_/g, " ");
}

function wrapText(value, maxCharacters, maxLines) {
  const words = String(value || "").trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxCharacters || !current) {
      current = candidate;
      continue;
    }

    lines.push(current);
    current = word;
    if (lines.length === maxLines - 1) break;
  }

  if (current && lines.length < maxLines) lines.push(current);

  const consumed = lines.join(" ").split(/\s+/).filter(Boolean).length;
  if (consumed < words.length && lines.length) {
    lines[lines.length - 1] = `${lines[lines.length - 1].replace(/[.…]+$/, "")}…`;
  }

  return lines.length ? lines : ["Conheça nossa solução"];
}

async function fetchImage(url) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("URL de imagem inválida.");

  const response = await fetch(parsed, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Não foi possível baixar a imagem: HTTP ${response.status}.`);

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_REMOTE_IMAGE_BYTES) throw new Error("A imagem excede o limite de 15 MB.");

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_REMOTE_IMAGE_BYTES) throw new Error("A imagem excede o limite de 15 MB.");
  return buffer;
}

function buildOverlaySvg({ width, height, headline, cta, brandKit, overlayConfig }) {
  const safeMargin = Number(overlayConfig?.canvas?.safe_margin) || 64;
  const headlineConfig = overlayConfig?.headline || {};
  const ctaConfig = overlayConfig?.cta || {};
  const fontSize = Math.min(Number(headlineConfig.font_size) || 68, 76);
  const lineHeight = Math.round(fontSize * 1.17);
  const maxWidth = Number(headlineConfig.max_width) || Math.round(width * 0.72);
  const maxCharacters = Math.max(14, Math.floor(maxWidth / (fontSize * 0.55)));
  const maxLines = Math.min(Number(headlineConfig.max_lines) || 3, 3);
  const lines = wrapText(headline, maxCharacters, maxLines);
  const headlineColor = hexColor(headlineConfig.color, "#FFFFFF");
  const primaryColor = hexColor(ctaConfig.background || brandKit.primary_color, "#008CFF");
  const ctaColor = hexColor(ctaConfig.color, "#FFFFFF");
  const ctaFontSize = Math.min(Number(ctaConfig.font_size) || 30, 34);
  const label = ctaLabel(cta);
  const buttonHeight = 62;
  const buttonWidth = Math.min(Math.max(190, 58 + label.length * ctaFontSize * 0.58), 370);
  const buttonY = height - safeMargin - buttonHeight;
  const headlineLastBaseline = buttonY - 42;
  const headlineFirstBaseline = headlineLastBaseline - (lines.length - 1) * lineHeight;
  const gradientStart = Math.round(height * 0.43);
  const gradientColor = hexColor(brandKit.primary_color, "#081A4B");
  const tspans = lines
    .map((line, index) => `<tspan x="${safeMargin}" y="${headlineFirstBaseline + index * lineHeight}">${escapeXml(line)}</tspan>`)
    .join("");

  return Buffer.from(`
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bottomShade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${gradientColor}" stop-opacity="0"/>
          <stop offset="52%" stop-color="${gradientColor}" stop-opacity="0.52"/>
          <stop offset="100%" stop-color="${gradientColor}" stop-opacity="0.96"/>
        </linearGradient>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="5" stdDeviation="7" flood-color="#000000" flood-opacity="0.58"/>
        </filter>
      </defs>
      <rect x="0" y="${gradientStart}" width="${width}" height="${height - gradientStart}" fill="url(#bottomShade)"/>
      <text font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="700" fill="${headlineColor}" filter="url(#shadow)">${tspans}</text>
      <rect x="${safeMargin}" y="${buttonY}" width="${buttonWidth}" height="${buttonHeight}" rx="18" fill="${primaryColor}" filter="url(#shadow)"/>
      <text x="${safeMargin + buttonWidth / 2}" y="${buttonY + 41}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${ctaFontSize}" font-weight="700" fill="${ctaColor}">${escapeXml(label)}</text>
    </svg>
  `);
}

async function prepareLogo(logoBuffer, overlayConfig) {
  const maxWidth = Math.max(Number(overlayConfig?.logo?.max_width) || 300, 300);
  const maxHeight = Math.max(Number(overlayConfig?.logo?.max_height) || 120, 80);
  const metadata = await sharp(logoBuffer).metadata();
  const pipeline = sharp(logoBuffer);

  if (!metadata.hasAlpha) {
    pipeline.trim({ background: { r: 0, g: 0, b: 0 }, threshold: 14 });
  }

  return pipeline
    .resize({ width: maxWidth, height: maxHeight, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
}

async function loadCreative(organizationId, creativeId) {
  const result = await query(
    `select
       gc.*,
       j.brand_kit_id,
       j.template_id,
       bk.logo_url,
       bk.logo_light_url,
       bk.primary_color,
       bk.secondary_color,
       bk.accent_color,
       bk.font_family,
       bk.default_cta,
       ct.width as template_width,
       ct.height as template_height,
       ct.overlay_config
     from public.generated_creatives gc
     join public.creative_generation_jobs j on j.id = gc.job_id
     join public.brand_kits bk on bk.id = j.brand_kit_id
     join public.creative_templates ct on ct.id = j.template_id
     where gc.id = $1 and gc.organization_id = $2
     limit 1`,
    [creativeId, organizationId]
  );
  return result.rows[0] || null;
}

async function handleComposeCreative(req, res) {
  let outputPath = null;

  try {
    const organizationId = getOrganizationId(req);
    const creativeId = req.body?.creative_id;
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");
    if (!creativeId) return fail(res, 400, "creative_id é obrigatório.");

    const creative = await loadCreative(organizationId, creativeId);
    if (!creative) return fail(res, 404, "Criativo gerado não encontrado.");

    if (creative.final_image_url && req.body?.force !== true) {
      return ok(res, {
        message: "O criativo já possui composição final.",
        data: { creative_id: creative.id, final_image_url: creative.final_image_url }
      });
    }

    const logoUrl = req.body?.logo_url || creative.logo_url || creative.logo_light_url;
    if (!creative.raw_image_url) return fail(res, 400, "O criativo não possui imagem-base.");
    if (!logoUrl) return fail(res, 400, "O kit de marca não possui logo_url.");

    const [rawImage, logoImage] = await Promise.all([
      fetchImage(creative.raw_image_url),
      fetchImage(logoUrl)
    ]);

    const width = Number(creative.template_width) || 1080;
    const height = Number(creative.template_height) || 1080;
    const overlayConfig = creative.overlay_config || {};
    const safeMargin = Number(overlayConfig?.canvas?.safe_margin) || 64;
    const logo = await prepareLogo(logoImage, overlayConfig);
    const logoMetadata = await sharp(logo).metadata();
    const logoPosition = overlayConfig?.logo?.position || "top_left";
    const logoLeft = logoPosition.includes("right")
      ? Math.max(width - safeMargin - Number(logoMetadata.width || 0), safeMargin)
      : safeMargin;
    const logoTop = safeMargin;
    const overlay = buildOverlaySvg({
      width,
      height,
      headline: creative.headline,
      cta: creative.cta || creative.default_cta,
      brandKit: creative,
      overlayConfig
    });

    const finalBuffer = await sharp(rawImage)
      .resize({ width, height, fit: "cover", position: "centre" })
      .composite([
        { input: logo, left: logoLeft, top: logoTop, blend: "over" },
        { input: overlay, left: 0, top: 0, blend: "over" }
      ])
      .png({ compressionLevel: 8 })
      .toBuffer();

    const organizationSegment = safeSegment(organizationId);
    const campaignSegment = safeSegment(creative.campaign_id);
    const outputDirectory = path.join(UPLOAD_ROOT, "campaigns", organizationSegment, campaignSegment, "final");
    ensureDir(outputDirectory);
    const fileName = `criativo-final-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.png`;
    const storageKey = `campaigns/${organizationSegment}/${campaignSegment}/final/${fileName}`;
    outputPath = path.join(outputDirectory, fileName);
    fs.writeFileSync(outputPath, finalBuffer);
    const finalImageUrl = publicFileUrl(storageKey);

    const client = await pool.connect();
    let updatedCreative;
    try {
      await client.query("begin");

      const mediaResult = await client.query(
        `insert into public.paid_traffic_media (
           campaign_id, organization_id, file_name, file_url, thumbnail_url,
           mime_type, size_bytes, storage_key, media_type, is_primary
         ) values ($1, $2, $3, $4, $4, 'image/png', $5, $6, 'image', false)
         returning *`,
        [creative.campaign_id, organizationId, fileName, finalImageUrl, finalBuffer.length, storageKey]
      );

      const creativeResult = await client.query(
        `update public.generated_creatives
         set media_id = $1,
             final_image_url = $2,
             thumbnail_url = $2,
             width = $3,
             height = $4,
             metadata = coalesce(metadata, '{}'::jsonb) || $5::jsonb,
             updated_at = now()
         where id = $6 and organization_id = $7
         returning *`,
        [
          mediaResult.rows[0].id,
          finalImageUrl,
          width,
          height,
          JSON.stringify({
            composition_pending: false,
            composed_at: new Date().toISOString(),
            logo_url: logoUrl,
            renderer: "sharp-svg-v1"
          }),
          creativeId,
          organizationId
        ]
      );

      await client.query("commit");
      updatedCreative = { ...creativeResult.rows[0], media: mediaResult.rows[0] };
    } catch (databaseError) {
      await client.query("rollback");
      throw databaseError;
    } finally {
      client.release();
    }

    return ok(res, {
      message: "Logo, headline e CTA aplicados ao criativo.",
      data: updatedCreative
    });
  } catch (error) {
    if (outputPath && fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    return fail(res, 500, "Não foi possível compor o criativo final.", error.message);
  }
}

const brandKitUpdatableFields = [
  "logo_url",
  "logo_light_url",
  "primary_color",
  "secondary_color",
  "accent_color",
  "font_family",
  "brand_voice",
  "visual_style",
  "target_audience",
  "default_cta",
  "default_whatsapp",
  "required_elements",
  "forbidden_elements",
  "reference_image_urls",
  "generation_instructions",
  "extra_config"
];

async function handleUpdateBrandKit(req, res) {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");

    const fields = brandKitUpdatableFields.filter((field) => Object.prototype.hasOwnProperty.call(req.body, field));
    if (!fields.length) return fail(res, 400, "Nenhum campo válido enviado.");

    const values = fields.map((field) => req.body[field]);
    const assignments = fields.map((field, index) => `${field} = $${index + 1}`);
    values.push(req.params.id, organizationId);

    const result = await query(
      `update public.brand_kits
       set ${assignments.join(", ")}, updated_at = now()
       where id = $${fields.length + 1} and organization_id = $${fields.length + 2}
       returning *`,
      values
    );

    if (!result.rowCount) return fail(res, 404, "Kit de marca não encontrado.");
    return ok(res, { data: result.rows[0] });
  } catch (error) {
    return fail(res, 500, "Não foi possível atualizar o kit de marca.", error.message);
  }
}

async function handleGetBrandKit(req, res) {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");

    const result = await query(
      `select * from public.brand_kits
       where organization_id = $1 and is_active = true
       order by is_default desc, updated_at desc
       limit 1`,
      [organizationId]
    );

    if (!result.rowCount) return fail(res, 404, "Kit de marca ativo não encontrado.");
    return ok(res, { data: result.rows[0] });
  } catch (error) {
    return fail(res, 500, "Não foi possível carregar o kit de marca.", error.message);
  }
}

async function handleInitializeBrandKit(req, res) {
  const client = await pool.connect();

  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");

    await client.query("begin");

    let brandKitResult = await client.query(
      `select * from public.brand_kits
       where organization_id = $1 and is_active = true
       order by is_default desc, updated_at desc
       limit 1
       for update`,
      [organizationId]
    );

    if (!brandKitResult.rowCount) {
      brandKitResult = await client.query(
        `insert into public.brand_kits (
           organization_id, name, primary_color, secondary_color, accent_color,
           font_family, brand_voice, visual_style, default_cta,
           required_elements, forbidden_elements, generation_instructions,
           extra_config, is_default, is_active
         ) values (
           $1, 'Kit de Marca Padrão', '#081A4B', '#008CFF', '#00C8FF',
           'Inter',
           'Profissional, clara, confiável, objetiva e orientada a resultados.',
           'Visual moderno, profissional, limpo, com alto contraste e composição orientada à conversão.',
           'SAIBA_MAIS',
           array[
             'Usar o logotipo oficial fornecido pelo cliente na composição final',
             'Manter alto contraste e leitura fácil em telas pequenas',
             'Reservar área segura para headline e CTA'
           ]::text[],
           array[
             'Não redesenhar ou deformar o logotipo',
             'Não inserir texto dentro da imagem gerada pela IA',
             'Não criar promessas ou resultados não comprovados',
             'Não usar marcas de terceiros sem autorização'
           ]::text[],
           'Gerar somente a imagem-base, sem texto, sem logotipo e sem CTA. Criar uma composição publicitária profissional com área visual limpa para aplicação posterior dos elementos da marca.',
           '{"default_variants":3,"default_quality":"medium","default_model":"gpt-image-2","human_approval_required":true,"publish_paused_by_default":true}'::jsonb,
           true, true
         )
         on conflict (organization_id, name)
         do update set
           is_default = true,
           is_active = true,
           updated_at = now()
         returning *`,
        [organizationId]
      );
    }

    const brandKit = brandKitResult.rows[0];
    const templateResult = await client.query(
      `insert into public.creative_templates (
         organization_id, brand_kit_id, name, template_type, placement,
         aspect_ratio, width, height, prompt_template, overlay_config,
         is_default, is_active
       ) values (
         $1, $2, 'Meta Feed Quadrado 1:1', 'social_ad', 'meta_feed',
         '1:1', 1080, 1080,
         'Crie uma imagem-base publicitária profissional para {{product_service}}, voltada a {{target_audience}}. Objetivo da campanha: {{objective}}. Conceito visual: {{creative_notes}}. Use o estilo da marca: {{visual_style}}. Não coloque palavras, letras, logotipos, botões ou marcas d''água. Reserve áreas limpas para aplicação posterior da headline, do logotipo e do CTA.',
         '{
           "canvas":{"width":1080,"height":1080,"background":"#081A4B","safe_margin":64},
           "overlay":{"enabled":true,"type":"bottom_gradient","from":"transparent","to":"rgba(8,26,75,0.94)","height_percent":48},
           "logo":{"position":"top_left","max_width":300,"max_height":120},
           "headline":{"position":"bottom_left","max_width":820,"font_size":68,"font_weight":700,"color":"#FFFFFF","max_lines":3},
           "cta":{"position":"bottom_left","background":"#008CFF","color":"#FFFFFF","font_size":30,"border_radius":18}
         }'::jsonb,
         true, true
       )
       on conflict (organization_id, name)
       do update set
         brand_kit_id = excluded.brand_kit_id,
         is_default = true,
         is_active = true,
         updated_at = now()
       returning *`,
      [organizationId, brandKit.id]
    );

    await client.query("commit");
    return ok(res, {
      message: "Kit de marca e template inicializados.",
      data: {
        brand_kit: brandKit,
        template: templateResult.rows[0]
      }
    });
  } catch (error) {
    await client.query("rollback").catch(() => null);
    return fail(res, 500, "Não foi possível inicializar o kit de marca.", error.message);
  } finally {
    client.release();
  }
}

async function handleListCreatives(req, res) {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");

    const result = await query(
      `select gc.*
       from public.generated_creatives gc
       where gc.campaign_id = $1 and gc.organization_id = $2
       order by gc.created_at desc, gc.variant_number asc`,
      [req.params.campaignId, organizationId]
    );

    return ok(res, { data: result.rows });
  } catch (error) {
    return fail(res, 500, "Não foi possível carregar os criativos gerados.", error.message);
  }
}

async function handleApproveCreative(req, res) {
  const client = await pool.connect();
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");

    await client.query("begin");
    const current = await client.query(
      `select * from public.generated_creatives
       where id = $1 and organization_id = $2
       limit 1`,
      [req.params.id, organizationId]
    );

    if (!current.rowCount) {
      await client.query("rollback");
      return fail(res, 404, "Criativo não encontrado.");
    }

    const creative = current.rows[0];
    if (!creative.final_image_url) {
      await client.query("rollback");
      return fail(res, 400, "O criativo ainda não possui composição final.");
    }

    await client.query(
      `update public.generated_creatives
       set is_selected = false,
           status = case when status = 'approved' then 'generated' else status end,
           updated_at = now()
       where campaign_id = $1 and organization_id = $2`,
      [creative.campaign_id, organizationId]
    );

    await client.query(
      `update public.paid_traffic_media
       set is_primary = false, updated_at = now()
       where campaign_id = $1 and organization_id = $2`,
      [creative.campaign_id, organizationId]
    );

    const approved = await client.query(
      `update public.generated_creatives
       set status = 'approved', is_selected = true,
           metadata = coalesce(metadata, '{}'::jsonb) || $1::jsonb,
           updated_at = now()
       where id = $2 and organization_id = $3
       returning *`,
      [JSON.stringify({ approved_at: new Date().toISOString() }), creative.id, organizationId]
    );

    if (creative.media_id) {
      await client.query(
        `update public.paid_traffic_media
         set is_primary = true, updated_at = now()
         where id = $1 and organization_id = $2`,
        [creative.media_id, organizationId]
      );
    }

    await client.query("commit");
    return ok(res, { message: "Criativo aprovado e marcado como principal.", data: approved.rows[0] });
  } catch (error) {
    await client.query("rollback").catch(() => null);
    return fail(res, 500, "Não foi possível aprovar o criativo.", error.message);
  } finally {
    client.release();
  }
}

async function handleRejectCreative(req, res) {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");

    const result = await query(
      `update public.generated_creatives
       set status = 'rejected', is_selected = false,
           metadata = coalesce(metadata, '{}'::jsonb) || $1::jsonb,
           updated_at = now()
       where id = $2 and organization_id = $3
       returning *`,
      [
        JSON.stringify({
          rejected_at: new Date().toISOString(),
          rejection_reason: req.body?.reason || null
        }),
        req.params.id,
        organizationId
      ]
    );

    if (!result.rowCount) return fail(res, 404, "Criativo não encontrado.");
    return ok(res, { message: "Criativo rejeitado.", data: result.rows[0] });
  } catch (error) {
    return fail(res, 500, "Não foi possível rejeitar o criativo.", error.message);
  }
}

function registerCreativeCompositionRoutes(app) {
  if (app.__be2bCreativeCompositionRegistered) return;
  app.__be2bCreativeCompositionRegistered = true;

  const stackBefore = app._router?.stack?.length || 0;
  app.get("/api/creative/brand-kit", handleGetBrandKit);
  app.post("/api/creative/brand-kit/initialize", handleInitializeBrandKit);
  app.post("/api/creative/compose", handleComposeCreative);
  app.patch("/api/creative/brand-kits/:id", handleUpdateBrandKit);
  app.get("/api/creative/campaigns/:campaignId/creatives", handleListCreatives);
  app.post("/api/creative/:id/approve", handleApproveCreative);
  app.post("/api/creative/:id/reject", handleRejectCreative);

  const stack = app._router?.stack;
  if (!stack || stack.length <= stackBefore) return;
  const previousLayers = stack.slice(0, stackBefore);
  const addedLayers = stack.slice(stackBefore);
  const fallbackIndex = Math.max(previousLayers.length - 1, 0);
  stack.splice(0, stack.length, ...previousLayers.slice(0, fallbackIndex), ...addedLayers, ...previousLayers.slice(fallbackIndex));
}

if (!express.application.__be2bCreativeCompositionPatched) {
  express.application.__be2bCreativeCompositionPatched = true;
  const originalListen = express.application.listen;

  express.application.listen = function patchedListen(...args) {
    registerCreativeCompositionRoutes(this);
    return originalListen.apply(this, args);
  };
}
