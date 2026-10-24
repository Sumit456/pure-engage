// Types for the JavaScript connector package (packages/purenet-connector), limited to what the API uses.
declare module '@pure-engage/purenet-connector' {
  import type { IncomingMessage, ServerResponse } from 'node:http';

  export interface PlatformTrackRequest {
    attributes: Record<string, unknown>[];
    events: Record<string, unknown>[];
  }

  export interface PureNetClient {
    getMember(memberId: string): Promise<unknown>;
    listConsents(memberId: string): Promise<unknown[]>;
    searchMembers(system: string, value: string, opts?: { limit?: number; cursor?: string }): Promise<{ data: unknown[]; next_cursor: string | null }>;
    createSubscription(callbackUrl: string, eventTypes: string[]): Promise<{ id: string; signingSecret: string }>;
    deleteSubscription(subscriptionId: string): Promise<null>;
  }

  export function createPureNetFromEnv(env?: NodeJS.ProcessEnv): { config: Record<string, unknown>; client: PureNetClient };

  export function createReceiver(opts: {
    secret: string;
    sink: (track: PlatformTrackRequest) => Promise<void>;
    client?: PureNetClient;
    seen?: { has(id: string): boolean; add(id: string): void };
    log?: (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;
    now?: () => number;
  }): (req: IncomingMessage, res: ServerResponse) => Promise<void>;

  export function sign(secret: string, rawBody: string | Buffer, t?: number): string;
}
