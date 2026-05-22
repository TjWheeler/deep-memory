/** Strip provenance field from an entity or relationship object */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function stripProvenance<T>(obj: T): Omit<T & { provenance?: unknown }, 'provenance'> {
  const { provenance, ...rest } = obj as any;
  return rest;
}

/** Strip provenance from an array of objects */
export function stripProvenanceArray<T>(items: T[]): Omit<T & { provenance?: unknown }, 'provenance'>[] {
  return items.map(stripProvenance);
}
