import { describe, expect, it } from 'vitest';
import { kafkaConfigFromEnv, securityProperties } from '../src/index.js';

const CA = '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----';

describe('Kafka connection config', () => {
  it('defaults to local plaintext Kafka', () => {
    const cfg = kafkaConfigFromEnv('t', {});
    expect(cfg.brokers).toEqual(['localhost:9092']);
    expect(securityProperties(cfg)).toEqual({});
  });

  it('supports Aiven client-certificate auth (mutual TLS), PEM inline or base64', () => {
    const cfg = kafkaConfigFromEnv('t', {
      KAFKA_BROKERS: 'kafka-x.aivencloud.com:12345',
      KAFKA_CA_PEM: CA.replace(/\n/g, '\\n'), // as stored in a one-line .env
      KAFKA_CERT_PEM: Buffer.from('-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----').toString('base64'),
      KAFKA_KEY_PEM: Buffer.from('-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----').toString('base64'),
    });
    const props = securityProperties(cfg);
    expect(props['security.protocol']).toBe('ssl');
    expect(props['ssl.ca.pem']).toBe(CA);
    expect(props['ssl.certificate.pem']).toContain('CERT');
    expect(props['ssl.key.pem']).toContain('KEY');
  });

  it('supports SASL/SCRAM over TLS', () => {
    const props = securityProperties(
      kafkaConfigFromEnv('t', { KAFKA_SASL_MECHANISM: 'scram-sha-256', KAFKA_USERNAME: 'avnadmin', KAFKA_PASSWORD: 'pw', KAFKA_CA_PEM: CA }),
    );
    expect(props).toMatchObject({ 'security.protocol': 'sasl_ssl', 'sasl.mechanisms': 'SCRAM-SHA-256', 'sasl.username': 'avnadmin', 'ssl.ca.pem': CA });
  });
});
