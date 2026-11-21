import { expect, test } from "bun:test";
import { childEnv } from "./env";

// The whole point of childEnv: the alarm command is the user's, but the omp environment holds keys.
test("the child does not inherit the credential variables", () => {
	process.env.OPENAI_API_KEY = "secret";
	try {
		expect(childEnv().OPENAI_API_KEY).toBeUndefined();
		expect(childEnv({ STRATEGIUM_P: "50" }).STRATEGIUM_P).toBe("50");
		expect(childEnv()).toMatchObject({ PATH: process.env.PATH });
	} finally {
		delete process.env.OPENAI_API_KEY;
	}
});

test("the child keeps the non-secret names the alarm needs", () => {
	process.env.SystemDrive = "C:";
	process.env.XDG_RUNTIME_DIR = "/run/user/1000";
	process.env.MY_API_KEY = "secret";
	try {
		expect(childEnv()).toMatchObject({ SystemDrive: "C:", XDG_RUNTIME_DIR: "/run/user/1000" });
		expect(childEnv().MY_API_KEY).toBeUndefined();
	} finally {
		delete process.env.SystemDrive;
		delete process.env.XDG_RUNTIME_DIR;
		delete process.env.MY_API_KEY;
	}
});
