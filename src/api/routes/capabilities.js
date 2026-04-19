import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const nVideoPath = path.join(__dirname, '../../../modules/nVideo/lib/index.js');
const nImagePath = path.join(__dirname, '../../../modules/nImage/lib/index.js');
const require = createRequire(import.meta.url);
const nVideo = require(nVideoPath);
const nImage = require(nImagePath);

export async function handleCapabilities(ctx) {
  const { searchParams } = new URL(ctx.rawRequest.url, `http://${ctx.rawRequest.headers.host}`);
  const section = searchParams.get('section');
  const module = searchParams.get('module');

  try {
    if (module === 'nimage' || (!module && section === 'image')) {
      return handleImageCapabilities(ctx, section);
    }
    if (module === 'nvideo' || (!module && ['build', 'codecs', 'common', 'filters', 'hwaccels'].includes(section))) {
      return handleVideoCapabilities(ctx, section);
    }
    const caps = {
      nVideo: nVideo.getCapabilities(),
      nImage: nImage.getCapabilities(),
      nImageState: {
        isLoaded: nImage.isLoaded,
        hasSharp: nImage.hasSharp,
        version: nImage.version,
        supportedFormats: nImage.getSupportedFormats(),
        rawFormats: nImage.RAW_FORMATS,
        heicFormats: nImage.HEIC_FORMATS,
        imagemagickFormats: nImage.IMAGEMAGICK_FORMATS,
      },
    };
    ctx.json(200, { success: true, data: caps });
  } catch (error) {
    ctx.error(500, error.message);
  }
}

function handleImageCapabilities(ctx, section) {
  if (section === 'formats') {
    ctx.json(200, { success: true, data: nImage.getSupportedFormats() });
  } else if (section === 'state') {
    ctx.json(200, {
      success: true,
      data: {
        isLoaded: nImage.isLoaded,
        hasSharp: nImage.hasSharp,
        version: nImage.version,
      },
    });
  } else if (section === 'raw') {
    ctx.json(200, { success: true, data: nImage.RAW_FORMATS });
  } else if (section === 'heic') {
    ctx.json(200, { success: true, data: nImage.HEIC_FORMATS });
  } else if (section === 'imagemagick') {
    ctx.json(200, { success: true, data: nImage.IMAGEMAGICK_FORMATS });
  } else {
    ctx.json(200, {
      success: true,
      data: {
        ...nImage.getCapabilities(),
        state: {
          isLoaded: nImage.isLoaded,
          hasSharp: nImage.hasSharp,
          version: nImage.version,
        },
        supportedFormats: nImage.getSupportedFormats(),
      },
    });
  }
}

function handleVideoCapabilities(ctx, section) {
  if (section === 'build') {
    const buildInfo = nVideo.getBuildInfo();
    ctx.json(200, { success: true, data: buildInfo });
  } else if (section === 'codecs') {
    const codecs = nVideo.getCapabilities().codecs;
    ctx.json(200, { success: true, data: codecs });
  } else if (section === 'common') {
    const common = nVideo.getCapabilities().commonCodecs;
    ctx.json(200, { success: true, data: common });
  } else if (section === 'filters') {
    const filters = nVideo.getCapabilities().filters;
    ctx.json(200, { success: true, data: filters });
  } else if (section === 'formats') {
    const formats = nVideo.getCapabilities().formats;
    ctx.json(200, { success: true, data: formats });
  } else if (section === 'hwaccels') {
    const buildInfo = nVideo.getBuildInfo();
    ctx.json(200, {
      success: true,
      data: {
        hwaccels: buildInfo.hwaccels || [],
        videoEncodersByHwaccel: nVideo.getCapabilities().commonCodecs.videoEncodersByHwaccel || {},
        recommended: nVideo.getCapabilities().commonCodecs.recommended || {},
      },
    });
  } else {
    const caps = nVideo.getCapabilities();
    ctx.json(200, { success: true, data: caps });
  }
}
