import { describe, it, expect } from 'vitest';
import { PromptBuilder } from './PromptBuilder.js';

const VOCABULARY = '### Entity: Widget\nA test entity type.';

describe('PromptBuilder', () => {
  describe('buildSystemPrompt', () => {
    it('injects the vocabulary under a Vocabulary section', () => {
      const prompt = new PromptBuilder(VOCABULARY).buildSystemPrompt();
      expect(prompt).toContain('## Vocabulary');
      expect(prompt).toContain(VOCABULARY);
    });

    it('preserves the JSON output format section', () => {
      const prompt = new PromptBuilder(VOCABULARY).buildSystemPrompt();
      expect(prompt).toContain('## Output Format');
      expect(prompt).toContain('"entities"');
      expect(prompt).toContain('"relationships"');
    });

    it('keeps the rule to only extract explicitly-stated values', () => {
      const prompt = new PromptBuilder(VOCABULARY).buildSystemPrompt();
      expect(prompt).toContain('ONLY extract values explicitly stated in the source document');
    });

    it('states that an open-enum list is a naming vocabulary, not a checklist of entities', () => {
      const prompt = new PromptBuilder(VOCABULARY).buildSystemPrompt();
      expect(prompt).toContain('naming vocabulary, not a checklist');
      expect(prompt).toContain('Do NOT create one entity per listed value');
    });

    it('states that a cross-reference or deferral is not a property value', () => {
      const prompt = new PromptBuilder(VOCABULARY).buildSystemPrompt();
      expect(prompt).toContain('A cross-reference or deferral is not a property value');
      expect(prompt).toContain('Refer to Clause 3.3.6');
      expect(prompt).toContain('model the referenced material as its own entity');
    });

    it('appends the domain guidance section when provided', () => {
      const prompt = new PromptBuilder(VOCABULARY, undefined, 'Domain-specific note.').buildSystemPrompt();
      expect(prompt).toContain('## Domain Guidance');
      expect(prompt).toContain('Domain-specific note.');
    });

    it('appends the extraction rules section when provided', () => {
      const prompt = new PromptBuilder(VOCABULARY, 'Rule-specific note.').buildSystemPrompt();
      expect(prompt).toContain('## Extraction Rules');
      expect(prompt).toContain('Rule-specific note.');
    });

    it('omits optional sections when not provided', () => {
      const prompt = new PromptBuilder(VOCABULARY).buildSystemPrompt();
      expect(prompt).not.toContain('## Domain Guidance');
      expect(prompt).not.toContain('## Extraction Rules');
    });
  });
});
