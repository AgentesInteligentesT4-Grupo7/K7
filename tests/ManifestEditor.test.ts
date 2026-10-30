import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { disabledExtension, editManifest } from '../src/profiles/ManifestEditor.js';

const YAML = `# Manifesto da fita
nome: demo
identidade:
  nome: Demo   # comentário que fica
modulos:
  arquivos: {}

canais: [terminal]   # só o terminal por enquanto

# código da fita
extensao: extensao/index.ts
vitrine: false
`;

describe('Edição do perfil.yaml pela página de administração', () => {
  it('muda só as linhas das chaves e mantém comentários e ordem', () => {
    const out = editManifest(YAML, { vitrine: true, canais: ['telegram', 'web'] });
    assert.equal(out, YAML.replace('vitrine: false', 'vitrine: true').replace('canais: [terminal]   # só o terminal por enquanto', 'canais: [telegram, web]'));
  });

  it('desliga e religa a extensão comentando a linha (o caminho não se perde)', () => {
    const off = editManifest(YAML, { extensaoLigada: false });
    assert.match(off, /^# extensao: extensao\/index\.ts$/m);
    assert.equal(disabledExtension(off), 'extensao/index.ts');
    assert.equal(editManifest(off, { extensaoLigada: true }), YAML);
    assert.throws(() => editManifest('nome: x\n', { extensaoLigada: true }), /não tem extensão/);
  });

  it('acesso do Telegram: cria o bloco ou troca o modo mantendo as outras opções', () => {
    const added = editManifest(YAML, { telegramAcesso: 'convite' });
    assert.match(added, /vitrine: false\ntelegram:\n {2}acesso: convite\n$/);
    const withOptions = YAML + 'telegram:\n  acesso: lista\n  pedidos: false\n  limite_hora: 5\n';
    assert.match(editManifest(withOptions, { telegramAcesso: 'aberto' }), /telegram:\n {2}acesso: aberto\n {2}pedidos: false\n {2}limite_hora: 5\n$/);
    const flow = 'nome: x\ntelegram: { acesso: lista }\nvitrine: true\n';
    assert.equal(editManifest(flow, { telegramAcesso: 'convite' }), 'nome: x\ntelegram:\n  acesso: convite\nvitrine: true\n');
  });

  it('chave que não existe vai para o fim; resultado inválido não passa', () => {
    assert.equal(editManifest('nome: x\n\n', { vitrine: true }), 'nome: x\nvitrine: true\n\n');
    assert.throws(() => editManifest(YAML, { canais: [] }), /pelo menos um canal/);
    assert.throws(() => editManifest(YAML, { canais: ['fax' as never] }), /canais/);
  });
});
