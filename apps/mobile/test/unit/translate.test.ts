/**
 * El traductor del móvil debe enviar al modelo lo mismo que el de Python y devolver el mismo resultado.
 * Los casos los calcula `tools/export_translate_fixtures.py` con el código real del motor del PC.
 */
import { describe, expect, it } from 'vitest';
import type { GlossaryEntry, Page, Project, Region } from '@starblitz/shared';
import cases from '../fixtures/translate_cases.json';
import { ContextualTranslator, estimateMaxChars, isRefusal, mergeMemory } from '../../src/engine/translate/contextual';
import { LLMClient, parseJson, type ChatMessage } from '../../src/engine/translate/llm';
import * as quality from '../../src/engine/translate/quality';

class Scripted extends LLMClient {
  calls: { messages: { role: string; content: string; images: number }[]; schema: string; temperature: number; model: string }[] = [];
  constructor(private script: string[]) { super({ temperature: 0.3, timeout_s: 60, use_vision: true }); }
  async health() { return { ok: true }; }
  protected async chat(messages: ChatMessage[], schema: object, o: { model: string; temperature: number }) {
    this.calls.push({
      messages: messages.map((m) => ({ role: m.role, content: m.content, images: m.images?.length ?? 0 })),
      schema: 'new_terms' in (schema as { properties: object }).properties ? 'translation' : 'review', temperature: o.temperature, model: o.model,
    });
    return this.script.shift() ?? '';
  }
}

const strip = (r: Region) => { const { updated: _u, ...rest } = r; return rest; };

describe('traductor contextual (paridad con Python)', () => {
  for (const c of cases.cases) {
    it(c.name, async () => {
      const input = c.input as unknown as { project: Project; page: Page; prev: Page | null; next: Page | null; story: string[]; image: boolean; script: string[]; settings: { quality: 'balanced' | 'max'; review_threshold: number; dictionary: GlossaryEntry[] } };
      const client = new Scripted(input.script);
      const tr = new ContextualTranslator(client, 'modelo-prueba', { quality: input.settings.quality, review_threshold: input.settings.review_threshold, dictionary: input.settings.dictionary } as never);
      const project = structuredClone(input.project);
      const result = await tr.translatePage(project, input.page, {
        prevPage: input.prev, nextPage: input.next, story: input.story, imageJpeg: input.image ? new Uint8Array([0x6a, 0x70, 0x65, 0x67]) : null,
      });
      // Lo que se envía al modelo, idéntico carácter a carácter
      expect(client.calls).toEqual(c.calls);
      // Lo que se obtiene
      expect(result.updated.map(strip)).toEqual(c.result.updated);
      expect(result.summary).toBe(c.result.summary);
      expect(result.reviewed).toBe(c.result.reviewed);
      expect(result.repaired ?? 0).toBe((c.result as { repaired?: number }).repaired ?? 0);
      expect(result.newTerms).toEqual(c.result.new_terms);
      expect(result.characters).toEqual(c.result.characters);
      // Memoria de la obra tras incorporar lo aprendido
      mergeMemory(project, result);
      expect(project.glossary).toEqual(c.merged.glossary);
      expect(project.characters).toEqual(c.merged.characters);
    });
  }

  it('controles de calidad (eco, invención, vosotros, nombres, mayúsculas) iguales que en Python', () => {
    for (const q of (cases as unknown as { quality: { source: string; translation: string; echo: string; variant: string; names: [string, string][]; issues: string[]; case: string; length: number[]; echo_ok: boolean | null; lost: string[] }[] }).quality) {
      const label = `${q.source} → ${q.translation}`;
      expect(quality.check(q.source, q.translation, q.echo, q.variant, q.names), label).toEqual(q.issues);
      expect(quality.matchCase(q.source, q.translation), label).toBe(q.case);
      expect([quality.contentLength(q.source), quality.contentLength(q.translation)], label).toEqual(q.length);
      expect(quality.echoMatches(q.source, q.echo), label).toBe(q.echo_ok);
      expect(quality.lostNames(q.source, q.translation, q.names), label).toEqual(q.lost);
    }
  });

  it('detecta las negativas del modelo igual que Python', () => {
    for (const { text, match } of cases.refusal) expect(isRefusal(text), text).toBe(match);
  });

  it('calcula los caracteres que caben en un globo igual que Python', () => {
    for (const e of cases.estimate) {
      expect(estimateMaxChars(e.box as [number, number, number, number], e.line, e.h, e.bubble), JSON.stringify(e)).toBe(e.out);
    }
  });

  it('interpreta las respuestas JSON del modelo igual que Python', () => {
    for (const { raw, out } of cases.parse_json) {
      if ('error' in out) expect(() => parseJson(raw), raw).toThrow();
      else expect(parseJson(raw), raw).toEqual(out.ok);
    }
  });
});
