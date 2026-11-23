import { test, expect } from "@playwright/test";
import { TerminalAckController, type AckFailure } from "../src/terminalAck";

// The transport and clock are injected: this test never starts a native session.
function clock() {
  const tasks: { callback: () => void; delay: number; active: boolean }[] = [];
  const flush = async () => {
    for (let step = 0; step < 20; step++) await Promise.resolve();
  };
  return {
    schedule(callback: () => void, delay: number) {
      const task = { callback, delay, active: true };
      tasks.push(task);
      return () => {
        task.active = false;
      };
    },
    flush,
    pending: () =>
      tasks.filter((task) => task.active).map((task) => task.delay),
    async fire(delay: number) {
      const task = tasks.find((task) => task.active);
      expect(task?.delay).toBe(delay);
      task!.active = false;
      task!.callback();
      await flush();
    },
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("terminal ACKs recover in order, fail within a bound, and cancel without late errors", async () => {
  const recoverClock = clock();
  const recoverCalls: number[] = [];
  const recoverFailures: AckFailure[] = [];
  const recovery = new TerminalAckController({
    schedule: recoverClock.schedule,
    send: async (sequence) => {
      recoverCalls.push(sequence);
      if (recoverCalls.length === 1)
        throw new Error("temporary transport error");
    },
    onFailure: (failure) => recoverFailures.push(failure),
  });
  recovery.acknowledge(1);
  recovery.acknowledge(1); // A repeated render callback cannot duplicate a queued ACK.
  recovery.acknowledge(2);
  await recoverClock.flush();
  expect(recoverCalls).toEqual([1]);
  expect(recoverClock.pending()).toEqual([250]);
  await recoverClock.fire(250);
  expect(recoverCalls).toEqual([1, 1, 2]);
  expect(recoverFailures).toEqual([]);
  expect(recoverClock.pending()).toEqual([]);
  recovery.dispose();

  const failClock = clock();
  const failedCalls: number[] = [];
  const failures: AckFailure[] = [];
  const failing = new TerminalAckController({
    schedule: failClock.schedule,
    send: async (sequence) => {
      failedCalls.push(sequence);
      throw new Error("transport unavailable");
    },
    onFailure: (failure) => failures.push(failure),
  });
  failing.acknowledge(3);
  failing.acknowledge(4);
  await failClock.flush();
  await failClock.fire(250);
  await failClock.fire(750);
  expect(failedCalls).toEqual([3, 3, 3]);
  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject({ sequence: 3, attempts: 3 });
  failing.acknowledge(5);
  await failClock.flush();
  expect(failedCalls).toHaveLength(3);
  expect(failClock.pending()).toEqual([]);

  const timeoutClock = clock();
  const pendingInvokes: ReturnType<typeof deferred>[] = [];
  const timeoutFailures: AckFailure[] = [];
  const timedOut = new TerminalAckController({
    schedule: timeoutClock.schedule,
    send: () => {
      const invocation = deferred();
      pendingInvokes.push(invocation);
      return invocation.promise;
    },
    onFailure: (failure) => timeoutFailures.push(failure),
  });
  timedOut.acknowledge(6);
  await timeoutClock.flush();
  await timeoutClock.fire(5000);
  await timeoutClock.fire(250);
  await timeoutClock.fire(5000);
  await timeoutClock.fire(750);
  await timeoutClock.fire(5000);
  expect(pendingInvokes).toHaveLength(3);
  expect(timeoutFailures).toHaveLength(1);
  expect(timeoutFailures[0]).toMatchObject({ sequence: 6, attempts: 3 });
  expect(String(timeoutFailures[0].cause)).toContain("与桌面后端通信超时");
  pendingInvokes[0].resolve();
  pendingInvokes[1].reject(new Error("late rejection after timeout"));
  pendingInvokes[2].resolve();
  await timeoutClock.flush();
  expect(timeoutFailures).toHaveLength(1);
  expect(timeoutClock.pending()).toEqual([]);

  // Cancellation must clear both an in-flight deadline and a scheduled retry.
  for (const duringRetry of [false, true]) {
    const cancelClock = clock();
    const invocation = deferred();
    const cancelFailures: AckFailure[] = [];
    let attempts = 0;
    const cancelled = new TerminalAckController({
      schedule: cancelClock.schedule,
      send: () => {
        attempts++;
        return invocation.promise;
      },
      onFailure: (failure) => cancelFailures.push(failure),
    });
    cancelled.acknowledge(7);
    await cancelClock.flush();
    if (duringRetry) {
      invocation.reject(new Error("retry pending"));
      await cancelClock.flush();
      expect(cancelClock.pending()).toEqual([250]);
    } else expect(cancelClock.pending()).toEqual([5000]);
    cancelled.dispose();
    cancelled.acknowledge(8);
    if (!duringRetry)
      invocation.reject(new Error("late rejection after disposal"));
    await cancelClock.flush();
    expect(cancelClock.pending()).toEqual([]);
    expect(attempts).toBe(1);
    expect(cancelFailures).toEqual([]);
  }
});
