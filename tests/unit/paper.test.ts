import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  acceptCandidates,
  createPaper,
  lineDiff,
  newCandidate,
  ProjectConflict,
  replaceSources,
  restoreModule,
  saveModule,
} from "../../shared/paper-project";
import { moduleOrder } from "../../shared/paper-types";
import type { ModuleInput, ModuleId } from "../../shared/paper-types";
import {
  adapterDefinitions,
  executePaperModule,
  searchLiterature,
} from "../../server/paper/adapters";
import {
  bibliographyTex,
  markdownToTex,
  paperTex,
  texEscape,
  vectorPdf,
} from "../../server/paper/export";
import { PaperStore } from "../../server/paper/store";
import type { FigureScene } from "../../shared/types";

const paper = () =>
  createPaper(
    randomUUID(),
    "Frozen model with local repair",
    "Monitor a frozen model's prefix, diagnose locally and commit only a confident local repair.",
  );
const candidate = (
  p: ReturnType<typeof paper>,
  id: ModuleId,
  content: string,
  runId = randomUUID(),
) =>
  newCandidate(p, randomUUID(), runId, id, "orchestra-section", "test-model", {
    content,
    warnings: [],
  });
test("paper creates a complete module contract with no invented content", () => {
  const p = paper();
  assert.equal(p.schema, "paper-workbench/1");
  assert.equal(Object.keys(p.modules).length, 9);
  assert.ok(
    moduleOrder.every(
      (id) => !p.modules[id].content && p.modules[id].history[0].revision === 0,
    ),
  );
});
test("creating a proposal never changes the manuscript", () => {
  const p = paper(),
    before = structuredClone(p.modules);
  const c = candidate(p, "introduction", "Proposed intro");
  p.candidates.push(c);
  assert.deepEqual(p.modules, before);
  assert.equal(c.baseRevision, 0);
});
test("accept replaces only the chosen section", () => {
  const p = paper();
  saveModule(p, "method", 0, "Human-authored method");
  saveModule(p, "conclusion", 0, "Human-authored conclusion");
  const method = structuredClone(p.modules.method),
    conclusion = structuredClone(p.modules.conclusion),
    c = candidate(p, "introduction", "New introduction");
  p.candidates.push(c);
  acceptCandidates(p, [c.id]);
  assert.equal(p.modules.introduction.content, "New introduction");
  assert.deepEqual(p.modules.method, method);
  assert.deepEqual(p.modules.conclusion, conclusion);
  assert.equal(c.status, "accepted");
});
test("a late proposal cannot overwrite edits made after generation", () => {
  const p = paper(),
    c = candidate(p, "introduction", "AI version");
  p.candidates.push(c);
  saveModule(p, "introduction", 0, "New manual revision");
  const before = structuredClone(p);
  assert.throws(() => acceptCandidates(p, [c.id]), ProjectConflict);
  assert.deepEqual(p, before);
});
test("source changes invalidate old proposals and mark, not rewrite, manuscript", () => {
  const p = paper();
  saveModule(p, "introduction", 0, "Preserved intro");
  const c = candidate(p, "introduction", "Old-context AI intro");
  p.candidates.push(c);
  replaceSources(p, p.revision, {
    title: p.title,
    ideaSpark: "Updated mechanism",
    materials: [],
    language: "en",
    guidelines: p.guidelines,
  });
  assert.equal(p.modules.introduction.content, "Preserved intro");
  assert.ok(p.modules.introduction.needsSync.includes("materials"));
  assert.throws(() => acceptCandidates(p, [c.id]), ProjectConflict);
});
test("dependency changes are checked without rewriting dependent text", () => {
  const p = paper();
  saveModule(p, "abstract", 0, "Abstract to keep");
  const c = candidate(p, "abstract", "Older abstract");
  p.candidates.push(c);
  saveModule(p, "method", 0, "New method");
  assert.equal(p.modules.abstract.content, "Abstract to keep");
  assert.ok(p.modules.abstract.needsSync.includes("method"));
  assert.throws(() => acceptCandidates(p, [c.id]), ProjectConflict);
});
test("locks protect generation and candidate acceptance but allow intentional manual edits", async () => {
  const p = paper(),
    c = candidate(p, "introduction", "AI");
  p.candidates.push(c);
  p.modules.introduction.locked = true;
  assert.throws(() => acceptCandidates(p, [c.id]), ProjectConflict);
  saveModule(p, "introduction", 0, "Manual locked-section edit");
  await assert.rejects(
    executePaperModule(
      {
        contract: "paper-module/1",
        project: p,
        moduleId: "introduction",
        methodId: "orchestra-section",
        model: "mock",
        instruction: "",
      },
      () => {},
      async () => {
        throw Error("must not call model");
      },
    ),
    /锁定/,
  );
});
test("batch validation is atomic when one module has changed", () => {
  const p = paper(),
    run = randomUUID(),
    a = candidate(p, "method", "AI method", run),
    b = candidate(p, "introduction", "AI intro", run);
  p.candidates.push(a, b);
  saveModule(p, "method", 0, "Manual changed method");
  const before = structuredClone(p);
  assert.throws(() => acceptCandidates(p, [a.id, b.id], true), ProjectConflict);
  assert.deepEqual(p, before);
});
test("valid batch acceptance consumes the proposed module dependencies", () => {
  const p = paper(),
    run = randomUUID(),
    a = candidate(p, "method", "Proposed method", run),
    b = candidate(p, "abstract", "Proposed abstract", run);
  p.candidates.push(a, b);
  acceptCandidates(p, [a.id, b.id], true);
  assert.equal(p.modules.abstract.content, "Proposed abstract");
  assert.deepEqual(p.modules.abstract.needsSync, []);
});
test("restore appends a version and preserves unrelated sections", () => {
  const p = paper();
  saveModule(p, "introduction", 0, "v1");
  saveModule(p, "introduction", 1, "v2");
  saveModule(p, "method", 0, "Manual method");
  restoreModule(p, "introduction", 2, 1);
  assert.equal(p.modules.introduction.content, "v1");
  assert.equal(p.modules.introduction.revision, 3);
  assert.equal(p.modules.introduction.history.length, 4);
  assert.equal(p.modules.method.content, "Manual method");
});
test("unknown citations block adoption rather than masquerade as valid references", () => {
  const p = paper(),
    c = candidate(p, "introduction", "A claim [@invented].");
  p.candidates.push(c);
  const before = structuredClone(p);
  assert.throws(() => acceptCandidates(p, [c.id]), /缺少引用/);
  assert.deepEqual(p, before);
});
test("diff displays additions, removals and unchanged lines", () => {
  const d = lineDiff("same\nold", "same\nnew");
  assert.ok(d.some((x) => x.kind === "same" && x.text === "same"));
  assert.ok(d.some((x) => x.kind === "remove" && x.text === "old"));
  assert.ok(d.some((x) => x.kind === "add" && x.text === "new"));
});
test("selective upstream prompts execute through the scoped protocol, not whole-paper generation", async () => {
  const p = paper();
  let actual = "";
  const out = await executePaperModule(
    {
      contract: "paper-module/1",
      project: p,
      moduleId: "introduction",
      methodId: "orchestra-section",
      model: "mock",
      instruction: "rewrite",
    },
    () => {},
    async (_m, system) => {
      actual = system;
      return { content: "Grounded introduction", warnings: [] };
    },
  );
  assert.match(actual, /Role: Senior AI Researcher/);
  assert.match(actual, /Return ONLY the target module/);
  assert.match(actual, /Explicitly disclose limitations/);
  assert.equal(out.content, "Grounded introduction");
  assert.ok(out.warnings.length);
  assert.equal(p.modules.introduction.content, "");
});
test("evidence-first is a distinct three-stage method", async () => {
  const p = paper(),
    stages: string[] = [];
  let calls = 0;
  const out = await executePaperModule(
    {
      contract: "paper-module/1",
      project: p,
      moduleId: "method",
      methodId: "evidence-first",
      model: "mock",
      instruction: "",
    },
    (stage) => stages.push(stage),
    async () => {
      calls++;
      return calls === 1
        ? {
            claims: [{ claim: "Frozen model", source: "idea spark" }],
            structure: ["monitor", "repair"],
            missingEvidence: [],
          }
        : calls === 2
          ? { content: "Evidence-first method", warnings: [] }
          : { issues: ["No experimental record"] };
    },
  );
  assert.equal(calls, 3);
  assert.deepEqual(stages, ["argument-plan", "writing", "audit"]);
  assert.ok(out.warnings.includes("No experimental record"));
});
test("idea-only experiments do not call a model or manufacture results", async () => {
  const p = paper();
  const out = await executePaperModule(
    {
      contract: "paper-module/1",
      project: p,
      moduleId: "experiments",
      methodId: "orchestra-section",
      model: "mock",
      instruction: "",
    },
    () => {},
    async () => {
      throw Error("model must not be called");
    },
  );
  assert.match(out.content, /TODO/);
  assert.match(out.content, /No performance comparisons/);
});
test("adapter validates unknown citation keys before making a candidate", async () => {
  const p = paper();
  await assert.rejects(
    executePaperModule(
      {
        contract: "paper-module/1",
        project: p,
        moduleId: "method",
        methodId: "orchestra-section",
        model: "mock",
        instruction: "",
      },
      () => {},
      async () => ({ content: "Unsupported [@ghost]", warnings: [] }),
    ),
    /不存在的引用/,
  );
});
test("literature records are verified metadata, not alleged claim verification", async () => {
  const request = async (url: any) => {
    assert.match(String(url), /api.semanticscholar.org/);
    return new Response(
      JSON.stringify({
        data: [
          {
            paperId: "abcd1234efgh5678",
            title: "A real metadata record",
            authors: [{ name: "Author" }],
            year: 2024,
            abstract: "Abstract",
            url: "https://example.org/paper",
          },
        ],
      }),
      { status: 200 },
    );
  };
  const result = await searchLiterature(
    "local repair",
    undefined,
    request as typeof fetch,
  );
  assert.equal(result[0].verification, "metadata-verified");
  assert.equal(result[0].key, "S2_abcd1234efgh");
});
test("rate-limited literature search is an explicit failure without hallucinated fallback", async () => {
  await assert.rejects(
    searchLiterature(
      "query",
      undefined,
      (async () => new Response("", { status: 429 })) as typeof fetch,
    ),
    /HTTP 429/,
  );
});
test("all registered methods expose provenance, stages and supported modules", () => {
  const definitions = adapterDefinitions();
  assert.equal(new Set(definitions.map((m) => m.id)).size, definitions.length);
  assert.ok(definitions.length >= 6);
  assert.ok(
    definitions.every((m) => m.modules.length && m.stages.length && m.version),
  );
});
test("LaTeX export escapes text and preserves math and structured citations", () => {
  const tex = markdownToTex(
    "A & B use $x_t$ [@key].\n\n| Metric | Value |\n|---|---|\n| Accuracy | 50% |",
  );
  assert.match(tex, /A \\& B/);
  assert.match(tex, /\$x_t\$/);
  assert.match(tex, /\\cite\{key\}/);
  assert.match(tex, /\\begin\{tabular\}/);
  assert.match(tex, /50\\%/);
  assert.equal(texEscape("_#"), "\\_\\#");
  assert.match(paperTex(paper()), /TODO/);
});
test("TeX math cannot directly include local files or execute macro definitions", () => {
  assert.throws(() => markdownToTex("$\\input{secret}$"), /不允许/);
  assert.throws(() => markdownToTex("$\\csname input\\endcsname$"), /不允许/);
  assert.throws(() => markdownToTex("$^^5cinput{secret}$"), /不允许/);
  assert.throws(
    () => markdownToTex("$\\begin{document}x\\end{document}$"),
    /不允许/,
  );
  assert.match(markdownToTex("$\\frac{\\alpha}{2}+\\mathbf{x}$"), /\\frac/);
});
test("vector PDF export uses native paths rather than a page-sized raster image", async () => {
  const bytes = await vectorPdf(
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect x="5" y="5" width="190" height="90" fill="#eee"/><text x="15" y="45">Native vector</text></svg>',
    200,
    100,
  );
  assert.equal(bytes.subarray(0, 4).toString(), "%PDF");
  assert.ok(!bytes.toString("latin1").includes("/Subtype /Image"));
});
test("project storage serializes parallel module edits without losing either", async () => {
  const root = await mkdtemp(join(tmpdir(), "paper-workbench-test-")),
    store = new PaperStore(root),
    p = paper();
  await store.save(p);
  await Promise.all([
    store.mutate(p.id, (x) => saveModule(x, "method", 0, "Method")),
    store.mutate(p.id, (x) => saveModule(x, "introduction", 0, "Intro")),
  ]);
  const saved = await store.load(p.id);
  assert.equal(saved.modules.method.content, "Method");
  assert.equal(saved.modules.introduction.content, "Intro");
  assert.equal((await store.list()).length, 1);
  assert.throws(() => store.path("../escape"), /Invalid ID/);
});

test("manual edits preserve the independently selected generation method", () => {
  const p = paper();
  p.modules.introduction.methodId = "evidence-first";
  p.modules.introduction.model = "configured-model";
  saveModule(p, "introduction", 0, "Human revision");
  assert.equal(p.modules.introduction.methodId, "evidence-first");
  assert.equal(p.modules.introduction.model, "configured-model");
  assert.equal(p.modules.introduction.history.at(-1)!.methodId, "manual");
});

test("edited and restored outlines cannot silently use a newer cached plan", () => {
  const p = paper();
  p.outlineData = { section_plan: "Old plan" };
  saveModule(p, "outline", 0, "Human plan v1");
  assert.equal(p.outlineData, undefined);
  p.outlineData = { section_plan: "New AI plan" };
  saveModule(p, "outline", 1, "Human plan v2");
  p.outlineData = { section_plan: "Cached v2" };
  restoreModule(p, "outline", 2, 1);
  assert.equal(p.modules.outline.content, "Human plan v1");
  assert.equal(p.outlineData, undefined);
});

test("independent figure updates keep other figures and append immutable versions", () => {
  const p = paper();
  const scene = {
    schema: "paper-atelier/1",
    width: 200,
    height: 100,
  } as FigureScene;
  const asset = (figureId: string, title: string, version = 1) => ({
    id: randomUUID(),
    figureId,
    version,
    title,
    caption: title + " caption",
    scene,
    createdAt: new Date().toISOString(),
  });
  const add = (a: ReturnType<typeof asset>) => {
    const c = newCandidate(
      p,
      randomUUID(),
      randomUUID(),
      "figures",
      "vector-atelier",
      "",
      { content: a.caption, warnings: [], assets: [a] },
    );
    p.candidates.push(c);
    acceptCandidates(p, [c.id]);
  };
  const a = asset(randomUUID(), "Figure A"),
    b = asset(randomUUID(), "Figure B");
  add(a);
  add(b);
  const a2 = asset(a.figureId, "Figure A revised", 2);
  add(a2);
  assert.deepEqual(new Set(p.modules.figures.assetIds), new Set([a2.id, b.id]));
  assert.equal(
    p.assets.find((v) => v.id === a.id)!.caption,
    "Figure A caption",
  );
  assert.match(p.modules.figures.content, /Figure B/);
  restoreModule(p, "figures", 3, 2);
  assert.deepEqual(p.modules.figures.assetIds, [a.id, b.id]);
  assert.equal(p.assets.length, 3);
  assert.throws(
    () => saveModule(p, "figures", 4, "replace derived overview"),
    /逐图修改/,
  );
});

test("possible absolute scientific claims are warnings, not asserted correctness judgements", async () => {
  const p = paper();
  const result = await executePaperModule(
    {
      contract: "paper-module/1",
      project: p,
      moduleId: "abstract",
      methodId: "orchestra-section",
      model: "test",
      instruction: "",
    },
    () => {},
    async () => ({
      content: "Our approach consistently improves performance.",
      warnings: [],
    }),
  );
  assert.ok(result.warnings.some((w) => w.includes("风险提示")));
});

test("missing references remain visible in LaTeX and unsafe citation keys are refused", () => {
  const p = paper();
  p.modules.references.content = "[TODO: Literature service was unavailable.]";
  assert.match(paperTex(p), /Literature service was unavailable/);
  p.citations.push({
    id: "bad",
    key: "bad}\\input{secret}",
    title: "Bad imported key",
    authors: [],
    year: null,
    venue: "",
    abstract: "",
    url: "",
    verification: "user-provided",
    provider: "Manual",
  });
  assert.throws(() => bibliographyTex(p), /引用键/);
});
