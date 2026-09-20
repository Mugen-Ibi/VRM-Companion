import { z } from 'zod';
import { CATEGORIES, type Root, type Plan, type Avatar, type Conversation } from '../shared/types';
import type { Store } from './store';
import { DEFAULTS } from '../shared/types';
import { settingsSchema } from './settings';

const id = z.string().uuid(),
  number = z.number().finite().nonnegative();
const identity = z.object({
  id: z.string().min(1),
  size: number,
  modified: z.string(),
  hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
const rootSchema = z.object({
  id,
  path: z.string().min(1),
  identity: z.string().min(1),
  revoked: z.boolean(),
});
const operation = z
  .object({
    id,
    kind: z.enum(['mkdir', 'move']),
    from: z.string().optional(),
    to: z.string().min(1),
    identity: identity.optional(),
    state: z.enum(['pending', 'intent', 'done', 'failed', 'unresolved', 'unverified']),
    error: z.string().optional(),
  })
  .refine(
    (op) => op.kind !== 'move' || (!!op.from && !!op.identity?.hash),
    'Move identity is missing',
  );
const planSchema = z.object({
  id,
  rootId: id,
  rootIdentity: z.string().min(1),
  conversationId: id,
  revision: z.number().int().positive(),
  hash: z.string().regex(/^$|^[a-f0-9]{64}$/),
  expiresAt: number,
  createdAt: number,
  status: z.enum([
    'draft',
    'ready',
    'executing',
    'completed',
    'partial',
    'canceled',
    'failed',
    'stale',
    'recovery',
    'reviewed',
  ]),
  entries: z.array(
    z.object({
      id,
      name: z.string(),
      size: number,
      category: z.enum(CATEGORIES),
      reason: z.string(),
      identity: identity.optional(),
      excluded: z.string().optional(),
    }),
  ),
  operations: z.array(operation),
  totalBytes: number,
  undoOf: id.optional(),
  error: z.string().optional(),
  manualReviewedAt: number.optional(),
});
const conversationSchema = z.object({
  id,
  title: z.string(),
  rootId: id.optional(),
  messages: z.array(
    z.object({
      id,
      role: z.enum(['user', 'assistant']),
      content: z.string(),
      status: z.string().optional(),
      createdAt: number,
    }),
  ),
});
const avatarSchema = z.object({
  id,
  name: z.string(),
  version: z.enum(['0', '1']),
  authors: z.string(),
  license: z.string(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  size: number,
});

export function validateStoredRecord(bucket: string, key: string, value: unknown) {
  const schema = (
    {
      roots: rootSchema,
      plans: planSchema,
      conversations: conversationSchema,
      avatars: avatarSchema,
    } as Record<string, z.ZodType<{ id: string }>>
  )[bucket];
  if (schema) {
    const result = schema.safeParse(value);
    if (!result.success || result.data.id !== key)
      throw new Error(`保存データの形式が不正です（${bucket}/${key}）。原本を保持してください。`);
  } else if (bucket === 'settings' && key === 'main') {
    if (
      !value ||
      typeof value !== 'object' ||
      !settingsSchema.safeParse({ ...DEFAULTS, ...value }).success
    )
      throw new Error('保存された設定の形式が不正です。原本を保持してください。');
  }
}

class Repository<T extends { id: string }> {
  constructor(
    private store: Store,
    private bucket: string,
    private schema: z.ZodType<T>,
  ) {}
  private parse(value: unknown, expectedId?: string): T {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success || (expectedId !== undefined && parsed.data.id !== expectedId))
      throw new Error(
        `保存データの形式が不正です（${this.bucket}${expectedId ? '/' + expectedId : ''}）。原本を保持し、バックアップから復旧してください。`,
      );
    return parsed.data;
  }
  get(id: string): T | undefined {
    const value = this.store.get<unknown>(this.bucket, id);
    return value === undefined ? undefined : this.parse(value, id);
  }
  list(): T[] {
    return this.store.list<unknown>(this.bucket).map((value) => this.parse(value));
  }
  put(value: T) {
    this.store.put(this.bucket, value.id, this.parse(value, value.id));
  }
}
export class Repositories {
  readonly roots: Repository<Root>;
  readonly plans: Repository<Plan>;
  readonly conversations: Repository<Conversation>;
  readonly avatars: Repository<Avatar>;
  constructor(private store: Store) {
    this.roots = new Repository(store, 'roots', rootSchema);
    this.plans = new Repository(store, 'plans', planSchema);
    this.conversations = new Repository(store, 'conversations', conversationSchema);
    this.avatars = new Repository(store, 'avatars', avatarSchema);
  }
  validate() {
    for (const row of this.store.records()) validateStoredRecord(row.bucket, row.id, row.value);
  }
}
