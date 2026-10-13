/** Durable request identity: object key order is irrelevant, array order and
 * explicit JSON values remain significant. The version is part of the value. */
export function requestIdentity(value: unknown): string {
  return JSON.stringify({ version: 1, value }, (_key, item) => item !== null && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
