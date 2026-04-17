import cron from 'node-cron';
import axios from 'axios';
import { parseStringPromise } from 'xml2js';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const CONFIG_PATH = path.resolve('indexer-config.json');

interface IndexerConfig {
  tokens: any;
  sitemaps: Array<{
    url: string;
    priority: 'high' | 'medium' | 'low';
  }>;
}

function loadConfig(): IndexerConfig {
  if (fs.existsSync(CONFIG_PATH)) {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  }
  return { tokens: null, sitemaps: [] };
}

async function getAuthenticatedClient(tokens: any) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.APP_URL}/auth/callback`
  );
  oauth2Client.setCredentials(tokens);
  
  // Refresh token if needed
  oauth2Client.on('tokens', (newTokens) => {
    const config = loadConfig();
    config.tokens = { ...config.tokens, ...newTokens };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  });

  return oauth2Client;
}

async function processSitemap(sitemapUrl: string, priority: string) {
  console.log(`[Indexer] Processing ${sitemapUrl} with priority ${priority}`);
  
  const config = loadConfig();
  if (!config.tokens) {
    console.error(`[Indexer] Error: No tokens found in config for ${sitemapUrl}`);
    return;
  }

  try {
    const response = await axios.get(sitemapUrl, { timeout: 15000 });
    const result = await parseStringPromise(response.data);
    
    let urls: string[] = [];
    if (result.urlset && result.urlset.url) {
      urls = result.urlset.url.map((u: any) => u.loc[0]);
    } else if (result.sitemapindex && result.sitemapindex.sitemap) {
      urls = result.sitemapindex.sitemap.map((s: any) => s.loc[0]);
    }

    if (urls.length === 0) {
      console.log(`[Indexer] No URLs found in ${sitemapUrl}`);
      return;
    }

    const auth = await getAuthenticatedClient(config.tokens);
    const indexing = google.indexing({ version: 'v3', auth });

    console.log(`[Indexer] Submitting ${urls.length} URLs for ${sitemapUrl}...`);

    for (const url of urls) {
      try {
        await indexing.urlNotifications.publish({
          requestBody: {
            url: url,
            type: 'URL_UPDATED'
          }
        });
        // Small delay to respect rate limits
        await new Promise(r => setTimeout(r, 500));
      } catch (err: any) {
        console.error(`[Indexer] Failed to index ${url}:`, err.message);
      }
    }
    
    console.log(`[Indexer] Completed task for ${sitemapUrl}`);
  } catch (err: any) {
    console.error(`[Indexer] Fatal error processing ${sitemapUrl}:`, err.message);
  }
}

// --- Schedule Definitions ---

// High Priority: Daily at 01:00 AM
cron.schedule('0 1 * * *', async () => {
  const config = loadConfig();
  const highPriorityItems = config.sitemaps.filter(s => s.priority === 'high');
  for (const item of highPriorityItems) {
    await processSitemap(item.url, item.priority);
  }
});

// Medium Priority: Weekly (Every Sunday at 02:00 AM)
cron.schedule('0 2 * * 0', async () => {
  const config = loadConfig();
  const mediumPriorityItems = config.sitemaps.filter(s => s.priority === 'medium');
  for (const item of mediumPriorityItems) {
    await processSitemap(item.url, item.priority);
  }
});

// Low Priority: Monthly (1st of every month at 03:00 AM)
cron.schedule('0 3 1 * *', async () => {
  const config = loadConfig();
  const lowPriorityItems = config.sitemaps.filter(s => s.priority === 'low');
  for (const item of lowPriorityItems) {
    await processSitemap(item.url, item.priority);
  }
});

console.log('[Indexer] Background scheduler initialized.');
console.log('[Indexer] Schedules: High=Daily, Medium=Weekly, Low=Monthly');

// Helper to manually trigger for testing/debugging
if (process.argv.includes('--run-now')) {
  console.log('[Indexer] Manual trigger activated...');
  const config = loadConfig();
  for (const item of config.sitemaps) {
    processSitemap(item.url, item.priority);
  }
}
