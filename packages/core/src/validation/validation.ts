// Property and input validation utilities

import type { PropertySchema } from '../types/vocabulary.js';
import { validatePropertyValue, type ValidationResult } from '../vocabulary/VocabularyValidator.js';

/**
 * Validate a set of property values against their schemas.
 * This is a convenience wrapper for bulk property validation.
 */
export function validateProperties(
  properties: Record<string, unknown>,
  schemas: PropertySchema[],
): ValidationResult {
  const errors: ValidationResult['errors'] = [];

  for (const schema of schemas) {
    const value = properties[schema.name];
    const result = validatePropertyValue(schema.name, value, schema);
    if (!result.valid) {
      errors.push(...result.errors);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Apply default values from property schemas to a properties object.
 * Returns a new object with defaults filled in for missing properties.
 */
export function applyPropertyDefaults(
  properties: Record<string, unknown>,
  schemas: PropertySchema[],
): Record<string, unknown> {
  const result = { ...properties };

  for (const schema of schemas) {
    if (result[schema.name] === undefined && schema.defaultValue !== undefined) {
      result[schema.name] = schema.defaultValue;
    }
  }

  return result;
}
