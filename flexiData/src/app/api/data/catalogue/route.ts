import { requireAccount } from "@/lib/api-auth";
import { isTechlinkProviderCode, getDataProviderCode } from "@/lib/data-gateway";
import {
  describeTechlinkApiError,
  describeTechlinkContractError,
  describeTechlinkTransportError,
  fetchTechlinkCatalogue,
  TechlinkApiError,
  TechlinkCatalogueError,
  TechlinkConfigurationError,
  TechlinkContractError,
  TechlinkTransportError,
} from "@/lib/techlink";
import { normalizeGhanaMobileStrict } from "@/lib/ghana-mobile";

export const dynamic = "force-dynamic";

const NETWORKS = new Set(["MTN", "TELECEL"]);

/**
 * Authenticated, read-only live catalogue seam. The browser never receives the
 * Techlink key; it receives only the validated fields needed to display a
 * selection and the exact provider IDs returned by this request.
 */
export async function GET(req: Request) {
  const auth = await requireAccount();
  if (!auth.ok) return auth.response;

  const query = new URL(req.url).searchParams;
  const network = query.get("network")?.trim().toUpperCase() ?? "";
  const phone = query.get("phone")?.trim() ?? "";
  if (!NETWORKS.has(network)) {
    return Response.json({ ok: false, error: "Choose a network" }, { status: 400 });
  }
  if (!normalizeGhanaMobileStrict(phone).ok) {
    return Response.json({ ok: false, error: "Enter a valid Ghana recipient number" }, { status: 400 });
  }
  if (!isTechlinkProviderCode(getDataProviderCode())) {
    return Response.json({ ok: false, error: "Live catalogue is not enabled" }, { status: 404 });
  }

  try {
    const catalogue = await fetchTechlinkCatalogue(network as "MTN" | "TELECEL", phone);
    return Response.json({ ok: true, provider: catalogue.provider, network, bundles: catalogue.bundles });
  } catch (error) {
    if (error instanceof TechlinkConfigurationError) {
      return Response.json({ ok: false, error: "Techlink catalogue is not configured" }, { status: 503 });
    }
    if (error instanceof TechlinkCatalogueError) {
      return Response.json({ ok: false, error: "Techlink catalogue could not be verified" }, { status: 502 });
    }
    if (error instanceof TechlinkApiError) {
      const diagnostic = describeTechlinkApiError(error);
      // Safe diagnostics only: category and upstream status. Never log the
      // provider body, request URL, recipient phone, or API key.
      console.warn("[flexidata] Techlink catalogue upstream failure", {
        category: diagnostic.category,
        upstreamStatus: diagnostic.upstreamStatus,
      });
      return Response.json(
        {
          ok: false,
          error: diagnostic.message,
          code: diagnostic.code,
          upstreamStatus: diagnostic.upstreamStatus,
        },
        { status: diagnostic.responseStatus },
      );
    }
    if (error instanceof TechlinkContractError) {
      const diagnostic = describeTechlinkContractError(error);
      console.warn("[flexidata] Techlink catalogue response contract failure", {
        category: diagnostic.category,
        schemaCheck: diagnostic.schemaCheck,
        providerField: diagnostic.providerField,
        bundleSizeField: diagnostic.bundleSizeField,
        upstreamStatus: diagnostic.upstreamStatus,
      });
      return Response.json(
        {
          ok: false,
          error: diagnostic.message,
          code: diagnostic.code,
          schemaCheck: diagnostic.schemaCheck,
          providerField: diagnostic.providerField,
          bundleSizeField: diagnostic.bundleSizeField,
          upstreamStatus: diagnostic.upstreamStatus,
        },
        { status: diagnostic.responseStatus },
      );
    }
    if (error instanceof TechlinkTransportError) {
      const diagnostic = describeTechlinkTransportError(error);
      console.warn("[flexidata] Techlink catalogue transport failure", {
        category: diagnostic.category,
        upstreamStatus: diagnostic.upstreamStatus,
      });
      return Response.json(
        {
          ok: false,
          error: diagnostic.message,
          code: diagnostic.code,
          upstreamStatus: diagnostic.upstreamStatus,
        },
        { status: diagnostic.responseStatus },
      );
    }
    console.error("[flexidata] Techlink catalogue unexpected failure", {
      category: "unexpected",
      upstreamStatus: null,
    });
    return Response.json(
      {
        ok: false,
        error: "Techlink catalogue failed unexpectedly",
        code: "techlink_unexpected_failure",
        upstreamStatus: null,
      },
      { status: 503 },
    );
  }
}
