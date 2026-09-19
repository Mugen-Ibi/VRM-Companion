import { contextBridge, ipcRenderer } from 'electron';
import type { AvatarAPI } from '../shared/types';
const api: AvatarAPI = {
  state: () => ipcRenderer.invoke('avatar:state'),
  bytes: (id) => ipcRenderer.invoke('avatar:bytes', id),
  hit: (value) => ipcRenderer.send('avatar:hit', value),
  openPanel: () => ipcRenderer.send('avatar:open'),
  openMenu: () => ipcRenderer.send('avatar:menu'),
  drag: (dx, dy) => ipcRenderer.send('avatar:drag', dx, dy),
  report: (id, ok, error) => ipcRenderer.send('avatar:report', id, ok, error),
  onUpdate(fn) {
    const cb = (_e: unknown, value: any) => fn(value);
    ipcRenderer.on('avatar:update', cb);
    return () => ipcRenderer.removeListener('avatar:update', cb);
  },
};
contextBridge.exposeInMainWorld('avatarHost', api);
