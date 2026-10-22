// Background loop: campaign fan-out, then message dispatch. Safe to run in several processes because each step
// claims its work with FOR UPDATE SKIP LOCKED. Journeys (M5) plug in here too.
export interface WorkerStep { name: string; run: () => Promise<unknown> }

export function createWorker(steps: WorkerStep[], log: (level: 'error', msg: string, fields?: Record<string, unknown>) => void = () => {}) {
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  async function tick() {
    for (const step of steps) {
      try { await step.run(); } catch (err) { log('error', `worker step failed: ${step.name}`, { error: (err as Error).message }); }
    }
  }

  return {
    tick,
    start(intervalMs: number) {
      if (!intervalMs || timer) return;
      timer = setInterval(() => {
        if (running) return;
        running = true;
        tick().finally(() => { running = false; });
      }, intervalMs);
      timer.unref();
    },
    stop() { if (timer) clearInterval(timer); timer = undefined; },
  };
}
