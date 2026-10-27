import fs from "node:fs";
import path from "node:path";

function mimeFromExt(ext) {
  const m = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
  };
  return m[ext.toLowerCase()] || "image/png";
}

/**
 * Upload a local image file to Substack.
 * Returns { url, imageWidth, imageHeight, bytes, id }.
 * Per API_REFERENCE.md: POST {pub}/image {image: "data:image/png;base64,..."} -> {url, bytes, imageWidth, imageHeight}
 */
export async function uploadImage({ sid, publicationUrl, filePath }) {
  if (!fs.existsSync(filePath)) throw new Error(`Image not found: ${filePath}`);
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath) || ".png";
  const mime = mimeFromExt(ext);
  const b64 = buf.toString("base64");
  const dataUri = `data:${mime};base64,${b64}`;

  let host = publicationUrl;
  if (!host.startsWith("http")) host = `https://${host}`;
  const url = `${host.replace(/\/+$/, "")}/api/v1/image`;

  const r = await fetch(url, {
    method: "POST",
    headers: { Cookie: `substack.sid=${sid}`, "Content-Type": "application/json" },
    body: JSON.stringify({ image: dataUri }),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(`POST /image HTTP ${r.status}: ${text.slice(0, 600)}`);
  // normalize keys: bytes / imageWidth / imageHeight (some responses camel differently)
  return {
    id: json.id,
    url: json.url,
    bytes: json.bytes,
    imageWidth: json.imageWidth ?? json.width,
    imageHeight: json.imageHeight ?? json.height,
    contentType: json.contentType || mime,
    raw: json,
  };
}

/**
 * Build a Substack imageGallery node (side-by-side images).
 * Schema reverse-engineered from the editor bundle: a block atom whose
 * attrs.gallery holds { images: [{type, src}], caption, alt, staticGalleryImage }.
 */
export function buildGallery({ images, caption, alt }) {
  return {
    type: "imageGallery",
    attrs: {
      gallery: {
        images: images.map((i) => ({ type: i.type || "image/png", src: i.src })),
        caption: caption || null,
        alt: alt || null,
        staticGalleryImage: null,
      },
    },
  };
}

/**
 * Ask Substack for the flattened "static gallery" image used in email and in
 * clients without gallery support. Falls back to the first image on failure.
 */
export async function uploadGalleryStatic({ sid, publicationUrl, images, caption, alt }) {
  let host = publicationUrl;
  if (!host.startsWith("http")) host = `https://${host}`;
  const url = `${host.replace(/\/+$/, "")}/api/v1/image-gallery`;
  const gallery = { images, caption: caption || "", alt: alt || "" };
  const r = await fetch(url, {
    method: "POST",
    headers: { Cookie: `substack.sid=${sid}`, "Content-Type": "application/json" },
    body: JSON.stringify({ gallery }),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(`POST /image-gallery HTTP ${r.status}: ${text.slice(0, 300)}`);
  if (!json?.url) throw new Error("POST /image-gallery returned no url");
  return { type: json.contentType || "image/png", src: json.url };
}

/**
 * Scan markdown for local image refs ![alt](path) where path is not http(s) nor data:.
 * Returns array of {alt, src, title, fullMatch}
 */
export function findLocalImages(markdown) {
  const re = /!\[([^\]]*)\]\((\S+?)(?:\s+"([^"]*)")?\)/g;
  const out = [];
  let m;
  while ((m = re.exec(markdown))) {
    const src = m[2];
    if (/^https?:\/\//i.test(src) || src.startsWith("data:")) continue;
    out.push({ alt: m[1], src, title: m[3] || null, fullMatch: m[0] });
  }
  return out;
}

/**
 * Build a captionedImage node from an uploaded image.
 * Per API_REFERENCE.md: captionedImage > image2 + caption
 */
export function buildCaptionedImage({ url, alt, caption, imageWidth, imageHeight, bytes }) {
  const captionNodes = caption ? [{ type: "text", text: caption }] : [];
  return {
    type: "captionedImage",
    content: [
      {
        type: "image2",
        attrs: {
          src: url,
          srcNoWatermark: null,
          fullscreen: null,
          imageSize: null,
          width: imageWidth,
          height: imageHeight,
          resizeWidth: null,
          bytes: bytes,
          alt: alt || null,
          title: null,
          type: "image/png",
          href: null,
          belowTheFold: false,
          topImage: false,
          internalRedirect: null,
        },
      },
      {
        type: "caption",
        content: captionNodes,
      },
    ],
  };
}
