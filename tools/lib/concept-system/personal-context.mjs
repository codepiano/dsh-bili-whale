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

// Allocate only to subjects with usable material. An empty owner profile must
// not silently consume half the fish's budget or permanently exclude beliefs.
export async function renderLearningContext(
  store,
  { budget = 400, scene = "general" } = {},
) {
  const state = store.state().concepts;
  const members = Object.values(state?.members ?? {}).filter(
    (m) => m.status === "accepted" && ["general", scene].includes(m.scene),
  );
  const subjects = ["fish", "user"].filter(
    (subject) =>
      members.some((m) => m.subject === subject) ||
      (subject === "fish" && state?.exploration),
  );
  if (!subjects.length)
    return { text: "", rendered: [], budget, omitted_subjects: [] };
  const labels = {
    fish: "［关于鱼的学习素材］",
    user: "［关于主人的观察，不代表鱼自己的偏好］",
  };
  let chosen = subjects,
    omitted_subjects = [];
  if (subjects.length > 1 && budget < 250) {
    chosen = ["fish"];
    omitted_subjects = ["user"];
  }
  const overhead =
    chosen.reduce((n, s) => n + [...labels[s]].length + 1, 0) +
    (chosen.length - 1) * 2;
  const available = budget - overhead;
  const useLabels = available >= chosen.length * 100;
  const pool = useLabels ? available : budget;
  const needs = chosen.map((s) => ({
    subject: s,
    need:
      50 +
      (s === "fish" && state?.exploration ? 120 : 0) +
      members
        .filter((m) => m.subject === s)
        .reduce((n, m) => n + [...m.content].length + 20, 0),
  }));
  const total = needs.reduce((n, s) => n + s.need, 0),
    rendered = [];
  let remaining = pool;
  const engine = new ConceptEngine(store);
  for (const [i, item] of needs.entries()) {
    const after = needs.length - i - 1;
    const size = after
      ? Math.max(
          100,
          Math.min(
            remaining - after * 100,
            Math.floor((pool * item.need) / total),
          ),
        )
      : remaining;
    rendered.push(
      await engine.call("personal_render", {
        subject: item.subject,
        scene,
        budget: size,
      }),
    );
    remaining -= size;
  }
  const text = rendered
    .filter((r) => r.text)
    .map((r) => (useLabels ? labels[r.subject] + "\n" : "") + r.text)
    .join("\n\n");
  return { rendered, text, budget, omitted_subjects };
}
