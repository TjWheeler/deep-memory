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
  buildSystemPrompt(): string {
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
9. Respond ONLY with the JSON object — no markdown fences, no explanations.

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
  buildUserPrompt(source: IndexSource, documentContent: string): string {
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
  buildChunkPrompt(source: IndexSource, chunk: string, chunkIndex: number, totalChunks: number, lineOffset: number): string {
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
  buildChapterPrompt(
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
