import { z } from 'zod';

export const CHANNELS = ['email', 'sms', 'push'] as const;
export const PURPOSES = ['care', 'marketing'] as const;
export const CONSENT_STATUSES = ['granted', 'denied', 'unknown'] as const;

export type Channel = (typeof CHANNELS)[number];
export type Purpose = (typeof PURPOSES)[number];
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

export const channelSchema = z.enum(CHANNELS);
export const purposeSchema = z.enum(PURPOSES);
export const consentStatusSchema = z.enum(CONSENT_STATUSES);

/** `{ email: { care: 'granted', marketing: 'denied' } }`. Missing entries mean unknown. */
export const consentMapSchema = z.record(channelSchema, z.record(purposeSchema, consentStatusSchema).optional());
export type ConsentMap = z.infer<typeof consentMapSchema>;

/** Sending is allowed only on an explicit grant; unknown or missing is treated as denied. */
export function canSend(consent: ConsentMap | null | undefined, channel: Channel, purpose: Purpose): boolean {
  return consent?.[channel]?.[purpose] === 'granted';
}
