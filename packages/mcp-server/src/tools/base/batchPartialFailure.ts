import type { BatchPartialFailureError } from '@utaba/deep-memory';

/** The MCP tool response shape for a pre-formatted error result */
export interface ToolErrorResponse {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
}

/**
 * The error response for a batch create that stored some members before one
 * failed. It follows the server's error shape (`Error: <message>` text with
 * `isError`) and appends the members that were stored and the index that
 * failed, so the caller can resend only the members that are not stored
 * instead of resending the batch and duplicating them.
 */
export function batchPartialFailureResponse(error: BatchPartialFailureError): ToolErrorResponse {
  const details = {
    code: error.code,
    failedIndex: error.failedIndex,
    created: error.created,
    suggestion: error.suggestion,
  };
  return {
    content: [{ type: 'text', text: `Error: ${error.message}\n${JSON.stringify(details, null, 2)}` }],
    isError: true,
  };
}
