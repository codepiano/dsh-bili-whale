import { ConceptEngine } from "./engine.mjs";

// Shadow mode records exactly what would be offered, without changing the prompt.
export async function preparePersonalContext(
  observer,
  { mode = "shadow", scene = "general", budget = 400 } = {},
) {
  const rendered = await new ConceptEngine(observer.store).call(
    "personal_render",
    { scene, budget },
  );
  const content = {
    mode,
    state_version: rendered.state_version,
    text: rendered.text,
    selected: rendered.selected,
    omitted: rendered.omitted,
  };
  const version = await observer.store.snapshot("personal_rendered", content, {
    actor: "concept_system",
  });
  return {
    text: mode === "active" ? rendered.text : "",
    source: { role: "personal_rendered", status: "present", content },
    version,
  };
}
