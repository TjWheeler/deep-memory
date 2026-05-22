# Legal Domain — Domain Guidance

This document provides domain-specific knowledge for AI agents extracting entities and relationships from legal agreements. It supplements the vocabulary (what to extract) and the index process (how to extract) with knowledge about contract conventions, clause interpretation, and common extraction errors.

This guidance is injected into the extraction prompt alongside the vocabulary. Follow it when making labeling, grouping, and relationship decisions.

---

## Identity Pattern

This domain does **not** use Identity entities. Contracts are identified by their title and party names. Clauses are identified by section numbers. Obligations and rights are labelled with specific duty descriptions. No entity type in this vocabulary has a real-world ambiguity problem where distinct instances share the same label. See `docs/identity-pattern.md` for when identity is needed.

---

## MANDATORY Extraction Checklist

You MUST follow this checklist for every document. Do NOT skip steps. Incomplete extraction is a failure.

### Step 1: Extract ALL Clauses
Read every section heading and paragraph. Create a separate Clause entity for EACH distinct clause type. If a section covers multiple topics (e.g. "Term, Termination and Obligations on Termination"), split it into separate Clause entities — one per clause type.

### Step 2: Extract ALL Definitions
Create a Definition entity for EVERY defined term in the contract. Defined terms are typically capitalized (e.g. "Confidential Information", "Permitted Purpose", "Representatives"). Check both definition sections AND inline definitions within clauses.

### Step 3: Extract ALL Obligations — Decompose Aggressively
This is the most important step. Read every clause and extract EVERY distinct duty it creates. A single clause often creates 2-5 separate obligations. You MUST create a separate Obligation entity for each one.

**Decomposition signals — each of these creates a SEPARATE Obligation:**
- "shall not disclose" → one Obligation (non-disclosure)
- "shall not use" → one Obligation (non-use)
- "shall protect with reasonable care" → one Obligation (protection)
- "shall promptly notify" → one Obligation (notification)
- "shall return or destroy" → one Obligation (return-destroy)
- "shall certify in writing" → one Obligation (compliance)
- "shall indemnify" → one Obligation (indemnification)
- "shall maintain records" → one Obligation (record-keeping)
- "shall comply with applicable laws" → one Obligation (compliance)
- "shall not assign without consent" → one Obligation (restriction)
- "shall keep confidential for X years after termination" → one Obligation with survivesTermination: true

**Watch for these patterns that ALWAYS create obligations:**
- "shall", "shall not", "must", "must not", "agrees to", "undertakes to", "covenants to"
- "is responsible for", "will ensure", "will procure"
- Indemnification clauses ("shall indemnify and hold harmless")
- Payment terms ("shall pay within X days")
- Insurance requirements ("shall maintain insurance")
- Compliance requirements ("shall comply with")

### Step 4: Extract ALL Rights
Create a Right entity for every entitlement granted. Look for: "may", "is entitled to", "has the right to", "reserves the right to", "shall be entitled to".

### Step 5: Extract ALL Warranties
Create a Warranty entity for every representation or warranty. Look for: "represents and warrants", "warrants that", "represents that", "acknowledges that". Each distinct warranty statement is a SEPARATE entity.

### Step 6: Create ALL Relationships — This Is Critical
After extracting entities, you MUST create these relationships:

1. **For EVERY Obligation:** Create a `BOUND_BY` relationship from each Party who owes that duty. In a mutual agreement where "each party" is bound, create a BOUND_BY from EACH party to the obligation.
2. **For EVERY Right:** Create an `ENTITLED_TO` relationship from each Party who holds that right.
3. **For EVERY Warranty:** Create a `WARRANTS` relationship from the Party who gives the warranty. Create a `MAKES_WARRANTY` from the Clause that contains it.
4. **For EVERY Obligation and Right:** Create a `CREATES_OBLIGATION` or `GRANTS_RIGHT` from the Clause that creates it.
5. **For EVERY Clause:** Create a `CONTAINS_CLAUSE` from the Contract or Template.
6. **For EVERY defined term used in a clause:** Create a `USES_DEFINITION` from the Clause to the Definition. Scan EVERY clause for references to defined terms.
7. **For EVERY Party:** Create a `HAS_PARTY` from the Contract.

### Step 7: Verify Completeness
Before finishing, verify:
- Every Obligation has at least one BOUND_BY from a Party
- Every Right has at least one ENTITLED_TO from a Party
- Every Warranty has a WARRANTS from a Party and MAKES_WARRANTY from a Clause
- Every Clause has a CONTAINS_CLAUSE from the Contract
- Key defined terms (especially "Confidential Information") have USES_DEFINITION from every clause that references them

---

## Entity Naming Rules

These rules produce consistent, canonical labels that prevent duplicate entities and orphan relationships across contracts.

### Contract Labels

**Format:** `{contractType}: {party names}` or the document's own title if one is stated.

| Correct | Incorrect |
|---------|-----------|
| `MNDA: Acme Corp / Beta Ltd` | `NDA` (too generic) |
| `MSA: Acme Corp / Gamma Services` | `Master Service Agreement` (no parties) |
| `Mutual Non-Disclosure Agreement between Acme Corp Ltd and Beta Technologies GmbH` | `Contract 1` |

If the document states a formal title (e.g. "Mutual Non-Disclosure Agreement between..."), use it as the label. Otherwise construct from `contractType` and party names.

### Party Labels

**Format:** The party's full legal name exactly as it appears in the contract.

| Correct | Incorrect |
|---------|-----------|
| `Acme Corp Ltd` | `Acme` |
| `Beta Technologies GmbH` | `Beta Technologies` (missing legal suffix) |
| `John A. Smith` | `Mr. Smith` |

**Use the name from the contract, not your knowledge of the company.** If the contract says "Acme Corp Limited" but you know the company recently rebranded to "Acme Inc.", use what the contract says. The contract is the authoritative source.

**Legal entity suffixes matter.** `Ltd`, `LLC`, `GmbH`, `Inc.`, `Pty Ltd` are part of the legal name. Include them.

### Clause Labels

**Format:** `{clauseType}` optionally qualified with section reference.

| Correct | Incorrect |
|---------|-----------|
| `Confidentiality — Section 3` | `Section 3` (no type) |
| `Governing Law` | `Clause 10: Governing Law and Jurisdiction` (too verbose) |
| `Confidentiality Exclusions — Section 4` | `Exceptions` (too vague) |

**Keep labels short and type-driven.** The `clauseType` property carries the structured classification; the label is for human scanning.

### Obligation Labels

**Format:** A concise imperative statement.

| Correct | Incorrect |
|---------|-----------|
| `Receiving party must not disclose Confidential Information to third parties` | `Non-disclosure obligation` |
| `Must return or destroy all materials within 10 business days of termination` | `Return materials` |
| `Must notify Disclosing Party within 5 days of a compelled disclosure` | `Notification duty` |

**Include the actor, the action, and key constraints.** The label should be specific enough to distinguish this obligation from others in the same contract.

### Definition Labels

**Format:** The defined term exactly as capitalized in the contract.

| Correct | Incorrect |
|---------|-----------|
| `Confidential Information` | `confidential information` |
| `Permitted Purpose` | `permitted purpose` |
| `Representatives` | `Reps` |

**Preserve the contract's capitalization.** Defined terms are typically capitalized in legal documents — this capitalization is part of their identity.

---

## Relationship Referencing Rules

**Every `sourceLabel` and `targetLabel` in a relationship MUST exactly match the `label` of an entity you have created.** This is the single most important rule for preventing orphan relationships.

When creating a relationship:
1. Check the entity label you assigned earlier in this extraction
2. Use that exact label in `sourceLabel` or `targetLabel`
3. Do NOT abbreviate party names or paraphrase clause labels

Example — if you created a Party with label `Acme Corp Ltd`:
- Relationship sourceLabel: `Acme Corp Ltd` (correct)
- Relationship sourceLabel: `Acme Corp` (WRONG — creates orphan)
- Relationship sourceLabel: `Acme` (WRONG — creates orphan)

---

## Contract Structure Patterns

Understanding how contracts are structured helps you extract accurately.

### Standard NDA Structure

A typical NDA or MNDA follows this pattern:

1. **Recitals** ("Whereas" clauses) — background and context
2. **Definitions** — defined terms (Confidential Information, Permitted Purpose, etc.)
3. **Confidentiality obligation** — the core duty
4. **Exclusions** — what is NOT Confidential Information
5. **Permitted Purpose** — restrictions on use
6. **Term and termination** — duration, renewal, termination rights
7. **Obligations on termination** — return/destroy duties
8. **Remedies** — injunctive relief, damages
9. **General provisions** — governing law, dispute resolution, entire agreement, severability, notice, waiver, amendment
10. **Signature blocks** — execution details

Not every NDA follows this exact order, but these clause types should be present. If one is missing, flag it during validation.

### Mutual vs Unilateral NDAs

| Feature | Mutual NDA (MNDA) | Unilateral NDA |
|---------|-------------------|----------------|
| `contractType` | `MNDA` | `NDA` |
| Party roles | Both parties are `mutual-party` | One is `disclosing-party`, one is `receiving-party` |
| Obligations | Reciprocal — both parties owe the same duties | One-directional — only the receiving party is bound |
| `BOUND_BY` | Both parties linked to each obligation | Only the receiving party linked |

**Common mistake:** Indexing a mutual NDA as if it were unilateral. If the agreement says "each party" or "the parties" when describing obligations, both parties must be linked via `BOUND_BY`.

### MSA + SOW Hierarchies

Master Service Agreements (MSAs) and Statements of Work (SOWs) form a parent-child pattern:

- The SOW is `EXECUTED_UNDER` the MSA
- The MSA's general terms govern unless the SOW explicitly overrides
- If the SOW contradicts the MSA, create `CONFLICTS_WITH` between the conflicting clauses

Do NOT use `REFERENCES` for this relationship — `EXECUTED_UNDER` signals formal subordination.

---

## Obligation and Right Extraction

This is the most error-prone part of contract extraction. Follow these rules carefully.

### One Duty Per Obligation Entity

A single contract clause often creates multiple distinct obligations. Always decompose:

| Clause Text | Obligations to Create |
|-------------|----------------------|
| "The Receiving Party shall not disclose Confidential Information to any third party and shall protect it with at least the same degree of care as its own confidential information" | 1. Non-disclosure obligation; 2. Protection obligation |
| "Upon termination, the Receiving Party shall promptly return or destroy all Confidential Information and certify in writing that it has done so" | 1. Return/destroy obligation; 2. Certification obligation |

### Survival Analysis

Pay special attention to which obligations survive termination:

- Confidentiality obligations almost always survive (typically 2-5 years)
- Return/destroy obligations are triggered by termination but may not "survive" in the traditional sense — they are obligations *on* termination
- General provisions (governing law, dispute resolution) typically survive

**Set `survivesTermination: true` explicitly** for obligations that continue after the agreement ends. Set `survivalPeriodYears` when a specific period is stated.

### Obligation Scope for Templates

Templates have no named parties. Use `obligationScope` instead of `BOUND_BY`:

| Template Says | `obligationScope` |
|--------------|-------------------|
| "The Receiving Party shall..." | `receiving-party` |
| "The Disclosing Party shall..." | `disclosing-party` |
| "Each party shall..." | `both-parties` |
| "The Service Provider shall..." | `service-provider` |

When a concrete contract is generated from the template, the generation agent substitutes `obligationScope` with actual `BOUND_BY` relationships to Party entities.

---

## Definition Extraction

### Inline vs Section Definitions

Contracts define terms in two ways:
1. **Definition section** — a dedicated clause listing all defined terms
2. **Inline definitions** — terms defined parenthetically within other clauses (e.g. "the Purpose (as defined in clause 2)")

**Capture both.** Create a `Definition` entity for each, regardless of where it appears. Link inline definitions to the clause where they appear via `DEFINES_TERM`.

### Definition Scope

The scope of a definition is often the most important part of a contract. Pay special attention to:

| Term | What to Watch For |
|------|-------------------|
| `Confidential Information` | Inclusions AND exclusions — what is carved out |
| `Permitted Purpose` | How narrowly the purpose is defined |
| `Representatives` | Whether it includes subsidiaries, affiliates, advisors |
| `Affiliate` | Whether control thresholds are specified |

Capture the complete definition text — don't summarize away the carve-outs or qualifications.

### USES_DEFINITION Coverage

For key defined terms (especially "Confidential Information"), scan every clause for usage and create `USES_DEFINITION` relationships. This enables queries like "show me every clause that references Confidential Information."

---

## Anti-Hallucination Rules

Legal extraction errors can have serious consequences. These rules prevent the most dangerous mistakes.

### Rule 1: Extract what the contract says, not what you think it should say

Do NOT fill in "standard" provisions that aren't in the document:

| Property | Hallucination Example | Why It's Dangerous |
|----------|-----------------------|-------------------|
| `noticePeriodDays` | Inserting "30 days" because that's standard | The actual contract may specify 10 days or no notice period |
| `survivalPeriodYears` | Inserting "2 years" for confidentiality | The contract may specify 5 years or indefinite survival |
| `expiryDate` | Calculating from "two years from the Effective Date" when the Effective Date is ambiguous | The calculated date may be wrong |

**Test:** For every property value, ask: "Can I point to the exact text in the contract that states this?" If no, omit the property.

### Rule 2: Don't infer party roles from names

| Contract Says | Correct | Wrong |
|---------------|---------|-------|
| "Acme Corp (the 'Disclosing Party')" | role: `disclosing-party` | — |
| No role labels defined | role based on context of obligations | Guessing who discloses based on company type |

If the contract defines party roles explicitly, use those. If it doesn't (common in mutual NDAs where both parties are equivalent), use `mutual-party`.

### Rule 3: Don't merge distinct obligations

If a clause creates multiple duties, ALWAYS create separate Obligation entities even if they seem related. The graph structure should reflect the contract structure, not a summary of it.

### Rule 4: Don't assume reciprocity

In a mutual NDA, most obligations ARE reciprocal — but not all. Read the specific language:

| Clause Says | Both Parties Bound? |
|-------------|-------------------|
| "Each party shall..." | Yes |
| "The parties agree to..." | Yes |
| "The Receiving Party shall..." (in MNDA where both receive) | Yes — both parties take the receiving role |
| "Company A shall indemnify Company B..." | No — only Company A is bound |

---

## Common Extraction Pitfalls

### 1. Conflating clause types

| Source Text | Wrong | Right |
|-------------|-------|-------|
| "Section 3: Confidentiality and Use Restrictions" | One clause with type `confidentiality` | Two clauses: `confidentiality` and `permitted-purpose` |
| "Section 7: Term, Termination and Obligations on Termination" | One clause with type `term` | Three clauses: `term`, `termination`, `obligations-on-termination` |

**One clause type per entity.** Split compound sections into their constituent clause types.

### 2. Missing BOUND_BY relationships

Every `Obligation` must have at least one `BOUND_BY` from a Party. The most common validation failure is obligations that exist in the graph but aren't linked to anyone.

**After creating all obligations, verify:** For each Party, traverse its `BOUND_BY` relationships. Every party should have at least one obligation.

### 3. Jurisdiction confusion

The governing law jurisdiction and the dispute resolution forum may be different:

| Contract Says | Entities to Create |
|---------------|-------------------|
| "Governed by English law, disputes resolved in London courts" | One Jurisdiction: "England and Wales" |
| "Governed by English law, disputes resolved by Singapore arbitration" | Two Jurisdictions: "England and Wales" (governing law) and "Singapore" (arbitration forum) |

### 4. Template vs contract confusion

When indexing a template (not a concrete contract):
- `Party` entities should NOT be created (templates have role-scoped obligations, not party-bound ones)
- Use `obligationScope` on Obligations instead of `BOUND_BY`
- The `Contract` entity should be a `Template` entity instead
- Clauses still use `CONTAINS_CLAUSE`

### 5. Cross-reference completeness

Contracts are full of internal cross-references ("subject to clause 4", "as defined in clause 2"). These are easy to miss but critical for graph completeness.

**Systematic approach:** After creating all clauses, re-read each clause looking specifically for:
- "Subject to..."
- "As defined in..."
- "In accordance with..."
- "Without prejudice to..."
- "Notwithstanding..."

Each of these typically signals a `REFERENCES_CLAUSE` or `USES_DEFINITION` relationship.

---

## Legal Terminology Reference

Key terms that help with accurate extraction:

| Term | Meaning | Extraction Impact |
|------|---------|-------------------|
| **Recitals** | "Whereas" clauses — background context | Clause entity with type `recitals` |
| **Boilerplate** | Standard general provisions | Still needs extraction — `entire-agreement`, `severability`, `waiver`, etc. |
| **Carve-out** | Exception to a broader provision | Often a separate clause (`confidentiality-exclusions`) |
| **Survival clause** | Provisions that continue after termination | Set `survivesTermination: true` on affected Obligations |
| **Representation** | Statement of present fact | `Warranty` entity (not `Obligation`) |
| **Warranty** | Promise that a fact is true | `Warranty` entity |
| **Covenant** | Promise to do or not do something | `Obligation` entity |
| **Indemnity** | Promise to compensate for loss | `Obligation` with type `indemnification` |
| **Condition precedent** | Event that must occur before an obligation or right becomes effective | `conditionPrecedent` property |
| **Force majeure** | Unforeseeable circumstances excusing performance | Clause entity, may create `Right` to suspend |
| **Severability** | If one clause is invalid, the rest survives | Clause entity with type `severability` |
| **Entire agreement** | This document is the complete agreement, superseding prior negotiations | Clause entity with type `entire-agreement` |
| **Without prejudice** | Statement that cannot be used as evidence in court | Context for relationships, not a separate entity |
