"use client";

import { useEffect, useReducer, useRef } from "react";
import { planFile, planKey, type PlanDoc } from "@/lib/generated-types";

export interface Controls {
  strategy: string;
  allowPaid: boolean;
  needs: string[];
  minIsolation: string;
}

/**
 * Where the plan for the current controls stands. One state, one reducer: the page never shows a
 * plan for controls other than the ones named, and an error says so instead of showing the old
 * plan as if it were the new one.
 */
export type PlanState =
  | { status: "ready"; key: string; plan: PlanDoc }
  | { status: "loading"; key: string; previous: PlanDoc }
  | { status: "error"; key: string; previous: PlanDoc; message: string };

type Action =
  | { type: "request"; key: string }
  | { type: "loaded"; key: string; plan: PlanDoc }
  | { type: "failed"; key: string; message: string };

function reduce(state: PlanState, action: Action): PlanState {
  const shown = state.status === "ready" ? state.plan : state.previous;
  switch (action.type) {
    case "request":
      return { status: "loading", key: action.key, previous: shown };
    case "loaded":
      // A response for controls the visitor has already left is dropped.
      return action.key === state.key ? { status: "ready", key: action.key, plan: action.plan } : state;
    case "failed":
      return action.key === state.key ? { status: "error", key: action.key, previous: shown, message: action.message } : state;
  }
}

/** The router's plan for these controls: generated at build time, fetched as a small static file. */
export function usePlan(controls: Controls, initial: { key: string; plan: PlanDoc }): [PlanState, () => void] {
  const key = planKey(controls);
  const cache = useRef(new Map<string, PlanDoc>([[initial.key, initial.plan]]));
  const generation = useRef(0);
  const [state, dispatch] = useReducer(reduce, { status: "ready", key: initial.key, plan: initial.plan });
  const [attempt, retry] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const mine = ++generation.current;
    const hit = cache.current.get(key);
    if (hit) {
      dispatch({ type: "request", key });
      dispatch({ type: "loaded", key, plan: hit });
      return;
    }
    dispatch({ type: "request", key });
    const ctrl = new AbortController();
    fetch(`/data/plans/${planFile(key)}.json`, { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`the plan file answered ${res.status}`);
        return (await res.json()) as PlanDoc;
      })
      .then((plan) => {
        cache.current.set(key, plan);
        if (mine === generation.current) dispatch({ type: "loaded", key, plan });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted || mine !== generation.current) return;
        dispatch({ type: "failed", key, message: err instanceof Error ? err.message : String(err) });
      });
    return () => ctrl.abort();
  }, [key, attempt]);

  return [state, retry];
}

export function shownPlan(state: PlanState): PlanDoc {
  return state.status === "ready" ? state.plan : state.previous;
}
