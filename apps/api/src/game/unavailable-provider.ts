import type { GuesserObservation, GuesserProvider, GuesserResult } from "./ports";

export class UnavailableGuesserProvider implements GuesserProvider {
  async guess(observation: GuesserObservation): Promise<GuesserResult> {
    return { jobId: observation.jobId, status: "unavailable", reason: "provider-unavailable" };
  }
}
