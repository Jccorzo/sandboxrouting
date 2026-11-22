// The catalog's shapes, apart from the adapters it lists, so a client (the dashboard) can use
// them without loading provider code.

export interface CatalogField {
  /** The environment variable the adapter reads. */
  name: string;
  /** secret: shown back only as its last 4 characters. setting: not secret, shown in full. */
  kind: "secret" | "setting";
  label: string;
  required: boolean;
  /** For a setting: the values allowed, as a regular expression source (anchored). */
  pattern?: string;
  help?: string;
}

export interface CatalogEntry {
  id: string;
  name: string;
  homepage: string;
  fields: CatalogField[];
}
