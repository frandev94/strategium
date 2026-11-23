// Dev-only test extension for tools/tui-shot (see .omp/skills/strategium-tui-shot). Never shipped: not in package.json (tsconfig type-checks it).
// Inert unless STRATEGIUM_REPLAY_DIR is set. A fake model provider makes the real agent loop call the real `ask` tool: no network, no cost.
// Log: <dir>/replay.log, JSONL {ev: input|tool_call|tool_result|stream|select, ...}.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const FORM =
	'<form><p>REPLAY: pick one</p><select name="pick"><option>Yes</option><option>No</option></select></form>';

type Block = { type?: string; text?: string };
type Msg = { role: string; content?: string | Block[] };

const textOf = (m: Msg | undefined): string =>
	typeof m?.content === "string"
		? m.content
		: (m?.content ?? []).map(b => (b.type === "text" ? (b.text ?? "") : "")).join("");

export default function (pi: ExtensionAPI) {
	const dir = process.env.STRATEGIUM_REPLAY_DIR;
	if (!dir) return;
	const log = (rec: Record<string, unknown>) => appendFileSync(join(dir, "replay.log"), `${JSON.stringify(rec)}\n`);

	// Duck-typed AssistantMessageEventStream: the loop only does for-await (agent-loop.ts:2295) and result() (:2354).
	const stream = (events: unknown[], final: unknown) => ({
		async *[Symbol.asyncIterator]() {
			yield* events;
		},
		result: async () => final,
	}) as never; // duck-typed stream: the real AssistantMessageEventStream class is not constructible here

	pi.registerProvider("replay", {
		api: "strategium-replay",
		baseUrl: "http://127.0.0.1:9", // never called
		apiKey: "replay",
		models: [
			{
				id: "ask",
				name: "Replay (fake)",
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100000,
				maxTokens: 4096,
			},
		],
		streamSimple: (model, context, options) => {
			const out = (content: unknown[], stopReason: "stop" | "toolUse") => ({
				role: "assistant",
				content,
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason,
				timestamp: Date.now(),
			});
			const done = (message: { stopReason: string }) =>
				stream([{ type: "start", partial: out([], "stop") }, { type: "done", reason: message.stopReason, message }], message);
			const text = (t: string) => done(out([{ type: "text", text: t }], "stop"));

			const msgs = context.messages as Msg[];
			const last = msgs[msgs.length - 1];
			if (last?.role === "toolResult") return text(`REPLAY-ANSWER ${textOf(last).slice(0, 200)}`);
			// Side turns (title...) carry no tools: they get plain text, only the main turn waits and calls ask.
			const names = (context.tools ?? []).map(t => t.name);
			const ending = textOf(last).trimEnd().endsWith("replay-end");
			if (last?.role !== "user" || !(ending || textOf(last).trimEnd().endsWith("replay-ask")) || !names.length) return text("replay");

			// ask is a discoverable device when tools.xdev is on (tools/ask.ts:371): then it is `write xd://ask`. The strategium tool is not a model tool here: its bash command form ends the run.
			const call = ending
				? { name: "bash", arguments: { command: `strategium -j '${JSON.stringify({ action: "end" })}'` } }
				: names.includes("ask")
					? { name: "ask", arguments: { html: FORM } }
					: { name: "write", arguments: { path: "xd://ask", content: JSON.stringify({ html: FORM }) } };
			const message = out([{ type: "toolCall", id: "replay-ask-1", ...call }], "toolUse");
			async function* events() {
				const start = { type: "start", partial: out([], "toolUse") };
				yield start;
				log({ ev: "stream", phase: "start", names });
				while (!existsSync(join(dir!, "go"))) {
					if (options?.signal?.aborted) return;
					await sleep(100);
				}
				log({ ev: "stream", phase: "go", via: call.name });
				const toolCall = message.content[0];
				yield { type: "toolcall_start", contentIndex: 0, partial: message };
				yield { type: "toolcall_end", contentIndex: 0, toolCall, partial: message };
				yield { type: "done", reason: "toolUse", message };
			}
			return { [Symbol.asyncIterator]: events, result: async () => message } as never;
		},
	});

	pi.on("session_start", (_e, ctx) => {
		ctx.ui.onTerminalInput(data => {
			log({ ev: "input", data });
			return undefined; // never consume
		});
	});
	pi.on("tool_call", e => void log({ ev: "tool_call", name: e.toolName }));
	pi.on("tool_result", e =>
		void log({ ev: "tool_result", name: e.toolName, isError: e.isError, text: textOf({ role: "", content: e.content }) }),
	);

	pi.registerCommand("replay-select", {
		description: "Replay: open ctx.ui.select after 3 s",
		handler: async (_args, ctx) => {
			ctx.setTimeout(async () => log({ ev: "select", value: await ctx.ui.select("REPLAY select", ["Yes", "No"]) ?? null }), 3000);
		},
	});
}
