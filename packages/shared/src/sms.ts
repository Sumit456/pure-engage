// SMS length and segment counting. Any character outside GSM-7 (for example Arabic) switches the whole
// message to UCS-2, which cuts a segment from 160 to 70 characters.

const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXTENDED = '^{}\\[~]|€\f'; // each costs two septets

export interface SmsInfo { encoding: 'GSM-7' | 'UCS-2'; units: number; segments: number; perSegment: number }

export function smsInfo(text: string): SmsInfo {
  let gsm = true;
  let septets = 0;
  for (const ch of text) {
    if (GSM7_BASIC.includes(ch)) septets += 1;
    else if (GSM7_EXTENDED.includes(ch)) septets += 2;
    else { gsm = false; break; }
  }
  if (gsm) {
    const segments = septets === 0 ? 0 : septets <= 160 ? 1 : Math.ceil(septets / 153);
    return { encoding: 'GSM-7', units: septets, segments, perSegment: segments > 1 ? 153 : 160 };
  }
  // UCS-2 counts UTF-16 code units (emoji take two).
  const units = text.length;
  const segments = units === 0 ? 0 : units <= 70 ? 1 : Math.ceil(units / 67);
  return { encoding: 'UCS-2', units, segments, perSegment: segments > 1 ? 67 : 70 };
}
