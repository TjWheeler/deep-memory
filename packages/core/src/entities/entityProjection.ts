// Entity projection — maps StoredEntity to the appropriate detail level

import type {
  DetailLevel,
  Entity,
  EntityBrief,
  EntitySummary,
  StoredEntity,
} from '../types/entities.js';

/** Project a stored entity to the requested detail level */
export function projectEntity(stored: StoredEntity, level: DetailLevel): Entity | EntitySummary | EntityBrief {
  switch (level) {
    case 'brief':
      return {
        id: stored.id,
        slug: stored.slug,
        entityType: stored.entityType,
        label: stored.label,
        summary: stored.summary,
      };
    case 'summary':
      return {
        id: stored.id,
        slug: stored.slug,
        entityType: stored.entityType,
        label: stored.label,
        summary: stored.summary,
        properties: stored.properties,
      };
    case 'full':
      return {
        id: stored.id,
        slug: stored.slug,
        entityType: stored.entityType,
        label: stored.label,
        summary: stored.summary,
        properties: stored.properties,
        data: stored.data,
        dataFormat: stored.dataFormat,
        provenance: stored.provenance,
      };
  }
}

/** Project an EntitySummary down to brief level */
export function projectSummaryToBrief(entity: EntitySummary): EntityBrief {
  return {
    id: entity.id,
    slug: entity.slug,
    entityType: entity.entityType,
    label: entity.label,
    summary: entity.summary,
  };
}
