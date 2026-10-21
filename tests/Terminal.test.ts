import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { AgentController } from '../src/agent/AgentController.js';
import type { AgentInput } from '../src/agent/types.js';
import { TerminalChat } from '../src/cli/TerminalChat.js';
import { TerminalOutputHandler } from '../src/cli/TerminalOutputHandler.js';
import { DocumentExtractor } from '../src/telegram/input/DocumentExtractor.js';
import type { ITextToSpeech } from '../src/telegram/output/tts/TextToSpeech.js';
import type { VoiceCloneService } from '../src/voice/VoiceCloneService.js';
import { VoiceNotFoundError } from '../src/voice/VoiceLibrary.js';

const fakeTts = (voice = 'pf_dora'): ITextToSpeech => ({
  name: 'fake',
  voice,
  synthesize: async () => ({ audio: Buffer.from('OggS'), format: 'ogg' }),
});

function setup() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term-'));
  const printed: string[] = [];
  const write = (text: string) => void printed.push(text);
  const output = new TerminalOutputHandler({
    outputDir: outDir,
    autoPlay: false,
    tts: fakeTts(),
    clonedVoices: { asTextToSpeech: (voice) => fakeTts(voice ?? 'minha-voz') },
    write,
  });
  const inputs: AgentInput[] = [];
  const events: string[] = [];
  const controller = {
    handle: async (input: AgentInput) => void inputs.push(input),
    newConversation: (userId: string) => void events.push(`nova:${userId}`),
    listSkills: () => [{ name: 'resumidor', description: 'Resume textos', directory: '', filePath: '' }],
  } as unknown as AgentController;
  const chat = new TerminalChat({
    controller,
    output,
    documents: new DocumentExtractor(),
    stt: { transcribe: async () => 'transcrição do áudio' },
    voiceClone: { list: () => [], voicesDir: '/vozes' } as unknown as VoiceCloneService,
    userId: 'terminal',
    voiceId: 'pf_dora',
    maxDocumentChars: 10_000,
    write,
  });
  return { chat, output, inputs, events, printed, outDir };
}

describe('TerminalChat', () => {
  it('texto vira AgentInput do canal terminal, com a conversa própria', async () => {
    const { chat, inputs } = setup();
    await chat.handleLine('Qual a capital da França?');
    assert.equal(inputs.length, 1);
    assert.deepEqual(
      { userId: inputs[0]!.userId, channel: inputs[0]!.channel, source: inputs[0]!.source, audio: inputs[0]!.requiresAudioReply },
      { userId: 'terminal', channel: 'terminal', source: 'text', audio: false },
    );
    await chat.handleLine('responda em áudio: oi');
    assert.equal(inputs[1]!.requiresAudioReply, true);
    assert.equal(inputs[1]!.voiceId, 'pf_dora');
  });

  it('/arquivo extrai o documento (inclusive caminho com espaço entre aspas) e mantém a instrução', async () => {
    const { chat, inputs } = setup();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc com espaço-'));
    const file = path.join(dir, 'notas.md');
    fs.writeFileSync(file, '# Reunião\nDecidimos migrar para Postgres.');
    await chat.handleLine(`/arquivo "${file}" resuma em uma frase`);
    assert.equal(inputs[0]!.source, 'document');
    assert.equal(inputs[0]!.attachmentName, 'notas.md');
    assert.match(inputs[0]!.text, /^resuma em uma frase\n\n\[Documento anexado: notas\.md\]\n# Reunião/);
  });

  it('/audio transcreve e envia como voz (resposta em áudio por padrão)', async () => {
    const { chat, inputs } = setup();
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aud-')), 'a.ogg');
    fs.writeFileSync(file, 'x');
    await chat.handleLine(`/audio ${file}`);
    assert.deepEqual({ text: inputs[0]!.text, source: inputs[0]!.source, audio: inputs[0]!.requiresAudioReply }, { text: 'transcrição do áudio', source: 'voice', audio: true });
  });

  it('comandos locais: /nova, /skills, /sair, desconhecido e arquivo inexistente', async () => {
    const { chat, events, printed, inputs } = setup();
    await chat.handleLine('/nova');
    await chat.handleLine('/skills');
    await chat.handleLine('/xyz');
    await chat.handleLine('/arquivo C:\\nao\\existe.pdf');
    assert.equal(await chat.handleLine('/sair'), 'exit');
    assert.deepEqual(events, ['nova:terminal']);
    assert.ok(printed.some((p) => p.includes('resumidor')));
    assert.ok(printed.some((p) => p.includes('Comando desconhecido')));
    assert.ok(printed.some((p) => p.includes('Arquivo não encontrado')));
    assert.equal(inputs.length, 0);
  });

  it('parsePathArgument separa caminho e resto', () => {
    assert.deepEqual(TerminalChat.parsePathArgument('"C:\\a b\\x.pdf" resuma'), { filePath: 'C:\\a b\\x.pdf', remainder: 'resuma' });
    assert.deepEqual(TerminalChat.parsePathArgument('C:\\x.pdf'), { filePath: 'C:\\x.pdf', remainder: '' });
  });
});

describe('TerminalOutputHandler', () => {
  it('imprime o texto, salva documentos e áudios como arquivos locais', async () => {
    const { output, printed, outDir } = setup();
    await output.send(0, { text: 'Pronto!\n<arquivo nome="spec.md"># Spec</arquivo>\n<voz_clonada>Oi Maria</voz_clonada>', isAudio: true });
    const files = fs.readdirSync(outDir).sort();
    assert.ok(files.some((f) => f.endsWith('-spec.md')));
    assert.ok(files.some((f) => f.endsWith('-resposta.ogg')));
    assert.ok(files.some((f) => f.endsWith('-voz-minha-voz.ogg')));
    assert.ok(printed.some((p) => p.includes('Pronto!')));
    assert.equal(fs.readFileSync(path.join(outDir, files.find((f) => f.endsWith('-spec.md'))!), 'utf8'), '# Spec');
  });

  it('voz clonada sem voz cadastrada vira aviso, não exceção', async () => {
    const printed: string[] = [];
    const output = new TerminalOutputHandler({
      outputDir: os.tmpdir(),
      autoPlay: false,
      tts: fakeTts(),
      clonedVoices: {
        asTextToSpeech: () => {
          throw new VoiceNotFoundError('Nenhuma voz cadastrada ainda.');
        },
      },
      write: (t) => void printed.push(t),
    });
    await output.sendClonedVoice(0, 'oi');
    assert.match(printed.join(''), /Nenhuma voz cadastrada/);
  });
});
