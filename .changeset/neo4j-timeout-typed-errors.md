---
'@utaba/deep-memory': minor
---

Neo4j transaction timeouts now surface as `TRAVERSAL_TIMEOUT` (traversals) or the new `QUERY_TIMEOUT` (all other operations), and provider errors keep the driver error as `cause`.

## Typed timeout errors

- `@utaba/deep-memory`: new `QueryTimeoutError` (code `QUERY_TIMEOUT`, `elapsedMs`) for a non-traversal operation that ran past the storage server's transaction timeout. The server rolled the transaction back, so a timed-out write did not commit.
- `@utaba/deep-memory`: `DeepMemoryError` and `ProviderError` accept an optional `ErrorOptions` argument, so providers can attach the backend error as `cause`. `TraversalTimeoutError` accepts the same options, and its suggestion now says to narrow the query rather than retry it.
- `@utaba/deep-memory-storage-neo4j`: a server-side transaction timeout (GQL status `25N14`, or a `…TransactionTimedOut…` code) was reported as a generic `ProviderError` on traversals and creates, and as a raw `Neo4jError` on other reads. Hosts treated it as an outage and retried the oversized query. It now raises `TraversalTimeoutError` from `traverse`, `exploreNeighborhood` and `findPaths`, and `QueryTimeoutError` from every other operation, with the driver error as `cause`.
- `@utaba/deep-memory-storage-neo4j`: every `ProviderError` built from a driver error now sets `cause` to that error, so hosts can read the driver's code without parsing `message`.

Migration: hosts that detected a timeout by reading `gqlStatus` / `code` on the raw `Neo4jError` from read paths should branch on `QUERY_TIMEOUT` instead, or read the driver error from `cause`.
