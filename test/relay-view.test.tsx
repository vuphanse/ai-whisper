import { render } from "ink-testing-library";
import { Text } from "ink";
import { describe, expect, it } from "vitest";

describe("ink toolchain", () => {
	it("renders JSX via ink-testing-library", () => {
		const { lastFrame } = render(<Text>hello-ink</Text>);
		expect(lastFrame()).toContain("hello-ink");
	});
});
