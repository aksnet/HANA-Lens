// HANA-Lens Java Bridge
// Replaces tauri-adapter.js: routes all invoke() calls and file dialogs
// through the local Java HTTP server instead of Tauri IPC.

(function(){
  'use strict';

  const SERVER = 'http://localhost:7321';

  // ── Core invoke ─────────────────────────────────────────────────────────────
  async function invoke(command, args){
    const response = await fetch(SERVER + '/invoke/' + command, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args || {})
    });
    if(!response.ok){
      const msg = await response.text();
      throw new Error(msg || 'Command failed: ' + command);
    }
    const text = await response.text();
    if(!text || text === 'null') return null;
    return JSON.parse(text);
  }

  // ── Path helpers ─────────────────────────────────────────────────────────────
  function basename(p){ return p.replace(/\\/g,'/').replace(/\/$/, '').split('/').pop() || p }
  function joinPath(a, b){
    a = a.replace(/\\/g,'/').replace(/\/$/, '')
    b = b.replace(/\\/g,'/')
    return a + '/' + b
  }
  function dirOfPath(p){ const s=p.replace(/\\/g,'/'); const i=s.lastIndexOf('/'); return i>0?s.slice(0,i):s }

  // ── TauriFileHandle ──────────────────────────────────────────────────────────
  class TauriFileHandle {
    constructor(path){
      this.kind = 'file'
      this.name = basename(path)
      this._path = path
      this._meta = null
    }

    async getFile(){
      const path = this._path
      const handle = this
      return {
        name: handle.name,
        get size(){ return handle._meta?.size ?? 0 },
        get lastModified(){ return handle._meta?.lastModified ?? 0 },
        async text(){ return invoke('read_text_file', {path}) },
        slice(start, end){
          return { async text(){ return invoke('read_file_range', {path, offset: start>>>0, length: (end-start)>>>0}) } }
        }
      }
    }

    async _loadMeta(){
      if(!this._meta){
        try{ this._meta = await invoke('get_file_metadata', {path: this._path}) }
        catch(e){ this._meta = {size:0, lastModified:0} }
      }
    }
  }

  // ── TauriDirHandle ───────────────────────────────────────────────────────────
  class TauriDirHandle {
    constructor(path){
      this.kind = 'directory'
      this.name = basename(path) || path
      this._path = path
    }

    async *entries(){
      let items
      try{ items = await invoke('read_dir', {path: this._path}) }
      catch(e){ return }
      for(const item of items){
        const childPath = joinPath(this._path, item.name)
        if(item.kind === 'directory'){
          yield [item.name, new TauriDirHandle(childPath)]
        } else {
          const fh = new TauriFileHandle(childPath)
          fh._meta = {size: item.size ?? 0, lastModified: item.lastModified ?? 0}
          yield [item.name, fh]
        }
      }
    }

    async getDirectoryHandle(name){
      const p = joinPath(this._path, name)
      const exists = await invoke('entry_exists', {path: p, kind: 'directory'})
      if(!exists) throw Object.assign(new Error(name), {name:'NotFoundError'})
      return new TauriDirHandle(p)
    }

    async getFileHandle(name){
      const p = joinPath(this._path, name)
      const exists = await invoke('entry_exists', {path: p, kind: 'file'})
      if(!exists) throw Object.assign(new Error(name), {name:'NotFoundError'})
      return new TauriFileHandle(p)
    }
  }

  // ── showDirectoryPicker override ─────────────────────────────────────────────
  window.showDirectoryPicker = async function(opts){
    let defaultPath = ''
    if(opts?.startIn){
      const h = opts.startIn
      const candidate = h.kind === 'file' ? dirOfPath(h._path) : h._path
      try {
        const ok = await invoke('path_accessible', { path: candidate })
        if(ok) defaultPath = candidate
      } catch(e) {}
    }
    const params = new URLSearchParams({ defaultPath })
    const res = await fetch(SERVER + '/dialog/open-directory?' + params)
    const result = await res.json()
    if(!result) throw Object.assign(new Error('Aborted'), {name:'AbortError'})
    return new TauriDirHandle(result)
  }

  // ── showOpenFilePicker override ──────────────────────────────────────────────
  window.showOpenFilePicker = async function(opts){
    let defaultPath = ''
    if(opts?.startIn){
      const h = opts.startIn
      const candidate = h.kind === 'file' ? dirOfPath(h._path) : h._path
      try {
        const ok = await invoke('path_accessible', { path: candidate })
        if(ok) defaultPath = candidate
      } catch(e) {}
    }
    let extensions = ''
    if(opts?.types){
      const exts = []
      for(const t of opts.types){
        for(const arr of Object.values(t.accept||{})){
          for(const e of arr) exts.push(e.replace(/^\./, ''))
        }
      }
      extensions = exts.join(',')
    }
    const params = new URLSearchParams({ defaultPath, extensions })
    const res = await fetch(SERVER + '/dialog/open-file?' + params)
    const result = await res.json()
    if(!result) throw Object.assign(new Error('Aborted'), {name:'AbortError'})
    const path = result
    return [new TauriFileHandle(path)]
  }

  // ── CombinedFileHandle ───────────────────────────────────────────────────────
  class CombinedFileHandle {
    constructor(name, parts) {
      this.kind = 'file'
      this.name = name
      this._parts = parts
      this._totalSize = parts.reduce((s, p) => s + (p._meta?.size ?? 0), 0)
      this._lastModified = Math.max(...parts.map(p => p._meta?.lastModified ?? 0))
    }

    async getFile() {
      const totalSize = this._totalSize
      const lastModified = this._lastModified
      const parts = this._parts
      return {
        size: totalSize,
        lastModified,
        async text() { return this.slice(0, totalSize).text() },
        slice(start, end) {
          return {
            async text() {
              let result = ''
              let pos = 0
              for (const part of parts) {
                const partSize = part._meta?.size ?? 0
                const partEnd = pos + partSize
                if (end <= pos) break
                if (start >= partEnd) { pos = partEnd; continue }
                const readStart = Math.max(0, start - pos)
                const readEnd = Math.min(partSize, end - pos)
                if (readEnd > readStart) {
                  result += await invoke('read_file_range', {
                    path: part._path,
                    offset: readStart >>> 0,
                    length: (readEnd - readStart) >>> 0
                  })
                }
                pos = partEnd
              }
              return result
            }
          }
        }
      }
    }
  }

  // ── Expose globally ──────────────────────────────────────────────────────────
  window.TauriDirHandle = TauriDirHandle
  window.TauriFileHandle = TauriFileHandle
  window.CombinedFileHandle = CombinedFileHandle
  window.invoke = invoke

  // Expose a minimal window.__TAURI__ so that feature checks in app.js pass.
  // No dialog stub — app.js guards dialog calls with window.__TAURI__?.dialog
  // and falls back to browser APIs (download link / input[type=file]) when absent.
  window.__TAURI__ = {
    core: { invoke }
  }

  // ── External link handler ────────────────────────────────────────────────────
  document.addEventListener('click', e => {
    const a = e.target.closest('a[href]')
    if(!a) return
    const href = a.href
    if(!href || (!href.startsWith('http://') && !href.startsWith('https://'))) return
    // Don't intercept links to localhost (our own server)
    try { if(new URL(href).hostname === 'localhost') return } catch(e) {}
    e.preventDefault()
    invoke('open_external_url', { url: href }).catch(() => {})
  }, true)

})();
