/**
 * Provider catalogue identities are exact, explicit data. This module never
 * derives a supplier product ID from network, category, label, amount or any
 * other FlexiData field.
 */
export type CataloguePlanIdentity = Readonly<{
  network: string;
  category: string;
  label: string;
}>;

export type ExplicitCatalogueEntry = CataloguePlanIdentity & Readonly<{
  providerProductCode: string;
}>;

/**
 * Deliberately empty until Techlink supplies an official test catalogue and
 * every row is independently verified. Do not populate this with guessed IDs.
 */
export const TECHLINK_CATALOGUE: readonly ExplicitCatalogueEntry[] = [];

export function lookupExplicitProviderProductCode(
  entries: readonly ExplicitCatalogueEntry[],
  identity: CataloguePlanIdentity,
): string | null {
  const match = entries.find((entry) =>
    entry.network === identity.network &&
    entry.category === identity.category &&
    entry.label === identity.label,
  );
  const code = match?.providerProductCode.trim();
  return code || null;
}

export function lookupTechlinkProductCode(identity: CataloguePlanIdentity): string | null {
  return lookupExplicitProviderProductCode(TECHLINK_CATALOGUE, identity);
}
