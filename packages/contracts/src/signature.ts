import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * RestroFlow signs every webhook: X-RestroFlow-Signature: sha256=<hex HMAC-SHA256(raw body, secret)>.
 */
export const SIGNATURE_HEADER = 'x-restroflow-signature';

export function sign(rawBody: string | Buffer, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
}

/** Constant-time comparison; false for missing/malformed headers. */
export function verifySignature(rawBody: string | Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m || !m[1]) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(m[1], 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
