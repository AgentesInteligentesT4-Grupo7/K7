import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AcessoCloudflare, PessoasDaAdmin } from '../src/canais/admin/AdminPessoas.js';
import { AdminServer } from '../src/canais/admin/AdminServer.js';
import { FitaRunner } from '../src/canais/admin/FitaRunner.js';

const EQUIPE = 'equipe.cloudflareaccess.com';
const AUD = 'aud-da-aplicacao';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

function jwt(payload: Record<string, unknown>, kid = 'k1', chave = privateKey): string {
  const corpo = `${b64({ alg: 'RS256', kid })}.${b64({ aud: [AUD], iss: `https://${EQUIPE}`, exp: Math.floor(Date.now() / 1000) + 600, ...payload })}`;
  return `${corpo}.${sign('RSA-SHA256', Buffer.from(corpo), chave).toString('base64url')}`;
}

describe('Pessoas da administração (login pelo domínio)', () => {
  let certs: http.Server;
  let certsUrl = '';
  let server: AdminServer;
  let base = '';
  let pessoas: PessoasDaAdmin;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k7-pessoas-'));

  before(async () => {
    certs = http.createServer((_req, res) => res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1' }] })));
    await new Promise<void>((r) => certs.listen(0, '127.0.0.1', () => r()));
    certsUrl = `http://127.0.0.1:${(certs.address() as { port: number }).port}/certs`;
    const perfis = path.join(dir, 'perfis');
    fs.mkdirSync(path.join(perfis, 'demo'), { recursive: true });
    fs.writeFileSync(path.join(perfis, 'demo', 'perfil.yaml'), 'nome: demo\ndescricao: Demonstração\nidentidade: { nome: Demo, emoji: "🧪" }\ncanais: [terminal]\nmodulos: []\n');
    pessoas = new PessoasDaAdmin(path.join(dir, 'pessoas.json'), ['dona@gmail.com']);
    const runner = new FitaRunner({ rootDir: dir, webPortBase: 9900, launch: () => { throw new Error('não liga nos testes'); } });
    server = new AdminServer({
      port: 0, rootDir: dir, env: { PERFIS_DIR: perfis }, token: 't'.repeat(32), runner,
      dominios: ['admin.exemplo.com.br'], acesso: new AcessoCloudflare({ equipe: EQUIPE, aud: AUD, certsUrl }), pessoas,
    });
    await server.start();
    base = new URL(server.url).origin;
  });
  after(async () => {
    await server.stop();
    certs.close();
  });

  // content-length explícito: o http do Node não manda corpo em DELETE sem ele.
  const pedir = (rota: string, token: string, method = 'GET', body?: unknown) =>
    new Promise<{ status: number; data: { erro?: string; email?: string; papel?: string; pessoas?: { email: string }[] } }>((resolve) => {
      const req = http.request(`${base}${rota}`, {
        method,
        headers: { host: 'admin.exemplo.com.br', 'cf-access-jwt-assertion': token, ...(body ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(JSON.stringify(body))) } : {}) },
      }, (res) => {
        let texto = '';
        res.on('data', (c) => (texto += c));
        res.on('end', () => resolve({ status: res.statusCode!, data: JSON.parse(texto || '{}') }));
      });
      req.end(body ? JSON.stringify(body) : undefined);
    });

  it('dono pelo ADMIN_DONOS; e-mail fora da lista é recusado com a explicação', async () => {
    const eu = await pedir('/api/eu', jwt({ email: 'Dona@Gmail.com' }));
    assert.deepEqual(eu.data, { email: 'dona@gmail.com', papel: 'dono', local: false });
    const outro = await pedir('/api/eu', jwt({ email: 'estranho@gmail.com' }));
    assert.equal(outro.status, 403);
    assert.match(outro.data.erro!, /estranho@gmail\.com ainda não tem acesso/);
  });

  it('assinatura falsa, outra aplicação ou login vencido não entram', async () => {
    const outraChave = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    assert.equal((await pedir('/api/eu', jwt({ email: 'dona@gmail.com' }, 'k1', outraChave))).status, 401);
    assert.equal((await pedir('/api/eu', jwt({ email: 'dona@gmail.com', aud: ['outra'] }))).status, 401);
    assert.equal((await pedir('/api/eu', jwt({ email: 'dona@gmail.com', exp: 1 }))).status, 401);
    assert.equal((await pedir('/api/eu', 'lixo')).status, 401);
  });

  it('o dono inclui pessoas; editor muda fitas mas não a lista; leitor só vê', async () => {
    const dona = jwt({ email: 'dona@gmail.com' });
    assert.equal((await pedir('/api/pessoas', dona, 'POST', { email: 'ed@gmail.com', papel: 'editor' })).status, 200);
    assert.equal((await pedir('/api/pessoas', dona, 'POST', { email: 'le@gmail.com', papel: 'leitor' })).status, 200);
    assert.equal((await pedir('/api/pessoas', dona, 'POST', { email: 'x@gmail.com', papel: 'chefe' })).status, 400);
    assert.equal((await pedir('/api/pessoas', dona, 'DELETE', { email: 'dona@gmail.com' })).status, 400);

    const editor = jwt({ email: 'ed@gmail.com' });
    assert.equal((await pedir('/api/fitas', editor)).status, 200);
    assert.equal((await pedir('/api/pessoas', editor)).status, 403);
    assert.equal((await pedir('/api/instalar', editor, 'POST', { origem: 'x' })).status, 403);
    const mudou = await pedir('/api/fitas/demo/manifesto', editor, 'POST', { vitrine: true });
    assert.equal(mudou.status, 200, mudou.data.erro ?? '');

    const leitor = jwt({ email: 'le@gmail.com' });
    assert.equal((await pedir('/api/fitas', leitor)).status, 200);
    const tentou = await pedir('/api/fitas/demo/manifesto', leitor, 'POST', { vitrine: false });
    assert.equal(tentou.status, 403);
    assert.match(tentou.data.erro!, /só para ver/);

    const tirou = await pedir('/api/pessoas', dona, 'DELETE', { email: 'le@gmail.com' });
    assert.equal(tirou.status, 200, tirou.data.erro ?? '');
    assert.equal((await pedir('/api/eu', leitor)).status, 403);
    assert.deepEqual(pessoas.listar().map((p) => p.email), ['dona@gmail.com', 'ed@gmail.com']);
  });
});
