/**
 * One raw issue read as the facts the launcher's admission gate and the
 * owner's one-time protected release check: number, text, state and author,
 * the author id through the runtime's own parse
 * (`src/github/wire-issue-author.ts`: a positive safe integer, else absent).
 * A pull request, or any malformed field, is null.
 */
import { issueAuthorFacts } from "../src/github/wire-issue-author.ts";

export interface HostedIssueFactsV1 {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  author: string | null;
  authorId?: number;
}

export function parseHostedIssueFacts(
  issue: unknown,
): HostedIssueFactsV1 | null {
  if (issue === null || typeof issue !== "object" || Array.isArray(issue)) {
    return null;
  }
  const obj = issue as Record<string, unknown>;
  const user = obj["user"];
  const login = user !== null && typeof user === "object"
    ? (user as Record<string, unknown>)["login"]
    : null;
  const body = obj["body"] === null ? "" : obj["body"];
  const state = obj["state"];
  if (
    typeof obj["number"] !== "number" || typeof obj["title"] !== "string" ||
    typeof body !== "string" || (state !== "open" && state !== "closed") ||
    obj["pull_request"] !== undefined
  ) return null;
  const { authorId } = issueAuthorFacts(obj);
  return {
    number: obj["number"],
    title: obj["title"],
    body,
    state,
    author: typeof login === "string" ? login : null,
    ...(authorId === undefined ? {} : { authorId }),
  };
}
