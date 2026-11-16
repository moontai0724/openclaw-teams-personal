export class PocError extends Error {}

export function failureReason(error: unknown): string {
  return error instanceof PocError ? error.message : "Unexpected runtime, network or remote-data failure";
}
