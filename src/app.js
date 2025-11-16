const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Make sure Express knows it's behind a proxy (platform TLS termination)
app.set('trust proxy', true);

// Middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json({ limit: '10mb' }));
app.use('/output', express.static(path.join(__dirname, '..', 'outputs')));

// ImgnAI Config
const BASE_URL = 'https://app.imgnai.com/services/webappms';
const LOGIN_URL = 'https://app.imgnai.com/login';
const GENERATE_URL = 'https://app.imgnai.com/generate';
const IMAGE_BASE_URL = 'https://wasmall.imgnai.com/';
const USERNAME = 'imgnai69';
const PASSWORD = 'imgnai@1trick.net';

const API_MAPPINGS = {
  MODELS: { 1: { id: 'Gen' } },
  QUALITY: {
    1: { value: true, quality_modifier: 30 },
    2: { value: false, quality_modifier: 75 }
  },
  ASPECT_RATIO: {
    1: { res: 'WIDE_LARGE', w: 1024, h: 409 }
  }
};

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// Home page
app.get('/', (req, res) => res.render('index'));

// Health check (useful for platform probes)
app.get('/health', (req, res) => res.status(200).send('ok'));

// Generate endpoint
app.post('/generate', async (req, res) => {
  const { prompt = 'a cat', model = 1, quality = 1, ratio = 1 } = req.body;
  let browser, page;

  try {
    // Launch Puppeteer (use system Chromium — no download script needed)
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: '/usr/bin/chromium-browser',  // Leapcell's pre-installed
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-zygote',
        '--disable-web-security'
      ]
    });
    page = await browser.newPage();

    // Login
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle0', timeout: 120000 });
    await page.type('input[name="username"]', USERNAME);
    await page.type('input[name="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'networkidle0' });
    await page.goto(GENERATE_URL, { waitUntil: 'networkidle0' });

    // Get JWT
    const jwt = await page.evaluate(() => {
      const cookie = document.cookie.split('; ').find(c => c.startsWith('authentication='));
      if (!cookie) return null;
      const json = JSON.parse(decodeURIComponent(cookie.split('=')[1]));
      return json.state?.token;
    });
    if (!jwt) throw new Error('Login failed');

    // Create session
    const sessionUuid = await page.evaluate(async (url, jwt) => {
      const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${jwt}` } });
      return (await r.text()).trim();
    }, `${BASE_URL}/api/generate-session`, jwt);

    // Build batch (4 images)
    const batch = Array(4).fill().map((_, i) => ({
      nsfw: false,
      profile: API_MAPPINGS.MODELS[model].id,
      n_steps: API_MAPPINGS.QUALITY[quality].quality_modifier,
      strength: 0.76,
      seed: Math.floor(Math.random() * 4e9) + i,
      prompt,
      negative_prompt: 'low quality, blurry',
      input: null,
      width: API_MAPPINGS.ASPECT_RATIO[ratio].w,
      height: API_MAPPINGS.ASPECT_RATIO[ratio].h,
      guidance_scale: 3.5,
      image_resolution: API_MAPPINGS.ASPECT_RATIO[ratio].res,
      is_uhd: false,
      is_fast: API_MAPPINGS.QUALITY[quality].value,
      use_assistant: false
    }));

    const payload = { session_uuid: sessionUuid, use_credits: false, use_assistant: false, generate_image_list: batch };

    // Submit batch
    const jobIds = await page.evaluate(async (url, payload, jwt) => {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      return Array.isArray(data) ? data : data.jobIds || [];
    }, `${BASE_URL}/api/generate-image-batch`, payload, jwt);

    // Poll for images
    const imageUrls = [];
    for (const id of jobIds) {
      for (let i = 0; i < 180; i++) {
        await wait(2000);
        const data = await page.evaluate(async (url, jwt) => {
          const r = await fetch(url, { headers: { Authorization: `Bearer ${jwt}` } });
          return r.ok ? await r.json() : null;
        }, `${BASE_URL}/api/generate-image/uuid/${id}`, jwt);
        if (data?.response?.image_url) {
          imageUrls.push(IMAGE_BASE_URL + data.response.image_url);
          break;
        }
      }
    }

    // Download to static folder
    const outDir = path.join(__dirname, '..', 'outputs');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

    const saved = [];
    for (let i = 0; i < imageUrls.length; i++) {
      const url = imageUrls[i];
      const fileName = `${Date.now()}_${i + 1}.jpeg`;
      const filePath = path.join(outDir, fileName);
      const response = await fetch(url);
      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(filePath, buffer);
      saved.push(`/output/${fileName}`);
    }

    res.json({ success: true, images: saved, count: saved.length });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

// Explicitly bind to 0.0.0.0 and log binding info so the platform can route TLS -> HTTP correctly
const HOST = process.env.HOST || '0.0.0.0';
// Extra startup info to help diagnose platform routing issues
console.log('Starting server with env:', {
  PORT: process.env.PORT || PORT,
  NODE_ENV: process.env.NODE_ENV,
  HOST: HOST,
  PID: process.pid
});
app.listen(PORT, HOST, () => console.log(`Server listening on ${HOST}:${PORT}`));
