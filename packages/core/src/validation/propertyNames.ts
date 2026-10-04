// Rules for the names of user-defined properties on entities and
// relationships. They apply on every storage provider, at vocabulary
// proposal time and on every write, so a name that one backend could not
// store is refused everywhere rather than accepted by some providers and
// failing at write time on others.

import { InvalidInputError } from '../core/errors.js';
import {
  SAFE_IDENTIFIER_PATTERN,
  describeRejectedValue,
  isSafeIdentifier,
} from './identifier.js';

/** What a user property belongs to: the owner decides which names are reserved */
export type PropertyOwner = 'entity' | 'relationship';

/**
 * Field names every record carries, plus the provenance fields stamped on
 * each mutation and the write token a graph store uses to make retried
 * writes idempotent. Graph stores keep user properties next to these fields
 * on the same node or edge, so a user property with one of these names
 * would overwrite a system field.
 */
const SHARED_SYSTEM_KEYS = [
  'id',
  'repositoryId',
  'label',
  'properties',
  'createdBy',
  'createdByType',
  'createdAt',
  'createdInConversation',
  'createdFromMessage',
  'modifiedBy',
  'modifiedByType',
  'modifiedAt',
  'modifiedInConversation',
  'modifiedFromMessage',
  '_attempt',
] as const;

/**
 * The sets the guards test against. Kept private so that nothing a consumer
 * does to the exported copies (a cast to `Set` followed by `delete`) can
 * weaken the guards.
 */
const ENTITY_KEYS: ReadonlySet<string> = new Set<string>([
  ...SHARED_SYSTEM_KEYS,
  'entityType',
  'entityLabel',
  'slug',
  'summary',
  'data',
  'dataFormat',
  'embedding',
]);

const RELATIONSHIP_KEYS: ReadonlySet<string> = new Set<string>([
  ...SHARED_SYSTEM_KEYS,
  'relationshipType',
  'sourceEntityId',
  'targetEntityId',
  'bidirectional',
]);

/**
 * Property names an entity type may not declare and an entity write may not
 * set. A copy for consumers that want to apply or display the same rule;
 * {@link propertyNameRefusal} does not read it.
 */
export const RESERVED_ENTITY_PROPERTY_KEYS: ReadonlySet<string> = new Set(ENTITY_KEYS);

/**
 * Property names a relationship type may not declare and a relationship
 * write may not set. A copy for consumers that want to apply or display the
 * same rule; {@link propertyNameRefusal} does not read it.
 */
export const RESERVED_RELATIONSHIP_PROPERTY_KEYS: ReadonlySet<string> = new Set(RELATIONSHIP_KEYS);

/** True when `name` is reserved for a system field on records of `owner`'s kind */
export function isReservedPropertyName(name: string, owner: PropertyOwner): boolean {
  return (owner === 'entity' ? ENTITY_KEYS : RELATIONSHIP_KEYS).has(name);
}

/**
 * Why `name` cannot be used as a user property name on an `owner`, or
 * `undefined` when it can.
 *
 * A name must be a safe identifier: graph stores write property names into
 * query text, where they cannot be bound as parameters. It must also not be
 * reserved for a system field.
 */
export function propertyNameRefusal(name: string, owner: PropertyOwner): string | undefined {
  if (!isSafeIdentifier(name)) {
    return (
      `Property name ${describeRejectedValue(name)} is not a valid identifier; ` +
      `property names must match ${SAFE_IDENTIFIER_PATTERN.source}`
    );
  }
  if (isReservedPropertyName(name, owner)) {
    return `Property name "${name}" is reserved for a system field on every ${owner}`;
  }
  return undefined;
}

/**
 * Throw `InvalidInputError` (field `properties.<key>`) for the first key of
 * `properties` that cannot be used as a user property name on an `owner`.
 * Every key given is checked whatever its value. A caller that allows a key
 * to be removed (an update's `null`) passes only the keys it writes.
 */
export function assertWritablePropertyKeys(
  properties: Readonly<Record<string, unknown>> | null | undefined,
  owner: PropertyOwner,
): void {
  if (properties == null) return;
  for (const key of Object.keys(properties)) {
    const refusal = propertyNameRefusal(key, owner);
    if (refusal !== undefined) {
      throw new InvalidInputError(
        `properties.${key}`,
        refusal,
        `Rename the property to a name matching ${SAFE_IDENTIFIER_PATTERN.source} that is not a reserved system field.`,
      );
    }
  }
}
