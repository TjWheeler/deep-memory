---
'@utaba/deep-memory-indexer': patch
---

Fix two full-validation defects found running a live validation pass against docling-converted sources.

- **Read the correct source text.** `validateFull` now resolves each extraction's source to its converted derived text (when one exists) before handing it to the validation worker, instead of the original binary document path. Reading a binary file as UTF-8 text caused the validator to see garbage and misreport legitimate entities as fabricated.
- **Bound the validation worker's tool-use loop.** A batch's tool-calling loop now has a hard ceiling on provider calls (`maxToolCallsPerBatch` plus a small grace allowance to conclude), so a model that keeps issuing tool calls instead of a final answer can no longer pin an unbounded number of requests against the configured endpoint. A batch that hits the ceiling completes with every item marked `unverifiable` and a distinct note, rather than looping indefinitely. A stop request is now also honored inside an in-progress batch (previously only between batches), and no longer counts as a batch failure or consumes a retry.
