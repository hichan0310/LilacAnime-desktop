const { contextBridge, ipcRenderer } = require('electron');
const { pathToFileURL } = require('url');

contextBridge.exposeInMainWorld('lilac', {
  season: () => ipcRenderer.invoke('anime:season'),
  top: () => ipcRenderer.invoke('anime:top'),
  search: query => ipcRenderer.invoke('anime:search', query),
  detail: id => ipcRenderer.invoke('anime:detail', id),
  linkkfHome: (page = 1, limit = 20) => ipcRenderer.invoke('linkkf:home', page, limit),
  linkkfDetail: id => ipcRenderer.invoke('linkkf:detail', id),
  linkkfEpisodes: id => ipcRenderer.invoke('linkkf:episodes', id),
  linkkfPlay: episode => ipcRenderer.invoke('linkkf:play', episode),
  linkkfResolve: episode => ipcRenderer.invoke('linkkf:resolve', episode),
  providerCatalog: (provider, query = '', offset = 0) => ipcRenderer.invoke('provider:catalog', provider, query, offset),
  providerDetail: anime => ipcRenderer.invoke('provider:detail', anime),
  providerPlay: (episode, title) => ipcRenderer.invoke('provider:play', episode, title),
  providerResolve: episode => ipcRenderer.invoke('provider:resolve', episode),
  coverData: url => ipcRenderer.invoke('cover:data', url),
  opEdSkip: request => ipcRenderer.invoke('oped:get', request),
  clearOpEd: () => ipcRenderer.invoke('oped:clear'),
  onOpEdStatus: callback => ipcRenderer.on('oped:status', (_, message) => callback(message)),
  downloadMedia: (url, name) => ipcRenderer.invoke('media:download', url, name),
  onDownloadProgress: callback => ipcRenderer.on('download:progress', (_, value) => callback(value)),
  downloads: () => ipcRenderer.invoke('downloads:list'),
  addDownload: request => ipcRenderer.invoke('downloads:add', request),
  cancelDownload: id => ipcRenderer.invoke('downloads:cancel', id),
  resumeDownload: id => ipcRenderer.invoke('downloads:resume', id),
  removeDownload: id => ipcRenderer.invoke('downloads:remove', id),
  playDownload: id => ipcRenderer.invoke('downloads:play', id),
  openDownloadsFolder: () => ipcRenderer.invoke('downloads:open-folder'),
  onDownloadsChanged: callback => ipcRenderer.on('downloads:changed', (_, value) => callback(value)),
  findSubtitle: async (source, title, episode) => {
    const result = await ipcRenderer.invoke('subtitle:find', source, title, episode);
    return {...result,url:pathToFileURL(result.path).href};
  },
  mpvStatus: () => ipcRenderer.invoke('mpv:status'),
  mpvPlay: (url, subtitlePath, title) => ipcRenderer.invoke('mpv:play', url, subtitlePath, title),
  setPlayerFullscreen: enabled => ipcRenderer.invoke('player:fullscreen', Boolean(enabled)),
  chooseVideo: async () => {
    const file = await ipcRenderer.invoke('file:video');
    return file ? pathToFileURL(file).href : null;
  },
  chooseSubtitle: async () => {
    const file = await ipcRenderer.invoke('file:subtitle');
    return file ? pathToFileURL(file).href : null;
  },
  chooseSubtitleDetails: async () => {
    const file = await ipcRenderer.invoke('file:subtitle');
    return file ? {path:file,url:pathToFileURL(file).href} : null;
  },
  openExternal: url => ipcRenderer.invoke('open:external', url)
});
