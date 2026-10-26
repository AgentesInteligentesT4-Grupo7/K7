import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ResponseAttachments } from '../src/agent/ResponseAttachments.js';
import { MediaOutputStrategy } from '../src/canais/telegram/output/strategies/MediaOutputStrategy.js';
import type { TelegramSender } from '../src/canais/telegram/output/TelegramSender.js';
import { UserFacingError } from '../src/errors/AppErrors.js';
import { DownloadMediaTool } from '../src/modules/midia/DownloadMediaTool.js';
import { YtdlpClient } from '../src/modules/midia/YtdlpClient.js';
import { DEFAULT_MODULES, MODULE_IDS } from '../src/modules/registry.js';

/** Serviço ytdlp de mentira: o primeiro status responde "rodando", o seguinte "ok" (ou o erro pedido). */
function fakeService(behavior: { error?: string; files?: Array<{ nome: string; conteudo: string }>; falhas?: Array<{ link: string | null; motivo: string }> }) {
  const requests: Array<{ method: string; url: string; body?: unknown }> = [];
  let polls = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      requests.push({ method: req.method!, url: req.url!, ...(raw ? { body: JSON.parse(raw) } : {}) });
      const json = (status: number, body: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
      if (req.url === '/baixar') return json(200, { id: 'abc' });
      if (req.url === '/trabalhos/abc' && req.method === 'GET') {
        polls++;
        if (polls === 1) return json(200, { status: 'rodando', progresso: '0/?', arquivos: [], erro: null });
        const falhas = behavior.falhas ?? [];
        if (behavior.error) return json(200, { status: 'erro', progresso: '1/1', arquivos: [], falhas, erro: behavior.error });
        const arquivos = (behavior.files ?? []).map((f) => ({ nome: f.nome, bytes: f.conteudo.length }));
        return json(200, { status: 'ok', progresso: `${arquivos.length}/${arquivos.length}`, arquivos, falhas, erro: null });
      }
      const file = (behavior.files ?? []).find((f) => req.url === `/trabalhos/abc/arquivos/${encodeURIComponent(f.nome)}`);
      if (file) return res.writeHead(200).end(file.conteudo);
      if (req.method === 'DELETE') return json(200, { ok: true });
      json(404, { detail: 'não encontrado' });
    });
  });
  return { server, requests };
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('Módulo midia: cliente do serviço yt-dlp', () => {
  const ok = fakeService({
    files: [{ nome: 'Musica.mp3', conteudo: 'ID3-audio' }],
    falhas: [{ link: 'https://youtu.be/AAAAAAAAAAA', motivo: 'vídeo privado' }],
  });
  let okUrl = '';
  before(async () => (okUrl = await listen(ok.server)));
  after(() => ok.server.close());

  it('pede o download, acompanha até terminar, copia o arquivo (sem sobrescrever) e apaga o trabalho no serviço', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'midia-'));
    fs.writeFileSync(path.join(dir, 'Musica.mp3'), 'antigo');
    const progress: string[] = [];
    const client = new YtdlpClient({ baseUrl: okUrl, timeoutMs: 5_000, pollMs: 10 });
    const { files, failures } = await client.download({ url: 'https://youtu.be/x', formato: 'mp3', playlist: false, maxItens: 25 }, dir, (p) => progress.push(p));
    assert.deepEqual(files.map((f) => path.basename(f.path)), ['Musica (2).mp3']);
    assert.deepEqual(failures, [{ link: 'https://youtu.be/AAAAAAAAAAA', motivo: 'vídeo privado' }], 'vídeo pulado volta com link e motivo');
    assert.equal(fs.readFileSync(files[0]!.path, 'utf8'), 'ID3-audio');
    assert.equal(fs.readFileSync(path.join(dir, 'Musica.mp3'), 'utf8'), 'antigo', 'o arquivo que já existia fica');
    assert.deepEqual(progress, ['0/?', '1/1']);
    assert.deepEqual(ok.requests[0]!.body, { url: 'https://youtu.be/x', formato: 'mp3', playlist: false, max_itens: 25 });
    assert.equal(ok.requests.at(-1)!.method, 'DELETE');
  });

  it('erro do yt-dlp vira mensagem que a pessoa entende; serviço fora do ar diz como subir', async () => {
    const failing = fakeService({
      error: 'ERROR: [youtube] abc: Private video. Sign in if you have access',
      falhas: [{ link: 'https://youtu.be/BBBBBBBBBBB', motivo: 'vídeo privado' }],
    });
    const url = await listen(failing.server);
    try {
      const client = new YtdlpClient({ baseUrl: url, timeoutMs: 5_000, pollMs: 10 });
      await assert.rejects(
        client.download({ url: 'https://youtu.be/x', formato: 'mp4', playlist: false, maxItens: 1 }, os.tmpdir()),
        /o vídeo é privado[\s\S]*https:\/\/youtu\.be\/BBBBBBBBBBB: vídeo privado/,
      );
      assert.equal(failing.requests.at(-1)!.method, 'DELETE', 'apaga o trabalho mesmo com erro');
    } finally {
      failing.server.close();
    }
    const offline = new YtdlpClient({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 1_000 });
    await assert.rejects(offline.healthCheck(), (error: unknown) => error instanceof UserFacingError && /docker compose -f servicos\/ytdlp/.test(error.userMessage));
  });
});

describe('Módulo midia: ferramenta baixar_youtube', () => {
  it('só aceita YouTube; link só de playlist baixa a playlist; arquivos vão junto da resposta', async () => {
    const calls: unknown[] = [];
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'midia-ws-'));
    const client = {
      download: async (request: unknown, targetDir: string) => {
        calls.push(request);
        fs.mkdirSync(targetDir, { recursive: true });
        const file = path.join(targetDir, 'Aula.mp4');
        fs.writeFileSync(file, 'video');
        return {
          files: [{ path: file, id: 'VIDEOAULA01' }],
          failures: calls.length === 1 ? [{ link: 'https://youtu.be/CCCCCCCCCCC', motivo: 'vídeo excluído ou indisponível' }] : [],
          skipped: [],
        };
      },
    } as unknown as YtdlpClient;
    const tool = new DownloadMediaTool(client, workspace, 25);

    await assert.rejects(tool.execute({ url: 'https://vimeo.com/123' }), /Só links do YouTube/);
    await assert.rejects(tool.execute({ url: 'https://youtu.be/x', formato: 'avi' }), /deve ser um de/);

    const { result, media } = await ResponseAttachments.collect(() =>
      tool.execute({ url: 'https://www.youtube.com/playlist?list=PL123', formato: 'mp4', max_itens: 500 }),
    );
    assert.deepEqual(calls[0], { url: 'https://www.youtube.com/playlist?list=PL123', formato: 'mp4', playlist: true, maxItens: 25, pular: [] });
    assert.deepEqual(media.map((m) => [path.basename(m.path), m.kind]), [['Aula.mp4', 'video']]);
    assert.match(result.output, /^ok: 1 arquivo\(s\) MP4/);
    assert.match(result.output, /1 vídeo\(s\) com problema foram pulados[\s\S]*INFORME AO USUÁRIO[\s\S]*https:\/\/youtu\.be\/CCCCCCCCCCC: vídeo excluído ou indisponível/);
    assert.equal(path.dirname(media[0]!.path), path.join(workspace, 'downloads'));

    await tool.execute({ url: 'https://www.youtube.com/watch?v=abc&list=PL123' });
    assert.deepEqual(calls[1], { url: 'https://www.youtube.com/watch?v=abc&list=PL123', formato: 'mp3', playlist: false, maxItens: 25, pular: [] }, 'vídeo de uma playlist: só o vídeo');

    // Sem teto configurado (padrão): a playlist inteira, ou a quantidade pedida.
    const unlimited = new DownloadMediaTool(client, workspace);
    await unlimited.execute({ url: 'https://www.youtube.com/playlist?list=PL123' });
    assert.equal((calls[2] as { maxItens?: number }).maxItens, undefined);
    await unlimited.execute({ url: 'https://www.youtube.com/playlist?list=PL123', max_itens: 300 });
    assert.equal((calls[3] as { maxItens?: number }).maxItens, 300);
  });

  it('música já baixada (mesmo ID e formato) não baixa de novo: o serviço pula e o arquivo existente é entregue', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'midia-indice-'));
    const requests: Array<{ pular?: string[] }> = [];
    const client = {
      download: async (request: { pular?: string[] }, targetDir: string) => {
        requests.push(request);
        fs.mkdirSync(targetDir, { recursive: true });
        if (requests.length === 1) {
          const file = path.join(targetDir, 'Artista - Musica.mp3');
          fs.writeFileSync(file, 'ID3');
          return { files: [{ path: file, id: 'IDMUSICA001' }], failures: [], skipped: [] };
        }
        // Segunda vez: o serviço recebeu o ID em "pular" e devolve que ele estava no link.
        return { files: [], failures: [], skipped: request.pular ?? [] };
      },
    } as unknown as YtdlpClient;
    const tool = new DownloadMediaTool(client, workspace);

    await tool.execute({ url: 'https://youtu.be/IDMUSICA001', formato: 'mp3' });
    const { result, media } = await ResponseAttachments.collect(() => tool.execute({ url: 'https://youtu.be/IDMUSICA001', formato: 'mp3' }));
    assert.deepEqual(requests[1]!.pular, ['IDMUSICA001']);
    assert.deepEqual(media.map((m) => path.basename(m.path)), ['Artista - Musica.mp3']);
    assert.match(result.output, /0 baixado\(s\) agora e 1 que já tinham sido baixados antes/);

    // Em outro formato é outro arquivo: baixa normalmente.
    await tool.execute({ url: 'https://youtu.be/IDMUSICA001', formato: 'wav' });
    assert.deepEqual(requests[2]!.pular, []);
  });

  it('o módulo existe, mas fica fora do padrão sem fita (precisa do serviço)', () => {
    assert.ok(MODULE_IDS.includes('midia'));
    assert.ok(!DEFAULT_MODULES.split(',').includes('midia'));
  });
});

describe('Módulo midia: entrega no Telegram', () => {
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
