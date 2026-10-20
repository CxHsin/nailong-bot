import { defineTask, type TaskId } from "@earendil-works/pi-durable";
import type { AssistantMemory } from "./memory.js";

/** Durable owns compaction completion; the profile worker owns retryable archive work. */
export function memoryRefinement(memory: AssistantMemory, conversationId: string, run: (key: string) => Promise<void>) {
  return defineTask<{
    compactTask: number; rangeId: string; sourceIds: string[]; expectedVersion: number;
  }, { phase: "wait" } | { phase: "extract" }, { status: string }>({
    name: "nailong.memory-refinement", version: 1, initial: () => ({ phase: "wait" }),
    phases: {
      async wait(task, runtime, context) {
        await runtime.commit(() => ({ status: "waiting", checkpoint: { phase: "extract" },
          on: [task.input.compactTask as TaskId], policy: "allSettled" }), context);
      },
      async extract(task, runtime, context) {
        const compacted = await runtime.getTask(task.input.compactTask as TaskId, context);
        let status = "skipped";
        if (compacted?.state.status === "terminal" && compacted.state.outcome.status === "completed") {
          const result = compacted.state.outcome.result as { entryId?: number; submissionId?: number };
          if (result.entryId !== undefined || result.submissionId !== undefined) {
            const key = memory.enqueueProfile({ conversationId, ...task.input });
            await run(key);
            status = memory.profileJobs().find(job => job.key === key)?.state === "applied" ? "processed" : "pending";
          }
        }
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { status } } }), context);
      },
    },
    async abort(_task, runtime, context) {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });
}
