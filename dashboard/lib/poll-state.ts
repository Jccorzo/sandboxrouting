// The state of a polled view, and the one function that moves it. Every request carries a
// generation; a response from an older generation than the latest request is dropped, so a slow
// answer can never overwrite a newer one (or data for a range the user has since left).
//
//   loading ──ok──▶ ready ──refresh──▶ ready (refreshing) ──ok──▶ ready
//      │                                      └──fail──▶ ready (stale, with the error)
//      └──fail──▶ error ──retry──▶ error (retrying) ──ok──▶ ready
//   any ──reset (the view's query changed)──▶ loading
import type { Failure } from "./api";

export type PollView<T> =
  | { status: "loading" }
  | { status: "error"; failure: Failure; retrying: boolean }
  /** `failure`: the last refresh failed; `data` is from `fetchedAt` and says so. */
  | { status: "ready"; data: T; fetchedAt: number; refreshing: boolean; failure?: Failure };

export interface PollState<T> {
  /** The generation of the latest request; only its answer counts. */
  gen: number;
  view: PollView<T>;
}

export type PollAction<T> =
  | { type: "begin"; gen: number }
  | { type: "reset"; gen: number }
  | { type: "succeeded"; gen: number; data: T; at: number }
  | { type: "failed"; gen: number; failure: Failure };

export const initialPoll = <T>(): PollState<T> => ({ gen: 0, view: { status: "loading" } });

export function pollReducer<T>(state: PollState<T>, action: PollAction<T>): PollState<T> {
  switch (action.type) {
    case "reset":
      return { gen: action.gen, view: { status: "loading" } };
    case "begin": {
      if (action.gen <= state.gen) return state;
      const v = state.view;
      const view: PollView<T> = v.status === "ready" ? { ...v, refreshing: true } : v.status === "error" ? { ...v, retrying: true } : v;
      return { gen: action.gen, view };
    }
    case "succeeded":
      if (action.gen !== state.gen) return state; // an older request's answer
      return { gen: state.gen, view: { status: "ready", data: action.data, fetchedAt: action.at, refreshing: false } };
    case "failed": {
      if (action.gen !== state.gen) return state;
      const v = state.view;
      // Keep showing what we had, marked stale; never pretend the refresh worked.
      if (v.status === "ready") return { gen: state.gen, view: { status: "ready", data: v.data, fetchedAt: v.fetchedAt, refreshing: false, failure: action.failure } };
      return { gen: state.gen, view: { status: "error", failure: action.failure, retrying: false } };
    }
  }
}
