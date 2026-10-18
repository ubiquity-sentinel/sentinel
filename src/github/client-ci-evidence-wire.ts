/**
 * Strict parsers for the GitHub responses the CI failure evidence reader
 * uses: check runs, commit statuses, Actions jobs and runs, and check-run
 * annotations. Each throws on a shape it cannot trust; the reader maps that
 * to the `malformed` reason. String values are bounded here and sanitized by
 * the reader before they reach any prompt. Separate from `wire.ts` on
 * purpose: the merge gate's check parser is not changed by this lane.
 */
const MAX_WIRE_TEXT = 70_000;
const MAX_WIRE_NAME = 1_024;
const MAX_PAGE_ITEMS = 100;
const MAX_JOB_STEPS = 200;

type Row = Record<string, unknown>;

class CiEvidenceWireError extends Error {
  constructor() {
    super("CI evidence wire value is malformed");
  }
}

function row(value: unknown): Row {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CiEvidenceWireError();
  }
  return value as Row;
}

function id(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new CiEvidenceWireError();
  }
  return value;
}

function text(value: unknown, max = MAX_WIRE_NAME): string {
  if (typeof value !== "string") throw new CiEvidenceWireError();
  return value.length > max ? value.slice(0, max) : value;
}

function optionalText(value: unknown, max = MAX_WIRE_NAME): string {
  return value === null || value === undefined ? "" : text(value, max);
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function sha(value: unknown): string {
  const parsed = text(value);
  if (!/^[0-9a-f]{40}$/.test(parsed)) throw new CiEvidenceWireError();
  return parsed;
}

function instant(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function line(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new CiEvidenceWireError();
  }
  return value;
}

export interface CheckRunWireV1 {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  headSha: string;
  app: string | null;
  startedAt: number | null;
  output: { title: string; summary: string; text: string };
}

export function parseCheckRunsPageWire(
  body: unknown,
): { total: number; runs: CheckRunWireV1[] } {
  const page = row(body);
  const total = page.total_count;
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) {
    throw new CiEvidenceWireError();
  }
  const runs = list(page.check_runs, MAX_PAGE_ITEMS).map((item) => {
    const run = row(item);
    const output = run.output === null || run.output === undefined
      ? {}
      : row(run.output);
    const app = run.app === null || run.app === undefined ? null : row(run.app);
    return {
      id: id(run.id),
      name: text(run.name),
      status: text(run.status),
      conclusion: nullableText(run.conclusion),
      headSha: sha(run.head_sha),
      app: app === null ? null : nullableText(app.slug),
      startedAt: instant(run.started_at),
      output: {
        title: optionalText(output.title),
        summary: optionalText(output.summary, MAX_WIRE_TEXT),
        text: optionalText(output.text, MAX_WIRE_TEXT),
      },
    };
  });
  return { total, runs };
}

export interface StatusWireV1 {
  context: string;
  state: string;
  description: string;
}

export function parseStatusesWire(body: unknown): StatusWireV1[] {
  return list(body, MAX_PAGE_ITEMS).map((item) => {
    const status = row(item);
    return {
      context: text(status.context),
      state: text(status.state),
      description: optionalText(status.description),
    };
  });
}

export interface JobStepWireV1 {
  number: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: number | null;
  completedAt: number | null;
}

export interface JobWireV1 {
  id: number;
  runId: number;
  headSha: string;
  name: string;
  workflowName: string | null;
  status: string;
  conclusion: string | null;
  steps: JobStepWireV1[];
}

export function parseJobWire(body: unknown): JobWireV1 {
  const job = row(body);
  const steps = job.steps === null || job.steps === undefined
    ? []
    : list(job.steps, MAX_JOB_STEPS);
  return {
    id: id(job.id),
    runId: id(job.run_id),
    headSha: sha(job.head_sha),
    name: text(job.name),
    workflowName: nullableText(job.workflow_name),
    status: text(job.status),
    conclusion: nullableText(job.conclusion),
    steps: steps.map((item) => {
      const step = row(item);
      const number = step.number;
      if (
        typeof number !== "number" || !Number.isSafeInteger(number) ||
        number < 0
      ) throw new CiEvidenceWireError();
      return {
        number,
        name: text(step.name),
        status: text(step.status),
        conclusion: nullableText(step.conclusion),
        startedAt: instant(step.started_at),
        completedAt: instant(step.completed_at),
      };
    }),
  };
}

export interface RunWireV1 {
  id: number;
  name: string | null;
  path: string | null;
  headSha: string;
}

export function parseRunWire(body: unknown): RunWireV1 {
  const run = row(body);
  return {
    id: id(run.id),
    name: nullableText(run.name),
    path: nullableText(run.path),
    headSha: sha(run.head_sha),
  };
}

export interface AnnotationWireV1 {
  path: string;
  startLine: number | null;
  endLine: number | null;
  level: string;
  title: string;
  message: string;
}

export function parseAnnotationsWire(body: unknown): AnnotationWireV1[] {
  return list(body, MAX_PAGE_ITEMS).map((item) => {
    const note = row(item);
    return {
      path: optionalText(note.path),
      startLine: line(note.start_line),
      endLine: line(note.end_line),
      level: optionalText(note.annotation_level),
      title: optionalText(note.title),
      message: optionalText(note.message, MAX_WIRE_TEXT),
    };
  });
}
