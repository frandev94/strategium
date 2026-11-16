import { expect, test } from "bun:test";
import { childEnv } from "./env";

// The whole point of childEnv: the alarm command is the user's, but the omp environment holds keys.
test("the child does not inherit the credential variables", () => {
	process.env.OPENAI_API_KEY = "secret";
	try {
		expect(childEnv().OPENAI_API_KEY).toBeUndefined();
		expect(childEnv({ STRATEGIUM_P: "50" }).STRATEGIUM_P).toBe("50");
		expect(childEnv().PATH).toBe(process.env.PATH);
	} finally {
		delete process.env.OPENAI_API_KEY;
	}
});
