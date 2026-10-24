# Spec: Geração de Imagens e Histórias Ilustradas (HQ, mangá, livro ilustrado)

**Versão:** 1.0
**Status:** Implementada em parte (MVP: RF-01, RF-02, RF-03, RF-10, RF-11, RF-13 a/b; img2img foto → desenho e estilo realista)
**Autor:** K7 Agent
**Data:** 2026-10-21
**Reviewers:** Parreira

---

## 1. Resumo

Gera imagens em estilo de ilustração, HQ, mangá ou anime **na GPU local** (RTX 3060, 12 GB), com modelos SDXL rodando no **ComfyUI** em Docker. O foco é **histórias**: o agente transforma o roteiro em cenas, mantém uma **ficha visual de cada personagem** para que ele pareça o mesmo em todos os painéis, gera os painéis e, opcionalmente, monta páginas com balões de fala.

---

## 2. Contexto e Motivação

**Problema:**
- O agente não gera imagens.
- Em histórias, o maior desafio da IA é a **consistência**: o mesmo personagem (rosto, cabelo, roupas, acessórios) muda de uma cena para outra quando cada imagem é gerada isoladamente.
- O fluxo manual (roteiro → descrição visual em inglês → geração → montagem) é repetitivo e fácil de errar (prompts inconsistentes entre cenas).

**Evidências:**
- Pedido do usuário (2026-10-21): skill de geração de imagens na GPU local, estilo ilustração/HQ, com modelos DreamShaper XL, Pony Diffusion V6 XL e Animagine XL, para projetos narrativos.
- Fluxo de referência trazido pelo usuário: roteiro → *prompt sheet* por cena → geração → montagem com balões.
- SDXL a 1024×1024 ocupa ~7–9 GB de VRAM e cabe na RTX 3060 de 12 GB; com versões aceleradas (Lightning/DMD2, 4–8 passos), uma imagem leva poucos segundos.

**Por que agora:**
O projeto já tem a infraestrutura de serviços em Docker na GPU (Kokoro, Whisper, Chatterbox), skills com hot-reload e entrega de arquivos no Telegram e no terminal. A geração de imagens segue o mesmo padrão.

---

## 3. Goals (Objetivos)

- [ ] G-01: Gerar imagens a partir de pedidos em português, com o LLM escrevendo o prompt técnico em inglês no formato de cada modelo.
- [ ] G-02: **Projetos de história** com roteiro, ficha de personagens e cenas, guardados no workspace.
- [ ] G-03: **Consistência de personagens** sem treino (ficha visual fixa + seed + referência de imagem via IP-Adapter), com LoRA treinada como evolução opcional.
- [ ] G-04: Controle de **pose e enquadramento** com ControlNet (OpenPose) quando a cena exigir.
- [ ] G-05: Entrega no Telegram (álbum de painéis) e no terminal (arquivos), e montagem opcional de páginas com balões.
- [ ] G-06: Geração **segura** (sem conteúdo sexual ou ofensivo) e **sem travar a GPU** dos outros serviços.

**Métricas de sucesso:**
| Métrica | Baseline atual | Target | Prazo |
|---------|---------------|--------|-------|
| Tempo por imagem 1024×1024 (modo rápido / qualidade) | N/A | ≤ 8 s / ≤ 30 s | MVP |
| Personagem reconhecido como o mesmo em 6 cenas (avaliação do usuário) | N/A | ≥ 5 de 6 | Fase 3 |
| Pedidos de conteúdo proibido que geram imagem | N/A | 0 | Sempre |
| Erros de falta de VRAM durante a geração | N/A | 0 (com o gerenciamento do RF-10) | MVP |

---

## 4. Non-Goals (Fora do Escopo)

- NG-01: Conteúdo sexual, nudez ou violência gráfica extrema (com qualquer pessoa); imagem de pessoa real feita para enganar ou humilhar; foto enviada de uma pessoa transformada em foto realista (só vira desenho).
- NG-02: Fotorrealismo como foco (os modelos escolhidos são de ilustração).
- NG-03: Vídeo e animação.
- NG-04: Treino de LoRA dentro do bot nesta versão (Fase 5 é opcional e roda fora do fluxo de conversa).
- NG-05: Editor visual de HQ completo. A montagem automática é básica; a finalização (fontes, efeitos) continua em ferramentas como Canva ou Clip Studio Paint.

---

## 5. Usuários e Personas

**Usuário primário:** Parreira, escrevendo uma história e pedindo pelo Telegram ou pelo terminal: "crie o personagem Kael", "gere a cena 3 do capítulo 1", "refaça o painel 2 com ele de costas", "monte a página 1".

---

## 6. Requisitos Funcionais

### 6.1 Requisitos Principais

| ID | Requisito | Prioridade | Critério de Aceite |
|----|-----------|-----------|-------------------|
| RF-01 | **Motor:** ComfyUI em Docker com GPU (porta configurável), com workflows-modelo versionados no projeto (`comfy/workflows/*.json`): `txt2img`, `txt2img+ipadapter`, `txt2img+ipadapter+openpose`, `character-sheet`. O bot preenche os parâmetros e envia pela API (`/prompt`, `/history`, `/view`). | Must | Um pedido simples gera um PNG em ≤ 30 s no modo qualidade. |
| RF-02 | **Modelos por estilo** (`IMAGE_MODELS` no `.env`): `ilustracao`/`hq` → DreamShaper XL; `anime` → Animagine XL; `manga`/`webtoon` → Pony Diffusion V6 XL. Cada estilo tem um template de prompt próprio (ex.: Pony usa `score_9, score_8_up, …`; Animagine usa tags no estilo Danbooru) e um prompt negativo base. | Must | "Desenhe estilo mangá" usa o Pony com o template correto. |
| RF-03 | **Ferramenta `gerar_imagem(descricao, estilo, proporcao?, seed?, personagens?)`:** o LLM converte a descrição em português no prompt técnico em inglês do estilo e chama o ComfyUI. Proporções: `quadrado` (1024×1024), `retrato` (832×1216), `paisagem` (1216×832), `painel_largo` (1344×768). | Must | O usuário nunca precisa escrever prompt em inglês. |
| RF-04 | **Projeto de história** em `workspace/historias/<projeto>/`: `roteiro.md`, `personagens/<nome>/ficha.yaml` (+ referências), `cenas/<nn>-<titulo>/cena.yaml` (prompt sheet) + painéis gerados, `paginas/`. Ferramentas: `criar_projeto_historia`, `listar_projetos`. | Must | Os arquivos são legíveis e editáveis à mão; o bot relê o que o usuário mudar. |
| RF-05 | **Ficha de personagem** (`criar_personagem(projeto, nome, descricao, estilo)`): o LLM gera uma descrição visual canônica em inglês (rosto, cabelo, corpo, roupas, acessórios, paleta), um seed fixo e uma **folha de referência** (frente/perfil/costas, fundo neutro). O usuário aprova ou pede ajustes; a versão aprovada vira a referência do personagem. | Must | A ficha aprovada é reutilizada automaticamente em toda cena com o personagem. |
| RF-06 | **Consistência sem treino:** toda cena com personagens injeta a descrição canônica de cada um no prompt e usa a(s) imagem(ns) de referência via **IP-Adapter**; seed por cena registrado para reprodutibilidade. | Must | Refazer uma cena com o mesmo seed e os mesmos parâmetros reproduz a imagem. |
| RF-07 | **Pose e enquadramento (ControlNet OpenPose):** `gerar_cena` aceita uma pose de uma biblioteca (`em_pe`, `correndo`, `sentado`, `de_costas`, `apontando`…) ou uma imagem de referência de pose enviada pelo usuário. | Should | "Kael correndo, visto de lado" usa a pose `correndo` e mantém o personagem. |
| RF-08 | **Do roteiro às cenas:** skill `diretor-de-historia` lê o `roteiro.md` e produz o *prompt sheet* de cada cena (enquadramento, personagens presentes, ação, cenário, iluminação, falas) em `cena.yaml`, para revisão antes de gerar. | Must | "Prepare as cenas do capítulo 1" cria os `cena.yaml` sem gerar imagens ainda. |
| RF-09 | **Geração e revisão de painéis:** `gerar_cena(projeto, cena, variacoes=1..4)` gera os painéis; `refazer_painel(projeto, cena, ajuste)` aplica um ajuste em linguagem natural ("de costas", "mais escuro", "sem o chapéu") mantendo o restante. | Must | Um ajuste pequeno não muda o personagem nem o cenário. |
| RF-10 | **Gestão de VRAM:** antes de gerar, pede ao Ollama para descarregar modelos locais (`keep_alive: 0`); uma geração por vez (fila); o ComfyUI libera os modelos após `IMAGE_IDLE_UNLOAD_MIN` minutos sem uso. Durante a geração, o orquestrador de LLMs evita modelos locais. | Must | Gerar imagem com o bot ativo não causa erro de memória da GPU. |
| RF-11 | **Entrega:** Telegram envia os painéis como **álbum** (até 10) e, sob pedido, o PNG original como **arquivo** (sem a compressão de foto); o terminal salva em `data/terminal/` e no projeto. | Must | O usuário recebe os painéis em ordem, com legenda "Cena 3 · painel 2". |
| RF-12 | **Montagem de página** (`montar_pagina(projeto, cenas, layout)`): layouts prontos (1, 2, 3, 4 e 6 painéis), margens e calhas, **balões de fala** com o texto do `cena.yaml` (fonte legível, posição ajustável), exporta PNG e PDF. | Should | "Monte a página 1 com as cenas 1–4" gera um PNG de página com balões. |
| RF-13 | **Segurança de conteúdo:** (a) o LLM recusa pedidos fora do NG-01; (b) prompt negativo base fixo bloqueando conteúdo explícito; (c) classificador NSFW na imagem gerada antes de entregar (imagem reprovada é descartada e o usuário é avisado); (d) personagens que aparentem ser menores de idade nunca em contexto sexualizado ou sugestivo — regra sem exceção. | Must | Os testes do RF-13 nunca entregam imagem imprópria. |
| RF-14 | **Downloads de modelos:** script `npm run imagens:modelos` baixa os checkpoints/IP-Adapter/ControlNet configurados (Civitai com `CIVITAI_TOKEN` quando exigido, Hugging Face), confere o hash e mostra a licença de cada um antes de baixar. | Must | Sem nada baixado, a skill avisa como baixar em vez de falhar. |
| RF-15 | **LoRA de personagem (opcional):** a partir de 15–20 imagens aprovadas da ficha, gera o dataset (imagens + legendas) pronto para treino externo (kohya_ss/OneTrainer, SDXL em 12 GB com *gradient checkpointing*) e, quando o arquivo `.safetensors` for colocado no projeto, passa a usá-lo nas cenas. | Could | Com a LoRA presente, as cenas a usam com o peso configurado. |

### 6.2 Fluxo Principal (Happy Path)

1. "Crie um projeto de história chamado Neon Rain, estilo HQ." → `criar_projeto_historia`.
2. "Crie o personagem Kael: jovem mecânico, cabelo raspado nas laterais, jaqueta de couro com arnês, óculos de solda na testa." → `criar_personagem` gera a folha de referência → o usuário aprova.
3. O usuário cola ou escreve o roteiro → `diretor-de-historia` cria `cenas/01..06/cena.yaml`.
4. "Gere as cenas 1 a 3." → para cada cena: VRAM liberada (RF-10) → ComfyUI com ficha + IP-Adapter (+ pose) → classificador (RF-13) → álbum no Telegram.
5. "Refaça a cena 2 com ele de costas." → `refazer_painel`.
6. "Monte a página 1." → `montar_pagina` → PNG/PDF com balões.

### 6.3 Fluxos Alternativos

- **ComfyUI desligado:** a skill responde "o gerador de imagens está desligado; ligue com `docker start comfyui`" e não trava a conversa.
- **Modelo do estilo não baixado:** usa o modelo padrão (DreamShaper XL) e avisa; se nenhum estiver baixado, indica o RF-14.
- **Imagem reprovada pelo classificador:** descarta, avisa e oferece ajustar o pedido.

---

## 7. Requisitos Não-Funcionais

| ID | Requisito | Valor alvo | Observação |
|----|-----------|-----------|------------|
| RNF-01 | VRAM durante a geração | ≤ 10 GB | SDXL + IP-Adapter + ControlNet em fp16; folga para o sistema. |
| RNF-02 | Modo rápido vs. qualidade | `IMAGE_QUALITY=rapido` (Lightning/DMD2, 4–8 passos) ou `qualidade` (25–30 passos) | O usuário escolhe no `.env` ou por pedido. |
| RNF-03 | Disco | ~6–7 GB por checkpoint SDXL | Pasta de modelos fora do Git, montada no container. |
| RNF-04 | Não bloquear o bot | Geração em fila assíncrona | O bot continua respondendo enquanto gera ("gerando 3 painéis…"). |

---

## 8. Design e Interface

```
Telegram/Terminal ─► skill diretor-de-historia / gerador-imagens (LLM: português → prompt técnico)
                         │ ferramentas: criar_projeto_historia, criar_personagem, gerar_imagem,
                         │              gerar_cena, refazer_painel, montar_pagina
                         ▼
                   ImageJobQueue (uma geração por vez) ─► VramManager (descarrega Ollama)
                         │
                         ▼
                   ComfyUIClient ─► ComfyUI (Docker, GPU) ─► checkpoints SDXL + IP-Adapter + ControlNet
                         │
                         ▼
                   SafetyChecker (NSFW) ─► StoryProject (workspace) ─► Output (álbum / arquivo / página)
```

---

## 9. Modelo de Dados

Arquivos no workspace (editáveis pelo usuário), sem tabelas novas:

```yaml
# personagens/kael/ficha.yaml
nome: Kael
estilo: hq
descricao_pt: jovem mecânico, cabelo raspado nas laterais...
prompt_canonico: "young male mechanic, undercut black hair, worn brown leather jacket with harness, welding goggles on forehead, ..."
seed: 482113
referencias: [ref-frente.png, ref-perfil.png, ref-costas.png]
lora: null            # ou kael.safetensors (RF-15)

# cenas/03-a-perseguicao/cena.yaml
enquadramento: plano americano
personagens: [kael]
acao: correndo por um beco com chuva neon
pose: correndo
proporcao: painel_largo
falas:
  - personagem: kael
    texto: "Eles estão logo atrás!"
seed: 90233
paineis: [painel-1.png, painel-2.png]
```

---

## 10. Integrações e Dependências

| Dependência | Tipo | Impacto se indisponível |
|-------------|------|------------------------|
| ComfyUI (Docker, GPU) | Obrigatória | Sem geração de imagens; o resto do bot funciona. |
| DreamShaper XL | Obrigatória (modelo padrão) | Sem geração até baixar. |
| Animagine XL, Pony Diffusion V6 XL | Opcionais (por estilo) | O estilo cai para o modelo padrão. |
| IP-Adapter (SDXL) | Obrigatória para consistência (RF-06) | Consistência só por prompt + seed (pior). |
| ControlNet OpenPose (SDXL) | Opcional (RF-07) | Sem controle de pose. |
| Classificador NSFW | Obrigatória (RF-13) | Geração bloqueada até estar disponível. |
| `sharp` (montagem de página) | Opcional (RF-12) | Sem montagem automática. |

**Licenças:** cada modelo tem a sua (as do Pony e do Animagine são *Fair AI Public License*, com condições para uso comercial e serviços de geração). O script do RF-14 mostra a licença antes de baixar; uso em produto (ex.: AgroMinds) exige leitura da licença de cada modelo.

**Novas variáveis de ambiente:**

```env
COMFYUI_BASE_URL=http://localhost:8188
IMAGE_MODELS=hq:dreamshaperXL,ilustracao:dreamshaperXL,anime:animagineXL,manga:ponyDiffusionV6XL
IMAGE_DEFAULT_STYLE=hq
IMAGE_QUALITY=rapido            # rapido | qualidade
IMAGE_IDLE_UNLOAD_MIN=5
CIVITAI_TOKEN=
```

---

## 11. Edge Cases e Tratamento de Erros

| Cenário | Trigger | Comportamento esperado |
|---------|---------|----------------------|
| EC-01: Falta de VRAM | Outro processo ocupando a GPU | Libera o Ollama (RF-10) e tenta de novo uma vez; se persistir, reduz a resolução ou avisa. |
| EC-02: Pedido proibido | Conteúdo do NG-01 ou RF-13(d) | Recusa sem gerar e sem armazenar o pedido como cena. |
| EC-03: Personagem "derrete" entre cenas | Ângulo ou iluminação muito diferentes | Sugere aumentar o peso do IP-Adapter, usar pose (RF-07) ou partir para a LoRA (RF-15). |
| EC-04: Ficha editada à mão com erro | YAML inválido | Aviso com a linha do erro; usa a última versão válida. |
| EC-05: Muitos personagens na mesma cena | 3+ personagens com IP-Adapter | Limite de 2 referências por cena; os demais só por prompt, com aviso. |
| EC-06: Telegram comprime a foto | Envio como foto | Oferece o PNG original como arquivo (RF-11). |

---

## 12. Segurança e Privacidade

- Geração 100% local: roteiros, fichas e imagens não saem da máquina (exceto o texto enviado ao LLM escolhido pelo orquestrador; com `PRIVACY_DEFAULT=local`, nem isso).
- RF-13 é obrigatório e não configurável para desligar.
- Imagens de pessoas reais enviadas como referência de pose servem só para extrair o esqueleto (OpenPose); a foto não é usada como referência de rosto.

---

## 13. Plano de Rollout

1. ComfyUI em Docker + DreamShaper XL + `gerar_imagem` simples + entrega no Telegram/terminal + RF-13 (segurança).
2. Gestão de VRAM (RF-10) e fila (RNF-04).
3. Projeto de história, fichas de personagem com IP-Adapter, `diretor-de-historia`, `gerar_cena` e `refazer_painel`.
4. ControlNet de pose (RF-07), Animagine e Pony (RF-02), montagem de página (RF-12).
5. (Opcional) LoRA de personagem (RF-15).

**Impacto em outras specs:** `telegram-output` (envio de álbuns e de imagens como arquivo), `architecture.md` §2.6 (ComfyUI e modelos SDXL), `llm-orchestration` (evitar modelos locais durante a geração).

---

## 14. Open Questions

- OQ-01: Começar só com o DreamShaper XL (mais versátil e com licença mais simples) ou já com os três?
- OQ-02: A montagem de página (RF-12) é necessária, ou você prefere finalizar sempre no Canva/Clip Studio e o bot só entregar os painéis?
- OQ-03: O treino de LoRA (RF-15) interessa? Ele dá a melhor consistência, mas cada personagem leva cerca de 1–2 h de GPU para treinar.
