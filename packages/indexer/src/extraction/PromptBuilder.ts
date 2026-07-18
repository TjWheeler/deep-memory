import type { DocumentOverview } from './ChapterSplitter.js';
import type { IndexSource } from '../types/source-list.js';

/**
 * Builds extraction prompts from vocabulary, rules, and document content.
 *
 * The prompt instructs the LLM to extract entities and relationships from a
 * source document following the vocabulary conventions and extraction rules.
 * Output is structured JSON matching the ExtractionOutput format.
 */
export class PromptBuilder {
  constructor(
    private readonly vocabulary: string,
    private readonly extractionRules?: string,
    private readonly domainGuidance?: string,
  ) {}

  /**
   * Build the system prompt for extraction.
   * This is constant across all documents — it defines the task and output format.
   */
  public buildSystemPrompt(): string {
    let prompt = `You are a precise data extraction agent. Your task is to extract structured entities and relationships from technical documents.

## Output Format

You MUST respond with valid JSON matching this exact structure:

\`\`\`json
{
  "entities": [
    {
      "entityType": "string (from vocabulary)",
      "label": "string (canonical name)",
      "summary": "string (1-2 sentence description)",
      "properties": { "key": "value" },
      "aliases": ["alternative name 1", "alternative name 2"],
      "sourceRefs": [
        { "description": "what this section contains", "lineStart": 100, "lineEnd": 115 }
      ]
    }
  ],
  "relationships": [
    {
      "type": "string (from vocabulary)",
      "sourceLabel": "string (entity label)",
      "targetLabel": "string (entity label)",
      "properties": { "key": "value" },
      "sourceRefs": [
        { "description": "what this section contains", "lineStart": 200, "lineEnd": 210 }
      ]
    }
  ]
}
\`\`\`

## Rules

1. Only use entity types and relationship types defined in the vocabulary below.
2. Follow the naming conventions specified in the vocabulary.
3. Include sourceRefs for EVERY entity and relationship — these are line numbers in the source document.
4. Properties must match the property schemas defined in the vocabulary.
5. Include all known aliases (alternative names found in the document).
6. **CRITICAL — ONLY extract values explicitly stated in the source document.** Do NOT fill in properties from your general knowledge. If the document does not state a value, OMIT that property entirely. Do not guess weights, materials, pressures, fluid specifications, or any other value. Every property you include must be traceable to a specific line in the source.
7. Do NOT include entities or relationships you are not confident about.
8. When a relationship references an entity not fully described in the document (e.g., a truck model name in a compatibility chart), create a **stub entity** with only the information the source provides. Do not omit the entity.
9. **An enumerated list of recommended or allowed values on an OPEN (free-text) property is a naming vocabulary, not a checklist.** Such a list exists to standardize labels for things the document describes — it is NOT a set of entities to instantiate. Do NOT create one entity per listed value. Create an entity only when the source document actually describes that thing as present, and cite the line(s) that describe it.
10. **A cross-reference or deferral is not a property value.** When a property is a CLOSED enumeration, its value MUST be one of the allowed codes. A cell or field whose content points elsewhere instead of stating a value (e.g. "Refer to Clause 3.3.6", "See Section X", "As per Appendix A") is a deferral, not a value — do NOT force that text into the property. Instead, model the referenced material as its own entity of the appropriate type (for example, a clause/provision-type entity) and relate to it.
11. Respond ONLY with the JSON object — no markdown fences, no explanations.

## Vocabulary

${this.vocabulary}`;

    if (this.domainGuidance) {
      prompt += `

## Domain Guidance

${this.domainGuidance}`;
    }

    if (this.extractionRules) {
      prompt += `

## Extraction Rules

${this.extractionRules}`;
    }

    return prompt;
  }

  /**
   * Build the user prompt for a specific document.
   * Contains the document content with line numbers for sourceRef tracking.
   */
  public buildUserPrompt(source: IndexSource, documentContent: string): string {
    const numberedContent = addLineNumbers(documentContent);
    return `Extract all entities and relationships from the following ${source.type} document.

Document: ${source.path}
${source.notes ? `Notes: ${source.notes}\n` : ''}
--- DOCUMENT START ---
${numberedContent}
--- DOCUMENT END ---

Extract all entities and relationships. Respond with JSON only.`;
  }

  /**
   * Build the user prompt for a document chunk (when the document exceeds context limits).
   */
  public buildChunkPrompt(source: IndexSource, chunk: string, chunkIndex: number, totalChunks: number, lineOffset: number): string {
    return `Extract entities and relationships from chunk ${chunkIndex + 1} of ${totalChunks} of this ${source.type} document.

Document: ${source.path}
Chunk: ${chunkIndex + 1}/${totalChunks} (lines starting at ${lineOffset + 1})
${source.notes ? `Notes: ${source.notes}\n` : ''}
--- CHUNK START ---
${chunk}
--- CHUNK END ---

Extract all entities and relationships from this chunk. Line numbers in sourceRefs should be absolute (as shown). Respond with JSON only.`;
  }
  /**
   * Build the user prompt for a chapter in progressive extraction.
   * Includes a document overview and cumulative context from prior chapters
   * so the model can reference previously extracted entities by their canonical labels.
   */
  public buildChapterPrompt(
    source: IndexSource,
    numberedChapterContent: string,
    chapterIndex: number,
    totalChapters: number,
    overview: DocumentOverview,
    progressiveContext: string,
  ): string {
    let prompt = `Extract entities and relationships from chapter ${chapterIndex + 1} of ${totalChapters} of this ${source.type} document.

## Document Overview
Title: ${overview.title}
${overview.metadata}

### Structure
${overview.headingStructure}
`;

    if (progressiveContext) {
      prompt += `
${progressiveContext}

When you encounter entities already listed above, reference them by their **exact label**.
Do NOT re-extract full details for previously seen entities — only include them if this
chapter adds new properties, relationships, or sourceRefs. If you find new information
about a previously seen entity, use the same label so results can be merged.
`;
    }

    prompt += `
--- CHAPTER START ---
${numberedChapterContent}
--- CHAPTER END ---

Extract all entities and relationships from this chapter. Line numbers in sourceRefs should be absolute (as shown). Respond with JSON only.`;

    return prompt;
  }
}

/** Add line numbers to document content for sourceRef tracking */
function addLineNumbers(content: string): string {
  return content
    .split('\n')
    .map((line, i) => `${i + 1}\t${line}`)
    .join('\n');
}
