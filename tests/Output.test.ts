import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AllProvidersFailedError, EmptyAudioError } from '../src/errors/AppErrors.js';
import { FileTagParser } from '../src/telegram/output/FileTagParser.js';
import { ErrorOutputStrategy } from '../src/telegram/output/strategies/ErrorOutputStrategy.js';
import { TelegramOutputHandler } from '../src/telegram/output/TelegramOutputHandler.js';
import { TextChunker } from '../src/telegram/output/TextChunker.js';
import { stripMarkdown } from '../src/utils/text.js';

describe('TextChunker', () => {
  const chunker = new TextChunker(4096);

  it('não fatia textos dentro do limite', () => {
    assert.deepEqual(chunker.split('curto'), ['curto']);
  });

  it('RF-01: 9000 chars viram 3 bolhas, todas ≤ 4096, sem cortar palavras', () => {
    const words = Array.from({ length: 1500 }, (_, i) => `pal${String(i).padStart(2, '0')}`).join(' ');
    const text = words.slice(0, 9000);
    const chunks = chunker.split(text);
    assert.equal(chunks.length, 3);
    for (const chunk of chunks) assert.ok(chunk.length <= 4096);
    assert.equal(chunks.join(' '), text);
  });

  it('prefere quebra de parágrafo', () => {
    const p1 = 'a'.repeat(3000);
    const p2 = 'b'.repeat(3000);
    assert.deepEqual(chunker.split(`${p1}\n\n${p2}`), [p1, p2]);
  });

  it('fecha e reabre blocos de código cortados', () => {
    const code = Array.from({ length: 400 }, (_, i) => `const linha${i} = ${i};`).join('\n');
    const chunks = chunker.split(`Código:\n\`\`\`ts\n${code}\n\`\`\``);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 4096);
      assert.equal((chunk.match(/```/g) ?? []).length % 2, 0, 'cada chunk deve ter fences balanceados');
    }
    assert.ok(chunks[1]!.startsWith('```ts\n'));
  });

  it('não parte emojis (surrogate pairs) no corte duro', () => {
    const text = '😀'.repeat(3000);
    for (const chunk of chunker.split(text)) {
      assert.ok(!/[\ud800-\udbff]$/.test(chunk));
      assert.ok(!/^[\udc00-\udfff]/.test(chunk));
    }
  });
});

describe('FileTagParser', () => {
  it('RF-02: extrai documentos e mantém o texto de acompanhamento', () => {
    const parsed = FileTagParser.parse('Segue o PRD:\n<arquivo nome="spec auth.md">\n# Spec\nconteúdo\n</arquivo>\nAbraço');
    assert.equal(parsed.text, 'Segue o PRD:\n\nAbraço');
    assert.deepEqual(parsed.files, [{ filename: 'spec-auth.md', content: '# Spec\nconteúdo' }]);
  });

  it('trata tag não fechada (resposta truncada) e sanitiza nomes perigosos', () => {
    const parsed = FileTagParser.parse('Ok <arquivo nome="../../etc/passwd">dados');
    assert.equal(parsed.text, 'Ok');
    assert.equal(parsed.files[0]!.filename, 'passwd.md');
  });

  it('texto sem tags passa intacto', () => {
    assert.deepEqual(FileTagParser.parse('só texto'), { text: 'só texto', files: [] });
  });
});

describe('ErrorOutputStrategy', () => {
  it('RF-03: formata com ⚠️ e nunca vaza detalhes técnicos', () => {
    assert.match(ErrorOutputStrategy.format(new AllProvidersFailedError(['gemini'])), /^⚠️ Erro: API Provider gemini falhou/);
    assert.equal(ErrorOutputStrategy.format(new EmptyAudioError()), '⚠️ Áudio vazio captado. Pode reenviar?');
    const leaked = ErrorOutputStrategy.format(new Error('key=AIzaSecreta stack...'));
    assert.ok(!leaked.includes('AIza'));
  });
});

describe('TelegramOutputHandler', () => {
  function recorder(failAudio = false) {
    const log: string[] = [];
    const handler = new TelegramOutputHandler({
      text: { send: async (_c, text) => void log.push(`text:${text}`) },
      file: { send: async (_c, file) => void log.push(`file:${file.filename}`) },
      error: { send: async () => void log.push('error') },
      audio: {
        send: async (_c, text) => {
          if (failAudio) throw new Error('tts down');
          log.push(`audio:${text}`);
        },
      },
    });
    return { log, handler };
  }

  it('envia texto e depois os arquivos', async () => {
    const { log, handler } = recorder();
    await handler.send(1, { text: 'Pronto!\n<arquivo nome="a.md">x</arquivo>', isAudio: false });
    assert.deepEqual(log, ['text:Pronto!', 'file:a.md']);
  });

  it('RF-04: usa áudio quando isAudio=true', async () => {
    const { log, handler } = recorder();
    await handler.send(1, { text: 'Olá', isAudio: true });
    assert.deepEqual(log, ['audio:Olá']);
  });

  it('fallback para texto com aviso quando o TTS falha', async () => {
    const { log, handler } = recorder(true);
    await handler.send(1, { text: 'Olá', isAudio: true });
    assert.equal(log.length, 1);
    assert.match(log[0]!, /^text:⚠️ Não consegui gerar o áudio/);
  });
});

describe('stripMarkdown', () => {
  it('limpa sintaxe para TTS preservando snake_case', () => {
    assert.equal(stripMarkdown('## Título\n**negrito** e `criar_arquivo` em [link](http://x)'), 'Título\nnegrito e criar_arquivo em link');
  });
});
