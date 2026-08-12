/**
 * panel#890 — a POPULATED ComfyUI-Manager catalogue proves nothing about its age.
 *
 * ## What was measured (the reporter's, on a network that genuinely blocks the registry)
 *
 * Manager raises `InvalidChannel` for the channel host and logs `Cannot connect to
 * comfyregistry`. It then answers `/customnode/getmappings?mode=cache` with HTTP 200,
 * 1,570,773 bytes, 5583 packs — served from the `extension-node-map.json` BUNDLED in
 * the Manager package, via `get_data_by_mode`'s except-branch.
 *
 * So the failure mode is not an empty list. It is a full one, of unknown age, byte-for-
 * byte indistinguishable from a current one. Manager does not report which source
 * answered.
 *
 * ## Why the existing caveats do not cover it
 *
 * #1136 added `catalogue_unavailable` (the list came back EMPTY) and
 * `mappings_unavailable` (the lookup threw and we caught it). Both key on an OBSERVED
 * failure. A bundled fallback presents as success, so neither fires — and `unresolved`
 * goes out with no caveat at all, reading as "these packs do not exist". That is the
 * exact collapse #1136 exists to prevent, surviving in the case Manager works hardest
 * to produce.
 *
 * ## What this deliberately does NOT say
 *
 * It does not claim the catalogue IS stale. Nothing here can observe that, and the
 * reporter named that trap in the issue: a staleness claim inferred from something the
 * panel cannot see would repeat the fault the original issue was filed about. This says
 * only what is true of every Manager-served catalogue — its currency is unverifiable
 * from here — and then hands over a check that can settle it.
 *
 * ## The discriminator
 *
 * `search_custom_nodes` queries `api.comfy.org` DIRECTLY rather than through Manager, so
 * it is an independent source:
 *
 *   - found there, absent here  → this Manager catalogue is behind
 *   - absent from both          → genuinely unknown to the registry
 *
 * Named rather than performed: this rides on a read that already has its answer, and
 * adding a network call to it would make every dependency scan slower for a case that
 * is usually fine.
 */

/** The one sentence that must accompany an `unresolved` list from a Manager catalogue
 *  we could not date. Kept SHORT on purpose — it attaches to every miss, including the
 *  many that are ordinary, so a paragraph here becomes noise that gets skipped and then
 *  it protects nobody. */
export const MANAGER_CATALOGUE_CURRENCY_CAVEAT =
  `NOT proof these do not exist. This is the ComfyUI-Manager catalogue, and when Manager ` +
  `cannot reach the registry it serves a copy bundled in its own package — populated, ` +
  `HTTP 200, and indistinguishable from a current one; it does not report which source ` +
  `answered, so nothing here can date it (panel#890). To settle it, look one of these up ` +
  `with search_custom_nodes, which queries api.comfy.org directly: found there means this ` +
  `Manager catalogue is behind (update ComfyUI-Manager on the ComfyUI host and re-scan), ` +
  `absent from both means it is genuinely unknown to the registry.`;

/**
 * Should the currency caveat be attached?
 *
 * Only when there is something to mislead about (`unresolved` non-empty) AND no
 * STRONGER caveat already applies. `catalogue_unavailable` and `mappings_unavailable`
 * report an OBSERVED failure; this one reports the absence of evidence either way.
 * Emitting both would bury the observed fact under the generic one and read as two
 * separate problems.
 */
export function managerCatalogueCurrencyUnverified(opts: {
  unresolvedCount: number;
  catalogueUnavailable?: string;
  mappingsUnavailable?: string;
}): boolean {
  if (opts.unresolvedCount <= 0) return false;
  if (opts.catalogueUnavailable) return false;
  if (opts.mappingsUnavailable) return false;
  return true;
}
