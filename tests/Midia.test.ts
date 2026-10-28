import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MediaOutputStrategy } from '../src/canais/telegram/output/strategies/MediaOutputStrategy.js';
import type { TelegramSender } from '../src/canais/telegram/output/TelegramSender.js';

describe('Entrega de áudio e vídeo no Telegram', () => {
  it('áudio vai como música, vídeo como vídeo; acima do limite avisa onde ficou salvo', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'midia-tg-'));
    const small = path.join(dir, 'musica.mp3');
    const clip = path.join(dir, 'clipe.mp4');
    const big = path.join(dir, 'filme.mp4');
    fs.writeFileSync(small, 'a'.repeat(10));
    fs.writeFileSync(clip, 'v'.repeat(10));
    fs.writeFileSync(big, 'x'.repeat(100));
    const sent: string[] = [];
    const notes: string[] = [];
    const sender = {
      sendAudio: async (_c: number, p: string) => sent.push(`audio ${path.basename(p)}`),
      sendVideo: async (_c: number, p: string) => sent.push(`video ${path.basename(p)}`),
      sendDocument: async (_c: number, p: string) => sent.push(`doc ${path.basename(p)}`),
    } as unknown as TelegramSender;
    const strategy = new MediaOutputStrategy(sender, async (_c, text) => void notes.push(text), 50);
    await strategy.send(1, [
      { path: small, kind: 'audio' },
      { path: clip, kind: 'video' },
      { path: big, kind: 'video' },
    ]);
    assert.deepEqual(sent, ['audio musica.mp3', 'video clipe.mp4']);
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /limite de 50 MB[\s\S]*filme\.mp4/);
  });
});
