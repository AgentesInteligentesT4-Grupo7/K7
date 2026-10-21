# 🦀 AgroMinds

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
| `src/telegram` | Input handler, downloader, extração de documentos, Whisper, estratégias de saída e TTS (`output/tts`: Kokoro, Edge) |

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

docker compose run --rm agrominds node dist/cli/chat.js            # chat no terminal
docker compose run --rm agrominds node dist/cli/eval.js pesquisa   # avalia os modelos
```

- **Não rode o bot no Docker e o `npm run dev` ao mesmo tempo:** o Telegram aceita uma conexão por bot (erro 409).
- **Serviços no host:** Ollama, Kokoro (8880), Whisper (8890) e Chatterbox (8004) são alcançados por
  `host.docker.internal`. Os endereços do `docker-compose.yml` sobrescrevem os do `.env`. Ligue os
  containers de voz antes: `docker start kokoro-tts whisper-stt chatterbox-tts-server-chatterbox-tts-server-1`.
- **Banco SQLite num volume Docker (`agrominds-state`)**, porque o modo WAL não é confiável numa pasta do
  Windows montada no container. Por isso o Docker tem **memória, notas de avaliação e histórico próprios**,
  separados do `npm run dev`. Para levar o banco do Windows para o Docker uma vez (com os dois parados):
  ```bash
  docker run --rm -v agrominds_agrominds-state:/state -v "%cd%/data:/src" alpine cp /src/agrominds.db /state/
  ```
- **Pastas montadas do Windows** (edite normalmente): `data/` (vozes, cache, saídas do terminal), `workspace/`,
  `.agents/skills/` (com hot-reload) e `evals/`.
- O container não enxerga a GPU diretamente: os modelos locais continuam rodando no Ollama do Windows, que usa a GPU.

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

## Dados locais

| Caminho | Conteúdo |
|---------|----------|
| `data/agrominds.db` | Conversas e mensagens (SQLite, WAL). Está no `.gitignore`. |
| `tmp/` | Áudios/PDFs temporários, apagados após o uso e limpos no startup |
| `workspace/` | Única pasta onde as ferramentas de arquivo podem ler e escrever |
