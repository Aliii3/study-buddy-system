import type { ServiceKey } from "@/types/domain";
import { parseGraphQL, runGraphQLDocument } from "./apollo-client";

export type GraphQLErrorPayload = {
  message: string;
};

function isTransientNetworkError(error: unknown) {
  if (error instanceof TypeError) return true;
  const msg = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    msg.includes("fetch") ||
    msg.includes("network") ||
    msg.includes("failed to fetch") ||
    msg.includes("load failed") ||
    msg.includes("ecconnreset")
  );
}

async function withRetry<T>(run: () => Promise<T>, attempts = 2): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await run();
    } catch (error) {
      last = error;
      if (i === attempts - 1 || !isTransientNetworkError(error)) throw error;
      await new Promise((r) => setTimeout(r, 350 * (i + 1)));
    }
  }
  throw last;
}

export async function graphQL<T>(
  service: ServiceKey,
  query: string,
  variables?: Record<string, unknown>,
  token?: string | null
): Promise<T> {
  const document = parseGraphQL(query);
  return withRetry(() => runGraphQLDocument<T>(service, document, variables, token));
}
