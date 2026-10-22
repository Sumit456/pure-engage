import type { Config } from '../config.ts';
import type { DB } from '../db/index.ts';
import { createAuthService } from './auth.ts';
import { createContactsService } from './contacts.ts';
import { createEventsService } from './events.ts';
import { createIngestService } from './ingest.ts';

export function createServices(db: DB, config: Config) {
  const auth = createAuthService(db, { idleMinutes: config.PE_SESSION_IDLE_MINUTES, maxHours: config.PE_SESSION_MAX_HOURS });
  const contacts = createContactsService(db);
  const events = createEventsService(db, contacts);
  const ingest = createIngestService(contacts, events);
  return { auth, contacts, events, ingest };
}

export type Services = ReturnType<typeof createServices>;
