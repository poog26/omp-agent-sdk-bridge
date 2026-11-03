// Maps Claude Code's usage report onto OMP's Usage and prices it with OMP's own cost
// function, so the footer and stats price bridge turns exactly as they price any other
// model. The cost is an API-equivalent estimate: a subscription doesn't bill per token,
// but it's the figure the same usage would cost on the API.

export interface TokenPrice {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	longContext?: unknown;
	timeBased?: unknown;
}

/** Anything priced per million tokens: a registered model's `cost`, OMP's calculateCost. */
export type PriceFn = (model: { cost: TokenPrice }, usage: UsageTarget) => unknown;

export interface UsageTarget {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cttl?: { ephemeral5m?: number; ephemeral1h?: number };
	reasoning?: number;
}

type Report = Record<string, unknown>;

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Write Claude Code's cumulative usage snapshot into `target` and price it. Each snapshot
 * replaces the previous one, since Claude Code reports running totals per message.
 * Returns the reasoning-token count when Claude Code reports one.
 */
export function applyClaudeUsage(
	target: UsageTarget,
	report: Report,
	model: { cost: TokenPrice },
	price: PriceFn,
): number | undefined {
	const input = count(report.input_tokens);
	const output = count(report.output_tokens);
	const cacheRead = count(report.cache_read_input_tokens);
	const cacheWrite = count(report.cache_creation_input_tokens);
	if (input !== undefined) target.input = input;
	if (output !== undefined) target.output = output;
	if (cacheRead !== undefined) target.cacheRead = cacheRead;
	if (cacheWrite !== undefined) target.cacheWrite = cacheWrite;

	// The 5-minute and 1-hour cache writes bill at different rates, so OMP prices them
	// separately when Claude Code reports the split.
	const creation = report.cache_creation as Report | null | undefined;
	if (creation && typeof creation === "object") {
		const fiveMinute = count(creation.ephemeral_5m_input_tokens) ?? 0;
		const oneHour = count(creation.ephemeral_1h_input_tokens) ?? 0;
		if (fiveMinute > 0 || oneHour > 0) {
			target.cttl = {
				...(fiveMinute > 0 ? { ephemeral5m: fiveMinute } : {}),
				...(oneHour > 0 ? { ephemeral1h: oneHour } : {}),
			};
		} else {
			delete target.cttl;
		}
	}

	const reasoning = count(report.reasoning_tokens) ?? count(report.thinking_tokens);
	if (reasoning !== undefined) target.reasoning = reasoning;
	target.totalTokens = target.input + target.output + target.cacheRead + target.cacheWrite;
	price(model, target);
	return reasoning;
}
