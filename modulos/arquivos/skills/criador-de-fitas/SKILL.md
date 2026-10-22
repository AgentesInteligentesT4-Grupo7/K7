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
  # refinamento, voz-clonada, imagens (ComfyUI na GPU)
canais: [telegram, terminal]  # web = chat no navegador
privacidade: publico          # publico | pessoal | local
estilo_padrao: <opcional>     # formal, informal, tecnico, didatico, jornalistico, academico, infantil, persuasivo, poetico, conciso
variaveis: {}                 # ex.: { MINHA_API_KEY: "chave da API X" }
```

**`skills/<skill>/SKILL.md`**: frontmatter com `name` e `description` (o roteador escolhe pela descrição: escreva
quando usar) e o corpo com o procedimento passo a passo e as regras. Use `{{AGENT_NAME}}` e `{{OWNER_NAME}}`.

**`personas/<nome>.md`** (opcional): frontmatter `name`, `description`, `estilo` (opcional), `skills` (opcional) e
o corpo em segunda pessoa: "Você é ..." com aparência/personalidade, jeito de falar, história e objetivos.

**`estilos/<nome>.md`** (opcional, só se nenhum dos prontos servir): `name`, `description`, `aliases` e as regras de escrita.

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
