import { contextBridge, ipcRenderer } from 'electron';
import type { API, Reply, AppEvent } from '../shared/types';
async function call<T>(name: string, ...args: unknown[]): Promise<T> {
  const r = (await ipcRenderer.invoke('companion:' + name, ...args)) as Reply<T>;
  if (!r.ok) throw new Error(r.error);
  return r.value;
}
const api: API = {
  chooseModelDirectory: () => call('chooseModelDirectory'),
  chooseLlamaServer: () => call('chooseLlamaServer'),
  refreshModels: () => call('refreshModels'),
  selectModel: (id) => call('selectModel', id),
  unloadModel: () => call('unloadModel'),
  gesture: (name) => call('gesture', name),
  state: () => call('state'),
  settings: (v, k) => call('settings', v, k),
  connect: () => call('connect'),
  newConversation: () => call('newConversation'),
  deleteConversation: (id) => call('deleteConversation', id),
  clearHistory: () => call('clearHistory'),
  send: (id, t, mode) => call('send', id, t, mode),
  cancel: () => call('cancel'),
  selectRoot: (id) => call('selectRoot', id),
  chooseRoot: (id, r) => call('chooseRoot', id, r),
  revokeRoot: (id) => call('revokeRoot', id),
  resolvePending: (id) => call('resolvePending', id),
  dismissPending: () => call('dismissPending'),
  propose: (id) => call('propose', id),
  editPlan: (id, r, c) => call('editPlan', id, r, c),
  prepare: (id) => call('prepare', id),
  approve: (id, r, h) => call('approve', id, r, h),
  undo: (id) => call('undo', id),
  recover: () => call('recover'),
  acknowledgeRecovery: (id, r) => call('acknowledgeRecovery', id, r),
  deleteJob: (id) => call('deleteJob', id),
  importAvatar: () => call('importAvatar'),
  selectAvatar: (id) => call('selectAvatar', id),
  deleteAvatar: (id) => call('deleteAvatar', id),
  avatarBytes: (id) => call('avatarBytes', id),
  showAvatar: () => call('showAvatar'),
  hideAvatar: () => call('hideAvatar'),
  openData: () => call('openData'),
  backupData: () => call('backupData'),
  onEvent(fn) {
    const handler = (_e: unknown, v: AppEvent) => fn(v);
    ipcRenderer.on('companion:event', handler);
    return () => ipcRenderer.removeListener('companion:event', handler);
  },
};
contextBridge.exposeInMainWorld('companion', api);
