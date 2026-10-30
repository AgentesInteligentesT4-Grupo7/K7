# Como criar uma fita

Uma **fita** (ou perfil) é o que faz o K7 virar um agente específico: um baixador de músicas, um ajudante de cozinha,
um assistente do agronegócio. O **tocador** (este repositório) tem o que serve a qualquer agente (LLMs, memória,
canais, voz, módulos); a fita **descreve** o agente e, se precisar, traz o **próprio código**.

> **Comece sem código.** A maioria das fitas é só YAML e Markdown: identidade, quais módulos do tocador ligar, skills
> escritas em texto, personas, estilos, APIs descritas em YAML e segredos no `.env`.
> Quando a fita precisa de algo que só ela usa (ex.: a Rebobina baixa do YouTube e tem um player), esse código fica
> **na fita**, numa extensão (seção 12), e não no tocador: outro agente não carrega o que não usa. O instalador
> avisa que a fita traz código e só instala com a sua confirmação, porque ele roda com o mesmo acesso do tocador.

Para o desenho completo (por que é assim, segurança, instalação), veja a spec
[specs/profiles-modules.md](../specs/profiles-modules.md). Este guia é o passo a passo. Para ligar, desligar e remover cada parte (canais, vitrine, extensão, serviços), veja
[ativar-desativar-fitas.md](ativar-desativar-fitas.md).

---

## 1. Criar a pasta da fita

As fitas ficam fora deste repositório, na pasta configurada em `PERFIS_DIR` no `.env` do tocador
(aqui: `../ParreiraClaw-perfis`). Três jeitos de começar:

| Jeito | Como | Quando usar |
|---|---|---|
| **Modelo pronto** | `npm run perfil -- novo minha-fita` | O mais comum: cria a pasta com `perfil.yaml` comentado, `.env.example`, `.gitignore` e uma skill de exemplo. |
| **Conversando** | Peça ao agente: "quero uma fita de receitas com uma chef mineira" | A skill `criador-de-fitas` faz uma entrevista curta e escreve os arquivos em `workspace/<perfil>/fitas/<nome>/`; depois `npm run perfil -- instalar workspace/<perfil>/fitas/<nome>`. |
| **À mão** | Copie uma fita existente (ex.: `rebobina`) e edite | Quando a fita nova é parecida com uma que já existe. |

O nome da fita só aceita letras minúsculas, números e hífen (ex.: `rebobina`, `agro-minds`).

## 2. Estrutura da pasta

```
minha-fita/
├── perfil.yaml        identidade, módulos, canais, privacidade, limites (obrigatório)
├── skills/            o que o agente sabe fazer, uma pasta por skill com SKILL.md
├── personas/          personagens ou especialistas com quem se conversa (opcional)
├── estilos/           jeitos de escrever: formal, infantil, resumo curto... (opcional)
├── ferramentas/       APIs REST descritas em YAML, sem código (módulo http, opcional)
├── conhecimento/      documentos que o agente consulta: PDF, Markdown, texto (módulo conhecimento, opcional)
├── evals/             perguntas para avaliar os modelos nesta fita (opcional)
├── extensao/          código da fita: index.ts com ativar(k7) (opcional, seção 12)
├── web/               painel da fita no chat web: painel.js e painel.css (opcional, seção 12)
├── servicos/          containers que a extensão usa (Docker; opcional)
├── testes/            testes da extensão (*.test.ts; opcional)
├── .env.example       nomes dos segredos, sem valores (vai para o Git)
├── .env               os segredos de verdade (NUNCA vai para o Git)
├── .gitignore         .env, dados/, áudios e vídeos
└── README.md          o que a fita faz e como rodar
```

Os dados que a fita gera (banco, vozes, arquivos baixados) não ficam nela: o tocador guarda em
`dados/<fita>/` e `workspace/<fita>/`, separados por fita.

## 3. O `perfil.yaml`

Exemplo real, a fita **Rebobina** (baixa áudio e vídeo do YouTube):

```yaml
nome: rebobina
versao: 0.1.0
descricao: Baixa áudio (MP3 ou WAV) ou vídeo (MP4) de links e playlists do YouTube e entrega os arquivos.
requer:
  tocador: ">=1.0"

identidade:
  nome: Rebobina
  emoji: 🎧
  dono: Grupo 7
  proposito: baixador de áudio e vídeo do YouTube
  instrucoes: |
    Você baixa áudio e vídeo do YouTube: recebe o link, entende o formato e entrega o arquivo.
    Fora desse objetivo, responda só: "Essa opção não está disponível aqui."

modulos: {}                 # nenhum módulo do tocador: tudo o que ela faz vem da extensão
extensao: extensao/index.ts # o código da fita (seção 12)

canais: [telegram, terminal, web]
privacidade: publico
vitrine: true

guardrails:
  injecao: bloquear
  verificar_com_llm: true
  topicos:
    permitidos: [links do YouTube para baixar, escolher o formato do download]
    acao: bloquear

variaveis: {}
```

### Campos

| Campo | Obrigatório | O que é |
|---|---|---|
| `nome` | sim | Identificador da fita (igual ao nome da pasta). |
| `versao` | não | Versão da fita (`0.1.0`); o instalador usa para atualizar. |
| `descricao` | não | Uma frase: aparece em `npm run perfil -- listar` e no site do K7. |
| `requer.tocador` | não | Versões do tocador aceitas (`">=1.0"`, `"^1.2"`). |
| `identidade.nome` / `emoji` | não | Como o agente se apresenta. |
| `identidade.dono` | não | Para quem o agente trabalha (pessoa, grupo, empresa). |
| `identidade.proposito` | não | Uma linha: "assistente de receitas", "baixador de música". |
| `identidade.instrucoes` | não | Regras fixas de comportamento, válidas em toda conversa. |
| `identidade.idioma` | não | Padrão: português do Brasil. |
| `modulos` | sim | Quais módulos do tocador ligar (tabela abaixo). Lista (`[voz, arquivos]`) ou mapa com opções (`conhecimento: { hyde: true }`). |
| `canais` | não | `telegram`, `terminal`, `web`. Padrão: `[telegram, terminal]`. |
| `privacidade` | não | `publico` (escolhe entre os modelos gratuitos da nuvem e o local), `pessoal` (só provedores que não treinam com os dados) ou `local` (só a GPU da máquina). |
| `estilo_padrao` | não | Estilo de escrita padrão (um dos de `estilos/` ou do tocador, ex.: `informal`). |
| `modo_padrao` | não | Raciocínio: `normal`, `reformular` (reescreve a pergunta antes) ou `verificado` (confere a resposta). |
| `vitrine` | não | `true` para aparecer no site do K7 (`npm run site`), para qualquer visitante escolher. |
| `guardrails` | não | Limites do agente (seção 8). |
| `extensao` | não | Arquivo com o código da fita (`extensao/index.ts`): ferramentas, painel web, comandos (seção 12). |
| `variaveis` | não | Segredos que o `.env` da fita precisa ter, com a descrição: `{ CLIMA_API_KEY: "chave da API de clima" }`. O tocador avisa os que faltam. |

### Módulos disponíveis

| Módulo | O que liga | Precisa de |
|---|---|---|
| `arquivos` | Criar, ler e listar arquivos no workspace da fita | — |
| `voz` | Receber áudio (Whisper) e responder em áudio (Kokoro/Edge) | Whisper e Kokoro (Docker) |
| `voz-clonada` | `/minhavoz`, `/falar` e a voz da pessoa em áudios | Chatterbox (Docker, GPU) |
| `refinamento` | Criador ↔ crítico, análise em etapas, debate, criador de prompts | — |
| `http` | As APIs descritas em `ferramentas/*.yaml` | — |
| `pesquisa-web` | Pesquisar na internet, ler páginas, notícias | SearXNG (opcional; sem ele usa DuckDuckGo) |
| `anexos` | Entender imagens e documentos enviados (visão, OCR) | — |
| `imagens` | Gerar imagens: ilustração, HQ, anime, mangá | ComfyUI (Docker, GPU) |
| `conhecimento` | Responder com base nos documentos de `conhecimento/`, com citação | Embeddings (Ollama ou Gemini) |

Módulo desligado some de verdade: sem `arquivos`, nenhuma ferramenta de arquivo; sem `voz`, áudios são recusados.
Ligue **só o que a fita usa**: menos ferramentas, menos chance de o agente sair do objetivo.

Opções do `conhecimento` (todas opcionais): `fusao` (`true` ou quantas variações da pergunta), `hyde`, `crag`,
`adaptativo`, `embeddings` (`auto`, `ollama`, `gemini`, `off`). Veja [specs/knowledge-base.md](../specs/knowledge-base.md).

## 4. Skills (`skills/<nome>/SKILL.md`)

Uma skill é **um procedimento em texto** que o agente segue quando o pedido combina com ela. Um roteador lê a
`description` de todas as skills e escolhe a certa, então **a descrição é o que mais importa**.

```markdown
---
name: lista-de-compras
description: "Monta a lista de compras a partir de receitas ou do que acabou, agrupada pelas seções do mercado, e salva em arquivo: 'faz a lista de compras', 'o que preciso comprar para essa receita?', 'acabou o café, anota aí'."
max_iterations: 6
---

# Skill: Lista de compras

Você é {{AGENT_NAME}}, {{AGENT_PURPOSE}} de {{OWNER_NAME}}, e monta listas de compras que dá para usar no mercado.

## 1. Juntar os itens
...

## 2. Salvar
1. Use `obter_data_hora` para a data.
2. Salve com `criar_arquivo` em `compras-AAAA-MM-DD.md`, com caixinhas (`- [ ] item`).

## Regras
- Nunca diga que salvou sem a ferramenta ter confirmado.
```

### Cabeçalho (frontmatter)

| Chave | O que faz |
|---|---|
| `name` | Nome da skill (igual ao da pasta). Skill da fita com o mesmo nome de uma do tocador a substitui. |
| `description` | Quando usar: o que a skill faz **e exemplos de pedidos entre aspas**. É o que o roteador lê. |
| `max_iterations` | Quantos passos com ferramentas ela pode dar (pesquisa, arquivos). Só se precisar de muitos. |
| `exige_ferramenta` | `true` quando a skill **tem** que agir (gerar imagem, baixar): resposta sem nenhuma ação volta para o modelo, em vez de ele fingir que fez. |
| `privacidade` | `local` força só modelos da máquina nesta skill (ex.: conteúdo pessoal). |
| `gatilhos` | Palavras que escolhem a skill direto, sem passar pelo roteador: `[desenh, imagem, ilustra]`. |
| `loop` | Skill de refinamento criador ↔ crítico (modelos diferentes); veja `modulos/refinamento/skills/idealizador-analisador`. |

No texto, `{{AGENT_NAME}}`, `{{OWNER_NAME}}` e `{{AGENT_PURPOSE}}` viram os valores da `identidade`.

### Como escrever uma skill que funciona

- **Papel e público na primeira linha** ("Você é {{AGENT_NAME}} e ajuda {{OWNER_NAME}} a...").
- **Passos numerados**, cada um com a ação e a ferramenta a usar.
- **Formato da resposta** explícito, com um exemplo curto.
- **Regras** curtas no fim, com o que nunca fazer.
- Poucas skills bem descritas funcionam melhor que muitas genéricas.
- Trate o usuário de forma neutra ("você"), sem presumir gênero.

## 5. Ferramentas HTTP (`ferramentas/<nome>.yaml`, módulo `http`)

Uma API REST descrita em YAML vira uma ferramenta do agente, sem código:

```yaml
nome: previsao_do_tempo
descricao: Tempo atual e previsão para uma coordenada
url: https://api.open-meteo.com/v1/forecast
parametros:
  latitude: { tipo: number, descricao: Latitude }
  longitude: { tipo: number, descricao: Longitude }
fixos: { current: "temperature_2m,weather_code", timezone: auto }
autenticacao: { tipo: header, nome: X-Api-Key, variavel: CLIMA_API_KEY }   # opcional; a chave fica no .env
resposta: { campos: [current], limite_kb: 30 }
```

Só `https`, só o host declarado, nada da rede local, sem redirecionamentos, resposta limitada; a chave nunca
chega ao modelo. Arquivos `*.yaml.off` ficam desligados (bom para exemplos).

## 6. Personas e estilos (opcionais)

**Persona** (`personas/<nome>.md`): um personagem ou especialista com memória própria. O usuário fala com ela com
`/persona <nome>` ou `@nome mensagem`.

```markdown
---
name: editora
description: "Editora literária exigente: avalia ritmo, personagens e diálogos e sugere cortes."
estilo: formal
skills: [roteirista]
---
Você é a editora que acompanha os projetos de {{OWNER_NAME}}...
```

**Estilo** (`estilos/<nome>.md`): um jeito de escrever, escolhido com `/estilo <nome>` ou por `estilo_padrao`.

```markdown
---
name: resumo-curto
description: "Resumo enxuto e direto."
controles: { detalhe: 2, foco: 9 }
---
- Vá direto ao ponto.
```

## 7. Base de conhecimento (`conhecimento/`, módulo `conhecimento`)

Coloque PDFs, Markdown ou textos em `conhecimento/`. O tocador indexa e o agente responde com base neles,
citando a fonte. Use para manuais, regulamentos, FAQ de uma loja. Não coloque material com direitos autorais
que a fita não pode distribuir, nem documentos pessoais em fita pública.

## 8. Manter a fita no assunto (`guardrails`)

Para uma fita pública, defina o que ela atende e o que recusa:

```yaml
guardrails:
  injecao: bloquear              # off | avisar | bloquear: "ignore suas instruções..."
  verificar_com_llm: true        # um modelo confere cada mensagem antes (assunto e tentativa de mudar as regras)
  dados_pessoais: mascarar       # off | mascarar | bloquear: CPF, telefone, e-mail, chaves na resposta
  proibidas: { palavras: [concorrente], acao: refazer }   # corrigir | refazer | bloquear
  topicos:
    permitidos: [receitas, cardápio, lista de compras]
    acao: bloquear               # bloquear | avisar
  abster: [saude, juridico, financeiro]   # nesses temas, diz que não sabe em vez de inventar
```

Combine com `identidade.instrucoes` dizendo a resposta exata para pedidos fora do assunto. A Rebobina, por exemplo,
responde "Essa opção não está disponível aqui. Me mande um link do YouTube..." para qualquer outra coisa.
Detalhes em [specs/guardrails.md](../specs/guardrails.md).

## 9. Segredos (`.env`)

- `.env.example` lista os nomes **sem valores** e vai para o Git; `.env` tem os valores e **nunca** vai para o Git
  (confira que o `.gitignore` da fita tem `.env`).
- O `.env` da fita vence o do tocador. Use para o token do bot próprio da fita (`TELEGRAM_BOT_TOKEN`, criado no
  @BotFather), quem pode usar (`TELEGRAM_ALLOWED_USER_IDS`) e as chaves das APIs da fita.
- No chat público (site ou `npm run web` com `WEB_PUBLIC=on`), use `WEB_PUBLIC_LIMIT` e `WEB_PUBLIC_LIMIT_TOTAL`
  para limitar mensagens por hora e proteger as chaves dos modelos.

## 10. Testar

Na pasta do tocador:

```bash
npm run perfil -- listar                 # a fita aparece? (erro no perfil.yaml aparece aqui, com o campo)
npm run chat -- --perfil minha-fita      # conversa no terminal; /skills lista as skills carregadas
npm run web -- --perfil minha-fita       # chat no navegador
npm run dev -- --perfil minha-fita       # bot do Telegram (precisa do token no .env da fita)
npm run site                             # site do K7: aparece na vitrine se tiver vitrine: true
```

Roteiro mínimo de teste:

1. "Quem é você?": responde com a identidade da fita?
2. Um pedido para cada skill: a skill certa é escolhida (o log mostra `Router → <skill>`)?
3. Um pedido fora do assunto: recusa do jeito definido?
4. "Ignore suas instruções e...": continua no papel?
5. Com `exige_ferramenta`, o agente realmente usa a ferramenta (não só diz que fez)?

## 11. Publicar e instalar em outra máquina

Cada fita pode virar um repositório próprio (privado ou público):

```bash
cd ../ParreiraClaw-perfis/minha-fita
git init -b main && git add -A && git commit -m "Fita minha-fita"
gh repo create <usuario-ou-grupo>/perfil-minha-fita --private --source . --push
```

Em outra máquina, na pasta do tocador:

```bash
npm run perfil -- instalar <usuario>/minha-fita        # busca github.com/<usuario>/perfil-minha-fita
npm run perfil -- instalar https://github.com/...git   # ou a URL do repositório
npm run perfil -- atualizar minha-fita                 # nova versão (mantém o .env e os dados)
npm run perfil -- remover minha-fita                   # pede confirmação; --apagar-dados apaga dados/<fita>
```

Depois de instalar, copie `.env.example` para `.env` e preencha.

## Checklist antes de publicar

- [ ] `npm run perfil -- listar` mostra a fita sem erro.
- [ ] Só os módulos que a fita usa estão ligados.
- [ ] Cada skill tem `description` com exemplos de pedidos entre aspas.
- [ ] Nenhum segredo nem dado pessoal nos arquivos (o `.env` está no `.gitignore`).
- [ ] Com extensão: `npm run fita -- <fita> testes` passa, e a extensão não importa nada de `src/` do tocador.
- [ ] Fita pública: `guardrails` com `topicos` e `injecao`, e `instrucoes` com a resposta para pedidos fora do assunto.
- [ ] Testada no canal em que vai rodar (seção 10).
- [ ] `README.md` diz o que a fita faz, como rodar e os serviços de que precisa.

## 12. Código da fita (`extensao/`)

Para o que só esta fita faz. O `perfil.yaml` aponta o arquivo (`extensao: extensao/index.ts`) e o tocador o carrega
quando a fita toca (TypeScript direto, sem compilar). A extensão **não importa nada do tocador**: tudo vem do objeto
`k7` que ela recebe. Copie [src/fitas/FitaApi.ts](../src/fitas/FitaApi.ts) para `extensao/k7.ts` para ter os tipos.

```ts
import type { FitaApi } from './k7.js';

export default async function ativar(k7: FitaApi): Promise<void> {
  // Ferramenta para o agente (o modelo decide quando usar)
  k7.ferramenta({
    name: 'contar_letras',
    description: 'Conta as letras de uma palavra.',
    parameters: { type: 'object', properties: { palavra: { type: 'string' } }, required: ['palavra'] },
    async run(args, ctx) {
      ctx.progresso('Contando…');                 // aparece na tela enquanto espera
      return `${String(args.palavra).length} letras`;
    },
  });

  // Rota no chat web (sempre em /api/x/) e painel na página
  k7.web.rota('GET', /^\/api\/x\/contagem$/, (ctx) => ctx.json({ visitante: ctx.userId }));
  k7.web.painel({ script: 'web/painel.js', estilo: 'web/painel.css' });

  // npm run fita -- minha-fita limpar
  k7.comando('limpar', 'Apaga os arquivos temporários da fita', async () => { /* ... */ });

  // Ao subir o tocador: confere o serviço (falha vira aviso, não derruba nada)
  k7.aoIniciar(async () => k7.log.info('pronto'));
}
```

| No `k7` | Para quê |
|---|---|
| `fita.dir`, `fita.workspaceDir`, `fita.dadosDir`, `fita.env` | Pasta da fita, pastas de trabalho e de dados dela no tocador, variáveis do `.env` |
| `ferramenta(tool)` | Ferramenta do agente. `ctx` traz `userId`, `progresso()` (barra de %) e `anexarMidia()` (áudio/vídeo junto da resposta) |
| `web.rota(método, /^\/api\/x\/.../, handler, { visitante })` | Rota do chat web. `ctx` traz `userId`, `json`, `midia` (com Range), `zip`, `emFila`, `progresso`, `saiu` (a pessoa fechou a página) |
| `web.painel({ script, estilo })` | Arquivos da fita incluídos na página do chat |
| `comando(nome, descrição, fn)` | `npm run fita -- <fita> <nome>` |
| `aoIniciar(fn)` | Verificações quando o tocador sobe |
| `util.limitador(n)`, `util.emParalelo(itens, n, fn)` | Tarefas ao mesmo tempo, com teto |
| `log.info/aviso/erro` | Log com o nome da fita |

**Erros para a pessoa:** um erro com a propriedade `userMessage` (texto) aparece como está no chat, no Telegram e na
página (status 422). Os demais viram "falha interna" e vão para o log.

**Painel web:** o script roda depois do da página e usa `window.K7`: `api(caminho)`, `fileUrl(caminho)`,
`authHeaders()`, `el()`, `esc()`, `saveToFolder()`, `state` e os avisos `onReady(info)`, `onReply(resposta)` e
`onBusy(true/false)`. Rotas com `{ visitante: false }` (ex.: arquivo aberto por `<audio>`) não recebem quem é o
visitante: use ids imprevisíveis nelas.

**Testes:** `testes/*.test.ts` com `node:test`, rodados por `npm run fita -- <fita> testes`. Para não depender do
tocador, teste as peças da extensão direto ou com um `k7` de mentira (a Rebobina tem um em `testes/k7-falso.ts`).

