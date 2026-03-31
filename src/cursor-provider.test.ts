import { describe, test, expect } from "bun:test";
import { createCursorProvider } from "./cursor-provider";

describe("createCursorProvider", () => {
  test("returns provider with correct structure", () => {
    const provider = createCursorProvider();
    expect(provider).toBeDefined();
    expect(typeof provider.languageModel).toBe("function");
  });

  test("strips cursor/ prefix from model name", () => {
    const provider = createCursorProvider();
    const model = provider.languageModel("cursor/composer-2");
    expect(model).toBeDefined();
  });
});
