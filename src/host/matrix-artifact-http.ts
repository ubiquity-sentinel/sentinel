/** Read-only bounded authenticated requests, redirects and exhaustive pagination. */
import { HOSTED_SUPERVISOR_REPOSITORY as REPOSITORY } from "../contracts/hosted-supervisor.ts";
import { MAX_MATRIX_ARCHIVE_BYTES } from "../contracts/matrix.ts";
import {
  DEFAULT_HTTP_MAX_BODY_BYTES,
  type HttpResponseV1,
} from "../github/http.ts";
import {
  type Json,
  positive,
  record,
  refuse,
} from "./matrix-artifact-values.ts";
import type {
  MatrixArtifactDeadlineV1,
  MatrixArtifactOptionsV1,
  MatrixArtifactReaderV1,
} from "./matrix-artifact-context.ts";
import { MatrixArtifactUnavailableError } from "./matrix-artifact-port.ts";

const API = `https://api.github.com/repos/${REPOSITORY}/actions`;
const MAX_ITEMS = 10_000;
/** Complete listings attempted when items shift between pages. */
const LISTING_ATTEMPTS = 3;
/** Reads attempted per request when GitHub answers a server error (5xx). */
const SERVER_ERROR_ATTEMPTS = 3;
const SERVER_ERROR_PAUSE_MS = 1_000;
function storageUrl(location: string | null): string {
  if (location === null) refuse();
  const url = new URL(location);
  if (
    url.protocol !== "https:" || url.port !== "" || url.username !== "" ||
    url.password !== "" || url.hash !== "" ||
    !/^productionresultssa[0-9]+\.blob\.core\.windows\.net$/.test(url.hostname)
  ) refuse();
  return url.toString();
}

/** Dedicated bounded archive bytes; ordinary metadata/log bodies retain 8 MiB. */
export function createMatrixArtifactHttp(
  options: MatrixArtifactOptionsV1,
  until: number,
  deadline: MatrixArtifactDeadlineV1,
  repositoryIdentity: { id: number | null },
): MatrixArtifactReaderV1 {
  /** One GitHub API or storage read, retried on a server error. */
  const get = async (
    path: string,
    binary = false,
    storage = false,
  ): Promise<HttpResponseV1> => {
    for (let attempt = 1;; attempt++) {
      const response = await getOnce(path, binary, storage);
      if (
        storage || response.status < 500 || response.status > 599 ||
        attempt >= SERVER_ERROR_ATTEMPTS ||
        until - options.clock.now() <= SERVER_ERROR_PAUSE_MS * attempt
      ) return response;
      await new Promise((resolve) =>
        setTimeout(resolve, SERVER_ERROR_PAUSE_MS * attempt)
      );
    }
  };
  const getOnce = async (
    path: string,
    binary: boolean,
    storage: boolean,
  ): Promise<HttpResponseV1> => {
    const remaining = until - options.clock.now();
    if (remaining <= 0 || deadline.fired()) refuse();
    const response = await deadline.race(
      options.http({
        method: "GET",
        url: path,
        deadlineMs: remaining,
        headers: storage
          ? new Map()
          : new Map([["authorization", `Bearer ${options.token}`], [
            "accept",
            "application/vnd.github+json",
          ], ["x-github-api-version", "2022-11-28"]]),
        body: null,
        redirect: storage ? "error" : "manual",
        ...(binary ? { responseType: "bytes" as const } : {}),
      }),
    );
    if (
      new TextEncoder().encode(response.bodyText).length >
        DEFAULT_HTTP_MAX_BODY_BYTES ||
      (response.bodyBytes?.length ?? 0) > MAX_MATRIX_ARCHIVE_BYTES
    ) refuse();
    return response;
  };
  /** A server error that outlived its retries is unavailability, never provenance. */
  const unavailableOr = (status: number) => {
    if (status >= 500 && status <= 599) {
      throw new MatrixArtifactUnavailableError();
    }
    refuse();
  };
  const json = async (path: string): Promise<Json> => {
    const response = await get(path);
    if (response.status !== 200) unavailableOr(response.status);
    return record(JSON.parse(response.bodyText));
  };
  /**
   * One complete listing. Other runs add and delete artifacts while a listing
   * pages (each plan and cell uploads, maintenance cleanup deletes; live
   * 2026-10-24 run 40113229034 refused at 440 artifacts over 5 pages), so a
   * count or item set that shifts between pages is reported as `shifted` and
   * the caller lists again; every structural refusal stays immediate.
   */
  const listOnce = async (
    path: string,
    key: string,
  ): Promise<Json[] | "shifted"> => {
    const items: Json[] = [];
    let total: number | null = null;
    for (let page = 1; page <= 100; page++) {
      const url = `${API}${path}?per_page=100&page=${page}`;
      const response = await get(url);
      if (response.status !== 200) unavailableOr(response.status);
      const body = record(JSON.parse(response.bodyText));
      if (
        !Number.isSafeInteger(body.total_count) ||
        (body.total_count as number) < 0 ||
        (body.total_count as number) > MAX_ITEMS
      ) refuse();
      if (total !== null && total !== body.total_count) return "shifted";
      total = body.total_count as number;
      if (!Array.isArray(body[key]) || body[key].length > 100) refuse();
      items.push(...body[key].map(record));
      if (items.length > total) return "shifted";
      const link = response.headers.get("link");
      const nextLinks = [
        ...(link?.matchAll(/<([^>]+)>;\s*rel="next"/g) ?? []),
      ];
      if (nextLinks.length > 1) refuse();
      const next = nextLinks[0];
      if (
        next && next[1] !== `${API}${path}?per_page=100&page=${page + 1}`
      ) {
        if (!next[1].startsWith("https://api.github.com/repositories/")) {
          refuse();
        }
        if (repositoryIdentity.id === null) {
          const repository = await json(
            `https://api.github.com/repos/${REPOSITORY}`,
          );
          if (repository.full_name !== REPOSITORY) refuse();
          repositoryIdentity.id = positive(repository.id);
        }
        if (
          next[1] !==
            `https://api.github.com/repositories/${repositoryIdentity.id}/actions${path}?per_page=100&page=${
              page + 1
            }`
        ) {
          refuse();
        }
      }
      if (!next && items.length === total) {
        const ids = items.map((row) => positive(row.id));
        if (new Set(ids).size !== ids.length) return "shifted";
        return items;
      }
      if (!next || body[key].length === 0) return "shifted";
    }
    refuse();
  };
  const pages = async (path: string, key: string): Promise<Json[]> => {
    for (let attempt = 1; attempt <= LISTING_ATTEMPTS; attempt++) {
      const listed = await listOnce(path, key);
      if (listed !== "shifted") return listed;
    }
    refuse();
  };
  // `unserved` classifies only a body that is not served (yet): an API answer
  // other than the redirect, or storage other than 200. A foreign redirect
  // target, the deadline and every bound still refuse.
  const download = async (
    path: string,
    binary: boolean,
    unserved: () => never = refuse,
  ): Promise<HttpResponseV1> => {
    const redirect = await get(`${API}${path}`);
    if (redirect.status !== 302) unserved();
    const response = await get(
      storageUrl(redirect.headers.get("location")),
      binary,
      true,
    );
    if (response.status !== 200) unserved();
    return response;
  };

  return { json, pages, download };
}
