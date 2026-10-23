import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TaskContext } from '../src/llm/orchestration/TaskContext.js';
import type { PrivacyLevel } from '../src/llm/orchestration/types.js';
import { EnrollmentVerifier } from '../src/voice/EnrollmentVerifier.js';
import { FakeLlmProvider } from './helpers/FakeLlmProvider.js';

const TEXT = 'O sol apareceu devagar atrás das montanhas e iluminou o vale inteiro. Na feira de domingo comprei laranjas bananas e um abacaxi bem doce.';

describe('Cadastro de voz com texto para ler', () => {
  it('aprova quem leu o texto, mesmo pulando um trecho e com erros de transcrição; reprova outro áudio', () => {
    const verifier = new EnrollmentVerifier(new FakeLlmProvider([]), 0.6);
    assert.deepEqual(verifier.check(TEXT, TEXT.toUpperCase()), { ok: true, match: 1 });
    const skipped = verifier.check(TEXT, 'O sol apareceu devagar atrás das montanhas e iluminou o vale inteiro. Na feira de domingo comprei laranja e banana.');
    assert.ok(skipped.ok && skipped.match < 1, `faltou um trecho: ${skipped.match}`);
    const other = verifier.check(TEXT, 'Oi gente, tudo bem? Hoje eu vou mostrar como fazer um bolo de chocolate bem fofinho.');
    assert.ok(!other.ok && other.match < 0.3, `áudio de outra conversa: ${other.match}`);
    assert.deepEqual(verifier.check(TEXT, ''), { ok: false, match: 0 });
  });

  it('o texto vem do LLM local (privacidade "local"); tamanho fora do esperado pede outro; falha vira mensagem clara', async () => {
    const privacies: Array<PrivacyLevel | undefined> = [];
    const llm = new FakeLlmProvider([{ content: 'Curto demais.' }, { content: `"${TEXT}"` }]);
    const chat = llm.chat.bind(llm);
    llm.chat = async (r) => (privacies.push(TaskContext.current()?.privacy), chat(r));
    const verifier = new EnrollmentVerifier(llm);
    assert.equal(await verifier.challenge('7'), TEXT, 'aspas removidas');
    assert.deepEqual(privacies, ['local', 'local']);

    const broken = new EnrollmentVerifier(new FakeLlmProvider([new Error('ollama fora'), new Error('ollama fora')]));
    await assert.rejects(broken.challenge('7'), /Não consegui gerar o texto para você ler agora/);
  });
});
