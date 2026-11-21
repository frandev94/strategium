import { describe, expect, test } from "bun:test";
import { bashBlock, checkSlices, editTargets, endedAgents, remoteBlock, remoteTargets, sliceWarnings } from "./index";

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

describe("remoteTargets: bash", () => {
	const hosts = (cmd: string) => remoteTargets("bash", { command: cmd })?.targets;
	test.each([
		["ssh h", ["h"]],
		["ssh -p 22 -J j1 u@h cmd", ["h", "j1"]],
		["ssh -p22 -i key -o StrictHostKeyChecking=no U@Box.Example.com uptime", ["box.example.com"]],
		["ssh -J a,b h", ["h", "a", "b"]],
		["ssh user@[::1] ls", ["::1"]],
		["ssh ssh://u@H:2222/x", ["h"]],
		["scp a u@h:/x", ["h"]],
		["scp h1:/a h2:/b", ["h1", "h2"]],
		["scp -P 22 -o Foo=a:b a box:/x", ["box"]],
		["rsync -e \"ssh -p 2\" a box:/x", ["box"]],
		["rsync -avz a/ u@h::mod", ["h"]],
		["rsync rsync://H/mod/ .", ["h"]],
		["sftp h", ["h"]],
		["sftp -P 2222 u@h:/dir", ["h"]],
		["ansible-playbook -i inv.yml site.yml", ["inv.yml"]],
		["ansible all -i h1,h2, -m ping", ["h1", "h2"]],
		["ansible-playbook --inventory=inv/prod.ini site.yml", ["inv/prod.ini"]],
		["ansible-playbook site.yml", [""]],
		["ssh $HOST uptime", [""]],
	])("%s reaches %j", (cmd, expected) => expect(hosts(cmd)).toEqual(expected));

	test("every command word is found behind env, sudo, VAR=x, a path, .exe and inside $( )", () => {
		for (const cmd of [
			"env FOO=1 ssh h",
			"sudo ssh h",
			"FOO=1 BAR=2 ssh h",
			"time ssh h",
			"/usr/bin/ssh h",
			"C:\\Windows\\System32\\OpenSSH\\ssh.exe h",
			"ssh.exe h",
			"echo $(ssh h)",
			"echo `ssh h`",
			"cd x && ssh h",
			"ls | xargs ssh h",
			"if true; then ssh h; fi",
			"echo hi\nssh h",
			"timeout 5 ssh h",
		])
			expect(remoteTargets("bash", { command: cmd })?.targets).toContain("h");
		for (const word of ["scp", "sftp", "rsync", "ansible-playbook", "ansible"]) {
			const arg = word.startsWith("ansible") ? "-i h" : "box:/x";
			expect(remoteTargets("bash", { command: `sudo ${word} ${arg}` })).toBeDefined();
		}
	});

	test("via names the command", () => {
		expect(remoteTargets("bash", { command: "ssh h" })?.via).toBe("ssh");
		expect(remoteTargets("bash", { command: "ansible-playbook -i x site.yml" })?.via).toBe("ansible-playbook without --check");
	});

	test("ansible that only checks or lists is not remote", () => {
		for (const flag of ["--check", "-C", "--syntax-check", "--list-hosts", "--list-tasks", "--list-tags", "--version"])
			expect(hosts(`ansible-playbook -i inv.yml ${flag} site.yml`)).toBeUndefined();
	});

	test("property 1: command words only inside quotes, a heredoc or as an argument reach nothing", () => {
		for (const cmd of [
			"ssh-keygen -t ed25519",
			"ssh-add key",
			"sshfs box:/x /mnt",
			"echo ssh h",
			"echo 'ssh h'",
			"echo \"x; scp a box:/x\"",
			"echo 'x; ssh h'",
			"grep ssh file",
			"grep -r 'rsync a box:/x' .",
			"cat <<EOF\nssh h\nscp a box:/b\nEOF",
			"cat <<'EOF' > notes.txt\nrsync a box:/b\nEOF",
			"git clone ssh://git@github.com/a/b.git",
			"git push",
			"git remote add o ssh://h/r",
			"rsync a/ b/",
			"rsync -av src dst",
			"scp C:\\a D:\\b",
			"scp ./a ./b",
			"ssh -V",
			"ssh",
			"ls",
			"",
		])
			expect(remoteTargets("bash", { command: cmd })).toBeUndefined();
	});

	test("a quoted segment does not end the command, so a command after it is still seen", () => {
		expect(hosts("echo 'a;b'; ssh h")).toEqual(["h"]);
	});

	test("a heredoc opener line still runs its command", () => {
		expect(hosts("ssh h <<EOF\nls\nEOF")).toEqual(["h"]);
	});

	test("several remote commands name every target", () => {
		expect(hosts("ssh a uptime; scp x bb:/y")).toEqual(["a", "bb"]);
	});
});

describe("remoteTargets: ssh:// in path fields", () => {
	test.each([
		["read", { path: "ssh://u@H:2222/x" }, ["h"]],
		["write", { path: "ssh://h/x", content: "ssh://other/y" }, ["h"]],
		["grep", { pattern: "x", path: "src;ssh://h/x" }, ["h"]],
		["glob", { path: "ssh://h/**" }, ["h"]],
		["read", { path: "SSH://h/x" }, ["h"]],
		["edit", { input: "[ssh://h/etc/f#1A2B]\nPUT 1.=1:\n+x" }, ["h"]],
		["edit", { path: "ssh://h/f", old_string: "a", new_string: "b" }, ["h"]],
		["anything", { paths: ["a.ts", "ssh://h1/x", "ssh://h2/y"] }, ["h1", "h2"]],
		["anything", { file: "ssh://h/x" }, ["h"]],
	])("%s %j reaches %j", (name, input, expected) => {
		const hit = remoteTargets(name, input);
		expect(hit?.targets).toEqual(expected);
		expect(hit?.via).toBe("ssh://");
	});

	test("bare ssh://, local paths and file content reach nothing", () => {
		expect(remoteTargets("read", { path: "ssh://" })).toBeUndefined();
		expect(remoteTargets("grep", { path: "ssh://;src" })).toBeUndefined();
		expect(remoteTargets("read", { path: "src/a.ts" })).toBeUndefined();
		expect(remoteTargets("write", { path: "a.txt", content: "ssh://h/x" })).toBeUndefined();
		expect(remoteTargets("read", { path: "xd://eval" })).toBeUndefined();
	});

	test("ssh://h in a bash command that is not ssh stays local", () => {
		expect(remoteTargets("bash", { command: "echo ssh://h/x", path: "ssh://h/x" })).toBeUndefined();
	});
});

describe("remoteBlock", () => {
	const ssh = { command: "ssh h" };
	test("an undeclared target is refused with the sub and Captain wording", () => {
		const sub = remoteBlock({}, "sub", "bash", ssh);
		expect(sub).toContain("agents reach no remote machine during a run (ssh h)");
		expect(sub).toContain("strategium action targets");
		const captain = remoteBlock({}, "captain", "bash", ssh);
		expect(captain).toContain("the Captain reaches no remote machine before the Apply seal");
		expect(captain).toContain("strategium action apply");
	});

	test("an unreadable target reads an unnamed host and is never declared", () => {
		expect(remoteBlock({ targets: [""] }, "sub", "bash", { command: "ansible-playbook site.yml" })).toContain("an unnamed host");
		expect(remoteBlock({ targets: [""] }, "captain", "bash", { command: "ssh $H" })).toContain("an unnamed host");
	});

	test("a declared throwaway target passes for both, case and user@ insensitive", () => {
		const run = { targets: ["Box", "u@other:22"] };
		expect(remoteBlock(run, "sub", "bash", { command: "ssh root@BOX" })).toBeUndefined();
		expect(remoteBlock(run, "captain", "read", { path: "ssh://box/x" })).toBeUndefined();
		expect(remoteBlock(run, "sub", "bash", { command: "scp a other:/x" })).toBeUndefined();
	});

	test("every target must be declared", () => {
		expect(remoteBlock({ targets: ["box"] }, "sub", "bash", { command: "ssh -J j box" })).toContain("(ssh j)");
	});

	test("applied hosts pass for the Captain only", () => {
		const run = { applied: ["h"] };
		expect(remoteBlock(run, "captain", "bash", ssh)).toBeUndefined();
		expect(remoteBlock(run, "sub", "bash", ssh)).toContain("agents reach no remote machine");
		expect(remoteBlock(run, "captain", "bash", { command: "ssh g" })).toContain("Apply");
	});

	test("a call that reaches nothing remote passes", () => {
		expect(remoteBlock({}, "sub", "bash", { command: "ls" })).toBeUndefined();
		expect(remoteBlock({}, "captain", "read", { path: "src/a.ts" })).toBeUndefined();
	});

	test("property 2: a superset of declarations never blocks what a subset allowed; sub allowed implies Captain allowed", () => {
		const calls: [string, Record<string, unknown>][] = [
			["bash", { command: "ssh h" }],
			["bash", { command: "ssh -J j h" }],
			["bash", { command: "scp a u@h:/x; rsync b u@g:/y" }],
			["bash", { command: "ansible-playbook site.yml" }],
			["read", { path: "ssh://h/x" }],
			["grep", { path: "a;ssh://g/x" }],
			["bash", { command: "ls" }],
		];
		const decls = [{}, { targets: ["h"] }, { targets: ["h", "j"] }, { targets: ["h", "j", "g"] }, { applied: ["h", "g"] }, { targets: ["h", "j"], applied: ["g"] }];
		for (const [name, input] of calls)
			for (const a of decls)
				for (const b of decls) {
					const sup = { targets: [...(a.targets ?? []), ...(b.targets ?? [])], applied: [...(a.applied ?? []), ...(b.applied ?? [])] };
					for (const who of ["sub", "captain"] as const) if (!remoteBlock(a, who, name, input)) expect(remoteBlock(sup, who, name, input)).toBeUndefined();
				}
		for (const [name, input] of calls) for (const d of decls) if (!remoteBlock(d, "sub", name, input)) expect(remoteBlock(d, "captain", name, input)).toBeUndefined();
	});

	test("property 3: no input throws, whatever its shape or size", () => {
		const odd: unknown[] = [undefined, null, 0, "x", [], [1], true, { command: 5 }, { command: null }, { path: 5 }, { path: ["ssh://h"] }, { paths: "ssh://h" }, { paths: [null, 3, {}] }, { file: {} }, { input: 5 }, { command: "ssh" }];
		for (const input of odd)
			for (const name of ["bash", "read", "edit", "write", "grep", "", "task"]) {
				expect(() => remoteTargets(name, input as never)).not.toThrow();
				expect(() => remoteBlock({}, "sub", name, input as never)).not.toThrow();
				expect(() => remoteBlock({}, "captain", name, input as never)).not.toThrow();
			}
		expect(() => remoteTargets(5 as never, { command: "ssh h" })).not.toThrow();
		expect(() => remoteBlock({ targets: [5 as never, null as never] }, "sub", "bash", { command: "ssh h" })).not.toThrow();
		const noise = ["'", '"', "\\", "<<", "<<EOF", "$(", "`", ";", "&", "|", "ssh ", "scp ", "-J", "[", "]", ":", "@", "\n", " ", "ansible-playbook ", "ssh://"];
		let seed = 7;
		const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
		for (let i = 0; i < 400; i++) {
			const command = Array.from({ length: 1 + rnd(40) }, () => noise[rnd(noise.length)]).join("");
			expect(() => remoteBlock({}, "captain", "bash", { command })).not.toThrow();
		}
	});

	test("long hostile strings finish quickly", () => {
		const t = performance.now();
		for (const command of ["a=b ".repeat(20000), ";a=b ".repeat(20000), "'".repeat(50001), "ssh ".repeat(20000), "\"a ".repeat(20000) + "ssh h", "(".repeat(50000)])
			remoteTargets("bash", { command });
		expect(performance.now() - t).toBeLessThan(3000);
	});
});

describe("remoteTargets: review findings", () => {
	const hosts = (cmd: string) => remoteTargets("bash", { command: cmd })?.targets;
	test.each([
		['out="$(ssh h ls)"', ["h"]],
		['echo "$(ssh h ls)"', ["h"]],
		['echo "`ssh h ls`"', ["h"]],
		['echo "$(echo "x; ssh h")"', undefined],
		['echo "x; ssh h"', undefined],
		["echo 'x; ssh h'", undefined],
		["echo '$(ssh h)'", undefined],
		["rsync -a C:/a/ C:/b/", undefined],
		["scp C:/a D:/b", undefined],
		["rsync -a C:\\a\\ C:\\b\\", undefined],
		["# don't\nssh h\necho 'x'", ["h"]],
		["echo a #b ssh h", undefined],
		["sudo -u root ssh h", ["h"]],
		["env -u FOO ssh h", ["h"]],
		["timeout -s KILL 10 ssh h", ["h"]],
		["sudo -n ssh h", ["h"]],
		["command ssh h", ["h"]],
		["builtin ssh h", ["h"]],
		["eval ssh h", ["h"]],
		["sshpass -p x ssh h", ["h"]],
		["2>/dev/null ssh h", ["h"]],
		["ssh -o ProxyJump=j h", ["h", "j"]],
		["ssh -o 'ProxyJump j' h", ["h", "j"]],
		["ssh -J j h", ["h", "j"]],
		["SSH h", ["h"]],
		["ssh -V > v.txt", undefined],
		["ssh -V >v.txt", undefined],
		["ssh h\\\n uptime", ["h"]],
		["ssh -- -p box", ["-p"]],
		["scp -- -a box:/x", ["box"]],
		['scp "a;b" box:/x', ["box"]],
		["rsync --exclude 'a:b' a/ b/", undefined],
		["rsync --filter 'x:y' a/ box:/b", ["box"]],
		["rsync a box:/x >out:log", ["box"]],
		["ssh -o x 2>&1 box", ["box"]],
		["ssh box 2>/dev/null", ["box"]],
		["rsync rsync://H/mod/ .", ["h"]],
		["rsync -e ssh a box:/x", ["box"]],
	])("%s reaches %j", (cmd, expected) => expect(hosts(cmd)).toEqual(expected));

	test("a declared host passes through redirects", () => {
		for (const command of ["ssh -o x 2>&1 box", "ssh box 2>/dev/null"]) expect(remoteBlock({ targets: ["box"] }, "sub", "bash", { command })).toBeUndefined();
	});

	test("a single-letter host written with a colon and a slash is a drive, not a host", () => {
		expect(hosts("scp box:/x c:/y")).toEqual(["box"]);
	});

	test("an unterminated heredoc is not hidden: the lines after it still run", () => {
		expect(hosts("cat <<EOF\nssh h")).toEqual(["h"]);
	});

	test("a here-string is not a heredoc", () => {
		expect(hosts("cat <<<x\nssh h\nx")).toEqual(["h"]);
	});
});

describe("the guards stay linear on heredoc openers", () => {
	test("200 KB of unterminated openers is scanned quickly by both guards", () => {
		const command = "<<A\n".repeat(50000);
		let t = performance.now();
		remoteTargets("bash", { command });
		expect(performance.now() - t).toBeLessThan(500);
		t = performance.now();
		bashBlock(command);
		expect(performance.now() - t).toBeLessThan(500);
	});

	test("200 KB of terminated heredocs is scanned quickly by both guards", () => {
		const command = "cat <<A\nx\nA\n".repeat(17000);
		let t = performance.now();
		remoteTargets("bash", { command });
		expect(performance.now() - t).toBeLessThan(500);
		t = performance.now();
		bashBlock(command);
		expect(performance.now() - t).toBeLessThan(500);
	});

	test("a terminated heredoc body is data, an unterminated one is not", () => {
		expect(bashBlock("cat <<EOF\nbun test\nEOF")).toBeUndefined();
		expect(bashBlock("cat <<EOF\nbun test")).toBeDefined();
	});
});

describe("bashBlock: review findings", () => {
	test("a runner behind sudo -u root is blocked", () => {
		expect(bashBlock("sudo -u root bun test")).toBeDefined();
		expect(bashBlock("sudo -n bun test")).toBeDefined();
	});

	test("an apostrophe in a comment does not hide the next line", () => {
		expect(bashBlock("# don't\nbun test\necho 'x'")).toBeDefined();
	});

	test("a runner inside $( ) in double quotes is seen, a quoted word is not", () => {
		expect(bashBlock('echo "$(bun test)"')).toBeDefined();
		expect(bashBlock('echo "bun test"')).toBeUndefined();
		expect(bashBlock("echo 'bun test'")).toBeUndefined();
	});
});

// Time one call; the budgets leave slack for a slow CI machine.
const ms = (f: () => unknown) => {
	const t = performance.now();
	f();
	return performance.now() - t;
};
const both = (command: string) => Math.max(ms(() => bashBlock(command)), ms(() => remoteTargets("bash", { command })));

describe("the shell scan stays linear on adversarial input", () => {
	const shapes: [string, string, number][] = [
		["a long run of quoted wrapper arguments", "sudo " + '"" '.repeat(20000) + "bun test", 300],
		["a long run of filler glued to a command word", "ssh" + '""'.repeat(50000) + " h", 300],
		["many backtick spans inside one quoted assignment", 'A="' + "`x`".repeat(10000) + '" ssh h', 300],
		["blank heredoc openers", "<<A x\n".repeat(20000) + "A", 300],
		["a long heredoc body", "cat <<A\n" + "some text line\n".repeat(20000) + "A\n", 300],
		["blank lines before a word", "\n".repeat(20000) + "ls", 300],
		["one line of repeated <<A", "<<A ".repeat(5000), 300],
		["repeated timeout -s", ";timeout -s ".repeat(5000), 300],
		["repeated git -C", "git " + "-C ".repeat(5000) + "zzz", 300],
		["repeated env -u", "env " + "-u A=1 ".repeat(3000) + "zzz", 300],
		["repeated env A=1", "env " + "A=1 ".repeat(10000) + "zzz", 300],
	];
	for (const [name, input, budget] of shapes)
		test(`${name}: under ${budget} ms`, () => {
			expect(both(input)).toBeLessThan(budget);
		});
});

describe("shell scan details", () => {
	test("a # inside a word is not a comment", () => {
		expect(remoteTargets("bash", { command: "echo a#b; ssh h" })?.targets).toEqual(["h"]);
		expect(bashBlock("echo a#b; bun test")).toBeDefined();
		expect(bashBlock("echo a #b; bun test")).toBeUndefined();
	});

	test("an unterminated double quote leaves the rest visible", () => {
		expect(remoteTargets("bash", { command: 'echo "x\nssh h' })?.targets).toEqual(["h"]);
		expect(bashBlock('echo "x\nbun test')).toBeDefined();
	});

	test("a Windows-path inventory stays whole, not host c", () => {
		expect(remoteTargets("bash", { command: "ansible-playbook -i C:\\inv\\p.ini x.yml" })?.targets).toEqual(["c:\\inv\\p.ini"]);
	});

	test("env takes assignments and options in any order", () => {
		expect(remoteTargets("bash", { command: "env A=1 -u X ssh h" })?.targets).toEqual(["h"]);
		expect(remoteTargets("bash", { command: "sudo -u root A=1 ssh h" })?.targets).toEqual(["h"]);
		expect(remoteTargets("bash", { command: "timeout -s KILL 10 ssh h" })?.targets).toEqual(["h"]);
	});

	test("an unquoted heredoc body runs $( ) and backticks, a quoted one does not", () => {
		expect(remoteTargets("bash", { command: "cat <<EOF\n$(ssh h)\nEOF" })?.targets).toEqual(["h"]);
		expect(remoteTargets("bash", { command: "cat <<EOF\n`ssh h`\nEOF" })?.targets).toEqual(["h"]);
		expect(remoteTargets("bash", { command: "cat <<'EOF'\n$(ssh h)\nEOF" })).toBeUndefined();
		expect(remoteTargets("bash", { command: 'cat <<"EOF"\n$(ssh h)\nEOF' })).toBeUndefined();
		expect(remoteTargets("bash", { command: "cat <<EOF\nssh h\nEOF" })).toBeUndefined();
		expect(bashBlock("cat <<EOF\n$(rm x)\nEOF")).toBeDefined();
	});
});

describe("the command-head scan is linear by construction", () => {
	// Small sizes: a regression to an exponential or quadratic scan still finishes, and fails the budget instead of hanging.
	const small: [string, string][] = [
		["<-A x24", "<-A ".repeat(24)],
		["<<-A x24", "<<-A ".repeat(24)],
		["<<-A\\t-u x20", "<<-A\t-u ".repeat(20)],
		["<<-A#ansible x20", "<<-A#ansible ".repeat(20)],
		["<<-A\\rm x24", "<<-A\\rm ".repeat(24)],
		[' <<-A\\" x20', ' <<-A\\"'.repeat(20)],
		["command <<-Atest x200", "command <<-Atest".repeat(200)],
		["git -C x500", "git -C ".repeat(500)],
		["ansible <(ssh x700", "ansible <(ssh ".repeat(700)],
		["<(sftp = x1200", "<(sftp =".repeat(1200)],
		["command sftp ( x700", "command sftp (".repeat(700)],
		["$(-i ssh x1100", "$(-i ssh ".repeat(1100)],
		["ssh >& x1000", "ssh >& ".repeat(1000)],
		["sudo -u x1000", "sudo -u ".repeat(1000)],
		["timeout -s x1000", "timeout -s ".repeat(1000)],
	];
	test.each(small)("%s: under 50 ms", (_name, command) => expect(both(command)).toBeLessThan(50));

	// The exact inputs of the apothecary findings F4, F5 and F6.
	const exact: [string, string][] = [
		["F4 <-A x28", "<-A ".repeat(28)],
		["F4 <<-A x28", "<<-A ".repeat(28)],
		["F4 <<-A\\t-u x25", "<<-A\t-u ".repeat(25)],
		["F4 <<-A#ansible x24", "<<-A#ansible ".repeat(24)],
		["F4 <<-A\\rm x30", "<<-A\\rm ".repeat(30)],
		['F4  <<-A\\" x24', ' <<-A\\"'.repeat(24)],
		["F4 command <<-Atest, 100 KB", "command <<-Atest".repeat(6250)],
		["F5 git -C x5000", "git -C ".repeat(5000)],
		["F6 ansible <(ssh , 100 KB", "ansible <(ssh ".repeat(7143)],
		["F6 <(sftp =, 100 KB", "<(sftp =".repeat(12500)],
		["F6 command sftp (, 100 KB", "command sftp (".repeat(7143)],
		["F6 $(-i ssh , 100 KB", "$(-i ssh ".repeat(11111)],
	];
	test.each(exact)("%s: under 300 ms", (_name, command) => expect(both(command)).toBeLessThan(300));

	test("fuzz: a few thousand strings of grammar tokens, each call under 50 ms", () => {
		const tokens = [
			"ssh", "scp", "sftp", "rsync", "ansible", "ansible-playbook", "git", "-C", "-c", "-u", "-s", "--", "sudo", "env", "timeout", "time", "nice", "command", "xargs", "if", "then",
			"!", "{", "A=1", "<", ">", ">>", "<<", "<<-", "2>&1", ">&", "<(", "$(", "(", ")", "`", ";", "|", "&", "&&", "\n", " ", "\t", "'", '"', "\\", "#", "10", "h", "x", "rm",
			"bun", "test", "run", "-i", "=", "$", "<-A", "-A", "checkout", "reset", "--hard", "EOF", "-p",
		];
		let seed = 20231121;
		const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
		let worst = 0;
		for (let i = 0; i < 3000; i++) {
			const command = Array.from({ length: 1 + rnd(300) }, () => tokens[rnd(tokens.length)] + (rnd(4) ? " " : "")).join("");
			worst = Math.max(worst, both(command));
		}
		expect(worst).toBeLessThan(50);
	});
});

describe("heredoc bodies: what an unquoted one runs", () => {
	test("an escaped $( does not run", () => {
		expect(bashBlock("cat <<EOF\n\\$(rm x)\nEOF")).toBeUndefined();
		expect(remoteTargets("bash", { command: "cat <<EOF\n\\$(ssh h)\nEOF" })).toBeUndefined();
	});

	test("a $ that does not open $( runs nothing", () => {
		expect(bashBlock("cat <<EOF\ncost $5\nrm -rf x\nEOF")).toBeUndefined();
		expect(remoteTargets("bash", { command: "cat <<EOF\ncost $5\nssh h\nEOF" })).toBeUndefined();
	});
});

describe("the command word, behind wrappers and their options", () => {
	const hosts = (cmd: string) => remoteTargets("bash", { command: cmd })?.targets;
	test.each([
		["env -u timeout ssh h", ["h"]],
		["sudo -C 3 -u root ssh h", ["h"]],
		["sudo -u root -- ssh h", ["h"]],
		["timeout 1.5 ssh h", ["h"]],
		["timeout 10s ssh h", ["h"]],
		["timeout -s KILL -k 5 10 ssh h", ["h"]],
		["timeout --signal KILL 10 ssh h", ["h"]],
		["nice -n 5 ssh h", ["h"]],
		["xargs -P 4 -I {} ssh h", ["h"]],
		["watch -n 2 ssh h", ["h"]],
		["sshpass -f pw ssh h", ["h"]],
		["stdbuf -o L ssh h", ["h"]],
		["time -f %e ssh h", ["h"]],
		["command -p ssh h", ["h"]],
		["timeout 5 sudo -u root env A=1 ssh h", ["h"]],
		["2>&1 ssh h", ["h"]],
		["> /tmp/x ssh h", ["h"]],
		["<<-EOF ssh h", ["h"]],
		["A=$(echo x) ssh h", ["h"]],
		["A=1 B=$(echo x) env ssh h", ["h"]],
		// not command words: an option without a wrapper, a bad duration, command -v, an argument after a substitution
		["A=1 -u timeout ssh -s 10 h", undefined],
		["timeout ssh ssh h", undefined],
		["timeout -s KILL x ssh h", undefined],
		["command -v ssh h", undefined],
		["command -V ssh h", undefined],
		["echo $(date) ssh h", undefined],
		["echo x 2>&1; ls ssh h", undefined],
	])("%s reaches %j", (cmd, expected) => expect(hosts(cmd)).toEqual(expected));

	test("runners and writes follow the same walk", () => {
		for (const cmd of ["A=$(echo x) bun test", "2>&1 bun test", "xargs -P 4 -I {} bun test", "timeout 1.5 bun test", "watch -n 2 bun test", "sshpass -f pw npm test"])
			expect([cmd, bashBlock(cmd)]).toEqual([cmd, expect.stringContaining(RUNNER_MSG)]);
		for (const cmd of ["timeout ssh bun test", "A=1 -u timeout bun test", "command -v bun test"]) expect([cmd, bashBlock(cmd)]).toEqual([cmd, undefined]);
		for (const cmd of ["sudo rm x", "A=1 rm x", "env A=1 mv a b", "/bin/rm x", "time cp a b", "xargs -n1 rm", "nice -n 5 touch a"])
			expect([cmd, bashBlock(cmd)]).toEqual([cmd, expect.stringContaining(WRITE_MSG)]);
	});

	test("git's global options, with their values, do not hide the subcommand", () => {
		for (const cmd of ["git --git-dir x reset --hard", "git --work-tree w -C d stash", "git -C d -c k=v -p clean -fd", "sudo git -C d restore f", "find . -exec git rm {} +", "git -C git -C git reset --hard"])
			expect([cmd, bashBlock(cmd)]).toEqual([cmd, expect.stringContaining(WRITE_MSG)]);
		for (const cmd of ["git -C d log", "git --git-dir x status", "git -C git -C git checkout main", "git checkout -b x", "git reset --soft HEAD~1"]) expect([cmd, bashBlock(cmd)]).toEqual([cmd, undefined]);
	});
});

describe("quoted values of a wrapper option do not hide the command word", () => {
	const hosts = (cmd: string) => remoteTargets("bash", { command: cmd })?.targets;
	test.each([
		['sudo -u "$U" ssh h', ["h"]],
		["sudo -u 'deploy' ssh h", ["h"]],
		["xargs -I '{}' ssh '{}' uptime", ["{}"]],
		['xargs -I "{}" ssh h', ["h"]],
		["timeout -s 'KILL' 5 ssh h", ["h"]],
		['env -u "X" ssh h', ["h"]],
		['nice -n "5" ssh h', ["h"]],
		// quoted text is still never a command or a host
		["echo 'ssh h'", undefined],
		['echo "x; ssh h"', undefined],
		['echo "ssh h"', undefined],
	])("%s reaches %j", (cmd, expected) => expect(hosts(cmd)).toEqual(expected));

	test("a runner behind a quoted option value is blocked", () => {
		for (const cmd of ['sudo -u "$U" bun test', "timeout -s 'KILL' 5 bun test", 'env -u "X" bun test', "sudo -u 'deploy' npm test"])
			expect([cmd, bashBlock(cmd)]).toEqual([cmd, expect.stringContaining(RUNNER_MSG)]);
	});

	test("quoted text is not a command, and a quoted redirect target into $TEMP passes", () => {
		for (const cmd of ["echo 'bun test'", 'echo "bun test"', 'echo x > "$TEMP/y"', "echo x > '$TEMP/y'", 'sudo -u "root" echo "bun test"'])
			expect([cmd, bashBlock(cmd)]).toEqual([cmd, undefined]);
		expect(bashBlock('echo x > "out.txt"')).toContain(WRITE_MSG);
	});
});

describe("several assignments with $( ) before a command", () => {
	const hosts = (cmd: string) => remoteTargets("bash", { command: cmd })?.targets;
	test.each([
		"A=$(date) B=$(pwd) bun test",
		"A=$(a) B=$(b) C=$(c) bun test",
		"A=$(a) B=$(b) C=1 bun test",
		"env A=$(a) B=$(b) bun test",
		"(A=$(a) B=$(b) bun test)",
		"if A=$(a) B=$(b) bun test; then :; fi",
		"A=$(a)B=$(b) bun test",
		"A=$((1+2)) bun test",
		"A=$(x)$(y) bun test",
	])("%s runs the runner", cmd => expect([cmd, bashBlock(cmd)]).toEqual([cmd, expect.stringContaining(RUNNER_MSG)]));

	test.each([
		["A=$(date) B=$(pwd) ssh h", ["h"]],
		["A=$(a) B=$(b) C=$(c) ssh h", ["h"]],
		["N=$((N+1)) ssh h", ["h"]],
		["A=$(x)$(y) ssh h", ["h"]],
		["A=$(a)B=$(b) ssh h", ["h"]],
		// an argument after a substitution is still no command word
		["echo $(date) $(pwd) ssh h", undefined],
	])("%s reaches %j", (cmd, expected) => expect(hosts(cmd)).toEqual(expected));

	test("a write after several assignments is blocked", () => {
		expect(bashBlock("A=$(a) B=$(b) rm f")).toContain(WRITE_MSG);
	});
});

describe("a wrapper option needs more than a dash, and a keyword ends the wrapper", () => {
	const hosts = (cmd: string) => remoteTargets("bash", { command: cmd })?.targets;
	test("a lone - after a wrapper is not an option", () => expect(hosts("sudo - ssh h")).toBeUndefined());
	test("a keyword resets the wrapper", () => expect(hosts("sudo then -x ssh h")).toBeUndefined());
});

describe("timing guards finish small so a regression fails instead of hanging", () => {
	const shapes: [string, string][] = [
		["nested unterminated $(", '"$('.repeat(24)],
		["nested unterminated quote and $(", 'echo "$(git log "$(x '.repeat(9)],
		["nested unterminated $((", '"$(('.repeat(24)],
	];
	for (const [name, input] of shapes) test(`${name}, small: under 50 ms`, () => expect(both(input)).toBeLessThan(50));

	test("a 100 KB run of git -C finishes under 300 ms", () => expect(both("git -C ".repeat(14286))).toBeLessThan(300));
});

const hostsOf = (cmd: string) => remoteTargets("bash", { command: cmd })?.targets;

describe("CB5: a quoted argument behind a wrapper never becomes the command word", () => {
	test.each([
		'env "FOO=bar" bun test',
		'sudo "-E" bun test',
		'sudo "$@" bun test',
		'nice -n 5 "FOO=bar" bun test',
		'timeout "5" bun test',
		'timeout 5 "" bun test',
	])("%s is blocked as a runner", cmd => expect(bashBlock(cmd)).toContain(RUNNER_MSG));

	test.each([
		['env "A=1" ssh h', ["h"]],
		['sudo "-E" ssh h', ["h"]],
		['sudo "$@" ssh h', ["h"]],
		['nice -n 5 "FOO=bar" ssh h', ["h"]],
		['timeout "5" ssh h', ["h"]],
		["timeout 5 '' ssh h", ["h"]],
	])("%s reaches %j", (cmd, expected) => expect(hostsOf(cmd)).toEqual(expected));

	test("a quoted argument behind timeout and a wrapper still reaches the write", () => {
		expect(bashBlock("timeout 5 '' rm f")).toContain(WRITE_MSG);
		expect(bashBlock('sudo "x" rm f')).toContain(WRITE_MSG);
	});
});

describe("CB5: quote filler glued to a word never hides it", () => {
	test.each(["tsc\"\" -p .", "jest'' --ci", 'bun test"x"', 'bun"" test', '"" bun test'.replace('"" ', '""'), "t\"\"sc -p ."])("%s is blocked as a runner", cmd =>
		expect(bashBlock(cmd)).toContain(RUNNER_MSG),
	);
	test.each([
		['ssh"" h', ["h"]],
		['ss""h h', ["h"]],
		["ssh'' h", ["h"]],
		['""ssh h', ["h"]],
	])("%s reaches %j", (cmd, expected) => expect(hostsOf(cmd)).toEqual(expected));
	test("r\"\"m f is a write", () => expect(bashBlock('r""m f')).toContain(WRITE_MSG));
});

describe("glue transparency: filler glued to the command word or its subcommand changes nothing", () => {
	const variants = (cmd: string): string[] => {
		const [head, ...rest] = cmd.split(" ");
		const out: string[] = [];
		for (const q of ['""', "''"]) {
			for (const w of [head, rest[0]]) {
				const others = (x: string) => (w === head ? [x, ...rest].join(" ") : [head, x, ...rest.slice(1)].join(" "));
				out.push(others(q + w), others(w + q), others(w.slice(0, 1) + q + w.slice(1)));
			}
		}
		return out;
	};
	for (const cmd of ["bun test", "ssh h", "rm f", "tsc -p ."])
		test(`variants of ${cmd} behave like it`, () => {
			for (const v of variants(cmd)) {
				expect([v, bashBlock(v)]).toEqual([v, bashBlock(cmd)]);
				expect([v, hostsOf(v)]).toEqual([v, hostsOf(cmd)]);
			}
		});
});

describe("B4: a backtick substitution inside double quotes never hides the command after the quotes", () => {
	test.each([
		['A="`x`" ssh h', ["h"]],
		['A="x`y`z" ssh h', ["h"]],
		['sudo -u "`id -un`" ssh h', ["h"]],
	])("%s reaches %j", (cmd, expected) => expect(hostsOf(cmd)).toEqual(expected));
	test.each(['A="`x`" bun test', 'A="x`y`z" bun test'])("%s is blocked as a runner", cmd => expect(bashBlock(cmd)).toContain(RUNNER_MSG));
	test('A="`x`" rm f is a write', () => expect(bashBlock('A="`x`" rm f')).toContain(WRITE_MSG));
	test("text inside the quotes after a backtick stays quoted", () => {
		expect(hostsOf('echo "`date` ssh h"')).toBeUndefined();
		expect(bashBlock('echo "`date` bun test"')).toBeUndefined();
	});
});

describe("assignments with $( ) and comments: what the shell runs next", () => {
	test.each([
		['A="x $(a) y" ssh h', ["h"]],
		['A="$(a) y" ssh h', ["h"]],
		['A="x $(a) y $(b)" ssh h', ["h"]],
		["ssh h # x", ["h"]],
		["ssh # note", undefined],
		["A=$; echo a) ssh h", undefined],
	])("%s reaches %j", (cmd, expected) => expect(hostsOf(cmd)).toEqual(expected));
	test('A="x $(a) y $(b)" bun test is blocked as a runner', () => expect(bashBlock('A="x $(a) y $(b)" bun test')).toContain(RUNNER_MSG));
});

describe("no over-reach: quoted text and look-alikes stay allowed", () => {
	test.each(['echo "ssh h"', "echo 'x; ssh h'", '"A=1" ssh h', "ssh-keygen", "git clone ssh://h/r"])("%s reaches nothing", cmd =>
		expect(hostsOf(cmd)).toBeUndefined(),
	);
	test("quoted text is no runner or write", () => {
		for (const cmd of ["echo 'x; bun test'", 'echo "rm f"', "git push"]) expect(bashBlock(cmd)).toBeUndefined();
	});
});

describe("wrapper x quoted argument x command: every row equals the bare command", () => {
	const wrappers = ["sudo", "sudo -u x", "env", "env -i", "nice -n 5", "timeout 5", "xargs", "command", "exec"];
	const quoted = ['"A=1"', "'A=1'", '"-E"', '"$@"', '"x"', "''"];
	const commands = ["bun test", "ssh h", "rm f", "git push"];
	for (const w of wrappers)
		for (const q of quoted)
			for (const c of commands)
				test(`${w} ${q} ${c}`, () => {
					const cmd = `${w} ${q} ${c}`;
					expect(bashBlock(cmd)).toBe(bashBlock(c));
					expect(remoteTargets("bash", { command: cmd })).toEqual(remoteTargets("bash", { command: c }));
				});
});

describe("penance 1: B1 text glued after quotes holding a backtick never hides the command", () => {
	test.each([
		['A="`x`"B ssh h', ["h"]],
		['A="`x`".log rsync a box:/x', ["box"]],
		['A="`x`"\'\' ssh h', ["h"]],
		['A="`x`""" ssh h', ["h"]],
		['A="`x`"$(y) ssh h', ["h"]],
		['A="`x`$(y)" ssh h', ["h"]],
		['A="`x` $(y)" ssh h', ["h"]],
		["A=`x`B ssh h", ["h"]],
	])("%s reaches %j", (cmd, expected) => expect(hostsOf(cmd)).toEqual(expected));
	test.each(["A=`x`B bun test", 'LOG="`date +%F`".log bun test', 'A="`x`$(y)" bun test', 'A="`x`"$(y) bun test'])("%s is blocked as a runner", cmd =>
		expect(bashBlock(cmd)).toContain(RUNNER_MSG),
	);
	test("text inside the quotes stays quoted", () => expect(hostsOf('echo "`date` ssh h"')).toBeUndefined());
});

describe("penance 1: CB1 # inside a backtick or ${...} is no comment", () => {
	test.each(["echo `echo a # b` ; rm f", "echo ${x:- # } ; rm f", "echo ${x/ #/y} ; rm f"])("%s is a write", cmd => expect(bashBlock(cmd)).toContain(WRITE_MSG));
	test("v=`echo a #b`; ssh h reaches h", () => expect(hostsOf("v=`echo a #b`; ssh h")).toEqual(["h"]));
});

describe("penance 1: CB2 separators inside $( ) and ${ } or after a backslash do not split the segment", () => {
	test.each(["A=$(a;b) bun test", 'A="$(a;b)" bun test', "env A=$(a|b) tsc", "A=$(a&&b) bun test", "A=${B:-x;y} bun test", "A=a\\;b bun test"])("%s is blocked as a runner", cmd =>
		expect(bashBlock(cmd)).toContain(RUNNER_MSG),
	);
	test.each(["A=$(a;b) ssh h", "A=$(a | b) ssh h", "A=$(cd d; pwd) ssh h", "A=$(a\nb) ssh h", "A=${B:-x y} ssh h"])("%j reaches h", cmd => expect(hostsOf(cmd)).toEqual(["h"]));
	test("A=$(a;b) rm f is a write", () => expect(bashBlock("A=$(a;b) rm f")).toContain(WRITE_MSG));
});

describe("penance 1: B2 filler glued to git words and sed/perl options never hides the write", () => {
	test.each([
		'git re""set --hard',
		'git reset ""--hard',
		"git reset --har''d",
		'git reset"" --hard',
		'git ""stash',
		"git cl''ean -fd",
		'git checkout ""-- .',
		"git checkout'' .",
		"git ''checkout .",
		"git checkout ''-- f",
		"sudo git checkout'' .",
		'git ""checkout -- f',
		"sed'' -i s/a/b/ f",
		"sed ''-i f",
		'sed -""i s/a/b/ f',
		"perl'' -pi x",
		'perl -""i x',
	])("%s is a write", cmd => expect(bashBlock(cmd)).toContain(WRITE_MSG));
});

describe("penance 1: CB5 and CB6 redirects glued to or between the arguments", () => {
	test.each([
		["ssh &>/dev/null h", ["h"]],
		["ssh &>>/tmp/x h", ["h"]],
		["scp &>/dev/null f h:x", ["h"]],
		["rsync &>/dev/null -a f h:x", ["h"]],
		["ssh -o x &>/dev/null h", ["h"]],
		["&>f ssh h", ["h"]],
		["ssh>/dev/null h", ["h"]],
		["ssh</dev/null h", ["h"]],
	])("%s reaches %j", (cmd, expected) => expect(hostsOf(cmd)).toEqual(expected));
});

describe("penance 1: CB8 backslash-newline inside a word joins it", () => {
	test("ss\\<nl>h h reaches h", () => expect(hostsOf("ss\\\nh h")).toEqual(["h"]));
	test("r\\<nl>m f is a write", () => expect(bashBlock("r\\\nm f")).toContain(WRITE_MSG));
	test("bun te\\<nl>st is a runner", () => expect(bashBlock("bun te\\\nst")).toContain(RUNNER_MSG));
});

describe("penance 1: CB9 past the nesting cap the text is over-blocked, never hidden", () => {
	const deep = (inner: string, n = 17) => 'echo "$('.repeat(n) + inner + ')"'.repeat(n);
	test("ssh h at depth 17 is a target", () => expect(hostsOf(deep("ssh h"))).toBeDefined());
	test("rm f at depth 17 is a write", () => expect(bashBlock(deep("rm f"))).toContain(WRITE_MSG));
	test("bun test at depth 17 is a runner", () => expect(bashBlock(deep("bun test"))).toContain(RUNNER_MSG));
});

describe("penance 1: CB3 a heredoc opener inside quotes or a comment opens nothing", () => {
	test.each(["echo '<<X'\nssh h\nX", "echo hi # <<X\nssh h\nX", "echo $((1<<X))\nssh h\nX"])("%j reaches h", cmd => expect(hostsOf(cmd)).toEqual(["h"]));
});

describe("penance 1: CB4 ANSI-C quotes honour a backslash", () => {
	test("echo $'\\'' ; ssh h ; echo $'x' reaches h", () => expect(hostsOf("echo $'\\'' ; ssh h ; echo $'x'")).toEqual(["h"]));
});

describe("penance 1: literal underscores and quoted wrapper words stay literal", () => {
	test.each(["tsc_", "bun_ test", "rm_ f", "sudo ssh_ h", 'command ""-v ssh h'])("%s is allowed", cmd => {
		expect(bashBlock(cmd)).toBeUndefined();
		expect(hostsOf(cmd)).toBeUndefined();
	});
});

describe("penance 1: nothing origin/main's bashBlock blocks is allowed", () => {
	const runners = ["bun test", "bun run x", "bunx x", "npx x", "npm test", "pnpm run b", "yarn build", "tsc -p .", "jest", "vitest", "pytest", "cargo test", "go build", "dotnet test", "./node_modules/.bin/jest", "C:\\tools\\bun.exe test"];
	const writes = ["rm f", "mv a b", "cp a b", "touch f", "tee f", "ln a b", "git checkout -- f", "git checkout .", "git reset --hard", "git clean -fd", "git stash", "git restore f", "git -C d apply p", "sed -i s/a/b/ f", "perl -pi x", "echo x > f", "echo x >> f", "ls 2>f"];
	const wrap = (c: string) => [c, `env A=1 ${c}`, `sudo ${c}`, `echo a; ${c}`, `echo a && ${c}`, `a | ${c}`, `if x; then ${c}; fi`, `A=$(b) ${c}`, `$(${c})`, `echo "$(${c})"`, `\`${c}\``, `(${c})`, `echo a\n${c}`, `timeout 5 ${c}`];
	for (const c of runners) test(`runner ${c}`, () => wrap(c).forEach(v => expect([v, bashBlock(v)]).toEqual([v, expect.stringContaining(RUNNER_MSG)])));
	for (const c of writes) test(`write ${c}`, () => wrap(c).forEach(v => expect([v, bashBlock(v)]).toEqual([v, expect.stringContaining("writes no files")])));
});
