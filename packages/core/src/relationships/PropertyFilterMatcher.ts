// PropertyFilterMatcher — evaluates property filters against relationship properties

import type { PropertyFilter } from '../types/queries.js';

/**
 * Evaluate whether a set of properties matches all given filters.
 * All filters are AND'd — every filter must match for the result to be true.
 */
export function matchesPropertyFilters(
  properties: Record<string, unknown>,
  filters: PropertyFilter[],
): boolean {
  return filters.every((filter) => matchesSingleFilter(properties, filter));
}

function matchesSingleFilter(
  properties: Record<string, unknown>,
  filter: PropertyFilter,
): boolean {
  const value = properties[filter.key];

  switch (filter.operator) {
    case 'isNull':
      return value === null || value === undefined;

    case 'isNotNull':
      return value !== null && value !== undefined;

    case 'eq':
      return value === filter.value;

    case 'neq':
      return value !== filter.value;

    case 'gt':
      return typeof value === 'number' && typeof filter.value === 'number'
        ? value > filter.value
        : typeof value === 'string' && typeof filter.value === 'string'
          ? value > filter.value
          : false;

    case 'lt':
      return typeof value === 'number' && typeof filter.value === 'number'
        ? value < filter.value
        : typeof value === 'string' && typeof filter.value === 'string'
          ? value < filter.value
          : false;

    case 'gte':
      return typeof value === 'number' && typeof filter.value === 'number'
        ? value >= filter.value
        : typeof value === 'string' && typeof filter.value === 'string'
          ? value >= filter.value
          : false;

    case 'lte':
      return typeof value === 'number' && typeof filter.value === 'number'
        ? value <= filter.value
        : typeof value === 'string' && typeof filter.value === 'string'
          ? value <= filter.value
          : false;

    case 'contains':
      return typeof value === 'string' && typeof filter.value === 'string'
        ? value.toLowerCase().includes(filter.value.toLowerCase())
        : false;

    default:
      return false;
  }
}
