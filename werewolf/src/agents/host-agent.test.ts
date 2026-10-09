import { describe, it, expect, vi, afterEach } from 'vitest';
import { HostAgent } from './host-agent';
import { EngineState } from '../engine/state';
import { createSeededRng } from '../engine/deck';
import type { LlmClient } from '../llm/types';

function makeState(budgetMs: number, startClock: number) {
  let t = startClock;
  const state = new EngineState(
    [{ seatId: 's1', kind: 'agent', name: 'S1' }],
    { lobby: 0, night: 120000, dawn: 30000, day_discussion: 180000, voting: 90000, finished: 0 },
    createSeededRng(1),
    () => t,
  );
  return { state, setClock: (v: number) => { t = v; } };
}

const NUDGE_TIMINGS = { hostNudge: { enabled: true, minMsgPerMin: 2, silenceThresholdSec: 20 } };

describe('HostAgent.observeSilence', () => {
  afterEach(() => vi.useRealTimers());

  it('returns null when cadence is above threshold', async () => {
    const { state, setClock } = makeState(180000, 1000000);
    state.startDayDiscussion();
    // 5 speeches in the first 5s, then 56s of silence: silence exceeds the
    // 20s threshold, but cadence is 5 msgs/min > 2/min -> healthy, no nudge.
    for (let i = 0; i < 5; i++) {
      setClock(1000000 + i * 1000);
      state.recordEvent('player_speech', { seatId: 's' + (i + 1), text: 'hello' }, null);
    }
    setClock(1000000 + 60000);
    const client = vi.fn() as unknown as LlmClient;
    const host = new HostAgent(client, state, NUDGE_TIMINGS);
    expect(await host.observeSilence()).toBeNull();
    expect(client).not.toHaveBeenCalled();
  });

  it('returns a nudge Event when cadence drops below threshold', async () => {
    const { state, setClock } = makeState(180000, 1000000);
    state.startDayDiscussion();
    setClock(1000000 + 1000);
    state.recordEvent('player_speech', { seatId: 's1', text: 'hi' }, null);
    setClock(1000000 + 60000); // ~1 msg/min < 2/min, 59s since last message
    const client = vi.fn().mockResolvedValue('大家快发言吧！') as unknown as LlmClient;
    const host = new HostAgent(client, state, NUDGE_TIMINGS);
    const ev = await host.observeSilence();
    expect(ev).not.toBeNull();
    expect(ev!.type).toBe('host_nudge');
    expect(ev!.visibleTo).toBeNull();
    expect(ev!.payload.text).toBe('大家快发言吧！');
    expect(state.log.some((e) => e.type === 'host_nudge')).toBe(true);
  });

  it('never blocks the phase timer (always resolves within budget)', async () => {
    vi.useFakeTimers();
    const { state, setClock } = makeState(180000, 1000000);
    state.startDayDiscussion();
    setClock(1000000 + 1000);
    state.recordEvent('player_speech', { seatId: 's1', text: 'hi' }, null);
    setClock(1000000 + 60000);
    // remaining budget = 180000 - 60000 = 120000ms; the client hangs forever.
    const client = vi.fn().mockReturnValue(new Promise<string>(() => {})) as unknown as LlmClient;
    const host = new HostAgent(client, state, NUDGE_TIMINGS);
    const p = host.observeSilence();
    await vi.advanceTimersByTimeAsync(120000); // exactly the remaining budget
    const ev = await p; // already resolved: bounded by the budget
    expect(ev).toBeNull();
    expect(client).toHaveBeenCalledTimes(1);
  });
});

describe('HostAgent.announcePhaseTransition', () => {
  it('records a public host_announcement with the LLM narration', async () => {
    const { state, setClock } = makeState(180000, 1000000);
    state.startDayDiscussion();
    setClock(1000000 + 1000);
    const client = vi.fn().mockResolvedValue('欢迎来到白天。') as unknown as LlmClient;
    const host = new HostAgent(client, state, {});
    const ev = await host.announcePhaseTransition();
    expect(ev.type).toBe('host_announcement');
    expect(ev.visibleTo).toBeNull();
    expect(ev.payload.text).toBe('欢迎来到白天。');
  });

  it('falls back to a deterministic template when no budget remains', async () => {
    const { state, setClock } = makeState(180000, 1000000);
    state.startDayDiscussion();
    setClock(1000000 + 180000); // clock moved past the whole phase budget
    const host = new HostAgent(() => Promise.resolve('should not be used'), state, {});
    const ev = await host.announcePhaseTransition();
    expect(ev.type).toBe('host_announcement');
    expect(String(ev.payload.text)).toContain('白天讨论');
  });
});

describe('HostAgent.forceFinalCall', () => {
  it('records a host_final_call (template text when the LLM cannot run)', async () => {
    const { state, setClock } = makeState(180000, 1000000);
    state.startDayDiscussion();
    setClock(1000000 + 180000); // budget exhausted
    const client = vi.fn() as unknown as LlmClient;
    const host = new HostAgent(client, state, {});
    const ev = await host.forceFinalCall();
    expect(ev.type).toBe('host_final_call');
    expect(ev.visibleTo).toBeNull();
    expect(client).not.toHaveBeenCalled();
  });
});
