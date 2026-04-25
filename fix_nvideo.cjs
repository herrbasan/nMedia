const fs = require('fs');
const path = require('path');
let code = fs.readFileSync('modules/nVideo/lib/index.js', 'utf8');

const childProcessImport = "const { spawn } = require('child_process');\n\nfunction spawnFfmpeg";
if (!code.includes(childProcessImport)) {
  const replacement = `
const { spawn } = require('child_process');

function spawnFfmpeg(inputPath, outputPath, opts) {
    const ffmpegPath = path.join(__dirname, '..', 'deps', process.platform === 'win32' ? 'win' : 'linux', 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    
    if (!fs.existsSync(ffmpegPath)) {
        throw new Error('FFmpeg executable not found at ' + ffmpegPath);
    }

    const args = ['-y'];
    
    if (opts.hwaccel) {
        args.push('-hwaccel', opts.hwaccel);
    }

    args.push('-i', inputPath);

    if (opts.video) {
        if (opts.video.codec) args.push('-c:v', opts.video.codec);
        if (opts.video.width || opts.video.height) {
            args.push('-vf', \`scale=\${opts.video.width || -1}:\${opts.video.height || -1}\`);
        }
        if (opts.video.preset) args.push('-preset', opts.video.preset);
        if (opts.video.crf !== undefined) args.push('-crf', opts.video.crf);
        if (opts.video.cq !== undefined) args.push('-cq', opts.video.cq);
        if (opts.video.pix_fmt) args.push('-pix_fmt', opts.video.pix_fmt);
    } else {
        args.push('-c:v', 'copy');
    }

    if (opts.audio) {
        if (opts.audio.codec) args.push('-c:a', opts.audio.codec);
        if (opts.audio.bitrate) {
            let br = opts.audio.bitrate;
            if (typeof br === 'number' && br > 1000) br = Math.floor(br / 1000) + 'k';
            args.push('-b:a', br);
        }
    } else if (opts.audio === false) {
        args.push('-an');
    } else {
        args.push('-c:a', 'copy');
    }

    args.push('-progress', 'pipe:1', outputPath);

    let progressStarted = false;
    let durationUs = 0;
    
    try {
        const metadata = module.exports.probe(inputPath);
        durationUs = metadata && metadata.format && metadata.format.duration ? metadata.format.duration * 1000000 : 0;
    } catch(e) {}

    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    child.stderr.on('data', data => {
        stderr += data.toString();
    });

    child.stdout.on('data', data => {
        if (!opts.onProgress) return;
        const lines = data.toString().split('\\n');
        const progress = {};
        for (const line of lines) {
            const [key, val] = line.split('=');
            if (key && val) progress[key.trim()] = val.trim();
        }
        
        if (progress.out_time_us && durationUs > 0) {
            const outTimeUs = parseInt(progress.out_time_us, 10);
            const percent = Math.min((outTimeUs / durationUs) * 100, 100);
            opts.onProgress({
                percent: percent,
                fps: progress.fps ? parseFloat(progress.fps) : 0,
                speed: progress.speed ? parseFloat(progress.speed.replace('x','')) : 0,
                time: outTimeUs / 1000000,
                frame: progress.frame ? parseInt(progress.frame, 10) : 0
            });
            progressStarted = true;
        }
    });

    return new Promise((resolve, reject) => {
        child.on('close', code => {
            if (code !== 0) {
                const err = new Error(\`ffmpeg exited with code \${code}\\n\${stderr}\`);
                if (opts.onError) opts.onError(err);
                reject(err);
            } else {
                const stat = fs.statSync(outputPath);
                const res = { duration: durationUs / 1000000, size: stat.size, cached: false };
                if (opts.onComplete) opts.onComplete(res);
                resolve(res);
            }
        });
    });
}
`;
  code = code.replace("let nativeBinding = null;", "let nativeBinding = null;\n" + replacement);
}

const oldTranscode = `
    transcode(inputPath, outputPath, opts) {
        if (typeof inputPath !== 'string') {
            throw new TypeError('transcode: expected string argument (inputPath)');
        }
        if (typeof outputPath !== 'string') {
            throw new TypeError('transcode: expected string argument (outputPath)');
        }
        if (!opts || typeof opts !== 'object') {
            throw new TypeError('transcode: expected object argument (opts)');
        }

        const cacheEnabled = opts.cache !== false;
        const cacheDir = opts.cacheDir || DEFAULT_CACHE_DIR;
        const cacheTTL = opts.cacheTTL !== undefined ? opts.cacheTTL : DEFAULT_CACHE_TTL;

        if (cacheEnabled) {
            const cacheConfig = { video: opts.video, audio: opts.audio, threads: opts.threads };
            const cacheResult = lookupCache(inputPath, cacheConfig, cacheDir, cacheTTL);

            if (cacheResult.hit) {
                if (opts.onCacheHit) {
                    opts.onCacheHit(cacheResult.cacheFile);
                }
                copyFromCache(cacheResult.cacheFile, outputPath, cacheDir);
                const stat = fs.statSync(outputPath);
                return { duration: 0, frames: 0, audioFrames: 0, size: stat.size, bitrate: 0, speed: 0, timeMs: 0, dupFrames: 0, dropFrames: 0, cached: true };
            }

            if (opts.onCacheMiss) {
                opts.onCacheMiss();
            }
        }

        const result = nativeBinding.transcode(inputPath, outputPath, opts);

        if (cacheEnabled && result) {
            const cacheConfig = { video: opts.video, audio: opts.audio, threads: opts.threads };
            const cacheKey = computeCacheKey(inputPath, cacheConfig);
            const cacheFile = getCacheFilePath(cacheDir, cacheKey, outputPath);
            storeInCache(cacheFile, outputPath, cacheDir);
        }

        return result;
    },`;

const newTranscode = `
    transcode(inputPath, outputPath, opts) {
        if (typeof inputPath !== 'string') {
            throw new TypeError('transcode: expected string argument (inputPath)');
        }
        if (typeof outputPath !== 'string') {
            throw new TypeError('transcode: expected string argument (outputPath)');
        }
        if (!opts || typeof opts !== 'object') {
            throw new TypeError('transcode: expected object argument (opts)');
        }

        const cacheEnabled = opts.cache !== false;
        const cacheDir = opts.cacheDir || DEFAULT_CACHE_DIR;
        const cacheTTL = opts.cacheTTL !== undefined ? opts.cacheTTL : DEFAULT_CACHE_TTL;

        if (cacheEnabled) {
            const cacheConfig = { video: opts.video, audio: opts.audio, threads: opts.threads };
            const cacheResult = lookupCache(inputPath, cacheConfig, cacheDir, cacheTTL);

            if (cacheResult.hit) {
                if (opts.onCacheHit) {
                    opts.onCacheHit(cacheResult.cacheFile);
                }
                copyFromCache(cacheResult.cacheFile, outputPath, cacheDir);
                const stat = fs.statSync(outputPath);
                const res = { duration: 0, frames: 0, audioFrames: 0, size: stat.size, bitrate: 0, speed: 0, timeMs: 0, dupFrames: 0, dropFrames: 0, cached: true };
                if (opts.onComplete) opts.onComplete(res);
                return opts.useNative ? res : Promise.resolve(res);
            }

            if (opts.onCacheMiss) {
                opts.onCacheMiss();
            }
        }

        if (opts.useNative) {
            const result = nativeBinding.transcode(inputPath, outputPath, opts);
            if (cacheEnabled && result) {
                const cacheConfig = { video: opts.video, audio: opts.audio, threads: opts.threads };
                const cacheKey = computeCacheKey(inputPath, cacheConfig);
                const cacheFile = getCacheFilePath(cacheDir, cacheKey, outputPath);
                storeInCache(cacheFile, outputPath, cacheDir);
            }
            return result;
        } else {
            return spawnFfmpeg(inputPath, outputPath, opts).then(result => {
                if (cacheEnabled && result) {
                    const cacheConfig = { video: opts.video, audio: opts.audio, threads: opts.threads };
                    const cacheKey = computeCacheKey(inputPath, cacheConfig);
                    const cacheFile = getCacheFilePath(cacheDir, cacheKey, outputPath);
                    storeInCache(cacheFile, outputPath, cacheDir);
                }
                return result;
            });
        }
    },`;

code = code.replace(oldTranscode, newTranscode);
fs.writeFileSync('modules/nVideo/lib/index.js', code);
console.log('Done replacement');