import { describe, expect, test } from "bun:test";
import { bashBlock, checkSlices, editTargets, endedAgents, sliceWarnings } from "./index";

// The edit tool has five wire contracts; the guard must see the file in every one of them,
// or the Captain edits the repository it is not allowed to touch.
describe("files a tool call would write", () => {
	test("hashline headers", () => {
		const input = { input: "[src/a.ts#1A2B]\nPUT 1.=1:\n+x\n[src/b.ts#C3D4]\nPUT 1*:\n+y" };
		expect(editTargets("edit", input)).toEqual(["src/a.ts", "src/b.ts"]);
	});

	test("replace and patch take a path", () => {
		expect(editTargets("edit", { path: "src/a.ts", old_string: "a", new_string: "b" })).toEqual(["src/a.ts"]);
		expect(editTargets("edit", { path: "src/a.ts", edits: [{ op: "update" }] })).toEqual(["src/a.ts"]);
	});

	test("apply_patch sections, including the move destination", () => {
		const input = {
			input: [
				"*** Begin Patch",
				"*** Add File: src/new.ts",
				"+x",
				"*** Update File: src/old.ts",
				"*** Move to: src/moved.ts",
				"@@",
				"-a",
				"+b",
				"*** Delete File: src/gone.ts",
				"*** End Patch",
			].join("\n"),
		};
		expect(editTargets("edit", input)).toEqual(["src/new.ts", "src/old.ts", "src/gone.ts", "src/moved.ts"]);
	});

	test("the apply_patch custom tool is the edit tool under another name", () => {
		const input = { input: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch" };
		expect(editTargets("apply_patch", input)).toEqual(["src/a.ts"]);
	});

	test("sloppy edit sections", () => {
		const input = { input: "*** Edit File: src/a.ts\n*** Find\na\n*** Replace\nb" };
		expect(editTargets("edit", input)).toEqual(["src/a.ts"]);
	});

	test("write takes a path and other tools write nothing", () => {
		expect(editTargets("write", { path: "src/a.ts", content: "x" })).toEqual(["src/a.ts"]);
		expect(editTargets("read", { path: "src/a.ts" })).toEqual([]);
		expect(editTargets("edit", {})).toEqual([]);
	});
});

describe("bash during a run", () => {
	const allowed = [
		"git log --oneline origin/main..HEAD",
		'git commit -m "make it build"',
		'bun "$(realpath skill://strategium)/todo.ts" --glyphs <<\'EOF\'\nMuster\n  captain: run bun test\nEOF',
		"git diff --stat 2>&1 | tail -3",
		"ls x > /dev/null",
		'git show HEAD > "$TEMP/agent-previews/x.diff"',
		"omp config set task.isolation.enabled true",
		"git worktree add ../r-worktrees/k-s1 -b b",
	];
	test.each(allowed)("allows %s", cmd => expect(bashBlock(cmd)).toBeUndefined());

	test.each(["bun test", "cd x && npm run build", "pnpm test", "npx tsc", "pytest -q"])("blocks the runner %s", cmd =>
		expect(bashBlock(cmd)).toContain("runs no builds or test suites"),
	);

	const writes = [
		"rm -f README.md",
		"echo x > src/a.ts",
		"cat a | tee b",
		"sed -i s/a/b/ f",
		"git checkout -- f",
		"git restore f",
		"git reset --hard",
		"git clean -fd",
		"git stash",
	];
	test.each(writes)("blocks the write %s", cmd => expect(bashBlock(cmd)).toContain("writes no files through bash"));
});

const RUNNER_MSG = "runs no builds or test suites";
const WRITE_MSG = "writes no files through bash";

describe("bash runners, every alternative", () => {
	const runners = [
		"bun test", "bun run build", "bunx tsc", "npx jest", "npm test", "npm t", "npm run x", "npm run-script x", "npm exec x", "npm build",
		"pnpm test", "yarn build", "tsc -p .", "jest", "vitest run", "pytest", "cargo test", "cargo build", "go test ./...", "go build",
		"gradle build", "mvn package", "dotnet test", "dotnet build", "playwright test",
		"a&&bun test", "(bun test)", "`bun test`", "x; bun test", "x | bun test",
		"bun.cmd test", "npm.cmd test", "pnpm.exe test", "npx.exe x", "bunx.exe x", "cargo.exe test", "go.exe test", "dotnet.exe build",
		"bun.exe test", "./node_modules/.bin/jest", "node_modules/.bin/tsc -p .", "/usr/bin/pytest", "C:\\tools\\bun.exe test", "node_modules\\.bin\\vitest.cmd run",
		"CI=1 bun test", "FOO=a BAR=b npx jest", "env NODE_ENV=test bun test", "time bun test", "exec pytest", "if bun test; then x; fi", "x\nbun test",
		"echo $(bun test)", "xargs jest", "timeout 60 bun test", "sudo npm test",
		"time -p bun test", "env -i bun test", "xargs -n1 jest",
		"while true; do bun test; done", "{ bun test; }", "! bun test", "nohup bun test", "if x; then bun test; fi",
		"if x; then :; else bun test; fi", "if x; then :; elif bun test; then :; fi", "until bun test; do :; done",
		"timeout -k 5 60 bun test", "xargs -I{} bun test",
		"nice bun test", "nice -n 5 bun test", "stdbuf -oL bun test", "setsid bun test", "doas npm test", "watch bun test",
	];
	test.each(runners)("blocks %s", cmd => expect(bashBlock(cmd)).toContain(RUNNER_MSG));

	test("a runner name inside a word or a quoted string is not a runner", () => {
		expect(bashBlock("echo tsconfig")).toBeUndefined();
		expect(bashBlock('git commit -m "run bun test"')).toBeUndefined();
		expect(bashBlock("echo 'a > b'")).toBeUndefined();
	});

	test("a runner name that is only an argument, a path component or a pattern is not a runner", () => {
		for (const cmd of [
			"cat jest.config.js", "grep -rn jest src", "rg tsc extensions", "git log -- src/tsc.ts", "cat src/tsc.ts", "git log -S tsc",
			"cat .github/workflows/playwright.yml", "head -5 ./jest", "ls node_modules/.bin/tsc", "echo bun test > /dev/null",
			"git show HEAD:src/tsc.ts", "git ls-files src/tsc", "ls tests/pytest", "cat ../x/mvn", "grep -n pytest README.md",
			"git log --grep jest", "find . -name 'jest*'", "cat docs/npm test.md", "ls vitest.config.ts", "git diff -- test/jest/a.ts", "bun.lock test",
			"command -v jest", "which tsc", "type pytest",
		]) expect([cmd, bashBlock(cmd)]).toEqual([cmd, undefined]);
	});
});

describe("bash writes, every pattern", () => {
	const writes = [
		"mv a b", "cp a b", "touch a", "truncate -s0 a", "ln -s a b", "rmdir d", "tee f",
		"x; rm a", "x & rm a", "(rm a)", "x\nrm a", "echo $(rm a)", "echo `rm a`", "x && mv a b", "x | tee f",
		"perl -i -pe s/a/b/ f", "perl -pi -e s/a/b/ f", "sed -ni p f", "sed --in-place s/a/b/ f",
		"git apply p.diff", "git am p.mbox", "git rm f", "git mv a b", "git checkout HEAD -- f",
		"cat <<EOF > src/a.ts\nx\nEOF", "echo x >& src/a.ts", "echo x >> src/a.ts", "echo x 2> src/a.ts",
		"git -C ../r reset --hard", "git -c core.x=1 clean -fd", "git -C d -c k=v stash", "git -C d restore f",
		"git --no-pager reset --hard", "git -p clean -fd",
		"git checkout .", "git checkout -- .",
		"git --git-dir=x reset --hard",
		'echo x > "src/a.ts"', "echo x >> 'src/a.ts'", "cp agent://x local://K-plan.md",
	];
	test.each(writes)("blocks %s", cmd => expect(bashBlock(cmd)).toContain(WRITE_MSG));

	const allowed = [
		"git add -A", "git switch main", "git merge --no-ff b", "git branch -D b", "git reset --soft origin/main", "git reset -q", "git reset",
		"git checkout main", "git checkout -b x", "git -C ../r log", "git -c k=v status", "git commit -m 'x'",
		'echo x > "${TEMP}/x"', "echo x > $TMP/x", "echo x > $TMPDIR/x", "echo x > /tmp/x", "echo x > %TEMP%/x", "echo x > out://x", "echo x > local://x", "cat agent://x > local://K-plan.md",
		"echo x >> /dev/null", "ls 2>&1", "ls 2>&1 >/dev/null", "ls 2>&-",
		"cat <<-EOF\n\tbun test > a\n\tEOF",
		"cat <<EOF\nrm -rf x > y\nEOF",
		"git checkout --detach",
		"cat <<EOF\nEOFX\nrm f\nEOF",
		"cat <<EOF\nx\nEOFX\nrm f\nEOF",
	];
	test.each(allowed)("allows %s", cmd => expect(bashBlock(cmd)).toBeUndefined());
});

describe("heredoc scan reads like the regex it replaced", () => {
	test.each([
		// the word shrinks to a terminator that exists: <<EOFX ends at the line EO, so the later bun test is a command
		'cat <<EOFX\nEOFX\necho "<<Z"\nEO\nbun test\nZ', "cat <<'EOF\nbun test\nEOF", "cat <<EOF\n\nEOF\nbun test\n",
	])("refuses %j", cmd => expect(bashBlock(cmd)).toContain(RUNNER_MSG));
	test("allows a spaced opener word", () => expect(bashBlock("cat << EOF\nbun test\nEOF")).toBeUndefined());
});

describe("checkSlices", () => {
	const s = (id: string, files: string[], parallel = true) => ({ id, parallel, files });
	test("a folder overlaps its files, a name prefix does not", () => {
		expect(checkSlices([s("A", ["src"]), s("B", ["src/a.ts"])])).toContain("both change src/a.ts (inside src).");
		expect(checkSlices([s("A", ["src/a.ts"]), s("B", ["src"])])).toContain("both change src/a.ts (inside src).");
		expect(checkSlices([s("A", ["src/a"]), s("B", ["src/ab"])])).toBeUndefined();
	});
	test("paths are normalised", () => {
		for (const f of ["./a", "a/", " a", "a\\"]) expect(checkSlices([s("A", ["a"]), s("B", [f])])).toContain("both change a.");
	});
	test("every shared file is named", () => {
		expect(checkSlices([s("A", ["x", "y", "w"]), s("B", ["z", "y", "w"])])).toContain("both change y, w.");
	});
	test("the error explains the risk and shows the list fixed", () => {
		const err = checkSlices([s("A", ["a"]), s("B", ["a", "b"])]);
		expect(err).toContain("overwrite each other's changes");
		expect(err).toContain('e.g. slices: [{"id":"A","parallel":true,"files":["a"]},{"id":"B","parallel":false,"files":["a","b"]}]');
		expect(err).toContain("If one of them has already finished, remove it from the list");
	});
	test("a squad whose agent stopped collides with nothing", () => {
		expect(checkSlices([s("A", ["a"]), s("B", ["a"])], [s("A", ["a"])])).toBeUndefined();
		expect(checkSlices([s("A", ["a"]), s("B", ["a"]), s("C", ["a"])], [s("A", ["a"])])).toContain("squads B and C");
	});
	test("sequential squads may share files", () => {
		expect(checkSlices([s("A", ["a"], false), s("B", ["a"])])).toBeUndefined();
		expect(checkSlices([s("A", ["a"], false), s("B", ["a"], false)])).toBeUndefined();
	});
	test("overlap is found between non-adjacent parallel squads", () => {
		expect(checkSlices([s("A", ["a"]), s("M", ["m"], false), s("B", ["a"])])).toContain("squads A and B");
	});
	test("overlap is found between non-adjacent parallel squads that are not neighbours in the parallel list either", () => {
		expect(checkSlices([s("A", ["a"]), s("B", ["b"]), s("C", ["a"])])).toContain("squads A and C");
	});
	test("the first error in the plan's order wins", () => {
		expect(checkSlices([])).toBe("declare at least one squad");
		expect(checkSlices([s(" ", [])])).toBe("every squad needs an id");
		expect(checkSlices([s("A", []), s("A", ["a"])])).toBe("squad A lists no files");
		expect(checkSlices([s("A", ["a"]), s("A", [])])).toBe("duplicate squad id A");
		expect(checkSlices([s("A", ["a"]), s("A", ["a"])])).toBe("duplicate squad id A");
	});
	test.skipIf(process.platform === "linux")("case folds off Linux", () => {
		expect(checkSlices([s("A", ["Alarm/Vox.ts"]), s("B", ["alarm/vox.ts"])])).toContain("both change alarm/vox.ts.");
	});
});

describe("sliceWarnings", () => {
	const s = (id: string, files: string[], parallel = true) => ({ id, parallel, files });
	test("no stopped slice, no warning", () => {
		expect(sliceWarnings([s("A", ["a"]), s("B", ["a"])], [])).toEqual([]);
	});
	test("a stopped squad still listed is to be removed, with the list fixed", () => {
		expect(sliceWarnings([s("A", ["a"]), s("B", ["a", "b"])], [s("A", ["a"])])).toEqual([
			'squad A is no longer active (its agent has stopped); sharing a with B is not a conflict. Remove it from the list, e.g. slices: [{"id":"B","parallel":true,"files":["a","b"]}].',
		]);
	});
	test("a new squad on the files of a stopped one is told to build on that work, and only that squad", () => {
		expect(sliceWarnings([s("B", ["a"]), s("C", ["c"])], [s("A", ["a"])])).toEqual([
			"squad B changes a, which squad A already changed and its agent has stopped. Tell B's agent what A changed there, so it builds on that work instead of undoing it.",
		]);
	});
	test("every live squad that shares files with a stopped one is named, each in its own warning", () => {
		expect(sliceWarnings([s("B", ["a"]), s("C", ["b"]), s("D", ["d"])], [s("A", ["a", "b"])])).toEqual([
			"squad B changes a, which squad A already changed and its agent has stopped. Tell B's agent what A changed there, so it builds on that work instead of undoing it.",
			"squad C changes b, which squad A already changed and its agent has stopped. Tell C's agent what A changed there, so it builds on that work instead of undoing it.",
		]);
	});
	test("a stopped squad still listed names every live squad it shares with", () => {
		expect(sliceWarnings([s("A", ["a", "b"]), s("B", ["a"]), s("C", ["b"])], [s("A", ["a", "b"])])).toEqual([
			'squad A is no longer active (its agent has stopped); sharing a with B and b with C is not a conflict. Remove it from the list, e.g. slices: [{"id":"B","parallel":true,"files":["a"]},{"id":"C","parallel":true,"files":["b"]}].',
		]);
	});
	test("with nothing live there is no example list", () => {
		expect(sliceWarnings([s("A", ["a"])], [s("A", ["a"])])).toEqual(["squad A is no longer active (its agent has stopped). Remove it from the list."]);
	});
	test("a stopped squad that shares nothing has no sharing note", () => {
		expect(sliceWarnings([s("A", ["a"]), s("B", ["b"])], [s("A", ["a"])])).toEqual([
			'squad A is no longer active (its agent has stopped). Remove it from the list, e.g. slices: [{"id":"B","parallel":true,"files":["b"]}].',
		]);
	});
});

describe("endedAgents", () => {
	test("reads task jobs that ended from completion messages and wait results, not running or other jobs", () => {
		const messages = [
			{ role: "custom", customType: "async-result", details: { jobs: [{ jobId: "j1", type: "task", status: "completed", label: "S1" }] } },
			{ role: "toolResult", details: { jobs: [{ id: "j2", type: "task", status: "failed", label: "S2-2" }, { id: "j3", type: "task", status: "running", label: "S3" }] } },
			{ role: "custom", details: { jobs: [{ jobId: "j4", type: "bash", status: "completed", label: "ls" }] } },
			{ role: "user", content: "hi" },
		];
		expect(endedAgents(messages)).toEqual(["S1", "S2-2"]);
	});
	test("a job without a text label and a missing message list end nothing", () => {
		const jobs = [{ jobId: "j1", type: "task", status: "completed" }, { jobId: "j2", type: "task", status: "completed", label: 5 }];
		expect(endedAgents([{ details: { jobs } }])).toEqual([]);
		expect(endedAgents(undefined)).toEqual([]);
	});
});

describe("runner binaries by path", () => {
	test.each(["./node_modules/.bin/jest", "node_modules/.bin/tsc -p .", "/usr/bin/pytest", "bun.exe test", "C:\\tools\\bun.exe test", "node_modules\\.bin\\vitest.cmd run", "./node_modules/.bin/npx.cmd tsc"])(
		"blocks %s",
		cmd => expect(bashBlock(cmd)).toContain(RUNNER_MSG),
	);
});

describe("checkSlices, a trailing slash", () => {
	test("a folder written with a trailing slash overlaps the files in it", () => {
		const s = (id: string, files: string[]) => ({ id, parallel: true, files });
		expect(checkSlices([s("A", ["src/"]), s("B", ["src/a.ts"])])).toContain("both change src/a.ts (inside src).");
	});
});

// #102: forms that hide a command from the list; each is refused like its bare command.
describe("bash forms that hide a command", () => {
	const runners = [
		"A+=x bun test", "A[0]=x bun test", "A[k]+=x bun test",
		"{fd}>/dev/null bun test", "<<< x bun test", "2>/dev/null bun test", "0<f bun test", "2>&1 bun test", "x; <<< y bun test",
		"timeout .5 bun test", "timeout 0.5s bun test", "timeout -k .5 1 bun test",
		"case x in x) bun test;; esac", "case $x in\n a|b) npm test ;;\n *) : ;;\nesac", "f() { bun test; }; f", "coproc bun test",
		"b\\un test", "\\bun test",
		"bun${IFS}test", "bun$IFS test", "npm$IFS$IFS run${IFS}x",
		"(tsc)", "x;(jest)", "(cd sub; tsc)", "x=$(cd d; jest)", "(./node_modules/.bin/tsc)", "(cd x; pytest)", "x\npytest)",
		"A=$((1+2)) bun test", "A=$IFS$(pwd) bun test", "timeout -s KILL .5 bun test", "case x in x ) bun test;; esac",
	];
	test.each(runners)("blocks the runner %s", cmd => expect(bashBlock(cmd)).toContain(RUNNER_MSG));

	const writes = [
		"A+=x rm f", "A[0]=x rm f", "A=1 B=2 rm f",
		"f() { rm f; }; f", "case x in x) rm f;; esac", "case x in\n a) :;;\n b) mv a b;;\nesac",
		"r\\m f", "\\rm f", "c\\p a b", "(cd x; rm)", "(echo; touch)", "case x in x ) rm f;; esac",
		"rm${IFS}f", "rm$IFS f", "cat <<< x\nrm f\nx",
	];
	test.each(writes)("blocks the write %s", cmd => expect(bashBlock(cmd)).toContain(WRITE_MSG));

	test.each([
		'echo "r\\m"', "grep -n 'bun test' f", "case x in x) echo hi;; esac", "case x in x) : ;; esac", "cat <<< x", 'echo "bun${IFS}test"', "echo '$IFS rm'",
		"echo $(date) tsc", "echo {rm,x}", "cat C:\\Users\\mark\\x", "echo $IFSrm", "cat <<< x > /dev/null",
		"timeout 5 sleep 1", "echo a[0]=x", "ls >out://x", "x=1",
	])("allows %s", cmd => expect(bashBlock(cmd)).toBeUndefined());

	// Linear by construction: tool_call handlers are synchronous, so a hostile command must not freeze omp.
	test.each([
		["assignments", "A[0]=x ".repeat(3000)], ["unclosed subscripts", "a[;".repeat(6000)], ["empty assignments", "a=;".repeat(6000)],
		["fd redirections", "{fd}> ".repeat(3000)], ["here-strings", "<<< ".repeat(5000)], ["digits", "1".repeat(20000)],
		["backslashes", "\\\\".repeat(10000)], ["backslash words", "\\a".repeat(10000)], ["ifs", "${IFS}".repeat(3000)], ["bare ifs", "$IFS".repeat(5000)],
		["case arms", ") ".repeat(10000)], ["arms", "x) ".repeat(6000)], ["in words", "in ".repeat(6000)], ["in arms", "in x) ".repeat(3000)],
		["braces", "{ ".repeat(10000)], ["timeouts", "timeout .5 ".repeat(1800)], ["dots", "timeout .".repeat(2200)],
		["lone words", "a".repeat(50000)], ["newlines", "\n".repeat(20000)], ["newlines then runner", "\n".repeat(20000) + " bun test"],
		["then lines", "then\n".repeat(4000)], ["timeout options", "timeout -k .;".repeat(1500)], ["wrapper options", "env -x;".repeat(2800)],
		["assign lines", "A=x\n".repeat(5000)], ["long digits", "1".repeat(50000)], ["git options", "git -c ".repeat(5000)],
		["assign equals", "a=b=".repeat(12500)], ["assign repeats", "A=x".repeat(16666)], ["git many options", "git -c a=b ".repeat(4500)],
		["heredoc openers", "<<x\n".repeat(12500)], ["closed-looking heredocs", "<<EOF\n".repeat(20000)],
		["keys then long openers", (() => { let s = ""; for (let l = 1; l <= 200; l++) s += "a".repeat(l - 1) + "b\n"; while (s.length < 50000) s += "<<" + "a".repeat(200) + "\n"; return s; })()],
	])("scans hostile %s in under 100 ms", (_name, cmd) => {
		const t0 = performance.now();
		bashBlock(cmd);
		expect(performance.now() - t0).toBeLessThan(100);
	});
});

describe("git with many global options (#102)", () => {
	test.each([`git ${"-c a=b ".repeat(9)}checkout .`, `git ${"-c a=b ".repeat(8)}checkout .`, `git ${"-c a=b ".repeat(30)}reset --hard`])(
		"blocks %s", cmd => expect(bashBlock(cmd)).toContain(WRITE_MSG));
	test("a plain git with options stays allowed", () => expect(bashBlock("git -C x log")).toBeUndefined());
});
