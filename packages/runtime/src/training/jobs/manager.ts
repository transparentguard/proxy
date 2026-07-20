/**
 * TransparentGuard Runtime — Training Job Manager
 *
 * Local-first job lifecycle management using an append-only NDJSON state log.
 * All job state lives in ~/.tg/jobs/jobs.ndjson.
 *
 * State machine: pending → queued → running → complete | failed | cancelled
 *
 * The manager is compute-backend-agnostic. It delegates training to whichever
 * ITrainerBackend is registered for the requested backend ID.
 *
 * Design principles:
 *   - All state persisted locally — no external service needed to track status
 *   - Append-only log — every state transition is a new NDJSON line
 *   - Idempotent reads — reconstruct current state by replaying the log
 *   - Non-throwing status checks — returns { status: "failed" } instead of throwing
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import { homedir } from "os";
import { tgDataDir } from "../dataset/store.js";
import { getBackend } from "../backends/registry.js";
import type { TrainingJob, TrainingSpec, JobStatus } from "../types.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function jobsDir(): string {
  return join(tgDataDir(), "jobs");
}

function jobsLogPath(): string {
  return join(jobsDir(), "jobs.ndjson");
}

function ensureJobsDir(): void {
  const d = jobsDir();
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

// ---------------------------------------------------------------------------
// Job ID generation
// ---------------------------------------------------------------------------

function newJobId(): string {
  return `tg-job-${randomBytes(4).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// NDJSON log — append-only state machine
// ---------------------------------------------------------------------------

interface JobEvent extends Partial<TrainingJob> {
  job_id: string;
  event_at: string;
}

function appendEvent(event: JobEvent): void {
  ensureJobsDir();
  appendFileSync(jobsLogPath(), JSON.stringify(event) + "\n", "utf8");
}

/** Reconstruct the current state of all jobs by replaying the NDJSON log. */
function replayJobs(): Map<string, TrainingJob> {
  const jobs = new Map<string, TrainingJob>();
  if (!existsSync(jobsLogPath())) return jobs;

  const lines = readFileSync(jobsLogPath(), "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    let event: JobEvent;
    try { event = JSON.parse(line) as JobEvent; } catch { continue; }

    const { event_at: _ea, ...fields } = event;
    const existing = jobs.get(event.job_id);
    if (existing) {
      jobs.set(event.job_id, { ...existing, ...fields } as TrainingJob);
    } else {
      jobs.set(event.job_id, fields as TrainingJob);
    }
  }
  return jobs;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List all training jobs, most recent first.
 * Reconstructed by replaying the local NDJSON log.
 */
export function listJobs(): TrainingJob[] {
  const jobs = replayJobs();
  return [...jobs.values()].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}

/**
 * Get a specific job by ID.
 */
export function getJob(jobId: string): TrainingJob | undefined {
  return replayJobs().get(jobId);
}

/**
 * Submit a new training job.
 * Creates a job record in the NDJSON log and delegates to the configured backend.
 */
export async function submitJob(
  spec: TrainingSpec,
  datasetPath: string,
): Promise<TrainingJob> {
  const backend = getBackend(spec.backend);
  const jobId = newJobId();
  const now = new Date().toISOString();

  // Create initial job record
  const initialJob: TrainingJob = {
    job_id: jobId,
    classifier_name: spec.classifier_name,
    dataset_hash: spec.dataset_version,   // resolved by caller
    dataset_version: spec.dataset_version,
    backend: spec.backend,
    status: "pending",
    created_at: now,
  };

  appendEvent({ ...initialJob, event_at: now });

  // Delegate to backend
  let submitted: TrainingJob;
  try {
    submitted = await backend.train(spec, datasetPath);
    const update: Partial<TrainingJob> & { job_id: string; event_at: string } = {
      job_id: jobId,
      status: submitted.status,
      started_at: submitted.started_at,
      backend_job_id: submitted.backend_job_id,
      event_at: new Date().toISOString(),
    };
    appendEvent(update);
    return { ...initialJob, ...submitted, job_id: jobId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const failedAt = new Date().toISOString();
    appendEvent({
      job_id: jobId,
      status: "failed",
      error: msg,
      completed_at: failedAt,
      event_at: failedAt,
    });
    throw new Error(`Training job ${jobId} failed to submit: ${msg}`);
  }
}

/**
 * Poll and update status of a running job.
 * Writes any status change to the NDJSON log.
 * Never throws — returns the current (possibly stale) job state on error.
 */
export async function refreshJobStatus(jobId: string): Promise<TrainingJob | undefined> {
  const job = getJob(jobId);
  if (!job) return undefined;
  if (job.status === "complete" || job.status === "failed" || job.status === "cancelled") {
    return job; // terminal state — no refresh needed
  }

  try {
    const backend = getBackend(job.backend);
    const update = await backend.status(jobId, job.backend_job_id);
    if (update.status !== job.status) {
      appendEvent({
        job_id: jobId,
        ...update,
        event_at: new Date().toISOString(),
      });
    }
    return { ...job, ...update };
  } catch {
    return job;
  }
}

/**
 * Cancel a running or queued job.
 * Writes a "cancelled" event to the log.
 */
export async function cancelJob(jobId: string): Promise<void> {
  const job = getJob(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  if (job.status === "complete" || job.status === "failed" || job.status === "cancelled") {
    throw new Error(`Job ${jobId} is already in terminal state: ${job.status}`);
  }

  try {
    const backend = getBackend(job.backend);
    await backend.cancel(jobId, job.backend_job_id);
  } catch {
    // Backend cancel failure is non-fatal — we still mark locally
  }

  const now = new Date().toISOString();
  appendEvent({
    job_id: jobId,
    status: "cancelled",
    completed_at: now,
    event_at: now,
  });
}

/**
 * Format a job list for terminal output.
 */
export function formatJobList(jobs: TrainingJob[]): string {
  if (jobs.length === 0) return "\nNo training jobs found.\n";

  const lines: string[] = ["\nTraining jobs\n"];
  for (const j of jobs) {
    const statusIcon: Record<JobStatus, string> = {
      pending: "○", queued: "○", running: "◐", complete: "●", failed: "✗", cancelled: "—",
    };
    const icon = statusIcon[j.status] ?? "?";
    lines.push(`  ${icon} ${j.job_id}  ${j.classifier_name.padEnd(24)}  ${j.status.padEnd(10)}  ${j.backend}`);
    lines.push(`    Dataset: ${j.dataset_version}  Created: ${j.created_at}`);
    if (j.error) lines.push(`    Error: ${j.error}`);
  }
  lines.push("");
  return lines.join("\n");
}
