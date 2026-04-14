import { spawn } from 'child_process';

const filePath = '\\\\BADKID\\Storage\\Test Files\\Stream_1.flac';
const ffprobePath = 'D:\\Work\\_GIT\\MediaService\\bin\\ffprobe.exe';

const proc = spawn(ffprobePath, [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_streams',
    filePath
], { stdio: ['ignore', 'pipe', 'pipe'] });

let stdout = '';

proc.stdout.on('data', (data) => { stdout += data.toString(); });

proc.on('close', (code) => {
    try {
        const metadata = JSON.parse(stdout);
        console.log('Full output:', JSON.stringify(metadata, null, 2));
        const audioStream = metadata.streams?.find(s => s.codec_type === 'audio');
        if (audioStream) {
            console.log('\n=== AUDIO STREAM ===');
            console.log(JSON.stringify(audioStream, null, 2));
            console.log('bits_per_sample:', audioStream.bits_per_sample);
            console.log('bits_per_raw_sample:', audioStream.bits_per_raw_sample);
            console.log('sample_fmt:', audioStream.sample_fmt);
        }
    } catch (e) {
        console.error('Parse error:', e.message);
        console.log('Raw stdout:', stdout);
    }
});
