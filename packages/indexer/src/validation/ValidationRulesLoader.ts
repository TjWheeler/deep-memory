import { readFile } from 'node:fs/promises';
import type { ValidationRules } from '../types/validation.js';

/**
 * Loads and validates a validation-rules.json file from a starter kit.
 */
export class ValidationRulesLoader {
  /**
   * Load validation rules from a JSON file path.
   * Throws if the file is missing, malformed, or structurally invalid.
   */
  static async load(rulesPath: string): Promise<ValidationRules> {
    let content: string;
    try {
      content = await readFile(rulesPath, 'utf-8');
    } catch (error) {
      throw new Error(
        `Failed to read validation rules from ${rulesPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new Error(
        `Validation rules file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return ValidationRulesLoader.validate(parsed);
  }

  /**
   * Validate that a parsed object conforms to the ValidationRules schema.
   */
  static validate(value: unknown): ValidationRules {
    if (typeof value !== 'object' || value === null) {
      throw new Error('Validation rules must be a JSON object');
    }

    const obj = value as Record<string, unknown>;

    if (typeof obj['version'] !== 'string') {
      throw new Error('Validation rules must have a "version" string');
    }
    if (typeof obj['domain'] !== 'string') {
      throw new Error('Validation rules must have a "domain" string');
    }
    if (typeof obj['propertyRanges'] !== 'object' || obj['propertyRanges'] === null) {
      throw new Error('Validation rules must have a "propertyRanges" object');
    }
    if (typeof obj['relationshipRanges'] !== 'object' || obj['relationshipRanges'] === null) {
      throw new Error('Validation rules must have a "relationshipRanges" object');
    }
    if (typeof obj['structuralRules'] !== 'object' || obj['structuralRules'] === null) {
      throw new Error('Validation rules must have a "structuralRules" object');
    }

    return value as ValidationRules;
  }
}
