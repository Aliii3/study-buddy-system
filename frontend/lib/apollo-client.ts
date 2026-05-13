import { ApolloClient, ApolloLink, HttpLink, InMemoryCache } from "@apollo/client";
import { getOperationAST, parse, print } from "graphql";
import type { DocumentNode } from "graphql";
import type { ServiceKey } from "@/types/domain";

export const serviceEndpoints: Record<ServiceKey, string> = {
  user: process.env.NEXT_PUBLIC_USER_API || "/api/graphql/user",
  availability: process.env.NEXT_PUBLIC_AVAILABILITY_API || "/api/graphql/availability",
  session: process.env.NEXT_PUBLIC_SESSION_API || "/api/graphql/session",
  notification: process.env.NEXT_PUBLIC_NOTIFICATION_API || "/api/graphql/notification",
  matching: process.env.NEXT_PUBLIC_MATCHING_API || "/api/graphql/matching",
  profile: process.env.NEXT_PUBLIC_PROFILE_API || "/api/graphql/profile"
};

function directionalHttpLink() {
  return new ApolloLink((operation, forward) => {
    const service = operation.getContext().service as ServiceKey | undefined;
    if (!service) throw new Error("Apollo context.service is required (user | profile | availability | session | notification | matching)");
    const uri = serviceEndpoints[service];
    const token = operation.getContext().token as string | null | undefined;
    const httpLink = new HttpLink({
      uri,
      fetch,
      headers: token ? { authorization: `Bearer ${token}` } : {}
    });
    return httpLink.request(operation, forward);
  });
}

let client: ApolloClient | null = null;

export function getApolloClient() {
  if (!client) {
    client = new ApolloClient({
      link: directionalHttpLink(),
      cache: new InMemoryCache()
    });
  }
  return client;
}

export async function runGraphQLDocument<T>(
  service: ServiceKey,
  document: DocumentNode,
  variables: Record<string, unknown> | undefined,
  token: string | null | undefined
): Promise<T> {
  const operation = getOperationAST(document);
  if (!operation) throw new Error("Invalid GraphQL document");

  const uri = serviceEndpoints[service];
  const response = await fetch(uri, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ query: print(document), variables: variables ?? {} })
  });

  let body: { data?: T; errors?: { message: string }[] };
  try {
    body = (await response.json()) as { data?: T; errors?: { message: string }[] };
  } catch {
    throw new Error(`Invalid response from server (HTTP ${response.status})`);
  }

  if (body.errors?.length) {
    throw new Error(body.errors.map((entry) => entry.message).join("; "));
  }
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }
  if (body.data === undefined || body.data === null) {
    throw new Error("GraphQL returned no data");
  }
  return body.data as T;
}

export function parseGraphQL(query: string) {
  return parse(query) as DocumentNode;
}
