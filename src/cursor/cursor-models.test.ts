import { describe, it, expect, beforeEach } from "bun:test";
import { getCursorModels, clearModelCache, type CursorModel } from "./cursor-models";

describe("getCursorModels", () => {
  beforeEach(() => {
    clearModelCache();
  });

  it("returns fallback models when API is unavailable", async () => {
    const models = await getCursorModels("invalid-token");
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]).toHaveProperty("id");
    expect(models[0]).toHaveProperty("name");
    expect(models[0]).toHaveProperty("reasoning");
    expect(models[0]).toHaveProperty("contextWindow");
    expect(models[0]).toHaveProperty("maxTokens");
  });

  it("returns models with valid structure", async () => {
    const models = await getCursorModels("any-token");
    
    for (const model of models) {
      expect(typeof model.id).toBe("string");
      expect(typeof model.name).toBe("string");
      expect(typeof model.reasoning).toBe("boolean");
      expect(typeof model.contextWindow).toBe("number");
      expect(typeof model.maxTokens).toBe("number");
      expect(model.id.length).toBeGreaterThan(0);
      expect(model.name.length).toBeGreaterThan(0);
      expect(model.contextWindow).toBeGreaterThan(0);
      expect(model.maxTokens).toBeGreaterThan(0);
    }
  });

  it("caches results after first call", async () => {
    const firstCall = await getCursorModels("token-1");
    const secondCall = await getCursorModels("token-2");
    
    // Should return cached results regardless of different token
    expect(firstCall).toBe(secondCall);
    expect(firstCall.length).toBe(secondCall.length);
  });

  it("includes both reasoning and non-reasoning models in fallback", async () => {
    const models = await getCursorModels("invalid-token");
    
    const reasoningModels = models.filter(m => m.reasoning);
    const nonReasoningModels = models.filter(m => !m.reasoning);
    
    expect(reasoningModels.length).toBeGreaterThan(0);
    expect(nonReasoningModels.length).toBeGreaterThan(0);
  });

  it("includes expected fallback model families", async () => {
    const models = await getCursorModels("invalid-token");
    const modelIds = models.map(m => m.id);
    
    // Check for composer models
    expect(modelIds.some(id => id.includes("composer"))).toBe(true);
    
    // Check for claude models
    expect(modelIds.some(id => id.includes("claude"))).toBe(true);
    
    // Check for gpt models
    expect(modelIds.some(id => id.includes("gpt"))).toBe(true);
  });

  it("sorts models by id", async () => {
    const models = await getCursorModels("invalid-token");
    const ids = models.map(m => m.id);
    const sortedIds = [...ids].sort((a, b) => a.localeCompare(b));
    
    expect(ids).toEqual(sortedIds);
  });
});

describe("CursorModel type", () => {
  it("has correct interface", () => {
    const model: CursorModel = {
      id: "test-model",
      name: "Test Model",
      reasoning: true,
      contextWindow: 100000,
      maxTokens: 50000,
    };
    
    expect(model.id).toBe("test-model");
    expect(model.name).toBe("Test Model");
    expect(model.reasoning).toBe(true);
    expect(model.contextWindow).toBe(100000);
    expect(model.maxTokens).toBe(50000);
  });
});
