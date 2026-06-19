import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { webEnv } from "@/env/web";

const RATE_LIMIT_MAX_REQUESTS = 100;
const RATE_LIMIT_WINDOW_MS = 60_000;

type InMemoryRateLimitEntry = {
	count: number;
	resetAt: number;
};

const inMemoryRateLimitStore = new Map<string, InMemoryRateLimitEntry>();

let didLogRateLimitFallback = false;
let remoteRateLimitAvailable = !isPlaceholderUpstashConfig();

const redis = remoteRateLimitAvailable
	? new Redis({
			url: webEnv.UPSTASH_REDIS_REST_URL,
			token: webEnv.UPSTASH_REDIS_REST_TOKEN,
		})
	: null;

const baseRateLimit = redis
	? new Ratelimit({
			redis,
			limiter: Ratelimit.slidingWindow(RATE_LIMIT_MAX_REQUESTS, "1 m"),
			analytics: true,
			prefix: "rate-limit",
		})
	: null;

function isPlaceholderUpstashConfig() {
	return (
		webEnv.UPSTASH_REDIS_REST_TOKEN === "example_token" ||
		webEnv.UPSTASH_REDIS_REST_URL === "http://localhost:8079"
	);
}

function logRateLimitFallback(error?: unknown) {
	if (didLogRateLimitFallback) return;
	didLogRateLimitFallback = true;
	console.warn(
		"[rate-limit] Falling back to in-memory rate limiting because Upstash Redis is unavailable or misconfigured.",
		error,
	);
}

function checkInMemoryRateLimit(ip: string) {
	const now = Date.now();
	const entry = inMemoryRateLimitStore.get(ip);

	if (!entry || entry.resetAt <= now) {
		inMemoryRateLimitStore.set(ip, {
			count: 1,
			resetAt: now + RATE_LIMIT_WINDOW_MS,
		});
		return { success: true, limited: false };
	}

	entry.count += 1;
	return {
		success: entry.count <= RATE_LIMIT_MAX_REQUESTS,
		limited: entry.count > RATE_LIMIT_MAX_REQUESTS,
	};
}

export async function checkRateLimit({ request }: { request: Request }) {
	const forwardedFor = request.headers.get("x-forwarded-for");
	const ip = forwardedFor?.split(",")[0]?.trim() || "anonymous";

	if (!baseRateLimit || !remoteRateLimitAvailable) {
		logRateLimitFallback();
		return checkInMemoryRateLimit(ip);
	}

	try {
		const { success } = await baseRateLimit.limit(ip);
		return { success, limited: !success };
	} catch (error) {
		remoteRateLimitAvailable = false;
		logRateLimitFallback(error);
		return checkInMemoryRateLimit(ip);
	}
}
