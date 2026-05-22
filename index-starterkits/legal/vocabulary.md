# Legal Domain — Vocabulary

This document defines the entity types and relationship types for a contract-focused knowledge graph. It is intended to be read by AI agents and human developers when creating or extending a repository for contract creation and validation.

---

## Patterns in This Vocabulary

Before reading the full spec, understand these six conventions. When extending this vocabulary with new types, follow the same patterns for consistency.

1. **Status lifecycle for dynamic entities.** Contracts, obligations, and rights all evolve over time. Every entity that can change state has a `status` property with defined values. Always set status — use it to reflect the current state rather than deleting entities. A fulfilled obligation is still useful history.

2. **Obligations and rights belong to parties via explicit relationships.** A `Clause` creates an `Obligation` or grants a `Right`, but the obligation is *owed by* a specific `Party` (via `BOUND_BY`) and the right is *held by* a specific `Party` (via `ENTITLED_TO`). Always complete both links: Clause → Obligation/Right and Party → Obligation/Right.

3. **Definitions are entities, not just text.** Defined terms (e.g. "Confidential Information", "Permitted Purpose") are first-class `Definition` entities, not just properties on clauses. This allows queries like "show me every clause that uses this defined term" via `USES_DEFINITION`.

4. **Conflict detection is explicit.** When two clauses or two obligations are in tension, create a `CONFLICTS_WITH` relationship between them. This makes validation a graph query rather than a document review task.

5. **Templates capture the standard.** A `Template` entity represents the expected shape of an agreement type (e.g. standard mutual NDA). Specific contracts link to a template via `DERIVED_FROM`, enabling deviation analysis: clauses present in the template but not in the contract represent gaps.

6. **Section references are properties, not structure.** Clause ordering and section numbering (`sectionReference`) are stored as properties on `Clause` entities. The graph topology reflects logical relationships (what creates what, what conflicts with what) — not document layout.

---

## Entity Types

### Contract

The agreement itself. Represents a single executed, draft, or templated legal document.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `contractType` | string | yes | Type of agreement — see recommended values below |
| `status` | string | yes | `draft`, `under-review`, `executed`, `expired`, `terminated`, `amended` |
| `title` | string | no | Full document title (e.g. "Mutual Non-Disclosure Agreement between Acme Corp and Beta Ltd") |
| `effectiveDate` | string | no | ISO 8601 date — when obligations begin |
| `executionDate` | string | no | ISO 8601 date — when all parties signed |
| `expiryDate` | string | no | ISO 8601 date — when the agreement lapses |
| `terminationDate` | string | no | ISO 8601 date — if terminated early |
| `noticePeriodDays` | number | no | Days of notice required for termination |
| `description` | string | no | Plain-language summary of the agreement's purpose |

**Label convention:** `{contractType}: {party names}` (e.g. "NDA: Acme Corp / Beta Ltd"). If a title is set, use that instead.

**Summary convention:** A one-sentence description of the agreement, e.g. "Mutual NDA between Acme Corp and Beta Ltd, effective 2026-01-15, governing disclosure of technical roadmap information."

**Recommended `contractType` values:**

| Value | Description |
|-------|-------------|
| `NDA` | Non-disclosure agreement |
| `MNDA` | Mutual non-disclosure agreement |
| `MSA` | Master service agreement |
| `SOW` | Statement of work |
| `SLA` | Service level agreement |
| `DPA` | Data processing agreement |
| `LOI` | Letter of intent |
| `MOU` | Memorandum of understanding |
| `employment` | Employment contract |
| `license` | Software or IP license agreement |
| `amendment` | Amendment to an existing agreement |

**Naming convention:** Use uppercase for industry-standard acronyms where the abbreviated form is the canonical name in legal practice (NDA, MSA, SOW, etc.). Use lowercase for contract types that have no standard acronym — the plain English word is more stable than an arbitrary abbreviation. When extending this list, prefer an existing acronym if universally recognized; otherwise use lowercase English.

These are recommendations — in `open` governance mode, the agent can use any `contractType` value.

---

### Party

An organization or individual who is a signatory or named party to one or more contracts. Parties are shared across contracts — if Acme Corp appears in three agreements, there is one `Party` entity for Acme Corp linked to all three.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | string | yes | Full legal name of the party |
| `partyType` | string | yes | `organization` or `individual` |
| `jurisdiction` | string | no | Place of incorporation or domicile (e.g. "England and Wales", "Delaware, USA") |
| `registrationNumber` | string | no | Company registration or incorporation number |
| `address` | string | no | Registered address |
| `leiCode` | string | no | Legal Entity Identifier (ISO 17442) — globally unique 20-character alphanumeric code for legal entities |
| `vatID` | string | no | VAT identification number including country prefix (e.g. "GB123456789") |
| `taxID` | string | no | National tax or fiscal identifier (TIN in US, CIF/NIF in Spain, etc.) |

**Label convention:** The party's legal name (e.g. "Acme Corp Ltd").

**Summary convention:** A brief description, e.g. "UK-incorporated technology company, party to NDA with Beta Ltd."

---

### Clause

A discrete, identifiable provision within a contract. Each clause type should be a separate entity even if they appear together in a single document section.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `clauseType` | string | yes | Type of clause — see recommended values below |
| `content` | string | yes | The clause text or a faithful plain-language summary |
| `sectionReference` | string | no | Section identifier in the document (e.g. "3.2", "Clause 5(a)") |
| `status` | string | no | `active` (default), `amended`, `deleted` |
| `isStandard` | boolean | no | `true` if this clause matches the template verbatim |
| `context` | string | no | Use-case context for this clause — enables AI generation agents to filter clauses by context. See recommended values below |

**Label convention:** `{clauseType}` optionally qualified with section reference (e.g. "Confidentiality — Section 3" or just "Governing Law").

**Summary convention:** A plain-language one-liner, e.g. "Prohibits the receiving party from disclosing Confidential Information to third parties without prior written consent."

**Recommended `clauseType` values:**

| Value | Description |
|-------|-------------|
| `confidentiality` | Core non-disclosure obligation |
| `confidentiality-exclusions` | Carve-outs from the confidentiality obligation |
| `permitted-purpose` | Restriction on how Confidential Information may be used |
| `term` | Duration and expiry of the agreement |
| `termination` | Conditions under which the agreement may be terminated |
| `governing-law` | Which legal system governs the contract |
| `dispute-resolution` | How disputes are resolved (courts, arbitration, mediation) |
| `obligations-on-termination` | What parties must do when the agreement ends (e.g. return/destroy materials) |
| `limitation-of-liability` | Cap on damages or exclusions of liability types |
| `indemnification` | One party's obligation to compensate the other |
| `representations-warranties` | Statements of fact or promise |
| `intellectual-property` | Ownership of IP created or disclosed |
| `data-protection` | GDPR or other privacy obligations |
| `assignment` | Restrictions on transferring rights under the agreement |
| `entire-agreement` | Merger/integration clause |
| `amendment` | How the agreement may be modified |
| `notice` | How formal notices must be delivered |
| `severability` | What happens if a clause is found unenforceable |
| `waiver` | Restrictions on waiving rights |
| `injunctive-relief` | Right to seek equitable remedies |
| `definitions` | Container for all defined terms |
| `recitals` | Background and context ("whereas" clauses) |
| `signature` | Execution block |

**Recommended `context` values:**

| Value | Description |
|-------|-------------|
| `ip-disclosure` | NDA/MNDA where specific IP (software, patents, designs) is the subject matter |
| `product-launch` | Confidentiality around an unreleased product or commercial announcement |
| `investment-fundraising` | Confidentiality in the context of due diligence or investor negotiations |
| `services-delivery` | MSA/SOW confidentiality in a service delivery context |
| `employment` | Employment or contractor context |
| `general` | Default — no specific context bias |

These are recommendations — in `open` governance mode, the agent can use any `context` value.

---

### Obligation

A specific duty created by a clause and owed by one or more parties. One clause may create multiple distinct obligations — model each separately.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `description` | string | yes | Clear statement of what must be done or not done |
| `obligationType` | string | yes | See recommended values below |
| `status` | string | yes | `active`, `fulfilled`, `waived`, `breached`, `suspended` |
| `deadline` | string | no | ISO 8601 date — when the obligation must be fulfilled (if time-bound) |
| `recurring` | string | no | Recurrence pattern if ongoing (e.g. "annual", "on-demand", "continuous") |
| `conditionPrecedent` | string | no | Plain-language condition that must be met before this obligation applies |
| `survivesTermination` | boolean | no | `true` if this obligation continues to bind the party after the agreement ends |
| `survivalPeriodYears` | number | no | Number of years the obligation survives termination (omit if indefinite) |
| `obligationScope` | string | no | Role-scoped obligation for templates where no specific party exists yet — see recommended values below. Used in place of `BOUND_BY` for template obligations. Substituted with real party bindings when a contract is generated from the template |

**Label convention:** A concise imperative statement (e.g. "Receiving party must not disclose Confidential Information to third parties").

**Summary convention:** The obligation in natural language with context, e.g. "Beta Ltd must not share any Confidential Information received from Acme Corp with third parties without prior written consent, for the duration of the agreement and 2 years thereafter."

**Recommended `obligationType` values:**

| Value | Description |
|-------|-------------|
| `non-disclosure` | Must not reveal information |
| `non-use` | Must not use information for purposes other than the permitted purpose |
| `protection` | Must protect information with a defined standard of care |
| `notification` | Must notify the other party of a specified event |
| `return-destroy` | Must return or destroy materials on termination |
| `compliance` | Must comply with a law, regulation, or standard |
| `payment` | Must make a payment |
| `performance` | Must deliver a service or produce a deliverable |
| `restriction` | General restriction on action |
| `record-keeping` | Must maintain records |

**Recommended `obligationScope` values:**

| Value | Description |
|-------|-------------|
| `receiving-party` | Obligation falls on whoever receives information |
| `disclosing-party` | Obligation falls on whoever discloses |
| `service-provider` | Obligation falls on the contractor or supplier |
| `client` | Obligation falls on the client |
| `both-parties` | Mutual obligation |

This property bridges templates and contracts. Templates have no named parties, so obligations cannot use `BOUND_BY` relationships. Instead, tag template obligations with `obligationScope`. When the generation agent creates a real contract from the template, it substitutes the role scope with a `BOUND_BY` edge to the actual party entity.

---

### Right

A specific entitlement granted by a clause to one or more parties. Model each entitlement separately.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `description` | string | yes | Clear statement of what the party is entitled to do or receive |
| `rightType` | string | yes | See recommended values below |
| `status` | string | yes | `active`, `exercised`, `waived`, `expired` |
| `expiryDate` | string | no | ISO 8601 date — when this right lapses |
| `conditionPrecedent` | string | no | Plain-language condition that must be met before this right may be exercised |

**Label convention:** A concise statement of the entitlement (e.g. "Disclosing party may seek injunctive relief").

**Summary convention:** The right in natural language with context, e.g. "Acme Corp is entitled to seek injunctive relief in any competent court in the event of a breach or threatened breach of the confidentiality obligations by Beta Ltd."

**Recommended `rightType` values:**

| Value | Description |
|-------|-------------|
| `termination` | Right to end the agreement |
| `audit` | Right to inspect records or systems |
| `injunctive-relief` | Right to seek equitable remedy |
| `approval` | Right to approve or withhold consent |
| `use` | Right to use information or materials |
| `access` | Right to access systems, premises, or information |
| `assignment` | Right to transfer the agreement to a third party |
| `disclosure` | Right to disclose information in specified circumstances |
| `compensation` | Right to receive payment or damages |
| `renewal` | Right to extend the agreement |

---

### Warranty

A representation or warranty made by a party — a statement that a given fact is currently true. Warranties are materially different from obligations: an obligation says "you must do X", a warranty says "you warrant that X is true now." Breach of a warranty typically gives rise to a claim for damages or rescission. Model each distinct warranty statement as a separate entity.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `statement` | string | yes | The warranty statement in plain language (e.g. "Party has full authority to enter into this agreement") |
| `warrantyType` | string | yes | See recommended values below |
| `status` | string | yes | `given` (in force), `breached`, `waived`, `expired` |
| `madeDate` | string | no | ISO 8601 date — when the warranty was given (usually the execution date) |
| `repeatedOn` | string | no | ISO 8601 date — if the warranty is repeated at a later date (e.g. on drawdown) |

**Label convention:** A concise statement of the warranty (e.g. "Has authority to enter into this agreement").

**Summary convention:** The warranty in natural language with party context, e.g. "Acme Corp warrants that it has the full corporate authority to enter into this agreement and that doing so does not violate any existing obligation."

**Recommended `warrantyType` values:**

| Value | Description |
|-------|-------------|
| `authority` | Party has legal capacity and authority to enter the agreement |
| `no-conflict` | Entering the agreement does not violate any existing obligation or law |
| `ownership` | Party owns or has rights to the IP or information being disclosed |
| `accuracy` | Information provided is accurate and complete |
| `compliance` | Party is and will remain compliant with applicable laws |
| `solvency` | Party is solvent and not subject to insolvency proceedings |
| `no-litigation` | No pending or threatened litigation that would affect the agreement |

---

### Definition

A defined term within the contract — a word or phrase given a specific contractual meaning. Capturing definitions as entities makes it possible to trace where each defined term is used.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `term` | string | yes | The defined word or phrase exactly as it appears in the contract (e.g. "Confidential Information") |
| `definitionText` | string | yes | The full contractual definition |
| `sectionReference` | string | no | Where the definition appears in the document |

**Label convention:** The defined term as it appears in the contract (e.g. "Confidential Information").

**Summary convention:** A paraphrase, e.g. "Confidential Information means all non-public technical, commercial, and financial information disclosed by one party to the other in connection with the Permitted Purpose."

---

### Jurisdiction

A legal jurisdiction — used to record governing law and the courts or forums with authority over disputes.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | string | yes | Common name (e.g. "England and Wales", "New York, USA", "Singapore") |
| `country` | string | no | ISO 3166-1 country code or full country name |
| `region` | string | no | State, province, or territory where relevant |
| `legalSystem` | string | no | `common-law`, `civil-law`, `mixed` |

**Label convention:** The jurisdiction name (e.g. "England and Wales").

---

### Template

A standard contract template or precedent document. Used to represent the expected shape of an agreement type, enabling gap analysis when a specific contract is compared against it.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | string | yes | Template name (e.g. "Standard Mutual NDA v2") |
| `contractType` | string | yes | The agreement type this template produces — use the same values as `Contract.contractType` |
| `version` | string | no | Version identifier (e.g. "2.1", "2024-Q1") |
| `source` | string | no | Origin of the template (e.g. "internal legal", "BVCA", "NVCA", "Law Society") |
| `description` | string | no | Plain-language description of what this template covers |

**Label convention:** `{name}` (e.g. "Standard Mutual NDA v2").

---

## Relationship Types

### Contract Relationships

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| `HAS_PARTY` | A party is signatory to or named in this contract | Contract → Party | no |
| `CONTAINS_CLAUSE` | A clause is part of this contract or template | Contract/Template → Clause | no |
| `GOVERNED_BY` | This contract is subject to this jurisdiction | Contract → Jurisdiction | no |
| `DERIVED_FROM` | This contract was created from this template | Contract → Template | no |
| `AMENDS` | This contract modifies a prior contract | Contract → Contract | no |
| `SUPERSEDES` | This contract replaces a prior contract entirely | Contract → Contract | no |
| `REFERENCES` | This contract references another agreement (e.g. an NDA references a master agreement) | Contract → Contract | no |
| `EXECUTED_UNDER` | This contract is subordinate to and executed under a parent agreement (e.g. an SOW under an MSA, or an NDA entered in connection with a master agreement) | Contract → Contract | no |

#### Properties for `HAS_PARTY`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `role` | string | yes | The party's role — see recommended values below |
| `signedDate` | string | no | ISO 8601 date — when this party signed |
| `signatoryName` | string | no | Full name of the individual who signed on behalf of the party |
| `signatoryTitle` | string | no | Title of the signatory (e.g. "Chief Executive Officer") |

**Recommended `role` values:**

| Value | Description |
|-------|-------------|
| `disclosing-party` | The party sharing Confidential Information (NDA) |
| `receiving-party` | The party receiving Confidential Information (NDA) |
| `mutual-party` | Both disclosing and receiving (mutual NDA) |
| `service-provider` | The party delivering services (MSA/SOW) |
| `client` | The party receiving services (MSA/SOW) |
| `licensor` | The party granting a license |
| `licensee` | The party receiving a license |
| `employer` | Employing party |
| `employee` | Employed party |

#### Properties for `AMENDS` and `SUPERSEDES`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `effectiveDate` | string | no | ISO 8601 date — when the amendment or supersession takes effect |
| `reason` | string | no | Why the amendment or supersession was made |

---

### Clause Relationships

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| `CREATES_OBLIGATION` | This clause imposes an obligation | Clause → Obligation | no |
| `GRANTS_RIGHT` | This clause grants an entitlement | Clause → Right | no |
| `DEFINES_TERM` | This clause defines a term | Clause → Definition | no |
| `USES_DEFINITION` | This clause uses a defined term | Clause → Definition | no |
| `REFERENCES_CLAUSE` | This clause explicitly cross-references another clause | Clause → Clause | no |
| `CONFLICTS_WITH` | This clause is in tension with another clause | Clause → Clause | yes |
| `SUPERSEDES_CLAUSE` | An amended clause replaces this clause | Clause → Clause | no |

#### Properties for `REFERENCES_CLAUSE`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `nature` | string | no | How they relate (e.g. "conditions", "qualifies", "extends") |

#### Properties for `CONFLICTS_WITH`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `description` | string | no | Plain-language explanation of the conflict |
| `severity` | string | no | `minor` (interpretive tension), `major` (direct contradiction) |

---

### Party Relationships

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| `BOUND_BY` | A party is subject to this obligation | Party → Obligation | no |
| `ENTITLED_TO` | A party holds this right | Party → Right | no |
| `RELATED_PARTY` | Two parties have a corporate relationship relevant to this contract | Party → Party | yes |

#### Properties for `BOUND_BY`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `scope` | string | no | Any limitation on when or how this obligation applies |

#### Properties for `RELATED_PARTY`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `relation` | string | no | e.g. `parent`, `subsidiary`, `affiliate`, `group-company` |

---

### Obligation Relationships

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| `TRIGGERED_BY` | This obligation becomes active when another obligation or event occurs | Obligation → Obligation | no |
| `CONFLICTS_WITH` | This obligation is in direct tension with another | Obligation → Obligation | yes |

#### Properties for `TRIGGERED_BY`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `condition` | string | no | Plain-language description of the trigger condition |

---

### Warranty Relationships

| Type | Description | Source → Target | Bidirectional |
|------|-------------|-----------------|---------------|
| `MAKES_WARRANTY` | This clause creates a warranty | Clause → Warranty | no |
| `WARRANTS` | A party gives this warranty | Party → Warranty | no |

---

## Design Notes

- **Parties are shared across contracts.** If the same organization appears in multiple agreements, use one `Party` entity and link it to all relevant contracts. This enables queries like "show me all contracts to which Acme Corp is a party."
- **One obligation per entity.** A confidentiality clause typically creates several obligations: don't disclose, don't use for other purposes, protect with appropriate care. Model each as a separate `Obligation` entity — don't combine them.
- **CONFLICTS_WITH is bidirectional.** Create it once in either direction. The graph engine traverses it both ways automatically.
- **Validation is graph completeness.** A valid NDA should have: at least two parties (`HAS_PARTY`), a confidentiality clause, a governing law clause, a term clause, and all parties bound by at least one obligation (`BOUND_BY`). Run these as graph queries, not document scans.
- **Template gap analysis.** To find what a contract is missing, query for clauses in the template (via `DERIVED_FROM` → template's `CONTAINS_CLAUSE`) that have no corresponding `clauseType` in the target contract.
- **Relationship types are normalized** to `SCREAMING_SNAKE_CASE` by the core library.
- **Definitions are reused across clauses.** If five clauses all reference "Confidential Information", all five should have a `USES_DEFINITION` relationship to the single `Definition` entity for that term.
- **Warranties are not obligations.** A warranty is a statement of present fact; an obligation is a duty to act. Model them separately. A `representations-warranties` clause will typically generate both `Warranty` entities (via `MAKES_WARRANTY`) and `Obligation` entities (via `CREATES_OBLIGATION`) — the representations are warranties, the ongoing duties are obligations.
- **`survivesTermination` enables post-termination validation.** When validating an NDA, query for obligations with `survivesTermination: true` to confirm that confidentiality and return/destroy obligations are explicitly marked as surviving. An obligation without this flag set is assumed to expire with the agreement.
- **`EXECUTED_UNDER` vs `REFERENCES`.** Use `EXECUTED_UNDER` when one contract is formally subordinate to another (e.g. an SOW under an MSA — the SOW's terms are governed by the MSA). Use `REFERENCES` when a contract merely mentions another document without that subordination relationship.
- **Party identity properties.** `leiCode` is the authoritative global identifier for legal entities — use it when available to guarantee deduplication across contracts. `vatID` and `taxID` are useful for EU and cross-border agreements where tax identity is relevant to the contract.
- **This vocabulary is extensible.** In `open` governance mode, common extensions include `REQUIRES_CONSENT` (obligation requiring party approval), `CARVES_OUT` (obligation that creates an exception to another), and `NOTIFIES` (obligation to inform a specific party).
