export interface SyntheticStep { name: string; run: () => Promise<unknown>; }
export interface SyntheticResult { ok: boolean; durationMs: number; steps: Array<{ name: string; ok: boolean; error?: string; }>; }

export async function runSyntheticJourney(steps: SyntheticStep[], now: () => number = Date.now): Promise<SyntheticResult> {
  const started = now();
  const results: SyntheticResult['steps'] = [];
  for (const step of steps) {
    try { await step.run(); results.push({ name: step.name, ok: true }); }
    catch (error) { results.push({ name: step.name, ok: false, error: error instanceof Error ? error.message : String(error) }); break; }
  }
  return { ok: results.length === steps.length && results.every((step) => step.ok), durationMs: now() - started, steps: results };
}
