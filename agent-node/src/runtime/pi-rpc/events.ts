// RFC-043 — pi RPC session-event reduction.
//
// Reduces the pi RPC stdout event stream (see pi.dev/docs/latest/rpc:
// JSON Event Stream; schema verified by M0 probe) into per-turn state.
//
// Events observed by M0 probe (census): agent_start / turn_start /
// message_start / message_end / message_update / turn_end / agent_end /
// agent_settled. The only text payload rides on `message_update` →
// `assistantMessageEvent.type === "text_delta"`.

export interface PiTurnState {
  /** Accumulated final assistant text (text_delta concat). */
  replyText: string;
  /** Accumulated thinking text (for logs / debugging). */
  thoughtText: string;
  /** Count of assistant text deltas observed this turn. */
  deltaCount: number;
  /** Count of message records observed this turn. */
  messageCount: number;
  /** Whether agent_settled was observed (pi will not continue by itself). */
  settled: boolean;
  /** Whether agent_end was observed (one low-level run finished). */
  agentEnded: boolean;
}

export function newPiTurnState(): PiTurnState {
  return {
    replyText: "",
    thoughtText: "",
    deltaCount: 0,
    messageCount: 0,
    settled: false,
    agentEnded: false,
  };
}

export interface PiRecordLike {
  type?: unknown;
  [k: string]: unknown;
}

/** Merge one stdout record into the turn state; returns the state. */
export function reducePiRecord(state: PiTurnState, record: PiRecordLike): PiTurnState {
  const type = record.type;
  if (typeof type !== "string") return state;

  if (type === "message_update") {
    const ev = record.assistantMessageEvent as
      | { type?: unknown; delta?: unknown; thinkingDelta?: unknown }
      | undefined;
    if (ev && typeof ev === "object") {
      if (ev.type === "text_delta" && typeof ev.delta === "string") {
        state.replyText += ev.delta;
        state.deltaCount += 1;
      } else if (ev.type === "thinking_delta" && typeof ev.thinkingDelta === "string") {
        state.thoughtText += ev.thinkingDelta;
      }
    }
  } else if (type === "message_start" || type === "message_end") {
    state.messageCount += 1;
  } else if (type === "agent_end") {
    state.agentEnded = true;
  } else if (type === "agent_settled") {
    state.settled = true;
  }
  return state;
}

/** True when a turn is complete: pi will not continue by itself. */
export function turnCompleted(state: PiTurnState): boolean {
  return state.settled;
}
