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

/** Root icon paths user agents fetch on their own, none of which exist as-named.
 *  Covers /favicon.ico, /favicon.png, /apple-touch-icon.png and the numbered
 *  /apple-touch-icon-152x152-precomposed.png family iOS probes through. */
const ICON_ALIASES =
  /^\/(favicon\.(ico|png)|apple-touch-icon(-\d+x\d+)?(-precomposed)?\.png)$/i;

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

    // Root-relative ICON requests are a different animal from content links.
    // Browsers and crawlers request them on their OWN initiative, on every page
    // load, whether or not anything references them — so sending them through
    // the /docs redirect below turns each one into a redirect PLUS a Mintlify
    // 404, and that pair is logged as a worker error every single time. That is
    // the bulk of the 404 noise on this host: no `.ico` exists anywhere (not at
    // /docs/favicon.ico, not on the Mintlify origin either), and iOS Safari asks
    // for apple-touch-icon*.png unprompted.
    //
    // The real asset is /docs/favicon.svg. Point every icon alias at it: SVG
    // favicons are supported by every browser that requests these paths, and one
    // 301 to a 200 is both cheaper and quieter than a 301 to a 404.
    if (ICON_ALIASES.test(url.pathname)) {
      return Response.redirect(`https://${PUBLIC_HOST}/docs/favicon.svg`, 301);
    }

    // Internal links authored in the MDX pages are root-relative (e.g.
    // /local-llms) — Mintlify prefixes its OWN generated links with /docs but
    // NOT links written in page content, so those land here bare and used to
    // 404 (and older deploys 522'd). Redirect them onto the docs prefix
    // instead: every real page then resolves, and genuinely-nonexistent paths
    // still 404 — just from Mintlify, where the 404 page is styled. 301: these
    // are canonical content locations, not experiments.
    //
    // NOTE: robots.txt and sitemap.xml deliberately fall through to here and
    // resolve 200 via /docs — do not "fix" them into the icon branch above.
    const target = `https://${PUBLIC_HOST}/docs${url.pathname}${url.search}`;
    return Response.redirect(target, 301);
  },
};
