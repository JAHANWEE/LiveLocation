import { kafkaClient } from './kafka-client.js';

async function setup() {
  const admin = kafkaClient.admin();

  console.log('[Kafka Admin] Connecting…');
  await admin.connect();
  console.log('[Kafka Admin] Connected');

  const created = await admin.createTopics({
    waitForLeaders: true,
    topics: [
      {
        topic: 'location-updates',
        numPartitions: 2,          // 2 partitions → 2 consumers can read in parallel
        replicationFactor: 1,      // single broker in dev
        configEntries: [
          { name: 'retention.ms', value: String(7 * 24 * 60 * 60 * 1000) }, // 7 days
        ],
      },
    ],
  });

  console.log(created ? '[Kafka Admin] Topic created' : '[Kafka Admin] Topic already exists');

  await admin.disconnect();
  console.log('[Kafka Admin] Done');
}

setup().catch((err) => {
  console.error('[Kafka Admin] Error:', err);
  process.exit(1);
});
