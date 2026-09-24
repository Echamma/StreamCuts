/** Real-browser OfflineAudioContext regression for FAIR-005. Run with `bun scripts/test-audio-dynamics.ts`. */
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const playwrightRoot =
	process.platform === "win32"
		? join(homedir(), "AppData", "Local", "ms-playwright")
		: join(homedir(), ".cache", "ms-playwright");
const playwrightChromes = existsSync(playwrightRoot)
	? readdirSync(playwrightRoot)
			.filter((name) => name.startsWith("chromium_headless_shell-"))
			.sort()
			.reverse()
			.map((name) =>
				join(
					playwrightRoot,
					name,
					...(process.platform === "win32"
						? ["chrome-headless-shell-win64", "chrome-headless-shell.exe"]
						: ["chrome-linux", "headless_shell"]),
				),
			)
	: [];
const candidates = [
	process.env.CHROME_BIN,
	...playwrightChromes,
	"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"/usr/bin/chromium",
	"/usr/bin/google-chrome",
].filter((value): value is string => typeof value === "string");
const browser = candidates.find(existsSync);
if (!browser)
	throw new Error(
		"Set CHROME_BIN to Chrome or Edge to run the offline audio test.",
	);

const tempRoot = resolve(tmpdir());
const temp = mkdtempSync(join(tempRoot, "streamcuts-audio-dynamics-"));
try {
	const entry = resolve(
		"apps/web/src/media/__tests__/audio-dynamics.browser.ts",
	);
	const built = await Bun.build({
		entrypoints: [entry],
		target: "browser",
		outdir: temp,
	});
	if (!built.success) throw new Error(built.logs.map(String).join("\n"));
	const bundle = built.outputs[0];
	const script = readFileSync(bundle.path, "utf8");
	const html = join(temp, "index.html");
	writeFileSync(
		html,
		`<html><body>RUNNING<script>${script}</script></body></html>`,
	);
	const command = [
		browser,
		"--headless=new",
		"--no-sandbox",
		"--disable-gpu",
		"--no-first-run",
		"--allow-file-access-from-files",
		`--user-data-dir=${join(temp, "profile")}`,
		"--virtual-time-budget=20000",
		"--dump-dom",
		html,
	];
	const result = Bun.spawnSync(command, {
		stdout: "pipe",
		stderr: "pipe",
		timeout: 30000,
	});
	const output = new TextDecoder().decode(result.stdout);
	if (!output.includes("AUDIO_DYNAMICS_PASS")) {
		throw new Error(
			`Offline browser test failed (${result.exitCode}): ${output.slice(-2000)}\n${new TextDecoder().decode(result.stderr).slice(-1000)}`,
		);
	}
	console.log("FAIR-005 offline audio dynamics: passed");
} finally {
	if (
		!resolve(temp).startsWith(tempRoot + "\\") &&
		!resolve(temp).startsWith(tempRoot + "/")
	) {
		throw new Error("Refusing to remove an unexpected temp directory");
	}
	rmSync(temp, { recursive: true, force: true });
}
