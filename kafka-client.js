import { Kafka } from 'kafkajs';

const brokers = (process.env.KAFKA_BROKERS ?? '127.0.0.1:9092').split(',');

export const kafkaClient = new Kafka({
  clientId: process.env.KAFKA_CLIENT_ID ?? 'livetrack',
  brokers,
  // Reduce noise in development
  logLevel: 1, // WARN
});
