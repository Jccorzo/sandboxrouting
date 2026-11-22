"use client";

// Polls a back path through the proxy while the tab is visible. The state machine and its
// generation guard live in poll-state.ts; this hook only feeds it requests and answers.
import { useCallback, useEffect, useReducer, useRef } from "react";
import { useRouter } from "next/navigation";
import { api } from "./api";
import { initialPoll, pollReducer, type PollState, type PollView } from "./poll-state";

export function usePoll<T>(path: string, intervalMs = 15_000): PollView<T> & { refresh: () => void } {
  const [state, dispatch] = useReducer(pollReducer<T>, undefined, initialPoll<T>) as [PollState<T>, (a: Parameters<typeof pollReducer<T>>[1]) => void];
  const gen = useRef(0);
  const inflight = useRef<AbortController | null>(null);
  const router = useRouter();

  const load = useCallback(async () => {
    const mine = ++gen.current;
    inflight.current?.abort();
    const ctrl = new AbortController();
    inflight.current = ctrl;
    dispatch({ type: "begin", gen: mine });
    try {
      const out = await api<T>(path, { signal: ctrl.signal });
      if (out.ok) dispatch({ type: "succeeded", gen: mine, data: out.data, at: Date.now() });
      else {
        dispatch({ type: "failed", gen: mine, failure: out.failure });
        if (out.failure.kind === "unauthorized" && mine === gen.current) router.replace("/login");
      }
    } catch {
      // Aborted: a newer request replaced it, and the reducer would drop its answer anyway.
    }
  }, [path, router]);

  useEffect(() => {
    // A new path (another range or view) is another question: start from loading.
    dispatch({ type: "reset", gen: ++gen.current });
    void load();
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      clearInterval(timer);
      timer = setInterval(() => void load(), intervalMs);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void load();
        start();
      } else clearInterval(timer);
    };
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      inflight.current?.abort();
    };
  }, [load, intervalMs]);

  return { ...state.view, refresh: () => void load() };
}
