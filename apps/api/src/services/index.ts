import type { Config } from '../config.ts';
import type { DB } from '../db/index.ts';
import { createAuthService } from './auth.ts';
import { createContactsService } from './contacts.ts';
import { createDeliveryService } from './delivery.ts';
import { createEventsService } from './events.ts';
import { createIngestService } from './ingest.ts';
import { selectProviders } from './providers.ts';
import { createTemplatesService } from './templates.ts';
import { createLinkSigner } from './tracking.ts';
import { createSegmentsService } from './segments.ts';
import { createCampaignsService } from './campaigns.ts';
import { createWorker } from './worker.ts';
import { createJourneysService } from './journeys.ts';

export interface ServiceOptions {
  clock?: () => Date;
  log?: (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;
}

export function createServices(db: DB, config: Config, { clock = () => new Date(), log }: ServiceOptions = {}) {
  const auth = createAuthService(db, { idleMinutes: config.PE_SESSION_IDLE_MINUTES, maxHours: config.PE_SESSION_MAX_HOURS });
  const contacts = createContactsService(db);
  const events = createEventsService(db, contacts);
  const ingest = createIngestService(contacts, events);
  const templates = createTemplatesService(db);
  const signer = createLinkSigner(config.trackingSecret, config.PE_PUBLIC_URL);
  const providers = selectProviders(config);
  const delivery = createDeliveryService({ db, config, contacts, templates, signer, providers, clock, ...(log ? { log } : {}) });
  const segments = createSegmentsService(db, clock);
  const campaigns = createCampaignsService({ db, segments, templates, delivery, clock, batchSize: config.PE_CAMPAIGN_BATCH_SIZE, ...(log ? { log } : {}) });
  const journeys = createJourneysService({ db, contacts, templates, segments, delivery, clock, ...(log ? { log } : {}) });
  const worker = createWorker([
    { name: 'journey-events', run: () => journeys.processEvents() },
    { name: 'journey-steps', run: () => journeys.runDue() },
    { name: 'campaigns', run: () => campaigns.processDue() },
    { name: 'dispatch', run: () => delivery.dispatchOnce() },
  ], log);
  return { auth, contacts, events, ingest, templates, signer, providers, delivery, segments, campaigns, journeys, worker };
}

export type Services = ReturnType<typeof createServices>;
