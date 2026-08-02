/**
 * Cloudflare Worker: serve the Mintlify docs at comfyui-mcp.artokun.io/docs
 * by reverse-proxying to the Mintlify deployment, while everything else on the
 * host falls through to its normal origin.
 *
 * Requirements for this to render correctly:
 *  - Mintlify project's custom domain/subpath is set to comfyui-mcp.artokun.io/docs
 *    (so assets/links are generated with the /docs prefix).
 *  - A proxied (orange-cloud) DNS record exists for comfyui-mcp.artokun.io on the
 *    artokun.io zone so the route below can fire.
 *
 * Deploy: cd infra/cloudflare && npx wrangler deploy
 */
const DOCS_HOST = "artokun.mintlify.dev";
const PUBLIC_HOST = "comfyui-mcp.artokun.io";

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Bare root → the docs. 302 (temporary) so it's easy to swap for a real
    // landing page later without fighting cached permanent redirects.
    if (url.pathname === "/" || url.pathname === "") {
      return Response.redirect(`https://${PUBLIC_HOST}/docs`, 302);
    }

    // Proxy /docs and everything under it to Mintlify.
    if (/^\/docs(\/|$)/.test(url.pathname)) {
      url.hostname = DOCS_HOST;
      const proxied = new Request(url, request);
      proxied.headers.set("Host", DOCS_HOST);
      proxied.headers.set("X-Forwarded-Host", PUBLIC_HOST);
      proxied.headers.set("X-Forwarded-Proto", "https");
      return fetch(proxied);
    }

    // Internal links authored in the MDX pages are root-relative (e.g.
    // /local-llms) — Mintlify prefixes its OWN generated links with /docs but
    // NOT links written in page content, so those land here bare and used to
    // 404 (and older deploys 522'd). Redirect them onto the docs prefix
    // instead: every real page then resolves, and genuinely-nonexistent paths
    // still 404 — just from Mintlify, where the 404 page is styled. 301: these
    // are canonical content locations, not experiments.
    const target = `https://${PUBLIC_HOST}/docs${url.pathname}${url.search}`;
    return Response.redirect(target, 301);
  },
};
