import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { pool, query } from "./db.js";

const OPENAI_IMAGES_URL = "https://api.openai.com/v1/images/generations";
const OPENAI_IMAGE_EDITS_URL = "https://api.openai.com/v1/images/edits";
const UPLOAD_ROOT = process.env.UPLOAD_DIR || "/app/uploads";
const MAX_REFERENCE_BYTES = 15 * 1024 * 1024;

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

function publicFileUrl(storageKey) {
  const base = (process.env.MEDIA_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || "https://api.be2b.tech")
    .replace(/\/$/, "");
  return base.endsWith("/uploads") ? `${base}/${storageKey}` : `${base}/uploads/${storageKey}`;
}

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function removeQuietly(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // A limpeza não deve esconder o erro original.
  }
}

function clampVariants(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return 3;
  return Math.min(Math.max(parsed, 1), 4);
}

function normalizeQuality(value) {
  return ["auto", "low", "medium", "high"].includes(value) ? value : "medium";
}

function normalizeSize(value) {
  const size = String(value || "1024x1024").toLowerCase();
  const match = size.match(/^(\d{3,4})x(\d{3,4})$/);
  if (!match) return "1024x1024";

  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  const ratio = Math.max(width, height) / Math.min(width, height);

  if (
    width > 3840 ||
    height > 3840 ||
    width % 16 !== 0 ||
    height % 16 !== 0 ||
    pixels < 655360 ||
    pixels > 8294400 ||
    ratio > 3
  ) {
    return "1024x1024";
  }

  return `${width}x${height}`;
}

function dimensionsFromSize(size) {
  const [width, height] = size.split("x").map(Number);
  return { width, height };
}

function fillTemplate(template, variables) {
  return String(template || "")
    .replace(/{{\s*([a-z_]+)\s*}}/gi, (_, key) => String(variables[key] || "").trim())
    .replace(/\s+/g, " ")
    .trim();
}

function buildImagePrompt({ campaign, brandKit, template, additions }) {
  const variables = {
    product_service: campaign.product_service || campaign.name,
    target_audience: campaign.target_audience || brandKit.target_audience,
    objective: campaign.objective,
    creative_notes: campaign.creative_notes || "composição moderna, profissional e orientada à conversão",
    visual_style: brandKit.visual_style
  };

  const basePrompt = fillTemplate(
    template.prompt_template ||
      "Crie uma imagem-base publicitária profissional para {{product_service}}, voltada a {{target_audience}}. Objetivo: {{objective}}. Estilo visual: {{visual_style}}. Não inclua texto, logotipo, botão ou marca d'água.",
    variables
  );

  const parts = [
    basePrompt,
    brandKit.generation_instructions,
    brandKit.primary_color || brandKit.secondary_color || brandKit.accent_color
      ? `Paleta visual de referência: ${[brandKit.primary_color, brandKit.secondary_color, brandKit.accent_color].filter(Boolean).join(", ")}.`
      : null,
    Array.isArray(brandKit.forbidden_elements) && brandKit.forbidden_elements.length
      ? `Restrições: ${brandKit.forbidden_elements.join("; ")}.`
      : null,
    additions ? `Orientações adicionais: ${String(additions).trim()}` : null,
    "Produza somente a arte visual de fundo. Não escreva nenhuma palavra, letra, número, logotipo, botão, legenda ou marca d'água. Preserve áreas visualmente limpas para a composição posterior da marca."
  ];

  return parts.filter(Boolean).join("\n\n");
}

async function loadConfiguration({ organizationId, campaignId, brandKitId, templateId }) {
  const campaignResult = await query(
    `select * from public.paid_traffic_campaigns where id = $1 and organization_id = $2 limit 1`,
    [campaignId, organizationId]
  );
  const campaign = campaignResult.rows[0];
  if (!campaign) return { error: "Campanha não encontrada." };

  const brandKitResult = brandKitId
    ? await query(
        `select * from public.brand_kits where id = $1 and organization_id = $2 and is_active = true limit 1`,
        [brandKitId, organizationId]
      )
    : await query(
        `select * from public.brand_kits where organization_id = $1 and is_default = true and is_active = true order by updated_at desc limit 1`,
        [organizationId]
      );
  const brandKit = brandKitResult.rows[0];
  if (!brandKit) return { error: "Kit de marca ativo não encontrado." };

  const templateResult = templateId
    ? await query(
        `select * from public.creative_templates where id = $1 and organization_id = $2 and is_active = true limit 1`,
        [templateId, organizationId]
      )
    : await query(
        `select * from public.creative_templates where organization_id = $1 and brand_kit_id = $2 and is_default = true and is_active = true order by updated_at desc limit 1`,
        [organizationId, brandKit.id]
      );
  const template = templateResult.rows[0];
  if (!template) return { error: "Template criativo ativo não encontrado." };

  return { campaign, brandKit, template };
}

async function downloadReferenceImage(url, index) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("URL de referência inválida.");

  const response = await fetch(parsed, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Não foi possível baixar a referência ${index + 1}: HTTP ${response.status}.`);

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_REFERENCE_BYTES) throw new Error(`A referência ${index + 1} excede 15 MB.`);

  const contentType = response.headers.get("content-type")?.split(";")[0] || "image/png";
  if (!contentType.startsWith("image/")) throw new Error(`A referência ${index + 1} não é uma imagem.`);
  const extension = contentType === "image/jpeg" ? "jpg" : contentType === "image/webp" ? "webp" : "png";
  return { buffer, contentType, fileName: `referencia-${index + 1}.${extension}` };
}

async function requestOpenAIImages({ apiKey, model, prompt, variants, size, quality, referenceImageUrls = [] }) {
  const references = referenceImageUrls.filter(Boolean).slice(0, 4);
  let response;

  if (references.length > 0) {
    const downloaded = await Promise.all(references.map(downloadReferenceImage));
    const form = new FormData();
    form.set("model", model);
    form.set("prompt", `${prompt}\n\nUse as imagens anexadas somente como referências visuais autorizadas de estilo, produto, ambiente e composição. Não copie textos nem inclua logotipos na imagem-base.`);
    form.set("n", String(variants));
    form.set("size", size);
    form.set("quality", quality);
    form.set("output_format", "png");

    for (const item of downloaded) {
      form.append("image[]", new Blob([item.buffer], { type: item.contentType }), item.fileName);
    }

    response = await fetch(OPENAI_IMAGE_EDITS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form
    });
  } else {
    response = await fetch(OPENAI_IMAGES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        prompt,
        n: variants,
        size,
        quality,
        output_format: "png",
        background: "opaque"
      })
    });
  }

  const body = await response.json().catch(() => ({}));
  const requestId = response.headers.get("x-request-id");

  if (!response.ok) {
    const error = new Error(body?.error?.message || `OpenAI Images API retornou HTTP ${response.status}.`);
    error.status = response.status;
    error.code = body?.error?.code || body?.error?.type || null;
    error.requestId = requestId;
    error.openai = body?.error || null;
    throw error;
  }

  if (!Array.isArray(body.data) || body.data.length === 0) {
    throw new Error("A OpenAI não retornou nenhuma imagem.");
  }

  return { body, requestId, mode: references.length > 0 ? "edit_with_references" : "generation" };
}

async function handleGenerateCreative(req, res) {
  const apiKey = process.env.OPENAI_API_KEY;
  let jobId = null;
  const savedFiles = [];

  try {
    if (!apiKey) return fail(res, 503, "OPENAI_API_KEY não está configurada no serviço.");

    const organizationId = getOrganizationId(req);
    const campaignId = req.body?.campaign_id;
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");
    if (!campaignId) return fail(res, 400, "campaign_id é obrigatório.");

    const configuration = await loadConfiguration({
      organizationId,
      campaignId,
      brandKitId: req.body?.brand_kit_id,
      templateId: req.body?.template_id
    });
    if (configuration.error) return fail(res, 404, configuration.error);

    const { campaign, brandKit, template } = configuration;
    const variants = clampVariants(req.body?.variants ?? brandKit.extra_config?.default_variants);
    const quality = normalizeQuality(req.body?.quality ?? brandKit.extra_config?.default_quality);
    const size = normalizeSize(req.body?.size || "1024x1024");
    const model = String(brandKit.extra_config?.default_model || "gpt-image-2");
    const prompt = buildImagePrompt({
      campaign,
      brandKit,
      template,
      additions: req.body?.prompt_additions
    });

    const jobResult = await query(
      `insert into public.creative_generation_jobs (
        organization_id, campaign_id, brand_kit_id, template_id, requested_by,
        provider, model, briefing, prompt, requested_variants, output_size,
        output_quality, status, started_at
      ) values ($1, $2, $3, $4, $5, 'openai', $6, $7::jsonb, $8, $9, $10, $11, 'generating', now())
      returning *`,
      [
        organizationId,
        campaignId,
        brandKit.id,
        template.id,
        req.body?.requested_by || null,
        model,
        JSON.stringify({
          product_service: campaign.product_service,
          objective: campaign.objective,
          target_audience: campaign.target_audience,
          prompt_additions: req.body?.prompt_additions || null,
          reference_image_urls: brandKit.reference_image_urls || []
        }),
        prompt,
        variants,
        size,
        quality
      ]
    );
    jobId = jobResult.rows[0].id;

    const generated = await requestOpenAIImages({
      apiKey,
      model,
      prompt,
      variants,
      size,
      quality,
      referenceImageUrls: brandKit.reference_image_urls || []
    });
    const images = generated.body.data.filter((item) => item?.b64_json);
    if (images.length === 0) throw new Error("A OpenAI retornou uma resposta sem conteúdo de imagem.");

    const organizationSegment = safeSegment(organizationId);
    const campaignSegment = safeSegment(campaignId);
    const destinationDir = path.join(UPLOAD_ROOT, "campaigns", organizationSegment, campaignSegment, "ai");
    ensureDir(destinationDir);
    const { width, height } = dimensionsFromSize(size);

    const prepared = images.map((image, index) => {
      const bytes = Buffer.from(image.b64_json, "base64");
      const fileName = `criativo-ia-${Date.now()}-${index + 1}-${crypto.randomBytes(4).toString("hex")}.png`;
      const storageKey = `campaigns/${organizationSegment}/${campaignSegment}/ai/${fileName}`;
      const filePath = path.join(destinationDir, fileName);
      fs.writeFileSync(filePath, bytes);
      savedFiles.push(filePath);
      return {
        variantNumber: index + 1,
        fileName,
        storageKey,
        filePath,
        fileUrl: publicFileUrl(storageKey),
        sizeBytes: bytes.length,
        revisedPrompt: image.revised_prompt || null
      };
    });

    const client = await pool.connect();
    let creatives;
    try {
      await client.query("begin");
      creatives = [];

      for (const item of prepared) {
        const mediaResult = await client.query(
          `insert into public.paid_traffic_media (
            campaign_id, organization_id, file_name, file_url, thumbnail_url,
            mime_type, size_bytes, storage_key, media_type, is_primary
          ) values ($1, $2, $3, $4, $4, 'image/png', $5, $6, 'image', false)
          returning *`,
          [campaignId, organizationId, item.fileName, item.fileUrl, item.sizeBytes, item.storageKey]
        );

        const creativeResult = await client.query(
          `insert into public.generated_creatives (
            organization_id, campaign_id, job_id, media_id, variant_number,
            headline, primary_text, cta, image_prompt, revised_prompt,
            raw_image_url, thumbnail_url, mime_type, width, height, model,
            status, is_selected, metadata
          ) values (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9, $10,
            $11, $11, 'image/png', $12, $13, $14,
            'generated', false, $15::jsonb
          ) returning *`,
          [
            organizationId,
            campaignId,
            jobId,
            mediaResult.rows[0].id,
            item.variantNumber,
            campaign.ad_title,
            campaign.ad_primary_text,
            campaign.cta || brandKit.default_cta,
            prompt,
            item.revisedPrompt,
            item.fileUrl,
            width,
            height,
            model,
            JSON.stringify({
              provider: "openai",
              generation_mode: generated.mode,
              reference_image_count: (brandKit.reference_image_urls || []).length,
              provider_request_id: generated.requestId,
              composition_pending: true,
              template_id: template.id,
              brand_kit_id: brandKit.id
            })
          ]
        );

        creatives.push({
          ...creativeResult.rows[0],
          media: mediaResult.rows[0]
        });
      }

      const providerResponse = {
        request_id: generated.requestId,
        mode: generated.mode,
        created: generated.body.created || null,
        output_count: creatives.length,
        usage: generated.body.usage || null
      };

      await client.query(
        `update public.creative_generation_jobs
         set status = 'completed', provider_response = $1::jsonb, completed_at = now(), updated_at = now()
         where id = $2`,
        [JSON.stringify(providerResponse), jobId]
      );

      await client.query("commit");
    } catch (databaseError) {
      await client.query("rollback");
      throw databaseError;
    } finally {
      client.release();
    }

    return ok(res, {
      message: `${creatives.length} criativo(s) base gerado(s) pela IA.`,
      data: {
        job_id: jobId,
        campaign_id: campaignId,
        model,
        size,
        quality,
        composition_pending: true,
        creatives
      }
    });
  } catch (error) {
    savedFiles.forEach(removeQuietly);

    if (jobId) {
      await query(
        `update public.creative_generation_jobs
         set status = 'failed', error_message = $1, provider_response = $2::jsonb, completed_at = now(), updated_at = now()
         where id = $3`,
        [
          error.message,
          JSON.stringify({
            request_id: error.requestId || null,
            code: error.code || null,
            status: error.status || null,
            error: error.openai || null
          }),
          jobId
        ]
      ).catch(() => null);
    }

    const status = Number(error.status) >= 400 && Number(error.status) < 500 ? 400 : 500;
    return fail(res, status, "Não foi possível gerar os criativos com IA.", {
      message: error.message,
      code: error.code || null,
      request_id: error.requestId || null
    });
  }
}

function registerCreativeGenerationRoutes(app) {
  if (app.__be2bCreativeGenerationRegistered) return;
  app.__be2bCreativeGenerationRegistered = true;

  const stackBefore = app._router?.stack?.length || 0;
  app.post("/api/creative/generate", handleGenerateCreative);

  const stack = app._router?.stack;
  if (!stack || stack.length <= stackBefore) return;

  const previousLayers = stack.slice(0, stackBefore);
  const addedLayers = stack.slice(stackBefore);
  const fallbackIndex = Math.max(previousLayers.length - 1, 0);

  stack.splice(0, stack.length, ...previousLayers.slice(0, fallbackIndex), ...addedLayers, ...previousLayers.slice(fallbackIndex));
}

if (!express.application.__be2bCreativeGenerationPatched) {
  express.application.__be2bCreativeGenerationPatched = true;
  const originalListen = express.application.listen;

  express.application.listen = function patchedListen(...args) {
    registerCreativeGenerationRoutes(this);
    return originalListen.apply(this, args);
  };
}
