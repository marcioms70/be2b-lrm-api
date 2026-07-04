import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const UPLOAD_ROOT = process.env.UPLOAD_DIR || "/app/uploads";
const TMP_DIR = path.join(UPLOAD_ROOT, "_tmp");

const MAX_IMAGE_MB = Number(process.env.MAX_IMAGE_MB || 10);
const MAX_PDF_MB = Number(process.env.MAX_PDF_MB || 20);
const MAX_VIDEO_MB = Number(process.env.MAX_VIDEO_MB || 100);
const MAX_UPLOAD_MB = Math.max(MAX_IMAGE_MB, MAX_PDF_MB, MAX_VIDEO_MB);

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "application/pdf"
]);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
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

function safeFileName(originalName = "arquivo") {
  const ext = path.extname(originalName).toLowerCase();
  const base = path.basename(originalName, ext);
  const cleanBase = safeSegment(base, "arquivo").toLowerCase();
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const id = crypto.randomBytes(4).toString("hex");
  return `${cleanBase}-${stamp}-${id}${ext}`;
}

function inferMediaType(mimeType) {
  if (mimeType?.startsWith("image/")) return "image";
  if (mimeType?.startsWith("video/")) return "video";
  if (mimeType === "application/pdf") return "pdf";
  return "other";
}

function maxBytesForMime(mimeType) {
  if (mimeType?.startsWith("image/")) return MAX_IMAGE_MB * 1024 * 1024;
  if (mimeType?.startsWith("video/")) return MAX_VIDEO_MB * 1024 * 1024;
  if (mimeType === "application/pdf") return MAX_PDF_MB * 1024 * 1024;
  return 0;
}

function getPublicBaseUrl(req) {
  const configured = process.env.MEDIA_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

function removeQuietly(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

ensureDir(TMP_DIR);

const upload = multer({
  dest: TMP_DIR,
  limits: {
    fileSize: MAX_UPLOAD_MB * 1024 * 1024,
    files: 1
  },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(new Error(`Tipo de arquivo não permitido: ${file.mimetype}`));
    }
    return cb(null, true);
  }
});

function mediaUploadHandler(req, res) {
  upload.single("file")(req, res, (error) => {
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.message || "Não foi possível enviar a mídia."
      });
    }

    try {
      const file = req.file;
      const organizationId = safeSegment(req.body.organization_id);
      const campaignId = safeSegment(req.body.campaign_id);

      if (!file) {
        return res.status(400).json({ success: false, message: "Arquivo é obrigatório." });
      }

      if (!req.body.organization_id || !req.body.campaign_id) {
        removeQuietly(file.path);
        return res.status(400).json({
          success: false,
          message: "organization_id e campaign_id são obrigatórios."
        });
      }

      const maxBytes = maxBytesForMime(file.mimetype);
      if (!maxBytes || file.size > maxBytes) {
        removeQuietly(file.path);
        return res.status(400).json({
          success: false,
          message: "Arquivo excede o tamanho permitido para este tipo."
        });
      }

      const mediaType = req.body.media_type || inferMediaType(file.mimetype);
      const fileName = safeFileName(file.originalname);
      const storageKey = `campaigns/${organizationId}/${campaignId}/${fileName}`;
      const destinationDir = path.join(UPLOAD_ROOT, "campaigns", organizationId, campaignId);
      const destinationPath = path.join(destinationDir, fileName);

      ensureDir(destinationDir);
      fs.renameSync(file.path, destinationPath);

      const publicBaseUrl = getPublicBaseUrl(req);
      const fileUrl = `${publicBaseUrl}/uploads/${storageKey}`;
      const thumbnailUrl = mediaType === "image" ? fileUrl : null;

      return res.json({
        success: true,
        file_name: fileName,
        file_url: fileUrl,
        thumbnail_url: thumbnailUrl,
        mime_type: file.mimetype,
        size_bytes: file.size,
        storage_key: storageKey,
        media_type: mediaType
      });
    } catch (handlerError) {
      if (req.file?.path) removeQuietly(req.file.path);
      return res.status(500).json({
        success: false,
        message: "Não foi possível salvar a mídia no servidor."
      });
    }
  });
}

function registerMediaRoutes(app) {
  if (app.__be2bMediaUploadRegistered) return;
  app.__be2bMediaUploadRegistered = true;

  const stackBefore = app._router?.stack?.length || 0;

  app.use(
    "/uploads",
    express.static(UPLOAD_ROOT, {
      fallthrough: false,
      maxAge: "7d",
      immutable: false
    })
  );

  app.post("/api/media/upload", mediaUploadHandler);

  const stack = app._router?.stack;
  if (!stack || stack.length <= stackBefore) return;

  const previousLayers = stack.slice(0, stackBefore);
  const addedLayers = stack.slice(stackBefore);

  // O server.js registra um fallback 404 com app.use(...) antes do app.listen.
  // Como este arquivo é carregado via --import, reposicionamos as rotas de mídia
  // antes desse fallback para que /api/media/upload e /uploads funcionem.
  const fallbackIndex = Math.max(previousLayers.length - 1, 0);
  stack.splice(
    0,
    stack.length,
    ...previousLayers.slice(0, fallbackIndex),
    ...addedLayers,
    ...previousLayers.slice(fallbackIndex)
  );
}

if (!express.application.__be2bMediaUploadPatched) {
  express.application.__be2bMediaUploadPatched = true;
  const originalListen = express.application.listen;

  express.application.listen = function patchedListen(...args) {
    registerMediaRoutes(this);
    return originalListen.apply(this, args);
  };
}
