# @utaba/deep-memory-storage-neo4j

## 0.21.1

### Patch Changes

- Escape Lucene metacharacters in the Neo4j `findEntities` search term so full-text queries no longer throw `ParseException`.

  `@utaba/deep-memory-storage-neo4j` routed `query.searchTerm` verbatim into `CALL db.index.fulltext.queryNodes('dm_entity_text', $term)`, which parses `$term` as a Lucene classic query rather than a literal. Any reserved character in caller-supplied text (`[ ] : " ( ) { } ^ ~ * ? + - / \` and the `&` / `|` operator characters) was interpreted as query syntax and threw `org.apache.lucene.queryparser.classic.ParseException` — crashing or silently degrading every full-text search over a Neo4j graph.

  - New exported `escapeLuceneQuery` helper backslash-escapes the full Lucene classic-query metacharacter set (matching Lucene's own `QueryParserBase.escape`). Applied at the single `$term` binding in `findEntities`, so all search callers are covered by one change.
  - Characters are escaped, not stripped — every word is preserved, so relevance is unaffected.
  - Cosmos and SQL Server providers are unaffected: their substring search has no Lucene parse step and needs no escaping.
  - @utaba/deep-memory@0.21.1

## 0.21.0

### Patch Changes

- @utaba/deep-memory@0.21.0

## 0.20.1

### Patch Changes

- @utaba/deep-memory@0.20.1

## 0.20.0

### Patch Changes

- Updated dependencies [58be448]
- Updated dependencies [e4d470f]
  - @utaba/deep-memory@0.20.0
