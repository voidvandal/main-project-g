// Storage adapters. Both expose the same tiny interface:
//   list()                 -> all seat items
//   get(seatId)            -> item | undefined
//   save(item, prevVersion)-> writes item only if stored version === prevVersion
//                             (prevVersion === null means "must not exist");
//                             throws ConflictError otherwise.

export class ConflictError extends Error {
  constructor() {
    super('Seat was updated by someone else, please retry');
    this.name = 'ConflictError';
  }
}

export function memoryStore(initial = []) {
  const items = new Map(initial.map((s) => [s.seatId, structuredClone(s)]));
  return {
    async list() {
      return [...items.values()].map((s) => structuredClone(s));
    },
    async get(id) {
      const s = items.get(id);
      return s && structuredClone(s);
    },
    async save(item, prevVersion) {
      const cur = items.get(item.seatId);
      if (prevVersion === null ? cur !== undefined : cur?.version !== prevVersion) {
        throw new ConflictError();
      }
      items.set(item.seatId, structuredClone(item));
    },
  };
}

export async function dynamoStore(tableName) {
  // The AWS SDK v3 ships with the Lambda Node.js runtime, so it is imported
  // lazily here and never needed for local development or tests.
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand } = await import(
    '@aws-sdk/lib-dynamodb'
  );
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });

  return {
    async list() {
      const out = [];
      let ExclusiveStartKey;
      do {
        const r = await doc.send(new ScanCommand({ TableName: tableName, ExclusiveStartKey }));
        out.push(...(r.Items ?? []));
        ExclusiveStartKey = r.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return out;
    },
    async get(seatId) {
      const r = await doc.send(new GetCommand({ TableName: tableName, Key: { seatId } }));
      return r.Item;
    },
    async save(item, prevVersion) {
      const cond =
        prevVersion === null
          ? { ConditionExpression: 'attribute_not_exists(seatId)' }
          : {
              ConditionExpression: '#v = :v',
              ExpressionAttributeNames: { '#v': 'version' },
              ExpressionAttributeValues: { ':v': prevVersion },
            };
      try {
        await doc.send(new PutCommand({ TableName: tableName, Item: item, ...cond }));
      } catch (e) {
        if (e.name === 'ConditionalCheckFailedException') throw new ConflictError();
        throw e;
      }
    },
  };
}

// For a single long-running server (e.g. Lightsail containers): keeps seats in
// memory and writes a JSON snapshot to S3 after every change, loading it on start.
// Writes are serialised, so the snapshot always reflects the latest state.
export async function s3SnapshotStore(bucket, key = 'seats.json') {
  const { S3Client, GetObjectCommand, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const s3 = new S3Client({ forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === '1' }); // path style only for local S3 mocks
  let initial = [];
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    initial = JSON.parse(await r.Body.transformToString());
  } catch (e) {
    if (e.name !== 'NoSuchKey') throw e;
  }
  const mem = memoryStore(initial);
  let chain = Promise.resolve();
  const persist = () => {
    chain = chain
      .then(async () => {
        const items = await mem.list();
        await s3.send(new PutObjectCommand({
          Bucket: bucket, Key: key, Body: JSON.stringify(items), ContentType: 'application/json',
        }));
      })
      .catch((e) => console.error('snapshot to S3 failed', e));
    return chain;
  };
  return {
    list: mem.list,
    get: mem.get,
    async save(item, prevVersion) {
      await mem.save(item, prevVersion);
      await persist();
    },
  };
}
