//! Image processor — the `image` crate for decoding, `fast_image_resize` for
//! the operation that dominates the workload, `image-webp`/`resvg` for the
//! formats sharp used to cover.
//!
//! Option keys are the Node service's contract (`validateOptions.js`). Options
//! this build cannot honour are **refused by name**: silently ignoring one
//! returns media that looks right and is not.

use std::io::Cursor;

use image::{DynamicImage, ImageFormat, ImageReader};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Crop {
    #[serde(default)]
    pub x: u32,
    #[serde(default)]
    pub y: u32,
    #[serde(alias = "w")]
    pub width: u32,
    #[serde(alias = "h")]
    pub height: u32,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImageOptions {
    pub max_dimension: Option<u32>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub quality: Option<u8>,
    pub format: Option<String>,
    pub strip_exif: Option<bool>,
    pub crop: Option<Crop>,
    pub rotate: Option<i32>,
    pub flip: Option<bool>,
    pub flop: Option<bool>,
    pub grayscale: Option<bool>,
    pub normalize: Option<bool>,
    pub blur: Option<f32>,
    /// "resvg" or "chromium" for SVG input. Default: chromium when installed, else resvg.
    pub engine: Option<String>,
    // Declared so the refusal can name them instead of tripping "unknown field".
    pub density: Option<f64>,
    #[serde(rename = "colorScheme")]
    pub color_scheme_camel: Option<String>,
    pub color_scheme: Option<String>,
    pub transparent: Option<bool>,
    pub svg: Option<serde_json::Value>,
    pub background: Option<String>,
}

pub struct Processed {
    pub bytes: Vec<u8>,
    pub ext: &'static str,
    pub mime: &'static str,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Target {
    Png,
    Jpeg,
    Gif,
    Bmp,
    Tiff,
    Ico,
    Tga,
    WebP,
    Avif,
}

/// Output formats this build can actually write, for `/health` and
/// `/v1/capabilities` — a caller should learn "no AVIF" from discovery, not from
/// a failed job.
pub fn supported_outputs() -> Vec<&'static str> {
    let mut out = vec!["png", "jpeg", "gif", "bmp", "tiff", "ico", "tga", "webp"];
    if cfg!(feature = "avif") {
        out.push("avif");
    }
    out
}

pub fn supported_inputs() -> Vec<&'static str> {
    let mut out = vec![
        "png", "jpeg", "gif", "bmp", "tiff", "ico", "tga", "webp", "svg", "heic",
    ];
    if cfg!(feature = "avif") {
        out.push("avif");
    }
    out
}

/// Boundary validation, called before a job is admitted.
pub fn validate(opts: &ImageOptions) -> Result<(), String> {
    refuse_engine_only(opts)?;
    if opts.strip_exif == Some(false) {
        return Err(
            "strip_exif:false cannot be honoured — this build always re-encodes, which drops \
             metadata. Omit the option (metadata is stripped)."
                .into(),
        );
    }
    if let Some(engine) = opts.engine.as_deref() {
        match engine.to_ascii_lowercase().as_str() {
            "auto" | "resvg" | "chromium" | "chrome" => {}
            other => return Err(format!("unknown engine '{other}' — resvg or chromium")),
        }
    }
    if let Some(format) = opts.format.as_deref() {
        let target = parse_target(format)?;
        if opts.quality.is_some() && !matches!(target, Target::Jpeg | Target::WebP | Target::Avif) {
            return Err(format!(
                "quality applies to JPEG, WebP and AVIF output; '{format}' has no quality knob — \
                 refusing rather than ignoring it"
            ));
        }
    } else if opts.quality.is_some() {
        return Err(
            "quality is only meaningful when 'format' names a lossy output (jpeg, webp, avif)".into(),
        );
    }
    Ok(())
}

pub fn process(bytes: &[u8], opts: &ImageOptions, work: &std::path::Path) -> Result<Processed, String> {
    refuse_engine_only(opts)?;
    let img = decode(bytes, opts, work)?;
    finish(img, opts, default_target(bytes))
}

/// Pixels that were decoded elsewhere (HEIC/HEIF through ffmpeg): apply the same
/// option set and encode, so one code path owns resizing and formats.
pub fn process_pixels(img: DynamicImage, opts: &ImageOptions) -> Result<Processed, String> {
    refuse_engine_only(opts)?;
    // A HEIC handed over without a format almost always wants a JPEG.
    finish(img, opts, Target::Jpeg)
}

fn finish(mut img: DynamicImage, opts: &ImageOptions, fallback: Target) -> Result<Processed, String> {

    if let Some(crop) = &opts.crop {
        let (w, h) = (img.width(), img.height());
        if crop.width == 0 || crop.height == 0 || crop.x >= w || crop.y >= h {
            return Err(format!(
                "crop {}x{} at {},{} is outside the {w}x{h} image",
                crop.width, crop.height, crop.x, crop.y
            ));
        }
        img = img.crop_imm(crop.x, crop.y, crop.width.min(w - crop.x), crop.height.min(h - crop.y));
    }

    img = apply_resize(img, opts)?;

    if let Some(degrees) = opts.rotate {
        img = match degrees.rem_euclid(360) {
            90 => img.rotate90(),
            180 => img.rotate180(),
            270 => img.rotate270(),
            0 => img,
            other => return Err(format!("rotate must be a multiple of 90, got {other}")),
        };
    }
    if opts.flip.unwrap_or(false) {
        img = img.flipv();
    }
    if opts.flop.unwrap_or(false) {
        img = img.fliph();
    }
    if opts.grayscale.unwrap_or(false) {
        img = img.grayscale();
    }
    if let Some(sigma) = opts.blur {
        // A radius wider than the image blurs to a flat field. Unbounded, the
        // kernel is request-controlled: JSON 1e40 becomes f32::INFINITY, which
        // passes a `> 0` guard and sizes an allocation the process cannot survive.
        let widest = img.width().max(img.height()) as f32;
        if !sigma.is_finite() || sigma < 0.0 {
            return Err(format!("blur must be a finite, non-negative number, got {sigma}"));
        }
        if sigma > widest {
            return Err(format!("blur {sigma} is wider than the image ({widest}px)"));
        }
        if sigma > 0.0 {
            let blurred = image::imageops::blur(&img.to_rgba8(), sigma);
            img = DynamicImage::ImageRgba8(blurred);
        }
    }
    if opts.normalize.unwrap_or(false) {
        img = normalize_contrast(img);
    }

    let target = match opts.format.as_deref() {
        Some(name) => parse_target(name)?,
        // No format requested: keep the input's, so a resize does not silently
        // re-encode a photo as PNG (or as WebP — that would be a behaviour change
        // nobody asked for).
        None => fallback,
    };

    // A format without alpha cannot carry transparency. Flattening silently onto
    // an arbitrary colour is how "the logo came out with a black box" happens.
    if matches!(target, Target::Jpeg | Target::Bmp) && has_transparency(&img) {
        img = match opts.background.as_deref() {
            Some(value) => match parse_color(value) {
                Some(rgba) => composite_over(img, rgba),
                None => {
                    return Err(format!(
                        "background '{value}' is not a colour — use #rgb, #rrggbb, #rrggbbaa, white or black"
                    ))
                }
            },
            // Explaining the choice beats inventing one: a caller who asks for
            // JPEG of a transparent image gets the reason and the remedy.
            None if opts.transparent == Some(false) => {
                composite_over(img, image::Rgba([255, 255, 255, 255]))
            }
            None => {
                return Err(format!(
                    "{} cannot carry transparency and no background was given — pass background \
                     (e.g. \"#ffffff\") or transparent:false, or choose png/webp",
                    ext_for(target)
                ))
            }
        };
    }
    let mut out = Vec::with_capacity(64 * 1024);
    encode(&img, target, opts.quality, &mut out)?;
    Ok(Processed {
        bytes: out,
        ext: ext_for(target),
        mime: mime_for(target),
        width: img.width(),
        height: img.height(),
    })
}

fn refuse_engine_only(opts: &ImageOptions) -> Result<(), String> {
    let mut refused: Vec<&str> = Vec::new();
    if opts.svg.is_some() {
        refused.push("svg");
    }
    if opts.density.is_some() {
        refused.push("density");
    }
    if opts.color_scheme.is_some() || opts.color_scheme_camel.is_some() {
        refused.push("colorScheme");
    }
    if refused.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "option(s) {} need raster-engine support this build does not have — refusing rather than ignoring them",
            refused.join(", ")
        ))
    }
}

// ─── background / alpha ──────────────────────────────────────────────────

fn parse_color(value: &str) -> Option<image::Rgba<u8>> {
    let text = value.trim().to_ascii_lowercase();
    let named = match text.as_str() {
        "white" => [255, 255, 255, 255],
        "black" => [0, 0, 0, 255],
        _ => {
            // Sliced as bytes: a byte range chosen from the length of a multibyte
            // string lands mid-character, and `&hex[1..2]` would panic.
            let hex = text.trim_start_matches('#').as_bytes();
            if !hex.is_ascii() {
                return None;
            }
            let parse = |s: &[u8]| std::str::from_utf8(s).ok().and_then(|s| u8::from_str_radix(s, 16).ok());
            match hex.len() {
                3 => {
                    let (r, g, b) = (parse(&hex[0..1])?, parse(&hex[1..2])?, parse(&hex[2..3])?);
                    [r * 17, g * 17, b * 17, 255]
                }
                6 => [parse(&hex[0..2])?, parse(&hex[2..4])?, parse(&hex[4..6])?, 255],
                8 => [
                    parse(&hex[0..2])?,
                    parse(&hex[2..4])?,
                    parse(&hex[4..6])?,
                    parse(&hex[6..8])?,
                ],
                _ => return None,
            }
        }
    };
    Some(image::Rgba(named))
}

fn has_transparency(img: &DynamicImage) -> bool {
    // Only a buffer with an alpha channel can carry transparency; converting an
    // opaque RGB photo to RGBA just to prove that costs a full-image copy.
    match img {
        DynamicImage::ImageRgba8(buffer) => buffer.pixels().any(|p| p.0[3] < 255),
        DynamicImage::ImageLumaA8(buffer) => buffer.pixels().any(|p| p.0[1] < 255),
        DynamicImage::ImageRgba16(buffer) => buffer.pixels().any(|p| p.0[3] < u16::MAX),
        DynamicImage::ImageLumaA16(buffer) => buffer.pixels().any(|p| p.0[1] < u16::MAX),
        _ => false,
    }
}

fn composite_over(img: DynamicImage, background: image::Rgba<u8>) -> DynamicImage {
    let mut canvas = image::RgbaImage::from_pixel(img.width(), img.height(), background);
    image::imageops::overlay(&mut canvas, &img.to_rgba8(), 0, 0);
    DynamicImage::ImageRgba8(canvas)
}

// ─── decode ──────────────────────────────────────────────────────────────

fn decode(bytes: &[u8], opts: &ImageOptions, work: &std::path::Path) -> Result<DynamicImage, String> {
    if looks_like_svg(bytes) {
        return decode_svg_with(bytes, opts, work);
    }
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| format!("cannot read image header: {e}"))?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(20_000);
    limits.max_image_height = Some(20_000);
    // Dimensions alone do not bound allocation: 20k x 20k RGBA is ~1.6 GB.
    limits.max_alloc = Some(512 * 1024 * 1024);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|e| format!("cannot decode image: {e} (supported: {})", supported_inputs().join(", ")))
}

fn looks_like_svg(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(2048)];
    // The cut can land inside a multibyte character; a valid SVG must not be
    // classified as not-SVG and handed to the raster decoder.
    let text = match std::str::from_utf8(head) {
        Ok(text) => text,
        Err(e) => std::str::from_utf8(&head[..e.valid_up_to()]).unwrap_or(""),
    };
    text.contains("<svg") || text.trim_start().starts_with("<?xml")
}

/// SVG lands here instead of a browser process: `resvg` renders it in-process.
/// Text uses the system font database, so the result depends on installed fonts —
/// a deployment fact, not ours.
fn decode_svg_with(bytes: &[u8], opts: &ImageOptions, work: &std::path::Path) -> Result<DynamicImage, String> {
    let engine = opts.engine.as_deref().unwrap_or("auto").to_ascii_lowercase();
    match engine.as_str() {
        "resvg" => decode_svg_resvg(bytes),
        "chromium" | "chrome" => decode_svg_chromium(bytes, work),
        "auto" => {
            if crate::chromium::chrome_path().is_some() {
                match decode_svg_chromium(bytes, work) {
                    Ok(img) => Ok(img),
                    Err(e) => {
                        tracing::warn!("chromium SVG render failed ({e}); falling back to resvg");
                        decode_svg_resvg(bytes)
                    }
                }
            } else {
                decode_svg_resvg(bytes)
            }
        }
        other => Err(format!("unknown engine '{other}' — resvg or chromium")),
    }
}

/// Rasterise with the browser: correct for CSS variables, media queries and font
/// weights, at the cost of a child process per call.
fn decode_svg_chromium(bytes: &[u8], work: &std::path::Path) -> Result<DynamicImage, String> {
    let (width, height) = svg_size(bytes)?;
    let page = crate::chromium::svg_page(bytes, width, height, "transparent");
    let shot = crate::chromium::screenshot_html(
        &page,
        width,
        height,
        work,
        true,
        std::time::Duration::from_secs(30),
    )?;
    image::load_from_memory(&shot.png)
        .map_err(|e| format!("cannot decode the browser's PNG: {e}"))
}

/// Width/height from the `<svg>` root, falling back to the viewBox. Cheap string
/// parsing: the numbers are attributes, not markup we need a parser for.
fn svg_size(bytes: &[u8]) -> Result<(u32, u32), String> {
    const MAX_EDGE: u32 = 8_192;
    let text = std::str::from_utf8(bytes).map_err(|_| "SVG is not UTF-8".to_string())?;
    let mut end = text.len().min(4096);
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    let head = &text[..end];

    fn attr(text: &str, name: &str) -> Option<f64> {
        // `width="` also occurs inside `stroke-width="`; only an attribute that
        // starts a word counts, or a child's stroke reads as the canvas size.
        let pattern = format!("{name}=\"");
        let mut from = 0;
        loop {
            let at = from + text[from..].find(&pattern)?;
            let starts_word = match text[..at].chars().next_back() {
                None => true,
                Some(previous) => previous.is_whitespace() || previous == '<',
            };
            if starts_word {
                let rest = &text[at + pattern.len()..];
                let end = rest.find('"')?;
                let value = rest[..end].trim_end_matches("px").trim();
                return value.parse::<f64>().ok();
            }
            from = at + text[at..].chars().next().map(char::len_utf8).unwrap_or(1);
        }
    }

    let (w, h) = match (attr(head, "width"), attr(head, "height")) {
        (Some(w), Some(h)) => (w, h),
        _ => {
            let start = head
                .find("viewBox=\"")
                .ok_or_else(|| "SVG has neither width/height nor a viewBox".to_string())?
                + "viewBox=\"".len();
            let rest = &head[start..];
            let end = rest.find('"').ok_or_else(|| "unterminated viewBox".to_string())?;
            let parts: Vec<f64> = rest[..end]
                .split_whitespace()
                .filter_map(|p| p.parse::<f64>().ok())
                .collect();
            if parts.len() != 4 {
                return Err(format!("cannot read viewBox '{}'", &rest[..end]));
            }
            (parts[2], parts[3])
        }
    };

    if w <= 0.0 || h <= 0.0 {
        return Err(format!("SVG has no drawable size ({w}x{h})"));
    }
    let (width, height) = (w.ceil() as u32, h.ceil() as u32);
    if width > MAX_EDGE || height > MAX_EDGE {
        return Err(format!(
            "SVG is {width}x{height}; the limit is {MAX_EDGE} on the longest edge — scale it at the source"
        ));
    }
    Ok((width, height))
}

fn decode_svg_resvg(bytes: &[u8]) -> Result<DynamicImage, String> {
    const MAX_SVG_EDGE: u32 = 8_192;
    let mut options = resvg::usvg::Options::default();
    // usvg's default font database is EMPTY. Without this, every <text> element
    // is silently dropped: the first render of the storage charts came out with
    // all boxes and arrows and not one label.
    options.fontdb_mut().load_system_fonts();
    // The charts style text with `font-family: var(--nc-font, Inter, "Segoe UI",
    // ...)`; usvg does not resolve CSS variables, so the declaration is invalid
    // and falls back here. Better a real sans than usvg's serif default.
    options.font_family = "Segoe UI".to_string();
    let tree = resvg::usvg::Tree::from_data(bytes, &options)
        .map_err(|e| format!("cannot parse SVG: {e}"))?;
    let size = tree.size();
    let (w, h) = (size.width().ceil() as u32, size.height().ceil() as u32);
    if w == 0 || h == 0 {
        return Err(format!("SVG has no drawable size ({w}x{h})"));
    }
    if w > MAX_SVG_EDGE || h > MAX_SVG_EDGE {
        return Err(format!(
            "SVG is {w}x{h}; the limit is {MAX_SVG_EDGE} on the longest edge — scale it at the source"
        ));
    }
    let mut pixmap =
        resvg::tiny_skia::Pixmap::new(w, h).ok_or_else(|| format!("cannot allocate a {w}x{h} canvas"))?;
    resvg::render(&tree, resvg::tiny_skia::Transform::default(), &mut pixmap.as_mut());

    // tiny-skia stores **premultiplied** RGBA. Handing those bytes to a PNG/WebP
    // encoder (which expect straight alpha) darkens every translucent pixel — a
    // 50% red comes out as (128,0,0,128) instead of (255,0,0,128). Un-premultiply
    // before the image leaves this function.
    let data = pixmap.data();
    let mut straight = Vec::with_capacity(data.len());
    for px in data.chunks_exact(4) {
        let a = px[3] as u32;
        if a == 0 {
            straight.extend_from_slice(&[0, 0, 0, 0]);
            continue;
        }
        let demultiply = |c: u8| -> u8 { ((c as u32 * 255 + a / 2) / a).min(255) as u8 };
        straight.extend_from_slice(&[demultiply(px[0]), demultiply(px[1]), demultiply(px[2]), a as u8]);
    }

    let buffer = image::RgbaImage::from_raw(w, h, straight)
        .ok_or_else(|| "SVG render produced an unexpected buffer size".to_string())?;
    Ok(DynamicImage::ImageRgba8(buffer))
}

// ─── resize ──────────────────────────────────────────────────────────────

fn apply_resize(mut img: DynamicImage, opts: &ImageOptions) -> Result<DynamicImage, String> {
    if let (Some(width), Some(height)) = (opts.width, opts.height) {
        if width == 0 || height == 0 {
            return Err("width/height must be greater than zero".into());
        }
        // The allocation is w*h*bytes and a failed one aborts the process, not the
        // job; a single request must not be able to ask for 10 GB.
        if width as u64 * height as u64 > 80_000_000 {
            return Err(format!(
                "resize to {width}x{height} exceeds the 80 megapixel limit"
            ));
        }
        img = resize_fast(&img, width, height)?;
        return Ok(img);
    }
    let Some(max) = opts.max_dimension.or(opts.width).or(opts.height) else {
        return Ok(img);
    };
    if max == 0 {
        return Err("max_dimension must be greater than zero".into());
    }
    let (w, h) = (img.width(), img.height());
    let long = w.max(h);
    if long <= max {
        // Never upscale: a thumbnail request on a small image returns it as-is.
        return Ok(img);
    }
    let scale = max as f64 / long as f64;
    let nw = ((w as f64 * scale).round() as u32).max(1);
    let nh = ((h as f64 * scale).round() as u32).max(1);
    img = resize_fast(&img, nw, nh)?;
    Ok(img)
}

/// SIMD resize. `image::resize` is ~50x slower than this on a 4K image
/// (zune benchmark: 744 ms vs 28 ms), and resizing is what a media service
/// spends its time doing.
fn resize_fast(img: &DynamicImage, width: u32, height: u32) -> Result<DynamicImage, String> {
    use fast_image_resize as fr;

    let (source, pixel_type) = match img {
        DynamicImage::ImageRgb8(buf) => (buf.as_raw().clone(), fr::PixelType::U8x3),
        DynamicImage::ImageRgba8(buf) => (buf.as_raw().clone(), fr::PixelType::U8x4),
        DynamicImage::ImageLuma8(buf) => (buf.as_raw().clone(), fr::PixelType::U8),
        other => {
            let rgba = other.to_rgba8();
            (rgba.as_raw().clone(), fr::PixelType::U8x4)
        }
    };
    let (src_w, src_h) = (img.width(), img.height());
    let src = fr::images::Image::from_vec_u8(src_w, src_h, source, pixel_type)
        .map_err(|e| format!("resize source buffer rejected: {e}"))?;
    let mut dst = fr::images::Image::new(width, height, pixel_type);
    let mut resizer = fr::Resizer::new();
    let options = fr::ResizeOptions::new().resize_alg(fr::ResizeAlg::Convolution(fr::FilterType::Lanczos3));
    resizer
        .resize(&src, &mut dst, &options)
        .map_err(|e| format!("resize failed: {e}"))?;
    let out = dst.into_vec();
    match pixel_type {
        fr::PixelType::U8x3 => image::RgbImage::from_raw(width, height, out)
            .map(DynamicImage::ImageRgb8)
            .ok_or_else(|| "resized RGB buffer has the wrong length".to_string()),
        fr::PixelType::U8x4 => image::RgbaImage::from_raw(width, height, out)
            .map(DynamicImage::ImageRgba8)
            .ok_or_else(|| "resized RGBA buffer has the wrong length".to_string()),
        _ => image::GrayImage::from_raw(width, height, out)
            .map(DynamicImage::ImageLuma8)
            .ok_or_else(|| "resized grey buffer has the wrong length".to_string()),
    }
}

/// Per-channel contrast stretch (sharp's `normalise`, without libvips).
fn normalize_contrast(img: DynamicImage) -> DynamicImage {
    let mut rgba = img.to_rgba8();
    let mut min = [255u8; 3];
    let mut max = [0u8; 3];
    for pixel in rgba.pixels() {
        for c in 0..3 {
            min[c] = min[c].min(pixel.0[c]);
            max[c] = max[c].max(pixel.0[c]);
        }
    }
    for pixel in rgba.pixels_mut() {
        for c in 0..3 {
            let range = max[c].saturating_sub(min[c]);
            if range > 0 {
                let v = pixel.0[c].saturating_sub(min[c]) as u32 * 255 / range as u32;
                pixel.0[c] = v.min(255) as u8;
            }
        }
    }
    DynamicImage::ImageRgba8(rgba)
}

// ─── encode ──────────────────────────────────────────────────────────────

fn default_target(bytes: &[u8]) -> Target {
    if looks_like_svg(bytes) {
        // SVG has no raster format of its own; PNG keeps transparency.
        return Target::Png;
    }
    match image::guess_format(bytes) {
        Ok(ImageFormat::Jpeg) => Target::Jpeg,
        Ok(ImageFormat::Gif) => Target::Gif,
        Ok(ImageFormat::Bmp) => Target::Bmp,
        Ok(ImageFormat::Tiff) => Target::Tiff,
        Ok(ImageFormat::Ico) => Target::Ico,
        Ok(ImageFormat::Tga) => Target::Tga,
        Ok(ImageFormat::WebP) => Target::WebP,
        _ => Target::Png,
    }
}

fn parse_target(name: &str) -> Result<Target, String> {    Ok(match name.to_ascii_lowercase().as_str() {
        "png" => Target::Png,
        "jpeg" | "jpg" => Target::Jpeg,
        "gif" => Target::Gif,
        "bmp" => Target::Bmp,
        "tiff" | "tif" => Target::Tiff,
        "ico" => Target::Ico,
        "tga" => Target::Tga,
        "webp" => Target::WebP,
        "avif" if cfg!(feature = "avif") => Target::Avif,
        "avif" => {
            return Err(
                "avif output is compiled out of this build (cargo feature 'avif' pulls rav1e) — \
                 rebuild with --features avif"
                    .into(),
            )
        }
        other => {
            return Err(format!(
                "unsupported output format '{other}' — {}",
                supported_outputs().join(", ")
            ))
        }
    })
}

fn ext_for(target: Target) -> &'static str {
    match target {
        Target::Png => "png",
        Target::Jpeg => "jpg",
        Target::Gif => "gif",
        Target::Bmp => "bmp",
        Target::Tiff => "tiff",
        Target::Ico => "ico",
        Target::Tga => "tga",
        Target::WebP => "webp",
        Target::Avif => "avif",
    }
}

fn mime_for(target: Target) -> &'static str {
    match target {
        Target::Png => "image/png",
        Target::Jpeg => "image/jpeg",
        Target::Gif => "image/gif",
        Target::Bmp => "image/bmp",
        Target::Tiff => "image/tiff",
        Target::Ico => "image/x-icon",
        Target::Tga => "image/x-tga",
        Target::WebP => "image/webp",
        Target::Avif => "image/avif",
    }
}

fn encode(
    img: &DynamicImage,
    target: Target,
    quality: Option<u8>,
    out: &mut Vec<u8>,
) -> Result<(), String> {
    match target {
        Target::WebP => {
            // image-webp is pure Rust and takes RGBA; quality is not exposed by
            // this encoder, so a requested quality is reported as unsupported by
            // `validate` only when another format was named.
            let rgba = img.to_rgba8();
            image_webp::WebPEncoder::new(out)
                .encode(
                    rgba.as_raw(),
                    rgba.width(),
                    rgba.height(),
                    image_webp::ColorType::Rgba8,
                )
                .map_err(|e| format!("cannot encode WebP: {e}"))
        }
        Target::Avif => encode_avif(img, quality, out),
        other => {
            let format = match other {
                Target::Png => ImageFormat::Png,
                Target::Jpeg => ImageFormat::Jpeg,
                Target::Gif => ImageFormat::Gif,
                Target::Bmp => ImageFormat::Bmp,
                Target::Tiff => ImageFormat::Tiff,
                Target::Ico => ImageFormat::Ico,
                Target::Tga => ImageFormat::Tga,
                Target::WebP | Target::Avif => unreachable!("handled above"),
            };
            if format == ImageFormat::Jpeg {
                use image::codecs::jpeg::JpegEncoder;
                let q = quality.unwrap_or(82).clamp(1, 100);
                let mut cursor = std::io::Cursor::new(out);
                return JpegEncoder::new_with_quality(&mut cursor, q)
                    .encode_image(img)
                    .map_err(|e| format!("cannot encode JPEG: {e}"));
            }
            let mut cursor = std::io::Cursor::new(out);
            img.write_to(&mut cursor, format)
                .map_err(|e| format!("cannot encode image: {e}"))
        }
    }
}

#[cfg(feature = "avif")]
fn encode_avif(img: &DynamicImage, quality: Option<u8>, out: &mut Vec<u8>) -> Result<(), String> {
    let rgba = img.to_rgba8();
    let q = quality.unwrap_or(80).clamp(1, 100) as f32;
    let encoder = ravif::Encoder::new()
        .with_quality(q)
        .with_speed(6)
        .with_alpha_quality(q);
    let encoded = encoder
        .encode_rgba(ravif::Img::new(rgba.as_raw(), rgba.width() as usize, rgba.height() as usize))
        .map_err(|e| format!("cannot encode AVIF: {e}"))?;
    out.extend_from_slice(&encoded.avif_file);
    Ok(())
}

#[cfg(not(feature = "avif"))]
fn encode_avif(_img: &DynamicImage, _quality: Option<u8>, _out: &mut Vec<u8>) -> Result<(), String> {
    Err("avif output is compiled out of this build (cargo feature 'avif')".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_multibyte_background_is_refused_not_a_panic() {
        assert!(parse_color("aé").is_none());
        assert!(parse_color("abéé").is_none());
        assert_eq!(parse_color("#fff"), Some(image::Rgba([255, 255, 255, 255])));
        assert_eq!(parse_color("000"), Some(image::Rgba([0, 0, 0, 255])));
    }

    #[test]
    fn a_large_svg_is_read_across_a_multibyte_cut() {
        let mut svg = String::from("<svg width=\"10\" height=\"20\">");
        while svg.len() < 4095 {
            svg.push('x');
        }
        svg.push('é');
        svg.push_str("</svg>");
        assert_eq!(svg_size(svg.as_bytes()), Ok((10, 20)));
    }

    #[test]
    fn a_childs_attributes_are_not_the_canvas() {
        // Neither root width/height is present; without the word boundary the
        // child's stroke-width and line-height would be read as the canvas.
        let svg = br#"<svg viewBox="0 0 100 100"><rect stroke-width="4" line-height="5"/></svg>"#;
        assert_eq!(svg_size(svg), Ok((100, 100)));
    }

    #[test]
    fn an_svg_survives_a_multibyte_cut() {
        let mut svg = String::from("<svg width=\"10\" height=\"20\">");
        while svg.len() < 2047 {
            svg.push('x');
        }
        svg.push('é');
        svg.push_str("</svg>");
        assert!(looks_like_svg(svg.as_bytes()));
    }

    #[test]
    fn only_alpha_buffers_can_be_transparent() {
        let opaque = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(4, 4, image::Rgb([1, 2, 3])));
        assert!(!has_transparency(&opaque));
        let translucent =
            DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(4, 4, image::Rgba([1, 2, 3, 128])));
        assert!(has_transparency(&translucent));
    }
}
