/**
 * Cursor model list
 * Simplified model discovery - uses hardcoded list
 */
import { debug } from "../debug.js";

export interface CursorModel {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;

/**
 * Default list of Cursor models (sorted by ID)
 */
const CURSOR_MODELS: CursorModel[] = [
  // Auto (default)
  {
    id: "auto",
    name: "Auto (Cursor selects)",
    reasoning: false,
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
  // Claude models
  {
    id: "claude-4.5-opus",
    name: "Claude 4.5 Opus",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
  {
    id: "claude-4.5-sonnet",
    name: "Claude 4.5 Sonnet",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
  {
    id: "claude-4.6-opus-high",
    name: "Claude 4.6 Opus",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 128_000,
  },
  {
    id: "claude-4.6-sonnet-medium",
    name: "Claude 4.6 Sonnet",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
  // Composer models
  {
    id: "composer-1",
    name: "Composer 1",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
  {
    id: "composer-1.5",
    name: "Composer 1.5",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
  {
    id: "composer-2",
    name: "Composer 2",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
  {
    id: "composer-2-fast",
    name: "Composer 2 Fast",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
  // Gemini models
  {
    id: "gemini-3-flash",
    name: "Gemini 3 Flash",
    reasoning: true,
    contextWindow: 250_000,
    maxTokens: 32_000,
  },
  {
    id: "gemini-3-pro",
    name: "Gemini 3 Pro",
    reasoning: true,
    contextWindow: 500_000,
    maxTokens: 64_000,
  },
  {
    id: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 64_000,
  },
  // GPT models
  {
    id: "gpt-5.2",
    name: "GPT-5.2",
    reasoning: true,
    contextWindow: 400_000,
    maxTokens: 128_000,
  },
  {
    id: "gpt-5.2-codex",
    name: "GPT-5.2 Codex",
    reasoning: true,
    contextWindow: 400_000,
    maxTokens: 128_000,
  },
  {
    id: "gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    reasoning: true,
    contextWindow: 400_000,
    maxTokens: 128_000,
  },
  {
    id: "gpt-5.3-codex-spark-preview",
    name: "GPT-5.3 Codex Spark",
    reasoning: true,
    contextWindow: 128_000,
    maxTokens: 128_000,
  },
  {
    id: "gpt-5.4-high",
    name: "GPT-5.4 High",
    reasoning: true,
    contextWindow: 272_000,
    maxTokens: 128_000,
  },
  {
    id: "gpt-5.4-medium",
    name: "GPT-5.4",
    reasoning: true,
    contextWindow: 272_000,
    maxTokens: 128_000,
  },
  // Grok models
  {
    id: "grok",
    name: "Grok",
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 64_000,
  },
  {
    id: "grok-code-fast-1",
    name: "Grok Code Fast 1",
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 64_000,
  },
  // Kimi models
  {
    id: "kimi-k2.5",
    name: "Kimi K2.5",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
];

/**
 * Get available Cursor models
 * Returns the hardcoded model list (already sorted by ID)
 */
export async function getCursorModels(_apiKey?: string): Promise<CursorModel[]> {
  debug(2, "Returning Cursor model list", { count: CURSOR_MODELS.length });
  return CURSOR_MODELS;
}

/**
 * Get a specific model by ID
 */
export function getCursorModelById(id: string): CursorModel | undefined {
  return CURSOR_MODELS.find((m) => m.id === id);
}

/**
 * Get all model IDs
 */
export function getCursorModelIds(): string[] {
  return CURSOR_MODELS.map((m) => m.id);
}

/**
 * Clear model cache (for testing)
 * @deprecated No longer used - models are static
 */
export function clearModelCache(): void {
  // No-op for backward compatibility
}
