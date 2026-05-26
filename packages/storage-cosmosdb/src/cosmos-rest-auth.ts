// CosmosDB REST API auth + provisioning helpers.
//
// Extracted from CosmosDbProvider.ts so both ensureSchema (Gremlin-side
// provisioning) and CosmosDocumentClient (Document-endpoint queries) can
// share the same HMAC-token generator without duplicating it.

import crypto from 'node:crypto';

/**
 * Generate a CosmosDB REST API authorization token.
 * See: https://learn.microsoft.com/en-us/rest/api/cosmos-db/access-control-on-cosmosdb-resources
 */
export function cosmosAuthToken(
  verb: string,
  resourceType: string,
  resourceLink: string,
  date: string,
  key: string,
): string {
  const payload = `${verb.toLowerCase()}\n${resourceType.toLowerCase()}\n${resourceLink}\n${date.toLowerCase()}\n\n`;
  const keyBuffer = Buffer.from(key, 'base64');
  const hmac = crypto.createHmac('sha256', keyBuffer);
  hmac.update(payload);
  const signature = hmac.digest('base64');
  return encodeURIComponent(`type=master&ver=1.0&sig=${signature}`);
}

/**
 * Create a CosmosDB resource (database or container) via REST API.
 * Returns true if the resource was created, false if it already existed.
 */
export async function cosmosRestPut(
  restBase: string,
  key: string,
  urlPath: string,
  resourceLink: string,
  resourceType: string,
  body: Record<string, unknown>,
  rejectUnauthorized: boolean,
): Promise<boolean> {
  const date = new Date().toUTCString();
  const token = cosmosAuthToken('post', resourceType, resourceLink, date, key);

  const url = `${restBase}/${urlPath}`;

  const options: RequestInit = {
    method: 'POST',
    headers: {
      'Authorization': token,
      'x-ms-version': '2018-12-31',
      'x-ms-date': date,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  };

  // For self-signed certs (emulator), disable TLS verification process-wide.
  // Caller explicitly opted in via rejectUnauthorized: false.
  if (!rejectUnauthorized) {
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
  }

  const response = await fetch(url, options);

  if (response.status === 201) return true; // Created
  if (response.status === 409) return false; // Already exists

  const text = await response.text();
  throw new Error(`CosmosDB REST ${response.status}: ${text}`);
}
