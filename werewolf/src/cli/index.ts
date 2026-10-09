#!/usr/bin/env node
/**
 * werewolf-cli - play a hosted werewolf game from the terminal (plan task 10).
 *
 * Usage:
 *   werewolf-cli join <url> --room <id> --name <n> [--seat <n>] [--watch]
 *
 * Prints lobby and phase events to stdout. When you hold a human seat and
 * --watch is not set, each stdin line is sent as a seat_action: plain text is
 * sent as a speech string, a JSON line as a structured AgentAction.
 * --watch suppresses the stdin prompt (spectator mode for LLM-only games).
 */
import { WerewolfClient } from '../transport/client';
import type { AgentAction } from '../engine/types';
import type { ServerMsg } from '../transport/protocol';

interface CliOptions {
  url: string;
  room: string;
  name: string;
  seat?: string;
  watch: boolean;
}

function usage(): never {
  console.error('usage: werewolf-cli join <url> --room <id> --name <n> [--seat <n>] [--watch]');
  process.exit(1);
}

export function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] !== 'join') usage();
  const url = args[1];
  if (!url) usage();
  let room = '';
  let name = '';
  let seat: string | undefined;
  let watch = false;
  for (let i = 2; i < args.length; i++) {
    const a = args[i];
    if (a === '--room') {
      const v = args[++i];
      if (v === undefined) usage();
      room = v;
    } else if (a === '--name') {
      const v = args[++i];
      if (v === undefined) usage();
      name = v;
    } else if (a === '--seat') {
      const v = args[++i];
      if (v === undefined) usage();
      seat = v;
    } else if (a === '--watch') {
      watch = true;
    } else usage();
  }
  if (!room || !name) usage();
  return { url, room, name, seat, watch };
}

function describeSeat(seatId: string, name: string, role: string | undefined, you: string | null): string {
  let out = seatId + (role ? '(' + role + ')' : '') + ':' + name;
  if (you !== null && seatId === you) out += ' (you)';
  return out;
}

export async function main(argv: string[]): Promise<void> {
  const o = parseArgs(argv);
  const client = new WerewolfClient(o.url);
  client.on('lobby_update', (d) => {
    const m = d as ServerMsg;
    const you = m.seatId ?? null;
    const seats = (m.room?.seats ?? [])
      .map((s) => describeSeat(s.seatId, s.name, s.role?.roleId, you))
      .join(' ');
    console.log('[lobby] ' + (m.room?.status ?? '?') + ' - ' + seats);
  });
  client.on('phase_event', (d) => {
    const m = d as ServerMsg;
    const e = m.event;
    if (!e) return;
    console.log('[event] ' + e.type + ' ' + JSON.stringify(e.payload));
    if (e.type === 'phase_change' && (e.payload as { phase?: string }).phase === 'finished') {
      console.log('[event] game over - ' + JSON.stringify(e.payload));
      void client.close();
    }
  });
  client.on('chat', (d) => {
    const m = d as ServerMsg;
    if (m.event) console.log('[chat] ' + JSON.stringify(m.event.payload));
  });
  client.on('error', (d) => {
    const m = d as ServerMsg;
    console.error('[error] ' + (m.message ?? 'unknown error'));
  });

  const seatId = await client.join(o.room, o.name, o.seat);
  console.log('joined ' + o.room + ' as ' + seatId + (client.token ? ' (reconnect token stored)' : ''));

  if (o.watch) {
    console.log('watching as spectator - Ctrl-C to quit');
  } else {
    const readline = await import('node:readline');
    const rl = readline.createInterface({ input: process.stdin, terminal: process.stdin.isTTY === true });
    console.log('type a line and press Enter: plain text = speech, JSON = AgentAction (e.g. {"action":"pass","targets":[]}), q = quit');
    rl.on('line', (line) => {
      const t = line.trim();
      if (!t) return;
      if (t === 'q' || t === 'quit') {
        rl.close();
        void client.close();
        return;
      }
      let payload: AgentAction | string = t;
      if (t.startsWith('{')) {
        try {
          const parsed = JSON.parse(t) as Record<string, unknown>;
          if (typeof parsed.action !== 'string') throw new Error('missing "action" field');
          payload = parsed as unknown as AgentAction;
        } catch (err) {
          console.error('bad JSON: ' + (err instanceof Error ? err.message : String(err)));
          return;
        }
      }
      client
        .send(payload)
        .then(() => console.log('-> sent'))
        .catch((err: unknown) => console.error('send failed: ' + (err instanceof Error ? err.message : String(err))));
    });
    rl.on('close', () => {
      void client.close();
    });
  }

  process.on('SIGINT', () => {
    console.error('\nbye');
    void client.close().then(() => process.exit(0));
  });
}

// Run main() only when invoked as the bin (not when the module is imported).
const argv1 = process.argv[1] ?? '';
const isMain = argv1.endsWith('cli/index.js') || argv1.endsWith('cli/index.ts');
if (isMain) {
  main(process.argv).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
