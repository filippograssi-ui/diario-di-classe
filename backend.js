// Collegamento ai dati condivisi su Supabase.
// Espone la stessa piccola interfaccia usata dall'app: db.doc(), db.collection(), assets.upload()/delete().
window.fileUrl = p => p;
window.__makeBackend = function () {
  const cfg = window.DIARIO_CONFIG || {};
  if (!window.supabase || !cfg.url || !cfg.key) return null;
  const sb = window.supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: false } });
  const BUCKET = "appunti";
  const cache = new Map();   // collezione -> Map(id -> dati)
  const subs = new Map();    // collezione -> Set(funzioni)
  const loaded = new Set();

  const colMap = c => { if (!cache.has(c)) cache.set(c, new Map()); return cache.get(c); };
  const snapOf = c => {
    const m = colMap(c);
    const docs = [...m.keys()].sort().map(id => { const d = m.get(id); return { id, exists: true, data: () => d }; });
    return { docs, size: docs.length, empty: !docs.length };
  };
  const emit = c => {
    const s = subs.get(c); if (!s) return;
    const snap = snapOf(c);
    s.forEach(fn => { try { fn(snap); } catch (e) { console.error(e); } });
  };
  async function load(c) {
    const { data, error } = await sb.from("docs").select("id,data").eq("collection", c);
    if (error) { console.warn(error); window.__diarioOffline && window.__diarioOffline(true); return; }
    window.__diarioOffline && window.__diarioOffline(false);
    const m = new Map(); for (const r of data) m.set(r.id, r.data);
    cache.set(c, m); loaded.add(c); emit(c);
  }
  const reloadAll = () => { for (const c of subs.keys()) load(c); };

  sb.channel("docs-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "docs" }, p => {
      const row = p.eventType === "DELETE" ? p.old : p.new;
      if (!row || !row.collection) return;
      const m = colMap(row.collection);
      if (p.eventType === "DELETE") m.delete(row.id); else m.set(row.id, row.data);
      emit(row.collection);
    })
    .subscribe(st => { if (st === "SUBSCRIBED") reloadAll(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reloadAll(); });
  window.addEventListener("online", reloadAll);

  const fail = error => { if (error) { const e = new Error(error.message); e.code = "unavailable"; throw e; } };
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/[-.]/g, "").slice(0, 20);
  function addSub(c, fn) {
    if (!subs.has(c)) subs.set(c, new Set());
    subs.get(c).add(fn);
    if (loaded.has(c)) fn(snapOf(c)); else load(c);
    return () => subs.get(c).delete(fn);
  }
  function docRef(c, id) {
    return {
      id, path: c + "/" + id,
      async set(data) {
        colMap(c).set(id, data); emit(c);
        const { error } = await sb.from("docs").upsert({ collection: c, id, data, updated_at: new Date().toISOString() });
        fail(error);
      },
      async update(patch) {
        const m = colMap(c); m.set(id, { ...(m.get(id) || {}), ...patch }); emit(c);
        const { error } = await sb.rpc("merge_doc", { p_collection: c, p_id: id, p_patch: patch });
        fail(error);
      },
      async delete() {
        colMap(c).delete(id); emit(c);
        const { error } = await sb.from("docs").delete().eq("collection", c).eq("id", id);
        fail(error);
      },
      onSnapshot(fn) {
        return addSub(c, () => { const d = colMap(c).get(id); fn({ id, exists: d !== undefined, data: () => d }); });
      }
    };
  }
  const db = {
    doc(path) { const i = path.indexOf("/"); return docRef(path.slice(0, i), path.slice(i + 1)); },
    collection(c) {
      return {
        path: c,
        doc(id) { return docRef(c, id || newId()); },
        async add(data) { const r = docRef(c, newId()); await r.set(data); return r; },
        onSnapshot(fn) { return addSub(c, fn); }
      };
    }
  };
  window.fileUrl = p => sb.storage.from(BUCKET).getPublicUrl(p).data.publicUrl;
  const assets = {
    async upload(file, opts) {
      if (file.size > 50 * 1024 * 1024) { const e = new Error("too large"); e.code = "too_large"; throw e; }
      const type = (opts && opts.type) || file.type || "application/octet-stream";
      const safe = (file.name || "file").normalize("NFD").replace(/[^\w.\-]+/g, "_").slice(-80);
      const path = Date.now() + "-" + newId().slice(0, 8) + "-" + safe;
      const { error } = await sb.storage.from(BUCKET).upload(path, file, { contentType: type, upsert: false });
      if (error) { const e = new Error(error.message); e.code = "upstream_error"; throw e; }
      return { id: path, url: window.fileUrl(path), contentType: type };
    },
    async delete(path) { await sb.storage.from(BUCKET).remove([path]); return { deleted: true }; }
  };
  return { db, assets };
};
