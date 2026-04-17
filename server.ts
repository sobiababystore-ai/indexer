import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { google } from 'googleapis';
import axios from 'axios';
import cheerio from 'cheerio';
import { parseStringPromise } from 'xml2js';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

const app = express();
const PORT = 3000;
const CONFIG_PATH = path.resolve('indexer-config.json');

// Start the scheduler
import './indexer-scheduler.ts';

// Middleware
app.use(express.json());
app.use(cookieParser());
app.use(session({
  secret: 'sitemap-indexer-secret',
  resave: false,
  saveUninitialized: true,
  cookie: { 
    secure: true, 
    sameSite: 'none',
    maxAge: 3600000 // 1 hour
  }
}));

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${process.env.APP_URL}/auth/callback`
);

// --- OAuth Routes ---

app.get('/api/auth/url', (req, res) => {
  const scopes = [
    'https://www.googleapis.com/auth/webmasters',
    'https://www.googleapis.com/auth/indexing',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/userinfo.email'
  ];

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent'
  });

  res.json({ url });
});

app.get(['/auth/callback', '/auth/callback/'], async (req, res) => {
  const { code } = req.query;
  
  if (!code) {
    return res.send('No code provided');
  }

  try {
    const { tokens } = await oauth2Client.getToken(code as string);
    // @ts-ignore
    req.session.tokens = tokens;
    
    // Persist tokens globally for scheduler
    if (fs.existsSync(CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      config.tokens = tokens;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    } else {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({ tokens, sitemaps: [] }, null, 2));
    }
    
    res.send(`
      <html>
        <body>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS' }, '*');
              window.close();
            } else {
              window.location.href = '/';
            }
          </script>
          <p>Authentication successful. This window should close automatically.</p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('OAuth error:', error);
    res.status(500).send('Authentication failed');
  }
});

app.get('/api/auth/status', (req, res) => {
  // @ts-ignore
  const tokens = req.session.tokens;
  res.json({ isAuthenticated: !!tokens });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

// --- Sitemap & Indexing Routes ---

app.post('/api/sitemap/parse', async (req, res) => {
  const { url, priority = 'high' } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  // Add sitemap settings to config for scheduler
  if (fs.existsSync(CONFIG_PATH)) {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    const exists = config.sitemaps.some((s: any) => s.url === url);
    if (!exists) {
      config.sitemaps.push({ url, priority });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    } else {
      // Update priority if changed
      config.sitemaps = config.sitemaps.map((s: any) => 
        s.url === url ? { ...s, priority } : s
      );
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    }
  }

  try {
    const response = await axios.get(url, { timeout: 10000 });
    const result = await parseStringPromise(response.data);
    
    // Extract loc tags from urlset or sitemapindex
    let urls: string[] = [];
    if (result.urlset && result.urlset.url) {
      urls = result.urlset.url.map((u: any) => u.loc[0]);
    } else if (result.sitemapindex && result.sitemapindex.sitemap) {
      urls = result.sitemapindex.sitemap.map((s: any) => s.loc[0]);
    }

    res.json({ urls });
  } catch (error: any) {
    console.error('Sitemap parse error:', error.message);
    res.status(500).json({ error: 'Failed to parse sitemap: ' + error.message });
  }
});

app.post('/api/index-url', async (req, res) => {
  const { url } = req.body;
  // @ts-ignore
  const tokens = req.session.tokens;

  if (!tokens) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    oauth2Client.setCredentials(tokens);
    const indexing = google.indexing({ version: 'v3', auth: oauth2Client });
    
    // Note: The Indexing API is officially for JobPosting/BroadcastEvent
    // Requesting crawl:
    const response = await indexing.urlNotifications.publish({
      requestBody: {
        url: url,
        type: 'URL_UPDATED'
      }
    });

    res.json({ success: true, response: response.data });
  } catch (error: any) {
    console.error('Indexing API error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: error.response?.data?.error?.message || error.message,
      details: error.response?.data
    });
  }
});

// New endpoint to crawl a page and extract internal links
app.post('/api/crawl-page', async (req, res) => {
  const { url } = req.body;
  // Ensure authenticated
  // @ts-ignore
  const tokens = req.session.tokens;
  if (!tokens) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const response = await axios.get(url, { timeout: 10000 });
    const $ = cheerio.load(response.data);
    const base = new URL(url);
    const links: string[] = [];
    $('a[href]').each((_, el) => {
      let href = $(el).attr('href')?.trim();
      if (!href) return;
      try {
        const resolved = new URL(href, base).toString();
        // Only include same-origin links
        if (resolved.startsWith(base.origin)) {
          links.push(resolved);
        }
      } catch (e) {
        // ignore invalid URLs
      }
    });
    const unique = Array.from(new Set(links));
    res.json({ links: unique });
  } catch (e: any) {
    console.error('Crawl page error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/sitemap/submit', async (req, res) => {
  const { siteUrl, sitemapUrl } = req.body;
  // @ts-ignore
  const tokens = req.session.tokens;

  if (!tokens) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    oauth2Client.setCredentials(tokens);
    const searchconsole = google.searchconsole({ version: 'v1', auth: oauth2Client });
    
    await searchconsole.sitemaps.submit({
      siteUrl: siteUrl,
      feedpath: sitemapUrl
    });

    res.json({ success: true });
  } catch (error: any) {
    console.error('Search Console submit error:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data?.error?.message || error.message });
  }
});

// --- Server Setup ---

async function start() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve('dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server started at http://localhost:${PORT}`);
  });
}

start();
