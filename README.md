# 📼 K7

Tocador de fitas de agentes de IA, criado por **Danillo Tomaz Parreira** — Agentes Inteligentes T4, Grupo 7 (o 7 do K7).

Agente pessoal de IA que roda **100% local** no seu desktop e é controlado **exclusivamente pelo Telegram**.
Pipeline ReAct com LLMs intercambiáveis (Gemini, DeepSeek, Groq ou Ollama local), memória persistente em SQLite,
skills em Markdown com hot-reload (incluindo loops criador ↔ crítico com modelos diferentes) e entrada/saída
multimodal (texto, PDF, `.md`, voz com Whisper local e Kokoro TTS na GPU).

Especificações em [`specs/`](specs/).

## Arquitetura

```
Telegram ──► TelegramInputHandler (whitelist, PDF/MD, Whisper STT)
                 │  ChatQueue (fila serial por chat, polling nunca bloqueia)
                 ▼
           AgentController (Facade)
                 │
     MemoryManager ◄── salva entrada / lê janela (SQLite WAL)
                 │
     SkillLoader → SkillRouter (passo zero, JSON) → SkillExecutor (runtime injection)
                 │
           AgentLoop (ReAct: Thought → Action → Observation, MAX_ITERATIONS)
                 │        ▲
                 │        └── ToolRegistry (criar/ler/listar arquivos, data/hora)
                 ▼
     TelegramOutputHandler ─ Text (chunks 4096) | File (.md) | Audio (Kokoro GPU → Edge) | Error (⚠️)
```

| Pasta | Conteúdo |
|-------|----------|
| `src/agent` | `AgentController` (Facade), `AgentLoop` (ReAct), `RefinementLoop` (criador ↔ crítico), `SystemPromptBuilder` |
| `src/llm` | `ILlmProvider`, providers OpenAI-compatíveis, `ProviderFactory`, `FallbackLlmProvider` |
| `src/skills` | `SkillLoader`, `SkillRouter`, `SkillExecutor`, `RefinementLoopConfig` |
| `src/tools` | `BaseTool`, `ToolRegistry`, `ToolFactory`, sandbox do workspace |
| `src/memory` | `DatabaseConnection` (Singleton), repositórios, `MemoryManager` (Facade) |
| `src/canais` | Canais plugados no núcleo: `telegram/` (grammy, entrada, estratégias de saída), `terminal/` (chat no PC) e `comum/` (tags de arquivo/voz, texto de erro) |
| `src/voice` | Voz independente de canal: `stt/` (Whisper), `tts/` (Kokoro, Edge), clonagem (Chatterbox) |
| `src/documents` | Extração de texto de PDF/.md |
| `src/modules` | Registro dos módulos (`arquivos`, `voz`, `voz-clonada`, `refinamento`); skills de cada um em `modulos/<id>/skills/` |
| `src/profiles` | Perfis ("fitas"): manifesto `perfil.yaml`, carregamento com `--perfil` e instalador |

Padrões: Facade, Factory, Repository, Singleton, Strategy, Registry.

## Requisitos

- Node.js 20+ (testado com 24)
- Um bot do Telegram (crie com o [@BotFather](https://t.me/BotFather)) e seu user ID numérico ([@userinfobot](https://t.me/userinfobot))
- API key de pelo menos um provider (Gemini, DeepSeek ou Groq) **ou** o [Ollama](https://ollama.com) rodando localmente
- **Voz (opcional):**
  - Resposta em voz (TTS) com **Kokoro na GPU** via [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) (Docker + NVIDIA):
    ```bash
    docker run -d --gpus all -p 8880:8880 --name kokoro-tts --restart unless-stopped ghcr.io/remsky/kokoro-fastapi-gpu:latest
    ```
    Usa ~1 GB de VRAM, sintetiza um parágrafo em ~1s e entrega OGG/Opus (formato nativo de voice note, sem ffmpeg).
  - Transcrição de voz (STT) com **Whisper na GPU** via [Speaches](https://github.com/speaches-ai/speaches) (`WHISPER_ENGINE=http`, recomendado):
    ```bash
    docker run -d --gpus all -p 8890:8000 -v whisper-hf-cache:/home/ubuntu/.cache/huggingface/hub --name whisper-stt ghcr.io/speaches-ai/speaches:latest-cuda
    curl -X POST http://localhost:8890/v1/models/deepdml/faster-whisper-large-v3-turbo-ct2   # baixa o modelo (~1,6 GB) uma vez
    ```
    Transcreve um voice note em ~0,6s; o modelo sai da VRAM após 5 min ocioso. Não precisa de Python nem ffmpeg no Windows.
  - Alternativas sem Docker (exigem [ffmpeg](https://ffmpeg.org/) no PATH ou em `FFMPEG_BIN`):
    - `pip install openai-whisper` → `WHISPER_ENGINE=openai-whisper`, `WHISPER_BIN=whisper`, `WHISPER_MODEL=base`
    - [whisper.cpp](https://github.com/ggml-org/whisper.cpp) → `WHISPER_ENGINE=whisper-cpp`, `WHISPER_BIN=whisper-cli`, `WHISPER_MODEL=C:\caminho\ggml-base.bin`

## Instalação e execução

```bash
npm install              # se der erro de "gyp"/compilação no better-sqlite3: npm ci --ignore-scripts
cp .env.example .env     # preencha TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS e a API key
npm run dev              # long polling com hot-reload do core (nodemon + tsx)
```

Produção local: `npm run build && npm start`.
Testes: `npm test`. Typecheck: `npm run typecheck`.

## Uso no Telegram

- **Texto:** basta conversar. Peça "responda em áudio" para receber voice note.
- **PDF / .md:** envie o arquivo (com legenda opcional dizendo o que fazer). Limite: `MAX_DOCUMENT_MB` (padrão 20 MB).
- **Voz:** envie um voice note. Ele é transcrito localmente e a resposta volta em áudio (diga "responda em texto" para evitar).
- `/nova` inicia uma nova conversa (o histórico anterior fica arquivado no SQLite)
- `/skills` lista as skills instaladas

Usuários fora de `TELEGRAM_ALLOWED_USER_IDS` são ignorados silenciosamente.

## Rodando no Docker

```bash
docker compose up -d --build     # sobe o bot (reinicia sozinho com o Docker)
docker compose logs -f           # acompanha os logs
docker compose down              # para o bot

docker compose run --rm k7 node dist/canais/terminal/chat.js   # chat no terminal
docker compose run --rm k7 node dist/cli/eval.js pesquisa      # avalia os modelos

PERFIL=promo docker compose up -d                                         # bot de um perfil
docker compose run --rm k7 node dist/canais/terminal/chat.js --perfil historias
```

- **Perfis no Docker:** a pasta `../ParreiraClaw-perfis` (ou `PERFIS_DIR_HOST`) é montada em `/app/perfis`
  e os dados de cada perfil ficam no volume, em `/app/state/dados/<perfil>/`. Caminhos que o `.env` de um
  perfil fixa (como `DB_PATH=./data/...` no `pessoal`) apontam para a pasta montada `data/`.

- **Não rode o bot no Docker e o `npm run dev` ao mesmo tempo:** o Telegram aceita uma conexão por bot (erro 409).
- **Serviços no host:** Ollama, Kokoro (8880), Whisper (8890) e Chatterbox (8004) são alcançados por
  `host.docker.internal`. Os endereços do `docker-compose.yml` sobrescrevem os do `.env`. Ligue os
  containers de voz antes: `docker start kokoro-tts whisper-stt chatterbox-tts-server-chatterbox-tts-server-1`.
- **Banco SQLite num volume Docker (`k7-state`)**, porque o modo WAL não é confiável numa pasta do
  Windows montada no container. Por isso o Docker tem **memória, notas de avaliação e histórico próprios**,
  separados do `npm run dev`. Para levar o banco do Windows para o Docker uma vez (com os dois parados):
  ```bash
  docker run --rm -v k7_k7-state:/state -v "%cd%/data:/src" alpine cp /src/k7.db /state/
  ```
- **Pastas montadas do Windows** (edite normalmente): `data/` (vozes, cache, saídas do terminal), `workspace/`,
  `.agents/skills/` (com hot-reload) e `evals/`.
- O container não enxerga a GPU diretamente: os modelos locais continuam rodando no Ollama do Windows, que usa a GPU.

## Perfis: um tocador, várias fitas

O K7 é o **tocador** (núcleo + módulos + canais). Cada finalidade é um **perfil** — uma pasta
com `perfil.yaml` (identidade, módulos, canais, privacidade), `skills/` e `.env` próprios, **sem código**.
Os perfis ficam fora deste repositório, em `PERFIS_DIR` (aqui: `../ParreiraClaw-perfis`).

```bash
npm run dev -- --perfil pessoal       # bot do Telegram do perfil (cada perfil tem o seu bot)
npm run chat -- --perfil promo        # terminal
npm run eval -- --perfil pessoal conversa

npm run perfil -- listar              # perfis encontrados
npm run perfil -- novo historias2     # cria um perfil a partir do modelo
npm run perfil -- instalar <origem>   # pasta, URL https do Git, usuario/nome (GitHub: perfil-nome ou nome) ou @escopo/nome (npm)
npm run perfil -- atualizar <nome>    # busca a versão nova (mantém .env e dados)
npm run perfil -- remover <nome>      # pede confirmação; --apagar-dados apaga dados/<nome>
```

- **Criar uma fita conversando:** peça ao agente ("quero uma fita de receitas com uma chef mineira") e a skill
  `criador-de-fitas` monta manifesto, skills, personas e ferramentas em `fitas/<nome>/` no workspace; depois
  `npm run perfil -- instalar workspace/<perfil>/fitas/<nome>` (o instalador confere que não há código).
- **Sem `--perfil`** (e `PERFIL_PADRAO` vazio), tudo funciona como antes, só com o `.env` raiz.
- **Com perfil**, o ambiente é montado nesta ordem (o último vence): `.env` do tocador (sem identidade e sem
  token do bot) → pastas isoladas (`dados/<perfil>/agente.db`, `dados/<perfil>/vozes`, `workspace/<perfil>`,
  `tmp/<perfil>`) → `perfil.yaml` → `.env` do perfil.
- **Skills em camadas:** as dos módulos ligados + as do perfil; com o mesmo nome, vale a do perfil.
- **Módulo desligado some de verdade:** sem `arquivos`, nenhuma ferramenta de arquivo; sem `voz`, áudios são
  recusados com aviso e as respostas saem em texto; sem `voz-clonada`, sem `/minhavoz`, `/falar` e a skill.
- **APIs sem código (módulo `http`):** a fita descreve uma API em `ferramentas/<nome>.yaml` e o tocador a
  transforma em ferramenta do agente. Exemplo (`pessoal/ferramentas/previsao_do_tempo.yaml`):
  ```yaml
  nome: previsao_do_tempo
  descricao: Tempo atual e previsão para uma coordenada
  url: https://api.open-meteo.com/v1/forecast        # só https; {param} permitido no caminho
  parametros:
    latitude: { tipo: number, descricao: Latitude }
    longitude: { tipo: number, descricao: Longitude }
  fixos: { current: "temperature_2m,weather_code", timezone: auto }
  autenticacao: { tipo: header, nome: X-Api-Key, variavel: CLIMA_API_KEY }   # opcional; a chave fica no .env
  resposta: { campos: [current], limite_kb: 30 }
  ```
  Garantias: só o host declarado, nunca endereços da rede local (DNS validado na conexão), sem
  redirecionamentos, timeout de 15 s, resposta limitada e marcada como dado externo, chave nunca exposta ao LLM.
- **Instalação segura:** o instalador recusa perfis com código ou links (`.js`, `.ts`, `.py`, `.sh`, `.ps1`,
  `package.json`…), baixa pacotes npm com `--ignore-scripts` e nunca executa nada do perfil.

Spec: [specs/profiles-modules.md](specs/profiles-modules.md).

## Chat no terminal

Converse com o mesmo agente (memória, skills, ferramentas e vozes) direto no PC, sem o Telegram:

```bash
npm run chat                 # conversa própria do terminal
npm run chat -- --verbose    # mostra Thought/Action/Observation do agente
npm run chat -- --play       # abre automaticamente os áudios gerados
npm run chat -- --usuario <seu-id-do-telegram>   # continua a sua conversa do Telegram
```

Comandos: `/arquivo <caminho> [instrução]` (PDF/.md), `/audio <caminho>` (transcreve e envia como voz),
`/falar [@voz] <texto>`, `/vozes`, `/nova`, `/skills`, `/verbose`, `/play`, `/sair`.
Documentos e áudios gerados ficam em `data/terminal/`. Pode rodar ao mesmo tempo que o bot do Telegram.
Spec: [specs/channels.md](specs/channels.md). O WhatsApp (via n8n) está planejado na mesma spec.

## Chat no navegador

Uma interface no estilo do app desktop do Claude, servida pelo próprio tocador (sem dependências nem
internet): conversas na lateral (reabra qualquer uma), Markdown, anexos PDF/.md, microfone, resposta em
áudio, download dos documentos gerados e o modelo que respondeu.

```bash
npm run web                          # mostra o endereço com o token
npm run web -- --abrir               # já abre no navegador
npm run web -- --perfil promo --porta 8790
```

Ou como canal de serviço junto do bot: `CHANNELS=telegram,terminal,web` (ou `canais: [telegram, web]` no
perfil) e `npm run dev`. A página fica em `web/index.html` (editável sem reiniciar).

- **Só no seu PC:** escuta em `127.0.0.1` (`WEB_PORT`, padrão 8787).
- **Token na URL:** o endereço termina com `#t=<token>` (o fragmento nunca é enviado ao servidor); a API
  exige o token no cabeçalho e confere o `Host`, então outros sites abertos no navegador não conseguem
  usar o agente. `WEB_TOKEN` fixa o token; vazio gera um novo a cada início.
- A página tem CSP restritiva (só o próprio script, por nonce) e o Markdown é renderizado com escape.

## Pesquisa na internet (módulo `pesquisa-web`)

O agente pesquisa antes de responder sobre fatos atuais, números, preços ou versões, lê as melhores fontes e
cita as URLs ("Fontes:"). Ferramentas: `pesquisar_web`, `ler_pagina` (HTML e PDF) e `buscar_noticias`
(Google News). Skills: `pesquisador-web` (várias fontes, até 8 passos) e `noticias` (resumo por tema e período).

- **Buscadores, em ordem** (`SEARCH_PROVIDERS`): SearXNG local → DuckDuckGo (sem chave) → Tavily (com
  `TAVILY_API_KEY`). Sem o SearXNG no ar, tudo funciona pelo DuckDuckGo.
- SearXNG em Docker (opcional, ~200 MB): `docker compose --env-file .env -f servicos/searxng/docker-compose.yml up -d`.
- **Segurança:** nunca acessa a rede local (DNS validado e cada redirecionamento revalidado), páginas limitadas
  a 3 MB e 12.000 caracteres, e o conteúdo da internet chega ao LLM delimitado como dado, nunca como instrução.
- Skills podem pedir mais passos com `max_iterations` no frontmatter (até `MAX_ITERATIONS_HARD_CAP`); ao
  estourar, o agente entrega o que já levantou em vez de um erro.

## Base de conhecimento (módulo `conhecimento`)

RAG com os documentos da própria fita: o agente consulta a base antes de responder de memória ou ir à internet,
e cita os trechos como [1], [2] (spec [knowledge-base](specs/knowledge-base.md)).

```
minha-fita/conhecimento/
├── bases.yaml            # loja: { descricao: "Políticas da loja", idioma: pt-BR }
├── loja/trocas.md        # cada subpasta é uma base (.md, .txt, .pdf)
└── faq.txt               # arquivos soltos vão para a base "geral"
```

- **Ferramentas:** `consultar_conhecimento` (busca), `listar_conhecimento` e `guardar_no_conhecimento` (texto ou
  anexo; vai para os dados do perfil, fora da fita). Arquivos novos ou alterados são reindexados sozinhos.
- **Busca híbrida:** palavras (FTS5/BM25, sem acento, com prefixo para plurais) + vetores, fundidas por RRF.
- **Embeddings** (`EMBEDDINGS_PROVIDER=auto`): Ollama local se houver GPU e o modelo baixado
  (`ollama pull embeddinggemma`, ~600 MB) → Gemini se houver chave e a privacidade for `publico` → só palavras.
  Falta de cota ou modelo nunca quebra a busca: ela segue por palavras.
- **Técnicas por fita** (opcionais, custam 1–2 pedidos ao modelo barato por consulta):

```yaml
modulos:
  conhecimento:
    fusao: 3          # RAG-Fusion: 3 reformulações da pergunta
    hyde: true        # busca vetorial também por uma "resposta hipotética"
    adaptativo: true  # pergunta complexa vira sub-perguntas; conversa simples não busca
    crag: true        # avalia os trechos; se fracos, completa (ou troca) pela internet
    automatico: false # true = busca em toda mensagem e põe os trechos no prompt
    resultados: 5
```

## Imagens e documentos enviados (módulo `anexos`)

Mande uma foto, print, recibo, PDF ou arquivo de texto (Telegram, `/imagem` e `/arquivo` no terminal, 📎 no
navegador) e pergunte sobre ele. Tudo vai para uma **biblioteca de anexos** com ID, então dá para voltar
depois sem reenviar ("naquele recibo de ontem, qual era o CNPJ?").

- **Imagens** vão para um modelo com visão: o orquestrador escolhe um gratuito que enxergue imagem. Álbuns do
  Telegram chegam como uma mensagem só.
- **Documentos grandes** entram no histórico como referência + trecho; o agente lê o resto quando precisa.
- Ferramentas: `listar_anexos`, `ler_anexo` (OCR da imagem por visão, com cache), `buscar_nos_anexos` (busca
  por palavra, sem diferenciar acentos) e `analisar_imagem`. Comandos: `/anexos`, `/apagar_anexo <id>`.
- Ficam em `dados/<perfil>/anexos/`, por usuário, sem duplicar arquivo igual. Retenção:
  `ATTACHMENTS_RETENTION_DAYS` (90) e `ATTACHMENTS_MAX_GB` (5).
- **Privacidade:** a imagem é enviada ao modelo com visão escolhido (na nuvem, se não houver um local).
- Ainda não: OCR local (PP-OCRv5) e Word/Excel/PowerPoint (exigem pacotes e modelos extras).

## Imagens na GPU (módulo `imagens`)

O agente desenha ilustrações, HQ, anime e mangá com modelos SDXL no [ComfyUI](https://github.com/comfyanonymous/ComfyUI),
na sua GPU. Peça em português ("desenhe o Kael correndo num beco com chuva neon, estilo HQ"): o LLM escreve o
prompt técnico em inglês e a ferramenta `gerar_imagem` entrega a imagem no Telegram (foto ou álbum), no
navegador e no terminal (`workspace/imagens/`).

| Estilo | Modelo (checkpoint) | Passos |
|---|---|---|
| `hq`, `ilustracao` | DreamShaper XL (versão Turbo/Lightning) | 6–8 |
| `realista` | RealVisXL V5 Lightning (sem ele, DreamShaper com prompt de foto) | 6–8 |
| `anime` | Animagine XL 4.0 | 20–28 |
| `manga` | Pony Diffusion V6 XL | 20–28 |

Para ligar (uma vez; baixa ~5,4 GB da imagem e ~6,9 GB do modelo):

```bash
docker compose -f servicos/comfyui/docker-compose.yml up -d   # ComfyUI na GPU, só em 127.0.0.1:8188
npm run imagens:modelo                  # DreamShaper XL Turbo V2 SFW (estilos hq e ilustracao), SHA-256 conferido
npm run imagens:modelo -- anime         # opcional: Animagine XL 4.0
npm run imagens:modelo -- realista      # opcional: RealVisXL V5 Lightning (~7 GB), fotos mais realistas
docker stop comfyui | docker start comfyui                     # desligar / religar (não reinicia sozinho)
```

- Ligue o módulo no perfil (`modulos: imagens`, como no `historias`) ou em `MODULES`. Sem o ComfyUI no ar,
  o agente avisa e o resto continua funcionando.
- Modelos e caches ficam em volumes Docker (`comfyui_*`). O ComfyUI roda com `--lowvram` por padrão
  (`COMFYUI_CLI_ARGS` muda), para caber ao lado de outros serviços na GPU.
- Outros checkpoints (ex.: Pony para `manga`, do Civitai): `docker cp arquivo.safetensors comfyui:/root/ComfyUI/models/checkpoints/`; `IMAGE_MODELS` liga estilo → trecho do nome.
  Estilo sem modelo cai para o padrão, com aviso.
- **VRAM:** uma geração por vez; antes de gerar, os modelos do Ollama são descarregados da GPU; depois de
  `IMAGE_IDLE_UNLOAD_MIN` minutos ocioso, o modelo de imagem também sai.
- **Conteúdo:** nudez, conteúdo sexual e violência gráfica (com qualquer pessoa, real ou não) são recusados antes
  de chegar à GPU, e todo prompt leva um negativo de segurança fixo.
- Seed fixo repete a imagem; mesma descrição canônica do personagem mantém a aparência entre cenas.
- **Fichas de personagem (HQ):** `npm run imagens:modelo -- personagens` instala o IP-Adapter (~3,5 GB). Cada
  personagem (e cada fase dele: jovem, adulto...) ganha uma ficha com até 4 imagens de referência, buscadas na
  internet (só as limpas: personagem sozinho, sem balão ou texto), enviadas por você ou aprovadas de uma geração.
  Todo desenho do personagem é condicionado na ficha, para sair igual em todos os quadros. Com personagem, são
  geradas 3 versões (`IMAGE_CANDIDATES`) e um modelo com visão escolhe a de corpo certo e mais parecida.
- **Foto → desenho:** mande uma foto (módulo `anexos`) e peça "transforma em anime" (ou HQ, ilustração, mangá).
  O ComfyUI redesenha por cima da foto mantendo composição e cores; `intensidade` fiel, equilibrado (padrão) ou
  criativo. Com pessoas, o rosto pode mudar (use "fiel"). Foto nunca vira o estilo `realista`.

## Voz clonada (sua voz a partir de texto)

Você digita, o bot devolve um voice note com a **sua voz**, gerado localmente na GPU pelo
[Chatterbox](https://github.com/devnen/Chatterbox-TTS-Server) (modelo multilíngue, licença MIT).

**Subir o servidor** (na primeira vez, clonar e construir a imagem; depois só `docker compose up -d`):
```bash
git clone https://github.com/devnen/Chatterbox-TTS-Server.git ../../Chatterbox-TTS-Server
cd ../../Chatterbox-TTS-Server
# config.yaml: model.repo_id = chatterbox-multilingual e generation_defaults.language = pt
docker compose up -d --build
```

**Cadastrar a voz**, por um dos caminhos:
- no Telegram: `/minhavoz` (ou `/minhavoz nome`) e, em seguida, um áudio de 10 a 30 s falando naturalmente;
- ou coloque arquivos `.wav`, `.mp3` ou `.ogg` em `VOICE_CLONE_DIR` (padrão `./data/voices`). O nome do arquivo vira o nome da voz.

**Usar:**
- `/falar <texto>` fala exatamente o texto com a voz padrão (`VOICE_CLONE_DEFAULT`); `/falar @nome <texto>` escolhe a voz;
- ou peça normalmente: "manda um áudio com a minha voz desejando feliz aniversário pra Maria" (skill `voz-clonada`);
- `/vozes` lista as vozes cadastradas.

**Jeito de falar** (`VOICE_CLONE_DIRECTION`, padrão `auto`): a fala é gerada por trechos, cada um com seu ritmo e tom,
com silêncio de verdade entre eles. Sem marcações, o LLM local lê o texto e decide; o bot devolve, junto do áudio,
o roteiro que usou, para copiar, editar e mandar de novo:
```
/falar (rápido, animado) Que notícia boa, conseguimos. (pausa) Pessoal! (pausa longa) (sério) Agora falta resolver o contrato...
```
Marcações (o comando `/entonacao` lista todas):
- tons: `(rápido)` `(devagar)` `(animado)` `(calmo)` `(sério)` `(triste)` `(doente)` `(cansado)` `(bravo)` `(nervoso)`
  `(suspense)` `(forte)` `(normal)`, ou descritos à vontade: `(voz de quem acabou de acordar)`. O modelo local traduz
  a descrição em parâmetros de voz. Um tom vale até o próximo;
- pausas: `(pausa curta)` `(pausa)` `(pausa longa)` `(pausa 2s)`;
- efeitos: `(tosse)` `(espirro)` `(risada)` `(suspiro)` `(bocejo)` `(pigarro)`. O Chatterbox multilíngue não tem
  efeitos sonoros, então eles saem como onomatopeia na mesma voz ("Cof, cof...");
- situação: `(contexto: está gripado, de cama)` ou uma primeira linha `Contexto: ...`. O diretor usa o contexto
  para decidir o jeito de falar (pode pôr uma tosse se a pessoa está doente), e os trechos sem tom seguem o contexto.

```
/falar (contexto: está gripado) (voz de pessoa doente) Hoje não vou conseguir ir. (tosse) Desculpa, pessoal.
```

Se você escreve só tons e contexto, o diretor ainda decide as pausas e os efeitos, mantendo o que você escreveu.
Com pausas ou efeitos escritos, vale só o seu roteiro. Trechos de uma ou duas palavras são gerados junto do
vizinho, porque sozinhos o modelo erra. `manual` usa só as marcações escritas; `off` fala tudo de uma vez.

As amostras ficam em `data/`, que está no `.gitignore`. Só usuários da whitelist conseguem usar as vozes.

## Trocando o LLM

```env
LLM_PROVIDER=deepseek          # gemini | deepseek | groq | ollama
LLM_FALLBACK_PROVIDERS=gemini  # usados em ordem se o principal falhar (503, 429, rede...)
SKILL_ROUTER_PROVIDER=groq     # opcional: provider barato para o roteamento de skills
```

### Ollama (100% local)

```env
LLM_PROVIDER=ollama
OLLAMA_MODEL=qwen2.5:7b-instruct   # precisa estar baixado: ollama pull qwen2.5:7b-instruct
OLLAMA_BASE_URL=http://localhost:11434/v1
OLLAMA_TIMEOUT_MS=300000
```

- Não precisa de API key. No startup, o bot avisa se o Ollama estiver fora do ar ou se o modelo não tiver sido baixado.
- Prefira modelos com **tool calling** (qwen2.5, qwen3, llama3.1). Se o modelo não suportar tools, o agente continua respondendo, mas sem usar as ferramentas.
- O raciocínio estendido de modelos como qwen3 vem desligado (`OLLAMA_THINK=false`): o qwen3:8b responde em ~5s em vez de ~80s. Blocos `<think>` que sobrarem são removidos da resposta.
- Toda chamada ao Ollama vai com `max_tokens` (`OLLAMA_MAX_TOKENS`, padrão 4096). Sem isso o Ollama pode gerar sem fim e travar o modelo para as próximas mensagens.
- VRAM: o Ollama carrega um modelo por vez quando não cabem todos; modelos diferentes em sequência (como na skill de refinamento) são trocados a cada chamada, o que custa alguns segundos por troca.
- O system prompt com uma skill ativa pode passar de 4k tokens. Se o modelo parecer "esquecer" instruções, aumente o contexto do servidor Ollama (`OLLAMA_CONTEXT_LENGTH=16384` antes do `ollama serve`).
- Combinações úteis: `LLM_PROVIDER=gemini` + `LLM_FALLBACK_PROVIDERS=ollama` (nuvem com fallback local) ou `LLM_PROVIDER=ollama` + `SKILL_ROUTER_PROVIDER=ollama` com tudo offline.

## Orquestrador de LLMs gratuitos

Com `LLM_ORCHESTRATOR=on`, o agente escolhe **sozinho, a cada mensagem, o melhor modelo gratuito** para a tarefa
(conversa, pesquisa, raciocínio, código, resumo), sem você referenciar modelo nenhum. Spec: [specs/llm-orchestration.md](specs/llm-orchestration.md).

- **Só gratuitos (`LLM_COST_POLICY=free-only`):** uma trava bloqueia qualquer modelo pago antes da chamada.
  Fontes: OpenCode Zen (`-free`, liga/desliga com `OPENCODE_ENABLED`), OpenRouter (`:free`), NVIDIA, planos gratuitos
  do Gemini e do Groq, modelos da sua **GPU** (Ollama) e os `:cloud` do Ollama (exigem `ollama signin`).
  Crie as chaves **sem cartão de crédito**: é a garantia final de custo zero.
- **Descoberta automática:** os modelos vêm do catálogo [models.dev](https://models.dev) (renovado a cada 24 h)
  e do seu Ollama. Um modelo gratuito novo aparece sozinho.
- **O melhor vence, inclusive a GPU:** a ordem usa notas **medidas** com `npm run eval -- <tarefa>`
  (perguntas de referência em `evals/`). Um modelo local só passa à frente se for tão bom quanto o melhor
  gratuito da nuvem; em empate ganha o local (privado e sem cota). Modelos que não cabem na VRAM são penalizados.
- **Cota esgotada?** O modelo entra em pausa e a mensagem vai para o próximo da lista.
- **Privacidade:** `PRIVACY_DEFAULT=publico` permite gratuitos que treinam com os dados em conversas comuns;
  documentos anexados sempre usam só fontes sem treino ou a sua GPU (`SOURCES_TRAINING_ON_DATA`).
- **Comandos** (Telegram e terminal): `/modelos [tarefa]` (ranking), `/modelo` (quem respondeu e por quê),
  `/bom` e `/ruim` (feedback que ajusta o ranking).

```bash
npm run eval -- pesquisa              # mede os gratuitos (e os da sua GPU) em perguntas factuais
npm run eval -- codigo --modelos 4    # só os 4 melhores candidatos
```

## Identidade do agente (um código, vários projetos)

Nome, dono e foco vêm do `.env`. Para usar o mesmo código com outra finalidade, mude só a identidade:

```env
AGENT_NAME=PromoBot
AGENT_EMOJI=🛒
OWNER_NAME=Equipe Promo
AGENT_PURPOSE=assistente de promoções
AGENT_INSTRUCTIONS=Foque em ofertas de tecnologia.\nSeja breve e sempre cite a loja.
```

Isso muda o system prompt, o `/start`, o chat do terminal e os logs. Nas skills, use os marcadores
`{{AGENT_NAME}}`, `{{OWNER_NAME}}`, `{{AGENT_PURPOSE}}`, `{{AGENT_EMOJI}}` e `{{AGENT_LANGUAGE}}`:
eles são preenchidos ao carregar cada `SKILL.md`.

## Criando skills

Crie uma pasta em `.agents/skills/<nome>/SKILL.md`:

```markdown
---
name: minha-skill
description: Quando usar esta skill (o router decide com base nesta frase).
---

# Instruções detalhadas
...injetadas no system prompt apenas quando a skill for escolhida.
```

As skills são relidas do disco a cada mensagem, então não é preciso reiniciar. Pastas sem `SKILL.md` ou com
frontmatter inválido são ignoradas (YAML com erro gera um aviso no terminal: use aspas em textos que contenham `:`).
Se dois `name` se repetirem, vale a pasta que vem depois em ordem alfabética.
Skills incluídas: `prd-manager`, `resumidor`, `gestor-arquivos`, `idealizador-analisador`.

### Skills de refinamento (dois modelos: criador ↔ crítico)

Um bloco `loop:` no frontmatter transforma a skill num loop executado pelo código, em que cada papel usa
o provider e o modelo que você escolher. O usuário recebe só a versão final.

```markdown
---
name: idealizador-analisador
description: "Cria e refina uma ideia para um problema da comunidade."
loop:
  iterations: 20                              # rodadas de crítica + revisão (teto: REFINEMENT_MAX_ROUNDS)
  stop_phrase: Estou satisfeito com a ideia   # o crítico encerra antes escrevendo só esta frase
  creator: { tag: idealizador, provider: ollama, model: qwen2.5:7b-instruct }
  critic:  { tag: analisador,  provider: gemini, model: gemini-3.8-flash }
---
<idealizador>Perfil (system prompt) de quem cria e revisa a {ideia}.</idealizador>
<analisador>Perfil de quem analisa a {ideia} e escreve a {crítica}.</analisador>
```

Fluxo: o criador gera a `{ideia}`; a cada rodada o crítico produz a `{crítica}` e o criador reescreve a ideia
aplicando as sugestões. Cada chamada recebe só a ideia atual e a última crítica, então o contexto não cresce.
Se um provider cair no meio, a melhor ideia obtida até ali é entregue. Os detalhes de cada rodada aparecem
apenas no log do terminal.

Para entregar um documento como anexo, o LLM envolve o conteúdo em `<arquivo nome="x.md">...</arquivo>`.

## Personas e estilos de texto

Três peças que se combinam (spec [personas-styles](specs/personas-styles.md)):

| | Responde a | Onde |
|---|---|---|
| **Skill** | *o que fazer* | `skills/<nome>/SKILL.md` |
| **Persona** | *quem fala*: um agente com personalidade e **memória própria** | `personas/<nome>.md` na fita |
| **Estilo** | *como escrever*: formal, informal, técnico, didático, jornalístico, acadêmico, infantil, persuasivo, poético, conciso | `estilos/` no tocador (a fita pode ter os seus) |

- **Falar com uma persona:** `/persona kael` (fica ativa), `@mira mensagem` (só aquela mensagem), `/persona sair`.
  Conversas, resumo e fatos de cada persona ficam separados; `/memoria` e `/nova` valem para a persona ativa.
- **Vários agentes:** o agente principal consulta uma persona (`falar_com_persona`) ou encena um diálogo entre
  várias (`dialogo_entre_personas`), e cada uma guarda a cena na própria memória. Persona pode limitar as skills
  (`skills: [...]`) e ter estilo padrão (`estilo: ...`).
- **Estilo:** peça na mensagem ("reescreva em tom formal"), fixe com `/estilo formal` (`/estilo padrao` desfaz), ou
  defina `estilo: ...` na persona ou `estilo_padrao: ...` no `perfil.yaml`. Vale nessa ordem: mensagem → persona →
  `/estilo` → padrão da fita.
- **Níveis do texto (1–10):** `complexidade`, `tom`, `sentimento`, `perspectiva` (1–3), `foco`, `surpresa`,
  `detalhe`, `originalidade`, `abstracao`. Na mensagem (`resuma o artigo detalhe=3`), fixos (`/estilo formal tom=2`)
  ou no frontmatter do estilo/persona (`controles: { detalhe: 2 }`).

### Modos de raciocínio

`/modo verificado` (ou `modo=verificado` numa mensagem) confere os fatos da resposta: o agente cria perguntas
de verificação, responde cada uma sem olhar o rascunho e corrige o que não bater (CoVe). `/modo reformular`
reescreve e detalha perguntas vagas antes de responder (RaR). A fita pode fixar `modo_padrao: verificado`.
Para decisões e problemas difíceis, a skill `analise-em-etapas` (módulo `refinamento`) mostra o raciocínio:
entender → decompor → resolver as partes → limites → síntese (spec [reasoning](specs/reasoning.md)).

### Debate entre agentes e criador de prompts (módulo `refinamento`)

- **Debate:** "faça um debate com 3 agentes sobre ..." cria participantes com perspectivas diferentes (ou use as
  personas da fita). A cada rodada eles leem uns aos outros e atualizam as posições, um juiz dá notas e o debate
  para esperando você: "descarta o 3", "minha ideia é ...", "combine os dois melhores", "foco em custo zero",
  "encerra" (spec [debate](specs/debate.md)).
- **Criador de prompts:** "me ajude a escrever um prompt para ..." trabalha em rodadas com A) prompt revisado,
  B) sugestões e C) perguntas numeradas, até você dizer que está bom.

### Limites da fita (guardrails)

Declarados no `perfil.yaml`, sem código (spec [guardrails](specs/guardrails.md)):

```yaml
guardrails:
  injecao: bloquear              # "ignore as instruções anteriores..." é recusado
  dados_pessoais: mascarar       # CPF, CNPJ, e-mail, telefone, cartão e chaves viram [CPF], [EMAIL]...
  proibidas: { palavras: [concorrente x], acao: refazer }   # acha até "c0nc0rr3nt3"; refazer = LLM reescreve
  topicos: { permitidos: [culinária, receitas], acao: bloquear }
  verificar_com_llm: true        # confirma injeção/tópico com o modelo barato (1 pedido por mensagem)
  abster: [saude, juridico]      # só informação geral + "procure um profissional"
```

Mesmo sem configuração, texto de página, anexo ou API que tenta dar ordens ao agente chega ao LLM marcado como dado.

```markdown
---
name: kael
description: "Mecânico de 19 anos, protagonista de Neon Rain."
estilo: informal
---
Você é Kael, 19 anos, mecânico numa cidade chuvosa... (personalidade, jeito de falar, história, objetivos)
```

## Memória em camadas

Conversas longas não estouram o contexto nem esquecem o começo:

- **Resumo incremental:** quando a conversa cresce, um LLM barato (o do roteamento) resume em segundo plano o
  que saiu da janela recente: assunto, pedidos (repetidos viram um só), decisões, entregas e pendências.
- **Compactação:** respostas longas antigas entram no contexto só com o começo, e documentos gerados viram
  `[documento gerado: x]`. O original fica intacto no banco.
- **Fatos duradouros:** preferências e dados de projetos ("prefiro respostas curtas", "o app usa Postgres")
  valem em todas as conversas, inclusive depois do `/nova`.
- `/memoria` mostra o que o agente lembra; `/esquecer <n>` apaga um fato; `/esquecer tudo` limpa fatos e resumo.
- Segredos (chaves, tokens, senhas, cartões) nunca entram no resumo. Se o resumo falhar, vale o anterior.
- `MEMORY_LAYERED=false` volta à janela fixa de `MEMORY_WINDOW_SIZE` mensagens.

## Dados locais

| Caminho | Conteúdo |
|---------|----------|
| `data/k7.db` | Conversas e mensagens (SQLite, WAL). Está no `.gitignore`. |
| `tmp/` | Áudios/PDFs temporários, apagados após o uso e limpos no startup |
| `workspace/` | Única pasta onde as ferramentas de arquivo podem ler e escrever |

## Créditos

Os controles de texto, os guardrails, a base de conhecimento (RAG), os modos de raciocínio (CoVe, RaR), a
análise em etapas, o debate entre agentes e o criador de prompts foram desenhados a partir dos livros
*Prompts em Ação* (vol. 1 e vol. 2: Guardrails) e *RAG: Retrieval-Augmented Generation* e do repositório
[sandeco/prompts](https://github.com/sandeco/prompts), do **Prof. Sandeco Macedo** (IFG/UFG). O mapa do que veio
de onde, com os artigos originais de cada técnica, está em [CREDITOS.md](CREDITOS.md).
