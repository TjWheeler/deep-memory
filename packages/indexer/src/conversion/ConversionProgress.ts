/**
 * Progress data for an active conversion, written to disk each poll cycle.
 * Read by the status tool to surface live conversion progress (queue position,
 * elapsed time, whether OCR is running) without waiting for the run to finish.
 */
export interface ConversionProgress {
  /** Source filename being converted. */
  source: string;
  /** Async task id, once submitted. Absent on the synchronous path. */
  taskId?: string;
  /** Latest task status reported by the service. */
  taskStatus?: 'pending' | 'started' | 'success' | 'failure';
  /** Advisory queue position reported by the service, when present. */
  taskPosition?: number;
  /** ISO timestamp when conversion of this source began. */
  startedAt: string;
  /** Milliseconds elapsed since `startedAt` at the last update. */
  elapsedMs: number;
  /** Whether OCR is being applied to this conversion. */
  ocrApplied?: boolean;
}
