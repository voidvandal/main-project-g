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
