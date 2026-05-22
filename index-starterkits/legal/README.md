# Legal Domain Starter Kit

## Purpose

This starter kit defines a vocabulary and indexing process for capturing **contract knowledge** — the parties, clauses, obligations, rights, definitions, and governance terms that make up legal agreements. It is designed primarily around contract creation and validation workflows, using documents such as non-disclosure agreements (NDAs), master service agreements, and statements of work as the source material.

This is a **standalone vocabulary** — it does not depend on or extend the Person or Conversations starter kits. Parties (organizations and individuals) are modeled within this vocabulary.

## Target Use Cases

- **Contract indexing** — representing the structure and content of a legal agreement as a navigable knowledge graph
- **NDA creation** — assembling a compliant NDA from a template, verifying that all required clause types are present and correctly linked
- **Contract validation** — checking that a draft contract contains the expected clause types, that all parties have obligations and rights assigned, and that no clauses conflict
- **Obligation tracking** — knowing what each party must do, by when, and under what conditions
- **Cross-reference analysis** — identifying clauses that reference each other or that conflict
- **Template comparison** — comparing a specific contract against a standard template to identify deviations or missing provisions
- **Jurisdiction and governing law** — tracking which legal jurisdiction governs each agreement

## What the Graph Can Answer

Once populated, an agent can answer questions like:

- "What are Acme Corp's obligations under this NDA?"
- "Does this agreement have a governing law clause?"
- "Which clauses in this contract reference the confidentiality clause?"
- "Are there any conflicting obligations between the parties?"
- "What is excluded from the definition of Confidential Information?"
- "Has this agreement been signed by all parties?"
- "When does this NDA expire?"
- "What rights does the receiving party have under this agreement?"
- "Is there a dispute resolution clause in this contract?"
- "Which contracts were derived from the standard NDA template?"
- "What obligations are triggered by a breach of the confidentiality clause?"
- "Does this contract deviate from the template — what clauses are missing?"

## When to Use This Kit

Use this starter kit when:

- You are indexing **legal agreements** to enable structured querying and validation.
- You want to verify that a contract draft is **complete and internally consistent** before execution.
- You need to **extract and track obligations and rights** per party from contract text.
- You are building a **contract library** with multiple agreements of the same type and want to identify commonalities and deviations.

## Governance Recommendation

**`open`** governance is recommended. Contract language is highly varied — clause types, obligation categories, and right types differ across document styles, jurisdictions, and industries. The agent needs to create new vocabulary terms on the fly without approval gates slowing down the indexing flow.

## Design Philosophy

**Model structure, not just text.** The goal is not to store contract text verbatim — that belongs in a document store. The graph captures the *structural knowledge* of a contract: who the parties are, what each clause does, what obligations it creates, what rights it grants, and how clauses relate to each other. The actual clause text is stored as a `content` property, but the value comes from the relationships.

**Obligations and rights are first-class entities.** A confidentiality clause doesn't just exist as text — it creates specific obligations (e.g. "receiving party must not disclose") and grants specific rights (e.g. "disclosing party may seek injunctive relief"). Modeling these separately makes it possible to query "what must Party A do?" without parsing contract text.

**Validation is graph traversal.** Checking whether a contract is complete means checking that all expected clause types are present (`CONTAINS_CLAUSE`), all parties have at least one obligation (`BOUND_BY`), and no two clauses carry a `CONFLICTS_WITH` relationship. The graph structure is the validation surface.

**Definitions anchor the vocabulary.** Legal agreements are precise about defined terms. Capturing `Definition` entities and linking them to the clauses that use them makes it possible to trace how a term like "Confidential Information" is scoped and where that scoping matters.

---

## Starter Kit Files

| File | Description |
|------|-------------|
| `vocabulary.md` | Entity type and relationship type definitions for the legal domain |
| `domain-guidance.md` | Extraction prompt guidance consumed by AI agents during indexing |
| `README.md` | This file — overview, automated extraction notes, and manual indexing guide |

---

## Automated Extraction

The `vocabulary.md` and `domain-guidance.md` files are consumed by the indexing pipeline automatically. When you configure an indexing job that targets this starter kit, the pipeline reads both files to guide LLM extraction — no manual prompt engineering is required.

See the [Indexer Extraction Guide](../../docs/indexer-extraction-guide.md) for configuration details including chunk sizing, output token limits, and model selection.

**Validated local model configuration:**

| Setting | Value |
|---------|-------|
| Model | Qwen3.5-35B-A3B Q5_K_M |
| Runtime | llama.cpp with CUDA |
| Context window | 64K |
| `maxChunkSize` | 20000 |
| `maxOutputTokens` | 32768 |

---

## Manual Indexing Process (MCP Tools)

Step-by-step guidance for an AI agent indexing a legal agreement (such as an NDA) into a deep-memory repository using the Legal vocabulary via MCP tools rather than the automated pipeline.

---

### Prerequisites

- Read `vocabulary.md` in this folder to understand the available entity types and relationship types before proceeding.
- Ensure the MCP server is running and accessible.
- Have the contract document available (text, PDF extract, or structured data).
- If a `Template` entity for this contract type already exists in the repository, identify its entity ID — you will link the new contract to it via `DERIVED_FROM`.

---

### Indexing Order

Always follow this sequence. Later steps depend on entities created in earlier steps.

1. Create the `Contract`
2. Create `Party` entities and link them to the contract
3. Create the `Jurisdiction` and link it to the contract
4. Link to a `Template` if applicable
5. Create `Clause` entities and link them to the contract
6. Create `Definition` entities and link them to clauses
7. Create `Obligation` entities, link to clauses and parties
8. Create `Right` entities, link to clauses and parties
9. Create inter-clause relationships (cross-references, conflicts)
10. Validate and verify the graph

---

### Step 1 — Create the Contract Entity

1. Create a `Contract` entity with the following properties:
   - `contractType` — identify the agreement type (e.g. `NDA`, `MNDA`, `MSA`). For a mutual NDA use `MNDA`.
   - `status` — `draft` if unsigned, `executed` if all parties have signed, `under-review` if in negotiation.
   - `title` — the document's full title if stated; otherwise construct one from the parties and type.
   - `effectiveDate` — parse from the document. Often stated in the opening recital or signature block.
   - `executionDate` — the date all parties signed. May differ from `effectiveDate`.
   - `expiryDate` — parse from the term clause. May be an absolute date or calculated from `effectiveDate` (e.g. "two years from the Effective Date").
   - `noticePeriodDays` — parse from the termination clause if present.
   - `description` — write a plain-language one-sentence summary.

2. Note the entity ID returned — all subsequent relationships will reference it.

---

### Step 2 — Create Party Entities and HAS_PARTY Relationships

Create one `Party` entity per signatory or named party.

#### Creating Parties

1. **Deduplicate first.** Before creating a new Party, search the repository for an existing entity with the same `name`. If the party has appeared in a previous contract, reuse the existing entity.
2. Set `partyType` to `organization` or `individual`.
3. Set `name` to the full legal name exactly as it appears in the contract. Do not abbreviate.
4. Set `jurisdiction` to the place of incorporation or domicile if stated in the contract.
5. Set `registrationNumber` and `address` if present in the signature block.

#### Linking Parties to the Contract

For each party, create a `HAS_PARTY` relationship from Contract to Party with:
- `role` — identify from the contract: `disclosing-party`, `receiving-party`, `mutual-party`, etc. In a mutual NDA both parties typically have role `mutual-party`.
- `signedDate` — the date this party's signature appears on the document, if signed.
- `signatoryName` and `signatoryTitle` — from the signature block.

---

### Step 3 — Create Jurisdiction and GOVERNED_BY Relationship

1. Locate the governing law clause in the document.
2. Search for an existing `Jurisdiction` entity with the same `name` before creating a new one. Jurisdictions are shared across contracts.
3. Create or reuse the `Jurisdiction` entity with `name`, `country`, `legalSystem`.
4. Create a `GOVERNED_BY` relationship from Contract to Jurisdiction.

If the dispute resolution clause specifies a different forum (e.g. Singapore arbitration under English law), create a second `Jurisdiction` entity for the forum and note the distinction in the `description`.

---

### Step 4 — Link to Template (if applicable)

1. If this contract was created from a known template, search for the `Template` entity by name and `contractType`.
2. If found, create a `DERIVED_FROM` relationship from Contract to Template.
3. If the template does not yet exist in the repository, create it:
   - Set `name`, `contractType`, `version`, `source`, and `description`.
   - After fully indexing this contract, you can use its clauses as the baseline for what the template should contain.

---

### Step 5 — Create Clause Entities

Read through the contract and create one `Clause` entity per discrete, identifiable provision. Do not lump multiple clause types into one entity.

#### Creating Clauses

1. **One clause type per entity.** A section headed "Confidentiality and Non-Use" should be split into a `confidentiality` clause and a `permitted-purpose` clause (or `non-use` clause) if both concepts are present.
2. Set `clauseType` from the recommended values in the vocabulary. Use a new value if none fits.
3. Set `content` to the clause text or a faithful plain-language summary. For validation purposes, prefer the original text where tractable.
4. Set `sectionReference` to the section number as it appears in the document.
5. Set `status` — typically `active` for a current agreement.
6. Set `isStandard: true` if the clause matches the template verbatim (after `DERIVED_FROM` is established).

#### Linking Clauses to the Contract

Create a `CONTAINS_CLAUSE` relationship from Contract to Clause for every clause entity created.

#### Priority order for NDAs

For an NDA, create these clause types at minimum (in this order, as later steps depend on them):

1. `definitions`
2. `confidentiality`
3. `confidentiality-exclusions`
4. `permitted-purpose`
5. `term`
6. `termination`
7. `obligations-on-termination`
8. `governing-law`
9. `dispute-resolution`
10. `injunctive-relief` (if present)
11. `entire-agreement`, `amendment`, `notice`, `severability`, `waiver` (boilerplate)

---

### Step 6 — Create Definition Entities

Parse the definitions clause (and any inline definitions scattered through the document) and create one `Definition` entity per defined term.

#### Creating Definitions

1. Set `term` to the exact capitalized term as it appears in the contract (e.g. "Confidential Information", "Permitted Purpose", "Disclosing Party").
2. Set `definitionText` to the full contractual definition text.
3. Set `sectionReference` to where the definition appears.

#### Linking Definitions

- Create `DEFINES_TERM` from the `definitions` Clause to each Definition entity.
- For every other clause that uses a defined term, create `USES_DEFINITION` from that Clause to the Definition entity.

**Key defined terms to capture for an NDA:**

| Term | Notes |
|------|-------|
| `Confidential Information` | The scope of this definition is critical — note any carve-outs |
| `Permitted Purpose` | Restricts how Confidential Information may be used |
| `Disclosing Party` / `Receiving Party` | May be defined by name or by role |
| `Representatives` | Who the receiving party may share information with |
| `Affiliate` / `Group Company` | If permitted disclosures extend to affiliates |

---

### Step 7 — Create Obligation Entities

For each clause that imposes a duty, extract the distinct obligations and create one `Obligation` entity per duty.

#### Creating Obligations

1. **One obligation per entity.** A confidentiality clause typically creates at least three: (1) must not disclose, (2) must not use for other purposes, (3) must protect with appropriate care. Model each separately.
2. Write `description` as a clear imperative: "Receiving party must not disclose Confidential Information to any third party without prior written consent of the Disclosing Party."
3. Set `obligationType` from recommended values.
4. Set `status: active` for current obligations.
5. Set `deadline` if the obligation is time-bound (e.g. "return materials within 10 days of termination").
6. Set `recurring: continuous` for ongoing duties; `recurring: on-demand` for duties triggered by events.
7. Set `conditionPrecedent` if the obligation only applies under certain conditions (e.g. "only applies if the receiving party becomes subject to a legal requirement to disclose").

#### Linking Obligations

- Create `CREATES_OBLIGATION` from Clause to Obligation for every obligation that clause generates.
- Create `BOUND_BY` from Party to Obligation for every party subject to the obligation.

**Common obligations in an NDA to capture:**

| Obligation | Type | Typically bound by |
|------------|------|-------------------|
| Must not disclose Confidential Information to third parties | `non-disclosure` | Receiving party |
| Must not use Confidential Information except for the Permitted Purpose | `non-use` | Receiving party |
| Must protect Confidential Information with at least the same degree of care as own confidential information | `protection` | Receiving party |
| Must notify Disclosing Party promptly if legally compelled to disclose | `notification` | Receiving party |
| Must return or destroy Confidential Information on termination | `return-destroy` | Receiving party |
| May only disclose to Representatives who need to know | `restriction` | Receiving party |
| Must ensure Representatives are bound by equivalent obligations | `compliance` | Receiving party |

---

### Step 8 — Create Right Entities

For each clause that grants an entitlement, extract the distinct rights and create one `Right` entity per entitlement.

#### Creating Rights

1. Write `description` as a clear entitlement statement: "Disclosing Party may seek injunctive relief without the need to prove actual damage."
2. Set `rightType` from recommended values.
3. Set `status: active` for current rights.
4. Set `conditionPrecedent` if the right only arises in certain circumstances (e.g. "only if a breach has occurred or is threatened").

#### Linking Rights

- Create `GRANTS_RIGHT` from Clause to Right for every right that clause grants.
- Create `ENTITLED_TO` from Party to Right for every party that holds the right.

**Common rights in an NDA to capture:**

| Right | Type | Typically held by |
|-------|------|------------------|
| May terminate the agreement on written notice | `termination` | Either party (or both) |
| May seek injunctive or other equitable relief for breach | `injunctive-relief` | Disclosing party |
| May disclose to Representatives on a need-to-know basis | `disclosure` | Receiving party |
| May disclose if legally compelled (court order, regulator) | `disclosure` | Receiving party |

---

### Step 9 — Create Inter-Clause Relationships

With all clauses created, add the structural relationships between them.

#### Cross-References (REFERENCES_CLAUSE)

1. Read through each clause for explicit cross-references (e.g. "Subject to clause 4(b)...").
2. For each cross-reference, create `REFERENCES_CLAUSE` from the referencing Clause to the referenced Clause.
3. Set `nature` to describe how they relate (e.g. "conditions", "qualifies", "extends", "subject-to").

#### Conflicts (CONFLICTS_WITH)

1. Identify any clauses that appear to be in tension — for example, a broad confidentiality obligation and an exclusion clause that may be interpreted to swallow the main obligation.
2. Create `CONFLICTS_WITH` between them (bidirectional — create once in either direction).
3. Set `description` to explain the tension and `severity` to `minor` or `major`.

#### Clause Supersession (SUPERSEDES_CLAUSE)

- If this contract amends an earlier version and specific clauses replace earlier ones, create `SUPERSEDES_CLAUSE` from the new Clause to the old Clause (which should have `status: amended`).

---

### Step 10 — Validate and Verify

#### Structural Validation

After completing the index, run these checks:

1. **Party coverage** — every `Party` linked via `HAS_PARTY` must also be the source of at least one `BOUND_BY` relationship (every party has at least one obligation).
2. **Clause completeness for NDAs** — verify the following clause types are present via `CONTAINS_CLAUSE`:
   - `confidentiality`
   - `confidentiality-exclusions`
   - `term`
   - `governing-law`
   - `obligations-on-termination`
3. **Obligation linkage** — every `Obligation` must have both a `CREATES_OBLIGATION` inbound (from a Clause) and at least one `BOUND_BY` inbound (from a Party). Obligations without a bound party are incomplete.
4. **Right linkage** — every `Right` must have both a `GRANTS_RIGHT` inbound (from a Clause) and at least one `ENTITLED_TO` inbound (from a Party).
5. **Definition coverage** — every defined term that appears in a clause should have a `USES_DEFINITION` relationship from that clause. Scan the key terms (e.g. "Confidential Information") and check coverage.

#### Neighborhood Exploration

Use `explore_neighborhood` (depth 2) on the `Contract` entity to visually confirm the graph is well-connected. You should see:
- Contract to Parties (via `HAS_PARTY`)
- Contract to Clauses (via `CONTAINS_CLAUSE`)
- Contract to Jurisdiction (via `GOVERNED_BY`)
- Clauses to Obligations, Rights, Definitions
- Parties to Obligations, Rights

#### Template Gap Analysis (if DERIVED_FROM is set)

1. List all `clauseType` values in the template (via the template's `CONTAINS_CLAUSE` relationships).
2. List all `clauseType` values in the indexed contract.
3. Any clause type present in the template but absent from the contract is a **gap** — flag it for review.

---

### Example Indexing Sequence

Given a mutual NDA between Acme Corp Ltd (England and Wales) and Beta Technologies GmbH (Germany), effective 2026-01-15, governing disclosure of technical roadmap information for a potential partnership:

1. **Create Contract:** MNDA, status: executed, effectiveDate: 2026-01-15, expiryDate: 2028-01-15
2. **Create Party:** "Acme Corp Ltd" (organization, jurisdiction: England and Wales)
3. **Create Party:** "Beta Technologies GmbH" (organization, jurisdiction: Germany)
4. **Create HAS_PARTY:** Contract to Acme Corp (role: mutual-party, signedDate: 2026-01-14)
5. **Create HAS_PARTY:** Contract to Beta Technologies (role: mutual-party, signedDate: 2026-01-15)
6. **Create Jurisdiction:** "England and Wales" (legalSystem: common-law)
7. **Create GOVERNED_BY:** Contract to Jurisdiction
8. **Create Clause:** "Confidentiality" (clauseType: confidentiality, sectionReference: "3")
9. **Create Clause:** "Exclusions" (clauseType: confidentiality-exclusions, sectionReference: "4")
10. **Create Clause:** "Permitted Purpose" (clauseType: permitted-purpose, sectionReference: "2")
11. **Create Clause:** "Term" (clauseType: term, sectionReference: "7")
12. **Create Clause:** "Governing Law" (clauseType: governing-law, sectionReference: "10")
13. Create `CONTAINS_CLAUSE` for all 5 clauses to Contract
14. **Create Definition:** "Confidential Information" with full definition text
15. **Create Definition:** "Permitted Purpose" — "evaluation of a potential commercial partnership"
16. Create `DEFINES_TERM`: definitions clause to both Definitions
17. Create `USES_DEFINITION`: confidentiality clause to "Confidential Information"
18. Create `USES_DEFINITION`: exclusions clause to "Confidential Information"
19. **Create Obligation:** "Must not disclose Confidential Information to third parties" (non-disclosure, active, continuous)
20. Create `CREATES_OBLIGATION`: confidentiality clause to Obligation
21. Create `BOUND_BY`: Acme Corp to Obligation; Beta Technologies to Obligation
22. **Create Obligation:** "Must not use Confidential Information except for the Permitted Purpose" (non-use, active, continuous)
23. Create `CREATES_OBLIGATION` and `BOUND_BY` as above
24. **Create Right:** "May terminate on 30 days written notice" (termination, active)
25. Create `GRANTS_RIGHT`: term clause to Right
26. Create `ENTITLED_TO`: Acme Corp to Right; Beta Technologies to Right
27. Create `REFERENCES_CLAUSE`: confidentiality clause to exclusions clause (nature: "qualified-by")
28. **Validate:** run neighborhood exploration on Contract, confirm all parties have obligations, confirm no orphan obligations or rights
