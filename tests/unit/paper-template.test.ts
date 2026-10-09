import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { unzipSync, strFromU8, zipSync, strToU8 } from 'fflate';
import { validateTemplate, templatePreamble } from '../../shared/paper-template';
import { createPaper, replaceSources } from '../../shared/paper-project';
import { paperTex, paperSourceBundle } from '../../server/paper/export';
import { readTemplate, readTemplateFiles } from '../../src/paper/template-upload';

const template = () => ({ name: 'Conference template', entry: 'template.tex', files: [
  { name: 'template.tex', content: '\\documentclass{article}\n\\usepackage{conference}\n\\title{Example {nested} title}\n\\author{Template Author}\n\\begin{document}\nEXAMPLE BODY NOT OUR EVIDENCE\n\\end{document}' },
  { name: 'conference.sty', content: '\\ProvidesPackage{conference}\n\\setlength{\\textwidth}{5.5in}' },
] });

test('template parsing preserves the actual style and removes only sample manuscript and metadata', () => {
  const value = validateTemplate(template())!;
  const preamble = templatePreamble(value);
  assert.match(preamble, /\\usepackage\{conference\}/);
  assert.doesNotMatch(preamble, /Template Author|Example|EXAMPLE BODY/);
  const p = createPaper(randomUUID(), 'Actual paper', 'Real idea');
  p.template = value;
  p.modules.abstract.content = 'Actual abstract.';
  const source = paperTex(p);
  assert.match(source, /\\title\{Actual paper\}/);
  assert.match(source, /Actual abstract/);
  assert.doesNotMatch(source, /Template Author|EXAMPLE BODY|Research draft:/);
});

test('template import rejects traversal, Windows devices, case collisions, and oversized contents', () => {
  for (const name of ['../bad.sty', 'C:\\bad.sty', 'NUL.sty', 'aux.tex', 'sub/f.tex']) {
    const value = template(); value.files[1].name = name;
    assert.throws(() => validateTemplate(value));
  }
  const duplicate = template(); duplicate.files.push({ name: 'CONFERENCE.sty', content: '' });
  assert.throws(() => validateTemplate(duplicate), /重复/);
  const huge = template(); huge.files[1].content = 'x'.repeat(4_000_001);
  assert.throws(() => validateTemplate(huge), /4 MB/);
});

test('a ZIP upload carries the template dependencies as part of one input', async () => {
  const value = template();
  const bytes = zipSync(Object.fromEntries(value.files.map(f => [`bundle/${f.name}`, strToU8(f.content)])));
  const uploaded = await readTemplate(new File([bytes], 'conference.zip'));
  assert.equal(uploaded.entry, 'template.tex');
  assert.deepEqual(uploaded.files, value.files);
});

test('source ZIP bundles the generated manuscript and unchanged conference style', async () => {
  const p = createPaper(randomUUID(), 'Actual paper', 'Idea'); p.template = template();
  const archive = unzipSync(await paperSourceBundle(p));
  assert.match(strFromU8(archive['main.tex']), /\\title\{Actual paper\}/);
  assert.equal(strFromU8(archive['conference.sty']), template().files[1].content);
  assert.ok(archive['references.bib']);
  assert.equal(JSON.parse(strFromU8(archive['project.json'])).id,p.id);
  assert.ok(archive['manuscript.md']);
  assert.equal(archive['template.tex'], undefined);
});

test('changing the template invalidates candidates without rewriting existing sections', () => {
  const p = createPaper(randomUUID(), 'Paper', 'Idea'); p.modules.method.content = 'Human-authored method.';
  replaceSources(p, p.revision, { title: p.title, ideaSpark: p.ideaSpark, materials: p.materials,
    language: p.language, guidelines: p.guidelines, template: template() });
  assert.equal(p.sourceRevision, 1);
  assert.equal(p.modules.method.content, 'Human-authored method.');
  assert.deepEqual(p.modules.method.needsSync, ['materials']);
  assert.equal(p.template?.entry, 'template.tex');
});

test('main and style files can be uploaded together in the single template slot', async () => {
  const value = template();
  const result = await readTemplateFiles(value.files.map(f => new File([f.content], f.name)));
  assert.equal(result.entry, 'template.tex');
  assert.deepEqual(result.files, value.files);
});

test('dependency-only upload completes the current template and preserves its main file', async () => {
  const value = template(); value.files.pop();
  const result = await readTemplateFiles([new File(['STYLE'], 'conference.sty')], value);
  assert.deepEqual(result.files, [...value.files, { name: 'conference.sty', content: 'STYLE' }]);
  assert.equal(result.name, value.name);
  await assert.rejects(readTemplateFiles([new File(['STYLE'], 'conference.sty')]), /主 .tex/);
  await assert.rejects(readTemplateFiles([new File(['bad'], '../bad.sty')], value), /同一目录/);
});

test('a new main file replaces dependencies from the previous template', async () => {
  const result = await readTemplateFiles([new File([template().files[0].content], 'new.tex')], template());
  assert.equal(result.files.length, 1);
  assert.equal(result.entry, 'new.tex');
});

test('completing unchanged template dependencies does not invalidate chapters or provenance', () => {
  const p = createPaper(randomUUID(), 'Paper', 'Idea');
  p.template = template(); p.template.files.pop();
  p.modules.method.content = 'Human-authored method.';
  const modules = structuredClone(p.modules), sourceRevision = p.sourceRevision;
  replaceSources(p, p.revision, { title: p.title, ideaSpark: p.ideaSpark, materials: p.materials,
    language: p.language, guidelines: p.guidelines, template: template() });
  assert.equal(p.sourceRevision, sourceRevision);
  assert.deepEqual(p.modules, modules);
  assert.equal(p.template.files.length, 2);
  assert.equal(p.revision, 1);
});
