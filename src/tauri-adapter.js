// HANA-Lens Tauri Adapter
// Replaces the browser File System Access API with Tauri IPC calls.
// All file operations go through Rust via invoke(), so there is no
// .ini blocklist or path-depth restriction.

(function(){
  'use strict';

  const { invoke }  = window.__TAURI__.core;
  const { open: tauriOpen } = window.__TAURI__.dialog;

  // ── Path helpers ────────────────────────────────────────────────────────────
  function basename(p){ return p.replace(/\\/g,'/').replace(/\/$/, '').split('/').pop() || p }
  function joinPath(a, b){
    a = a.replace(/\\/g,'/').replace(/\/$/, '')
    b = b.replace(/\\/g,'/')
    return a + '/' + b
  }
  function dirOfPath(p){ const s=p.replace(/\\/g,'/'); const i=s.lastIndexOf('/'); return i>0?s.slice(0,i):s }

  // ── TauriFileHandle ──────────────────────────────────────────────────────────
  // Mimics FileSystemFileHandle + the File object returned by getFile()
  class TauriFileHandle {
    constructor(path){
      this.kind = 'file'
      this.name = basename(path)
      this._path = path
      this._meta = null // lazy: {size, lastModified}
    }

    async getFile(){
      const path = this._path
      const handle = this
      // Return a File-like object matching the subset used in app.js
      return {
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
  // Mimics FileSystemDirectoryHandle
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
  // Accepts same option shape as the browser API; `startIn` can be a TauriDirHandle
  // or TauriFileHandle (uses its directory as defaultPath).
  window.showDirectoryPicker = async function(opts){
    let defaultPath
    if(opts?.startIn){
      const h = opts.startIn
      defaultPath = h.kind === 'file' ? dirOfPath(h._path) : h._path
    }
    const result = await tauriOpen({ directory: true, multiple: false, defaultPath })
    if(!result) throw Object.assign(new Error('Aborted'), {name:'AbortError'})
    return new TauriDirHandle(typeof result === 'string' ? result : result[0])
  }

  // ── showOpenFilePicker override ──────────────────────────────────────────────
  window.showOpenFilePicker = async function(opts){
    let defaultPath
    if(opts?.startIn){
      const h = opts.startIn
      defaultPath = h.kind === 'file' ? dirOfPath(h._path) : h._path
    }
    const filters = []
    if(opts?.types){
      for(const t of opts.types){
        const exts = Object.values(t.accept||{}).flat().map(e=>e.replace(/^\./,''))
        if(exts.length) filters.push({name: t.description||'Files', extensions: exts})
      }
    }
    const result = await tauriOpen({ directory: false, multiple: false, defaultPath, filters: filters.length ? filters : undefined })
    if(!result) throw Object.assign(new Error('Aborted'), {name:'AbortError'})
    const path = typeof result === 'string' ? result : result[0]
    return [new TauriFileHandle(path)]
  }

  // ── CombinedFileHandle ───────────────────────────────────────────────────────
  // Represents multiple sequential TauriFileHandle parts as one virtual file.
  // Parts must be passed sorted by sequence number, each with ._meta.size set.
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

  // ── Expose classes globally ──────────────────────────────────────────────────
  window.TauriDirHandle = TauriDirHandle
  window.TauriFileHandle = TauriFileHandle
  window.CombinedFileHandle = CombinedFileHandle

  // ── External link handler ────────────────────────────────────────────────────
  // WebView2/WebKit does not open target="_blank" links in the system browser.
  // Intercept all http/https link clicks and route them through the Rust command.
  document.addEventListener('click', e => {
    const a = e.target.closest('a[href]')
    if(!a) return
    const href = a.href
    if(!href || (!href.startsWith('http://') && !href.startsWith('https://'))) return
    try { if(new URL(href).hostname === 'tauri.localhost') return } catch(e) {}
    e.preventDefault()
    invoke('open_external_url', { url: href }).catch(() => {})
  }, true)

})();
