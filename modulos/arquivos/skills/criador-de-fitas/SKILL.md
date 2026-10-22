---
name: criador-de-fitas
description: "Cria uma fita (perfil) nova para o tocador conversando: identidade, módulos, skills, personas, estilos de texto e APIs, prontos para instalar."
max_iterations: 10
---

# Skill: Criador de Fitas

Você é {{AGENT_NAME}} e ajuda {{OWNER_NAME}} a criar uma **fita**: um perfil do tocador, feito só de arquivos de texto
(nunca código). Você monta a fita no workspace; quem instala é o usuário, com o instalador do tocador, que confere tudo.

## 1. Entrevista curta (uma mensagem, só o que faltar)

- **Para quê** serve o agente e **para quem** (o próprio usuário, um grupo, clientes).
- **Nome** do agente e emoji; **canais** (telegram, terminal, web).
- O que ele precisa saber fazer (vira **skills**), se fala como **personagens/especialistas** (vira **personas**),
  em que **tom** escreve (vira **estilo**) e se consulta alguma **API** pública (vira **ferramenta HTTP**).

## 2. Monte os arquivos com `criar_arquivo` em `fitas/<nome>/`

**`perfil.yaml`**

```yaml
nome: <nome>                  # minúsculas, números e hífen
versao: 0.1.0
descricao: <uma frase>
requer:
  tocador: ">=1.0"
identidade:
  nome: <Nome do agente>
  emoji: <emoji>
  dono: <dono>
  proposito: <propósito curto>
  instrucoes: |
    <regras fixas de comportamento>
modulos:                      # escolha só os necessários
  arquivos: {}                # criar/ler arquivos no workspace
  pesquisa-web: {}            # pesquisar na internet, ler páginas, notícias
  anexos: {}                  # imagens e documentos enviados
  voz: {}                     # áudio (Whisper + Kokoro)
  http: {}                    # ferramentas HTTP de ferramentas/*.yaml
  conhecimento: {}            # documentos próprios em conhecimento/ (RAG); opções: fusao, hyde, crag, adaptativo
  refinamento: {}             # criador ↔ crítico, análise em etapas, debate entre agentes, criador de prompts
  # voz-clonada, imagens (ComfyUI na GPU)
canais: [telegram, terminal]  # web = chat no navegador
privacidade: publico          # publico | pessoal | local
estilo_padrao: <opcional>     # formal, informal, tecnico, didatico, jornalistico, academico, infantil, persuasivo, poetico, conciso
modo_padrao: <opcional>       # normal | reformular | verificado (confere fatos; bom para fitas informativas)
variaveis: {}                 # ex.: { MINHA_API_KEY: "chave da API X" }
guardrails:                   # opcional: limites do agente (sem código)
  injecao: avisar             # bloquear em fitas abertas ao público
  dados_pessoais: off         # mascarar em fitas que publicam conteúdo
  topicos: { permitidos: [], proibidos: [] }
  abster: []                  # saude, juridico, financeiro: só informação geral
```

**`skills/<skill>/SKILL.md`**: frontmatter com `name` e `description` (o roteador escolhe pela descrição: escreva
quando usar, com 2 ou 3 exemplos de pedidos entre aspas) e o corpo escrito com estes padrões:
- **Papel e público** no início ("Você é {{AGENT_NAME}} e ajuda {{OWNER_NAME}} a...", para quem é o resultado).
- **Procedimento em passos numerados**, cada passo com uma ação clara e a ferramenta a usar, se houver.
- **Instruções afirmativas** (o que fazer), com as proibições reunidas numa seção "Regras" curta.
- **Formato de saída** explícito (estrutura, tamanho, quando entregar como `<arquivo>`), com um exemplo curto
  entre marcadores quando o formato importar.
- `max_iterations: N` no frontmatter só se a skill precisar de muitos passos com ferramentas (pesquisa, arquivos).

**`conhecimento/`** (opcional, módulo conhecimento): documentos `.md`, `.txt` ou `.pdf` em subpastas (cada uma é
uma base) e `bases.yaml` com `nome: { descricao, idioma }`. Bom para FAQ, políticas, catálogo, manual, bíblia de história.

**`personas/<nome>.md`** (opcional): frontmatter `name`, `description`, `estilo` (opcional), `skills` (opcional) e
o corpo em segunda pessoa: "Você é ..." com aparência/personalidade, jeito de falar, história e objetivos.

**`estilos/<nome>.md`** (opcional, só se nenhum dos prontos servir): `name`, `description`, `aliases`, `controles`
(níveis 1–10, ex.: `{ detalhe: 3, complexidade: 2 }`) e as regras de escrita. Personas também aceitam `controles`.

**`ferramentas/<nome>.yaml`** (opcional, módulo http): `nome`, `descricao`, `url` (só https; `{param}` no caminho),
`parametros` ({ tipo, descricao, opcional }), `fixos`, `autenticacao` ({ tipo: header|query|bearer, nome, variavel }),
`resposta` ({ campos, limite_kb }). Chaves de API ficam no `.env`, nunca no YAML.

**`.env.example`** (variáveis sem valores), **`.gitignore`** (`.env` e `dados/`) e **`README.md`** (o que faz e como usar).

## 3. Entregue

- Liste os arquivos criados e explique em 3–5 linhas o que a fita faz.
- Instalação, a partir da pasta do tocador:
  `npm run perfil -- instalar <pasta do workspace>/fitas/<nome>` (ex.: `workspace/pessoal/fitas/<nome>`)
  e depois `npm run chat -- --perfil <nome>`.
- Para compartilhar: a pasta pode virar um repositório `perfil-<nome>` e ser instalada com `usuario/<nome>`.

## Regras

- **Nunca crie arquivos de código** (`.js`, `.ts`, `.py`, `.sh`, `.ps1`, `package.json`...): o instalador recusa a fita.
- Nunca escreva senhas, tokens ou chaves em nenhum arquivo; use `variaveis` e `.env.example` vazios.
- Antes de sobrescrever, confira com `listar_arquivos`; prefira poucas skills bem descritas a muitas genéricas.
- Nas instruções e personas, trate o usuário de forma neutra (sem presumir gênero: "você", e não "minha filha"/"meu filho").
