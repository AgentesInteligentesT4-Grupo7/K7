import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AudioIntentDetector } from '../src/telegram/input/AudioIntentDetector.js';
import { DocumentExtractor } from '../src/telegram/input/DocumentExtractor.js';
import { WhisperTranscriber } from '../src/telegram/input/WhisperTranscriber.js';
import { ChatQueue } from '../src/utils/ChatQueue.js';
import { sleep } from '../src/utils/text.js';

describe('AudioIntentDetector (RF-06 / EC-07)', () => {
  const positives = [
    'Cria um PRD pro meu app e me responde em áudio',
    'responda em audio por favor',
    'manda um áudio explicando',
    'fale comigo sobre o clima',
    'quero a resposta por voz',
    'Me manda uma mensagem de voz',
  ];
  const negatives = [
    'responda isso sem ser em áudio',
    'não precisa mandar áudio',
    'qual o melhor formato de áudio para podcast?',
    'resuma o texto',
    'responda em texto',
  ];

  for (const text of positives) it(`detecta pedido: "${text}"`, () => assert.equal(AudioIntentDetector.resolve(text, false), true));
  for (const text of negatives) it(`ignora: "${text}"`, () => assert.equal(AudioIntentDetector.resolve(text, false), false));

  it('voice note assume áudio por padrão, salvo negação explícita', () => {
    assert.equal(AudioIntentDetector.resolve('qual a capital da França', true), true);
    assert.equal(AudioIntentDetector.resolve('me responde em texto', true), false);
  });
});

describe('DocumentExtractor', () => {
  const extractor = new DocumentExtractor();

  it('aceita PDF e Markdown, rejeita o resto (EC-01)', () => {
    assert.equal(extractor.find('a.pdf', 'application/pdf')?.extension, '.pdf');
    assert.equal(extractor.find('scan', 'application/pdf')?.extension, '.pdf');
    assert.equal(extractor.find('notas.MD', 'application/octet-stream')?.extension, '.md');
    assert.equal(extractor.find('planilha.xlsx', 'application/vnd.ms-excel'), undefined);
    assert.equal(extractor.find('foto.jpg', 'image/jpeg'), undefined);
    assert.equal(extractor.find('doc.docx', undefined), undefined);
  });
});

describe('WhisperTranscriber.clean', () => {
  it('remove marcadores de silêncio (EC-03 áudio mudo)', () => {
    assert.equal(WhisperTranscriber.clean(' [BLANK_AUDIO] \n'), '');
    assert.equal(WhisperTranscriber.clean('Olá,\n  tudo bem? [MUSIC]'), 'Olá, tudo bem?');
  });
});

describe('ChatQueue', () => {
  it('serializa tarefas do mesmo chat e paraleliza chats diferentes', async () => {
    const queue = new ChatQueue();
    const order: string[] = [];
    const task = (label: string, ms: number) => async () => {
      await sleep(ms);
      order.push(label);
    };
    await Promise.all([
      queue.enqueue(1, task('1a', 30)),
      queue.enqueue(1, task('1b', 1)),
      queue.enqueue(2, task('2a', 5)),
    ]);
    assert.deepEqual(order, ['2a', '1a', '1b']);
  });

  it('uma tarefa com erro não trava a fila', async () => {
    const queue = new ChatQueue();
    let ran = false;
    void queue.enqueue(1, async () => {
      throw new Error('boom');
    });
    await queue.enqueue(1, async () => {
      ran = true;
    });
    assert.ok(ran);
  });
});
