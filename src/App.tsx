import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Search, 
  Link as LinkIcon, 
  CheckCircle2, 
  XCircle, 
  Loader2, 
  Play, 
  Globe, 
  LogOut,
  AlertCircle,
  FileText,
  MousePointer2,
  ExternalLink
} from 'lucide-react';
import { cn } from './lib/utils';

interface UrlStatus {
  url: string;
  status: 'idle' | 'pending' | 'success' | 'error';
  message?: string;
  source: 'sitemap' | 'discovered'; // indicates origin of URL
}

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [sitemapUrl, setSitemapUrl] = useState('');
  const [priority, setPriority] = useState<'high' | 'medium' | 'low'>('high');
  const [urls, setUrls] = useState<UrlStatus[]>([]);
  const [discoveredUrls, setDiscoveredUrls] = useState<UrlStatus[]>([]);
  const [isFetching, setIsFetching] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkAuth = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/status');
      const data = await res.json();
      setIsAuthenticated(data.isAuthenticated);
    } catch (e) {
      console.error('Failed to check auth', e);
      setIsAuthenticated(false);
    }
  }, []);

  useEffect(() => {
    checkAuth();
    
    const handleMessage = (event: MessageEvent) => {
      // Validate origin if possible, but '*' for now as per oauth skill for simplicity in dynamic env
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        checkAuth();
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [checkAuth]);

  const handleConnect = async () => {
    try {
      const res = await fetch('/api/auth/url');
      const { url } = await res.json();
      window.open(url, 'google_oauth', 'width=600,height=700');
    } catch (e) {
      setError('Failed to initiate login');
    }
  };

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setIsAuthenticated(false);
    setUrls([]);
    setSitemapUrl('');
  };

  const fetchUrls = async () => {
    if (!sitemapUrl) return;
    setIsFetching(true);
    setError(null);
    try {
      const res = await fetch('/api/sitemap/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: sitemapUrl, priority })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      
      setUrls(data.urls.map((u: string) => ({ url: u, status: 'idle', source: 'sitemap' })));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setIsFetching(false);
    }
  };

  const indexAll = async () => {
    if (isProcessing) return;
    setIsProcessing(true);
    
    // Reset statuses to idle before starting
    const resetUrls = [...urls, ...discoveredUrls].map(u => ({ ...u, status: 'idle' as const }));
    setUrls(resetUrls.filter(u => u.source === 'sitemap'));
    setDiscoveredUrls(resetUrls.filter(u => u.source === 'discovered'));

    const allItems = [...urls, ...discoveredUrls];

    for (let i = 0; i < allItems.length; i++) {
      const currentUrl = allItems[i].url;
      const isDiscovered = allItems[i].source === 'discovered';
      
      // Update locally to pending
      const updateStatus = (status: 'pending' | 'success' | 'error', message?: string) => {
        if (isDiscovered) {
          setDiscoveredUrls(prev => prev.map((u, idx) => u.url === currentUrl ? { ...u, status, message } : u));
        } else {
          setUrls(prev => prev.map((u, idx) => u.url === currentUrl ? { ...u, status, message } : u));
        }
      };

      updateStatus('pending');
      
      try {
        const res = await fetch('/api/index-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: currentUrl })
        });
        const data = await res.json();
        
        if (data.success) {
          updateStatus('success');
        } else {
          updateStatus('error', data.error);
        }
      } catch (e: any) {
        updateStatus('error', e.message);
      }
      
      // Small delay to avoid aggressive rate limiting
      await new Promise(r => setTimeout(r, 200));
    }
    
    setIsProcessing(false);
  };

  // Crawl all discovered links from sitemap URLs
  const crawlAllLinks = async () => {
    if (!isAuthenticated) return;
    setIsProcessing(true);
    const allLinks: Set<string> = new Set();
    try {
      for (const item of urls) {
        const res = await fetch('/api/crawl-page', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: item.url })
        });
        const data = await res.json();
        if (data.links && Array.isArray(data.links)) {
          data.links.forEach((l: string) => allLinks.add(l));
        }
      }
      const discoveredArray = Array.from(allLinks).map(l => ({ url: l, status: 'idle' as const, source: 'discovered' as const }));
      setDiscoveredUrls(discoveredArray);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setIsProcessing(false);
    }
  };

  const submitSitemapToSC = async () => {
    if (!sitemapUrl) return;
    setIsProcessing(true);
    try {
      // Logic for siteUrl: extract origin from sitemap
      const urlObj = new URL(sitemapUrl);
      const siteUrl = urlObj.origin + '/';

      const res = await fetch('/api/sitemap/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteUrl, sitemapUrl })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      alert('Sitemap submitted successfully to Search Console!');
    } catch (e: any) {
      setError('Submit failed: ' + e.message);
    } finally {
      setIsProcessing(false);
    }
  };

  if (isAuthenticated === null) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center font-mono">
        <Loader2 className="animate-spin text-accent" size={32} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg text-text-main font-sans selection:bg-accent selection:text-white">
      {/* Header Section */}
      <header className="h-16 bg-card border-b border-border-theme flex items-center px-10 justify-between sticky top-0 z-50">
        <div className="text-lg font-extrabold text-accent tracking-tighter">
          INDEXER PRO / SITEMAP
        </div>
        <div className="flex items-center gap-6">
          {isAuthenticated ? (
            <div className="flex items-center gap-4">
              <span className="text-xs text-text-sub font-medium flex items-center gap-2">
                <span className="w-2 h-2 bg-success-theme rounded-full animate-pulse" />
                Authenticated
              </span>
              <button 
                onClick={handleLogout}
                className="text-[11px] font-bold uppercase tracking-wider text-text-sub hover:text-text-main transition-colors flex items-center gap-1.5"
              >
                <LogOut size={14} />
                Logout
              </button>
            </div>
          ) : (
            <button 
              onClick={handleConnect}
              className="text-[11px] font-bold uppercase tracking-wider text-accent hover:opacity-80 transition-opacity flex items-center gap-1.5"
            >
              <Globe size={14} />
              Connect Console
            </button>
          )}
        </div>
      </header>

      <main className="max-w-[1024px] mx-auto p-10 grid grid-cols-1 gap-6">
        {/* Intro */}
        <section className="mb-2">
          <h1 className="text-2xl font-bold tracking-tight mb-1">Crawl Management</h1>
          <p className="text-sm text-text-sub">Force priority indexing for entire sitemap payloads via the Indexing API.</p>
        </section>

        {/* Control Panel: URL Input */}
        <section className="bg-card p-6 rounded-xl border border-border-theme grid grid-cols-1 lg:grid-cols-[1fr_200px_auto] gap-4 items-end shadow-sm">
          <div className="space-y-2">
            <label className="text-[11px] uppercase font-bold text-text-sub tracking-wider">Sitemap URL Source</label>
            <div className="relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-text-sub/40" size={18} />
              <input 
                type="url" 
                placeholder="https://example.com/sitemap.xml"
                value={sitemapUrl}
                onChange={(e) => setSitemapUrl(e.target.value)}
                className="w-full bg-[#fafbff] border-[1.5px] border-border-theme p-3 pl-11 rounded-md font-mono text-sm focus:outline-none focus:border-accent transition-colors"
              />
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-[11px] uppercase font-bold text-text-sub tracking-wider">Crawl Schedule</label>
            <select 
              value={priority}
              onChange={(e) => setPriority(e.target.value as any)}
              className="w-full bg-[#fafbff] border-[1.5px] border-border-theme p-3 rounded-md font-mono text-sm focus:outline-none focus:border-accent appearance-none cursor-pointer"
            >
              <option value="high">High (Daily)</option>
              <option value="medium">Medium (Weekly)</option>
              <option value="low">Low (Monthly)</option>
            </select>
          </div>
          <button 
            onClick={fetchUrls}
            disabled={!isAuthenticated || isFetching || !sitemapUrl}
            className="bg-accent text-white px-6 py-3 rounded-md font-semibold text-sm disabled:opacity-30 flex items-center gap-2 justify-center hover:shadow-lg transition-all active:scale-[0.98] h-[48px]"
          >
            {isFetching ? <Loader2 className="animate-spin" size={18} /> : <FileText size={18} />}
            Fetch URLs
          </button>
          {error && (
            <div className="md:col-span-2 flex items-center gap-2 text-red-600 text-xs font-medium">
              <AlertCircle size={14} />
              {error}
            </div>
          )}
        </section>

        {/* Dashboard Stats */}
        <AnimatePresence>
          {urls.length > 0 && (
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="grid grid-cols-1 gap-6"
            >
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-5">
                {[
                  { label: 'Total URLs', value: urls.length + discoveredUrls.length, color: 'text-text-main' },
                  { label: 'Crawled', value: [...urls, ...discoveredUrls].filter(u => u.status === 'success').length, color: 'text-success-theme' },
                  { label: 'In Queue', value: [...urls, ...discoveredUrls].filter(u => u.status === 'pending' || u.status === 'idle').length, color: 'text-pending-theme' },
                  { label: 'API Failures', value: [...urls, ...discoveredUrls].filter(u => u.status === 'error').length, color: 'text-red-500' }
                ].map((stat, i) => (
                  <div key={i} className="bg-card p-5 rounded-xl border border-border-theme text-center shadow-sm">
                    <div className={cn("text-3xl font-bold mb-1", stat.color)}>{stat.value.toLocaleString()}</div>
                    <div className="text-[11px] text-text-sub uppercase font-bold tracking-wider">{stat.label}</div>
                  </div>
                ))}
              </div>

              {/* Action Bar */}
              <div className="flex flex-wrap items-center justify-between gap-4 p-2">
                <div className="flex flex-col gap-1">
                  <span className="text-[11px] text-text-sub uppercase font-bold tracking-wider">
                    Process Progress: {Math.round((([...urls, ...discoveredUrls].filter(u => u.status === 'success' || u.status === 'error').length) / (urls.length + discoveredUrls.length)) * 100) || 0}%
                  </span>
                  <div className="w-48 h-1.5 bg-border-theme rounded-full overflow-hidden">
                    <motion.div 
                      className="h-full bg-accent"
                      initial={{ width: 0 }}
                      animate={{ width: `${(([...urls, ...discoveredUrls].filter(u => u.status === 'success' || u.status === 'error').length) / (urls.length + discoveredUrls.length)) * 100}%` }}
                    />
                  </div>
                </div>
                <div className="flex gap-3">
                  <button 
                    onClick={submitSitemapToSC}
                    disabled={isProcessing}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-md border border-border-theme text-xs font-bold uppercase tracking-wider hover:bg-bg transition-colors disabled:opacity-30"
                  >
                    <Globe size={14} />
                    Submit Sitemap
                  </button>
                  <button 
                    onClick={indexAll}
                    disabled={isProcessing}
                    className="flex items-center gap-2 px-6 py-2.5 bg-accent text-white rounded-md text-xs font-bold uppercase tracking-wider hover:bg-opacity-90 transition-all disabled:opacity-30 shadow-md active:translate-y-0.5"
                  >
                    {isProcessing ? <Loader2 className="animate-spin" size={14} /> : <Play size={14} />}
                    Force Re-index All
                  </button>
                  <button
                    onClick={crawlAllLinks}
                    disabled={isProcessing}
                    className="flex items-center gap-2 px-5 py-2.5 bg-[var(--color-info-theme)] text-white rounded-md text-xs font-bold uppercase tracking-wider hover:bg-opacity-90 transition-all disabled:opacity-30 shadow-md"
                  >
                    {isProcessing ? <Loader2 className="animate-spin" size={14} /> : <Globe size={14} />}
                    Crawl Links
                  </button>
                </div>
              </div>

              {/* Queue Table */}
              <div className="bg-card rounded-xl border border-border-theme overflow-hidden shadow-sm">
                <div className="bg-[#fafbff] px-6 py-4 border-b border-border-theme flex justify-between items-center">
                  <span className="font-bold text-sm">Live Submission Queue</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="bg-[#fafbff]">
                        <th className="text-left text-[11px] uppercase text-text-sub font-bold px-6 py-3 border-b border-border-theme w-24">Pos</th>
                        <th className="text-left text-[11px] uppercase text-text-sub font-bold px-6 py-3 border-b border-border-theme">Page / URL path</th>
                        <th className="text-left text-[11px] uppercase text-text-sub font-bold px-6 py-3 border-b border-border-theme w-32">Signal</th>
                      </tr>
                    </thead>
                    <tbody>
                      ([...urls, ...discoveredUrls].map((url, i) => (
                        <tr key={url.url} className="hover:bg-[#fafbff] transition-colors">
                          <td className="px-6 py-3 border-b border-border-theme font-mono text-xs text-text-sub">{(i + 1).toString().padStart(3, '0')}</td>
                          <td className="px-6 py-3 border-b border-border-theme">
                            <div className="flex items-center gap-2 min-w-0 font-mono text-[13px]">
                              <span className="truncate max-w-md" title={url.url}>{url.url}</span>
                              <a 
                                href={url.url} 
                                target="_blank" 
                                rel="noreferrer"
                                className="text-accent hover:opacity-60 transition-opacity"
                              >
                                <ExternalLink size={12} />
                              </a>
                              {url.source === 'discovered' && (
                                <span className="ml-2 px-2 py-0.5 rounded bg-[var(--color-info-theme)] text-white text-[10px] font-medium uppercase">Discovered</span>
                              )}
                            </div>
                          </td>
                          <td className="px-6 py-3 border-b border-border-theme">
                            {url.status === 'idle' && (
                              <span className="px-2.5 py-1 rounded bg-[#eee] text-text-sub text-[10px] font-bold uppercase tracking-wider">Queued</span>
                            )}
                            {url.status === 'pending' && (
                              <span className="px-2.5 py-1 rounded bg-amber-50 text-pending-theme text-[10px] font-bold uppercase tracking-wider flex items-center gap-1.5 w-fit">
                                <Loader2 size={10} className="animate-spin" />
                                Pending
                              </span>
                            )}
                            {url.status === 'success' && (
                              <span className="px-2.5 py-1 rounded bg-[#e6f6f4] text-success-theme text-[10px] font-bold uppercase tracking-wider">200 OK</span>
                            )}
                            {url.status === 'error' && (
                              <span className="px-2.5 py-1 rounded bg-red-50 text-red-500 text-[10px] font-bold uppercase tracking-wider" title={url.message}>Error</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <footer className="max-w-[1024px] mx-auto px-10 py-12 border-t border-border-theme opacity-50 font-mono text-[10px] uppercase tracking-widest text-center">
        Indexer Pro Engine // Built for scale and SEO velocity.
      </footer>
    </div>
  );
}
