// server.js — Audio Converter API
// Owner   : MAINUL-X
// GitHub  : github.com/M41NUL
// Section : Backend — Express routes, yt-dlp, ffmpeg, SSE progress

const express    = require('express');
const multer     = require('multer');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const { spawn }  = require('child_process');

const app  = express();
const PORT = process.env.PORT || 3000;

const TEMP_DIR = path.join(os.tmpdir(), 'audio_converter');
fs.mkdirSync(TEMP_DIR, { recursive: true });

const upload = multer({
  dest: TEMP_DIR,
  limits: { fileSize: 500 * 1024 * 1024 },
});

const SUPPORTED_FORMATS   = new Set(['mp3', 'm4a', 'flac', 'wav', 'ogg']);
const SUPPORTED_QUALITIES = new Set(['128', '192', '256', '320']);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

function slugify(text, maxLen = 60) {
  return (text || 'audio')
    .replace(/[^\w\s\-]/gu, '')
    .replace(/[\s\-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, maxLen)
    .replace(/^_+|_+$/g, '') || 'audio';
}

function humanSize(bytes) {
  return bytes > 1024 * 1024
    ? (bytes / 1024 / 1024).toFixed(1) + ' MB'
    : Math.round(bytes / 1024) + ' KB';
}

function cleanupOldFiles() {
  const now = Date.now();
  try {
    for (const f of fs.readdirSync(TEMP_DIR)) {
      if (f === 'yt_cookies.txt') continue;
      const fp = path.join(TEMP_DIR, f);
      const st = fs.statSync(fp);
      if (now - st.mtimeMs > 3600 * 1000) fs.unlinkSync(fp);
    }
  } catch (_) {}
}

function getCookiesFile() {
  const localPath = path.join(__dirname, 'cookies.txt');
  if (fs.existsSync(localPath)) {
    const content = fs.readFileSync(localPath, 'utf8').trim();
    if (content && !content.startsWith('# Add your YouTube')) return localPath;
  }

  const secretPath = '/etc/secrets/cookies.txt';
  if (fs.existsSync(secretPath)) return secretPath;

  // Priority 2: YT_COOKIES env var (raw cookie string or Netscape format)
  const raw = (process.env.YT_COOKIES || '').trim();
  if (!raw) return null;
  const cookiePath = path.join(TEMP_DIR, 'yt_cookies.txt');
  if (raw.startsWith('# Netscape HTTP Cookie File') || raw.includes('\t')) {
    fs.writeFileSync(cookiePath, raw);
  } else {
    const lines = ['# Netscape HTTP Cookie File', '# https://curl.se/docs/http-cookies.html', ''];
    for (const pair of raw.split(';')) {
      const p = pair.trim();
      const eq = p.indexOf('=');
      if (eq === -1) continue;
      const name = p.slice(0, eq).trim();
      const value = p.slice(eq + 1).trim();
      lines.push(`.youtube.com\tTRUE\t/\tFALSE\t0\t${name}\t${value}`);
    }
    fs.writeFileSync(cookiePath, lines.join('\n') + '\n');
  }
  return fs.existsSync(cookiePath) ? cookiePath : null;
}

function buildYtBase() {
  const cookies = getCookiesFile();

  const cmd = ['-m', 'yt_dlp'];

  // Common user-agent — reduces bot detection significantly
  cmd.push(
    '--user-agent',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  if (cookies) {
    cmd.push(
      '--cookies', cookies,
      '--extractor-args', 'youtube:player_client=android,web'
    );
  } else {
    cmd.push(
      '--extractor-args', 'youtube:player_client=android,mweb'
    );
  }

  return cmd;
}

function runCmd(bin, args, timeout = 300000) {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { timeout });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => resolve({ code, stdout, stderr }));
    proc.on('error', err => resolve({ code: 1, stdout: '', stderr: err.message }));
  });
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', cookies: !!process.env.YT_COOKIES?.trim() });
});

app.get('/api/preview', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });

  const args = [
    ...buildYtBase(),
    '--no-playlist', '--skip-download',
    '--print', '%(title)s|||%(duration_string)s|||%(thumbnail)s|||%(uploader)s',
    url,
  ];

  const { code, stdout, stderr } = await runCmd('python3', args, 30000);
  if (code !== 0) return res.status(500).json({ error: stderr.slice(0, 300) || 'Could not fetch video info' });

  const parts = (stdout.trim().split('\n')[0] || '').split('|||');
  res.json({
    title:     parts[0] || '',
    duration:  parts[1] || '',
    thumbnail: parts[2] || '',
    uploader:  parts[3] || '',
  });
});

app.get('/api/convert-stream', async (req, res) => {
  const { url, format = 'mp3', quality = '192', embedThumb = 'true' } = req.query;

  if (!url)                          return res.status(400).json({ error: 'url required' });
  if (!SUPPORTED_FORMATS.has(format))  return res.status(400).json({ error: 'Unsupported format' });
  if (!SUPPORTED_QUALITIES.has(quality)) return res.status(400).json({ error: 'Unsupported quality' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendErr = (msg) => { sseWrite(res, 'error', { message: msg }); res.end(); };

  cleanupOldFiles();

  sseWrite(res, 'prog', { pct: 0, phase: 'fetching', label: 'Fetching info...' });

  const metaArgs = [
    ...buildYtBase(),
    '--no-playlist', '--skip-download',
    '--print', '%(title)s|||%(duration_string)s|||%(thumbnail)s',
    url,
  ];

  const meta = await runCmd('python3', metaArgs, 60000);
  let title = 'audio', duration = '', thumbnail = '';
  if (meta.code === 0 && meta.stdout.trim()) {
    const parts = meta.stdout.trim().split('\n')[0].split('|||');
    title     = parts[0] || 'audio';
    duration  = parts[1] || '';
    thumbnail = parts[2] || '';
  }

  sseWrite(res, 'meta', { title, duration, thumbnail });
  sseWrite(res, 'prog', { pct: 5, phase: 'downloading', label: 'Starting download...' });

  const jobId    = uuidv4().replace(/-/g, '').slice(0, 8);
  const cleanName = slugify(title);
  const outBase  = path.join(TEMP_DIR, `${cleanName}_${jobId}`);

  const ytArgs = [
    ...buildYtBase(),
    '--no-playlist',
    '--format', 'bestaudio[ext=m4a]/bestaudio/best',
    '--extract-audio',
    '--audio-format', format,
    '--audio-quality', quality,
    '--output', outBase,
    '--progress',
    '--progress-template', 'download:[%(info.id)s] %(progress._percent_str)s of %(progress._total_bytes_str)s at %(progress._speed_str)s ETA %(progress._eta_str)s',
    '--newline',
  ];

  if (embedThumb === 'true' && (format === 'mp3' || format === 'm4a')) {
    ytArgs.push('--embed-thumbnail');
  }
  ytArgs.push(url);

  await new Promise((resolve) => {
    const proc = spawn('python3', ytArgs);
    let stderr = '';

    proc.stderr.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        stderr += line + '\n';

        const m = line.match(/\]\s+([\d.]+)%\s+of\s+(\S+)\s+at\s+(\S+)\s+ETA\s+(\S+)/);
        if (m) {
          const rawPct = parseFloat(m[1]);
          const pct   = Math.round(5 + rawPct * 0.85);
          sseWrite(res, 'prog', {
            pct,
            phase: 'downloading',
            label: `Downloading... ${m[1]}%`,
            speed: m[3],
            eta:   m[4],
            size:  m[2],
          });
        }

        if (line.includes('[ffmpeg]') || line.includes('Destination:')) {
          sseWrite(res, 'prog', { pct: 91, phase: 'converting', label: 'Converting audio...' });
        }
        if (line.includes('EmbedThumbnail') || line.includes('embed')) {
          sseWrite(res, 'prog', { pct: 96, phase: 'embedding', label: 'Embedding thumbnail...' });
        }
      }
    });

    proc.stdout.on('data', () => {});  // drain

    proc.on('close', async (code) => {
      if (code !== 0) {
        // Fallback: retry with generic best if format was not available
        if (stderr.includes('Requested format is not available') || stderr.includes('No video formats found')) {
          sseWrite(res, 'prog', { pct: 10, phase: 'downloading', label: 'Format fallback — retrying...' });

          const fallbackArgs = [
            ...buildYtBase(),
            '--no-playlist',
            '--format', 'best',
            '--extract-audio',
            '--audio-format', format,
            '--audio-quality', quality,
            '--output', outBase,
            '--progress',
            '--progress-template', 'download:[%(info.id)s] %(progress._percent_str)s of %(progress._total_bytes_str)s at %(progress._speed_str)s ETA %(progress._eta_str)s',
            '--newline',
            url,
          ];
          if (embedThumb === 'true' && (format === 'mp3' || format === 'm4a')) fallbackArgs.push('--embed-thumbnail');

          const fallbackProc = spawn('python3', fallbackArgs);
          let fbStderr = '';
          fallbackProc.stderr.on('data', (chunk) => { fbStderr += chunk.toString(); });
          fallbackProc.stdout.on('data', () => {});
          fallbackProc.on('close', async (fbCode) => {
            if (fbCode !== 0) { sendErr(fbStderr.slice(-400) || 'yt-dlp fallback failed'); return resolve(); }
            // find file and respond same as main path
            let finalPath = outBase + '.' + format;
            if (!fs.existsSync(finalPath)) {
              const candidates = fs.readdirSync(TEMP_DIR)
                .filter(f => f.startsWith(`${cleanName}_${jobId}`))
                .map(f => path.join(TEMP_DIR, f));
              finalPath = candidates[0] || null;
            }
            if (!finalPath || !fs.existsSync(finalPath)) { sendErr('Output file not found after fallback'); return resolve(); }
            const filesize = humanSize(fs.statSync(finalPath).size);
            sseWrite(res, 'done', { downloadUrl: `/api/download/${path.basename(finalPath)}`, title, duration, thumbnail, filesize });
            res.end();
            resolve();
          });
          fallbackProc.on('error', (err) => { sendErr(err.message); resolve(); });
          return;
        }

        sendErr(stderr.slice(-400) || 'yt-dlp failed');
        return resolve();
      }

      sseWrite(res, 'prog', { pct: 99, phase: 'finalizing', label: 'Finalizing...' });

      let finalPath = outBase + '.' + format;
      if (!fs.existsSync(finalPath)) {
        const candidates = fs.readdirSync(TEMP_DIR)
          .filter(f => f.startsWith(`${cleanName}_${jobId}`))
          .map(f => path.join(TEMP_DIR, f));
        finalPath = candidates[0] || null;
      }

      if (!finalPath || !fs.existsSync(finalPath)) {
        sendErr('Output file not found after conversion');
        return resolve();
      }

      const filesize = humanSize(fs.statSync(finalPath).size);
      sseWrite(res, 'done', {
        downloadUrl: `/api/download/${path.basename(finalPath)}`,
        title, duration, thumbnail, filesize,
      });
      res.end();
      resolve();
    });

    proc.on('error', (err) => { sendErr(err.message); resolve(); });

    req.on('close', () => { try { proc.kill(); } catch(_) {} resolve(); });
  });
});

app.post('/api/convert', async (req, res) => {
  const { url, format = 'mp3', quality = '192', embedThumb = true } = req.body;
  if (!url)                            return res.status(400).json({ error: 'url required' });
  if (!SUPPORTED_FORMATS.has(format))  return res.status(400).json({ error: 'Unsupported format' });
  if (!SUPPORTED_QUALITIES.has(quality)) return res.status(400).json({ error: 'Unsupported quality' });

  cleanupOldFiles();

  const metaArgs = [
    ...buildYtBase(),
    '--no-playlist', '--skip-download',
    '--print', '%(title)s|||%(duration_string)s|||%(thumbnail)s',
    url,
  ];
  const meta = await runCmd('python3', metaArgs, 60000);
  let title = 'audio', duration = '', thumbnail = '';
  if (meta.code === 0 && meta.stdout.trim()) {
    const parts = meta.stdout.trim().split('\n')[0].split('|||');
    title     = parts[0] || 'audio';
    duration  = parts[1] || '';
    thumbnail = parts[2] || '';
  }

  const jobId    = uuidv4().replace(/-/g, '').slice(0, 8);
  const cleanName = slugify(title);
  const outBase  = path.join(TEMP_DIR, `${cleanName}_${jobId}`);

  const ytArgs = [
    ...buildYtBase(),
    '--no-playlist',
    '--format', 'bestaudio[ext=m4a]/bestaudio/best',
    '--extract-audio',
    '--audio-format', format,
    '--audio-quality', quality,
    '--output', outBase,
    '--quiet',
  ];
  if (embedThumb && (format === 'mp3' || format === 'm4a')) ytArgs.push('--embed-thumbnail');
  ytArgs.push(url);

  const dl = await runCmd('python3', ytArgs, 300000);
  if (dl.code !== 0) return res.status(500).json({ error: dl.stderr.slice(0, 400) || 'yt-dlp failed' });

  let finalPath = outBase + '.' + format;
  if (!fs.existsSync(finalPath)) {
    const candidates = fs.readdirSync(TEMP_DIR)
      .filter(f => f.startsWith(`${cleanName}_${jobId}`))
      .map(f => path.join(TEMP_DIR, f));
    finalPath = candidates[0] || null;
  }
  if (!finalPath || !fs.existsSync(finalPath)) return res.status(500).json({ error: 'Output file not found' });

  res.json({
    downloadUrl: `/api/download/${path.basename(finalPath)}`,
    title, duration, thumbnail,
    filesize: humanSize(fs.statSync(finalPath).size),
  });
});

app.post('/api/convert-file', upload.single('file'), async (req, res) => {
  const { format = 'mp3', quality = '192' } = req.body;
  if (!SUPPORTED_FORMATS.has(format))   return res.status(400).json({ error: 'Unsupported format' });
  if (!SUPPORTED_QUALITIES.has(quality)) return res.status(400).json({ error: 'Unsupported quality' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  cleanupOldFiles();

  const jobId    = uuidv4().replace(/-/g, '').slice(0, 8);
  const origExt  = path.extname(req.file.originalname) || '.mp4';
  const cleanName = slugify(path.basename(req.file.originalname, origExt));
  const inPath   = req.file.path;  // multer already wrote it
  const outPath  = path.join(TEMP_DIR, `${cleanName}_${jobId}.${format}`);

  const ffArgs = ['-y', '-i', inPath, '-vn', '-ab', `${quality}k`, outPath];
  const ff = await runCmd('ffmpeg', ffArgs, 300000);

  try { fs.unlinkSync(inPath); } catch (_) {}

  if (ff.code !== 0) return res.status(500).json({ error: ff.stderr.slice(-300) || 'ffmpeg failed' });

  res.json({
    downloadUrl: `/api/download/${path.basename(outPath)}`,
    filesize: humanSize(fs.statSync(outPath).size),
  });
});

app.post('/api/upload-file', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (req.file.size > 500 * 1024 * 1024) {
    fs.unlinkSync(req.file.path);
    return res.status(413).json({ error: 'File too large (max 500 MB)' });
  }
  res.json({ jobId: req.file.filename, originalName: req.file.originalname });
});

app.get('/api/convert-file-stream', (req, res) => {
  const { job, format = 'mp3', quality = '192', originalName = 'video.mp4' } = req.query;
  if (!job) return res.status(400).json({ error: 'job required' });
  if (!SUPPORTED_FORMATS.has(format))    return res.status(400).json({ error: 'Unsupported format' });
  if (!SUPPORTED_QUALITIES.has(quality)) return res.status(400).json({ error: 'Unsupported quality' });

  const inPath = path.join(TEMP_DIR, job);
  if (!fs.existsSync(inPath)) return res.status(404).json({ error: 'Upload not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendErr = (msg) => { sseWrite(res, 'error', { message: msg }); res.end(); };

  const jobId     = uuidv4().replace(/-/g, '').slice(0, 8);
  const origExt   = path.extname(originalName) || '.mp4';
  const cleanName = slugify(path.basename(originalName, origExt));
  const outPath   = path.join(TEMP_DIR, `${cleanName}_${jobId}.${format}`);

  const ffprobe = spawn('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', inPath]);
  let probeOut = '';
  ffprobe.stdout.on('data', d => { probeOut += d; });

  const doConvert = (totalSec) => {
    sseWrite(res, 'prog', { pct: 2, label: 'Starting conversion...' });
    const ffArgs = ['-y', '-i', inPath, '-vn', '-ab', `${quality}k`, '-progress', 'pipe:2', '-nostats', outPath];
    const proc = spawn('ffmpeg', ffArgs);
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (totalSec > 0) {
        const m = text.match(/out_time_ms=(\d+)/);
        if (m) {
          const doneSec = parseInt(m[1]) / 1e6;
          const pct = Math.min(97, Math.round(2 + (doneSec / totalSec) * 95));
          sseWrite(res, 'prog', { pct, label: `Converting... ${pct}%` });
        }
      }
    });
    proc.on('close', (code) => {
      try { fs.unlinkSync(inPath); } catch (_) {}
      if (code !== 0) return sendErr(stderr.slice(-300) || 'ffmpeg failed');
      if (!fs.existsSync(outPath)) return sendErr('Output file not found');
      const filesize = humanSize(fs.statSync(outPath).size);
      sseWrite(res, 'done', {
        downloadUrl: `/api/download/${path.basename(outPath)}`,
        filename: `${cleanName}.${format}`,
        filesize,
      });
      res.end();
    });
    proc.on('error', (err) => sendErr(err.message));
    req.on('close', () => { try { proc.kill(); } catch (_) {} });
  };

  ffprobe.on('close', () => {
    let totalSec = 0;
    try { totalSec = parseFloat(JSON.parse(probeOut).format.duration) || 0; } catch (_) {}
    doConvert(totalSec);
  });
  ffprobe.on('error', () => doConvert(0));
});

app.get('/api/download/:filename', (req, res) => {
  const { filename } = req.params;
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filePath = path.join(TEMP_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found or expired' });
  res.download(filePath, filename);
});

app.listen(PORT, async () => {
  console.log(`🎵 Audio Converter running on port ${PORT}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  // ── ffmpeg check ──
  try {
    const ff = await runCmd('ffmpeg', ['-version'], 8000);
    if (ff.code === 0) {
      const ver = (ff.stdout || ff.stderr).split('\n')[0].replace('ffmpeg version ', '').split(' ')[0];
      console.log(`✅ ffmpeg     installed  →  v${ver}`);
    } else {
      console.log(`❌ ffmpeg     NOT found!`);
    }
  } catch (_) {
    console.log(`❌ ffmpeg     NOT found!`);
  }

  // ── yt-dlp check ──
  try {
    const yt = await runCmd('python3', ['-m', 'yt_dlp', '--version'], 8000);
    if (yt.code === 0) {
      console.log(`✅ yt-dlp     installed  →  v${yt.stdout.trim()}`);
    } else {
      console.log(`❌ yt-dlp     NOT found!`);
    }
  } catch (_) {
    console.log(`❌ yt-dlp     NOT found!`);
  }

  // ── cookies check ──
  const cookies = getCookiesFile();
  if (cookies) {
    console.log(`✅ cookies    found       →  ${cookies}`);
  } else {
    console.log(`⚠️  cookies    NOT set     →  YouTube may be limited`);
  }

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
});
