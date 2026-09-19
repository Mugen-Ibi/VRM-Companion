export const CATEGORIES = [
  '画像',
  '文書',
  '動画',
  '音声',
  '圧縮ファイル',
  'その他',
  '変更なし',
] as const;
export type Category = (typeof CATEGORIES)[number];
export type Phase =
  | 'idle'
  | 'thinking'
  | 'responding'
  | 'working'
  | 'success'
  | 'error'
  | 'canceled'
  | 'attention';
export interface Settings {
  endpoint: string;
  model: string;
  context: number;
  outputTokens: number;
  persona: string;
  userName: string;
  style: string;
  saveHistory: boolean;
  avatarId: string | null;
  avatarVisible: boolean;
  scale: number;
  fps: number;
  alwaysOnTop: boolean;
  autoStart: boolean;
  avatarX?: number;
  avatarY?: number;
}
export const DEFAULTS: Settings = {
  endpoint: 'http://127.0.0.1:8080',
  model: '',
  context: 4096,
  outputTokens: 512,
  persona: 'Companion',
  userName: '',
  style: '親しみやすい丁寧な日本語で、簡潔に話してください。',
  saveHistory: true,
  avatarId: null,
  avatarVisible: true,
  scale: 1,
  fps: 30,
  alwaysOnTop: true,
  autoStart: false,
};
export interface Identity {
  id: string;
  size: number;
  modified: string;
  hash?: string;
}
export interface Root {
  id: string;
  path: string;
  identity: string;
  revoked: boolean;
}
export interface Entry {
  id: string;
  name: string;
  size: number;
  category: Category;
  reason: string;
  identity?: Identity;
  excluded?: string;
}
export interface Operation {
  id: string;
  kind: 'mkdir' | 'move';
  from?: string;
  to: string;
  identity?: Identity;
  state: 'pending' | 'intent' | 'done' | 'failed' | 'unresolved' | 'unverified';
  error?: string;
}
export interface Plan {
  id: string;
  rootId: string;
  rootIdentity: string;
  conversationId: string;
  revision: number;
  hash: string;
  expiresAt: number;
  createdAt: number;
  status:
    | 'draft'
    | 'ready'
    | 'executing'
    | 'completed'
    | 'partial'
    | 'canceled'
    | 'failed'
    | 'stale'
    | 'recovery'
    | 'reviewed';
  entries: Entry[];
  operations: Operation[];
  totalBytes: number;
  undoOf?: string;
  error?: string;
  manualReviewedAt?: number;
}
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status?: string;
  createdAt: number;
}
export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  rootId?: string;
}
export interface Avatar {
  id: string;
  name: string;
  version: '0' | '1';
  authors: string;
  license: string;
  hash: string;
  size: number;
}
export interface Pending {
  id: string;
  conversationId: string;
  reason: string;
  needsTarget: boolean;
}
export interface State {
  avatarVisible: boolean;
  settings: Settings;
  roots: Root[];
  plans: Plan[];
  conversations: Conversation[];
  avatars: Avatar[];
  pending: Pending | null;
  phase: Phase;
  busy: boolean;
  dataPath: string;
  hasApiKey: boolean;
  recoveryWarning?: string;
}
export type AppEvent =
  | { type: 'state'; state: State }
  | { type: 'delta'; conversationId: string; messageId: string; text: string }
  | { type: 'progress'; text: string; done: number; total: number }
  | { type: 'error'; message: string };
export type Reply<T> = { ok: true; value: T } | { ok: false; error: string };
export interface API {
  state(): Promise<State>;
  settings(value: Settings, key?: string): Promise<State>;
  connect(): Promise<{ models: string[]; message: string }>;
  newConversation(): Promise<string>;
  deleteConversation(id: string): Promise<void>;
  clearHistory(): Promise<void>;
  send(id: string, text: string): Promise<void>;
  cancel(): Promise<void>;
  selectRoot(conversationId: string): Promise<void>;
  chooseRoot(conversationId: string, rootId: string): Promise<void>;
  revokeRoot(id: string): Promise<void>;
  resolvePending(id: string): Promise<void>;
  dismissPending(): Promise<void>;
  propose(conversationId: string): Promise<void>;
  editPlan(id: string, revision: number, choices: Record<string, Category>): Promise<void>;
  prepare(id: string): Promise<void>;
  approve(id: string, revision: number, hash: string): Promise<void>;
  undo(id: string): Promise<void>;
  recover(): Promise<void>;
  acknowledgeRecovery(id: string, revision: number): Promise<void>;
  deleteJob(id: string): Promise<void>;
  importAvatar(): Promise<void>;
  selectAvatar(id: string): Promise<void>;
  deleteAvatar(id: string): Promise<void>;
  avatarBytes(id: string): Promise<Uint8Array>;
  showAvatar(): Promise<void>;
  hideAvatar(): Promise<void>;
  openData(): Promise<void>;
  backupData(): Promise<string>;
  onEvent(fn: (event: AppEvent) => void): () => void;
}
export interface AvatarAPI {
  state(): Promise<{ settings: Settings; phase: Phase; visible: boolean }>;
  bytes(id: string): Promise<Uint8Array>;
  hit(hit: boolean): void;
  openPanel(): void;
  openMenu(): void;
  drag(dx: number, dy: number): void;
  report(id: string, ok: boolean, error?: string): void;
  onUpdate(fn: (state: { settings: Settings; phase: Phase; visible: boolean }) => void): () => void;
}
declare global {
  interface Window {
    companion: API;
    avatarHost: AvatarAPI;
  }
}
