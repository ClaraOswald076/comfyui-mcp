// Ollama model-facts probe for the LLM Arena (#792) — the VRAM / quantization
// axes. Kept in its own module (not inside llm-arena.mjs, which runs the arena
// on import) so the fold-safety of the parsing is unit-testable.

/**
 * Quantization + parameter size from /api/show, resident VRAM from /api/ps.
 * Call AFTER the model's run, while it is still resident. Ollama-dialect only
 * (the caller checks) — a hosted endpoint has neither. Every field is ABSENT
 * (never zero, never guessed) when the probe can't answer, and a malformed
 * capabilities array is UNKNOWN, never an affirmative empty list.
 */
export async function probeModelFacts(ollamaHost, model) {
  const facts = {};
  try {
    const res = await fetch(`${ollamaHost}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      const quant = data?.details?.quantization_level;
      const params = data?.details?.parameter_size;
      if (typeof quant === "string" && quant) facts.quant = quant;
      if (typeof params === "string" && params) facts.params = params;
      // Only a well-formed string list is an affirmative observation.
      if (Array.isArray(data?.capabilities) && data.capabilities.every((c) => typeof c === "string")) {
        facts.capabilities = data.capabilities;
      }
    }
  } catch {
    // probe failed — fields stay absent
  }
  try {
    const res = await fetch(`${ollamaHost}/api/ps`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      const running = (data?.models ?? []).find((m) => m?.name === model || m?.model === model);
      if (typeof running?.size_vram === "number" && running.size_vram > 0) {
        facts.vramResidentBytes = running.size_vram;
      }
    }
  } catch {
    // probe failed — field stays absent
  }
  return facts;
}
