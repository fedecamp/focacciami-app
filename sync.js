(function(){
  const SUPABASE_URL = 'https://szpjulwrtvfmmiohfqav.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN6cGp1bHdydHZmbW1pb2hmcWF2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyOTMwMTUsImV4cCI6MjA5OTg2OTAxNX0.fpJUxaB3fdC7_SyjWfFEuM5PX5SlQ4fL9AYaIUzm8qY';
  const PREFIX = 'focacciami_';
  const TABLE = 'focacciami_data';
  const _origSet = Storage.prototype.setItem;
  const _origRemove = Storage.prototype.removeItem;
  const _rawSet = (k, v) => _origSet.call(localStorage, k, v);
  const _rawRemove = (k) => _origRemove.call(localStorage, k);
  let client = null;
  let hydrating = false;
  const pending = new Map();
  let flushTimer = null;
  window.__fcSync = { ready: false, error: null, status: 'boot', log: [] };
  function dlog(m){ try { window.__fcSync.log.push('[' + new Date().toISOString().slice(11,19) + '] ' + m); if (window.__fcSync.log.length > 30) window.__fcSync.log.shift(); } catch(e){} }
  function setStatus(s){ window.__fcSync.status = s; dlog('status=' + s); try { window.dispatchEvent(new CustomEvent('fc-sync-status', { detail: s })); } catch(e){} }
  function getClient(){
    if (client) return client;
    if (!window.supabase) return null;
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    return client;
  }
  async function initialPull(){
    setStatus('sync');
    const c = getClient();
    if (!c) { setStatus('offline'); window.__fcSync.ready = true; window.dispatchEvent(new Event('fc-sync-ready')); return; }
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000));
    try {
      const q = c.from(TABLE).select('id, value');
      const { data, error } = await Promise.race([q, timeout]);
      if (error) throw error;
      const cloudCount = Array.isArray(data) ? data.filter(r => r && typeof r.id === 'string' && r.id.startsWith(PREFIX)).length : 0;
      const localKeys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(PREFIX)) localKeys.push(k);
      }
      if (cloudCount === 0 && localKeys.length > 0) {
        const batch = [];
        for (const k of localKeys) {
          const v = localStorage.getItem(k);
          let parsed = v;
          try { parsed = JSON.parse(v); } catch(e) {}
          batch.push({ id: k, value: parsed, updated_at: new Date().toISOString() });
        }
        try {
          const { error: uerr } = await c.from(TABLE).upsert(batch);
          if (uerr) console.warn('[fc-sync] initial push error', uerr);
        } catch(e) { console.warn('[fc-sync] initial push ex', e); }
      } else {
        hydrating = true;
        if (Array.isArray(data)) {
          for (const row of data) {
            if (!row || typeof row.id !== 'string' || !row.id.startsWith(PREFIX)) continue;
            const v = row.value;
            const s = (typeof v === 'string') ? v : JSON.stringify(v);
            _rawSet(row.id, s);
          }
        }
        hydrating = false;
      }
      setStatus('ok');
    } catch(e) {
      hydrating = false;
      window.__fcSync.error = e && (e.message || String(e));
      dlog('initial pull FAILED: ' + (e && (e.message || String(e))));
      console.warn('[fc-sync] initial pull failed', e);
      setStatus('offline');
    }
    window.__fcSync.ready = true;
    window.dispatchEvent(new Event('fc-sync-ready'));
  }
  async function softPull(){
    const c = getClient();
    if (!c) return;
    try {
      const { data, error } = await c.from(TABLE).select('id, value');
      if (error || !Array.isArray(data)) return;
      hydrating = true;
      let changed = false;
      for (const row of data) {
        if (!row || typeof row.id !== 'string' || !row.id.startsWith(PREFIX)) continue;
        const v = row.value;
        const s = (typeof v === 'string') ? v : JSON.stringify(v);
        const cur = localStorage.getItem(row.id);
        if (cur !== s) { _rawSet(row.id, s); changed = true; }
      }
      hydrating = false;
      if (changed) window.dispatchEvent(new Event('fc-sync-refreshed'));
    } catch(e) { hydrating = false; }
  }
  function scheduleFlush(){
    if (flushTimer) return;
    setStatus('saving');
    flushTimer = setTimeout(flush, 600);
  }
  async function flush(){
    flushTimer = null;
    if (pending.size === 0) { setStatus('ok'); return; }
    const c = getClient();
    if (!c) { setStatus('offline'); return; }
    const batch = [];
    for (const [id, value] of pending.entries()) batch.push({ id, value, updated_at: new Date().toISOString() });
    pending.clear();
    try {
      const { error } = await c.from(TABLE).upsert(batch);
      if (error) { console.warn('[fc-sync] push error', error); setStatus('offline'); return; }
      setStatus('ok');
    } catch(e) { console.warn('[fc-sync] push ex', e); setStatus('offline'); }
  }
  Storage.prototype.setItem = function(k, v){
    _origSet.call(this, k, v);
    if (this !== localStorage) return;
    if (hydrating) return;
    if (typeof k !== 'string' || !k.startsWith(PREFIX)) return;
    let parsed = v;
    try { parsed = JSON.parse(v); } catch(e) {}
    pending.set(k, parsed);
    scheduleFlush();
  };
  Storage.prototype.removeItem = function(k){
    _origRemove.call(this, k);
    if (this !== localStorage) return;
    if (hydrating) return;
    if (typeof k !== 'string' || !k.startsWith(PREFIX)) return;
    pending.set(k, null);
    scheduleFlush();
  };
  window.__fcSync.refresh = softPull;
  window.addEventListener('focus', () => { if (window.__fcSync.ready) softPull(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && window.__fcSync.ready) softPull(); });
  function boot(tries){
    tries = tries || 0;
    if (window.supabase) { dlog('supabase-js loaded after ' + tries + ' tries'); initialPull(); return; }
    if (tries > 50) { dlog('supabase-js FAILED to load'); setStatus('offline'); window.__fcSync.ready = true; window.dispatchEvent(new Event('fc-sync-ready')); return; }
    setTimeout(() => boot(tries + 1), 100);
  }
  dlog('boot start');
  boot();
})();