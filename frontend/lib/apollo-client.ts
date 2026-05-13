import { ApolloClient, ApolloLink, HttpLink, InMemoryCache } from "@apollo/client";
import { getOperationAST, parse } from "graphql";
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

  const apollo = getApolloClient();
  const context = { service, token };

  if (operation.operation === "mutation") {
    const result = await apollo.mutate({
      mutation: document,
      variables,
      context
    });
    if (result.error) throw new Error(String(result.error.message));
    if (!result.data) throw new Error("GraphQL mutation returned no data");
    return result.data as T;
  }

  const result = await apollo.query({
    query: document,
    variables,
    context,
    fetchPolicy: "network-only"
  });
  if (result.error) throw new Error(String(result.error.message));
  if (!result.data) throw new Error("GraphQL query returned no data");
  return result.data as T;
}

export function parseGraphQL(query: string) {
  return parse(query) as DocumentNode;
}
